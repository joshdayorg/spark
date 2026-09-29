import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import { slugify } from "./knowledge";

// ---------------------------------------------------------------------------
// Dream Cycle — the Findings engine (spec/ux/findings.md U-57..U-60, api.md
// Pipe 3 "Spark Mind"). An overnight Managed Agent run reasons over the org's
// accumulated knowledge and produces 3-7 findings per run. Findings are
// knowledgePages (type: "finding", D-8) written through the same idempotent
// upsert path as linter findings, in the finding-dream- slug namespace.
// ---------------------------------------------------------------------------

const DREAM_MAX_FINDINGS = 7;
const DREAM_CONTEXT_PAGE_LIMIT = 40;
const DREAM_CONTEXT_SYNTHESES = 6;
const DREAM_SUMMARY_CHARS = 280;

export const FINDING_TYPES = [
  "contradiction",
  "strategic_gap",
  "resource_drift",
  "emerging_capability",
  "stale_decision",
  "unanswered_question",
  "blind_spot",
] as const;
type FindingType = (typeof FINDING_TYPES)[number];
type Severity = "high" | "medium" | "low";

type DreamFindingCandidate = {
  findingType: FindingType;
  severity: Severity;
  title: string;
  summary: string;
  implication: string;
  relatedSlugs: string[];
  evidence: string[];
};

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  let cut = trimmed.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// Bounded reasoning context: recent syntheses + a spread of active pages.
// The agent can (and should) go deeper through the Spark MCP tools; this seed
// keeps the first reasoning pass grounded even if tool use is shallow.
export const getDreamContextForOrg = internalQuery({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    pages: Array<{ slug: string; type: string; title: string; summary: string }>;
    syntheses: Array<{ period: string; timestamp: number; summary: string }>;
    hasKnowledge: boolean;
  }> => {
    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", "active"),
      )
      .order("desc")
      .take(DREAM_CONTEXT_PAGE_LIMIT);
    const syntheses = await ctx.db
      .query("syntheses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(DREAM_CONTEXT_SYNTHESES);
    return {
      pages: pages
        .filter((page) => page.type !== "finding")
        .map((page) => ({
          slug: page.slug,
          type: page.type,
          title: page.title,
          summary: clip(page.compiledTruth, DREAM_SUMMARY_CHARS),
        })),
      syntheses: syntheses.map((row) => ({
        period: row.period,
        timestamp: row.timestamp,
        summary: clip(row.summary ?? "", DREAM_SUMMARY_CHARS * 2),
      })),
      hasKnowledge: pages.length > 0,
    };
  },
});

export const DREAM_SYSTEM_PROMPT = [
  "You are Spark Mind running the overnight Dream Cycle for an organization.",
  "You reason over the org's accumulated knowledge base and produce findings —",
  "strategic intelligence nobody asked for. Not activity summaries: connections,",
  "contradictions, drifts, and blind spots that only emerge from reading",
  "everything together.",
  "",
  "Use the Spark MCP tools (spark_search, spark_entity) to read deeper into any",
  "thread you are pursuing. Prefer specific evidence over vibes.",
  "",
  "Produce between 1 and 7 findings, each one of these exact types:",
  "contradiction | strategic_gap | resource_drift | emerging_capability |",
  "stale_decision | unanswered_question | blind_spot.",
  "",
  "End your reply with ONLY a fenced json block of this exact shape:",
  '```json',
  '{"findings": [{"findingType": "contradiction", "severity": "high",',
  '"title": "...", "summary": "2-5 sentence compiled truth of the finding",',
  '"implication": "what this means for the business (the So What)",',
  '"relatedSlugs": ["slug-of-page-you-reasoned-over"],',
  '"evidence": ["one-line evidence statement citing a page or synthesis"]}]}',
  "```",
  "Every finding MUST reference at least one real page slug from the context or",
  "your tool results in relatedSlugs. Severity: high = business impact + high",
  "confidence; medium = notable; low = informational.",
].join("\n");

export function buildDreamPrompt(context: {
  pages: Array<{ slug: string; type: string; title: string; summary: string }>;
  syntheses: Array<{ period: string; timestamp: number; summary: string }>;
}): string {
  return [
    "Knowledge base sample (slug | type | title | summary):",
    ...context.pages.map(
      (page) => `- ${page.slug} | ${page.type} | ${page.title} | ${page.summary}`,
    ),
    "",
    "Recent syntheses:",
    ...context.syntheses.map(
      (row) =>
        `- [${row.period} @ ${new Date(row.timestamp).toISOString()}] ${row.summary}`,
    ),
    "",
    "Run the Dream Cycle now. Reason across ALL of it — what contradicts, what",
    "is drifting, what capability is forming, what question nobody is asking.",
    "Then emit the fenced json block.",
  ].join("\n");
}

