// Playground-only public actions/queries.
// Kept as a hands-on testing surface for connections and search.
// These four endpoints exist exclusively for a separate playground frontend
// (not part of this repository) — they expose Spark's search and
// knowledge-page surface for hands-on testing under a Clerk-authenticated
// session. They are NOT used by the agent runtime, synthesis pipeline, or any
// other Convex code in this repo. Keeping them here (rather than in `spark.ts`)
// makes that split clear: anything in this file can be hardened, renamed, or
// deleted without touching production code paths.

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  ASANA_RESOURCE_FETCHERS,
  COMPOSIO_BACKEND_BASE_URL,
  type ComposioFetcher,
} from "./composioConfig";
import {
  SONNET_MODEL,
  anthropicClient,
  recentSignalStartersForOrg,
  buildSourceChunkSearchableText,
  classifyAnthropicRetry,
  dedupeEvidenceEntries,
  dedupeStrings,
  deriveKnowledgePageIdentity,
  getErrorMessage,
  getRecord,
  getString,
  rag,
  stripJsonFence,
  synthesizeCompiledTruth,
  withRetriableCall,
} from "./knowledge";
import { normalizeBoundedInteger, orgMutation } from "./spark";

// ---------------------------------------------------------------------------
// Temporary operator backfills/syncs/clears.
//
// These are intentionally playground-only. Run manually with
// `npx convex run playground:<functionName>`; do not wire them into production
// paths.
// ---------------------------------------------------------------------------

type EntityRef = {
  source: string;
  gid: string;
};

type OrgId = Id<"orgs">;

type EntityPageForLinking = {
  _id: Id<"knowledgePages">;
  identity?: EntityRef;
  entityId?: Id<"entities">;
};

function entityRefKey(ref: EntityRef): string {
  return `${ref.source}:${ref.gid}`;
}

function addDistinctEntityRef(
  refsByKey: Map<string, EntityRef>,
  ref: EntityRef | undefined,
): void {
  if (!ref) return;
  refsByKey.set(entityRefKey(ref), {
    source: ref.source,
    gid: ref.gid,
  });
}

export const repairSourceChunkSearchableText = internalMutation({
  args: {
    chunkId: v.id("sourceChunks"),
    content: v.string(),
    contextPrefix: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const searchableText = buildSourceChunkSearchableText(
      args.content,
      args.contextPrefix,
    );
    await ctx.db.patch(args.chunkId, { searchableText });
    return {
      chunkId: args.chunkId,
      searchableTextLength: searchableText.length,
    };
  },
});

