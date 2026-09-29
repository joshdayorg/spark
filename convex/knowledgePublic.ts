import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  applyKnowledgePagePatch,
  insertPageVersion,
} from "./knowledgePageVersions";
import { getUserIdFromAuth, orgMutation } from "./spark";

// ---------------------------------------------------------------------------
// Public Knowledge/Findings mutations (Pipe 7; ux/knowledge.md View 3 editor,
// ux/findings.md action bar). Reads already exist as orgQueries in
// knowledge.ts; these are the missing write surfaces. orgId comes only from
// the Clerk JWT via orgMutation; every target row is org-checked.
// ---------------------------------------------------------------------------

const COMPILED_TRUTH_MAX_CHARS = 50_000;

// Findings action bar (U-59): acknowledge / dismiss / resolve. Reopening to
// "new" is deliberately not exposed — the system reopens findings itself when
// they re-detect (shared upsert semantics).
export const setFindingStatus = orgMutation({
  args: {
    pageId: v.id("knowledgePages"),
    findingStatus: v.union(
      v.literal("acknowledged"),
      v.literal("investigating"),
      v.literal("resolved"),
      v.literal("dismissed"),
    ),
  },
  handler: async (ctx, args): Promise<null> => {
    const page = await ctx.db.get(args.pageId);
    if (!page || page.orgId !== ctx.orgId || page.type !== "finding") {
      throw new Error("BAD_REQUEST: finding not found for org");
    }
    const now = Date.now();
    const patch = { findingStatus: args.findingStatus, updatedAt: now };
    const latestVersion = await ctx.db
      .query("pageVersions")
      .withIndex("by_page", (q) => q.eq("pageId", page._id))
      .order("desc")
      .first();
    await ctx.db.patch(page._id, patch);
    await insertPageVersion(ctx, {
      pageId: page._id,
      page: applyKnowledgePagePatch(page, patch),
      changeReason: `Finding ${args.findingStatus} by user`,
      changedBy: await getUserIdFromAuth(ctx),
      version: (latestVersion?.version ?? 0) + 1,
      createdAt: now,
    });
    return null;
  },
});

// The editor (U-15/U-62): humans refine Compiled Truth. The edit is versioned
// with the human's identity so AI updates and human updates stay separable in
// history; the Evidence Timeline is immutable from here.
export const editCompiledTruth = orgMutation({
  args: {
    pageId: v.id("knowledgePages"),
    compiledTruth: v.string(),
    changeReason: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ version: number }> => {
    const page = await ctx.db.get(args.pageId);
    if (!page || page.orgId !== ctx.orgId || page.status === "archived") {
      throw new Error("BAD_REQUEST: page not found for org");
    }
    const compiledTruth = args.compiledTruth.trim();
    if (!compiledTruth) {
      throw new Error("BAD_REQUEST: compiled truth cannot be empty");
    }
    if (compiledTruth.length > COMPILED_TRUTH_MAX_CHARS) {
      throw new Error("BAD_REQUEST: compiled truth exceeds the size limit");
    }
    const now = Date.now();
    const patch = { compiledTruth, updatedAt: now };
    const latestVersion = await ctx.db
      .query("pageVersions")
      .withIndex("by_page", (q) => q.eq("pageId", page._id))
      .order("desc")
      .first();
    const version = (latestVersion?.version ?? 0) + 1;
    await ctx.db.patch(page._id, patch);
    await insertPageVersion(ctx, {
      pageId: page._id,
      page: applyKnowledgePagePatch(page, patch),
      changeReason: args.changeReason ?? "Human edit",
      changedBy: await getUserIdFromAuth(ctx),
      version,
      createdAt: now,
    });
    return { version };
  },
});

// Source intake from the Knowledge surface (spec/knowledge.md Ingest: "user
// drops a paste/URL"). Flows through the full pipeline: dedup, chunking,
// context prefixes, extraction, attribution.
export const createPasteSource = orgMutation({
  args: {
    title: v.string(),
    content: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ sourceId: Id<"sources"> | null; duplicate: boolean }> => {
    const title = args.title.trim();
    const content = args.content.trim();
    if (!title || !content) {
      throw new Error("BAD_REQUEST: title and content are required");
    }
    const { knowledgeBaseId } = (await ctx.runMutation(
      internal.knowledge.ensureKnowledgeBase,
      { orgId: ctx.orgId },
    )) as { knowledgeBaseId: Id<"knowledgeBases"> };
    const result = (await ctx.runMutation(internal.knowledge.createSource, {
      orgId: ctx.orgId,
      knowledgeBaseId,
      title,
      sourceType: "paste",
      content,
    })) as { sourceId: Id<"sources"> | null; duplicate?: boolean };
    return {
      sourceId: result.sourceId ?? null,
      duplicate: result.duplicate === true,
    };
  },
});
