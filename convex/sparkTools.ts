import { createTool, type ToolCtx } from "@convex-dev/agent";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

// ---------------------------------------------------------------------------
// Spark Chat knowledge tools (spec A-3 / U-24). Together with the typed
// aggregate/widget tools defined in spark.ts (countByDimension, trendOverTime,
// splitOf, getStat, listSessions — the S-11 runOneoffQuery intent, decomposed
// into safe typed queries), these complete the spec tool surface except
// createAgent, which lands with agentDefinitions in the customer-agents slice.
//
// Org scoping contract (scopedDb principle, S-11): every tool resolves orgId
// from the agent thread via internal.search.getOrgIdForThread. The model never
// sees or supplies an orgId; tools inject it at the infrastructure level and
// every read below goes through an org-prefixed index with a bounded take.
// ---------------------------------------------------------------------------

const MAX_TOOL_LIMIT = 50;
const MAX_SCAN_ROWS = 1000;
const MAX_EVIDENCE_ENTRIES = 20;
const SUMMARY_SNIPPET_CHARS = 400;

function clampLimit(
  requested: number | undefined,
  fallback: number,
  max: number = MAX_TOOL_LIMIT,
): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(requested), max));
}

function snippet(text: string, maxChars: number = SUMMARY_SNIPPET_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  let cut = trimmed.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

async function requireOrgIdForThread(toolCtx: ToolCtx): Promise<Id<"orgs">> {
  if (!toolCtx.threadId) {
    throw new Error("AUTH: missing thread context");
  }
  const orgId = (await toolCtx.runQuery(internal.search.getOrgIdForThread, {
    threadId: toolCtx.threadId,
  })) as Id<"orgs"> | null;
  if (!orgId) {
    throw new Error("AUTH: no org context for thread");
  }
  return orgId;
}

// --- getKnowledgeItem -------------------------------------------------------

type KnowledgeItemDetail = {
  found: boolean;
  page?: {
    pageId: Id<"knowledgePages">;
    slug: string;
    title: string;
    type: Doc<"knowledgePages">["type"];
    compiledTruth: string;
    tags: string[];
    confidence: Doc<"knowledgePages">["confidence"];
    lastConfirmed: number;
    sourceCount: number;
    evidence: Array<{
      source: string;
      channel: string;
      timestamp: number;
      content: string;
    }>;
  };
};

export const getPageDetailForOrg = internalQuery({
  args: {
    orgId: v.id("orgs"),
    pageId: v.optional(v.id("knowledgePages")),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<KnowledgeItemDetail> => {
    let page: Doc<"knowledgePages"> | null = null;
    if (args.pageId) {
      const byId = await ctx.db.get(args.pageId);
      // Org check before anything else: a page from another org is "not found".
      page = byId && byId.orgId === args.orgId ? byId : null;
    } else if (args.slug) {
      page = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) =>
          q.eq("orgId", args.orgId).eq("slug", args.slug!),
        )
        .first();
    }
    if (!page || page.status === "archived") {
      return { found: false };
    }

    const evidenceRows = await ctx.db
      .query("knowledgePageEvidence")
      .withIndex("by_page_key", (q) => q.eq("pageId", page!._id))
      .order("desc")
      .take(MAX_EVIDENCE_ENTRIES);

    return {
      found: true,
      page: {
        pageId: page._id,
        slug: page.slug,
        title: page.title,
        type: page.type,
        compiledTruth: page.compiledTruth,
        tags: page.tags,
        confidence: page.confidence,
        lastConfirmed: page.lastConfirmed,
        sourceCount: page.sourceCount,
        evidence: evidenceRows.map((row) => ({
          source: row.source,
          channel: row.channel,
          timestamp: row.timestamp,
          content: row.content,
        })),
      },
    };
  },
});

type GetKnowledgeItemInput = { pageId?: string; slug?: string };

export const getKnowledgeItem = createTool<GetKnowledgeItemInput, KnowledgeItemDetail>({
  description:
    "Fetch one knowledge page in full (Compiled Truth + recent evidence) by pageId or slug. Use after searchKnowledge when the user needs the details behind a result.",
  inputSchema: z.object({
    pageId: z.string().optional().describe("Knowledge page ID from a prior tool result"),
    slug: z.string().optional().describe("Stable page slug, if known instead of the ID"),
  }),
  execute: async (toolCtx, input): Promise<KnowledgeItemDetail> => {
    const orgId = await requireOrgIdForThread(toolCtx);
    if (!input.pageId && !input.slug) {
      throw new Error("BAD_REQUEST: provide pageId or slug");
    }
    return (await toolCtx.runQuery(internal.sparkTools.getPageDetailForOrg, {
      orgId,
      pageId: input.pageId as Id<"knowledgePages"> | undefined,
      slug: input.slug,
    })) as KnowledgeItemDetail;
  },
});