export const backfillSourceChunkSearchableText = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 500, 1), 1000);
    const page = await ctx.db.query("sourceChunks").paginate({
      cursor: args.cursor ?? null,
      numItems: limit,
    });
    let patched = 0;

    for (const chunk of page.page) {
      const searchableText = buildSourceChunkSearchableText(
        chunk.content,
        chunk.contextPrefix,
      );
      if (chunk.searchableText !== searchableText) {
        await ctx.db.patch(chunk._id, { searchableText });
        patched += 1;
      }
    }

    return {
      scanned: page.page.length,
      patched,
      continueCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const listPagesNeedingIdentity = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "active"),
      )
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    const pages: {
      _id: Id<"knowledgePages">;
      type: string;
      title: string;
      entity?: string;
    }[] = [];
    for (const page of result.page) {
      if (
        (page.type === "entity" || page.type === "project") &&
        page.identity === undefined
      ) {
        pages.push({
          _id: page._id,
          type: page.type,
          title: page.title,
          entity: page.entity,
        });
      }
    }
    return {
      pages,
      scanned: result.page.length,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const backfillIdentitiesBatch = internalMutation({
  args: {
    orgId: v.id("orgs"),
    pageIds: v.array(v.id("knowledgePages")),
  },
  handler: async (ctx, args) => {
    let scanned = 0;
    let patched = 0;
    let skipped = 0;
    for (const pageId of args.pageIds) {
      const page = await ctx.db.get(pageId);
      if (!page) {
        continue;
      }
      if (page.orgId !== args.orgId) {
        skipped += 1;
        continue;
      }
      if (
        (page.type !== "entity" && page.type !== "project") ||
        page.identity !== undefined
      ) {
        continue;
      }
      scanned += 1;
      const identity = await deriveKnowledgePageIdentity(ctx, args.orgId, {
        type: page.type,
        title: page.title,
        entity: page.entity,
      });
      if (identity) {
        await ctx.db.patch(page._id, { identity });
        patched += 1;
      } else {
        skipped += 1;
      }
    }
    return { scanned, patched, skipped };
  },
});

export const backfillKnowledgePageIdentities = internalAction({
  args: {
    orgId: v.id("orgs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    maxPages: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scanned: number;
    patched: number;
    skipped: number;
    pagesScanned: number;
    nextCursor: string | null;
    isDone: boolean;
  }> => {
    const numItems = normalizeBoundedInteger(args.numItems, 100, 1, 500);
    const maxPages = normalizeBoundedInteger(args.maxPages, 100, 1, 100);
    let cursor = args.cursor ?? null;
    let isDone = false;
    let scanned = 0;
    let patched = 0;
    let skipped = 0;
    let pagesScanned = 0;
    for (let iteration = 0; iteration < maxPages; iteration += 1) {
      const page = (await ctx.runQuery(
        internal.playground.listPagesNeedingIdentity,
        { orgId: args.orgId, cursor, numItems },
      )) as {
        pages: Array<{ _id: Id<"knowledgePages"> }>;
        scanned: number;
        continueCursor: string;
        isDone: boolean;
      };
      pagesScanned += page.scanned;
      if (page.pages.length > 0) {
        const result = await ctx.runMutation(
          internal.playground.backfillIdentitiesBatch,
          { orgId: args.orgId, pageIds: page.pages.map((p) => p._id) },
        );
        scanned += result.scanned;
        patched += result.patched;
        skipped += result.skipped;
      }
      isDone = page.isDone;
      cursor = page.isDone ? null : page.continueCursor;
      if (page.isDone) {
        break;
      }
    }
    return {
      scanned,
      patched,
      skipped,
      pagesScanned,
      nextCursor: cursor,
      isDone,
    };
  },
});

export const pageEventsForActorResolution = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("events")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });

    return {
      page: result.page.map((event) => ({
        _id: event._id,
        actor: event.actor,
        source: event.source,
        hasActorRef: event.actorRef !== undefined,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const applyEventActorNames = internalMutation({
  args: {
    updates: v.array(
      v.object({
        eventId: v.id("events"),
        name: v.string(),
        source: v.string(),
        gid: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ updated: number }> => {
    let updated = 0;
    for (const update of args.updates) {
      const event = await ctx.db.get(update.eventId);
      if (!event) {
        continue;
      }
      await ctx.db.patch(update.eventId, {
        actor: update.name,
        ...(event.actorRef === undefined
          ? { actorRef: { source: update.source, gid: update.gid } }
          : {}),
      });
      updated += 1;
    }
    return { updated };
  },
});

export const reresolveEventActors = internalAction({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; updated: number }> => {
    let scanned = 0;
    let updated = 0;
    let cursor: string | null = null;

    for (let iteration = 0; iteration < 1000; iteration += 1) {
      const res: {
        page: Array<{
          _id: Id<"events">;
          actor: string;
          source: string;
          hasActorRef: boolean;
        }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.playground.pageEventsForActorResolution, {
        orgId: args.orgId,
        cursor,
        numItems: 200,
      });

      const matched: Array<{ eventId: Id<"events">; source: string; gid: string }> = [];
      for (const event of res.page) {
        const parsed = /^(asana|slack):(.+)$/.exec(event.actor);
        if (parsed) {
          matched.push({
            eventId: event._id,
            source: parsed[1],
            gid: parsed[2],
          });
        }
      }

      if (matched.length > 0) {
        const refKeys = new Map<string, { source: string; gid: string }>();
        for (const m of matched) {
          refKeys.set(`${m.source}:${m.gid}`, { source: m.source, gid: m.gid });
        }
        const refs = Array.from(refKeys.values());

        const resolved = await ctx.runAction(
          internal.ingest.resolveIdentitiesForOrg,
          { orgId: args.orgId, refs },
        );

        const nameByKey = new Map<string, string>();
        for (const entry of resolved) {
          if (entry.name) {
            nameByKey.set(`${entry.source}:${entry.gid}`, entry.name);
          }
        }

        const updates = matched.flatMap((m) => {
          const name = nameByKey.get(`${m.source}:${m.gid}`);
          if (!name) {
            return [];
          }
          return [{ eventId: m.eventId, name, source: m.source, gid: m.gid }];
        });

        if (updates.length > 0) {
          const mutationResult = await ctx.runMutation(
            internal.playground.applyEventActorNames,
            { updates },
          );
          updated += mutationResult.updated;
        }
      }

      scanned += res.page.length;

      if (res.isDone) {
        break;
      }
      cursor = res.continueCursor;
    }

    return { scanned, updated };
  },
});

export const ingestTestEvents = internalMutation({
  args: {
    orgId: v.id("orgs"),
    actor: v.string(),
    count: v.number(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { orgId: OrgId; actor: string; count: number },
  ): Promise<{ count: number; repo: string; eventIds: Id<"events">[] }> => {
    const eventTemplates = [
      {
        source: "github",
        type: "pull_request",
        summary: "Opened a feature-flag PR for session enrichment output",
        raw: {
          action: "opened",
          title: "Add session enrichment knowledge pages",
          body: "Introduces document-first session enrichment, metadata tags, and knowledge page persistence.",
        },
      },
      {
        source: "github",
        type: "push",
        summary: "Pushed follow-up commits to tighten the enrichment parser",
        raw: {
          commits: [
            {
              message:
                "Handle trailing json metadata and preserve markdown body for session pages",
            },
          ],
        },
      },
      {
        source: "github",
        type: "issue_comment",
        summary: "Responded to review notes about confidence tags and evidence capture",
        raw: {
          comment:
            "Wired evidenceTimeline directly from clustered events and kept confidence in the metadata block.",
        },
      },
      {
        source: "slack",
        type: "message",
        summary: "Shared implementation notes about the Convex session enrichment flow",
        raw: {
          text:
            "Extractor now writes a session doc plus tags in one mutation; next step is validating the proof commands.",
        },
      },
      {
        source: "github",
        type: "pull_request",
        summary: "Merged the session enrichment branch after validation passed",
        raw: {
          action: "closed",
          merged: true,
          title: "Add session enrichment knowledge pages",
        },
      },
    ];
    const repo = "spark/session-enrichment-test";
    const baseTime =
      Date.now() - Math.max(args.count, 1) * 5 * 60 * 1000;
    const eventIds: Id<"events">[] = [];

    for (let index = 0; index < args.count; index += 1) {
      const template = eventTemplates[index % eventTemplates.length];
      const timestamp = baseTime + index * 5 * 60 * 1000;
      const eventId = await ctx.db.insert("events", {
        orgId: args.orgId,
        source: template.source,
        via: "api",
        type: template.type,
        actor: args.actor,
        summary: template.summary,
        timestamp,
        raw: {
          ...template.raw,
          actor: args.actor,
          repo,
          repository: { full_name: repo },
          sequence: index + 1,
        },
        processed: false,
      });
      eventIds.push(eventId);
    }

    return { count: eventIds.length, repo, eventIds };
  },
});

// The 12 derived-knowledge tables that get fully wiped. `events` is NOT here:
// events are kept and only have their processed/claim state reset.
const WIPE_KNOWLEDGE_TABLE_VALIDATOR = v.union(
  v.literal("knowledgePages"),
  v.literal("pageVersions"),
  v.literal("references"),
  v.literal("knowledgePageEvidence"),
  v.literal("sourceAttributions"),
  v.literal("sessions"),
  v.literal("sessionScores"),
  v.literal("sessionEvents"),
  v.literal("sources"),
  v.literal("sourceChunks"),
  v.literal("ingestJobs"),
  v.literal("syntheses"),
);

const WIPE_KNOWLEDGE_TABLES = [
  "knowledgePages",
  "pageVersions",
  "references",
  "knowledgePageEvidence",
  "sourceAttributions",
  "sessions",
  "sessionScores",
  "sessionEvents",
  "sources",
  "sourceChunks",
  "ingestJobs",
  "syntheses",
] as const;

const WIPE_BATCH_SIZE = 500;
const RAG_WIPE_PAGE_SIZE = 200;
const REBUILD_EXTRACTOR_MAX_ITERATIONS = 50;

/**
 * DESTRUCTIVE: delete up to `numItems` rows from one derived-knowledge table.
 *
 * A real switch with a literal per table keeps the table name statically typed
 * (Convex rejects a dynamic string passed to `ctx.db.query`). The caller loops
 * this until a batch returns `deleted < numItems`.
 */
export const wipeKnowledgeTableBatch = internalMutation({
  args: {
    orgId: v.id("orgs"),
    table: WIPE_KNOWLEDGE_TABLE_VALIDATOR,
    numItems: v.number(),
  },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    // Every case scopes to the given org via an index whose first field is
    // orgId, so a single-tenant wipe never touches another org's rows.
    let deleted = 0;
    switch (args.table) {
      case "knowledgePages": {
        const rows = await ctx.db
          .query("knowledgePages")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "pageVersions": {
        const rows = await ctx.db
          .query("pageVersions")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "references": {
        const rows = await ctx.db
          .query("references")
          .withIndex("by_org_type", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "knowledgePageEvidence": {
        const rows = await ctx.db
          .query("knowledgePageEvidence")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "sourceAttributions": {
        const rows = await ctx.db
          .query("sourceAttributions")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "sessions": {
        const rows = await ctx.db
          .query("sessions")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "sessionScores": {
        const rows = await ctx.db
          .query("sessionScores")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "sessionEvents": {
        const rows = await ctx.db
          .query("sessionEvents")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "sources": {
        const rows = await ctx.db
          .query("sources")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "sourceChunks": {
        const rows = await ctx.db
          .query("sourceChunks")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "ingestJobs": {
        const rows = await ctx.db
          .query("ingestJobs")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
      case "syntheses": {
        const rows = await ctx.db
          .query("syntheses")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(args.numItems);
        for (const row of rows) {
          await ctx.db.delete(row._id);
        }
        deleted = rows.length;
        break;
      }
    }
    return { deleted };
  },
});

/**
 * Reset one page of `events` to the pristine unprocessed state so the extractor
 * re-runs them. `claimUnprocessedEvents` marks events with
 * `{ processed: false, claimedAt: now }`; this clears both `processed` (back to
 * false) and `claimedAt` (to undefined). Both fields are optional in the
 * schema, so patching them is valid. Events themselves are KEPT — only their
 * processed/claim state is reset.
 */
export const resetEventsProcessedBatch = internalMutation({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; isDone: boolean; continueCursor: string }> => {
    const result = await ctx.db
      .query("events")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });

    for (const event of result.page) {
      await ctx.db.patch(event._id, {
        processed: false,
        claimedAt: undefined,
      });
    }

    return {
      scanned: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// Backfill: collapse byte-identical evidence-timeline rows on existing pages.
// Rows used to be deduped with the timestamp in the key, so a burst of N
// identical Asana stories (e.g. "notes changed on X", each with its own
// timestamp) left N rows on the page. This re-dedups page.evidenceTimeline by
// source|channel|content — the same key the live pipeline now uses — and
// patches any page that shrank. It does NOT bump updatedAt (a cleanup should
// not resurface old pages as recently-updated) and does NOT touch the
// append-only knowledgePageEvidence table (the UI renders the bounded
// page.evidenceTimeline array). Idempotent. Run per org with:
//   npx convex run playground:dedupeKnowledgePageEvidenceForOrg '{"orgId":"..."}'
export const dedupeKnowledgePageEvidenceBatch = internalMutation({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    scanned: number;
    changed: number;
    rowsRemoved: number;
    isDone: boolean;
    continueCursor: string;
  }> => {
    const result = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });

    let changed = 0;
    let rowsRemoved = 0;
    for (const page of result.page) {
      const deduped = dedupeEvidenceEntries(page.evidenceTimeline);
      if (deduped.length === page.evidenceTimeline.length) {
        continue;
      }
      rowsRemoved += page.evidenceTimeline.length - deduped.length;
      changed += 1;
      await ctx.db.patch(page._id, { evidenceTimeline: deduped });
    }

    return {
      scanned: result.page.length,
      changed,
      rowsRemoved,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const dedupeKnowledgePageEvidenceForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; changed: number; rowsRemoved: number }> => {
    let scanned = 0;
    let changed = 0;
    let rowsRemoved = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: {
        scanned: number;
        changed: number;
        rowsRemoved: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(
        internal.playground.dedupeKnowledgePageEvidenceBatch,
        { orgId: args.orgId, cursor, numItems: 100 },
      );
      scanned += page.scanned;
      changed += page.changed;
      rowsRemoved += page.rowsRemoved;
      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }
    return { scanned, changed, rowsRemoved };
  },
});

/**
 * DESTRUCTIVE + SINGLE-ORG: wipe all derived knowledge for `orgId`.
 *
 * 1. Deletes every row from the 12 derived-knowledge tables (batched).
 * 2. Resets every `events` row to unprocessed/unclaimed (events are KEPT).
 * 3. Clears the RAG vector-store namespace for the org.
 *
 * This does NOT touch: events (rows), identityCache, orgs, teamMembers,
 * knowledgeBases, or any auth/connection tables. Run only after a backup.
 */
export const wipeKnowledgeForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tablesDeleted: Record<string, number>;
    eventsReset: number;
    ragDeleted: number;
  }> => {
    // 1. Wipe each derived-knowledge table, batch by batch, until drained.
    const tablesDeleted: Record<string, number> = {};
    for (const table of WIPE_KNOWLEDGE_TABLES) {
      let total = 0;
      for (;;) {
        const { deleted } = await ctx.runMutation(
          internal.playground.wipeKnowledgeTableBatch,
          { orgId: args.orgId, table, numItems: WIPE_BATCH_SIZE },
        );
        total += deleted;
        if (deleted < WIPE_BATCH_SIZE) {
          break;
        }
      }
      tablesDeleted[table] = total;
    }

    // 2. Reset events to unprocessed/unclaimed (events are kept).
    let eventsReset = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: { scanned: number; isDone: boolean; continueCursor: string } =
        await ctx.runMutation(internal.playground.resetEventsProcessedBatch, {
          orgId: args.orgId,
          cursor,
          numItems: WIPE_BATCH_SIZE,
        });
      eventsReset += page.scanned;
      if (page.isDone) {
        break;
      }
      cursor = page.continueCursor;
    }

    // 3. Clear the RAG vector-store namespace for the org. The namespace string
    //    is the orgId (see `rag.add`/`rag.search` calls, which use
    //    `namespace: orgId`). `getNamespace` returns the single active
    //    namespaceId for that org (one per model/dimension/filter version; only
    //    one is ever "ready"). We page through its entries and delete each one
    //    synchronously (entry + its chunks) in this action context.
    let ragDeleted = 0;
    const namespace = await rag.getNamespace(ctx, { namespace: args.orgId });
    if (namespace) {
      let ragCursor: string | null = null;
      for (;;) {
        const listResult = await rag.list(ctx, {
          namespaceId: namespace.namespaceId,
          paginationOpts: { cursor: ragCursor, numItems: RAG_WIPE_PAGE_SIZE },
        });
        for (const entry of listResult.page) {
          await rag.delete(ctx, { entryId: entry.entryId });
          ragDeleted += 1;
        }
        if (listResult.isDone) {
          break;
        }
        ragCursor = listResult.continueCursor;
      }
    }

    return { tablesDeleted, eventsReset, ragDeleted };
  },
});

/**
 * Trigger a full knowledge rebuild for `orgId` from the (kept, reset) events.
 *
 * Pipeline order:
 *  1. `internal.spark.runExtractor` turns unprocessed events -> sessions. It
 *     claims a bounded batch per call and returns `eventCount: 0` when there is
 *     nothing left, so we loop it (capped) until it drains.
 *  2. `internal.knowledge.sweepStuckSessionBridges` bridges sessions -> sources
 *     -> processSource. We pass `cutoff: Date.now()` so every freshly created
 *     session page qualifies immediately (default cutoff only sweeps pages
 *     older than 30 min). It self-schedules continuation pages for the rest.
 *
 * Run this AFTER `wipeKnowledgeForOrg`. It does not delete anything itself.
 */
export const rebuildKnowledgeForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    sessionCount: number;
    eventCount: number;
    extractorIterations: number;
    sweep: {
      scannedCount: number;
      candidateCount: number;
      processedCount: number;
      scheduledContinuation: boolean;
      continueCursor: string | null;
      cutoff: number;
    };
  }> => {
    // 1. Drain unprocessed events into sessions (bounded batches).
    let sessionCount = 0;
    let eventCount = 0;
    let extractorIterations = 0;
    for (
      let iteration = 0;
      iteration < REBUILD_EXTRACTOR_MAX_ITERATIONS;
      iteration += 1
    ) {
      const result = await ctx.runAction(internal.spark.runExtractor, {
        orgId: args.orgId,
      });
      extractorIterations += 1;
      sessionCount += result.sessionCount;
      eventCount += result.eventCount;
      if (result.eventCount === 0) {
        break;
      }
    }

    // 2. Bridge every new session into the knowledge pipeline immediately.
    const sweep = await ctx.runAction(
      internal.knowledge.sweepStuckSessionBridges,
      { cutoff: Date.now() },
    );

    return { sessionCount, eventCount, extractorIterations, sweep };
  },
});

export const pageEntityPagesForLinking = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    pages: EntityPageForLinking[];
    continueCursor: string;
    isDone: boolean;
  }> => {
    const result = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "active"),
      )
      .paginate({ cursor: args.cursor, numItems: args.numItems });

    return {
      pages: result.page
        .filter((page) => page.type === "entity" || page.type === "project")
        .map((page) => ({
          _id: page._id,
          identity: page.identity,
          entityId: page.entityId,
        })),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const linkKnowledgePageEntityId = internalMutation({
  args: {
    orgId: v.id("orgs"),
    pageId: v.id("knowledgePages"),
    entityId: v.id("entities"),
  },
  handler: async (ctx, args): Promise<{ linked: boolean }> => {
    const page = await ctx.db.get(args.pageId);
    if (
      !page ||
      page.orgId !== args.orgId ||
      (page.type !== "entity" && page.type !== "project") ||
      page.status !== "active" ||
      page.entityId === args.entityId
    ) {
      return { linked: false };
    }
    await ctx.db.patch(args.pageId, { entityId: args.entityId });
    return { linked: true };
  },
});

export const linkEntityPagesForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    processed: number;
    linked: number;
    nextCursor: string;
    isDone: boolean;
  }> => {
    const numItems = normalizeBoundedInteger(args.limit, 100, 1, 500);
    const page = await ctx.runQuery(
      internal.playground.pageEntityPagesForLinking,
      {
        orgId: args.orgId,
        cursor: args.cursor ?? null,
        numItems,
      },
    );

    let processed = 0;
    let linked = 0;
    for (const knowledgePage of page.pages) {
      processed += 1;
      if (!knowledgePage.identity) {
        continue;
      }

      const cached = await ctx.runQuery(internal.spark.getCachedIdentities, {
        orgId: args.orgId,
        refs: [knowledgePage.identity],
      });
      const cachedEntityId = cached[0]?.entityId;
      const entityId =
        cachedEntityId ??
        (
          await ctx.runAction(internal.spark.resolveEntityForActor, {
            orgId: args.orgId,
            source: knowledgePage.identity.source,
            gid: knowledgePage.identity.gid,
          })
        ).entityId;

      if (!entityId) {
        continue;
      }
      if (knowledgePage.entityId === entityId) {
        continue;
      }
      const result = await ctx.runMutation(
        internal.playground.linkKnowledgePageEntityId,
        {
          orgId: args.orgId,
          pageId: knowledgePage._id,
          entityId,
        },
      );
      if (result.linked) {
        linked += 1;
      }
    }

    return {
      processed,
      linked,
      nextCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const linkProjectPagesByTitleForOrg = internalMutation({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ processed: number; linked: number; unmatched: number }> => {
    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_type", (q) =>
        q.eq("orgId", args.orgId).eq("type", "project"),
      )
      .take(500);
    let processed = 0;
    let linked = 0;
    let unmatched = 0;
    for (const page of pages) {
      if (page.status !== "active") {
        continue;
      }
      processed += 1;
      const entity = await ctx.db
        .query("entities")
        .withIndex("by_org_kind_displayName", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("kind", "project")
            .eq("displayName", page.title),
        )
        .first();
      if (!entity) {
        unmatched += 1;
        continue;
      }
      if (page.entityId !== entity._id) {
        await ctx.db.patch(page._id, { entityId: entity._id });
      }
      linked += 1;
    }
    return { processed, linked, unmatched };
  },
});

export const pageEntityRefsForBackfill = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
    includeEntityIdentities: v.boolean(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ refs: EntityRef[]; continueCursor: string; isDone: boolean }> => {
    const eventsPage = await ctx.db
      .query("events")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    const refsByKey = new Map<string, EntityRef>();
    for (const event of eventsPage.page) {
      addDistinctEntityRef(refsByKey, event.actorRef);
    }

    if (args.includeEntityIdentities) {
      const entityPages = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_type_status_updatedAt", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("type", "entity")
            .eq("status", "active"),
        )
        .collect();
      for (const page of entityPages) {
        addDistinctEntityRef(refsByKey, page.identity);
      }
      const projectPages = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_type_status_updatedAt", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("type", "project")
            .eq("status", "active"),
        )
        .collect();
      for (const page of projectPages) {
        addDistinctEntityRef(refsByKey, page.identity);
      }
    }

    return {
      refs: Array.from(refsByKey.values()),
      continueCursor: eventsPage.continueCursor,
      isDone: eventsPage.isDone,
    };
  },
});

export const backfillEntitiesForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ processed: number; nextCursor: string; isDone: boolean }> => {
    const numItems = normalizeBoundedInteger(args.batchSize, 100, 1, 500);
    const page = await ctx.runQuery(
      internal.playground.pageEntityRefsForBackfill,
      {
        orgId: args.orgId,
        cursor: args.cursor ?? null,
        numItems,
        includeEntityIdentities: args.cursor == null,
      },
    );

    let processed = 0;
    for (const ref of page.refs) {
      const resolved = await ctx.runAction(
        internal.spark.resolveEntityForActor,
        {
          orgId: args.orgId,
          source: ref.source,
          gid: ref.gid,
        },
      );
      processed += 1;
      if (!resolved.entityId) {
        // Sections, tasks, and unresolved refs intentionally do not get entities.
        continue;
      }
    }

    return {
      processed,
      nextCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const pageEventsForEntityBackfill = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ page: Array<{ _id: Id<"events"> }>; continueCursor: string; isDone: boolean }> => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });

    return {
      page: page.page.map((event) => ({ _id: event._id })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const backfillEntitiesFromEvents = internalAction({
  args: {
    orgId: v.id("orgs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ processed: number; nextCursor: string; isDone: boolean }> => {
    const numItems = normalizeBoundedInteger(args.batchSize, 100, 1, 500);
    const page = await ctx.runQuery(internal.playground.pageEventsForEntityBackfill, {
      orgId: args.orgId,
      cursor: args.cursor ?? null,
      numItems,
    });

    for (const event of page.page) {
      await ctx.runAction(internal.spark.resolveEventEntities, {
        eventId: event._id,
      });
    }

    return {
      processed: page.page.length,
      nextCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const clearEntitiesForOrg = internalMutation({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (ctx, args): Promise<{ deleted: number }> => {
    const rows = await ctx.db
      .query("entities")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length };
  },
});

const entityKindArg = v.union(
  v.literal("person"),
  v.literal("project"),
  v.literal("bot"),
  v.literal("system"),
  v.literal("shared"),
  v.literal("unknown"),
);

type MergeEntitiesResult = {
  survivorId: Id<"entities">;
  loserId: Id<"entities">;
  aliasesMoved: number;
  pagesMoved: number;
  actorPagesMoved: number;
  eventsMoved: number;
  sessionsMoved: number;
  emailsAdded: number;
  deletedLoser: boolean;
  // Set when a relation had more rows than this pass could repoint within the
  // per-mutation write budget. The loser is then KEPT (not deleted) so no row is
  // left pointing at a deleted entity; re-run the merge to finish draining.
  truncated?: boolean;
  dryRun: boolean;
};

const ENTITY_MERGE_DRY_RUN_LINK_LIMIT = 5000;
// Max rows a single mergeEntities mutation will repoint across all relations.
// Well under Convex's 16k per-transaction write limit, leaving headroom for the
// survivor patch + loser delete. Larger merges drain over multiple re-runs.
const MERGE_ENTITY_WRITE_BUDGET = 6000;
const ENTITY_MERGE_DRY_RUN_ORG_PAGE_SIZE = 100;

type EntityMergeConfidence = "high" | "medium" | "review";

type EntityMergeLinkCounts = {
  aliases: number;
  pages: number;
  actorPages: number;
  events: number;
  sessions: number;
  truncated: boolean;
};

type EntityMergeCandidateGroupSeed = {
  key: string;
  reason: string;
  confidence: EntityMergeConfidence;
  entityIds: Set<string>;
  evidence: string[];
};

type EntityMergePairDraft = {
  leftId: Id<"entities">;
  rightId: Id<"entities">;
  reasons: Set<string>;
  groupKeys: Set<string>;
  evidence: Set<string>;
  confidence: EntityMergeConfidence;
};

type EntityMergeDryRunEntitySummary = {
  entityId: Id<"entities">;
  displayName: string;
  kind: Doc<"entities">["kind"];
  emails: string[];
  teamMemberId: Id<"teamMembers"> | null;
  aliasCount: number;
  aliases: Array<{
    source: string;
    gid: string;
    name: string | null;
    email: string | null;
  }>;
  linkCounts: EntityMergeLinkCounts;
};

type EntityMergeDryRunCandidate = {
  survivor: EntityMergeDryRunEntitySummary;
  loser: EntityMergeDryRunEntitySummary;
  confidence: EntityMergeConfidence;
  reasons: string[];
  evidence: string[];
  groupKeys: string[];
  wouldMove: MergeEntitiesResult;
  truncatedCounts: boolean;
};

type EntityMergeDryRunOrgResult = {
  orgId: OrgId;
  dryRun: true;
  includeReview: boolean;
  inventory: {
    entityCount: number;
    aliasCount: number;
    linkedAliasCount: number;
    unlinkedAliasCount: number;
    danglingAliasCount: number;
    duplicateEvidenceGroupCount: number;
  };
  candidatePairCount: number;
  returnedCandidatePairCount: number;
  truncated: boolean;
  candidates: EntityMergeDryRunCandidate[];
};

type EntityMergeDryRunAllOrgsResult = {
  dryRun: true;
  includeReview: boolean;
  orgCount: number;
  totals: {
    entityCount: number;
    aliasCount: number;
    candidatePairCount: number;
    returnedCandidatePairCount: number;
    truncated: boolean;
  };
  orgs: EntityMergeDryRunOrgResult[];
};

const ENTITY_MERGE_CONFIDENCE_SCORE: Record<EntityMergeConfidence, number> = {
  high: 3,
  medium: 2,
  review: 1,
};

function normalizeEntityMergeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9@.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEntityMergeEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function strongerEntityMergeConfidence(
  left: EntityMergeConfidence,
  right: EntityMergeConfidence,
): EntityMergeConfidence {
  return ENTITY_MERGE_CONFIDENCE_SCORE[left] >=
    ENTITY_MERGE_CONFIDENCE_SCORE[right]
    ? left
    : right;
}

function addEntityMergeGroupMember(
  groups: Map<string, EntityMergeCandidateGroupSeed>,
  key: string,
  reason: string,
  confidence: EntityMergeConfidence,
  entityId: Id<"entities">,
  evidence: string,
) {
  if (!key) return;
  const group = groups.get(key) ?? {
    key,
    reason,
    confidence,
    entityIds: new Set<string>(),
    evidence: [],
  };
  group.entityIds.add(entityId as string);
  group.confidence = strongerEntityMergeConfidence(group.confidence, confidence);
  if (group.evidence.length < 10 && !group.evidence.includes(evidence)) {
    group.evidence.push(evidence);
  }
  groups.set(key, group);
}

function addEntityMergePairDraft(
  drafts: Map<string, EntityMergePairDraft>,
  leftId: Id<"entities">,
  rightId: Id<"entities">,
  seed: EntityMergeCandidateGroupSeed,
) {
  const sortedIds = [leftId as string, rightId as string].sort();
  const pairKey = `${sortedIds[0]}::${sortedIds[1]}`;
  const draft = drafts.get(pairKey) ?? {
    leftId: sortedIds[0] as Id<"entities">,
    rightId: sortedIds[1] as Id<"entities">,
    reasons: new Set<string>(),
    groupKeys: new Set<string>(),
    evidence: new Set<string>(),
    confidence: "review",
  };
  draft.reasons.add(seed.reason);
  draft.groupKeys.add(seed.key);
  for (const item of seed.evidence) {
    if (draft.evidence.size < 12) {
      draft.evidence.add(item);
    }
  }
  draft.confidence = strongerEntityMergeConfidence(
    draft.confidence,
    seed.confidence,
  );
  drafts.set(pairKey, draft);
}

function isLikelySameEntityName(left: string, right: string): boolean {
  if (!left || !right || left === right) {
    return false;
  }
  const [shorter, longer] =
    left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length >= 4 && longer.split(" ").includes(shorter)) {
    return true;
  }
  if (shorter.length >= 6 && longer.includes(shorter)) {
    return true;
  }
  const shorterWords = shorter.split(" ").filter((word) => word.length > 1);
  const longerWords = new Set(
    longer.split(" ").filter((word) => word.length > 1),
  );
  const sharedWords = shorterWords.filter((word) => longerWords.has(word));
  return shorterWords.length >= 2 && sharedWords.length >= 2;
}

async function countEntityMergeLinksForDryRun(
  ctx: QueryCtx,
  orgId: OrgId,
  entityId: Id<"entities">,
  aliasCount: number,
): Promise<EntityMergeLinkCounts> {
  const pages = await ctx.db
    .query("knowledgePages")
    .withIndex("by_org_entity", (q) =>
      q.eq("orgId", orgId).eq("entityId", entityId),
    )
    .take(ENTITY_MERGE_DRY_RUN_LINK_LIMIT);
  const actorPages = await ctx.db
    .query("knowledgePages")
    .withIndex("by_org_actorEntity", (q) =>
      q.eq("orgId", orgId).eq("actorEntityId", entityId),
    )
    .take(ENTITY_MERGE_DRY_RUN_LINK_LIMIT);
  const events = await ctx.db
    .query("events")
    .withIndex("by_org_actorEntity", (q) =>
      q.eq("orgId", orgId).eq("actorEntityId", entityId),
    )
    .take(ENTITY_MERGE_DRY_RUN_LINK_LIMIT);
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_org_actorEntity", (q) =>
      q.eq("orgId", orgId).eq("actorEntityId", entityId),
    )
    .take(ENTITY_MERGE_DRY_RUN_LINK_LIMIT);

  return {
    aliases: aliasCount,
    pages: pages.length,
    actorPages: actorPages.length,
    events: events.length,
    sessions: sessions.length,
    truncated:
      pages.length === ENTITY_MERGE_DRY_RUN_LINK_LIMIT ||
      actorPages.length === ENTITY_MERGE_DRY_RUN_LINK_LIMIT ||
      events.length === ENTITY_MERGE_DRY_RUN_LINK_LIMIT ||
      sessions.length === ENTITY_MERGE_DRY_RUN_LINK_LIMIT,
  };
}

function getEntityMergeSurvivorScore(
  entity: Doc<"entities">,
  counts: EntityMergeLinkCounts,
): number {
  return (
    (entity.teamMemberId ? 100000 : 0) +
    counts.pages * 1000 +
    counts.actorPages * 500 +
    counts.aliases * 250 +
    counts.sessions * 100 +
    counts.events +
    entity.emails.length * 50 +
    (entity.photoUrl ? 10 : 0)
  );
}

function chooseEntityMergeSurvivor(
  entities: Doc<"entities">[],
  countsByEntityId: Map<string, EntityMergeLinkCounts>,
): Doc<"entities"> {
  return [...entities].sort((left, right) => {
    const leftCounts = countsByEntityId.get(left._id as string) ?? {
      aliases: 0,
      pages: 0,
      actorPages: 0,
      events: 0,
      sessions: 0,
      truncated: false,
    };
    const rightCounts = countsByEntityId.get(right._id as string) ?? {
      aliases: 0,
      pages: 0,
      actorPages: 0,
      events: 0,
      sessions: 0,
      truncated: false,
    };
    const scoreDelta =
      getEntityMergeSurvivorScore(right, rightCounts) -
      getEntityMergeSurvivorScore(left, leftCounts);
    if (scoreDelta !== 0) return scoreDelta;
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (left.displayName.length !== right.displayName.length) {
      return right.displayName.length - left.displayName.length;
    }
    return (left._id as string).localeCompare(right._id as string);
  })[0];
}

function summarizeEntityForMergeDryRun(
  entity: Doc<"entities">,
  aliases: Doc<"identityCache">[],
  counts: EntityMergeLinkCounts,
): EntityMergeDryRunEntitySummary {
  return {
    entityId: entity._id,
    displayName: entity.displayName,
    kind: entity.kind,
    emails: entity.emails,
    teamMemberId: entity.teamMemberId ?? null,
    aliasCount: aliases.length,
    aliases: aliases.slice(0, 10).map((alias) => ({
      source: alias.source,
      gid: alias.gid,
      name: alias.name ?? null,
      email: alias.email ?? null,
    })),
    linkCounts: counts,
  };
}

export const dryRunEntityMergesForOrg = internalQuery({
  args: {
    orgId: v.id("orgs"),
    includeReview: v.optional(v.boolean()),
    maxPairs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<EntityMergeDryRunOrgResult> => {
    const includeReview = args.includeReview ?? true;
    const maxPairs = normalizeBoundedInteger(args.maxPairs, 250, 1, 1000);
    const entities = await ctx.db
      .query("entities")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const entityById = new Map(
      entities.map((entity) => [entity._id as string, entity]),
    );
    const aliases = await ctx.db
      .query("identityCache")
      .withIndex("by_org_source_gid", (q) => q.eq("orgId", args.orgId))
      .collect();
    const aliasesByEntityId = new Map<string, Doc<"identityCache">[]>();
    let unlinkedAliasCount = 0;
    let danglingAliasCount = 0;
    for (const alias of aliases) {
      if (!alias.entityId) {
        unlinkedAliasCount += 1;
        continue;
      }
      const entityId = alias.entityId as string;
      if (!entityById.has(entityId)) {
        danglingAliasCount += 1;
        continue;
      }
      const rows = aliasesByEntityId.get(entityId) ?? [];
      rows.push(alias);
      aliasesByEntityId.set(entityId, rows);
    }

    const countsByEntityId = new Map<string, EntityMergeLinkCounts>();
    for (const entity of entities) {
      countsByEntityId.set(
        entity._id as string,
        await countEntityMergeLinksForDryRun(
          ctx,
          args.orgId,
          entity._id,
          aliasesByEntityId.get(entity._id as string)?.length ?? 0,
        ),
      );
    }

    const groups = new Map<string, EntityMergeCandidateGroupSeed>();
    for (const entity of entities) {
      if (entity.teamMemberId) {
        addEntityMergeGroupMember(
          groups,
          `teamMember:${entity.teamMemberId}`,
          "shared_team_member",
          "high",
          entity._id,
          `teamMember:${entity.teamMemberId}`,
        );
      }
      for (const email of entity.emails) {
        const normalizedEmail = normalizeEntityMergeEmail(email);
        if (!normalizedEmail) continue;
        addEntityMergeGroupMember(
          groups,
          `email:${normalizedEmail}`,
          "shared_email",
          "high",
          entity._id,
          normalizedEmail,
        );
      }
      const normalizedName = normalizeEntityMergeName(entity.displayName);
      if (normalizedName) {
        addEntityMergeGroupMember(
          groups,
          `name:${entity.kind}:${normalizedName}`,
          "same_kind_and_normalized_name",
          "medium",
          entity._id,
          entity.displayName,
        );
      }
    }

    for (const alias of aliases) {
      if (!alias.entityId || !entityById.has(alias.entityId as string)) {
        continue;
      }
      const entity = entityById.get(alias.entityId as string);
      if (!entity) continue;
      addEntityMergeGroupMember(
        groups,
        `source:${alias.source}:${alias.gid}`,
        "shared_source_identity_ref",
        "high",
        alias.entityId,
        `${alias.source}:${alias.gid}`,
      );
      const normalizedEmail = normalizeEntityMergeEmail(alias.email);
      if (normalizedEmail) {
        addEntityMergeGroupMember(
          groups,
          `email:${normalizedEmail}`,
          "shared_email",
          "high",
          alias.entityId,
          normalizedEmail,
        );
      }
      const normalizedName = alias.name
        ? normalizeEntityMergeName(alias.name)
        : "";
      if (normalizedName) {
        addEntityMergeGroupMember(
          groups,
          `name:${entity.kind}:${normalizedName}`,
          "same_kind_and_normalized_alias_name",
          "medium",
          alias.entityId,
          alias.name ?? normalizedName,
        );
      }
    }

    for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
      const left = entities[leftIndex];
      if (left.kind !== "person" && left.kind !== "bot") continue;
      const leftName = normalizeEntityMergeName(left.displayName);
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < entities.length;
        rightIndex += 1
      ) {
        const right = entities[rightIndex];
        if (left.kind !== right.kind) continue;
        const rightName = normalizeEntityMergeName(right.displayName);
        if (!isLikelySameEntityName(leftName, rightName)) continue;
        const key = `similarName:${left._id}:${right._id}`;
        addEntityMergeGroupMember(
          groups,
          key,
          "similar_person_or_bot_name",
          "review",
          left._id,
          left.displayName,
        );
        addEntityMergeGroupMember(
          groups,
          key,
          "similar_person_or_bot_name",
          "review",
          right._id,
          right.displayName,
        );
      }
    }

    const pairDrafts = new Map<string, EntityMergePairDraft>();
    for (const seed of groups.values()) {
      if (seed.entityIds.size <= 1) continue;
      if (!includeReview && seed.confidence === "review") continue;
      const seedEntities = [...seed.entityIds]
        .map((entityId) => entityById.get(entityId))
        .filter((entity): entity is Doc<"entities"> => entity !== undefined);
      if (seedEntities.length <= 1) continue;
      const survivor = chooseEntityMergeSurvivor(
        seedEntities,
        countsByEntityId,
      );
      for (const entity of seedEntities) {
        if (entity._id === survivor._id) continue;
        addEntityMergePairDraft(pairDrafts, survivor._id, entity._id, seed);
      }
    }

    const candidates = [...pairDrafts.values()].map((draft) => {
      const left = entityById.get(draft.leftId as string);
      const right = entityById.get(draft.rightId as string);
      if (!left || !right) {
        throw new Error("dryRunEntityMergesForOrg: candidate entity missing");
      }
      const survivor = chooseEntityMergeSurvivor(
        [left, right],
        countsByEntityId,
      );
      const loser = survivor._id === left._id ? right : left;
      const survivorCounts = countsByEntityId.get(survivor._id as string) ?? {
        aliases: 0,
        pages: 0,
        actorPages: 0,
        events: 0,
        sessions: 0,
        truncated: false,
      };
      const loserCounts = countsByEntityId.get(loser._id as string) ?? {
        aliases: 0,
        pages: 0,
        actorPages: 0,
        events: 0,
        sessions: 0,
        truncated: false,
      };
      const mergedEmails = Array.from(
        new Set([...survivor.emails, ...loser.emails]),
      );
      return {
        survivor: summarizeEntityForMergeDryRun(
          survivor,
          aliasesByEntityId.get(survivor._id as string) ?? [],
          survivorCounts,
        ),
        loser: summarizeEntityForMergeDryRun(
          loser,
          aliasesByEntityId.get(loser._id as string) ?? [],
          loserCounts,
        ),
        confidence: draft.confidence,
        reasons: [...draft.reasons].sort(),
        evidence: [...draft.evidence],
        groupKeys: [...draft.groupKeys].sort(),
        wouldMove: {
          survivorId: survivor._id,
          loserId: loser._id,
          aliasesMoved: loserCounts.aliases,
          pagesMoved: loserCounts.pages,
          actorPagesMoved: loserCounts.actorPages,
          eventsMoved: loserCounts.events,
          sessionsMoved: loserCounts.sessions,
          emailsAdded: mergedEmails.length - survivor.emails.length,
          deletedLoser: false,
          dryRun: true,
        } satisfies MergeEntitiesResult,
        truncatedCounts: loserCounts.truncated || survivorCounts.truncated,
      };
    });

    candidates.sort((left, right) => {
      const confidenceDelta =
        ENTITY_MERGE_CONFIDENCE_SCORE[right.confidence] -
        ENTITY_MERGE_CONFIDENCE_SCORE[left.confidence];
      if (confidenceDelta !== 0) return confidenceDelta;
      const leftMoved =
        left.wouldMove.aliasesMoved +
        left.wouldMove.pagesMoved +
        left.wouldMove.actorPagesMoved +
        left.wouldMove.eventsMoved +
        left.wouldMove.sessionsMoved;
      const rightMoved =
        right.wouldMove.aliasesMoved +
        right.wouldMove.pagesMoved +
        right.wouldMove.actorPagesMoved +
        right.wouldMove.eventsMoved +
        right.wouldMove.sessionsMoved;
      if (leftMoved !== rightMoved) return rightMoved - leftMoved;
      return left.loser.displayName.localeCompare(right.loser.displayName);
    });

    const limitedCandidates = candidates.slice(0, maxPairs);

    return {
      orgId: args.orgId,
      dryRun: true,
      includeReview,
      inventory: {
        entityCount: entities.length,
        aliasCount: aliases.length,
        linkedAliasCount: aliases.length - unlinkedAliasCount - danglingAliasCount,
        unlinkedAliasCount,
        danglingAliasCount,
        duplicateEvidenceGroupCount: [...groups.values()].filter(
          (group) => group.entityIds.size > 1,
        ).length,
      },
      candidatePairCount: candidates.length,
      returnedCandidatePairCount: limitedCandidates.length,
      truncated: candidates.length > limitedCandidates.length,
      candidates: limitedCandidates,
    };
  },
});

export const dryRunEntityMergesForAllOrgs = internalAction({
  args: {
    includeReview: v.optional(v.boolean()),
    maxPairsPerOrg: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<EntityMergeDryRunAllOrgsResult> => {
    let cursor: string | null = null;
    let orgCount = 0;
    let candidatePairCount = 0;
    let returnedCandidatePairCount = 0;
    let entityCount = 0;
    let aliasCount = 0;
    let truncated = false;
    const orgs: EntityMergeDryRunOrgResult[] = [];

    do {
      const page = (await ctx.runQuery(internal.spark.listOrgIdsPage, {
        paginationOpts: {
          numItems: ENTITY_MERGE_DRY_RUN_ORG_PAGE_SIZE,
          cursor,
        },
      })) as {
        page: Id<"orgs">[];
        isDone: boolean;
        continueCursor: string | null;
      };
      for (const orgId of page.page) {
        orgCount += 1;
        const result = (await ctx.runQuery(
          internal.playground.dryRunEntityMergesForOrg,
          {
            orgId,
            includeReview: args.includeReview,
            maxPairs: args.maxPairsPerOrg,
          },
        )) as EntityMergeDryRunOrgResult;
        candidatePairCount += result.candidatePairCount;
        returnedCandidatePairCount += result.returnedCandidatePairCount;
        entityCount += result.inventory.entityCount;
        aliasCount += result.inventory.aliasCount;
        truncated = truncated || result.truncated;
        orgs.push(result);
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);

    return {
      dryRun: true,
      includeReview: args.includeReview ?? true,
      orgCount,
      totals: {
        entityCount,
        aliasCount,
        candidatePairCount,
        returnedCandidatePairCount,
        truncated,
      },
      orgs,
    };
  },
});

type UnlinkedIdentityAliasForRepair = {
  source: string;
  gid: string;
  name: string | null;
  email: string | null;
  photoUrl: string | null;
  fetchedAt: number;
};

export const pageUnlinkedIdentityAliasesForRepair = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    aliases: UnlinkedIdentityAliasForRepair[];
    continueCursor: string;
    isDone: boolean;
  }> => {
    const page = await ctx.db
      .query("identityCache")
      .withIndex("by_org_source_gid", (q) => q.eq("orgId", args.orgId))
      .paginate({ cursor: args.cursor, numItems: args.numItems });

    return {
      aliases: page.page
        .filter((alias) => alias.entityId === undefined)
        .map((alias) => ({
          source: alias.source,
          gid: alias.gid,
          name: alias.name ?? null,
          email: alias.email ?? null,
          photoUrl: alias.photoUrl ?? null,
          fetchedAt: alias.fetchedAt,
        })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

function canRepairUnlinkedIdentityAlias(alias: UnlinkedIdentityAliasForRepair) {
  return (
    alias.source === "asana" ||
    alias.source === "slack" ||
    alias.source === "github"
  );
}

export const repairUnlinkedIdentityAliasesForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    dryRun: boolean;
    processed: number;
    attempted: number;
    linked: number;
    skipped: number;
    nextCursor: string;
    isDone: boolean;
    sample: Array<{
      source: string;
      gid: string;
      name: string | null;
      email: string | null;
      action: "would_resolve" | "resolved" | "unresolved" | "skipped";
      entityId: Id<"entities"> | null;
    }>;
  }> => {
    const numItems = normalizeBoundedInteger(args.batchSize, 100, 1, 500);
    const page = await ctx.runQuery(
      internal.playground.pageUnlinkedIdentityAliasesForRepair,
      {
        orgId: args.orgId,
        cursor: args.cursor ?? null,
        numItems,
      },
    );

    const dryRun = args.dryRun ?? true;
    let attempted = 0;
    let linked = 0;
    let skipped = 0;
    const sample: Array<{
      source: string;
      gid: string;
      name: string | null;
      email: string | null;
      action: "would_resolve" | "resolved" | "unresolved" | "skipped";
      entityId: Id<"entities"> | null;
    }> = [];

    for (const alias of page.aliases) {
      if (!canRepairUnlinkedIdentityAlias(alias)) {
        skipped += 1;
        if (sample.length < 20) {
          sample.push({
            source: alias.source,
            gid: alias.gid,
            name: alias.name,
            email: alias.email,
            action: "skipped",
            entityId: null,
          });
        }
        continue;
      }
      attempted += 1;
      if (dryRun) {
        if (sample.length < 20) {
          sample.push({
            source: alias.source,
            gid: alias.gid,
            name: alias.name,
            email: alias.email,
            action: "would_resolve",
            entityId: null,
          });
        }
        continue;
      }
      const result = await ctx.runAction(internal.spark.resolveEntityForActor, {
        orgId: args.orgId,
        source: alias.source,
        gid: alias.gid,
        name: alias.name ?? undefined,
        email: alias.email ?? undefined,
      });
      if (result.entityId) {
        linked += 1;
      }
      if (sample.length < 20) {
        sample.push({
          source: alias.source,
          gid: alias.gid,
          name: alias.name,
          email: alias.email,
          action: result.entityId ? "resolved" : "unresolved",
          entityId: result.entityId,
        });
      }
    }

    return {
      dryRun,
      processed: page.aliases.length,
      attempted,
      linked,
      skipped,
      nextCursor: page.continueCursor,
      isDone: page.isDone,
      sample,
    };
  },
});

type EntityPageVariantPage = {
  id: Id<"knowledgePages">;
  title: string;
  slug: string;
  entity: string | null;
  entityId: Id<"entities"> | null;
  identity: { source: string; gid: string } | null;
  sourceCount: number;
  updatedAt: number;
  names: string[];
  compactNames: string[];
};

type EntityPageVariantGroup = {
  key: string;
  confidence: EntityMergeConfidence;
  reasons: string[];
  names: string[];
  survivorId: Id<"knowledgePages">;
  survivorTitle: string;
  canonicalEntityId: Id<"entities"> | null;
  pages: EntityPageVariantPage[];
  losers: Array<{ id: Id<"knowledgePages">; title: string }>;
};

type EntityPageVariantGroupResult = {
  orgId: OrgId;
  includeShortNameMatches: boolean;
  groupCount: number;
  returnedGroupCount: number;
  groups: EntityPageVariantGroup[];
};

type EntityPageVariantGroupSeed = {
  key: string;
  reason: string;
  confidence: EntityMergeConfidence;
  pageIds: Set<string>;
  names: Set<string>;
};

function compactEntityPageVariantName(value: string): string {
  const words = value
    .trim()
    .toLowerCase()
    .replace(/^entity[-_\s]+/, "")
    .match(/[a-z0-9]+/g);
  return words ? words.join("") : "";
}

function tokenizeEntityPageVariantName(value: string): string[] {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^entity[-_\s]+/, "")
      .match(/[a-z0-9]+/g) ?? []
  );
}

function isUsableEntityPageVariantName(value: string | null | undefined) {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("@") || trimmed.includes("/")) return false;
  if (/^(asana|slack|github):/i.test(trimmed)) return false;
  if (!/[a-z]/i.test(trimmed)) return false;
  return compactEntityPageVariantName(trimmed).length >= 3;
}

function isFullEntityPageVariantName(value: string): boolean {
  const tokens = tokenizeEntityPageVariantName(value);
  const compact = compactEntityPageVariantName(value);
  return tokens.length >= 2 || compact.length >= 8;
}

function isShortEntityPageVariantName(value: string): boolean {
  const tokens = tokenizeEntityPageVariantName(value);
  const compact = compactEntityPageVariantName(value);
  return tokens.length === 1 && compact.length >= 3 && compact.length <= 7;
}

function entityPageVariantRefKey(ref: { source: string; gid: string }) {
  return `${ref.source}:${ref.gid}`;
}

function addEntityPageVariantGroupSeed(
  seeds: EntityPageVariantGroupSeed[],
  key: string,
  reason: string,
  confidence: EntityMergeConfidence,
  pages: EntityPageVariantPage[],
  names: string[],
) {
  const pageIds = new Set(pages.map((page) => page.id as string));
  if (pageIds.size <= 1) return;
  seeds.push({
    key,
    reason,
    confidence,
    pageIds,
    names: new Set(names),
  });
}

function chooseEntityPageVariantSurvivor(
  pages: EntityPageVariantPage[],
): EntityPageVariantPage {
  return [...pages].sort((left, right) => {
    const leftScore =
      (left.entityId ? 100000 : 0) +
      (left.identity ? 10000 : 0) +
      left.sourceCount * 100 +
      Math.max(...left.compactNames.map((name) => name.length), 0);
    const rightScore =
      (right.entityId ? 100000 : 0) +
      (right.identity ? 10000 : 0) +
      right.sourceCount * 100 +
      Math.max(...right.compactNames.map((name) => name.length), 0);
    if (leftScore !== rightScore) return rightScore - leftScore;
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
    return right.title.length - left.title.length;
  })[0];
}

function weakestEntityMergeConfidence(
  left: EntityMergeConfidence,
  right: EntityMergeConfidence,
): EntityMergeConfidence {
  return ENTITY_MERGE_CONFIDENCE_SCORE[left] <=
    ENTITY_MERGE_CONFIDENCE_SCORE[right]
    ? left
    : right;
}

function buildEntityPageVariantGroups(
  pages: EntityPageVariantPage[],
  includeShortNameMatches: boolean,
): EntityPageVariantGroup[] {
  const pageById = new Map(pages.map((page) => [page.id as string, page]));
  const exactPagesByCompact = new Map<string, EntityPageVariantPage[]>();
  const fullPagesByCompact = new Map<string, EntityPageVariantPage[]>();
  const shortNamesByPageId = new Map<string, Set<string>>();

  for (const page of pages) {
    for (const name of page.names) {
      const compact = compactEntityPageVariantName(name);
      if (!compact) continue;
      const exact = exactPagesByCompact.get(compact) ?? [];
      exact.push(page);
      exactPagesByCompact.set(compact, exact);
      if (isFullEntityPageVariantName(name)) {
        const full = fullPagesByCompact.get(compact) ?? [];
        full.push(page);
        fullPagesByCompact.set(compact, full);
      }
      if (isShortEntityPageVariantName(name)) {
        const shorts = shortNamesByPageId.get(page.id as string) ?? new Set();
        shorts.add(compact);
        shortNamesByPageId.set(page.id as string, shorts);
      }
    }
  }

  const seeds: EntityPageVariantGroupSeed[] = [];
  for (const [compact, compactPages] of exactPagesByCompact) {
    const uniquePages = Array.from(
      new Map(compactPages.map((page) => [page.id as string, page])).values(),
    );
    addEntityPageVariantGroupSeed(
      seeds,
      `compact:${compact}`,
      "same_compact_page_name",
      "medium",
      uniquePages,
      [compact],
    );
  }

  if (includeShortNameMatches) {
    for (const [pageId, shortNames] of shortNamesByPageId) {
      const page = pageById.get(pageId);
      if (!page) continue;
      for (const shortName of shortNames) {
        const matchingFullKeys = [...fullPagesByCompact.keys()].filter(
          (fullKey) => fullKey !== shortName && fullKey.startsWith(shortName),
        );
        if (matchingFullKeys.length !== 1) continue;
        const fullKey = matchingFullKeys[0];
        addEntityPageVariantGroupSeed(
          seeds,
          `uniquePrefix:${shortName}:${fullKey}`,
          "unique_short_name_prefix",
          "review",
          [page, ...(fullPagesByCompact.get(fullKey) ?? [])],
          [shortName, fullKey],
        );
      }
    }
  }

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  };

  for (const seed of seeds) {
    const pageIds = [...seed.pageIds];
    for (const pageId of pageIds) {
      parent.set(pageId, parent.get(pageId) ?? pageId);
    }
    for (const pageId of pageIds.slice(1)) {
      union(pageIds[0], pageId);
    }
  }

  const components = new Map<
    string,
    {
      pageIds: Set<string>;
      reasons: Set<string>;
      names: Set<string>;
      confidence: EntityMergeConfidence;
    }
  >();
  for (const seed of seeds) {
    const root = find([...seed.pageIds][0]);
    const component = components.get(root) ?? {
      pageIds: new Set<string>(),
      reasons: new Set<string>(),
      names: new Set<string>(),
      confidence: "high",
    };
    for (const pageId of seed.pageIds) {
      component.pageIds.add(pageId);
    }
    component.reasons.add(seed.reason);
    for (const name of seed.names) {
      component.names.add(name);
    }
    component.confidence = weakestEntityMergeConfidence(
      component.confidence,
      seed.confidence,
    );
    components.set(root, component);
  }

  return [...components.entries()]
    .map(([root, component]) => {
      const groupPages = [...component.pageIds]
        .map((pageId) => pageById.get(pageId))
        .filter((page): page is EntityPageVariantPage => page !== undefined);
      const survivor = chooseEntityPageVariantSurvivor(groupPages);
      const canonicalEntityId =
        survivor.entityId ??
        groupPages.find((page) => page.entityId !== null)?.entityId ??
        null;
      return {
        key: root,
        confidence: component.confidence,
        reasons: [...component.reasons].sort(),
        names: dedupeStrings([
          ...component.names,
          ...groupPages.flatMap((page) => page.names),
        ]),
        survivorId: survivor.id,
        survivorTitle: survivor.title,
        canonicalEntityId,
        pages: groupPages,
        losers: groupPages
          .filter((page) => page.id !== survivor.id)
          .map((page) => ({ id: page.id, title: page.title })),
      };
    })
    .filter((group) => group.pages.length > 1)
    .sort((left, right) => {
      if (left.confidence !== right.confidence) {
        return (
          ENTITY_MERGE_CONFIDENCE_SCORE[right.confidence] -
          ENTITY_MERGE_CONFIDENCE_SCORE[left.confidence]
        );
      }
      return right.pages.length - left.pages.length;
    });
}

export const listEntityPageNameVariantGroupsForOrg = internalQuery({
  args: {
    orgId: v.id("orgs"),
    query: v.optional(v.string()),
    includeShortNameMatches: v.optional(v.boolean()),
    maxGroups: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<EntityPageVariantGroupResult> => {
    const includeShortNameMatches = args.includeShortNameMatches ?? true;
    const maxGroups = normalizeBoundedInteger(args.maxGroups, 100, 1, 500);
    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_type_status_updatedAt", (q) =>
        q.eq("orgId", args.orgId).eq("type", "entity").eq("status", "active"),
      )
      .collect();
    const aliases = await ctx.db
      .query("identityCache")
      .withIndex("by_org_source_gid", (q) => q.eq("orgId", args.orgId))
      .collect();
    const entities = await ctx.db
      .query("entities")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const aliasByRef = new Map(
      aliases.map((alias) => [
        entityPageVariantRefKey(alias),
        alias,
      ]),
    );
    const aliasesByEntityId = new Map<string, Doc<"identityCache">[]>();
    for (const alias of aliases) {
      if (!alias.entityId) continue;
      const rows = aliasesByEntityId.get(alias.entityId as string) ?? [];
      rows.push(alias);
      aliasesByEntityId.set(alias.entityId as string, rows);
    }
    const entityById = new Map(
      entities.map((entity) => [entity._id as string, entity]),
    );

    const variantPages: EntityPageVariantPage[] = pages.map((page) => {
      const names: string[] = [page.title, page.entity ?? "", page.slug];
      if (page.identity) {
        const alias = aliasByRef.get(entityPageVariantRefKey(page.identity));
        names.push(alias?.name ?? "");
        names.push(alias?.source === "github" ? alias.gid : "");
      }
      if (page.entityId) {
        const entity = entityById.get(page.entityId as string);
        names.push(entity?.displayName ?? "");
        for (const alias of aliasesByEntityId.get(page.entityId as string) ?? []) {
          names.push(alias.name ?? "");
          names.push(alias.source === "github" ? alias.gid : "");
        }
      }
      const filteredNames = dedupeStrings(
        names.filter((name) => isUsableEntityPageVariantName(name)),
      );
      return {
        id: page._id,
        title: page.title,
        slug: page.slug,
        entity: page.entity ?? null,
        entityId: page.entityId ?? null,
        identity: page.identity ?? null,
        sourceCount: page.sourceCount,
        updatedAt: page.updatedAt,
        names: filteredNames,
        compactNames: dedupeStrings(
          filteredNames.map((name) => compactEntityPageVariantName(name)),
        ),
      };
    });

    const query = args.query?.trim();
    const queryCompact = query ? compactEntityPageVariantName(query) : "";
    const groups = buildEntityPageVariantGroups(
      variantPages,
      includeShortNameMatches,
    ).filter((group) => {
      if (!query || !queryCompact) return true;
      return group.pages.some(
        (page) =>
          page.title.toLowerCase().includes(query.toLowerCase()) ||
          page.slug.toLowerCase().includes(query.toLowerCase()) ||
          page.compactNames.some(
            (name) => name.includes(queryCompact) || queryCompact.includes(name),
          ),
      );
    });

    return {
      orgId: args.orgId,
      includeShortNameMatches,
      groupCount: groups.length,
      returnedGroupCount: Math.min(groups.length, maxGroups),
      groups: groups.slice(0, maxGroups),
    };
  },
});

export const mergeEntityPageNameVariantsForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    query: v.optional(v.string()),
    includeShortNameMatches: v.optional(v.boolean()),
    applyReviewMatches: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
    maxGroups: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    dryRun: boolean;
    groupCount: number;
    appliedGroupCount: number;
    skippedReviewGroupCount: number;
    linkedPages: number;
    mergedPages: number;
    mergedEntities: number;
    groups: EntityPageVariantGroup[];
  }> => {
    const dryRun = args.dryRun ?? true;
    const applyReviewMatches = args.applyReviewMatches ?? false;
    const result = (await ctx.runQuery(
      internal.playground.listEntityPageNameVariantGroupsForOrg,
      {
        orgId: args.orgId,
        query: args.query,
        includeShortNameMatches: args.includeShortNameMatches,
        maxGroups: args.maxGroups,
      },
    )) as EntityPageVariantGroupResult;

    let appliedGroupCount = 0;
    let skippedReviewGroupCount = 0;
    let linkedPages = 0;
    let mergedPages = 0;
    let mergedEntities = 0;

    for (const group of result.groups) {
      if (group.confidence === "review" && !applyReviewMatches) {
        skippedReviewGroupCount += 1;
        continue;
      }
      appliedGroupCount += 1;
      if (dryRun) continue;

      if (group.canonicalEntityId) {
        const entityIds = dedupeStrings(
          group.pages
            .map((page) => page.entityId)
            .filter((entityId): entityId is Id<"entities"> => entityId !== null)
            .map((entityId) => entityId as string),
        ) as Array<Id<"entities">>;
        for (const entityId of entityIds) {
          if (entityId === group.canonicalEntityId) continue;
          await ctx.runMutation(internal.playground.mergeEntities, {
            orgId: args.orgId,
            survivorId: group.canonicalEntityId,
            loserId: entityId,
            dryRun: false,
          });
          mergedEntities += 1;
        }
        for (const page of group.pages) {
          if (page.entityId === group.canonicalEntityId) continue;
          const linkResult = await ctx.runMutation(
            internal.playground.linkKnowledgePageEntityId,
            {
              orgId: args.orgId,
              pageId: page.id,
              entityId: group.canonicalEntityId,
            },
          );
          if (linkResult.linked) {
            linkedPages += 1;
          }
        }
      }

      for (const loser of group.losers) {
        await ctx.runMutation(internal.knowledge.mergeKnowledgePages, {
          orgId: args.orgId,
          loserId: loser.id,
          winnerId: group.survivorId,
        });
        mergedPages += 1;
      }
    }

    return {
      dryRun,
      groupCount: result.groupCount,
      appliedGroupCount,
      skippedReviewGroupCount,
      linkedPages,
      mergedPages,
      mergedEntities,
      groups: result.groups,
    };
  },
});

