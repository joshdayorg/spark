import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

// ---------------------------------------------------------------------------
// usage — one row per AI call across all surfaces (spec/api.md A-11,
// spec/data-model.md Phase 3). This is the substrate for per-org cost
// dashboards, per-agent budget caps (U-51), and metered billing.
//
// Recording is deliberately fail-soft at every call site: a usage-write
// failure must never take down chat, extraction, synthesis, or an agent run.
// ---------------------------------------------------------------------------

export const USAGE_SOURCES = [
  "chat",
  "extractor",
  "synthesizer",
  "linter",
  "customer-agent",
  "dream-cycle",
] as const;

export type UsageSource = (typeof USAGE_SOURCES)[number];

export const usageSourceValidator = v.union(
  v.literal("chat"),
  v.literal("extractor"),
  v.literal("synthesizer"),
  v.literal("linter"),
  v.literal("customer-agent"),
  v.literal("dream-cycle"),
);

export const recordUsage = internalMutation({
  args: {
    orgId: v.id("orgs"),
    agentId: v.optional(v.id("agentDefinitions")),
    source: usageSourceValidator,
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadInputTokens: v.number(),
    cacheCreationInputTokens: v.number(),
    costCents: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"usage">> => {
    return ctx.db.insert("usage", {
      orgId: args.orgId,
      agentId: args.agentId,
      source: args.source,
      model: args.model,
      inputTokens: Math.max(0, Math.trunc(args.inputTokens)),
      outputTokens: Math.max(0, Math.trunc(args.outputTokens)),
      cacheReadInputTokens: Math.max(0, Math.trunc(args.cacheReadInputTokens)),
      cacheCreationInputTokens: Math.max(
        0,
        Math.trunc(args.cacheCreationInputTokens),
      ),
      costCents: Math.max(0, args.costCents),
      timestamp: Date.now(),
    });
  },
});

const SUM_PAGE_SIZE = 1000;
const SUM_MAX_PAGES = 20;

// Bounded cost sum for budget checks (U-51). Reads through an org-prefixed
// index in timestamp order with a hard page budget; if the window somehow
// exceeds SUM_PAGE_SIZE * SUM_MAX_PAGES rows, the result is marked truncated
// (budget callers should treat truncated as over-budget — fail safe).
export const sumUsageForOrgSince = internalQuery({
  args: {
    orgId: v.id("orgs"),
    sinceMs: v.number(),
    source: v.optional(usageSourceValidator),
    agentId: v.optional(v.id("agentDefinitions")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ costCents: number; rows: number; truncated: boolean }> => {
    let costCents = 0;
    let rows = 0;

    const query = args.agentId
      ? ctx.db
          .query("usage")
          .withIndex("by_org_agent", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("agentId", args.agentId!)
              .gte("timestamp", args.sinceMs),
          )
      : args.source
      ? ctx.db
          .query("usage")
          .withIndex("by_org_source", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("source", args.source!)
              .gte("timestamp", args.sinceMs),
          )
      : ctx.db
          .query("usage")
          .withIndex("by_org", (q) =>
            q.eq("orgId", args.orgId).gte("timestamp", args.sinceMs),
          );

    let cursor: string | null = null;
    for (let page = 0; page < SUM_MAX_PAGES; page++) {
      const result = await query.paginate({ cursor, numItems: SUM_PAGE_SIZE });
      for (const row of result.page) {
        costCents += row.costCents;
        rows += 1;
      }
      if (result.isDone) {
        return { costCents, rows, truncated: false };
      }
      cursor = result.continueCursor;
    }
    return { costCents, rows, truncated: true };
  },
});