// --- listKnowledgeSources ----------------------------------------------------

export const listSourcesForOrg = internalQuery({
  args: {
    orgId: v.id("orgs"),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("processed"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 20);
    const rows = args.status
      ? await ctx.db
          .query("sources")
          .withIndex("by_org_status", (q) =>
            q.eq("orgId", args.orgId).eq("status", args.status!),
          )
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("sources")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId))
          .order("desc")
          .take(limit);
    return rows.map((source) => ({
      sourceId: source._id,
      title: source.title,
      sourceType: source.sourceType,
      status: source.status,
      createdAt: source.createdAt,
    }));
  },
});

type SourceListItem = {
  sourceId: Id<"sources">;
  title: string;
  sourceType: Doc<"sources">["sourceType"];
  status: Doc<"sources">["status"];
  createdAt: number;
};
type ListKnowledgeSourcesInput = {
  status?: "pending" | "processing" | "processed";
  limit?: number;
};

export const listKnowledgeSources = createTool<ListKnowledgeSourcesInput, SourceListItem[]>({
  description:
    "List the org's ingested knowledge sources (pastes, URLs, files, captured sessions) with their processing status, newest first.",
  inputSchema: z.object({
    status: z
      .enum(["pending", "processing", "processed"])
      .optional()
      .describe("Filter by processing status"),
    limit: z.number().optional().describe("Max sources to return (default 20, max 50)"),
  }),
  execute: async (toolCtx, input): Promise<SourceListItem[]> => {
    const orgId = await requireOrgIdForThread(toolCtx);
    return (await toolCtx.runQuery(internal.sparkTools.listSourcesForOrg, {
      orgId,
      status: input.status,
      limit: input.limit,
    })) as SourceListItem[];
  },
});

// --- summarizeKnowledge -------------------------------------------------------

export const listPageSummariesForOrg = internalQuery({
  args: {
    orgId: v.id("orgs"),
    type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 25);
    const pages = args.type
      ? await ctx.db
          .query("knowledgePages")
          .withIndex("by_org_type", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("type", args.type as Doc<"knowledgePages">["type"]),
          )
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("knowledgePages")
          .withIndex("by_org_status", (q) =>
            q.eq("orgId", args.orgId).eq("status", "active"),
          )
          .order("desc")
          .take(limit);
    return pages
      .filter((page) => page.status === "active")
      .map((page) => ({
        pageId: page._id,
        slug: page.slug,
        title: page.title,
        type: page.type,
        confidence: page.confidence,
        lastConfirmed: page.lastConfirmed,
        summary: snippet(page.compiledTruth),
      }));
  },
});

type PageSummary = {
  pageId: Id<"knowledgePages">;
  slug: string;
  title: string;
  type: Doc<"knowledgePages">["type"];
  confidence: Doc<"knowledgePages">["confidence"];
  lastConfirmed: number;
  summary: string;
};
type SummarizeKnowledgeInput = {
  type?: Doc<"knowledgePages">["type"];
  limit?: number;
};

export const summarizeKnowledge = createTool<SummarizeKnowledgeInput, PageSummary[]>({
  description:
    "Pull a bounded set of knowledge page summaries (optionally filtered by type: fact, pattern, decision, entity, project, question, finding, goal, session) so you can synthesize across them. Use for broad questions like 'what do we know about X' or 'summarize our decisions'.",
  inputSchema: z.object({
    type: z
      .enum([
        "fact",
        "pattern",
        "decision",
        "entity",
        "project",
        "question",
        "finding",
        "goal",
        "session",
      ])
      .optional()
      .describe("Restrict to one knowledge type"),
    limit: z.number().optional().describe("Max pages to include (default 25, max 50)"),
  }),
  execute: async (toolCtx, input): Promise<PageSummary[]> => {
    const orgId = await requireOrgIdForThread(toolCtx);
    return (await toolCtx.runQuery(internal.sparkTools.listPageSummariesForOrg, {
      orgId,
      type: input.type,
      limit: input.limit,
    })) as PageSummary[];
  },
});

// --- addKnowledgeItem ---------------------------------------------------------