async function mergeEntitiesImpl(
  ctx: MutationCtx,
  orgId: OrgId,
  survivorId: Id<"entities">,
  loserId: Id<"entities">,
  dryRun: boolean,
): Promise<MergeEntitiesResult> {
  if (survivorId === loserId) {
    throw new Error("BAD_REQUEST: survivor and loser must differ");
  }
  const survivor = await ctx.db.get(survivorId);
  if (!survivor || survivor.orgId !== orgId) {
    throw new Error("BAD_REQUEST: survivor entity not found in org");
  }
  const loser = await ctx.db.get(loserId);
  if (!loser || loser.orgId !== orgId) {
    throw new Error("BAD_REQUEST: loser entity not found in org");
  }

  const mergedEmails = Array.from(
    new Set([...survivor.emails, ...loser.emails]),
  );
  const emailsAdded = mergedEmails.length - survivor.emails.length;

  if (dryRun) {
    // Preview only — bounded counts (capped at the write budget for display).
    const aliases = await ctx.db
      .query("identityCache")
      .withIndex("by_entity", (q) => q.eq("entityId", loserId))
      .take(MERGE_ENTITY_WRITE_BUDGET);
    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_entity", (q) =>
        q.eq("orgId", orgId).eq("entityId", loserId),
      )
      .take(MERGE_ENTITY_WRITE_BUDGET);
    const actorPages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_actorEntity", (q) =>
        q.eq("orgId", orgId).eq("actorEntityId", loserId),
      )
      .take(MERGE_ENTITY_WRITE_BUDGET);
    const events = await ctx.db
      .query("events")
      .withIndex("by_org_actorEntity", (q) =>
        q.eq("orgId", orgId).eq("actorEntityId", loserId),
      )
      .take(MERGE_ENTITY_WRITE_BUDGET);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_org_actorEntity", (q) =>
        q.eq("orgId", orgId).eq("actorEntityId", loserId),
      )
      .take(MERGE_ENTITY_WRITE_BUDGET);
    return {
      survivorId,
      loserId,
      aliasesMoved: aliases.length,
      pagesMoved: pages.length,
      actorPagesMoved: actorPages.length,
      eventsMoved: events.length,
      sessionsMoved: sessions.length,
      emailsAdded,
      deletedLoser: false,
      dryRun: true,
    };
  }

  // Repoint every row of each loser relation onto the survivor, paged via its
  // index, until the relation is drained or the shared write budget is spent.
  // `step` loads + repoints one batch and returns the rows it moved; `drain`
  // loops it. A short batch means the relation is fully drained; running out of
  // budget flips `truncated`, which keeps the loser alive (no dangling refs).
  let writesUsed = 0;
  let truncated = false;
  const drain = async (
    step: (limit: number) => Promise<number>,
  ): Promise<number> => {
    let moved = 0;
    for (;;) {
      const remaining = MERGE_ENTITY_WRITE_BUDGET - writesUsed;
      if (remaining <= 0) {
        truncated = true;
        return moved;
      }
      const limit = Math.min(500, remaining);
      const movedNow = await step(limit);
      moved += movedNow;
      writesUsed += movedNow;
      if (movedNow < limit) {
        return moved;
      }
    }
  };

  const aliasesMoved = await drain(async (limit) => {
    const batch = await ctx.db
      .query("identityCache")
      .withIndex("by_entity", (q) => q.eq("entityId", loserId))
      .take(limit);
    for (const row of batch) {
      await ctx.db.patch(row._id, { entityId: survivorId });
    }
    return batch.length;
  });
  const pagesMoved = await drain(async (limit) => {
    const batch = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_entity", (q) =>
        q.eq("orgId", orgId).eq("entityId", loserId),
      )
      .take(limit);
    for (const row of batch) {
      await ctx.db.patch(row._id, { entityId: survivorId });
    }
    return batch.length;
  });
  const actorPagesMoved = await drain(async (limit) => {
    const batch = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_actorEntity", (q) =>
        q.eq("orgId", orgId).eq("actorEntityId", loserId),
      )
      .take(limit);
    for (const row of batch) {
      await ctx.db.patch(row._id, { actorEntityId: survivorId });
    }
    return batch.length;
  });
  const eventsMoved = await drain(async (limit) => {
    const batch = await ctx.db
      .query("events")
      .withIndex("by_org_actorEntity", (q) =>
        q.eq("orgId", orgId).eq("actorEntityId", loserId),
      )
      .take(limit);
    for (const row of batch) {
      await ctx.db.patch(row._id, { actorEntityId: survivorId });
    }
    return batch.length;
  });
  const sessionsMoved = await drain(async (limit) => {
    const batch = await ctx.db
      .query("sessions")
      .withIndex("by_org_actorEntity", (q) =>
        q.eq("orgId", orgId).eq("actorEntityId", loserId),
      )
      .take(limit);
    for (const row of batch) {
      await ctx.db.patch(row._id, { actorEntityId: survivorId });
    }
    return batch.length;
  });

  const patch: {
    updatedAt: number;
    emails?: string[];
    photoUrl?: string;
    teamMemberId?: Id<"teamMembers">;
  } = { updatedAt: Date.now() };
  if (emailsAdded > 0) {
    patch.emails = mergedEmails;
  }
  if (!survivor.photoUrl && loser.photoUrl) {
    patch.photoUrl = loser.photoUrl;
  }
  if (!survivor.teamMemberId && loser.teamMemberId) {
    patch.teamMemberId = loser.teamMemberId;
  }
  await ctx.db.patch(survivorId, patch);
  // Only delete the loser once every relation is fully repointed. If the write
  // budget ran out, keep the loser so its remaining rows still reference a live
  // entity; re-running the merge drains the rest and then deletes it.
  if (!truncated) {
    await ctx.db.delete(loserId);
  }

  // The survivor may now own >1 entity/project page (its own + the loser's
  // repointed page). Consolidate duplicates of the same type into one so the
  // knowledgebase shows a single page — the entity merge alone repoints
  // entityId but leaves both pages. Async so it runs outside this transaction.
  await ctx.scheduler.runAfter(0, internal.playground.consolidateEntityPagesForEntity, {
    orgId,
    entityId: survivorId,
  });

  return {
    survivorId,
    loserId,
    aliasesMoved,
    pagesMoved,
    actorPagesMoved,
    eventsMoved,
    sessionsMoved,
    emailsAdded,
    deletedLoser: !truncated,
    truncated,
    dryRun: false,
  };
}

