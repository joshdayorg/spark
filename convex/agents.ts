import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { orgMutation, orgQuery } from "./spark";

// ---------------------------------------------------------------------------
// Customer agents (spec/ux/agents.md, spec/api.md Pipe 4, U-35..U-52).
//
// A definition is customer config; each run is a Managed Agent session driven
// by spark.ts runManagedAgentSession. This module owns: lifecycle, versioned
// edits with bounded rollback history (U-38), the schedule → cron layer
// (U-50), budget enforcement before session creation (U-51), templates
// (U-47), and run bookkeeping (agentRuns).
// ---------------------------------------------------------------------------

export const AGENT_VERSION_HISTORY_LIMIT = 10;
const SCHEDULER_BATCH_LIMIT = 10;
const CONSECUTIVE_FAILURES_TO_ERROR = 3;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MODEL_TIER_MAP: Record<"fast" | "thorough", string> = {
  fast: "claude-sonnet-4-6",
  thorough: "claude-opus-4-6",
};

// U-47 starter templates, aligned to the four spec use cases.
export const AGENT_TEMPLATES: Array<{
  slug: string;
  name: string;
  description: string;
  instructions: string;
  modelTier: "fast" | "thorough";
  schedule: string;
}> = [
  {
    slug: "digest",
    name: "Weekly Digest",
    description: "Weekly summary of what the team shipped, by person.",
    instructions:
      "Each run, review the org's recent sessions and knowledge updates via the Spark MCP tools. Write a concise digest of what shipped since the last run, grouped by person, with links to the knowledge pages you used. Push the digest into Spark with spark_push.",
    modelTier: "fast",
    schedule: "weekly",
  },
  {
    slug: "monitor",
    name: "Stall Monitor",
    description: "Watches for stalled projects and unresolved decisions.",
    instructions:
      "Each run, look for projects with no new sessions and decision pages that stayed open since the previous run. When something has stalled, push a finding-style signal into Spark with spark_push explaining what stalled, since when, and who is blocked.",
    modelTier: "fast",
    schedule: "daily",
  },
  {
    slug: "scorer",
    name: "Work Scorer",
    description: "Grades recent work sessions against your rubric.",
    instructions:
      "Each run, fetch recent session pages via spark_search and grade each against the rubric. Push a per-session score summary into Spark with spark_push. Be specific about what raised or lowered each score.",
    modelTier: "thorough",
    schedule: "weekly",
  },
  {
    slug: "investigator",
    name: "Investigator",
    description: "Deep-dives anomalies in org activity.",
    instructions:
      "Each run, look for anomalies — velocity drops, pattern breaks, contradictory decisions — using spark_search and spark_entity. Investigate the most significant one and push a detailed finding into Spark with spark_push.",
    modelTier: "thorough",
    schedule: "daily",
  },
];

// Schedule grammar (kept deliberately small; anything unparseable simply does
// not schedule): "hourly" | "daily" | "weekly" | "every <N>m" | "every <N>h".
export function computeNextRunAt(
  schedule: string | undefined,
  from: number,
): number | undefined {
  if (!schedule) return undefined;
  const normalized = schedule.trim().toLowerCase();
  if (normalized === "hourly") return from + 60 * 60 * 1000;
  if (normalized === "daily") return from + DAY_MS;
  if (normalized === "weekly") return from + 7 * DAY_MS;
  const every = normalized.match(/^every\s+(\d+)\s*(m|h)$/);
  if (every) {
    const amount = Number(every[1]);
    const unit = every[2] === "h" ? 60 * 60 * 1000 : 60 * 1000;
    return from + Math.max(MIN_INTERVAL_MS, amount * unit);
  }
  return undefined;
}

const editableFieldsValidator = {
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  instructions: v.optional(v.string()),
  modelTier: v.optional(v.union(v.literal("fast"), v.literal("thorough"))),
  schedule: v.optional(v.string()),
  delivery: v.optional(
    v.object({
      channel: v.string(),
      target: v.string(),
      condition: v.optional(v.string()),
    }),
  ),
  rubric: v.optional(v.string()),
  monthlyBudgetCents: v.optional(v.number()),
  budgetAlertCents: v.optional(v.number()),
};

function snapshotOf(def: Doc<"agentDefinitions">) {
  return {
    version: def.version,
    name: def.name,
    description: def.description,
    instructions: def.instructions,
    modelTier: def.modelTier,
    schedule: def.schedule,
    rubric: def.rubric,
    savedAt: Date.now(),
  };
}