export const addKnowledgeFromChat = internalMutation({
  args: {
    orgId: v.id("orgs"),
    title: v.string(),
    content: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ sourceId: Id<"sources"> | null; duplicate: boolean }> => {
    const { knowledgeBaseId } = (await ctx.runMutation(
      internal.knowledge.ensureKnowledgeBase,
      { orgId: args.orgId },
    )) as { knowledgeBaseId: Id<"knowledgeBases"> };
    const result = (await ctx.runMutation(internal.knowledge.createSource, {
      orgId: args.orgId,
      knowledgeBaseId,
      title: args.title,
      sourceType: "paste",
      content: args.content,
    })) as { sourceId: Id<"sources"> | null; duplicate?: boolean };
    return {
      sourceId: result.sourceId ?? null,
      duplicate: result.duplicate === true,
    };
  },
});

type AddKnowledgeResult = { sourceId: Id<"sources"> | null; duplicate: boolean };
type AddKnowledgeItemInput = { title: string; content: string };

export const addKnowledgeItem = createTool<AddKnowledgeItemInput, AddKnowledgeResult>({
  description:
    "Write new knowledge from this conversation into the org's knowledge base. The content is ingested through the normal source pipeline (chunking, extraction, attribution), so state it as clean, self-contained markdown.",
  inputSchema: z.object({
    title: z.string().describe("Short document title for the new knowledge"),
    content: z
      .string()
      .describe("Self-contained markdown capturing the knowledge to record"),
  }),
  // U-29: human gate on the write tool. The user must approve before Spark
  // writes conversation content into the org's knowledge base.
  needsApproval: true,
  execute: async (toolCtx, input): Promise<AddKnowledgeResult> => {
    const orgId = await requireOrgIdForThread(toolCtx);
    return (await toolCtx.runMutation(internal.sparkTools.addKnowledgeFromChat, {
      orgId,
      title: input.title,
      content: input.content,
    })) as AddKnowledgeResult;
  },
});

// --- createAgent (U-47) --------------------------------------------------------

type CreateAgentInput = {
  name: string;
  description: string;
  instructions: string;
  modelTier: "fast" | "thorough";
  schedule?: string;
  deliveryChannel?: string;
  deliveryTarget?: string;
  deliveryCondition?: string;
  activate?: boolean;
};
type CreateAgentResult = { agentDefinitionId: Id<"agentDefinitions">; status: string };

export const createAgent = createTool<CreateAgentInput, CreateAgentResult>({
  description:
    "Create a customer agent from this conversation (U-47). Generate the full config from org context: a clear name, one-line description, markdown instructions, model tier (fast=Sonnet for routine work, thorough=Opus for deep reasoning), and a schedule ('hourly' | 'daily' | 'weekly' | 'every <N>m' | 'every <N>h'). Optional delivery (channel + target, e.g. slack #engineering). Set activate=true only when the user explicitly confirmed the preview.",
  inputSchema: z.object({
    name: z.string().describe("Short agent name"),
    description: z.string().describe("One-line summary of what it does"),
    instructions: z.string().describe("Full markdown instructions for each run"),
    modelTier: z.enum(["fast", "thorough"]).describe("fast=Sonnet, thorough=Opus"),
    schedule: z
      .string()
      .optional()
      .describe("hourly | daily | weekly | every <N>m | every <N>h"),
    deliveryChannel: z.string().optional().describe("Delivery channel, e.g. slack"),
    deliveryTarget: z.string().optional().describe("Delivery target, e.g. #engineering"),
    deliveryCondition: z
      .string()
      .optional()
      .describe("Natural-language condition for when to deliver"),
    activate: z
      .boolean()
      .optional()
      .describe("true = active immediately; false/omitted = saved as draft"),
  }),
  // The user approves the preview card before anything is persisted.
  needsApproval: true,
  execute: async (toolCtx, input): Promise<CreateAgentResult> => {
    const orgId = await requireOrgIdForThread(toolCtx);
    const agentDefinitionId = (await toolCtx.runMutation(
      internal.agents.createAgentDefinition,
      {
        orgId,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        modelTier: input.modelTier,
        schedule: input.schedule,
        delivery:
          input.deliveryChannel && input.deliveryTarget
            ? {
                channel: input.deliveryChannel,
                target: input.deliveryTarget,
                condition: input.deliveryCondition,
              }
            : undefined,
        activate: input.activate,
      },
    )) as Id<"agentDefinitions">;
    return {
      agentDefinitionId,
      status: input.activate ? "active" : "draft",
    };
  },
});