async function setEntityKindImpl(
  ctx: MutationCtx,
  orgId: OrgId,
  entityId: Id<"entities">,
  kind: Doc<"entities">["kind"],
): Promise<{ entityId: Id<"entities">; kind: string }> {
  const entity = await ctx.db.get(entityId);
  if (!entity || entity.orgId !== orgId) {
    throw new Error("BAD_REQUEST: entity not found in org");
  }
  await ctx.db.patch(entityId, { kind, updatedAt: Date.now() });
  return { entityId, kind };
}

async function renameEntityImpl(
  ctx: MutationCtx,
  orgId: OrgId,
  entityId: Id<"entities">,
  displayName: string,
): Promise<{ entityId: Id<"entities">; displayName: string }> {
  const name = displayName.trim();
  if (!name) {
    throw new Error("BAD_REQUEST: displayName required");
  }
  const entity = await ctx.db.get(entityId);
  if (!entity || entity.orgId !== orgId) {
    throw new Error("BAD_REQUEST: entity not found in org");
  }
  await ctx.db.patch(entityId, { displayName: name, updatedAt: Date.now() });
  return { entityId, displayName: name };
}

// Internal (CLI / scripted admin) ------------------------------------------

export const mergeEntities = internalMutation({
  args: {
    orgId: v.id("orgs"),
    survivorId: v.id("entities"),
    loserId: v.id("entities"),
    dryRun: v.optional(v.boolean()),
  },
  handler: (ctx, args): Promise<MergeEntitiesResult> =>
    mergeEntitiesImpl(
      ctx,
      args.orgId,
      args.survivorId,
      args.loserId,
      args.dryRun ?? false,
    ),
});

// Active entity/project pages an entity owns — for post-merge consolidation.
export const listEntityPagesForConsolidation = internalQuery({
  args: { orgId: v.id("orgs"), entityId: v.id("entities") },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_entity", (q) =>
        q.eq("orgId", args.orgId).eq("entityId", args.entityId),
      )
      .take(100);
    return pages
      .filter((p) => p.status === "active")
      .map((p) => ({ _id: p._id, type: p.type, sourceCount: p.sourceCount, createdAt: p.createdAt }));
  },
});

// After an entity merge the survivor can own >1 page of the same type (its own
// + the merged-in loser's). Merge duplicates of each type into one canonical
// page (most evidence, tie-break oldest) via mergeKnowledgePages. No-op when
// only one page per type. Scheduled from mergeEntitiesImpl; also runnable
// directly to clean an entity up.
export const consolidateEntityPagesForEntity = internalAction({
  args: { orgId: v.id("orgs"), entityId: v.id("entities") },
  handler: async (ctx, args): Promise<{ mergedPages: number }> => {
    const pages = await ctx.runQuery(
      internal.playground.listEntityPagesForConsolidation,
      { orgId: args.orgId, entityId: args.entityId },
    );
    const byType = new Map<string, typeof pages>();
    for (const p of pages) byType.set(p.type, [...(byType.get(p.type) ?? []), p]);
    let mergedPages = 0;
    for (const group of byType.values()) {
      if (group.length < 2) continue;
      const winner = [...group].sort(
        (a, b) => b.sourceCount - a.sourceCount || a.createdAt - b.createdAt,
      )[0];
      for (const loser of group) {
        if (loser._id === winner._id) continue;
        await ctx.runMutation(internal.knowledge.mergeKnowledgePages, {
          orgId: args.orgId,
          loserId: loser._id,
          winnerId: winner._id,
        });
        mergedPages += 1;
      }
    }
    return { mergedPages };
  },
});

export const setEntityKind = internalMutation({
  args: {
    orgId: v.id("orgs"),
    entityId: v.id("entities"),
    kind: entityKindArg,
  },
  handler: (ctx, args) =>
    setEntityKindImpl(ctx, args.orgId, args.entityId, args.kind),
});

export const renameEntity = internalMutation({
  args: {
    orgId: v.id("orgs"),
    entityId: v.id("entities"),
    displayName: v.string(),
  },
  handler: (ctx, args) =>
    renameEntityImpl(ctx, args.orgId, args.entityId, args.displayName),
});

// Public org-scoped (frontend identity tool) -------------------------------

export const mergeEntityInto = orgMutation({
  args: {
    survivorId: v.id("entities"),
    loserId: v.id("entities"),
    dryRun: v.optional(v.boolean()),
  },
  handler: (ctx, args): Promise<MergeEntitiesResult> =>
    mergeEntitiesImpl(
      ctx,
      ctx.orgId,
      args.survivorId,
      args.loserId,
      args.dryRun ?? false,
    ),
});

export const updateEntityKind = orgMutation({
  args: {
    entityId: v.id("entities"),
    kind: entityKindArg,
  },
  handler: (ctx, args) =>
    setEntityKindImpl(ctx, ctx.orgId, args.entityId, args.kind),
});

export const updateEntityName = orgMutation({
  args: {
    entityId: v.id("entities"),
    displayName: v.string(),
  },
  handler: (ctx, args) =>
    renameEntityImpl(ctx, ctx.orgId, args.entityId, args.displayName),
});

// --- Entity dedup backfill (deterministic, email-keyed) --------------------
// Cleans the existing "multiple entities for one person" mess that formed before
// emails were normalized: (1) lowercases stored emails so the by_org_email joins
// are case-insensitive going forward, then (2) merges person entities that share
// a normalized email (transitively, via union-find) using the existing
// mergeEntities primitive. Email is a strong identity key, so this is safe to
// run unattended. The non-deterministic tail (same name / same photo, no shared
// email) is intentionally left to the human merge UI
// (spark:suggestEntityDuplicates -> mergeEntityInto). Caveat: a genuinely shared
// inbox address on multiple person aliases would fuse them — rare, and such
// accounts are usually kind:"shared" (excluded here, person-only). Run per org:
//   npx convex run playground:mergeDuplicateEntitiesForOrg '{"orgId":"..."}'

const EMAIL_NORMALIZE_BATCH = 200;

export const normalizeStoredEmailsBatch = internalMutation({
  args: {
    orgId: v.id("orgs"),
    table: v.union(
      v.literal("identityCache"),
      v.literal("teamMembers"),
      v.literal("entities"),
    ),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; changed: number; isDone: boolean; continueCursor: string }> => {
    let changed = 0;
    if (args.table === "entities") {
      const page = await ctx.db
        .query("entities")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .paginate({ cursor: args.cursor, numItems: args.numItems });
      for (const e of page.page) {
        const next = Array.from(
          new Set(e.emails.map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0)),
        );
        if (next.length !== e.emails.length || next.some((x, i) => x !== e.emails[i])) {
          await ctx.db.patch(e._id, { emails: next });
          changed += 1;
        }
      }
      return { scanned: page.page.length, changed, isDone: page.isDone, continueCursor: page.continueCursor };
    }
    const page =
      args.table === "identityCache"
        ? await ctx.db
            .query("identityCache")
            .withIndex("by_org_source_gid", (q) => q.eq("orgId", args.orgId))
            .paginate({ cursor: args.cursor, numItems: args.numItems })
        : await ctx.db
            .query("teamMembers")
            .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
            .paginate({ cursor: args.cursor, numItems: args.numItems });
    for (const row of page.page) {
      const lowered = row.email?.trim().toLowerCase();
      if (lowered && lowered !== row.email) {
        await ctx.db.patch(row._id, { email: lowered });
        changed += 1;
      }
    }
    return { scanned: page.page.length, changed, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const personEntitiesForDedup = internalQuery({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ _id: Id<"entities">; emails: string[]; teamMemberLinked: boolean; createdAt: number }>> => {
    const people = (
      await ctx.db
        .query("entities")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(2000)
    ).filter((e) => e.kind === "person");
    return people.map((e) => ({
      _id: e._id,
      emails: Array.from(
        new Set(e.emails.map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0)),
      ),
      teamMemberLinked: Boolean(e.teamMemberId),
      createdAt: e.createdAt,
    }));
  },
});

export const mergeDuplicateEntitiesForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<{ emailsNormalized: number; duplicateGroups: number; merged: number }> => {
    // 1. Lowercase stored emails (identityCache + teamMembers + entities) so
    //    grouping here and future by_org_email joins are case-insensitive.
    let emailsNormalized = 0;
    for (const table of ["identityCache", "teamMembers", "entities"] as const) {
      let cursor: string | null = null;
      for (;;) {
        const r: { scanned: number; changed: number; isDone: boolean; continueCursor: string } =
          await ctx.runMutation(internal.playground.normalizeStoredEmailsBatch, {
            orgId: args.orgId,
            table,
            cursor,
            numItems: EMAIL_NORMALIZE_BATCH,
          });
        emailsNormalized += r.changed;
        if (r.isDone) break;
        cursor = r.continueCursor;
      }
    }

    // 2. Union person entities linked by a shared normalized email, then merge
    //    each component into one survivor (team-member-linked, else oldest).
    const people = await ctx.runQuery(internal.playground.personEntitiesForDedup, {
      orgId: args.orgId,
    });
    const parent = new Map<string, string>();
    for (const e of people) parent.set(e._id, e._id);
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      while (parent.get(x) !== root) {
        const next = parent.get(x)!;
        parent.set(x, root);
        x = next;
      }
      return root;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));

    const byEmail = new Map<string, string[]>();
    for (const e of people) {
      for (const email of e.emails) byEmail.set(email, [...(byEmail.get(email) ?? []), e._id]);
    }
    for (const [, ids] of byEmail) {
      for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
    }

    const byId = new Map<string, (typeof people)[number]>(
      people.map((e) => [e._id, e]),
    );
    const components = new Map<string, string[]>();
    for (const e of people) {
      const root = find(e._id);
      components.set(root, [...(components.get(root) ?? []), e._id]);
    }

    let duplicateGroups = 0;
    let merged = 0;
    for (const [, memberIds] of components) {
      if (memberIds.length < 2) continue;
      duplicateGroups += 1;
      const members = memberIds.map((id) => byId.get(id)!);
      const survivor = [...members].sort(
        (a, b) =>
          Number(b.teamMemberLinked) - Number(a.teamMemberLinked) || a.createdAt - b.createdAt,
      )[0];
      for (const loser of members) {
        if (loser._id === survivor._id) continue;
        // mergeEntities truncates at the write budget without deleting the loser;
        // re-run until the loser is fully drained and deleted.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const res = await ctx.runMutation(internal.playground.mergeEntities, {
            orgId: args.orgId,
            survivorId: survivor._id,
            loserId: loser._id,
          });
          if (res.deletedLoser) break;
        }
        merged += 1;
      }
    }
    return { emailsNormalized, duplicateGroups, merged };
  },
});