export const createAgentDefinition = internalMutation({
  args: {
    orgId: v.id("orgs"),
    name: v.string(),
    description: v.string(),
    instructions: v.string(),
    modelTier: v.union(v.literal("fast"), v.literal("thorough")),
    schedule: v.optional(v.string()),
    delivery: v.optional(
      v.object({
        channel: v.string(),
        target: v.string(),
        condition: v.optional(v.string()),
      }),
    ),
    rubric: v.optional(v.string()),
    monthlyBudgetCents: v.optional(v.number()),
    activate: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Id<"agentDefinitions">> => {
    const now = Date.now();
    const status = args.activate ? "active" : "draft";
    return ctx.db.insert("agentDefinitions", {
      orgId: args.orgId,
      name: args.name,
      description: args.description,
      instructions: args.instructions,
      modelTier: args.modelTier,
      schedule: args.schedule,
      delivery: args.delivery,
      rubric: args.rubric,
      monthlyBudgetCents: args.monthlyBudgetCents,
      status,
      version: 1,
      consecutiveFailures: 0,
      nextRunAt:
        status === "active" ? computeNextRunAt(args.schedule, now) : undefined,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateAgentDefinition = internalMutation({
  args: {
    orgId: v.id("orgs"),
    agentDefinitionId: v.id("agentDefinitions"),
    ...editableFieldsValidator,
  },
  handler: async (ctx, args): Promise<{ version: number }> => {
    const def = await ctx.db.get(args.agentDefinitionId);
    if (!def || def.orgId !== args.orgId) {
      throw new Error("BAD_REQUEST: unknown agent definition for org");
    }
    const history = [...(def.versionHistory ?? []), snapshotOf(def)].slice(
      -AGENT_VERSION_HISTORY_LIMIT,
    );
    const now = Date.now();
    const schedule = args.schedule ?? def.schedule;
    const nextVersion = def.version + 1;
    await ctx.db.patch(def._id, {
      name: args.name ?? def.name,
      description: args.description ?? def.description,
      instructions: args.instructions ?? def.instructions,
      modelTier: args.modelTier ?? def.modelTier,
      schedule,
      delivery: args.delivery ?? def.delivery,
      rubric: args.rubric ?? def.rubric,
      monthlyBudgetCents: args.monthlyBudgetCents ?? def.monthlyBudgetCents,
      budgetAlertCents: args.budgetAlertCents ?? def.budgetAlertCents,
      version: nextVersion,
      versionHistory: history,
      nextRunAt:
        def.status === "active"
          ? computeNextRunAt(schedule, now)
          : def.nextRunAt,
      updatedAt: now,
    });
    return { version: nextVersion };
  },
});

export const rollbackAgentDefinition = internalMutation({
  args: {
    orgId: v.id("orgs"),
    agentDefinitionId: v.id("agentDefinitions"),
    toVersion: v.number(),
  },
  handler: async (ctx, args): Promise<{ version: number }> => {
    const def = await ctx.db.get(args.agentDefinitionId);
    if (!def || def.orgId !== args.orgId) {
      throw new Error("BAD_REQUEST: unknown agent definition for org");
    }
    const snapshot = (def.versionHistory ?? []).find(
      (entry) => entry.version === args.toVersion,
    );
    if (!snapshot) {
      throw new Error("BAD_REQUEST: version not in rollback history");
    }
    const now = Date.now();
    const history = [...(def.versionHistory ?? []), snapshotOf(def)].slice(
      -AGENT_VERSION_HISTORY_LIMIT,
    );
    const nextVersion = def.version + 1;
    await ctx.db.patch(def._id, {
      name: snapshot.name,
      description: snapshot.description,
      instructions: snapshot.instructions,
      modelTier: snapshot.modelTier,
      schedule: snapshot.schedule,
      rubric: snapshot.rubric,
      version: nextVersion,
      versionHistory: history,
      nextRunAt:
        def.status === "active"
          ? computeNextRunAt(snapshot.schedule, now)
          : def.nextRunAt,
      updatedAt: now,
    });
    return { version: nextVersion };
  },
});

// Lifecycle: draft → active ↔ paused; errored → active (fix + resume);
// any non-archived → archived.
export const setAgentStatus = internalMutation({
  args: {
    orgId: v.id("orgs"),
    agentDefinitionId: v.id("agentDefinitions"),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("archived"),
    ),
  },
  handler: async (ctx, args): Promise<null> => {
    const def = await ctx.db.get(args.agentDefinitionId);
    if (!def || def.orgId !== args.orgId) {
      throw new Error("BAD_REQUEST: unknown agent definition for org");
    }
    if (def.status === "archived") {
      throw new Error("BAD_REQUEST: archived agents can only be restored to draft");
    }
    const now = Date.now();
    await ctx.db.patch(def._id, {
      status: args.status,
      consecutiveFailures:
        args.status === "active" ? 0 : def.consecutiveFailures,
      nextRunAt:
        args.status === "active"
          ? computeNextRunAt(def.schedule, now)
          : undefined,
      updatedAt: now,
    });
    return null;
  },
});

export const listAgentDefinitionsForOrg = internalQuery({
  args: {
    orgId: v.id("orgs"),
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("active"),
        v.literal("paused"),
        v.literal("errored"),
        v.literal("archived"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const defs = args.status
      ? await ctx.db
          .query("agentDefinitions")
          .withIndex("by_org", (q) =>
            q.eq("orgId", args.orgId).eq("status", args.status!),
          )
          .take(100)
      : await ctx.db
          .query("agentDefinitions")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(100);
    return defs.map((def) => ({
      agentDefinitionId: def._id,
      name: def.name,
      description: def.description,
      modelTier: def.modelTier,
      schedule: def.schedule,
      status: def.status,
      version: def.version,
      lastRunAt: def.lastRunAt,
      nextRunAt: def.nextRunAt,
    }));
  },
});

// --- scheduler ---------------------------------------------------------------

// Claim-before-run: the mutation advances nextRunAt atomically, so overlapping
// scheduler ticks cannot double-run a definition (same pattern as extraction
// claim/lease, A-12).
export const claimDueAgentDefinitions = internalMutation({
  args: { now: v.number() },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ agentDefinitionId: Id<"agentDefinitions">; orgId: Id<"orgs"> }>> => {
    const due = await ctx.db
      .query("agentDefinitions")
      .withIndex("by_status_nextRunAt", (q) =>
        q.eq("status", "active").lte("nextRunAt", args.now),
      )
      .take(SCHEDULER_BATCH_LIMIT);
    const claimed: Array<{
      agentDefinitionId: Id<"agentDefinitions">;
      orgId: Id<"orgs">;
    }> = [];
    for (const def of due) {
      if (def.nextRunAt === undefined) {
        continue;
      }
      await ctx.db.patch(def._id, {
        nextRunAt: computeNextRunAt(def.schedule, args.now),
        lastRunAt: args.now,
      });
      claimed.push({ agentDefinitionId: def._id, orgId: def.orgId });
    }
    return claimed;
  },
});

export const agentScheduler = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    const claimed = await ctx.runMutation(
      internal.agents.claimDueAgentDefinitions,
      { now: Date.now() },
    );
    for (const claim of claimed) {
      await ctx.scheduler.runAfter(0, internal.agents.runAgentDefinition, {
        agentDefinitionId: claim.agentDefinitionId,
        trigger: "schedule",
      });
    }
    return null;
  },
});

// --- run bookkeeping -----------------------------------------------------------

export const getAgentDefinitionById = internalQuery({
  args: { agentDefinitionId: v.id("agentDefinitions") },
  handler: async (ctx, args): Promise<Doc<"agentDefinitions"> | null> => {
    return ctx.db.get(args.agentDefinitionId);
  },
});

export const insertAgentRun = internalMutation({
  args: {
    orgId: v.id("orgs"),
    agentDefinitionId: v.id("agentDefinitions"),
    trigger: v.union(
      v.literal("schedule"),
      v.literal("manual"),
      v.literal("chat"),
    ),
  },
  handler: async (ctx, args): Promise<Id<"agentRuns">> => {
    return ctx.db.insert("agentRuns", {
      orgId: args.orgId,
      agentDefinitionId: args.agentDefinitionId,
      status: "running",
      startTime: Date.now(),
      trigger: args.trigger,
    });
  },
});

export const finishAgentRun = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    outputText: v.optional(v.string()),
    error: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    costCents: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<null> => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      return null;
    }
    const endTime = Date.now();
    await ctx.db.patch(run._id, {
      status: args.status,
      outcome: args.status === "completed" ? "satisfied" : "failed",
      endTime,
      duration: endTime - run.startTime,
      outputText: args.outputText,
      error: args.error,
      tokenUsage:
        args.inputTokens !== undefined && args.outputTokens !== undefined
          ? { inputTokens: args.inputTokens, outputTokens: args.outputTokens }
          : undefined,
      costCents: args.costCents,
    });

    // Failure accounting → auto-pause to errored after N consecutive failures.
    const def = await ctx.db.get(run.agentDefinitionId);
    if (!def) {
      return null;
    }
    if (args.status === "failed") {
      const failures = (def.consecutiveFailures ?? 0) + 1;
      await ctx.db.patch(def._id, {
        consecutiveFailures: failures,
        ...(failures >= CONSECUTIVE_FAILURES_TO_ERROR
          ? { status: "errored" as const, nextRunAt: undefined }
          : {}),
        updatedAt: endTime,
      });
    } else if ((def.consecutiveFailures ?? 0) > 0) {
      await ctx.db.patch(def._id, {
        consecutiveFailures: 0,
        updatedAt: endTime,
      });
    }
    return null;
  },
});