export function parseDreamFindings(output: string): DreamFindingCandidate[] {
  const fenced = output.match(/```json\s*([\s\S]*?)```/);
  const braceIndex = output.indexOf("{");
  const rawJson =
    fenced?.[1] ?? (braceIndex >= 0 ? output.slice(braceIndex) : "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Dream Cycle output contained no parseable findings JSON");
  }
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    throw new Error("Dream Cycle output JSON missing findings array");
  }
  const results: DreamFindingCandidate[] = [];
  for (const item of findings.slice(0, DREAM_MAX_FINDINGS)) {
    const candidate = item as Record<string, unknown>;
    const findingType = String(candidate.findingType ?? "");
    const severity = String(candidate.severity ?? "");
    const title = String(candidate.title ?? "").trim();
    const summary = String(candidate.summary ?? "").trim();
    const implication = String(candidate.implication ?? "").trim();
    const relatedSlugs = Array.isArray(candidate.relatedSlugs)
      ? candidate.relatedSlugs.map((slug) => String(slug)).filter(Boolean)
      : [];
    const evidence = Array.isArray(candidate.evidence)
      ? candidate.evidence.map((entry) => String(entry)).filter(Boolean)
      : [];
    if (
      !(FINDING_TYPES as readonly string[]).includes(findingType) ||
      !["high", "medium", "low"].includes(severity) ||
      !title ||
      !summary ||
      !implication ||
      relatedSlugs.length === 0
    ) {
      console.warn("spark:dreamFindingSkipped", { title, findingType, severity });
      continue;
    }
    results.push({
      findingType: findingType as FindingType,
      severity: severity as Severity,
      title,
      summary,
      implication,
      relatedSlugs,
      evidence: evidence.length > 0 ? evidence : [summary],
    });
  }
  return results;
}

export const resolvePageIdsBySlugs = internalQuery({
  args: { orgId: v.id("orgs"), slugs: v.array(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<Array<Id<"knowledgePages">>> => {
    const ids: Array<Id<"knowledgePages">> = [];
    for (const slug of args.slugs.slice(0, 10)) {
      const page = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) =>
          q.eq("orgId", args.orgId).eq("slug", slug),
        )
        .first();
      if (page && page.status === "active") {
        ids.push(page._id);
      }
    }
    return ids;
  },
});

export const runDreamCycleForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<{ findingsWritten: number; skipped: number; reason?: string }> => {
    const context = await ctx.runQuery(internal.dreamCycle.getDreamContextForOrg, {
      orgId: args.orgId,
    });
    if (!context.hasKnowledge) {
      return { findingsWritten: 0, skipped: 0, reason: "no-knowledge" };
    }

    const result = (await ctx.runAction(internal.spark.runDreamCycle, {
      orgId: args.orgId,
      prompt: buildDreamPrompt(context),
    })) as { output: string };

    const candidates = parseDreamFindings(result.output);
    let findingsWritten = 0;
    let skipped = 0;
    const now = Date.now();

    for (const candidate of candidates) {
      const relatedPageIds = await ctx.runQuery(
        internal.dreamCycle.resolvePageIdsBySlugs,
        { orgId: args.orgId, slugs: candidate.relatedSlugs },
      );
      if (relatedPageIds.length === 0) {
        console.warn("spark:dreamFindingUnresolvedSlugs", {
          orgId: args.orgId,
          title: candidate.title,
          relatedSlugs: candidate.relatedSlugs,
        });
        skipped += 1;
        continue;
      }
      await ctx.runMutation(internal.knowledge.upsertLinterFinding, {
        orgId: args.orgId,
        slug: `finding-dream-${candidate.findingType}-${slugify(candidate.title)}`,
        title: candidate.title,
        compiledTruth: candidate.summary,
        evidenceTimeline: candidate.evidence.map((entry) => ({
          source: "Spark Mind",
          channel: "dream-cycle",
          timestamp: now,
          content: entry,
        })),
        tags: ["dream-cycle", candidate.findingType],
        confidence:
          candidate.severity === "high"
            ? ("high" as const)
            : candidate.severity === "medium"
              ? ("medium" as const)
              : ("low" as const),
        severity: candidate.severity,
        findingType: candidate.findingType,
        implication: candidate.implication,
        relatedPageIds,
        sourceAgent: "dream-cycle",
      });
      findingsWritten += 1;
    }

    console.log("spark:dreamCycleCompleted", {
      orgId: args.orgId,
      findingsWritten,
      skipped,
    });
    return { findingsWritten, skipped };
  },
});

// Overnight fan-out (03:30 UTC): schedule a Dream Cycle per org that has
// knowledge. Orgs are paged; each run is an isolated scheduled action so one
// org's failure cannot starve the rest.
export const dreamCycleFanOut = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    let cursor: string | null = null;
    do {
      const page = (await ctx.runQuery(internal.spark.listOrgIdsPage, {
        paginationOpts: { numItems: 50, cursor },
      })) as { page: Array<Id<"orgs">>; isDone: boolean; continueCursor: string };
      for (const orgId of page.page) {
        await ctx.scheduler.runAfter(0, internal.dreamCycle.runDreamCycleForOrg, {
          orgId,
        });
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    return null;
  },
});