// TEMP debug helper — inspect why two entity pages didn't auto-merge (emails +
// aliases). Remove after diagnosis; not committed.
export const debugEntityMergeEligibility = internalQuery({
  args: { orgId: v.id("orgs"), slugs: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: unknown[] = [];
    for (const slug of args.slugs) {
      const page = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) => q.eq("orgId", args.orgId).eq("slug", slug))
        .first();
      if (!page) {
        out.push({ slug, found: false });
        continue;
      }
      const entityId = page.entityId ?? page.actorEntityId ?? null;
      const entity = entityId ? await ctx.db.get(entityId) : null;
      const aliases = entityId
        ? await ctx.db
            .query("identityCache")
            .withIndex("by_entity", (q) => q.eq("entityId", entityId))
            .collect()
        : [];
      out.push({
        slug,
        pageTitle: page.title,
        pageType: page.type,
        entityId,
        entity: entity
          ? {
              displayName: entity.displayName,
              kind: entity.kind,
              emails: entity.emails,
              teamMemberId: entity.teamMemberId ?? null,
              hasPhoto: Boolean(entity.photoUrl),
            }
          : null,
        aliases: aliases.map((a) => ({
          source: a.source,
          gid: a.gid,
          name: a.name ?? null,
          email: a.email ?? null,
        })),
      });
    }
    return out;
  },
});

// TEMP debug helper — list non-person entities (system/shared/bot) with their
// emails + aliases so real people mis-typed as system can be spotted. Remove after.
export const debugNonPersonEntities = internalQuery({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    const ents = (
      await ctx.db
        .query("entities")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .take(2000)
    ).filter((e) => e.kind === "system" || e.kind === "shared" || e.kind === "bot");
    const out: unknown[] = [];
    for (const e of ents) {
      const aliases = await ctx.db
        .query("identityCache")
        .withIndex("by_entity", (q) => q.eq("entityId", e._id))
        .collect();
      out.push({
        entityId: e._id,
        displayName: e.displayName,
        kind: e.kind,
        emails: e.emails,
        teamMemberId: e.teamMemberId ?? null,
        aliases: aliases.map((a) => `${a.source}:${a.name ?? a.gid}${a.email ? ` <${a.email}>` : ""}`),
      });
    }
    return out;
  },
});

export const clearIdentityCache = internalMutation({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("identityCache")
      .withIndex("by_org_source_gid", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length };
  },
});

// ---------------------------------------------------------------------------
// Prose-gid re-title pipeline: clean knowledge pages whose title/compiledTruth
// embed raw Asana gids or Composio internal ids. Resolved gids become readable
// names; unresolved raw ids are rephrased generically.
// ---------------------------------------------------------------------------

// Matches Composio trigger/connected-account internal ids (ti_.../ca_...).
const COMPOSIO_ID_REGEX = /\b(?:ti|ca)_[A-Za-z0-9]+\b/;
const RAW_ASANA_GID_REGEX = /\b\d{10,}\b/g;
const LEAK_REWRITE_PAGE_TYPES = ["fact", "decision", "pattern"] as const;

type KnowledgePageDoc = Doc<"knowledgePages">;
type ProseGidKind = "person" | "project" | "task" | "section";
export type ProseGidResource = {
  gid: string;
  kind: string;
  name: string;
};

export type LeakedPage = {
  _id: Id<"knowledgePages">;
  type: string;
  title: string;
  compiledTruth: string;
  evidenceTimeline: KnowledgePageDoc["evidenceTimeline"];
  rawGids: string[];
};

export function isLeakRewritePageType(type: KnowledgePageDoc["type"]): boolean {
  return LEAK_REWRITE_PAGE_TYPES.some((candidate) => candidate === type);
}

function extractRawGidsFromText(text: string): string[] {
  return Array.from(text.matchAll(RAW_ASANA_GID_REGEX), (match) => match[0]);
}

export function getRawGidsForPage(page: {
  title: string;
  compiledTruth: string;
}): string[] {
  return dedupeStrings([
    ...extractRawGidsFromText(page.title),
    ...extractRawGidsFromText(page.compiledTruth),
  ]);
}

export function hasComposioInternalId(page: {
  title: string;
  compiledTruth: string;
}): boolean {
  return (
    COMPOSIO_ID_REGEX.test(page.title) ||
    COMPOSIO_ID_REGEX.test(page.compiledTruth)
  );
}

export const listLeakedPages = internalQuery({
  args: {
    orgId: v.id("orgs"),
    personGids: v.array(v.object({ gid: v.string(), name: v.string() })),
    limit: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ pages: LeakedPage[]; total: number }> => {
    const gidSet = new Set(args.personGids.map((person) => person.gid));

    const pages: LeakedPage[] = [];
    let total = 0;
    for (const type of LEAK_REWRITE_PAGE_TYPES) {
      const docs = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_type_status_updatedAt", (q) =>
          q.eq("orgId", args.orgId).eq("type", type).eq("status", "active"),
        )
        .collect();
      for (const page of docs) {
        const rawGids = getRawGidsForPage(page).filter((gid) =>
          gidSet.has(gid),
        );
        if (rawGids.length === 0 && !hasComposioInternalId(page)) {
          continue;
        }
        total += 1;
        if (pages.length < args.limit) {
          pages.push({
            _id: page._id,
            type: page.type,
            title: page.title,
            compiledTruth: page.compiledTruth,
            evidenceTimeline: page.evidenceTimeline,
            rawGids,
          });
        }
      }
    }
    return { pages, total };
  },
});

export const applyPageRewrite = internalMutation({
  args: {
    pageId: v.id("knowledgePages"),
    title: v.string(),
    compiledTruth: v.string(),
    evidenceTimeline: v.optional(
      v.array(
        v.object({
          source: v.string(),
          channel: v.string(),
          timestamp: v.number(),
          content: v.string(),
        }),
      ),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    const patch: {
      title: string;
      compiledTruth: string;
      updatedAt: number;
      evidenceTimeline?: KnowledgePageDoc["evidenceTimeline"];
    } = {
      title: args.title,
      compiledTruth: args.compiledTruth,
      updatedAt: Date.now(),
    };
    if (args.evidenceTimeline !== undefined) {
      patch.evidenceTimeline = args.evidenceTimeline;
    }
    await ctx.db.patch(args.pageId, patch);
  },
});

function formatResolvedGidLabel(resource: ProseGidResource): string {
  const name = resource.name.trim();
  if (resource.kind === "person") {
    return name;
  }
  if (resource.kind === "task") {
    return !name || name === "Untitled task"
      ? "an untitled Asana task"
      : `the task "${name}"`;
  }
  if (resource.kind === "section") {
    return `the "${name}" section`;
  }
  if (resource.kind === "project") {
    return `the "${name}" project`;
  }
  return `the Asana resource "${name}"`;
}

function formatResolvedGidSubstitution(resource: ProseGidResource): string {
  return `- ${resource.gid} = ${formatResolvedGidLabel(resource)}`;
}

export async function rewriteLeakedPagesWithResources(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    pages: LeakedPage[];
    resources: ProseGidResource[];
    unknownGids: string[];
    logName: string;
  },
): Promise<number> {
  const instructions = [
    "You clean up text that accidentally contains raw machine identifiers.",
    "Replace raw Asana gids with human-readable names or generic descriptions while preserving all unrelated wording, dates, numbers, timestamps, structure, and the trailing [Source: ...] tag verbatim.",
    "",
    "Rules:",
    "- Replace EVERY occurrence of each listed gid, including any inside backticks or after labels like \"user\", \"assignee\", \"task\", \"section\", \"project\", \"GID\", or \"gid:\", with the listed substitution. Never also print the raw gid.",
    "- Person, project, task, and section substitutions should read as natural prose in context.",
    "- For any unresolved bare long numeric id, remove the raw number and describe the resource generically from context, such as \"a section\", \"a task\", \"a project\", or \"the assignee\". Do not print the raw id.",
    '- For a task mapped to "an untitled Asana task", never print the literal words "Untitled task"; write "an untitled Asana task" or "the task" as a back-reference.',
    "- Remove Composio ids matching ti_... or ca_...; rephrase to refer generically to \"a Composio webhook trigger\" or \"the connected account\" so sentences stay grammatical.",
    "- Do NOT change any other number, date, time, person name, or the [Source: ...] tag.",
    '- Return STRICT JSON: { "title": string, "compiledTruth": string }. No other keys, no markdown fence.',
  ].join("\n");

  let processed = 0;
  for (const page of args.pages) {
    const userContent = [
      "Resolved gid substitutions to apply:",
      ...(args.resources.length > 0
        ? args.resources.map(formatResolvedGidSubstitution)
        : ["- (none)"]),
      "",
      "Unresolved bare long numeric ids to remove and describe generically:",
      ...(args.unknownGids.length > 0
        ? args.unknownGids.map((gid) => `- ${gid}`)
        : ["- (none)"]),
      "",
      "Rewrite the following page and return both the rewritten title and compiledTruth.",
      `Title: ${page.title}`,
      "",
      "compiledTruth:",
      page.compiledTruth,
    ].join("\n");

    let responseText: string;
    try {
      responseText = await withRetriableCall(
        classifyAnthropicRetry,
        async () => {
          const result = await anthropicClient.messages.create({
            model: SONNET_MODEL,
            max_tokens: 1400,
            temperature: 0,
            system: [
              {
                type: "text" as const,
                text: instructions,
                cache_control: { type: "ephemeral" as const },
              },
            ],
            messages: [
              {
                role: "user" as const,
                content: userContent,
              },
            ],
          });
          return result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
            .trim();
        },
      );
    } catch (error) {
      console.warn(`knowledge:${args.logName}CallFailed`, {
        pageId: page._id,
        error: getErrorMessage(error),
      });
      continue;
    }

    let newTitle: string | null;
    let newCompiledTruth: string | null;
    try {
      const parsed = getRecord(JSON.parse(stripJsonFence(responseText)));
      newTitle = parsed ? getString(parsed.title)?.trim() ?? null : null;
      newCompiledTruth = parsed
        ? getString(parsed.compiledTruth)?.trim() ?? null
        : null;
    } catch (error) {
      console.warn(`knowledge:${args.logName}ParseFailed`, {
        pageId: page._id,
        error: getErrorMessage(error),
      });
      continue;
    }
    if (!newTitle || !newCompiledTruth) {
      console.warn(`knowledge:${args.logName}InvalidPayload`, {
        pageId: page._id,
      });
      continue;
    }

    const cleanedTimeline = page.evidenceTimeline.map((entry) => {
      let content = entry.content;
      for (const resource of args.resources) {
        content = content
          .split(resource.gid)
          .join(formatResolvedGidLabel(resource));
      }
      for (const gid of args.unknownGids) {
        content = content.split(gid).join("an Asana resource");
      }
      content = content.replace(COMPOSIO_ID_REGEX, "a Composio identifier");
      return { ...entry, content };
    });

    await ctx.runMutation(internal.playground.applyPageRewrite, {
      pageId: page._id,
      title: newTitle,
      compiledTruth: newCompiledTruth,
      evidenceTimeline: cleanedTimeline,
    });
    processed += 1;
  }

  return processed;
}

export const retitleLeakedPages = internalAction({
  args: {
    orgId: v.id("orgs"),
    // explicit person gid -> name map, e.g. [{ gid: "400000000000007", name: "Maya Chen" }]
    personGids: v.array(v.object({ gid: v.string(), name: v.string() })),
    limit: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ processed: number; remaining: number }> => {
    const personGids = args.personGids;

    const { pages, total } = await ctx.runQuery(
      internal.playground.listLeakedPages,
      { orgId: args.orgId, personGids, limit: args.limit },
    );

    const processed = await rewriteLeakedPagesWithResources(ctx, {
      pages,
      resources: personGids.map((person) => ({
        gid: person.gid,
        kind: "person",
        name: person.name,
      })),
      unknownGids: [],
      logName: "retitleLeakedPages",
    });

    return { processed, remaining: total };
  },
});

export const retitleResourcePages = internalAction({
  args: {
    orgId: v.id("orgs"),
    resources: v.array(
      v.object({ gid: v.string(), kind: v.string(), name: v.string() }),
    ),
    unknownGids: v.array(v.string()),
    limit: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ processed: number; remaining: number }> => {
    const personGids = [
      ...args.resources.map((r) => ({ gid: r.gid, name: r.name })),
      ...args.unknownGids.map((g) => ({ gid: g, name: "" })),
    ];

    const { pages, total } = await ctx.runQuery(
      internal.playground.listLeakedPages,
      { orgId: args.orgId, personGids, limit: args.limit },
    );

    const processed = await rewriteLeakedPagesWithResources(ctx, {
      pages,
      resources: args.resources,
      unknownGids: args.unknownGids,
      logName: "retitleResourcePages",
    });

    return { processed, remaining: total };
  },
});

const PROSE_BACKFILL_DEFAULT_LIMIT = 25;
const PROSE_BACKFILL_MAX_LIMIT = 100;

type CachedIdentityForBackfill = {
  source: string;
  gid: string;
  name?: string;
  photoUrl?: string;
  email?: string;
  entityId?: Id<"entities">;
  fetchedAt: number;
};

export const listLeakedPagesForProseBackfill = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    pages: LeakedPage[];
    gids: string[];
    nextCursor: string;
    isDone: boolean;
  }> => {
    const page = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "active"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });

    const pages: LeakedPage[] = [];
    const gids = new Set<string>();
    for (const knowledgePage of page.page) {
      if (!isLeakRewritePageType(knowledgePage.type)) {
        continue;
      }
      const rawGids = getRawGidsForPage(knowledgePage);
      if (rawGids.length === 0 && !hasComposioInternalId(knowledgePage)) {
        continue;
      }
      for (const gid of rawGids) {
        gids.add(gid);
      }
      pages.push({
        _id: knowledgePage._id,
        type: knowledgePage.type,
        title: knowledgePage.title,
        compiledTruth: knowledgePage.compiledTruth,
        evidenceTimeline: knowledgePage.evidenceTimeline,
        rawGids,
      });
    }

    return {
      pages,
      gids: Array.from(gids),
      nextCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

function normalizeResolvedName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function isRawIdentifierLikeName(value: string): boolean {
  return /^(asana|slack|github):/i.test(value) || /^\d{10,}$/.test(value);
}

function extractComposioNameByPaths(
  result: unknown,
  paths: string[][],
): string | null {
  const outer = getRecord(result);
  if (outer && outer.successful === false) {
    return null;
  }
  const bases = [
    getRecord(outer?.data),
    getRecord(getRecord(outer?.data)?.data),
  ].filter((base): base is Record<string, unknown> => base !== null);
  for (const base of bases) {
    for (const path of paths) {
      let cursor: unknown = base;
      for (const key of path) {
        cursor = getRecord(cursor)?.[key];
      }
      const value = normalizeResolvedName(getString(cursor));
      if (value) {
        return value;
      }
    }
  }
  return null;
}

async function fetchComposioResourceForRepair(
  orgId: Id<"orgs">,
  fetcher: ComposioFetcher,
  gid: string,
  extraArguments: Record<string, unknown> = {},
): Promise<unknown | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    console.warn("playground:asanaRepairFetchFailed", {
      orgId,
      slug: fetcher.slug,
      gid,
      error: "CONFIG: COMPOSIO_API_KEY is not configured",
    });
    return null;
  }

  try {
    const resp = await fetch(
      `${COMPOSIO_BACKEND_BASE_URL}/api/v3/tools/execute/${fetcher.slug}`,
      {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: String(orgId),
          arguments: {
            [fetcher.argKey]: gid,
            ...extraArguments,
          },
          ...(fetcher.version ? { version: fetcher.version } : {}),
        }),
      },
    );
    if (!resp.ok) {
      console.warn("playground:asanaRepairFetchFailed", {
        orgId,
        slug: fetcher.slug,
        gid,
        error: `REST execute returned ${resp.status}`,
      });
      return null;
    }
    return await resp.json();
  } catch (error) {
    console.warn("playground:asanaRepairFetchFailed", {
      orgId,
      slug: fetcher.slug,
      gid,
      error: getErrorMessage(error),
    });
    return null;
  }
}

async function fetchComposioResourceNameForBackfill(
  orgId: Id<"orgs">,
  fetcher: ComposioFetcher,
  gid: string,
): Promise<string | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    console.warn("knowledge:proseGidResolveFailed", {
      orgId,
      slug: fetcher.slug,
      gid,
      error: "CONFIG: COMPOSIO_API_KEY is not configured",
    });
    return null;
  }

  let result: unknown;
  try {
    const resp = await fetch(
      `${COMPOSIO_BACKEND_BASE_URL}/api/v3/tools/execute/${fetcher.slug}`,
      {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: String(orgId),
          arguments: { [fetcher.argKey]: gid },
          ...(fetcher.version ? { version: fetcher.version } : {}),
        }),
      },
    );
    if (!resp.ok) {
      console.warn("knowledge:proseGidResolveFailed", {
        orgId,
        slug: fetcher.slug,
        gid,
        error: `REST execute returned ${resp.status}`,
      });
      return null;
    }
    result = await resp.json();
  } catch (error) {
    console.warn("knowledge:proseGidResolveFailed", {
      orgId,
      slug: fetcher.slug,
      gid,
      error: getErrorMessage(error),
    });
    return null;
  }

  return extractComposioNameByPaths(result, fetcher.namePaths);
}

const ASANA_REPAIR_DEFAULT_LIMIT = 100;
const ASANA_REPAIR_MAX_LIMIT = 250;
const ASANA_REPAIR_DEFAULT_MAX_PAGES = 1;

const ASANA_REPAIR_TASK_DETAIL_OPT_FIELDS = [
  "name",
  "created_by.gid",
  "created_by.name",
  "completed_by.gid",
  "completed_by.name",
  "assignee.gid",
  "assignee.name",
] as const;

const ASANA_REPAIR_CREATED_BY_GID_PATHS = [
  ["created_by", "gid"],
  ["created_by", "id"],
  ["data", "created_by", "gid"],
  ["data", "created_by", "id"],
];

const ASANA_REPAIR_CREATED_BY_NAME_PATHS = [
  ["created_by", "name"],
  ["data", "created_by", "name"],
];

const ASANA_REPAIR_COMPLETED_BY_GID_PATHS = [
  ["completed_by", "gid"],
  ["completed_by", "id"],
  ["data", "completed_by", "gid"],
  ["data", "completed_by", "id"],
];

const ASANA_REPAIR_COMPLETED_BY_NAME_PATHS = [
  ["completed_by", "name"],
  ["data", "completed_by", "name"],
];

type AsanaRepairPerson = {
  gid: string | null;
  name: string | null;
};

type AsanaRepairTaskDetails = {
  taskName: string | null;
  createdBy: AsanaRepairPerson | null;
  completedBy: AsanaRepairPerson | null;
};

type AsanaEventRepair = {
  eventId: Id<"events">;
  actor: string;
  summary: string;
  actorRef?: EntityRef;
  raw: unknown;
  clearActorIdentity: boolean;
  actorAliasName?: string;
  reason: string;
  before: {
    actor: string;
    summary: string;
    actorRef: EntityRef | null;
  };
  after: {
    actor: string;
    summary: string;
    actorRef: EntityRef | null;
  };
};

type AsanaRepairForOrgResult = {
  dryRun: boolean;
  scanned: number;
  changed: number;
  patched: number;
  pages: number;
  isDone: boolean;
  nextCursor: string | null;
  samples: Array<{
    eventId: Id<"events">;
    reason: string;
    before: AsanaEventRepair["before"];
    after: AsanaEventRepair["after"];
  }>;
};

function recordValue(
  record: Record<string, unknown> | null | undefined,
  key: string,
): unknown {
  return record ? record[key] : undefined;
}

function recordString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  return getString(recordValue(record, key));
}

function asanaRepairPersonFromValue(value: unknown): AsanaRepairPerson | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }
  const gid = recordString(record, "gid") ?? recordString(record, "id");
  const name = recordString(record, "name");
  return gid || name ? { gid, name } : null;
}

function asanaRepairPersonFromPaths(
  result: unknown,
  gidPaths: string[][],
  namePaths: string[][],
): AsanaRepairPerson | null {
  const gid = extractComposioNameByPaths(result, gidPaths);
  const name = extractComposioNameByPaths(result, namePaths);
  return gid || name ? { gid, name } : null;
}

function extractAsanaRepairTaskDetails(
  result: unknown,
): AsanaRepairTaskDetails {
  return {
    taskName: extractComposioNameByPaths(
      result,
      ASANA_RESOURCE_FETCHERS.task.namePaths,
    ),
    createdBy: asanaRepairPersonFromPaths(
      result,
      ASANA_REPAIR_CREATED_BY_GID_PATHS,
      ASANA_REPAIR_CREATED_BY_NAME_PATHS,
    ),
    completedBy: asanaRepairPersonFromPaths(
      result,
      ASANA_REPAIR_COMPLETED_BY_GID_PATHS,
      ASANA_REPAIR_COMPLETED_BY_NAME_PATHS,
    ),
  };
}