const MONTH_MS = 30 * DAY_MS;

export const runAgentDefinition = internalAction({
  args: {
    agentDefinitionId: v.id("agentDefinitions"),
    trigger: v.union(
      v.literal("schedule"),
      v.literal("manual"),
      v.literal("chat"),
    ),
  },
  handler: async (ctx, args): Promise<{ ran: boolean; reason?: string }> => {
    const def = await ctx.runQuery(internal.agents.getAgentDefinitionById, {
      agentDefinitionId: args.agentDefinitionId,
    });
    if (!def || def.status !== "active") {
      return { ran: false, reason: "not-active" };
    }

    // U-51: enforce the monthly budget cap BEFORE creating a session. A
    // truncated sum means the window overflowed the read budget — treat as
    // over budget (fail safe for spend).
    if (def.monthlyBudgetCents !== undefined) {
      const spend = await ctx.runQuery(internal.usage.sumUsageForOrgSince, {
        orgId: def.orgId,
        sinceMs: Date.now() - MONTH_MS,
        agentId: def._id,
      });
      if (spend.truncated || spend.costCents >= def.monthlyBudgetCents) {
        console.warn("spark:agentBudgetExceeded", {
          agentDefinitionId: def._id,
          spendCents: spend.costCents,
          budgetCents: def.monthlyBudgetCents,
          truncated: spend.truncated,
        });
        return { ran: false, reason: "budget-exceeded" };
      }
    }

    const runId = await ctx.runMutation(internal.agents.insertAgentRun, {
      orgId: def.orgId,
      agentDefinitionId: def._id,
      trigger: args.trigger,
    });

    try {
      const result = (await ctx.runAction(internal.spark.runCustomerAgent, {
        orgId: def.orgId,
        name: def.name,
        model: MODEL_TIER_MAP[def.modelTier],
        system: def.instructions,
        message: buildRunPrompt(def),
        agentId: def._id,
      })) as { output: string; usage: { inputTokens: number; outputTokens: number } };
      await ctx.runMutation(internal.agents.finishAgentRun, {
        runId,
        status: "completed",
        outputText: result.output.slice(0, 20_000),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      return { ran: true };
    } catch (error) {
      await ctx.runMutation(internal.agents.finishAgentRun, {
        runId,
        status: "failed",
        error: String(error).slice(0, 2_000),
      });
      return { ran: false, reason: "run-failed" };
    }
  },
});

function buildRunPrompt(def: Doc<"agentDefinitions">): string {
  const parts = [
    `Scheduled run of the "${def.name}" agent.`,
    def.description,
    def.rubric ? `Rubric for a good outcome:\n${def.rubric}` : null,
    def.delivery
      ? `After completing the work, deliver the result to ${def.delivery.channel} → ${def.delivery.target}` +
        (def.delivery.condition ? ` (only when: ${def.delivery.condition})` : "")
      : null,
    "Use the Spark MCP tools to read org knowledge and push results.",
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}


// ---------------------------------------------------------------------------
// Public Agents surface (Pipe 7: the Agents page subscribes to
// agentDefinitions + agentRuns; ux/agents.md roster + detail views).
// All wrappers derive orgId from the Clerk JWT via orgQuery/orgMutation —
// never from client args — and org-check every target row.
// ---------------------------------------------------------------------------

const AGENT_RUNS_PAGE = 25;

export const listAgents = orgQuery({
  args: {},
  handler: async (ctx) => {
    const defs = await ctx.db
      .query("agentDefinitions")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(100);
    return defs
      .filter((def) => def.status !== "archived")
      .map((def) => ({
        agentDefinitionId: def._id,
        name: def.name,
        description: def.description,
        modelTier: def.modelTier,
        schedule: def.schedule,
        status: def.status,
        version: def.version,
        lastRunAt: def.lastRunAt,
        nextRunAt: def.nextRunAt,
        monthlyBudgetCents: def.monthlyBudgetCents,
      }));
  },
});

export const getAgentDetail = orgQuery({
  args: { agentDefinitionId: v.id("agentDefinitions") },
  handler: async (ctx, args) => {
    const def = await ctx.db.get(args.agentDefinitionId);
    if (!def || def.orgId !== ctx.orgId) {
      return null;
    }
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_agent", (q) => q.eq("agentDefinitionId", def._id))
      .order("desc")
      .take(AGENT_RUNS_PAGE);
    return {
      agentDefinitionId: def._id,
      name: def.name,
      description: def.description,
      instructions: def.instructions,
      modelTier: def.modelTier,
      schedule: def.schedule,
      delivery: def.delivery,
      rubric: def.rubric,
      status: def.status,
      version: def.version,
      versionHistory: (def.versionHistory ?? []).map((entry) => ({
        version: entry.version,
        name: entry.name,
        savedAt: entry.savedAt,
      })),
      lastRunAt: def.lastRunAt,
      nextRunAt: def.nextRunAt,
      consecutiveFailures: def.consecutiveFailures ?? 0,
      monthlyBudgetCents: def.monthlyBudgetCents,
      budgetAlertCents: def.budgetAlertCents,
      recentRuns: runs.map((run) => ({
        runId: run._id,
        status: run.status,
        outcome: run.outcome,
        startTime: run.startTime,
        duration: run.duration,
        costCents: run.costCents,
        error: run.error,
        trigger: run.trigger,
        outputPreview: run.outputText?.slice(0, 280),
      })),
    };
  },
});

export const templates = orgQuery({
  args: {},
  handler: async () => AGENT_TEMPLATES,
});

export const createAgentForOrg = orgMutation({
  args: {
    name: v.string(),
    description: v.string(),
    instructions: v.string(),
    modelTier: v.union(v.literal("fast"), v.literal("thorough")),
    schedule: v.optional(v.string()),
    delivery: v.optional(
      v.object({
        channel: v.string(),
        target: v.string(),
        condition: v.optional(v.string()),
      }),
    ),
    rubric: v.optional(v.string()),
    monthlyBudgetCents: v.optional(v.number()),
    activate: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<Id<"agentDefinitions">> => {
    return ctx.runMutation(internal.agents.createAgentDefinition, {
      orgId: ctx.orgId,
      ...args,
    });
  },
});

export const updateAgent = orgMutation({
  args: {
    agentDefinitionId: v.id("agentDefinitions"),
    ...editableFieldsValidator,
  },
  handler: async (ctx, args): Promise<{ version: number }> => {
    return ctx.runMutation(internal.agents.updateAgentDefinition, {
      orgId: ctx.orgId,
      ...args,
    });
  },
});

export const setAgentStatusForOrg = orgMutation({
  args: {
    agentDefinitionId: v.id("agentDefinitions"),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("archived"),
    ),
  },
  handler: async (ctx, args): Promise<null> => {
    return ctx.runMutation(internal.agents.setAgentStatus, {
      orgId: ctx.orgId,
      agentDefinitionId: args.agentDefinitionId,
      status: args.status,
    });
  },
});

export const rollbackAgent = orgMutation({
  args: {
    agentDefinitionId: v.id("agentDefinitions"),
    toVersion: v.number(),
  },
  handler: async (ctx, args): Promise<{ version: number }> => {
    return ctx.runMutation(internal.agents.rollbackAgentDefinition, {
      orgId: ctx.orgId,
      agentDefinitionId: args.agentDefinitionId,
      toVersion: args.toVersion,
    });
  },
});

// "Run now" from the detail view. The org check happens here; the scheduled
// action re-checks status (only active definitions run).
export const runAgentNow = orgMutation({
  args: { agentDefinitionId: v.id("agentDefinitions") },
  handler: async (ctx, args): Promise<null> => {
    const def = await ctx.db.get(args.agentDefinitionId);
    if (!def || def.orgId !== ctx.orgId) {
      throw new Error("BAD_REQUEST: unknown agent definition for org");
    }
    if (def.status !== "active") {
      throw new Error("BAD_REQUEST: only active agents can be run on demand");
    }
    await ctx.scheduler.runAfter(0, internal.agents.runAgentDefinition, {
      agentDefinitionId: def._id,
      trigger: "manual",
    });
    return null;
  },
});