async function fetchAsanaRepairTaskDetails(
  orgId: Id<"orgs">,
  taskGid: string,
): Promise<AsanaRepairTaskDetails> {
  const fetcher = ASANA_RESOURCE_FETCHERS.task;
  const result = await fetchComposioResourceForRepair(orgId, fetcher, taskGid, {
    opt_fields: ASANA_REPAIR_TASK_DETAIL_OPT_FIELDS,
  });
  if (result) {
    return extractAsanaRepairTaskDetails(result);
  }
  return { taskName: null, createdBy: null, completedBy: null };
}

function rawAsanaRepairRecords(event: Doc<"events">): {
  raw: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  sparkResolved: Record<string, unknown> | null;
  resolvedAsana: Record<string, unknown> | null;
} {
  const raw = getRecord(event.raw);
  const data = getRecord(recordValue(raw, "data")) ?? raw;
  const metadata = getRecord(recordValue(raw, "metadata"));
  const sparkResolved = getRecord(recordValue(raw, "sparkResolved"));
  const resolvedAsana = getRecord(recordValue(sparkResolved, "asana"));
  return { raw, data, metadata, sparkResolved, resolvedAsana };
}

function asanaRepairTriggerSlug(
  event: Doc<"events">,
  metadata: Record<string, unknown> | null,
  resolvedAsana: Record<string, unknown> | null,
): string {
  const fromMetadata =
    recordString(metadata, "trigger_slug") ?? recordString(metadata, "triggerSlug");
  const fromResolved = recordString(resolvedAsana, "triggerSlug");
  if (fromMetadata || fromResolved) {
    return fromMetadata ?? fromResolved ?? event.type;
  }
  switch (event.type) {
    case "task_created":
      return "ASANA_TASK_CREATED";
    case "task_updated":
      return "ASANA_TASK_UPDATED";
    case "ticket_moved":
      return "ASANA_TASK_MOVED_TO_SECTION";
    case "task_completed":
      return "ASANA_TASK_COMPLETED";
    default:
      return event.type;
  }
}

function asanaRepairTaskGid(
  data: Record<string, unknown> | null,
  resolvedAsana: Record<string, unknown> | null,
): string | null {
  const resolvedTask = getRecord(recordValue(resolvedAsana, "task"));
  return (
    recordString(data, "task_gid") ??
    recordString(data, "taskGid") ??
    recordString(resolvedTask, "gid") ??
    null
  );
}

function asanaRepairProjectName(
  data: Record<string, unknown> | null,
  resolvedAsana: Record<string, unknown> | null,
): string | null {
  const resolvedProject = getRecord(recordValue(resolvedAsana, "project"));
  return (
    recordString(data, "project_name") ??
    recordString(data, "projectName") ??
    recordString(resolvedProject, "name") ??
    null
  );
}

function asanaRepairTaskName(
  data: Record<string, unknown> | null,
  resolvedAsana: Record<string, unknown> | null,
  fetched: AsanaRepairTaskDetails,
): string | null {
  const resolvedTask = getRecord(recordValue(resolvedAsana, "task"));
  return (
    fetched.taskName ??
    recordString(data, "name") ??
    recordString(data, "task_name") ??
    recordString(data, "taskName") ??
    recordString(resolvedTask, "name") ??
    null
  );
}

function asanaRepairRawCreator(
  data: Record<string, unknown> | null,
  resolvedAsana: Record<string, unknown> | null,
): AsanaRepairPerson | null {
  return (
    asanaRepairPersonFromValue(recordValue(data, "created_by")) ??
    asanaRepairPersonFromValue(recordValue(resolvedAsana, "taskCreator"))
  );
}

function asanaRepairRawCompleter(
  data: Record<string, unknown> | null,
  resolvedAsana: Record<string, unknown> | null,
): AsanaRepairPerson | null {
  return (
    asanaRepairPersonFromValue(recordValue(data, "completed_by")) ??
    asanaRepairPersonFromValue(recordValue(resolvedAsana, "taskCompleter"))
  );
}

function asanaRepairPersonActor(person: AsanaRepairPerson | null): {
  actor: string;
  actorRef?: EntityRef;
  aliasName?: string;
} {
  if (!person?.gid && !person?.name) {
    return { actor: "asana" };
  }
  const actor = person.name ?? `asana:${person.gid}`;
  return {
    actor,
    ...(person.gid ? { actorRef: { source: "asana", gid: person.gid } } : {}),
    ...(person.name ? { aliasName: person.name } : {}),
  };
}

function asanaRepairTaskPhrase(taskName: string | null): string {
  return taskName ? `"${taskName}"` : "a task";
}

function asanaRepairProjectSuffix(projectName: string | null): string {
  return projectName ? ` in ${projectName}` : "";
}

function asanaRepairCreatedSummary(
  taskName: string | null,
  projectName: string | null,
  creatorName: string | null,
): string {
  const task = asanaRepairTaskPhrase(taskName);
  const suffix = asanaRepairProjectSuffix(projectName);
  return creatorName
    ? `${creatorName} created ${task}${suffix}`
    : `${taskName ? `Task ${task}` : "A task"} was created${suffix}`;
}

function asanaRepairCompletedSummary(
  taskName: string | null,
  projectName: string | null,
  completerName: string | null,
): string {
  const task = asanaRepairTaskPhrase(taskName);
  const suffix = asanaRepairProjectSuffix(projectName);
  return completerName
    ? `${completerName} completed ${task}${suffix}`
    : `${taskName ? `Task ${task}` : "A task"} was completed${suffix}`;
}

function asanaRepairUpdatedSummary(
  data: Record<string, unknown> | null,
  taskName: string | null,
  projectName: string | null,
): string {
  const task = asanaRepairTaskPhrase(taskName);
  const suffix = asanaRepairProjectSuffix(projectName);
  const field = recordString(data, "change_field");
  return field
    ? `${field} changed on ${task}${suffix}`
    : `${taskName ? `Task ${task}` : "A task"} was updated${suffix}`;
}

function asanaRepairMovedSummary(
  taskName: string | null,
  projectName: string | null,
): string {
  const task = asanaRepairTaskPhrase(taskName);
  const suffix = asanaRepairProjectSuffix(projectName);
  return `${taskName ? `Task ${task}` : "A task"} moved to a section${suffix}`;
}

function actorRefsEqual(
  left: EntityRef | undefined,
  right: EntityRef | undefined,
): boolean {
  if (!left && !right) {
    return true;
  }
  return Boolean(
    left &&
      right &&
      left.source === right.source &&
      left.gid === right.gid,
  );
}

function mergeAsanaRepairRaw(
  event: Doc<"events">,
  patch: {
    triggerSlug: string;
    actorSource: string;
    taskGid: string | null;
    taskName: string | null;
    actorPerson: AsanaRepairPerson | null;
    previousActor: string;
    previousSummary: string;
    neutralizeUnverifiedTaskChanges: boolean;
  },
): unknown {
  const raw = getRecord(event.raw);
  if (!raw) {
    return event.raw;
  }
  const existingSparkResolved = getRecord(recordValue(raw, "sparkResolved"));
  const existingAsana = getRecord(recordValue(existingSparkResolved, "asana"));
  const existingTask = existingAsana
    ? recordValue(existingAsana, "task")
    : null;
  return {
    ...raw,
    sparkResolved: {
      ...existingSparkResolved,
      asana: {
        ...existingAsana,
        triggerSlug: patch.triggerSlug,
        actorSource: patch.actorSource,
        repair: {
          repairedAt: Date.now(),
          previousActor: patch.previousActor,
          previousSummary: patch.previousSummary,
          neutralizeUnverifiedTaskChanges:
            patch.neutralizeUnverifiedTaskChanges,
        },
        task: patch.taskGid
          ? { gid: patch.taskGid, name: patch.taskName }
          : existingTask ?? null,
        repairedActor: patch.actorPerson
          ? { gid: patch.actorPerson.gid, name: patch.actorPerson.name }
          : null,
      },
    },
  };
}

async function buildAsanaEventRepair(
  orgId: Id<"orgs">,
  event: Doc<"events">,
  options: {
    neutralizeUnverifiedTaskChanges: boolean;
    fetchMissingTaskDetails: boolean;
  },
): Promise<AsanaEventRepair | null> {
  if (event.source !== "asana") {
    return null;
  }
  const { data, metadata, resolvedAsana } = rawAsanaRepairRecords(event);
  const triggerSlug = asanaRepairTriggerSlug(event, metadata, resolvedAsana);
  const taskGid = asanaRepairTaskGid(data, resolvedAsana);
  const needsTaskFetch =
    options.fetchMissingTaskDetails &&
    Boolean(taskGid) &&
    (triggerSlug === "ASANA_TASK_CREATED" ||
      triggerSlug === "ASANA_TASK_COMPLETED" ||
      !asanaRepairTaskName(data, resolvedAsana, {
        taskName: null,
        createdBy: null,
        completedBy: null,
      }));
  const fetched =
    needsTaskFetch && taskGid
      ? await fetchAsanaRepairTaskDetails(orgId, taskGid)
      : { taskName: null, createdBy: null, completedBy: null };
  const taskName = asanaRepairTaskName(data, resolvedAsana, fetched);
  const projectName = asanaRepairProjectName(data, resolvedAsana);

  let actor = event.actor;
  let actorRef = event.actorRef;
  let actorAliasName: string | undefined;
  let actorPerson: AsanaRepairPerson | null = null;
  let summary = event.summary;
  let actorSource = "unchanged";
  let reason = "";

  if (triggerSlug === "ASANA_TASK_CREATED") {
    actorPerson = fetched.createdBy ?? asanaRepairRawCreator(data, resolvedAsana);
    const resolved = asanaRepairPersonActor(actorPerson);
    actor = resolved.actor;
    actorRef = resolved.actorRef;
    actorAliasName = resolved.aliasName;
    actorSource = actorPerson ? "task_created_by" : "neutral_missing_task_created_by";
    summary = asanaRepairCreatedSummary(
      taskName,
      projectName,
      actorPerson?.name ?? null,
    );
    reason = "asana_created_requires_explicit_task_created_by";
  } else if (triggerSlug === "ASANA_TASK_COMPLETED") {
    actorPerson =
      fetched.completedBy ?? asanaRepairRawCompleter(data, resolvedAsana);
    const resolved = asanaRepairPersonActor(actorPerson);
    actor = resolved.actor;
    actorRef = resolved.actorRef;
    actorAliasName = resolved.aliasName;
    actorSource = actorPerson
      ? "task_completed_by"
      : "neutral_missing_task_completed_by";
    summary = asanaRepairCompletedSummary(
      taskName,
      projectName,
      actorPerson?.name ?? null,
    );
    reason = "asana_completed_requires_explicit_task_completed_by";
  } else if (
    options.neutralizeUnverifiedTaskChanges &&
    triggerSlug === "ASANA_TASK_UPDATED"
  ) {
    actor = "asana";
    actorRef = undefined;
    actorPerson = null;
    actorAliasName = undefined;
    actorSource = "neutral_unverified_trigger_user";
    summary = asanaRepairUpdatedSummary(data, taskName, projectName);
    reason = "asana_update_trigger_user_not_verified_actor";
  } else if (
    options.neutralizeUnverifiedTaskChanges &&
    triggerSlug === "ASANA_TASK_MOVED_TO_SECTION"
  ) {
    actor = "asana";
    actorRef = undefined;
    actorPerson = null;
    actorAliasName = undefined;
    actorSource = "neutral_unverified_trigger_user";
    summary = asanaRepairMovedSummary(taskName, projectName);
    reason = "asana_move_trigger_user_not_verified_actor";
  } else {
    return null;
  }

  const raw = mergeAsanaRepairRaw(event, {
    triggerSlug,
    actorSource,
    taskGid,
    taskName,
    actorPerson,
    previousActor: event.actor,
    previousSummary: event.summary,
    neutralizeUnverifiedTaskChanges: options.neutralizeUnverifiedTaskChanges,
  });
  const actorChanged =
    event.actor !== actor || !actorRefsEqual(event.actorRef, actorRef);
  const summaryChanged = event.summary !== summary;
  const alreadyRepaired = Boolean(
    getRecord(recordValue(resolvedAsana, "repair")),
  );
  if (!actorChanged && !summaryChanged && alreadyRepaired) {
    return null;
  }

  return {
    eventId: event._id,
    actor,
    summary,
    ...(actorRef ? { actorRef } : {}),
    raw,
    clearActorIdentity: actorChanged,
    ...(actorAliasName ? { actorAliasName } : {}),
    reason,
    before: {
      actor: event.actor,
      summary: event.summary,
      actorRef: event.actorRef ?? null,
    },
    after: {
      actor,
      summary,
      actorRef: actorRef ?? null,
    },
  };
}

export const pageAsanaEventsForRepair = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    events: Doc<"events">[];
    isDone: boolean;
    continueCursor: string;
  }> => {
    const result = await ctx.db
      .query("events")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", args.orgId).eq("source", "asana"),
      )
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    return {
      events: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const applyAsanaEventRepairs = internalMutation({
  args: {
    orgId: v.id("orgs"),
    repairs: v.array(
      v.object({
        eventId: v.id("events"),
        actor: v.string(),
        summary: v.string(),
        actorRef: v.optional(v.object({ source: v.string(), gid: v.string() })),
        raw: v.any(),
        clearActorIdentity: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ patched: number }> => {
    let patched = 0;
    for (const repair of args.repairs) {
      const event = await ctx.db.get(repair.eventId);
      if (!event || event.orgId !== args.orgId || event.source !== "asana") {
        continue;
      }
      await ctx.db.patch(repair.eventId, {
        actor: repair.actor,
        summary: repair.summary,
        actorRef: repair.actorRef,
        raw: repair.raw,
        processed: false,
        claimedAt: undefined,
        ...(repair.clearActorIdentity
          ? {
              actorEntityId: undefined,
              actorIdentityResolvedAt: undefined,
            }
          : {}),
      });
      patched += 1;
    }
    return { patched };
  },
});

export const repairAsanaEventsForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    maxPages: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    neutralizeUnverifiedTaskChanges: v.optional(v.boolean()),
    fetchMissingTaskDetails: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<AsanaRepairForOrgResult> => {
    const dryRun = args.dryRun ?? true;
    const requestedLimit = Math.trunc(args.limit ?? ASANA_REPAIR_DEFAULT_LIMIT);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, ASANA_REPAIR_MAX_LIMIT))
      : ASANA_REPAIR_DEFAULT_LIMIT;
    const requestedMaxPages = Math.trunc(
      args.maxPages ?? ASANA_REPAIR_DEFAULT_MAX_PAGES,
    );
    const maxPages = Number.isFinite(requestedMaxPages)
      ? Math.max(1, Math.min(requestedMaxPages, 5000))
      : ASANA_REPAIR_DEFAULT_MAX_PAGES;
    const neutralizeUnverifiedTaskChanges =
      args.neutralizeUnverifiedTaskChanges ?? true;
    const fetchMissingTaskDetails = args.fetchMissingTaskDetails ?? false;

    let cursor = args.cursor ?? null;
    let scanned = 0;
    let changed = 0;
    let patched = 0;
    let isDone = false;
    const samples: Array<{
      eventId: Id<"events">;
      reason: string;
      before: AsanaEventRepair["before"];
      after: AsanaEventRepair["after"];
    }> = [];

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page: {
        events: Doc<"events">[];
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.playground.pageAsanaEventsForRepair, {
        orgId: args.orgId,
        cursor,
        numItems: limit,
      });

      scanned += page.events.length;
      const repairs: AsanaEventRepair[] = [];
      for (const event of page.events) {
        const repair = await buildAsanaEventRepair(args.orgId, event, {
          neutralizeUnverifiedTaskChanges,
          fetchMissingTaskDetails,
        });
        if (!repair) {
          continue;
        }
        repairs.push(repair);
        changed += 1;
        if (samples.length < 20) {
          samples.push({
            eventId: repair.eventId,
            reason: repair.reason,
            before: repair.before,
            after: repair.after,
          });
        }
      }

      if (!dryRun && repairs.length > 0) {
        for (const repair of repairs) {
          if (repair.actorRef && repair.actorAliasName) {
            await ctx.runMutation(internal.spark.linkEntityAlias, {
              orgId: args.orgId,
              source: repair.actorRef.source,
              gid: repair.actorRef.gid,
              kind: "person",
              name: repair.actorAliasName,
              fetchedAt: Date.now(),
            });
          }
        }
        const result = await ctx.runMutation(
          internal.playground.applyAsanaEventRepairs,
          {
            orgId: args.orgId,
            repairs: repairs.map((repair) => ({
              eventId: repair.eventId,
              actor: repair.actor,
              summary: repair.summary,
              ...(repair.actorRef ? { actorRef: repair.actorRef } : {}),
              raw: repair.raw,
              clearActorIdentity: repair.clearActorIdentity,
            })),
          },
        );
        patched += result.patched;
      }

      cursor = page.continueCursor;
      isDone = page.isDone;
      if (isDone) {
        break;
      }
    }

    return {
      dryRun,
      scanned,
      changed,
      patched,
      pages: scanned === 0 ? 0 : Math.ceil(scanned / limit),
      isDone,
      nextCursor: isDone ? null : cursor,
      samples,
    };
  },
});

export const repairAsanaEventsAndRebuildKnowledgeForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    repairLimit: v.optional(v.number()),
    repairMaxPages: v.optional(v.number()),
    neutralizeUnverifiedTaskChanges: v.optional(v.boolean()),
    fetchMissingTaskDetails: v.optional(v.boolean()),
    autoContinue: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    dryRun: boolean;
    repair: AsanaRepairForOrgResult;
    wipe: unknown | null;
    rebuild: unknown | null;
    scheduledContinuation: boolean;
    skipped?: string;
  }> => {
    const dryRun = args.dryRun ?? true;
    const autoContinue = args.autoContinue ?? true;
    const repairArgs: {
      orgId: Id<"orgs">;
      dryRun: boolean;
      cursor?: string | null;
      limit?: number;
      maxPages?: number;
      neutralizeUnverifiedTaskChanges?: boolean;
      fetchMissingTaskDetails?: boolean;
    } = { orgId: args.orgId, dryRun };
    if (args.cursor !== undefined) {
      repairArgs.cursor = args.cursor;
    }
    if (args.repairLimit !== undefined) {
      repairArgs.limit = args.repairLimit;
    }
    if (args.repairMaxPages !== undefined) {
      repairArgs.maxPages = args.repairMaxPages;
    }
    if (args.neutralizeUnverifiedTaskChanges !== undefined) {
      repairArgs.neutralizeUnverifiedTaskChanges =
        args.neutralizeUnverifiedTaskChanges;
    }
    if (args.fetchMissingTaskDetails !== undefined) {
      repairArgs.fetchMissingTaskDetails = args.fetchMissingTaskDetails;
    }
    const repair: AsanaRepairForOrgResult = await ctx.runAction(
      internal.playground.repairAsanaEventsForOrg,
      repairArgs,
    );
    if (dryRun) {
      return {
        dryRun,
        repair,
        wipe: null,
        rebuild: null,
        scheduledContinuation: false,
        ...(repair.isDone ? {} : { skipped: "asana-repair-page-limit-reached" }),
      };
    }
    if (!repair.isDone) {
      if (autoContinue && repair.nextCursor) {
        const continuationArgs: {
          orgId: Id<"orgs">;
          dryRun: false;
          cursor: string;
          autoContinue: boolean;
          repairLimit?: number;
          repairMaxPages?: number;
          neutralizeUnverifiedTaskChanges?: boolean;
          fetchMissingTaskDetails?: boolean;
        } = {
          orgId: args.orgId,
          dryRun: false,
          cursor: repair.nextCursor,
          autoContinue,
        };
        if (args.repairLimit !== undefined) {
          continuationArgs.repairLimit = args.repairLimit;
        }
        if (args.repairMaxPages !== undefined) {
          continuationArgs.repairMaxPages = args.repairMaxPages;
        }
        if (args.neutralizeUnverifiedTaskChanges !== undefined) {
          continuationArgs.neutralizeUnverifiedTaskChanges =
            args.neutralizeUnverifiedTaskChanges;
        }
        if (args.fetchMissingTaskDetails !== undefined) {
          continuationArgs.fetchMissingTaskDetails = args.fetchMissingTaskDetails;
        }
        await ctx.scheduler.runAfter(
          0,
          internal.playground.repairAsanaEventsAndRebuildKnowledgeForOrg,
          continuationArgs,
        );
        return {
          dryRun,
          repair,
          wipe: null,
          rebuild: null,
          scheduledContinuation: true,
          skipped: "asana-repair-continuation-scheduled",
        };
      }
      return {
        dryRun,
        repair,
        wipe: null,
        rebuild: null,
        scheduledContinuation: false,
        skipped: "asana-repair-page-limit-reached",
      };
    }
    const wipe = await ctx.runAction(internal.playground.wipeKnowledgeForOrg, {
      orgId: args.orgId,
    });
    const rebuild = await ctx.runAction(
      internal.playground.rebuildKnowledgeForOrg,
      { orgId: args.orgId },
    );
    return { dryRun, repair, wipe, rebuild, scheduledContinuation: false };
  },
});

async function getCachedAsanaIdentityForBackfill(
  ctx: Pick<ActionCtx, "runQuery">,
  orgId: Id<"orgs">,
  gid: string,
): Promise<CachedIdentityForBackfill | null> {
  const cached: CachedIdentityForBackfill[] = await ctx.runQuery(
    internal.spark.getCachedIdentities,
    {
      orgId,
      refs: [{ source: "asana", gid }],
    },
  );
  return cached[0] ?? null;
}

async function resolveEntityNameForBackfill(
  ctx: Pick<ActionCtx, "runAction" | "runQuery">,
  orgId: Id<"orgs">,
  gid: string,
): Promise<string | null> {
  const cached = await getCachedAsanaIdentityForBackfill(ctx, orgId, gid);
  const cachedName = normalizeResolvedName(cached?.name);
  if (cachedName && !isRawIdentifierLikeName(cachedName)) {
    return cachedName;
  }
  if (!cached) {
    return null;
  }

  await ctx.runAction(internal.spark.resolveEntityForActor, {
    orgId,
    source: "asana",
    gid,
    name: cached.name,
    email: cached.email,
  });
  const refreshed = await getCachedAsanaIdentityForBackfill(ctx, orgId, gid);
  const refreshedName = normalizeResolvedName(refreshed?.name);
  return refreshedName && !isRawIdentifierLikeName(refreshedName)
    ? refreshedName
    : null;
}

async function resolveGidForProseBackfill(
  ctx: Pick<ActionCtx, "runAction" | "runQuery">,
  orgId: Id<"orgs">,
  gid: string,
): Promise<ProseGidResource | null> {
  const entityName = await resolveEntityNameForBackfill(ctx, orgId, gid);
  if (entityName) {
    return { gid, kind: "person", name: entityName };
  }

  const projectName = await fetchComposioResourceNameForBackfill(
    orgId,
    ASANA_RESOURCE_FETCHERS.project,
    gid,
  );
  if (projectName) {
    return { gid, kind: "project", name: projectName };
  }

  const taskName = await fetchComposioResourceNameForBackfill(
    orgId,
    ASANA_RESOURCE_FETCHERS.task,
    gid,
  );
  if (taskName) {
    return { gid, kind: "task", name: taskName };
  }

  const sectionName = await fetchComposioResourceNameForBackfill(
    orgId,
    ASANA_RESOURCE_FETCHERS.section,
    gid,
  );
  if (sectionName) {
    return { gid, kind: "section", name: sectionName };
  }

  return null;
}

export const backfillProseGidsForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ processed: number; nextCursor: string; isDone: boolean }> => {
    const requestedLimit = Math.trunc(
      args.limit ?? PROSE_BACKFILL_DEFAULT_LIMIT,
    );
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, PROSE_BACKFILL_MAX_LIMIT))
      : PROSE_BACKFILL_DEFAULT_LIMIT;
    const page = await ctx.runQuery(
      internal.playground.listLeakedPagesForProseBackfill,
      {
        orgId: args.orgId,
        cursor: args.cursor ?? null,
        limit,
      },
    );

    if (page.pages.length === 0) {
      return {
        processed: 0,
        nextCursor: page.nextCursor,
        isDone: page.isDone,
      };
    }

    const resolvedByGid = new Map<string, ProseGidResource | null>();
    for (const gid of page.gids) {
      if (!resolvedByGid.has(gid)) {
        resolvedByGid.set(
          gid,
          await resolveGidForProseBackfill(ctx, args.orgId, gid),
        );
      }
    }

    let processed = 0;
    for (const leakedPage of page.pages) {
      const resources: ProseGidResource[] = [];
      const unknownGids: string[] = [];
      for (const gid of leakedPage.rawGids) {
        const resolved = resolvedByGid.get(gid) ?? null;
        if (resolved) {
          resources.push(resolved);
        } else {
          unknownGids.push(gid);
        }
      }

      processed += await rewriteLeakedPagesWithResources(ctx, {
        pages: [leakedPage],
        resources,
        unknownGids,
        logName: "backfillProseGidsForOrg",
      });
    }

    return {
      processed,
      nextCursor: page.nextCursor,
      isDone: page.isDone,
    };
  },
});

type DuplicateEntityPageGroup = {
  entityId: Id<"entities">;
  survivorId: Id<"knowledgePages">;
  survivorTitle: string;
  losers: Array<{ id: Id<"knowledgePages">; title: string }>;
};

type EntityPageWithEntityId = {
  _id: Id<"knowledgePages">;
  title: string;
  entityId: Id<"entities">;
  sourceCount: number;
  updatedAt: number;
};

export const listDuplicateEntityPageGroups = internalQuery({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ groups: DuplicateEntityPageGroup[] }> => {
    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_entity", (q) => q.eq("orgId", args.orgId))
      .collect();
    const pagesByEntityId = new Map<
      Id<"entities">,
      EntityPageWithEntityId[]
    >();
    for (const page of pages) {
      if (
        (page.type !== "entity" && page.type !== "project") ||
        page.status !== "active" ||
        page.entityId === undefined
      ) {
        continue;
      }
      const group = pagesByEntityId.get(page.entityId) ?? [];
      group.push({
        _id: page._id,
        title: page.title,
        entityId: page.entityId,
        sourceCount: page.sourceCount,
        updatedAt: page.updatedAt,
      });
      pagesByEntityId.set(page.entityId, group);
    }

    const groups: DuplicateEntityPageGroup[] = [];
    for (const entityPages of pagesByEntityId.values()) {
      if (entityPages.length <= 1) {
        continue;
      }
      const sortedPages = [...entityPages].sort((left, right) => {
        if (left.sourceCount !== right.sourceCount) {
          return right.sourceCount - left.sourceCount;
        }
        return right.updatedAt - left.updatedAt;
      });
      const [survivor, ...losers] = sortedPages;
      groups.push({
        entityId: survivor.entityId,
        survivorId: survivor._id,
        survivorTitle: survivor.title,
        losers: losers.map((loser) => ({
          id: loser._id,
          title: loser.title,
        })),
      });
    }

    return { groups };
  },
});

export const mergeDuplicateEntityPagesForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ groups: DuplicateEntityPageGroup[]; merged: number }> => {
    const { groups } = await ctx.runQuery(
      internal.playground.listDuplicateEntityPageGroups,
      { orgId: args.orgId },
    );

    if (args.dryRun === true) {
      return { groups, merged: 0 };
    }

    let merged = 0;
    for (const group of groups) {
      for (const loser of group.losers) {
        await ctx.runMutation(internal.knowledge.mergeKnowledgePages, {
          orgId: args.orgId,
          loserId: loser.id,
          winnerId: group.survivorId,
        });
        merged += 1;
      }
    }

    return { groups, merged };
  },
});

// Debug helper: eyeball events for one org+source (optionally a via/window).
// Returns counts + a trimmed sample (no raw) so backfilled events can be
// inspected without the dashboard. Read-only.
export const listRecentEventsForSource = internalQuery({
  args: {
    orgId: v.id("orgs"),
    source: v.string(),
    via: v.optional(v.string()),
    sinceMs: v.optional(v.number()),
    untilMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("events")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", args.orgId).eq("source", args.source),
      )
      .order("asc")
      .collect();
    const inWindow = rows.filter((e) => {
      if (args.via && e.via !== args.via) return false;
      if (args.sinceMs !== undefined && e.timestamp < args.sinceMs) return false;
      if (args.untilMs !== undefined && e.timestamp >= args.untilMs) return false;
      return true;
    });
    const byVia: Record<string, number> = {};
    for (const e of inWindow) byVia[e.via] = (byVia[e.via] ?? 0) + 1;
    return {
      total: inWindow.length,
      byVia,
      sample: inWindow.slice(0, args.limit ?? 25).map((e) => ({
        at: new Date(e.timestamp).toISOString(),
        via: e.via,
        type: e.type,
        actor: e.actor,
        summary: e.summary.slice(0, 140),
        sourceDeliveryId: e.sourceDeliveryId ?? null,
      })),
    };
  },
});

// One-time migration: backdate evidence that was stamped with write-time before
// the source.occurredAt fix. For each session-derived source it sets occurredAt
// (= the session's real end time) and re-stamps the evidence rows that source
// produced on entity/extraction pages — matched precisely via sourceAttributions
// (excerpt == evidence content), so title collisions don't cross-contaminate.
// Run dryRun first: backdateSessionEvidenceForOrg {orgId, dryRun:true}.
export const listSessionSourceIdsForOrg = internalQuery({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args): Promise<Id<"sources">[]> => {
    const statuses = ["processed", "processing", "pending"] as const;
    const ids: Id<"sources">[] = [];
    for (const status of statuses) {
      const rows = await ctx.db
        .query("sources")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", status),
        )
        .collect();
      for (const s of rows) {
        if (s.sourceType === "session" && s.sessionId) ids.push(s._id);
      }
    }
    return ids;
  },
});

export const restampSessionSourceEvidence = internalMutation({
  args: { sourceId: v.id("sources"), dryRun: v.boolean() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    evidenceRestamped: number;
    pagesPatched: number;
    occurredAtSet: boolean;
  }> => {
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.sourceType !== "session" || !source.sessionId) {
      return { evidenceRestamped: 0, pagesPatched: 0, occurredAtSet: false };
    }
    const session = await ctx.db.get(source.sessionId);
    const activityMs = session?.endTime ?? session?.startTime;
    if (activityMs === undefined) {
      return { evidenceRestamped: 0, pagesPatched: 0, occurredAtSet: false };
    }

    let occurredAtSet = false;
    if (source.occurredAt !== activityMs) {
      if (!args.dryRun) await ctx.db.patch(source._id, { occurredAt: activityMs });
      occurredAtSet = true;
    }

    // Excerpts this source contributed, grouped by page (excerpt == evidence content).
    const attributions = await ctx.db
      .query("sourceAttributions")
      .withIndex("by_source", (q) => q.eq("sourceId", source._id))
      .collect();
    const excerptsByPage = new Map<Id<"knowledgePages">, Set<string>>();
    for (const a of attributions) {
      const set = excerptsByPage.get(a.pageId) ?? new Set<string>();
      set.add(a.excerpt);
      excerptsByPage.set(a.pageId, set);
    }

    let evidenceRestamped = 0;
    let pagesPatched = 0;
    for (const [pageId, excerpts] of excerptsByPage) {
      const matches = (channel: string, src: string, content: string) =>
        channel === source.sourceType &&
        src === source.title &&
        excerpts.has(content);

      // Durable evidence records.
      const evRows = await ctx.db
        .query("knowledgePageEvidence")
        .withIndex("by_page", (q) => q.eq("pageId", pageId))
        .collect();
      for (const ev of evRows) {
        if (matches(ev.channel, ev.source, ev.content) && ev.timestamp !== activityMs) {
          if (!args.dryRun) await ctx.db.patch(ev._id, { timestamp: activityMs });
          evidenceRestamped += 1;
        }
      }

      // Embedded timeline the UI reads.
      const page = await ctx.db.get(pageId);
      if (page) {
        let changed = false;
        const nextTimeline = page.evidenceTimeline.map((e) => {
          if (matches(e.channel, e.source, e.content) && e.timestamp !== activityMs) {
            changed = true;
            return { ...e, timestamp: activityMs };
          }
          return e;
        });
        if (changed) {
          if (!args.dryRun) await ctx.db.patch(pageId, { evidenceTimeline: nextTimeline });
          pagesPatched += 1;
        }
      }
    }
    return { evidenceRestamped, pagesPatched, occurredAtSet };
  },
});

export const backdateSessionEvidenceForOrg = internalAction({
  args: { orgId: v.id("orgs"), dryRun: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    dryRun: boolean;
    sourcesScanned: number;
    sourcesOccurredAtSet: number;
    pagesPatched: number;
    evidenceRestamped: number;
  }> => {
    const dryRun = args.dryRun ?? false;
    const sourceIds = (await ctx.runQuery(
      internal.playground.listSessionSourceIdsForOrg,
      { orgId: args.orgId },
    )) as Id<"sources">[];

    let sourcesOccurredAtSet = 0;
    let pagesPatched = 0;
    let evidenceRestamped = 0;
    for (const sourceId of sourceIds) {
      const res = await ctx.runMutation(
        internal.playground.restampSessionSourceEvidence,
        { sourceId, dryRun },
      );
      if (res.occurredAtSet) sourcesOccurredAtSet += 1;
      pagesPatched += res.pagesPatched;
      evidenceRestamped += res.evidenceRestamped;
    }
    return {
      dryRun,
      sourcesScanned: sourceIds.length,
      sourcesOccurredAtSet,
      pagesPatched,
      evidenceRestamped,
    };
  },
});

// One-time migration companion: backdate page.lastConfirmed to the newest real
// evidence timestamp (was write-time). Fixes the page list grouping + breadcrumb
// dates for already-built pages. Backdate-only (never pushes forward). Run via
// backdateLastConfirmedForOrg {orgId, dryRun}.
export const backdateLastConfirmedBatch = internalMutation({
  args: {
    orgId: v.id("orgs"),
    status: v.union(v.literal("active"), v.literal("archived")),
    cursor: v.union(v.string(), v.null()),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status),
      )
      .paginate({ numItems: 100, cursor: args.cursor });
    let patched = 0;
    for (const page of result.page) {
      if (page.evidenceTimeline.length === 0) continue;
      const maxMs = Math.max(
        ...page.evidenceTimeline.map((e) => e.timestamp),
      );
      if (maxMs < page.lastConfirmed) {
        if (!args.dryRun) await ctx.db.patch(page._id, { lastConfirmed: maxMs });
        patched += 1;
      }
    }
    return {
      patched,
      scanned: result.page.length,
      isDone: result.isDone,
      cursor: result.continueCursor,
    };
  },
});

export const backdateLastConfirmedForOrg = internalAction({
  args: { orgId: v.id("orgs"), dryRun: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ dryRun: boolean; scanned: number; patched: number }> => {
    const dryRun = args.dryRun ?? false;
    let scanned = 0;
    let patched = 0;
    for (const status of ["active", "archived"] as const) {
      let cursor: string | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res: {
          patched: number;
          scanned: number;
          isDone: boolean;
          cursor: string;
        } = await ctx.runMutation(
          internal.playground.backdateLastConfirmedBatch,
          { orgId: args.orgId, status, cursor, dryRun },
        );
        scanned += res.scanned;
        patched += res.patched;
        if (res.isDone) break;
        cursor = res.cursor;
      }
    }
    return { dryRun, scanned, patched };
  },
});

// Debug: dump one page's raw compiled truth + evidence (dates/order) to diagnose
// rendering. Read-only.
export const sampleKnowledgePageRaw = internalQuery({
  args: {
    orgId: v.id("orgs"),
    type: v.optional(v.string()),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let page: Doc<"knowledgePages"> | null = null;
    if (args.slug) {
      page = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) =>
          q.eq("orgId", args.orgId).eq("slug", args.slug as string),
        )
        .first();
    } else {
      const rows = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", "active"),
        )
        .order("desc")
        .take(300);
      page =
        rows.find(
          (p) =>
            (!args.type || p.type === args.type) &&
            p.evidenceTimeline.length > 3,
        ) ??
        rows.find((p) => !args.type || p.type === args.type) ??
        null;
    }
    if (!page) return null;
    return {
      title: page.title,
      slug: page.slug,
      type: page.type,
      lastConfirmed: new Date(page.lastConfirmed).toISOString(),
      updatedAt: new Date(page.updatedAt).toISOString(),
      sessionEndTime: page.sessionEndTime
        ? new Date(page.sessionEndTime).toISOString()
        : null,
      compiledTruthLen: page.compiledTruth.length,
      compiledTruthHasDoubleNewline: /\n{2,}/.test(page.compiledTruth),
      compiledTruthNewlineCount: (page.compiledTruth.match(/\n/g) ?? []).length,
      compiledTruth: page.compiledTruth.slice(0, 4000),
      evidenceCount: page.evidenceTimeline.length,
      evidence: page.evidenceTimeline.map((e) => ({
        at: new Date(e.timestamp).toISOString(),
        source: e.source,
        channel: e.channel,
        content: e.content.slice(0, 70),
      })),
    };
  },
});

// Re-synthesis: rebuild a page's compiledTruth from its FULL evidence (the
// uncapped knowledgePageEvidence, not the 25-row embedded timeline), so pages
// whose summary was overwritten by a single thin source (e.g. a backfilled
// GitHub commit) regain a comprehensive summary. Run:
//   recompileCompiledTruthForOrg {orgId, slug:"mayachen"}   // one page
//   recompileCompiledTruthForOrg {orgId, limit:5}               // first 5 entity/project
//   recompileCompiledTruthForOrg {orgId}                        // all entity/project
const RECOMPILE_EVIDENCE_MAX = 200;

export const getPageEvidenceForRecompile = internalQuery({
  args: {
    orgId: v.id("orgs"),
    pageId: v.optional(v.id("knowledgePages")),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let page: Doc<"knowledgePages"> | null = null;
    if (args.pageId) {
      page = await ctx.db.get(args.pageId);
    } else if (args.slug) {
      page = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) =>
          q.eq("orgId", args.orgId).eq("slug", args.slug as string),
        )
        .first();
    }
    if (!page || page.orgId !== args.orgId) return null;
    const ev = await ctx.db
      .query("knowledgePageEvidence")
      .withIndex("by_page", (q) => q.eq("pageId", page._id))
      .collect();
    ev.sort((a, b) => b.timestamp - a.timestamp); // newest first
    return {
      pageId: page._id,
      title: page.title,
      type: page.type,
      entity: page.entity ?? null,
      evidenceCount: ev.length,
      evidence: ev.slice(0, RECOMPILE_EVIDENCE_MAX).map((e) => ({
        at: new Date(e.timestamp).toISOString().slice(0, 10),
        source: e.source,
        content: e.content,
      })),
    };
  },
});

export const applyRecompiledTruth = internalMutation({
  args: { pageId: v.id("knowledgePages"), compiledTruth: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const page = await ctx.db.get(args.pageId);
    if (!page) return false;
    await ctx.db.patch(page._id, {
      compiledTruth: args.compiledTruth,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const listActivePageRefsBatch = internalQuery({
  args: { orgId: v.id("orgs"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const res = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "active"),
      )
      .paginate({ numItems: 200, cursor: args.cursor });
    return {
      refs: res.page.map((p) => ({ pageId: p._id, type: p.type })),
      isDone: res.isDone,
      cursor: res.continueCursor,
    };
  },
});

// synthesizeCompiledTruth is imported from ./knowledge (canonical — shared with
// the live extraction pipeline so the migration and live re-synthesis stay in sync).

// Processes ONE page (slug) or ONE pagination batch (200 active pages) per call
// — driven by `cursor` so a caller loops batch-by-batch without risking the
// action time limit on hundreds of sequential LLM calls. Per-page try/catch so
// one bad page can't abort the batch.
export const recompileCompiledTruthForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    slug: v.optional(v.string()),
    types: v.optional(v.array(v.string())),
    cursor: v.optional(v.union(v.string(), v.null())),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    recompiled: number;
    skipped: number;
    errors: number;
    scanned: number;
    isDone: boolean;
    cursor: string | null;
  }> => {
    const dryRun = args.dryRun ?? false;
    const typeSet = new Set(args.types ?? ["entity", "project"]);

    const recompileOne = async (
      pageId: Id<"knowledgePages">,
    ): Promise<"done" | "skip" | "error"> => {
      try {
        const data = await ctx.runQuery(
          internal.playground.getPageEvidenceForRecompile,
          { orgId: args.orgId, pageId },
        );
        if (!data || data.evidence.length === 0) return "skip";
        if (dryRun) return "done";
        const compiled = await synthesizeCompiledTruth(data);
        if (!compiled) return "skip";
        await ctx.runMutation(internal.playground.applyRecompiledTruth, {
          pageId,
          compiledTruth: compiled,
        });
        return "done";
      } catch {
        return "error";
      }
    };

    let recompiled = 0;
    let skipped = 0;
    let errors = 0;
    let scanned = 0;
    const tally = (r: "done" | "skip" | "error") => {
      if (r === "done") recompiled += 1;
      else if (r === "error") errors += 1;
      else skipped += 1;
    };

    if (args.slug) {
      const data = await ctx.runQuery(
        internal.playground.getPageEvidenceForRecompile,
        { orgId: args.orgId, slug: args.slug },
      );
      if (data) {
        scanned = 1;
        tally(await recompileOne(data.pageId));
      }
      return { recompiled, skipped, errors, scanned, isDone: true, cursor: null };
    }

    const batch = await ctx.runQuery(
      internal.playground.listActivePageRefsBatch,
      { orgId: args.orgId, cursor: args.cursor ?? null },
    );
    for (const ref of batch.refs) {
      if (!typeSet.has(ref.type)) continue;
      scanned += 1;
      tally(await recompileOne(ref.pageId));
    }
    return {
      recompiled,
      skipped,
      errors,
      scanned,
      isDone: batch.isDone,
      cursor: batch.isDone ? null : batch.cursor,
    };
  },
});

// One-time cleanup: retire existing "Weak provenance" linter findings (now that
// that linter rule is disabled). Sets findingStatus="resolved" so they drop out
// of the active Findings view. Only patches findingStatus (not updatedAt) so the
// by_org_type_status_updatedAt pagination stays stable while mutating. Run:
//   resolveWeakProvenanceFindingsForOrg {orgId, dryRun:true}   // count first
const WEAK_PROVENANCE_TAG = "lint:weak_provenance";

// Phase 1 (read-only): collect weak-provenance finding ids. Pagination is stable
// because we don't mutate during the scan.
export const collectWeakProvenanceFindingIds = internalQuery({
  args: { orgId: v.id("orgs"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const res = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_type_status_updatedAt", (q) =>
        q.eq("orgId", args.orgId).eq("type", "finding").eq("status", "active"),
      )
      .paginate({ numItems: 200, cursor: args.cursor });
    return {
      ids: res.page
        .filter((p) => p.tags.includes(WEAK_PROVENANCE_TAG))
        .map((p) => p._id),
      scanned: res.page.length,
      isDone: res.isDone,
      cursor: res.continueCursor,
    };
  },
});

// Phase 2: archive by id (status="archived" drops them from every active list/
// search query). findingStatus is also set for record-keeping.
export const archiveFindingsByIds = internalMutation({
  args: { ids: v.array(v.id("knowledgePages")), dryRun: v.boolean() },
  handler: async (ctx, args): Promise<{ archived: number }> => {
    let archived = 0;
    for (const id of args.ids) {
      const page = await ctx.db.get(id);
      if (!page || page.type !== "finding" || page.status !== "active") continue;
      if (!args.dryRun) {
        await ctx.db.patch(id, { status: "archived", findingStatus: "resolved" });
      }
      archived += 1;
    }
    return { archived };
  },
});

export const resolveWeakProvenanceFindingsForOrg = internalAction({
  args: { orgId: v.id("orgs"), dryRun: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ dryRun: boolean; scanned: number; found: number; archived: number }> => {
    const dryRun = args.dryRun ?? false;
    const ids: Id<"knowledgePages">[] = [];
    let scanned = 0;
    let cursor: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r: {
        ids: Id<"knowledgePages">[];
        scanned: number;
        isDone: boolean;
        cursor: string;
      } = await ctx.runQuery(
        internal.playground.collectWeakProvenanceFindingIds,
        { orgId: args.orgId, cursor },
      );
      ids.push(...r.ids);
      scanned += r.scanned;
      if (r.isDone) break;
      cursor = r.cursor;
    }

    let archived = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const r = await ctx.runMutation(internal.playground.archiveFindingsByIds, {
        ids: ids.slice(i, i + 100),
        dryRun,
      });
      archived += r.archived;
    }
    return { dryRun, scanned, found: ids.length, archived };
  },
});

// Clear ALL existing active findings (one-time slate-wipe). Two-phase like the
// weak-provenance cleanup. Stale-decision / AI-contradiction linters stay on, so
// genuinely meaningful findings can re-appear later; orphan + weak are disabled.
export const collectActiveFindingIds = internalQuery({
  args: { orgId: v.id("orgs"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const res = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_type_status_updatedAt", (q) =>
        q.eq("orgId", args.orgId).eq("type", "finding").eq("status", "active"),
      )
      .paginate({ numItems: 200, cursor: args.cursor });
    return {
      ids: res.page.map((p) => p._id),
      scanned: res.page.length,
      isDone: res.isDone,
      cursor: res.continueCursor,
    };
  },
});

export const archiveAllFindingsForOrg = internalAction({
  args: { orgId: v.id("orgs"), dryRun: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ dryRun: boolean; scanned: number; found: number; archived: number }> => {
    const dryRun = args.dryRun ?? false;
    const ids: Id<"knowledgePages">[] = [];
    let scanned = 0;
    let cursor: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r: {
        ids: Id<"knowledgePages">[];
        scanned: number;
        isDone: boolean;
        cursor: string;
      } = await ctx.runQuery(internal.playground.collectActiveFindingIds, {
        orgId: args.orgId,
        cursor,
      });
      ids.push(...r.ids);
      scanned += r.scanned;
      if (r.isDone) break;
      cursor = r.cursor;
    }

    let archived = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const r = await ctx.runMutation(internal.playground.archiveFindingsByIds, {
        ids: ids.slice(i, i + 100),
        dryRun,
      });
      archived += r.archived;
    }
    return { dryRun, scanned, found: ids.length, archived };
  },
});

// TEMP audit (read-only): quantify how many active `decision` pages are actually
// routine task/operational events vs real strategic decisions, to size the
// extraction-quality cleanup. Run: `npx convex run playground:debugDecisionAudit`.
export const debugDecisionAudit = internalQuery({
  args: { orgId: v.optional(v.id("orgs")) },
  handler: async (ctx, args) => {
    const orgs = args.orgId
      ? [await ctx.db.get(args.orgId)].filter(Boolean)
      : await ctx.db.query("orgs").take(20);
    const noise =
      /\b((re)?assigned to|multi-homed|tasks? (move|moved|repositioning|created|creation|assignment|reassigned)|task created|task moved|webhook|deduplicat|connectivity test|pull used to sync)\b/i;
    const out = [];
    for (const org of orgs) {
      if (!org) continue;
      const decisions = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_type_status_updatedAt", (q) =>
          q.eq("orgId", org._id).eq("type", "decision").eq("status", "active"),
        )
        .take(3000);
      const noisy = decisions.filter((page) => noise.test(page.title));
      const lowSingle = decisions.filter(
        (page) => page.sourceCount < 2 && page.confidence === "low",
      );
      out.push({
        orgId: org._id,
        totalDecisions: decisions.length,
        noisyByTitle: noisy.length,
        lowConfidenceSingleSource: lowSingle.length,
        sampleNoisy: noisy.slice(0, 15).map((page) => page.title),
        sampleAll: decisions.slice(0, 12).map((page) => ({
          title: page.title,
          confidence: page.confidence,
          sourceCount: page.sourceCount,
        })),
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Cleanup: re-classify existing `decision` pages, archiving the ones that are
// actually routine task/implementation events (the extractor over-produced these
// before the prompt was tightened). LLM keep/demote judge; DRY RUN by default.
//   Dry run: npx convex run playground:reclassifyDecisionsForOrg '{"orgId":"..."}'
//   Apply:   npx convex run playground:reclassifyDecisionsForOrg '{"orgId":"...","dryRun":false}'
// ---------------------------------------------------------------------------
export const decisionPagesForReclassify = internalQuery({
  args: { orgId: v.id("orgs"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_type_status_updatedAt", (q) =>
        q.eq("orgId", args.orgId).eq("type", "decision").eq("status", "active"),
      )
      .take(args.limit ?? 1000);
    return pages.map((page) => ({
      _id: page._id,
      title: page.title,
      compiledTruth: page.compiledTruth,
    }));
  },
});

export const archiveDecisionPagesByIds = internalMutation({
  args: { ids: v.array(v.id("knowledgePages")), dryRun: v.boolean() },
  handler: async (ctx, args): Promise<{ archived: number }> => {
    let archived = 0;
    for (const id of args.ids) {
      const page = await ctx.db.get(id);
      if (!page || page.type !== "decision" || page.status !== "active") continue;
      if (!args.dryRun) {
        await ctx.db.patch(id, { status: "archived" });
      }
      archived += 1;
    }
    return { archived };
  },
});

export const reclassifyDecisionsForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    dryRun: boolean;
    totalDecisions: number;
    demoteCount: number;
    keepCount: number;
    archived: number;
    sampleDemote: string[];
    sampleKeep: string[];
  }> => {
    const dryRun = args.dryRun ?? true;
    const batchSize = Math.min(Math.max(args.batchSize ?? 25, 1), 40);
    const pages: Array<{
      _id: Id<"knowledgePages">;
      title: string;
      compiledTruth: string;
    }> = await ctx.runQuery(internal.playground.decisionPagesForReclassify, {
      orgId: args.orgId,
      limit: 1000,
    });

    const instructions = [
      'You audit Spark knowledge pages currently classified as "decision" and decide which are GENUINE strategic decisions versus routine task/implementation events that were mis-classified.',
      "",
      "A genuine decision is a consequential, deliberate choice with reasoning that sets direction, strategy, policy, architecture, scope, or process — it would matter to someone outside the immediate task.",
      'Demote (verdict "demote") anything that is instead a routine task/ticket operation (assignment, reassignment, moving, scheduling, section placement, multi-homing), a file/layout/library/format pick, a "did X rather than Y" implementation choice, commit/PR bundling, a one-off engineering action, webhook/CI/automation noise, or a single-event activity log.',
      "",
      'For EACH page below, output ONLY a JSON array: [{ "id": string, "verdict": "keep" | "demote" }]. Include every id exactly once. No prose.',
    ].join("\n");

    const demote: Array<{ id: Id<"knowledgePages">; title: string }> = [];
    let keepCount = 0;
    const sampleKeep: string[] = [];

    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize);
      const userContent = batch
        .map(
          (page) =>
            `id: ${page._id}\ntitle: ${page.title}\nsummary: ${(page.compiledTruth ?? "")
              .replace(/\s+/g, " ")
              .slice(0, 280)}`,
        )
        .join("\n\n---\n\n");

      let responseText = "";
      try {
        responseText = await withRetriableCall(classifyAnthropicRetry, async () => {
          const result = await anthropicClient.messages.create({
            model: SONNET_MODEL,
            max_tokens: 4000,
            temperature: 0,
            system: [{ type: "text" as const, text: instructions }],
            messages: [{ role: "user" as const, content: userContent }],
          });
          return result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
            .trim();
        });
      } catch (error) {
        console.warn("playground:reclassifyDecisionsForOrg:batchFailed", {
          orgId: args.orgId,
          batchStart: i,
          error: getErrorMessage(error),
        });
        continue;
      }

      let verdicts: Array<{ id?: string; verdict?: string }> = [];
      try {
        const parsed = JSON.parse(stripJsonFence(responseText));
        if (Array.isArray(parsed)) verdicts = parsed;
      } catch {
        verdicts = [];
      }

      const byId = new Map(batch.map((page) => [page._id as string, page]));
      for (const verdict of verdicts) {
        const page = verdict.id ? byId.get(verdict.id) : undefined;
        if (!page) continue;
        if (verdict.verdict === "demote") {
          demote.push({ id: page._id, title: page.title });
        } else {
          keepCount += 1;
          if (sampleKeep.length < 15) sampleKeep.push(page.title);
        }
      }
    }

    let archived = 0;
    if (!dryRun && demote.length > 0) {
      for (let i = 0; i < demote.length; i += 100) {
        const r: { archived: number } = await ctx.runMutation(
          internal.playground.archiveDecisionPagesByIds,
          { ids: demote.slice(i, i + 100).map((d) => d.id), dryRun: false },
        );
        archived += r.archived;
      }
    }

    return {
      dryRun,
      totalDecisions: pages.length,
      demoteCount: demote.length,
      keepCount,
      archived,
      sampleDemote: demote.slice(0, 30).map((d) => d.title),
      sampleKeep,
    };
  },
});

// TEMP (read-only): inspect the actual recent-signal-starter chips for an org —
// mirrors the chat empty state + Home recommended buttons. Run:
//   npx convex run playground:debugRecentSignalStarters '{"orgId":"...","limit":6}'
export const debugRecentSignalStarters = internalQuery({
  args: { orgId: v.id("orgs"), limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    recentSignalStartersForOrg(ctx, args.orgId, Math.min(Math.max(args.limit ?? 6, 1), 12)),
});

// ---------------------------------------------------------------------------
// Backfill: populate starterQuestion/starterPrompt on existing signal-eligible
// pages that predate the extraction-prompt change. LLM-written per page; DRY RUN
// by default.
//   Dry run: npx convex run playground:backfillStarterQuestionsForOrg '{"orgId":"..."}'
//   Apply:   npx convex run playground:backfillStarterQuestionsForOrg '{"orgId":"...","dryRun":false}'
// ---------------------------------------------------------------------------
const STARTER_SIGNAL_TYPES = new Set([
  "fact",
  "decision",
  "pattern",
  "goal",
  "question",
  "session",
  "finding",
]);

// Returns the RECENT signal-eligible pages (per type, newest-first) that still
// lack a starterQuestion — i.e. the ones that can actually surface as chips.
// Targeting recency (not a full by_org_status scan) keeps the set bounded to
// what's visible, and the sliced compiledTruth keeps the payload small/stable.
export const pagesNeedingStarterQuestion = internalQuery({
  args: { orgId: v.id("orgs"), perType: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const perType = Math.min(Math.max(args.perType ?? 40, 1), 200);
    const types = [
      "finding",
      "decision",
      "pattern",
      "goal",
      "question",
      "session",
      "fact",
    ] as const;
    const groups = await Promise.all(
      types.map((type) =>
        ctx.db
          .query("knowledgePages")
          .withIndex("by_org_type_status_updatedAt", (q) =>
            q.eq("orgId", args.orgId).eq("type", type).eq("status", "active"),
          )
          .order("desc")
          .take(perType),
      ),
    );
    return groups
      .flat()
      .filter((page) => !(page.starterQuestion && page.starterQuestion.trim()))
      .map((page) => ({
        _id: page._id,
        type: page.type,
        title: page.title,
        compiledTruth: (page.compiledTruth ?? "").slice(0, 320),
      }));
  },
});

export const patchStarterQuestions = internalMutation({
  args: {
    items: v.array(
      v.object({
        id: v.id("knowledgePages"),
        starterQuestion: v.string(),
        starterPrompt: v.string(),
      }),
    ),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ patched: number }> => {
    let patched = 0;
    for (const item of args.items) {
      const page = await ctx.db.get(item.id);
      if (!page || page.status !== "active") continue;
      if (!item.starterQuestion.trim()) continue;
      if (!args.dryRun) {
        await ctx.db.patch(item.id, {
          starterQuestion: item.starterQuestion.trim(),
          starterPrompt: item.starterPrompt.trim(),
        });
      }
      patched += 1;
    }
    return { patched };
  },
});

export const backfillStarterQuestionsForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
    maxPages: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    dryRun: boolean;
    pagesNeeding: number;
    generated: number;
    patched: number;
    note: string;
    sample: Array<{ title: string; starterQuestion: string; starterPrompt: string }>;
  }> => {
    const dryRun = args.dryRun ?? true;
    const batchSize = Math.min(Math.max(args.batchSize ?? 20, 1), 30);
    // Cap per invocation so the action's ~dozen LLM batches fit the execution
    // limit. Re-run (with dryRun:false) until pagesNeeding reaches 0 — patched
    // pages no longer match the "needs starterQuestion" query.
    const maxPages = Math.min(Math.max(args.maxPages ?? 120, 1), 160);
    const candidates: Array<{
      _id: Id<"knowledgePages">;
      type: string;
      title: string;
      compiledTruth: string;
    }> = await ctx.runQuery(internal.playground.pagesNeedingStarterQuestion, {
      orgId: args.orgId,
      perType: 40,
    });
    // Cap per invocation so the action's LLM batches fit the ~5-min limit.
    const pages = candidates.slice(0, maxPages);

    const instructions = [
      "You write the clickable chip question + chat prefill prompt for Spark knowledge pages (used as 'recent signal' starters on the home and chat surfaces).",
      "",
      "For EACH page below, return ONLY a JSON array: [{ \"id\": string, \"starterQuestion\": string, \"starterPrompt\": string }]. Include every id exactly once. No prose.",
      "- starterQuestion: a concise, natural question (about 6-12 words) specific to THIS page that a user would click to explore it. No surrounding quotes, no ids, not a template.",
      "- starterPrompt: a fuller, natural one- or two-sentence chat prompt for the same page asking Spark to dig in (why it matters, the evidence, what to watch or the next step). Specific to this page; do NOT use a fixed skeleton like 'Analyze the pattern \"X\"'.",
    ].join("\n");

    const generated: Array<{
      id: Id<"knowledgePages">;
      title: string;
      starterQuestion: string;
      starterPrompt: string;
    }> = [];

    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize);
      const userContent = batch
        .map(
          (page) =>
            `id: ${page._id}\ntype: ${page.type}\ntitle: ${page.title}\nsummary: ${(page.compiledTruth ?? "")
              .replace(/\s+/g, " ")
              .slice(0, 320)}`,
        )
        .join("\n\n---\n\n");

      let responseText = "";
      try {
        responseText = await withRetriableCall(classifyAnthropicRetry, async () => {
          const result = await anthropicClient.messages.create({
            model: SONNET_MODEL,
            max_tokens: 6000,
            temperature: 0.3,
            system: [{ type: "text" as const, text: instructions }],
            messages: [{ role: "user" as const, content: userContent }],
          });
          return result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
            .trim();
        });
      } catch (error) {
        console.warn("playground:backfillStarterQuestionsForOrg:batchFailed", {
          orgId: args.orgId,
          batchStart: i,
          error: getErrorMessage(error),
        });
        continue;
      }

      let rows: Array<{ id?: string; starterQuestion?: string; starterPrompt?: string }> = [];
      try {
        const parsed = JSON.parse(stripJsonFence(responseText));
        if (Array.isArray(parsed)) rows = parsed;
      } catch {
        rows = [];
      }

      const byId = new Map(batch.map((page) => [page._id as string, page]));
      for (const row of rows) {
        const page = row.id ? byId.get(row.id) : undefined;
        if (!page || !row.starterQuestion?.trim()) continue;
        generated.push({
          id: page._id,
          title: page.title,
          starterQuestion: row.starterQuestion.trim(),
          starterPrompt: (row.starterPrompt ?? row.starterQuestion).trim(),
        });
      }
    }

    let patched = 0;
    if (!dryRun && generated.length > 0) {
      for (let i = 0; i < generated.length; i += 100) {
        const r: { patched: number } = await ctx.runMutation(
          internal.playground.patchStarterQuestions,
          {
            items: generated.slice(i, i + 100).map((g) => ({
              id: g.id,
              starterQuestion: g.starterQuestion,
              starterPrompt: g.starterPrompt,
            })),
            dryRun: false,
          },
        );
        patched += r.patched;
      }
    }

    return {
      dryRun,
      pagesNeeding: candidates.length,
      generated: generated.length,
      patched,
      note:
        candidates.length > maxPages
          ? `${candidates.length} recent pages still need it; processed ${pages.length} this run — re-run (dryRun:false) until pagesNeeding is small.`
          : "All recent signal pages processed this run.",
      sample: generated.slice(0, 12).map((g) => ({
        title: g.title,
        starterQuestion: g.starterQuestion,
        starterPrompt: g.starterPrompt,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Chat thread title backfill / clear utilities (admin). The live titling
// (spark.generateThreadTitle) stays in spark.ts; these are one-off org helpers.
// ---------------------------------------------------------------------------

export const listUntitledChatThreadIds = internalQuery({
  args: { orgId: v.id("orgs"), limit: v.number() },
  handler: async (ctx, args): Promise<string[]> => {
    const rows = await ctx.db
      .query("threadOrgs")
      .withIndex("by_org_purpose_user", (q) =>
        q.eq("orgId", args.orgId).eq("purpose", "chat"),
      )
      .collect();
    return rows
      .filter((r) => !r.title)
      .slice(0, args.limit)
      .map((r) => r.threadId);
  },
});

// AI-title existing chat threads that have no title yet.
export const backfillThreadTitlesForOrg = internalAction({
  args: { orgId: v.id("orgs"), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    const threadIds = (await ctx.runQuery(
      internal.playground.listUntitledChatThreadIds,
      { orgId: args.orgId, limit: args.limit ?? 200 },
    )) as string[];
    for (const threadId of threadIds) {
      await ctx.scheduler.runAfter(0, internal.spark.generateThreadTitle, {
        threadId,
      });
    }
    return { scheduled: threadIds.length };
  },
});

// Clear stored titles for an org's chat threads so a re-backfill regenerates
// them (e.g. after fixing the title prompt). Also clears manual renames.
export const clearThreadTitlesForOrg = internalMutation({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args): Promise<{ cleared: number }> => {
    const rows = await ctx.db
      .query("threadOrgs")
      .withIndex("by_org_purpose_user", (q) =>
        q.eq("orgId", args.orgId).eq("purpose", "chat"),
      )
      .collect();
    let cleared = 0;
    for (const row of rows) {
      if (row.title !== undefined) {
        await ctx.db.patch(row._id, { title: undefined });
        cleared += 1;
      }
    }
    return { cleared };
  },
});
