import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsMCPToolsetParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents";
import type { BetaManagedAgentsSpanModelRequestEndEvent } from "@anthropic-ai/sdk/resources/beta/sessions";
import { anthropic } from "@ai-sdk/anthropic";
import { stepCountIs } from "ai";
import { Agent, createTool, vStreamArgs } from "@convex-dev/agent";
import {
  makeFunctionReference,
  paginationOptsValidator,
  type FunctionReference,
  type PaginationOptions,
  type PaginationResult,
  type RegisteredAction,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { v, type Infer, type Validator } from "convex/values";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import { z as z4 } from "zod/v4";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DREAM_SYSTEM_PROMPT } from "./dreamCycle";
import type { UsageSource } from "./usage";
import {
  addKnowledgeItem,
  createAgent,
  getKnowledgeItem,
  listKnowledgeSources,
  summarizeKnowledge,
} from "./sparkTools";
import {
  ASANA_RESOURCE_FETCHERS,
  COMPOSIO_BACKEND_BASE_URL,
  type ComposioFetcher,
  SLACK_USER_FETCHER,
} from "./composioConfig";
import {
  action,
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import {
  SYNTHESIS_CLAIM_STALE_MS,
  SYNTHESIS_OUTPUT_SCHEMA,
  classifyAnthropicRetry,
  dedupeEvidenceEntries,
  isFatalAnthropicError,
  recordKnowledgePageEvidence,
  slugify,
  withRetriableCall,
} from "./knowledge";
import { classifyEvent, coalesceKeyFor, TIER_RANK } from "./classifyEvent";
import {
  applyKnowledgePagePatch,
  boundKnowledgePageEvidenceTimeline,
  boundSessionEventIds,
  insertPageVersion,
  type KnowledgePageState,
} from "./knowledgePageVersions";
import { validateMcpPushPayload } from "./mcpPushContract";

type OrgId = Id<"orgs">;
type RunQueryContext = {
  runQuery: any;
};
type RunMutationContext = {
  runMutation: any;
};
type RunActionContext = {
  runAction: any;
};
type RunSchedulerContext = {
  scheduler: {
    runAfter: any;
  };
};
type SessionStatus = "active" | "complete";
type ThreadPurpose = "chat" | "pulse";
type ChatDimension = "actor" | "source";
type ChatStatMetric =
  | "events_this_week"
  | "sessions_this_week"
  | "active_sessions"
  | "total_events";
type KnowledgeConfidence = "high" | "medium" | "low";
type SynthesisPeriod = "daily" | "weekly" | "monthly";
type SynthesisFailureKind =
  | "fatal"
  | "transient_exhausted"
  | "unexpected"
  | "dependency_wait";
type SynthesisInputPage = {
  _id: Id<"knowledgePages">;
  title: string;
  slug: string;
  type: Doc<"knowledgePages">["type"];
  compiledTruth: string;
  updatedAt: number;
  tags: string[];
  confidence: Doc<"knowledgePages">["confidence"];
  lastConfirmed: number;
  evidenceTimeline: Array<{
    source: string;
    channel: string;
    timestamp: number;
    content: string;
  }>;
  entity?: string;
  owner?: string;
  targetDate?: number;
  goalStatus?: NonNullable<Doc<"knowledgePages">["goalStatus"]>;
  severity?: NonNullable<Doc<"knowledgePages">["severity"]>;
  findingType?: NonNullable<Doc<"knowledgePages">["findingType"]>;
  findingStatus?: NonNullable<Doc<"knowledgePages">["findingStatus"]>;
  implication?: string;
  sourceAgent?: string;
  actor?: string;
  repo?: string;
  sessionStartTime?: number;
  sessionEndTime?: number;
  eventCount?: number;
  workType?: string;
  complexity?: NonNullable<Doc<"knowledgePages">["complexity"]>;
  skills?: string[];
};
type SynthesisInputSynthesis = {
  _id: Id<"syntheses">;
  period: SynthesisPeriod;
  timestamp: number;
  windowEnd: number;
  summary: string;
  actors: string[];
  repos: string[];
  sourcePageIds: Id<"knowledgePages">[];
  sourceSynthesisIds: Id<"syntheses">[];
  updatedAt: number;
  completedAt: number | null;
  warnings: string[];
};
type SynthesisInputs = {
  orgId: Id<"orgs">;
  period: SynthesisPeriod;
  timestamp: number;
  windowEnd: number;
  sessionPages: SynthesisInputPage[];
  updatedPages: SynthesisInputPage[];
  goalPages: SynthesisInputPage[];
  findingPages: SynthesisInputPage[];
  lowerSyntheses: SynthesisInputSynthesis[];
};
type ThreadOrgMappingResult = {
  threadOrgId: Id<"threadOrgs">;
  threadId: string;
  purpose: ThreadPurpose;
  reused: boolean;
};
type ThreadListItem = {
  threadOrgId: Id<"threadOrgs">;
  threadId: string;
  purpose: ThreadPurpose;
  createdAt: number;
  lastVisitAt?: number;
  // First user message of the thread — a recognizable label for the history list.
  preview?: string;
};
type ThreadAccess = {
  orgId: OrgId;
  userId: string;
  threadOrg: Doc<"threadOrgs">;
};
type ChartBucketDatum = {
  category: string;
  value: number;
  percentage?: number;
};
type ChartTrendDatum = {
  date: string;
  value: number;
};
type ChartWidget = {
  chartType: "bar" | "line" | "pie";
  title: string;
  xLabel?: string;
  yLabel?: string;
  total?: number;
  // True when the underlying scan hit CHAT_EVENT_SCAN_LIMIT, so the chart only
  // reflects the most-recent N events (not the whole window). Surfaced so the
  // UI and the model can disclose the cap instead of presenting it as complete.
  truncated?: boolean;
  data: Array<ChartBucketDatum | ChartTrendDatum>;
};
type StatWidget = {
  widgetType: "stat";
  label: string;
  value: number;
  context?: string;
};
type ChatSessionListItem = {
  id: string;
  title: string;
  actor: string;
  project: string;
  date: string;
  eventCount: number;
  summary: string;
};
type SessionListWidget = {
  widgetType: "sessionList";
  title: string;
  total: number;
  sessions: ChatSessionListItem[];
};
type SynthesisFanOutState = {
  orgId: Id<"orgs">;
  period: SynthesisPeriod;
  timestamp: number;
  windowEnd: number;
  targetStatus: Doc<"syntheses">["status"] | null;
  hasRelevantKnowledge: boolean;
  lastRelevantAt: number | null;
  counts: {
    sessionPages: number;
    updatedPages: number;
    lowerSyntheses: number;
  };
};
type SynthesisDependencyReadiness = {
  ready: boolean;
  period: SynthesisPeriod;
  lowerPeriod: SynthesisPeriod | null;
  expectedCount: number;
  completedCount: number;
  missing: Array<{ period: SynthesisPeriod; timestamp: number; windowEnd: number }>;
  inProgress: Array<{
    synthesisId: Id<"syntheses">;
    timestamp: number;
    windowEnd: number;
  }>;
  retryableFailed: Array<{
    synthesisId: Id<"syntheses">;
    timestamp: number;
    windowEnd: number;
    nextRetryAt?: number | null;
  }>;
  terminalFailed: Array<{
    synthesisId: Id<"syntheses">;
    timestamp: number;
    windowEnd: number;
    error?: string;
  }>;
  nextRetryAt?: number | null;
};
type SynthesisRunSummary = {
  _id: Id<"syntheses">;
  orgId: Id<"orgs">;
  period: SynthesisPeriod;
  timestamp: number;
  windowEnd: number;
  status: Doc<"syntheses">["status"];
  claimedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  failureKind?: SynthesisFailureKind;
  retryCount?: number;
  nextRetryAt?: number | null;
  terminalFailure?: boolean;
};
type SynthesisEvidencePack = {
  prompt: string;
  actors: string[];
  repos: string[];
  sourcePageIds: Id<"knowledgePages">[];
  sourceSynthesisIds: Id<"syntheses">[];
  warnings: string[];
  estimatedInputTokens: number;
};
type SynthesisActionResult = {
  status:
    | "completed"
    | "completed_no_activity"
    | "failed"
    | "skipped_missing"
    | "skipped_terminal"
    | "skipped_not_in_progress"
    | "skipped_stale_claim";
  synthesisId: Id<"syntheses">;
  orgId?: OrgId;
  period?: SynthesisPeriod;
  durationMs: number;
  attempts?: number;
  warnings?: string[];
  error?: string;
};
type LinterCandidatePage = {
  _id: Id<"knowledgePages">;
  knowledgeBaseId: Id<"knowledgeBases">;
  type: Doc<"knowledgePages">["type"];
  title: string;
  slug: string;
  tags: string[];
  confidence: Doc<"knowledgePages">["confidence"];
  lastConfirmed: number;
  sourceCount: number;
  createdAt: number;
  updatedAt: number;
  inboundReferenceCount: number;
  attributionCount: number;
};
type LinterCandidateResult = {
  pages: LinterCandidatePage[];
  nextCursor: string | null;
  isDone: boolean;
  scannedCount: number;
};
type DeterministicLinterFindingInput = {
  slug: string;
  title: string;
  compiledTruth: string;
  evidenceTimeline: Array<{
    source: string;
    channel: string;
    timestamp: number;
    content: string;
  }>;
  tags: string[];
  confidence: "high" | "medium" | "low";
  severity: NonNullable<Doc<"knowledgePages">["severity"]>;
  findingType: NonNullable<Doc<"knowledgePages">["findingType"]>;
  implication: string;
  relatedPageIds: Id<"knowledgePages">[];
};
type ContradictionCandidatePage = {
  _id: Id<"knowledgePages">;
  slug: string;
  title: string;
  type: Doc<"knowledgePages">["type"];
  compiledTruth: string;
  tags: string[];
  confidence: Doc<"knowledgePages">["confidence"];
  lastConfirmed: number;
  updatedAt: number;
  entity?: string;
  evidenceTimeline: Array<{
    source: string;
    channel: string;
    timestamp: number;
    content: string;
  }>;
};
type ContradictionCandidatePair = {
  pairKey: string;
  sourcePairKey: string;
  left: ContradictionCandidatePage;
  right: ContradictionCandidatePage;
  overlapReason: string;
};
type AiContradictionFindingInput = DeterministicLinterFindingInput & {
  pairKey: string;
};
type AiContradictionStatus =
  | "succeeded"
  | "failed"
  | "skipped_no_candidates"
  | "skipped_continuation";
type RunLinterForOrgResult = {
  orgId: OrgId;
  candidateBatchDone: boolean;
  candidateScannedCount: number;
  scheduledContinuation: boolean;
  continueCursor: string | null;
  staleDecision: number;
  orphanPage: number;
  weakProvenance: number;
  activeSlugs: string[];
  resolvedCount: number;
  resolvedSlugs: string[];
  contradictionStatus: AiContradictionStatus;
  contradiction: number;
  contradictionCandidatePairs: number;
  contradictionActiveSlugs: string[];
  contradictionResolvedCount: number;
  contradictionResolvedSlugs: string[];
  contradictionWarnings: string[];
  contradictionError?: string;
  durationMs: number;
};

type SessionEnrichment = {
  compiledTruth: string;
  title: string;
  tags: string[];
  workType: string;
  complexity?: "low" | "moderate" | "high";
  skills?: string[];
  confidence: KnowledgeConfidence;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  providerMetadata: {
    anthropic: {
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    };
  };
};

export type AuthLookupContext = {
  auth: {
    getUserIdentity: () => Promise<unknown | null>;
  };
  db?: QueryCtx["db"];
  runQuery?: ActionCtx["runQuery"];
};

type EventCluster = {
  actor: string;
  actorEntityId?: Id<"entities">;
  repo?: string;
  repoNames: string[];
  startTime: number;
  endTime?: number;
  status: SessionStatus;
  events: Doc<"events">[];
};
type SessionEvidenceEntry = {
  source: string;
  channel: string;
  timestamp: number;
  content: string;
};

type ManagedAgentUsage = {
  inputTokens: number;
  outputTokens: number;
};

type ManagedAgentResult = {
  output: string;
  usage: ManagedAgentUsage;
};

type ManagedAgentToolDefinition =
  | BetaManagedAgentsAgentToolset20260401Params
  | BetaManagedAgentsMCPToolsetParams;

type ManagedAgentMcpServer = BetaManagedAgentsURLMCPServerParams;

type ManagedToolsetBundle = {
  tools: ManagedAgentToolDefinition[];
  mcp_servers: ManagedAgentMcpServer[];
};

type ComposioSessionMcp = {
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
};

type ManagedMcpVaultAttachment = {
  vaultId: string;
  credentialId?: string;
};

type ManagedMcpPurpose = "customer-agent" | "dream-cycle";

type ManagedMcpPayload = {
  orgId: string;
  purpose: ManagedMcpPurpose;
  exp: number;
  jti: string;
};
type McpToolClass = "read" | "write" | "ask";

const SESSION_GAP_MS = 30 * 60 * 1000;
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const CLAIM_BATCH_SIZE = 100;
const STALE_ACTIVE_SESSION_CLOSE_BATCH_SIZE = 20;
const THREADS_FOR_USER_DEFAULT_PAGE_SIZE = 25;
const THREADS_FOR_USER_MAX_PAGE_SIZE = 100;
const CHAT_EVENT_SCAN_LIMIT = 5000;
const CHAT_SESSION_SCAN_LIMIT = 5000;
const CHAT_BUCKET_LIMIT = 12;
const CHAT_SPLIT_LIMIT = 8;
const CHAT_DEFAULT_SINCE_DAYS = 30;
const CHAT_DEFAULT_TREND_DAYS = 14;
const CHAT_DEFAULT_SESSION_LIMIT = 8;
const CHAT_MAX_SESSION_LIMIT = 20;
const SESSION_EVENT_RAW_MAX_CHARS = 2000;
const MCP_RATE_LIMIT_WINDOW_MS = 60_000;
const MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE = 100;
const IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MCP_RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MCP_API_KEY_LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;
const MCP_RATE_LIMITS: Record<McpToolClass, number> = {
  read: 600,
  write: 60,
  ask: 10,
};
const MCP_TOOL_CLASS_VALIDATOR = v.union(
  v.literal("read"),
  v.literal("write"),
  v.literal("ask"),
);
const MANAGED_MCP_PURPOSE_VALIDATOR = v.union(
  v.literal("customer-agent"),
  v.literal("dream-cycle"),
);
const EVENT_VIA_VALIDATOR = v.union(
  v.literal("webhook"),
  v.literal("composio"),
  v.literal("api"),
);
const MCP_AUTH_RETURN_VALIDATOR = v.object({
  orgId: v.id("orgs"),
  apiKeyId: v.id("apiKeys"),
});
const MCP_RATE_LIMIT_RETURN_VALIDATOR = v.object({
  allowed: v.boolean(),
  limit: v.number(),
  remaining: v.number(),
  resetAt: v.number(),
  retryAfterMs: v.number(),
  bucket: v.string(),
  count: v.number(),
});
const DELETED_COUNT_RETURN_VALIDATOR = v.object({
  deleted: v.number(),
});
// Authoritative workType enum. Referenced by prompt + normalizer.
// Update this array only; prompt rebuilds from it at module load.
const SESSION_WORK_TYPE_VALUES = [
  "feature",
  "bugfix",
  "refactor",
  "migration",
  "infrastructure",
  "investigation",
  "review",
  "other",
] as const;
const SESSION_WORK_TYPE_SET = new Set<string>(SESSION_WORK_TYPE_VALUES);
const SESSION_ENRICHMENT_SYSTEM_PROMPT = [
  "You are the Spark Extractor. You write knowledge pages about work sessions for an AI system that understands organizations.",
  "",
  "Given a bounded cluster of work events by one person, write a knowledge page that captures:",
  "- What happened in this session (narrative, not a list)",
  "- What decisions were made and why (if visible)",
  "- What patterns this session reveals about the person's work style",
  "- What skills and technologies were involved",
  "- How this work connects to broader projects or goals (if inferrable)",
  "",
  "Write in concise, concrete prose. Use markdown headers, links, and formatting naturally. This page will be read by AI agents and humans browsing a knowledge wiki.",
  "Use [[entity-name]] markdown syntax when referencing people, projects, repos, or other entities. For example: [[Maya Chen]], [[acme/web-app]], [[auth-migration]]. These wikilinks will be resolved into cross-references later. Write them as raw text; do not try to resolve them.",
  "",
  "After the document, output a JSON block with structured tags:",
  "```json",
  '{',
  '  "title": "short session title",',
  '  "workType": "feature",',
  '  "complexity": "moderate",',
  '  "skills": ["auth", "react"],',
  '  "tags": ["workType:feature", "complexity:moderate", "skill:auth", "skill:react"],',
  '  "confidence": "high"',
  "}",
  "```",
  "",
  "Rules:",
  "- The document comes first, the JSON block comes last (fenced in ```json)",
  "- workType, complexity, and skills are durable typed fields; include them explicitly in the JSON block",
  "- Tags use namespaced prefixes: workType:{value}, complexity:{low|moderate|high}, skill:{value}",
  `- workType must be one of: ${SESSION_WORK_TYPE_VALUES.join(", ")}`,
  "- complexity must be one of: low, moderate, high",
  "- skills must be short lowercase skill or technology names",
  "- Do not include actor or repo in tags; those are stored in structural fields",
  "- confidence is your assessment of how well you understood the session: high (clear picture), medium (some gaps), low (sparse events)",
  "- Only assert what the events directly support. Do not speculate.",
  "- For Asana events, preserve actor roles exactly as written. A task assignee, project member, trigger subscriber, or fallback actor is not the task creator/updater unless the event summary or raw payload explicitly says so.",
  "- When the actor behind an event is not verifiable, state the event plainly with no actor (e.g. \"Task X was completed\"). Do NOT narrate the gap — never write that an actor is unverified/unverifiable/\"could not be verified\", or that payload fields (created_by, completed_by, etc.) are null or missing. Describe what happened, not what the data lacks.",
  "- Title the session by the WORK itself — the task/project name and what changed (e.g. \"Starter bundle pricing updates\" or \"Asana task created in Q3 Launch Plan\"). NEVER prefix a title with \"Unattributed\" or otherwise flag a missing/unknown/unverifiable actor in the title; if the actor is unknown, simply title the work with no name.",
  "- For task-move events where the destination section/stage is not named, say only that the task moved to an unspecified section or workflow stage. Do NOT invent likely destinations such as In Progress, Review, Done, or similar workflow states.",
  "- Append source attribution: [Source: {actor}, {source channel}, {date} {time} PT]",
  "- If events are administrative (branch cleanup, renames, rebases, naming discussions), automated (bot-generated, scheduled dependency bumps, routine CI), or span unrelated topics, say so plainly. Use workType:infrastructure or workType:other for admin/bot work. Use complexity:low for routine maintenance.",
  "- Do NOT infer strategic intent, product direction, or team priorities unless events directly support it. If a session is just mechanical cleanup or automated noise, the page should be short and honest - not dressed up as meaningful engineering work.",
].join("\n");
const MODEL_RATES_CENTS_PER_MILLION: Record<
  string,
  {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  }
> = {
  "claude-opus-4-6": {
    input: 1500,
    output: 7500,
    cacheRead: 150,
    cacheCreation: 1875,
  },
  "claude-sonnet-4-6": {
    input: 300,
    output: 1500,
    cacheRead: 30,
    cacheCreation: 375,
  },
};
const anthropicClient = new Anthropic();
const SYNTHESIS_MODEL = "claude-sonnet-4-6";
const SYNTHESIS_INPUT_LIMIT = 12;
const SYNTHESIS_SWEEP_LIMIT = 100;
const SYNTHESIS_MAX_OUTPUT_TOKENS = 1600;
const SYNTHESIS_EVIDENCE_TOKEN_BUDGET = 8000;
const SYNTHESIS_TEXT_SECTION_CHAR_LIMIT = 900;
const SYNTHESIS_EVIDENCE_CHAR_LIMIT = 220;
const SYNTHESIS_CACHE_CONTROL = {
  type: "ephemeral" as const,
  ttl: "1h" as const,
};
const SYNTHESIS_USER_STABLE_PREFIX = [
  "Evidence pack format:",
  "- Each section groups source pages or lower-period syntheses.",
  "- Treat Compiled Truth as the current best statement and evidence snippets as provenance anchors.",
  "- Compress cross-source themes instead of repeating every item.",
  "- Stay inside the evidence pack. If support is weak or conflicting, say so plainly.",
].join("\n");
const SYNTHESIS_SYSTEM_PROMPT = [
  "You are the Spark Synthesizer. Spark is an AI that understands a company.",
  "Write an intelligence briefing, not a dashboard, activity feed, or standup note.",
  "The output must compress time for a leadership reader: what changed, why it matters, and what signals to watch.",
  "Work from bounded evidence only. Do not speculate or invent causality beyond what the evidence supports.",
  "Prefer concrete organizational intelligence over vanity metrics or task narration.",
  "Preserve the product voice: concise, concrete, current, evidence-grounded, and useful for decision making.",
  "When the evidence only supports maintenance or cleanup work, say that directly instead of dressing it up as strategy.",
  "If decisions, risks, or capabilities recur across sources, connect them explicitly.",
  "Return markdown in `summary` with exactly these headings in this order:",
  "## What Changed",
  "## Why It Matters",
  "## Signals To Watch",
  "Keep `actors` and `repos` as short deduplicated arrays of names that appear in the evidence.",
  "Do not include citations inline. The source ids are stored separately by the system.",
].join("\n");
const SYNTHESIS_SECTION_LIMITS = {
  sessionPages: 6,
  updatedPages: 6,
  goalPages: 4,
  findingPages: 4,
  lowerSyntheses: 4,
} as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const LINTER_STALE_DECISION_MS = 30 * DAY_MS;
const LINTER_HIGH_SEVERITY_MS = 90 * DAY_MS;
const LINTER_GRACE_MS = DAY_MS;
const LINTER_CANDIDATE_BATCH_SIZE = 200;
const LINTER_OBSOLETE_FINDING_BATCH_SIZE = 200;
const LINTER_DETERMINISTIC_TAGS = ["lint:deterministic"] as const;
const LINTER_AI_CONTRADICTION_TAGS = [
  "lint:ai",
  "lint:contradiction",
] as const;
const LINTER_CONTRADICTION_MODEL = SYNTHESIS_MODEL;
const LINTER_CONTRADICTION_PAGE_LIMIT = 24;
const LINTER_CONTRADICTION_PAIR_LIMIT = 48;
const LINTER_CONTRADICTION_OUTPUT_LIMIT = 6;
const LINTER_CONTRADICTION_MAX_OUTPUT_TOKENS = 1800;
const LINTER_CONTRADICTION_EVIDENCE_TOKEN_BUDGET = 6500;
const LINTER_CONTRADICTION_TEXT_CHAR_LIMIT = 700;
const LINTER_CONTRADICTION_EVIDENCE_CHAR_LIMIT = 180;
const LINTER_CONTRADICTION_ERROR_TAIL_CHARS = 500;
const LINTER_CONTRADICTION_CACHE_CONTROL = {
  type: "ephemeral" as const,
  ttl: "1h" as const,
};
const CONTRADICTION_LINTER_OUTPUT_SCHEMA = z4.object({
  contradictions: z4
    .array(
      z4.object({
        pairKey: z4.string(),
        severity: z4.enum(["high", "medium", "low"]),
        confidence: z4.enum(["high", "medium", "low"]),
        title: z4.string(),
        claim: z4.string(),
        leftAssertion: z4.string(),
        rightAssertion: z4.string(),
        incompatibility: z4.string(),
        implication: z4.string(),
        sameScope: z4.boolean(),
        sameScopeReason: z4.string(),
        currentConflict: z4.boolean(),
        canBothBeTrue: z4.boolean(),
        isStaleOrSuperseded: z4.boolean(),
        isHistoricalTransition: z4.boolean(),
        isMereDetailDifference: z4.boolean(),
        isWeakProvenanceOnly: z4.boolean(),
        notStaleOrSupersededReason: z4.string(),
        evidence: z4.array(z4.string()).min(2).max(4),
      }),
    )
    .max(LINTER_CONTRADICTION_OUTPUT_LIMIT),
  warnings: z4.array(z4.string()).optional(),
});
type ContradictionLinterOutput = z4.infer<typeof CONTRADICTION_LINTER_OUTPUT_SCHEMA>;
const CONTRADICTION_LINTER_SYSTEM_PROMPT = [
  "You are the Spark Knowledge Linter. Your only job is conservative contradiction adjudication.",
  "Create a contradiction only when both pages assert incompatible current truths that cannot both be true in the same entity, time, and rollout scope right now.",
  "Reject mere topic overlap, stale knowledge, likely supersession, weak provenance, added detail, historical transitions, and different scopes that can both be true.",
  "Only return a contradiction when you can explicitly supply leftAssertion, rightAssertion, incompatibility, sameScope=true, currentConflict=true, canBothBeTrue=false, and concrete reasons for shared scope and non-staleness.",
  "For every returned contradiction, isStaleOrSuperseded, isHistoricalTransition, isMereDetailDifference, and isWeakProvenanceOnly must all be false.",
  "Prefer no finding over a noisy finding. If uncertain, return no contradiction.",
  "Every contradiction must cite both page slugs or titles in evidence and explain the business implication.",
].join("\n");
const CONTRADICTION_LINTER_USER_STABLE_PREFIX = [
  "Evidence pack format:",
  "- Each candidate pair has a stable pairKey and two active knowledge pages.",
  "- Treat Compiled Truth as the current best statement for that page.",
  "- Evidence snippets are provenance anchors, not extra license to infer beyond the page.",
  "- Return only pairKeys from the evidence pack.",
  "- Do not invent pages, slugs, facts, or missing context.",
  "- Omit any contradiction if you cannot prove same-scope current incompatibility from the cited pages alone.",
  "- sameScope=true only when the pages address the same entity, timeframe, and rollout or audience scope.",
  "- currentConflict=true only when leftAssertion and rightAssertion cannot both be true now.",
  "- canBothBeTrue must be false for every returned contradiction.",
  "- isStaleOrSuperseded, isHistoricalTransition, isMereDetailDifference, and isWeakProvenanceOnly must all be false for every returned contradiction.",
  "- evidence must have at least two entries and must cite both page slugs or titles; do not rely on uncited inference.",
].join("\n");
const ORG_FANOUT_PAGE_SIZE = 100;

const listOrgIdsPageRef = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  PaginationResult<OrgId>
>("spark:listOrgIdsPage");
const claimSynthesisRunRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    period: SynthesisPeriod;
    timestamp: number;
    windowEnd: number;
    now?: number;
  },
  {
    status:
      | "claimed"
      | "skipped_completed"
      | "skipped_terminal_failed"
      | "skipped_fresh_in_progress"
      | "reclaimed_stale"
      | "reclaimed_failed";
    synthesisId: Id<"syntheses">;
  }
>("knowledge:claimSynthesisRun");
const getSynthesisRunByIdRef = makeFunctionReference<
  "query",
  { synthesisId: Id<"syntheses"> },
  Doc<"syntheses"> | null
>("knowledge:getSynthesisRunById");
const getSynthesisInputsRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    period: SynthesisPeriod;
    timestamp: number;
    windowEnd: number;
    limit?: number;
  },
  SynthesisInputs
>("knowledge:getSynthesisInputs");
const finalizeSynthesisRunRef = makeFunctionReference<
  "mutation",
  {
    synthesisId: Id<"syntheses">;
    summary: string;
    actors: string[];
    repos: string[];
    sourcePageIds: Id<"knowledgePages">[];
    sourceSynthesisIds: Id<"syntheses">[];
    inputTokensCached?: number;
    inputTokensUncached?: number;
    outputTokens?: number;
    warnings?: string[];
    expectedClaimedAt?: number;
  },
  {
    status: "completed" | "skipped_stale_claim";
    synthesisId: Id<"syntheses">;
    idempotent?: boolean;
    expectedClaimedAt?: number;
    currentClaimedAt?: number | null;
    currentStatus?: Doc<"syntheses">["status"];
  }
>("knowledge:finalizeSynthesisRun");
const markSynthesisFailedRef = makeFunctionReference<
  "mutation",
  {
    synthesisId: Id<"syntheses">;
    error: string;
    failureKind?: SynthesisFailureKind;
    now?: number;
    nextRetryAt?: number;
    expectedClaimedAt?: number;
  },
  {
    status: "failed" | "skipped_completed" | "skipped_stale_claim";
    synthesisId: Id<"syntheses">;
    error?: string;
    failureKind?: SynthesisFailureKind;
    retryCount?: number;
    nextRetryAt?: number;
    terminalFailure?: boolean;
    expectedClaimedAt?: number;
    currentClaimedAt?: number | null;
    currentStatus?: Doc<"syntheses">["status"];
  }
>("knowledge:markSynthesisFailed");
const findStaleSynthesisRunsRef = makeFunctionReference<
  "query",
  {
    staleBefore: number;
    limit?: number;
  },
  SynthesisRunSummary[]
>("knowledge:findStaleSynthesisRuns");
const findRecoverableFailedSynthesisRunsRef = makeFunctionReference<
  "query",
  {
    now: number;
    limit?: number;
  },
  SynthesisRunSummary[]
>("knowledge:findRecoverableFailedSynthesisRuns");
const getSynthesisFanOutStateRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    period: SynthesisPeriod;
    timestamp: number;
    windowEnd: number;
  },
  SynthesisFanOutState
>("knowledge:getSynthesisFanOutState");
const getSynthesisDependencyReadinessRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    period: SynthesisPeriod;
    timestamp: number;
    windowEnd: number;
  },
  SynthesisDependencyReadiness
>("knowledge:getSynthesisDependencyReadiness");
const listLinterCandidatesRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    staleBefore: number;
    orphanGraceBefore: number;
    weakProvenanceGraceBefore: number;
    limit?: number;
    cursor?: string;
  },
  LinterCandidateResult
>("knowledge:listLinterCandidates");
const listContradictionCandidatePairsRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    pageLimit?: number;
    pairLimit?: number;
  },
  { pairs: ContradictionCandidatePair[] }
>("knowledge:listContradictionCandidatePairs");
const upsertLinterFindingRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    slug: string;
    title: string;
    compiledTruth: string;
    evidenceTimeline: Array<{
      source: string;
      channel: string;
      timestamp: number;
      content: string;
    }>;
    tags: string[];
    confidence: "high" | "medium" | "low";
    severity: "high" | "medium" | "low";
    findingType:
      | "contradiction"
      | "strategic_gap"
      | "resource_drift"
      | "emerging_capability"
      | "stale_decision"
      | "unanswered_question"
      | "blind_spot";
    implication: string;
    relatedPageIds: Id<"knowledgePages">[];
    sourceAgent?: "linter" | "dream-cycle";
  },
  {
    findingId: Id<"knowledgePages">;
    slug: string;
    inserted: boolean;
    findingStatus:
      | "new"
      | "acknowledged"
      | "investigating"
      | "resolved"
      | "dismissed";
  }
>("knowledge:upsertLinterFinding");
const resolveObsoleteLinterFindingsRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    activeSlugs: string[];
    managedTags: string[];
    managedSlugs?: string[];
    managedSourcePairKeys?: string[];
    limit?: number;
  },
  {
    resolvedCount: number;
    resolvedSlugs: string[];
  }
>("knowledge:resolveObsoleteLinterFindings");
const runSynthesisActionRef = makeFunctionReference<
  "action",
  { synthesisId: Id<"syntheses"> },
  SynthesisActionResult
>("spark:runSynthesisAction");
const runLinterForOrgRef = makeFunctionReference<
  "action",
  {
    orgId: Id<"orgs">;
    now?: number;
    candidateCursor?: string;
    activeSlugs?: string[];
  },
  RunLinterForOrgResult
>("spark:runLinterForOrg");
const insertThreadOrgRef = makeFunctionReference<
  "mutation",
  {
    threadId: string;
    orgId: Id<"orgs">;
    userId: string;
    purpose: ThreadPurpose;
  },
  ThreadOrgMappingResult
>("spark:insertThreadOrg");

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function getString(value: unknown, key: string): string | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }
  const candidate = record[key];
  return typeof candidate === "string" ? candidate : null;
}

function getNumber(value: unknown, key: string): number | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }
  const candidate = record[key];
  return typeof candidate === "number" ? candidate : null;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

// Email is the strongest cross-source identity key, so it must be matched
// case-insensitively: always store and compare it lowercased. (Plain
// normalizeOptionalString only trims, which split case-variant emails like
// "Jane@Co.com" vs "jane@co.com" into separate entities and missed the
// by_org_email index.)
function normalizeEmail(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function getNestedNumber(value: unknown, path: string[]): number {
  let current: unknown = value;
  for (const key of path) {
    const record = getRecord(current);
    if (!record || !(key in record)) {
      return 0;
    }
    current = record[key];
  }
  return typeof current === "number" ? current : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dedupeSortedStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim() ?? "")
        .filter((value) => value.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function dedupeSortedIds<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  ) as T[];
}

function dedupeStringsPreserveOrder(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function clipSynthesisText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

// Hoisted: getEncoding("cl100k_base") builds the full BPE table (~80ms). The
// linter's trim loop calls the estimator up to ~48 times per run; constructing
// the encoder per call burned ~4s of cron action time for zero benefit.
let synthesisTokenEncoding: ReturnType<typeof getEncoding> | null = null;

function estimateSynthesisTokens(text: string): number {
  try {
    synthesisTokenEncoding ??= getEncoding("cl100k_base");
    return synthesisTokenEncoding.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function formatUtc(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function buildStaleDecisionFinding(
  page: LinterCandidatePage,
  now: number,
): DeterministicLinterFindingInput {
  const daysSinceConfirmed = Math.max(
    0,
    Math.floor((now - page.lastConfirmed) / DAY_MS),
  );
  const severity =
    now - page.lastConfirmed > LINTER_HIGH_SEVERITY_MS ? "high" : "medium";
  return {
    slug: `finding-linter-stale-decision-${page.slug}`,
    title: `Stale decision: ${page.title}`,
    compiledTruth:
      `The active decision "${page.title}" has not been reconfirmed since ` +
      `${formatUtc(page.lastConfirmed)} and is now ${daysSinceConfirmed} days old. ` +
      "Reconfirm, update, or archive it before it keeps shaping current work.",
    evidenceTimeline: [
      {
        source: page.title,
        channel: "knowledge",
        timestamp: page.lastConfirmed,
        content:
          `Decision last confirmed at ${formatUtc(page.lastConfirmed)}; ` +
          "the deterministic stale-decision threshold is 30 days.",
      },
    ],
    tags: ["lint:deterministic", "lint:stale_decision"],
    confidence: "high",
    severity,
    findingType: "stale_decision",
    implication:
      "Teams may still be relying on a decision that no longer matches current operating reality.",
    relatedPageIds: [page._id],
  };
}

function getContradictionFindingSlug(pairKey: string): string {
  return `finding-linter-contradiction-${pairKey}`;
}

function getTernaryRank(value: "high" | "medium" | "low"): number {
  if (value === "high") {
    return 0;
  }
  if (value === "medium") {
    return 1;
  }
  return 2;
}

const CONTRADICTION_PLACEHOLDER_TEXT = new Set([
  "n/a",
  "na",
  "none",
  "not provided",
  "same as above",
  "see above",
  "unknown",
  "unclear",
]);

function hasMeaningfulContradictionText(
  value: string,
  minChars: number = 12,
): boolean {
  const trimmed = value.trim();
  if (trimmed.length < minChars) {
    return false;
  }
  return !CONTRADICTION_PLACEHOLDER_TEXT.has(trimmed.toLowerCase());
}

function getContradictionScopeTags(page: ContradictionCandidatePage): string[] {
  return dedupeSortedStrings(
    page.tags
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.startsWith("scope:")),
  );
}

function pairHasExplicitScopeMismatch(pair: ContradictionCandidatePair): boolean {
  const leftScopes = getContradictionScopeTags(pair.left);
  const rightScopes = getContradictionScopeTags(pair.right);
  if (leftScopes.length === 0 || rightScopes.length === 0) {
    return false;
  }
  return !leftScopes.some((scope) => rightScopes.includes(scope));
}

type ContradictionEvidenceQuality = "high" | "medium" | "low";

function getContradictionEvidenceQuality(args: {
  evidence: readonly string[];
  leftAssertion: string;
  rightAssertion: string;
  incompatibility: string;
  sameScopeReason: string;
  notStaleOrSupersededReason: string;
}): ContradictionEvidenceQuality {
  const structuredFields = [
    args.leftAssertion,
    args.rightAssertion,
    args.incompatibility,
    args.sameScopeReason,
    args.notStaleOrSupersededReason,
  ];
  if (
    args.evidence.length >= 2 &&
    structuredFields.every((field) => field.trim().length >= 24)
  ) {
    return "high";
  }
  if (
    args.evidence.length >= 2 &&
    structuredFields.every((field) => field.trim().length >= 12)
  ) {
    return "medium";
  }
  return "low";
}

function capContradictionConfidence(
  modelConfidence: KnowledgeConfidence,
  pair: ContradictionCandidatePair,
  evidenceQuality: ContradictionEvidenceQuality,
): KnowledgeConfidence {
  const cappedRank = Math.max(
    getTernaryRank(modelConfidence),
    getTernaryRank(pair.left.confidence),
    getTernaryRank(pair.right.confidence),
    getTernaryRank(evidenceQuality),
  );
  if (cappedRank === 0) {
    return "high";
  }
  if (cappedRank === 1) {
    return "medium";
  }
  return "low";
}

function capContradictionSeverity(
  modelSeverity: NonNullable<Doc<"knowledgePages">["severity"]>,
  confidence: KnowledgeConfidence,
  evidenceQuality: ContradictionEvidenceQuality,
): NonNullable<Doc<"knowledgePages">["severity"]> {
  const cappedRank = Math.max(
    getTernaryRank(modelSeverity),
    getTernaryRank(confidence),
    getTernaryRank(evidenceQuality),
  );
  if (cappedRank === 0) {
    return "high";
  }
  if (cappedRank === 1) {
    return "medium";
  }
  return "low";
}

function formatContradictionEvidenceEntries(
  entries: ContradictionCandidatePage["evidenceTimeline"],
): string[] {
  if (entries.length === 0) {
    return ["- Evidence: none preserved on the page"];
  }

  return entries.map(
    (entry) =>
      `- Evidence (${formatUtc(entry.timestamp)} | ${entry.source} via ${entry.channel}): ${clipSynthesisText(
        entry.content,
        LINTER_CONTRADICTION_EVIDENCE_CHAR_LIMIT,
      )}`,
  );
}

function formatContradictionCandidatePage(
  label: "Left" | "Right",
  page: ContradictionCandidatePage,
): string {
  const context = [
    `${label}: ${page.title} (${page.slug})`,
    `type=${page.type}`,
    `confidence=${page.confidence}`,
    `lastConfirmed=${formatUtc(page.lastConfirmed)}`,
    `updatedAt=${formatUtc(page.updatedAt)}`,
  ];
  if (page.entity) {
    context.push(`entity=${page.entity}`);
  }

  return [
    context.join(" | "),
    `Tags: ${page.tags.join(", ") || "none"}`,
    "Compiled Truth:",
    clipSynthesisText(
      page.compiledTruth,
      LINTER_CONTRADICTION_TEXT_CHAR_LIMIT,
    ),
    ...formatContradictionEvidenceEntries(page.evidenceTimeline),
  ].join("\n");
}

function formatContradictionPair(pair: ContradictionCandidatePair): string {
  return [
    `## Pair ${pair.pairKey}`,
    `Overlap reason: ${pair.overlapReason}`,
    formatContradictionCandidatePage("Left", pair.left),
    formatContradictionCandidatePage("Right", pair.right),
  ].join("\n\n");
}

function buildContradictionEvidencePack(
  pairs: ContradictionCandidatePair[],
): {
  pairs: ContradictionCandidatePair[];
  prompt: string;
  warnings: string[];
  estimatedInputTokens: number;
  candidateFindingSlugs: string[];
  candidateSourcePairKeys: string[];
} {
  const warnings: string[] = [];
  let selected = pairs.slice(0, LINTER_CONTRADICTION_PAIR_LIMIT);
  if (pairs.length > selected.length) {
    warnings.push(
      `Trimmed contradiction candidate pairs from ${pairs.length} to ${selected.length}.`,
    );
  }

  while (true) {
    const prompt =
      selected.length === 0
        ? "## Candidate Pairs\n- none"
        : selected.map(formatContradictionPair).join("\n\n");
    const estimatedInputTokens = estimateSynthesisTokens(
      [
        CONTRADICTION_LINTER_SYSTEM_PROMPT,
        CONTRADICTION_LINTER_USER_STABLE_PREFIX,
        prompt,
      ].join("\n\n"),
    );
    if (
      estimatedInputTokens <= LINTER_CONTRADICTION_EVIDENCE_TOKEN_BUDGET ||
      selected.length <= 1
    ) {
      if (
        estimatedInputTokens > LINTER_CONTRADICTION_EVIDENCE_TOKEN_BUDGET &&
        selected.length <= 1
      ) {
        warnings.push(
          "Contradiction evidence pack remained above the target token budget with one candidate pair.",
        );
      }
      return {
        pairs: selected,
        prompt,
        warnings,
        estimatedInputTokens,
        candidateFindingSlugs: dedupeSortedStrings(
          selected.map((pair) => getContradictionFindingSlug(pair.pairKey)),
        ),
        candidateSourcePairKeys: dedupeSortedStrings(
          selected.map((pair) => pair.sourcePairKey),
        ),
      };
    }

    selected = selected.slice(0, -1);
    warnings.push("Budget trim removed one contradiction candidate pair.");
  }
}

function modelEvidenceCitesPage(
  evidence: readonly string[],
  page: ContradictionCandidatePage,
): boolean {
  const haystack = evidence.join("\n").toLowerCase();
  return (
    haystack.includes(page.slug.toLowerCase()) ||
    haystack.includes(page.title.toLowerCase())
  );
}

function buildAiContradictionFinding(args: {
  pair: ContradictionCandidatePair;
  title: string;
  claim: string;
  leftAssertion: string;
  rightAssertion: string;
  incompatibility: string;
  sameScopeReason: string;
  notStaleOrSupersededReason: string;
  implication: string;
  evidence: string[];
  confidence: KnowledgeConfidence;
  severity: NonNullable<Doc<"knowledgePages">["severity"]>;
}): AiContradictionFindingInput {
  const modelEvidence = args.evidence.map(
    (entry) => `- ${clipSynthesisText(entry, LINTER_CONTRADICTION_TEXT_CHAR_LIMIT)}`,
  );
  const leftStatement = clipSynthesisText(
    args.pair.left.compiledTruth,
    LINTER_CONTRADICTION_TEXT_CHAR_LIMIT,
  );
  const rightStatement = clipSynthesisText(
    args.pair.right.compiledTruth,
    LINTER_CONTRADICTION_TEXT_CHAR_LIMIT,
  );

  return {
    pairKey: args.pair.pairKey,
    slug: getContradictionFindingSlug(args.pair.pairKey),
    title: `Contradiction: ${clipSynthesisText(args.title, 90)}`,
    compiledTruth: [
      args.claim,
      "",
      `Left assertion (${args.pair.left.slug}): ${args.leftAssertion}`,
      `Right assertion (${args.pair.right.slug}): ${args.rightAssertion}`,
      `Why these cannot both be true now: ${args.incompatibility}`,
      `Shared scope: ${args.sameScopeReason}`,
      `Why this is not stale or superseded: ${args.notStaleOrSupersededReason}`,
      "",
      "Evidence cited by the AI contradiction linter:",
      ...modelEvidence,
      "",
      `Source page ${args.pair.left.slug} states: ${leftStatement}`,
      `Source page ${args.pair.right.slug} states: ${rightStatement}`,
    ].join("\n"),
    evidenceTimeline: [
      {
        source: args.pair.left.title,
        channel: "knowledge",
        timestamp: args.pair.left.updatedAt,
        content:
          `${args.pair.left.slug}: ${clipSynthesisText(
            args.pair.left.compiledTruth,
            LINTER_CONTRADICTION_EVIDENCE_CHAR_LIMIT,
          )}`,
      },
      {
        source: args.pair.right.title,
        channel: "knowledge",
        timestamp: args.pair.right.updatedAt,
        content:
          `${args.pair.right.slug}: ${clipSynthesisText(
            args.pair.right.compiledTruth,
            LINTER_CONTRADICTION_EVIDENCE_CHAR_LIMIT,
          )}`,
      },
    ],
    tags: [...LINTER_AI_CONTRADICTION_TAGS],
    confidence: args.confidence,
    severity: args.severity,
    findingType: "contradiction",
    implication: args.implication,
    relatedPageIds: [args.pair.left._id, args.pair.right._id],
  };
}

type NormalizedAiContradictionCandidate = {
  title: string;
  claim: string;
  leftAssertion: string;
  rightAssertion: string;
  incompatibility: string;
  sameScopeReason: string;
  notStaleOrSupersededReason: string;
  implication: string;
  evidence: string[];
  confidence: KnowledgeConfidence;
  severity: NonNullable<Doc<"knowledgePages">["severity"]>;
};

function normalizeAiContradictionCandidate(args: {
  rawContradiction: ContradictionLinterOutput["contradictions"][number];
  pair: ContradictionCandidatePair;
  warnings: string[];
}): NormalizedAiContradictionCandidate | null {
  const pairKey = args.pair.pairKey;
  const title = args.rawContradiction.title.trim();
  const claim = args.rawContradiction.claim.trim();
  const leftAssertion = args.rawContradiction.leftAssertion.trim();
  const rightAssertion = args.rawContradiction.rightAssertion.trim();
  const incompatibility = args.rawContradiction.incompatibility.trim();
  const sameScopeReason = args.rawContradiction.sameScopeReason.trim();
  const notStaleOrSupersededReason =
    args.rawContradiction.notStaleOrSupersededReason.trim();
  const implication = args.rawContradiction.implication.trim();
  const evidence = dedupeStringsPreserveOrder(args.rawContradiction.evidence).slice(
    0,
    4,
  );

  const requiredTextFields = [
    title,
    claim,
    leftAssertion,
    rightAssertion,
    incompatibility,
    sameScopeReason,
    notStaleOrSupersededReason,
    implication,
  ];
  if (!requiredTextFields.every((field) => hasMeaningfulContradictionText(field))) {
    args.warnings.push(
      `Dropped contradiction for ${pairKey}: missing required same-scope incompatibility detail.`,
    );
    return null;
  }

  if (evidence.length < 2) {
    args.warnings.push(
      `Dropped contradiction for ${pairKey}: evidence must include at least two cited entries.`,
    );
    return null;
  }

  if (
    !args.rawContradiction.sameScope ||
    !args.rawContradiction.currentConflict ||
    args.rawContradiction.canBothBeTrue ||
    args.rawContradiction.isStaleOrSuperseded ||
    args.rawContradiction.isHistoricalTransition ||
    args.rawContradiction.isMereDetailDifference ||
    args.rawContradiction.isWeakProvenanceOnly
  ) {
    args.warnings.push(
      `Dropped contradiction for ${pairKey}: structured guards did not prove same-scope current incompatibility.`,
    );
    return null;
  }

  if (pairHasExplicitScopeMismatch(args.pair)) {
    args.warnings.push(
      `Dropped contradiction for ${pairKey}: explicit scope tags disagree across the pair.`,
    );
    return null;
  }

  const citesLeft = modelEvidenceCitesPage(evidence, args.pair.left);
  const citesRight = modelEvidenceCitesPage(evidence, args.pair.right);
  if (!citesLeft || !citesRight) {
    args.warnings.push(
      `Dropped contradiction for ${pairKey}: evidence must cite both source pages directly.`,
    );
    return null;
  }

  const evidenceQuality = getContradictionEvidenceQuality({
    evidence,
    leftAssertion,
    rightAssertion,
    incompatibility,
    sameScopeReason,
    notStaleOrSupersededReason,
  });
  const confidence = capContradictionConfidence(
    args.rawContradiction.confidence,
    args.pair,
    evidenceQuality,
  );

  return {
    title,
    claim,
    leftAssertion,
    rightAssertion,
    incompatibility,
    sameScopeReason,
    notStaleOrSupersededReason,
    implication,
    evidence,
    confidence,
    severity: capContradictionSeverity(
      args.rawContradiction.severity,
      confidence,
      evidenceQuality,
    ),
  };
}

function normalizeAiContradictionFindings(args: {
  output: ContradictionLinterOutput;
  pairByKey: Map<string, ContradictionCandidatePair>;
  warnings: string[];
}): AiContradictionFindingInput[] {
  const findings: AiContradictionFindingInput[] = [];
  const seenPairKeys = new Set<string>();

  for (const rawContradiction of args.output.contradictions) {
    const pairKey = rawContradiction.pairKey.trim();
    const pair = args.pairByKey.get(pairKey);
    if (!pair) {
      args.warnings.push(`Dropped contradiction for unknown pairKey ${pairKey}.`);
      continue;
    }
    if (pair.left._id === pair.right._id) {
      args.warnings.push(`Dropped self-pair contradiction for ${pairKey}.`);
      continue;
    }
    if (seenPairKeys.has(pairKey)) {
      args.warnings.push(`Dropped duplicate contradiction for ${pairKey}.`);
      continue;
    }

    const normalized = normalizeAiContradictionCandidate({
      rawContradiction,
      pair,
      warnings: args.warnings,
    });
    if (!normalized) {
      continue;
    }

    seenPairKeys.add(pairKey);
    findings.push(
      buildAiContradictionFinding({
        pair,
        title: normalized.title,
        claim: normalized.claim,
        leftAssertion: normalized.leftAssertion,
        rightAssertion: normalized.rightAssertion,
        incompatibility: normalized.incompatibility,
        sameScopeReason: normalized.sameScopeReason,
        notStaleOrSupersededReason: normalized.notStaleOrSupersededReason,
        implication: normalized.implication,
        evidence: normalized.evidence,
        confidence: normalized.confidence,
        severity: normalized.severity,
      }),
    );
  }

  return findings;
}

export function debugNormalizeAiContradictionFindingsForTest(args: {
  output: ContradictionLinterOutput;
  pairs: ContradictionCandidatePair[];
}): {
  findings: Array<{
    pairKey: string;
    slug: string;
    confidence: KnowledgeConfidence;
    severity: NonNullable<Doc<"knowledgePages">["severity"]>;
    relatedPageIds: Id<"knowledgePages">[];
  }>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const findings = normalizeAiContradictionFindings({
    output: args.output,
    pairByKey: new Map(args.pairs.map((pair) => [pair.pairKey, pair])),
    warnings,
  });
  return {
    findings: findings.map((finding) => ({
      pairKey: finding.pairKey,
      slug: finding.slug,
      confidence: finding.confidence,
      severity: finding.severity,
      relatedPageIds: [...finding.relatedPageIds],
    })),
    warnings: dedupeStringsPreserveOrder(warnings),
  };
}

function getLatestClosedSynthesisWindow(
  period: SynthesisPeriod,
  now: number = Date.now(),
): { period: SynthesisPeriod; timestamp: number; windowEnd: number } {
  const current = new Date(now);
  const startOfTodayUtc = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  );

  if (period === "daily") {
    return {
      period,
      timestamp: startOfTodayUtc - 24 * 60 * 60 * 1000,
      windowEnd: startOfTodayUtc,
    };
  }

  if (period === "weekly") {
    const dayOfWeek = current.getUTCDay();
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const currentWeekStartUtc =
      startOfTodayUtc - daysSinceMonday * 24 * 60 * 60 * 1000;
    return {
      period,
      timestamp: currentWeekStartUtc - 7 * 24 * 60 * 60 * 1000,
      windowEnd: currentWeekStartUtc,
    };
  }

  const currentMonthStartUtc = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    1,
  );
  const previousMonthStartUtc = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth() - 1,
    1,
  );
  return {
    period,
    timestamp: previousMonthStartUtc,
    windowEnd: currentMonthStartUtc,
  };
}

function getSynthesisPageContextLine(page: SynthesisInputPage): string {
  const parts = [
    `type=${page.type}`,
    `updatedAt=${formatUtc(page.updatedAt)}`,
    `confidence=${page.confidence}`,
  ];

  if (page.actor) {
    parts.push(`actor=${page.actor}`);
  }
  if (page.repo) {
    parts.push(`repo=${page.repo}`);
  }
  if (page.workType) {
    parts.push(`workType=${page.workType}`);
  }
  if (page.goalStatus) {
    parts.push(`goalStatus=${page.goalStatus}`);
  }
  if (page.findingStatus) {
    parts.push(`findingStatus=${page.findingStatus}`);
  }
  if (page.severity) {
    parts.push(`severity=${page.severity}`);
  }
  if (page.targetDate) {
    parts.push(`targetDate=${formatUtc(page.targetDate)}`);
  }

  return parts.join(" | ");
}

function formatSynthesisEvidenceEntries(
  entries: SynthesisInputPage["evidenceTimeline"],
): string[] {
  if (entries.length === 0) {
    return ["- Evidence: none preserved on the page"];
  }

  return entries.map(
    (entry) =>
      `- Evidence (${formatUtc(entry.timestamp)} | ${entry.source} via ${entry.channel}): ${clipSynthesisText(
        entry.content,
        SYNTHESIS_EVIDENCE_CHAR_LIMIT,
      )}`,
  );
}

function formatSynthesisPage(page: SynthesisInputPage): string {
  return [
    `### ${page.title} (${page.slug})`,
    getSynthesisPageContextLine(page),
    clipSynthesisText(page.compiledTruth, SYNTHESIS_TEXT_SECTION_CHAR_LIMIT),
    ...formatSynthesisEvidenceEntries(page.evidenceTimeline),
  ].join("\n");
}

function formatLowerSynthesis(synthesis: SynthesisInputSynthesis): string {
  return [
    `### ${synthesis.period} synthesis ${formatUtc(synthesis.timestamp)}`,
    `windowEnd=${formatUtc(synthesis.windowEnd)} | updatedAt=${formatUtc(
      synthesis.updatedAt,
    )}`,
    clipSynthesisText(synthesis.summary, SYNTHESIS_TEXT_SECTION_CHAR_LIMIT),
  ].join("\n");
}

function buildSection<T>(
  title: string,
  items: readonly T[],
  formatter: (item: T) => string,
): string {
  if (items.length === 0) {
    return `${title}\n- none`;
  }

  return [title, ...items.map(formatter)].join("\n\n");
}

function buildSynthesisEvidencePrompt(args: {
  period: SynthesisPeriod;
  timestamp: number;
  windowEnd: number;
  sessionPages: SynthesisInputPage[];
  updatedPages: SynthesisInputPage[];
  goalPages: SynthesisInputPage[];
  findingPages: SynthesisInputPage[];
  lowerSyntheses: SynthesisInputSynthesis[];
}): string {
  return [
    `Period: ${args.period}`,
    `Window start UTC: ${formatUtc(args.timestamp)}`,
    `Window end UTC: ${formatUtc(args.windowEnd)}`,
    "",
    buildSection("## Session Pages", args.sessionPages, formatSynthesisPage),
    buildSection(
      "## Updated Knowledge Pages",
      args.updatedPages,
      formatSynthesisPage,
    ),
    buildSection("## Active Goals", args.goalPages, formatSynthesisPage),
    buildSection(
      "## Active Findings",
      args.findingPages,
      formatSynthesisPage,
    ),
    buildSection(
      "## Lower-Period Syntheses",
      args.lowerSyntheses,
      formatLowerSynthesis,
    ),
  ].join("\n\n");
}

function buildSynthesisEvidencePack(inputs: SynthesisInputs): SynthesisEvidencePack {
  const warnings: string[] = [];
  const selected = {
    sessionPages: inputs.sessionPages.slice(0, SYNTHESIS_SECTION_LIMITS.sessionPages),
    updatedPages: inputs.updatedPages.slice(0, SYNTHESIS_SECTION_LIMITS.updatedPages),
    goalPages: inputs.goalPages.slice(0, SYNTHESIS_SECTION_LIMITS.goalPages),
    findingPages: inputs.findingPages.slice(0, SYNTHESIS_SECTION_LIMITS.findingPages),
    lowerSyntheses: inputs.lowerSyntheses.slice(
      0,
      SYNTHESIS_SECTION_LIMITS.lowerSyntheses,
    ),
  };

  if (inputs.sessionPages.length > selected.sessionPages.length) {
    warnings.push(
      `Trimmed session pages from ${inputs.sessionPages.length} to ${selected.sessionPages.length}.`,
    );
  }
  if (inputs.updatedPages.length > selected.updatedPages.length) {
    warnings.push(
      `Trimmed updated pages from ${inputs.updatedPages.length} to ${selected.updatedPages.length}.`,
    );
  }
  if (inputs.goalPages.length > selected.goalPages.length) {
    warnings.push(
      `Trimmed goal pages from ${inputs.goalPages.length} to ${selected.goalPages.length}.`,
    );
  }
  if (inputs.findingPages.length > selected.findingPages.length) {
    warnings.push(
      `Trimmed finding pages from ${inputs.findingPages.length} to ${selected.findingPages.length}.`,
    );
  }
  if (inputs.lowerSyntheses.length > selected.lowerSyntheses.length) {
    warnings.push(
      `Trimmed lower-period syntheses from ${inputs.lowerSyntheses.length} to ${selected.lowerSyntheses.length}.`,
    );
  }

  const reductionOrder = [
    "updatedPages",
    "sessionPages",
    "findingPages",
    "goalPages",
    "lowerSyntheses",
  ] as const;

  while (true) {
    const prompt = buildSynthesisEvidencePrompt({
      period: inputs.period,
      timestamp: inputs.timestamp,
      windowEnd: inputs.windowEnd,
      sessionPages: selected.sessionPages,
      updatedPages: selected.updatedPages,
      goalPages: selected.goalPages,
      findingPages: selected.findingPages,
      lowerSyntheses: selected.lowerSyntheses,
    });
    const estimatedInputTokens = estimateSynthesisTokens(
      `${SYNTHESIS_USER_STABLE_PREFIX}\n\n${prompt}`,
    );

    if (estimatedInputTokens <= SYNTHESIS_EVIDENCE_TOKEN_BUDGET) {
      return {
        prompt,
        actors: dedupeSortedStrings(
          selected.sessionPages.map((page) => page.actor),
        ),
        repos: dedupeSortedStrings(
          selected.sessionPages.map((page) => page.repo),
        ),
        sourcePageIds: dedupeSortedIds([
          ...selected.sessionPages.map((page) => page._id),
          ...selected.updatedPages.map((page) => page._id),
          ...selected.goalPages.map((page) => page._id),
          ...selected.findingPages.map((page) => page._id),
        ]),
        sourceSynthesisIds: dedupeSortedIds(
          selected.lowerSyntheses.map((synthesis) => synthesis._id),
        ),
        warnings: dedupeSortedStrings(warnings),
        estimatedInputTokens,
      };
    }

    let reduced = false;
    for (const key of reductionOrder) {
      if (selected[key].length > 1) {
        switch (key) {
          case "sessionPages":
            selected.sessionPages = selected.sessionPages.slice(0, -1);
            break;
          case "updatedPages":
            selected.updatedPages = selected.updatedPages.slice(0, -1);
            break;
          case "goalPages":
            selected.goalPages = selected.goalPages.slice(0, -1);
            break;
          case "findingPages":
            selected.findingPages = selected.findingPages.slice(0, -1);
            break;
          case "lowerSyntheses":
            selected.lowerSyntheses = selected.lowerSyntheses.slice(0, -1);
            break;
        }
        warnings.push(`Budget trim removed one item from ${key}.`);
        reduced = true;
        break;
      }
    }

    if (!reduced) {
      warnings.push(
        "Evidence pack remained above the target token budget after deterministic trimming.",
      );
      return {
        prompt,
        actors: dedupeSortedStrings(
          selected.sessionPages.map((page) => page.actor),
        ),
        repos: dedupeSortedStrings(
          selected.sessionPages.map((page) => page.repo),
        ),
        sourcePageIds: dedupeSortedIds([
          ...selected.sessionPages.map((page) => page._id),
          ...selected.updatedPages.map((page) => page._id),
          ...selected.goalPages.map((page) => page._id),
          ...selected.findingPages.map((page) => page._id),
        ]),
        sourceSynthesisIds: dedupeSortedIds(
          selected.lowerSyntheses.map((synthesis) => synthesis._id),
        ),
        warnings: dedupeSortedStrings(warnings),
        estimatedInputTokens,
      };
    }
  }
}

function buildNoActivitySummary(
  period: SynthesisPeriod,
  timestamp: number,
  windowEnd: number,
): string {
  return [
    "## What Changed",
    `- No activity was captured for the ${period} window from ${formatUtc(timestamp)} to ${formatUtc(windowEnd)}.`,
    "",
    "## Why It Matters",
    "- The knowledge base did not record new session work, page updates, or lower-period syntheses for this window.",
    "",
    "## Signals To Watch",
    "- If this is unexpected, verify event ingest and knowledge-page generation for the org.",
  ].join("\n");
}

function normalizeSynthesisSummary(summary: string, warnings: string[]): string {
  const trimmed = summary.trim();
  const hasWhatChanged = trimmed.includes("## What Changed");
  const hasWhyItMatters = trimmed.includes("## Why It Matters");
  const hasSignalsToWatch = trimmed.includes("## Signals To Watch");

  if (hasWhatChanged && hasWhyItMatters && hasSignalsToWatch) {
    return trimmed;
  }

  warnings.push("Model output was missing one or more required headings.");

  let normalized = trimmed;
  if (!hasWhatChanged) {
    normalized = `## What Changed\n${normalized}`;
  }
  if (!normalized.includes("## Why It Matters")) {
    normalized = `${normalized}\n\n## Why It Matters\n- Additional synthesis context was not formatted under this heading.`;
  }
  if (!normalized.includes("## Signals To Watch")) {
    normalized = `${normalized}\n\n## Signals To Watch\n- No additional signals were extracted.`;
  }
  return normalized.trim();
}

function getSynthesisErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown synthesis error";
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("AUTH: invalid managed MCP token");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64EncodeText(value: string): string {
  return base64Encode(new TextEncoder().encode(value));
}

function base64DecodeText(value: string): string {
  return new TextDecoder().decode(base64Decode(value));
}

async function signHmacSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return base64Encode(new Uint8Array(signature));
}

function getManagedMcpSigningSecret(): string | null {
  return process.env.SPARK_MCP_SIGNING_SECRET ?? null;
}

function parseManagedMcpPayload(payloadJson: string): ManagedMcpPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error("AUTH: invalid managed MCP token");
  }

  const orgId = getString(parsed, "orgId");
  const purpose = getString(parsed, "purpose");
  const exp = getNumber(parsed, "exp");
  const jti = getString(parsed, "jti");

  if (
    !orgId ||
    !exp ||
    !jti ||
    (purpose !== "customer-agent" && purpose !== "dream-cycle")
  ) {
    throw new Error("AUTH: invalid managed MCP token");
  }

  return {
    orgId,
    purpose,
    exp,
    jti,
  };
}

async function buildManagedMcpToken(args: {
  orgId: OrgId;
  purpose: ManagedMcpPurpose;
}): Promise<{ token: string; expiresAt: number }> {
  const signingSecret = getManagedMcpSigningSecret();
  if (!signingSecret) {
    console.warn("spark:managedMcpToken", {
      orgId: args.orgId,
      message: "SPARK_MCP_SIGNING_SECRET is not configured",
    });
    throw new Error("CONFIG: SPARK_MCP_SIGNING_SECRET is not configured");
  }

  const expiresAt = Date.now() + 60 * 60 * 1000;
  const payload: ManagedMcpPayload = {
    orgId: args.orgId,
    purpose: args.purpose,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  };
  const payloadJson = JSON.stringify(payload);
  const signature = await signHmacSha256(signingSecret, payloadJson);

  return {
    token: `${base64EncodeText(payloadJson)}.${signature}`,
    expiresAt,
  };
}

async function verifyManagedMcpToken(args: {
  bearerToken: string;
}): Promise<OrgId> {
  const signingSecret = getManagedMcpSigningSecret();
  if (!signingSecret) {
    throw new Error("AUTH: managed MCP signing secret is not configured");
  }

  const trimmedToken = args.bearerToken.trim();
  if (!trimmedToken) {
    throw new Error("AUTH: missing bearer token");
  }

  const [encodedPayload, providedSignature, ...rest] = trimmedToken.split(".");
  if (!encodedPayload || !providedSignature || rest.length > 0) {
    throw new Error("AUTH: invalid managed MCP token");
  }

  const payloadJson = base64DecodeText(encodedPayload);
  const expectedSignature = await signHmacSha256(signingSecret, payloadJson);
  if (!constantTimeEquals(expectedSignature, providedSignature)) {
    throw new Error("AUTH: invalid managed MCP token");
  }

  const payload = parseManagedMcpPayload(payloadJson);
  if (payload.exp <= Date.now()) {
    throw new Error("AUTH: managed MCP token expired");
  }

  return payload.orgId as OrgId;
}

function requireIdentityField(identity: unknown, fieldName: string, message: string): string {
  const value = getString(identity, fieldName);
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function normalizeTitle(rawTitle: string, actor: string): string {
  const singleLine = rawTitle.trim().split("\n")[0]?.trim();
  if (!singleLine) {
    return `${actor} session`;
  }
  return singleLine.slice(0, 120);
}

function readRepoName(raw: unknown): string | undefined {
  const repository = getRecord(getRecord(raw)?.repository);
  const fullName = repository?.full_name;
  if (typeof fullName === "string" && fullName.length > 0) {
    return fullName;
  }
  const repo = getString(raw, "repo");
  return repo ?? undefined;
}

function readRepoNames(events: Doc<"events">[]): string[] {
  return Array.from(
    new Set(
      events
        .map((event) => readRepoName(event.raw))
        .filter((repo): repo is string => Boolean(repo)),
    ),
  );
}

type EventActorRef = { source: string; gid: string };

function getEventActorIdentityRef(event: Doc<"events">): EventActorRef | null {
  if (event.actorRef) {
    return event.actorRef;
  }
  if (event.source === "github") {
    const raw = getRecord(event.raw);
    const login = getString(getRecord(raw?.sender), "login");
    if (login) {
      return { source: "github", gid: login };
    }
  }
  return null;
}

function eventActorClusterKey(event: Doc<"events">): string {
  if (event.actorEntityId) {
    return `entity:${event.actorEntityId}`;
  }
  const ref = getEventActorIdentityRef(event);
  if (ref) {
    return `ref:${ref.source}:${ref.gid}`;
  }
  return `actor:${event.actor}`;
}

function pickClusterActor(events: Doc<"events">[]): string {
  return events[events.length - 1]?.actor ?? events[0]?.actor ?? "Unknown actor";
}

function pickClusterActorEntityId(events: Doc<"events">[]): Id<"entities"> | undefined {
  return events.find((event) => event.actorEntityId)?.actorEntityId;
}

function buildSessionCluster(events: Doc<"events">[], now: number): EventCluster {
  const startTime = events[0]?.timestamp ?? now;
  const lastTimestamp = events[events.length - 1]?.timestamp ?? now;
  const repoNames = readRepoNames(events);
  // Repo metadata is extracted from the clustered events; it is not a clustering key.
  const repo = repoNames.length === 1 ? repoNames[0] : undefined;
  const status: SessionStatus =
    now - lastTimestamp <= SESSION_GAP_MS ? "active" : "complete";

  return {
    actor: pickClusterActor(events),
    actorEntityId: pickClusterActorEntityId(events),
    repo,
    repoNames,
    startTime,
    endTime: status === "complete" ? lastTimestamp : undefined,
    status,
    events,
  };
}

function mergeSessionRepo(
  existingRepo: string | undefined,
  nextRepo: string | undefined,
): string | undefined {
  if (!existingRepo) {
    return nextRepo;
  }
  if (!nextRepo || nextRepo === existingRepo) {
    return existingRepo;
  }
  return undefined;
}

function mergeEventIdsPreserveOrder(
  existingEventIds: readonly Id<"events">[],
  nextEventIds: readonly Id<"events">[],
): Id<"events">[] {
  const seen = new Set<string>();
  const merged: Id<"events">[] = [];
  for (const eventId of [...existingEventIds, ...nextEventIds]) {
    if (seen.has(eventId)) {
      continue;
    }
    seen.add(eventId);
    merged.push(eventId);
  }
  return merged;
}

async function recordSessionEventMemberships(
  ctx: Pick<MutationCtx, "db">,
  args: {
    sessionId: Id<"sessions">;
    orgId: Id<"orgs">;
    eventIds: readonly Id<"events">[];
    createdAt: number;
  },
): Promise<number> {
  const seen = new Set<string>();
  let inserted = 0;

  for (const eventId of args.eventIds) {
    if (seen.has(eventId)) {
      continue;
    }
    seen.add(eventId);
    const existing = await ctx.db
      .query("sessionEvents")
      .withIndex("by_session_event", (q) =>
        q.eq("sessionId", args.sessionId).eq("eventId", eventId),
      )
      .first();
    if (existing) {
      continue;
    }
    await ctx.db.insert("sessionEvents", {
      sessionId: args.sessionId,
      orgId: args.orgId,
      eventId,
      createdAt: args.createdAt,
    });
    inserted += 1;
  }

  return inserted;
}

function mergeEvidenceTimeline(
  existingEvidence: readonly SessionEvidenceEntry[],
  nextEvidence: readonly SessionEvidenceEntry[],
): SessionEvidenceEntry[] {
  const seen = new Set<string>();
  const merged: SessionEvidenceEntry[] = [];
  for (const entry of [...existingEvidence, ...nextEvidence]) {
    // Dedup by content, not timestamp — otherwise extending an active session
    // re-adds the same field-change rows (each Asana keystroke story carries a
    // distinct timestamp). Keeps the first (oldest) occurrence.
    const key = `${entry.source}\n${entry.channel}\n${entry.content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function appendSessionContinuationText(existingText: string, nextText: string): string {
  const existing = existingText.trim();
  const next = nextText.trim();
  if (!existing) {
    return next;
  }
  if (!next || existing.includes(next)) {
    return existing;
  }
  return `${existing}\n\n## Continuation\n\n${next}`;
}

async function getLatestEventTimestamp(
  ctx: { db: { get: (id: Id<"events">) => Promise<Doc<"events"> | null> } },
  session: Doc<"sessions">,
): Promise<number> {
  let latest = session.endTime ?? session.startTime;
  for (const eventId of session.eventIds ?? []) {
    const event = await ctx.db.get(eventId);
    if (event && event.timestamp > latest) {
      latest = event.timestamp;
    }
  }
  return latest;
}

function clusterEventsIntoSessions(events: Doc<"events">[], now: number): EventCluster[] {
  const eventsByActor = new Map<string, Doc<"events">[]>();
  for (const event of events) {
    // Bucket by actor AND work-scope (task/issue/ticket, else repo/channel/
    // project) so unrelated work by the same actor — and, critically, the
    // synthetic-"asana" actor's unattributed edits across many tasks — no longer
    // collapse into one mega-session. Scope-less events keep actor-only behavior.
    const actorKey = `${eventActorClusterKey(event)}|${getEventSessionScope(event) ?? ""}`;
    const actorEvents = eventsByActor.get(actorKey) ?? [];
    actorEvents.push(event);
    eventsByActor.set(actorKey, actorEvents);
  }

  const clusters: EventCluster[] = [];

  for (const actorEvents of eventsByActor.values()) {
    actorEvents.sort((left, right) => left.timestamp - right.timestamp);

    let currentCluster: Doc<"events">[] = [];

    for (const event of actorEvents) {
      const previousEvent = currentCluster[currentCluster.length - 1];
      if (!previousEvent) {
        currentCluster = [event];
        continue;
      }

      // Events less than 30 minutes apart stay in the same work session.
      const gapSincePreviousEvent = event.timestamp - previousEvent.timestamp;
      if (gapSincePreviousEvent <= SESSION_GAP_MS) {
        currentCluster.push(event);
        continue;
      }

      clusters.push(buildSessionCluster(currentCluster, now));
      currentCluster = [event];
    }

    if (currentCluster.length > 0) {
      clusters.push(buildSessionCluster(currentCluster, now));
    }
  }

  return clusters.sort((left, right) => left.startTime - right.startTime);
}

// Tool-agnostic noise gate (replaces the old Asana-specific isTrivialAsanaCluster).
// A cluster is noise when it has NO substantive event AND, after collapsing
// repeats of the same change, carries fewer than two distinct signals. Every
// event is mapped to a canonical {tier, verb, field, object} by classifyEvent,
// so this drops a burst of identical field edits (any tool), a lone CI run, a
// lone section move, etc. uniformly — no source=== branch. It is a strict
// SUPERSET of the old gate: Asana task_updated/ticket_moved classify to tier
// routine, so the 13x "notes changed" burst still drops, while a task
// creation/comment, a code push, or two distinct changes still survive.
function isNoiseCluster(events: Doc<"events">[]): boolean {
  if (events.length === 0) {
    return true;
  }
  const classified = events.map((event) =>
    classifyEvent(event.source, event.type, event.raw),
  );
  if (classified.some((c) => TIER_RANK[c.tier] >= TIER_RANK.substantive)) {
    return false;
  }
  const distinctSignals = new Set(
    classified.map(
      (c, i) => `${c.verb}|${c.field ?? ""}|${c.object.gid ?? events[i].summary}`,
    ),
  );
  return distinctSignals.size < 2;
}

// Durable object kinds that can scope a session on their own when there is no
// container (a Gorgias ticket, a Linear issue from a tool we don't yet read a
// project for). Tools WITH a container (GitHub repo, Slack channel, Asana
// project) scope by that container instead — see getEventSessionScope.
const SESSION_SCOPE_OBJECT_KINDS = new Set([
  "task",
  "issue",
  "ticket",
  "doc",
  "page",
  "deal",
]);

// The work-container a session clusters within, canonically: the container when
// the source has one (GitHub repo, Slack channel, Asana project), else a durable
// object (Gorgias ticket, Linear issue). Container-first keeps a dev's commit/PR
// burst in one repo as one session rather than fragmenting per-PR. Undefined
// when neither is known, so those events keep actor-only clustering (prior
// behavior). Generalizes the old GitHub-only repo handling and stops the
// synthetic-"asana" actor from lumping every project into one mega-session.
//
// TUNABLE: flip to object-first (durable object before container) for finer,
// per-task / per-issue sessions — see docs/tool-agnostic-pipeline.md.
function getEventSessionScope(event: Doc<"events">): string | undefined {
  const c = classifyEvent(event.source, event.type, event.raw);
  if (c.container?.gid) {
    return `${c.container.kind}:${c.container.gid}`;
  }
  if (c.object.gid && SESSION_SCOPE_OBJECT_KINDS.has(c.object.kind)) {
    return `${c.object.kind}:${c.object.gid}`;
  }
  return undefined;
}

function stringifyEventRaw(raw: unknown): string {
  try {
    const serialized = JSON.stringify(raw);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // Fall through to a string fallback for non-serializable payloads.
  }

  if (typeof raw === "string") {
    return raw;
  }

  return "[unserializable raw payload]";
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function buildExtractorPrompt(cluster: EventCluster): string {
  const lines = cluster.events.flatMap((event) => {
    const time = new Date(event.timestamp).toISOString();
    const raw = truncateText(
      stringifyEventRaw(event.raw),
      SESSION_EVENT_RAW_MAX_CHARS,
    );
    return [
      `- ${time}: [${event.source}/${event.type}] ${event.summary}`,
      `  Raw: ${raw}`,
    ];
  });

  return [
    `Actor: ${cluster.actor}`,
    `Repos: ${cluster.repoNames.length > 0 ? cluster.repoNames.join(", ") : "unknown"}`,
    `Time range: ${new Date(cluster.startTime).toISOString()} - ${new Date(
      cluster.endTime ?? cluster.startTime,
    ).toISOString()}`,
    `Event count: ${cluster.events.length}`,
    "",
    "Events:",
    ...lines,
  ].join("\n");
}

function extractAnthropicText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function stripMarkdownHeading(value: string): string {
  return value.replace(/^#{1,6}\s+/, "").trim();
}

function extractMarkdownH1(document: string): string | null {
  const match = document.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function isKnowledgeConfidence(value: string | null): value is KnowledgeConfidence {
  return value === "high" || value === "medium" || value === "low";
}

function normalizeConfidence(raw: string | undefined): KnowledgeConfidence {
  const value = (raw ?? "").toLowerCase().trim();
  if (value === "high") {
    return "high";
  }
  if (value === "low") {
    return "low";
  }
  return "medium";
}

function normalizeSessionWorkType(raw: string | null | undefined): string | null {
  const value = (raw ?? "").toLowerCase().trim();
  if (!value) {
    return null;
  }
  if (SESSION_WORK_TYPE_SET.has(value)) {
    return value;
  }
  return "other";
}

function normalizeKnownSessionWorkType(
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? "").toLowerCase().trim();
  if (!value || !SESSION_WORK_TYPE_SET.has(value)) {
    return null;
  }
  return value;
}

function normalizeSessionComplexity(
  raw: string | null | undefined,
): "low" | "moderate" | "high" | undefined {
  const value = (raw ?? "").toLowerCase().trim();
  if (value === "low" || value === "moderate" || value === "high") {
    return value;
  }
  return undefined;
}

function normalizeSessionSkill(raw: string | null | undefined): string | null {
  const value = (raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/^skill:/, "")
    .trim();
  return value.length > 0 ? value : null;
}

function normalizeSessionSkills(rawSkills: unknown): string[] | undefined {
  if (!Array.isArray(rawSkills)) {
    return undefined;
  }

  const skills: string[] = [];
  const seenSkills = new Set<string>();
  for (const rawSkill of rawSkills) {
    if (typeof rawSkill !== "string") {
      continue;
    }
    const skill = normalizeSessionSkill(rawSkill);
    if (!skill || seenSkills.has(skill)) {
      continue;
    }
    seenSkills.add(skill);
    skills.push(skill);
  }

  return skills.length > 0 ? skills : undefined;
}

function normalizeSessionTag(tag: string): string | null {
  const normalizedTag = tag.trim();
  if (!normalizedTag) {
    return null;
  }

  const lowerTag = normalizedTag.toLowerCase();
  if (lowerTag.startsWith("actor:") || lowerTag.startsWith("repo:")) {
    return null;
  }

  if (lowerTag.startsWith("worktype:")) {
    const workType = lowerTag.slice("worktype:".length).trim();
    if (SESSION_WORK_TYPE_SET.has(workType)) {
      return `workType:${workType}`;
    }
    return "workType:other";
  }

  return normalizedTag;
}

function normalizeSessionTags(tags: string[], fallbackWorkType = "other"): string[] {
  const normalizedTags: string[] = [];
  const seenTags = new Set<string>();
  let hasWorkType = false;

  for (const tag of tags) {
    const normalizedTag = normalizeSessionTag(tag);
    if (!normalizedTag || seenTags.has(normalizedTag)) {
      continue;
    }

    if (normalizedTag.startsWith("workType:")) {
      if (hasWorkType) {
        continue;
      }
      hasWorkType = true;
    }

    seenTags.add(normalizedTag);
    normalizedTags.push(normalizedTag);
  }

  if (!hasWorkType) {
    normalizedTags.unshift(`workType:${fallbackWorkType}`);
  }

  return normalizedTags;
}

function getSessionWorkTypeFromTags(tags: string[]): string | null {
  for (const tag of tags) {
    const lowerTag = tag.toLowerCase();
    if (!lowerTag.startsWith("worktype:")) {
      continue;
    }
    const workType = normalizeSessionWorkType(
      lowerTag.slice("worktype:".length),
    );
    if (workType) {
      return workType;
    }
  }
  return null;
}

function getSessionComplexityFromTags(
  tags: string[],
): "low" | "moderate" | "high" | undefined {
  for (const tag of tags) {
    const lowerTag = tag.toLowerCase();
    if (!lowerTag.startsWith("complexity:")) {
      continue;
    }
    const complexity = normalizeSessionComplexity(
      lowerTag.slice("complexity:".length),
    );
    if (complexity) {
      return complexity;
    }
  }
  return undefined;
}

function getSessionSkillsFromTags(tags: string[]): string[] | undefined {
  const skills: string[] = [];
  const seenSkills = new Set<string>();
  for (const tag of tags) {
    const lowerTag = tag.toLowerCase();
    if (!lowerTag.startsWith("skill:")) {
      continue;
    }
    const skill = normalizeSessionSkill(lowerTag.slice("skill:".length));
    if (!skill || seenSkills.has(skill)) {
      continue;
    }
    seenSkills.add(skill);
    skills.push(skill);
  }
  return skills.length > 0 ? skills : undefined;
}

function normalizeSessionMetadata(record: Record<string, unknown> | null): {
  tags: string[];
  workType: string;
  complexity?: "low" | "moderate" | "high";
  skills?: string[];
} {
  const rawTags = record?.tags;
  const tagStrings = Array.isArray(rawTags)
    ? rawTags
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter((tag) => tag.length > 0)
    : [];
  const explicitWorkType = record
    ? normalizeKnownSessionWorkType(getString(record, "workType"))
    : null;
  const workTypeFromTags = getSessionWorkTypeFromTags(tagStrings);
  const workType = explicitWorkType ?? workTypeFromTags ?? "other";
  const tags = normalizeSessionTags(tagStrings, workType);
  const explicitComplexity = record
    ? normalizeSessionComplexity(getString(record, "complexity"))
    : undefined;
  const explicitSkills = record
    ? normalizeSessionSkills(record.skills)
    : undefined;

  return {
    tags,
    workType,
    complexity: explicitComplexity ?? getSessionComplexityFromTags(tagStrings),
    skills: explicitSkills ?? getSessionSkillsFromTags(tagStrings),
  };
}

function stripClosingCodeFence(value: string): string {
  return value.replace(/\s*```[\s]*$/, "").trim();
}

function normalizeCompiledTruth(compiledTruth: string, fullResponse: string): string {
  const normalizedCompiledTruth = compiledTruth.trim();
  if (normalizedCompiledTruth.length >= 50) {
    return normalizedCompiledTruth;
  }
  return fullResponse.trim();
}

function splitSessionEnrichmentResponse(text: string): {
  compiledTruth: string;
  jsonBlock: string | null;
} {
  const fenceIndex = text.lastIndexOf("```json");
  if (fenceIndex === -1) {
    return { compiledTruth: text.trim(), jsonBlock: null };
  }

  const afterFence = text.slice(fenceIndex + "```json".length);
  const closingFenceIndex = afterFence.indexOf("```");
  const jsonBlock =
    closingFenceIndex === -1
      ? afterFence.trim()
      : afterFence.slice(0, closingFenceIndex).trim();

  return {
    compiledTruth: text.slice(0, fenceIndex).trim(),
    jsonBlock:
      jsonBlock.length > 0 ? stripClosingCodeFence(jsonBlock) : null,
  };
}

function parseSessionEnrichment(
  text: string,
  cluster: EventCluster,
): Omit<SessionEnrichment, "usage" | "providerMetadata"> {
  const { compiledTruth, jsonBlock } = splitSessionEnrichmentResponse(text);
  const normalizedCompiledTruth = normalizeCompiledTruth(compiledTruth, text);
  const fallbackTitle =
    extractMarkdownH1(normalizedCompiledTruth) ??
    normalizeTitle(stripMarkdownHeading(normalizedCompiledTruth), cluster.actor);

  if (!jsonBlock) {
    return {
      compiledTruth: normalizedCompiledTruth,
      title: fallbackTitle,
      tags: ["workType:other"],
      workType: "other",
      confidence: "medium",
    };
  }

  try {
    const parsed = JSON.parse(stripClosingCodeFence(jsonBlock));
    const record = getRecord(parsed);
    const rawTitle = record ? getString(record, "title") : null;
    const rawConfidence = record ? getString(record, "confidence") : null;
    const metadata = normalizeSessionMetadata(record);

    return {
      compiledTruth: normalizedCompiledTruth,
      title: normalizeTitle(rawTitle ?? fallbackTitle, cluster.actor),
      tags: metadata.tags,
      workType: metadata.workType,
      complexity: metadata.complexity,
      skills: metadata.skills,
      confidence: normalizeConfidence(rawConfidence ?? undefined),
    };
  } catch {
    return {
      compiledTruth: normalizedCompiledTruth,
      title: fallbackTitle,
      tags: ["workType:other"],
      workType: "other",
      confidence: "medium",
    };
  }
}

export function debugParseSessionEnrichmentForTest(args: {
  text: string;
  actor?: string;
  startTime?: number;
}): Omit<SessionEnrichment, "usage" | "providerMetadata"> {
  return parseSessionEnrichment(args.text, {
    actor: args.actor ?? "Debug Session Actor",
    repoNames: [],
    startTime: args.startTime ?? 0,
    status: "complete",
    events: [],
  });
}

async function enrichSessionCluster(args: {
  cluster: EventCluster;
  orgId: OrgId;
  sessionCount: number;
}): Promise<SessionEnrichment> {
  const result = await withRetriableCall(classifyAnthropicRetry, async () =>
    anthropicClient.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      temperature: 0,
      system: [
        {
          type: "text" as const,
          text: SESSION_ENRICHMENT_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages: [
        {
          role: "user" as const,
          content: buildExtractorPrompt(args.cluster),
        },
      ],
    }),
  );

  const usage = {
    promptTokens: result.usage.input_tokens ?? 0,
    completionTokens: result.usage.output_tokens ?? 0,
  };
  const providerMetadata = {
    anthropic: {
      cacheReadInputTokens: result.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: result.usage.cache_creation_input_tokens ?? 0,
    },
  };
  const costCents = calculateCostCents(
    "claude-sonnet-4-6",
    usage,
    providerMetadata,
  );

  console.log("spark:enrichment", {
    orgId: args.orgId,
    sessionCount: args.sessionCount,
    usage,
    costCents,
  });

  const text = extractAnthropicText(result.content);
  if (!text) {
    throw new Error("Session enrichment returned no text");
  }

  return {
    ...parseSessionEnrichment(text, args.cluster),
    usage,
    providerMetadata,
  };
}

function calculateCostCents(
  model: string,
  usage: {
    promptTokens?: number;
    completionTokens?: number;
  },
  providerMetadata: unknown,
): number {
  const rates = MODEL_RATES_CENTS_PER_MILLION[model];
  if (!rates) {
    return 0;
  }

  const inputTokens = usage.promptTokens ?? 0;
  const outputTokens = usage.completionTokens ?? 0;
  const cacheReadTokens = getNestedNumber(providerMetadata, [
    "anthropic",
    "cacheReadInputTokens",
  ]);
  const cacheCreationTokens = getNestedNumber(providerMetadata, [
    "anthropic",
    "cacheCreationInputTokens",
  ]);

  const totalCostCents =
    (inputTokens * rates.input) / 1_000_000 +
    (outputTokens * rates.output) / 1_000_000 +
    (cacheReadTokens * rates.cacheRead) / 1_000_000 +
    (cacheCreationTokens * rates.cacheCreation) / 1_000_000;

  return Number(totalCostCents.toFixed(4));
}

async function resolveOrgId(
  ctx: {
    db: NonNullable<AuthLookupContext["db"]>;
  },
  clerkOrgId: string,
): Promise<OrgId> {
  const org = (await ctx.db
    .query("orgs")
    .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
    .first()) as Doc<"orgs"> | null;

  if (!org) {
    throw new Error(`BAD_REQUEST: Spark org not found for Clerk org ${clerkOrgId}`);
  }

  return org._id;
}

function extractClerkOrgId(identity: unknown): string | null {
  return (
    getString(identity, "org_id") ??
    getString(getRecord(identity)?.o, "id")
  );
}

export async function getOrgIdFromAuth(ctx: AuthLookupContext): Promise<OrgId> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("AUTH: not authenticated");
  }

  const clerkOrgId = extractClerkOrgId(identity);
  if (!clerkOrgId) {
    throw new Error("AUTH: no org context");
  }

  if (ctx.db) {
    return resolveOrgId({ db: ctx.db }, clerkOrgId);
  }

  if (ctx.runQuery) {
    return ctx.runQuery(internal.spark.resolveOrgIdByClerkOrgId, {
      clerkOrgId,
    }) as Promise<OrgId>;
  }

  throw new Error("AUTH: no org resolver available");
}

function getNestedString(value: unknown, path: string[]): string | null {
  let cursor: unknown = value;
  for (const key of path) {
    const record = getRecord(cursor);
    if (!record) {
      return null;
    }
    cursor = record[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

function extractClerkUserId(identity: unknown): string {
  const direct =
    getString(identity, "subject") ??
    getString(identity, "sub") ??
    getString(identity, "user_id") ??
    getString(identity, "userId") ??
    getString(identity, "clerkUserId");
  if (direct) {
    return direct;
  }

  const tokenIdentifier = getString(identity, "tokenIdentifier");
  if (tokenIdentifier) {
    const [, maybeUserId] = tokenIdentifier.match(/\|([^|]+)$/) ?? [];
    return maybeUserId || tokenIdentifier;
  }

  throw new Error("AUTH: user identity is missing a subject");
}

type OrgRoleClaim =
  | {
      present: true;
      source: string;
      value: string;
    }
  | {
      present: false;
    };

function getClearOrgRoleClaim(identity: unknown): OrgRoleClaim {
  const rootClaimKeys = [
    "org_role",
    "orgRole",
    "organization_role",
    "organizationRole",
    "active_org_role",
    "activeOrgRole",
    "active_organization_role",
    "activeOrganizationRole",
    "clerk_org_role",
    "clerkOrgRole",
  ];

  for (const key of rootClaimKeys) {
    const value = getString(identity, key);
    if (value) {
      return { present: true, source: key, value };
    }
  }

  const nestedClaimPaths = [
    ["o", "rol"],
    ["org", "role"],
    ["organization", "role"],
    ["activeOrg", "role"],
    ["active_org", "role"],
    ["activeOrganization", "role"],
    ["active_organization", "role"],
  ];

  for (const path of nestedClaimPaths) {
    const value = getNestedString(identity, path);
    if (value) {
      return { present: true, source: path.join("."), value };
    }
  }

  const role = getString(identity, "role");
  if (role?.trim().toLowerCase().startsWith("org:")) {
    return { present: true, source: "role", value: role };
  }

  return { present: false };
}

function isAdminOrgRoleClaim(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  const withoutOrgPrefix = normalized
    .replace(/^org:/, "")
    .replace(/^organization:/, "");
  return withoutOrgPrefix === "admin" || withoutOrgPrefix === "owner";
}

function assertIntegrationAdminClaim(claim: OrgRoleClaim): boolean {
  if (!claim.present) {
    return false;
  }
  if (!isAdminOrgRoleClaim(claim.value)) {
    throw new Error("AUTH: integration admin role required");
  }
  return true;
}

async function getTeamMemberRoleForIntegrationAdmin(
  ctx: Pick<AuthLookupContext, "db" | "runQuery">,
  orgId: OrgId,
  clerkUserId: string,
): Promise<Doc<"teamMembers">["role"] | null> {
  if (ctx.db) {
    const member = (await ctx.db
      .query("teamMembers")
      .withIndex("by_org_clerkUser", (q) =>
        q.eq("orgId", orgId).eq("clerkUserId", clerkUserId),
      )
      .first()) as Doc<"teamMembers"> | null;
    return member?.role ?? null;
  }

  if (ctx.runQuery) {
    return ctx.runQuery(internal.spark.getTeamMemberRoleForOrgUser, {
      orgId,
      clerkUserId,
    }) as Promise<Doc<"teamMembers">["role"] | null>;
  }

  throw new Error("AUTH: no team member role resolver available");
}

export async function requireIntegrationAdminOrgIdFromIdentity(
  ctx: Pick<AuthLookupContext, "db" | "runQuery">,
  identity: unknown,
): Promise<OrgId> {
  const clerkOrgId = extractClerkOrgId(identity);
  if (!clerkOrgId) {
    throw new Error("AUTH: no org context");
  }
  const clerkUserId = extractClerkUserId(identity);
  const orgId = ctx.db
    ? await resolveOrgId({ db: ctx.db }, clerkOrgId)
    : (await ctx.runQuery?.(internal.spark.resolveOrgIdByClerkOrgId, {
        clerkOrgId,
      })) as OrgId | undefined;

  if (!orgId) {
    throw new Error("AUTH: no org resolver available");
  }

  const claim = getClearOrgRoleClaim(identity);
  if (assertIntegrationAdminClaim(claim)) {
    return orgId;
  }

  const role = await getTeamMemberRoleForIntegrationAdmin(
    ctx,
    orgId,
    clerkUserId,
  );
  if (role !== "admin") {
    throw new Error("AUTH: integration admin role required");
  }

  return orgId;
}

export async function requireIntegrationAdminOrgIdFromAuth(
  ctx: AuthLookupContext,
): Promise<OrgId> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("AUTH: not authenticated");
  }

  return requireIntegrationAdminOrgIdFromIdentity(ctx, identity);
}

export async function getUserIdFromAuth(ctx: AuthLookupContext): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("AUTH: not authenticated");
  }

  return (
    getString(identity, "subject") ??
    getString(identity, "sub") ??
    requireIdentityField(identity, "tokenIdentifier", "AUTH: user identity is missing a subject")
  );
}

export function normalizeBoundedInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = Math.trunc(value ?? defaultValue);
  if (!Number.isFinite(candidate)) {
    return defaultValue;
  }
  return Math.max(minimum, Math.min(candidate, maximum));
}

function getUtcDayStartMs(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function getUtcWeekStartMs(timestamp: number): number {
  const dayStartMs = getUtcDayStartMs(timestamp);
  const dayOfWeek = new Date(dayStartMs).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return dayStartMs - daysSinceMonday * DAY_MS;
}

function getStatLabel(metric: ChatStatMetric): string {
  switch (metric) {
    case "events_this_week":
      return "Events this week";
    case "sessions_this_week":
      return "Sessions this week";
    case "active_sessions":
      return "Active sessions";
    case "total_events":
      return "Total events";
  }
}

function getStatContext(metric: ChatStatMetric): string {
  switch (metric) {
    case "events_this_week":
    case "sessions_this_week":
      return "Since Monday 00:00 UTC.";
    case "active_sessions":
      return "Sessions currently marked active.";
    case "total_events":
      return "Indexed org events.";
  }
}

const searchKnowledge = createTool<{ query: string }, unknown>({
  description:
    "Search the org's knowledge base for entities, sessions, and findings when the user asks what Spark already knows.",
  inputSchema: z.object({
    query: z.string().describe("Natural language search query"),
  }),
  execute: async (toolCtx, input): Promise<unknown> => {
    if (!toolCtx.threadId) {
      throw new Error("AUTH: missing thread context");
    }

    const orgId = await toolCtx.runQuery(internal.search.getOrgIdForThread, {
      threadId: toolCtx.threadId,
    });
    if (!orgId) {
      throw new Error("AUTH: no org context for thread");
    }

    const raw = (await toolCtx.runAction(internal.search.deepSearch, {
      orgId,
      query: input.query,
      limit: 10,
    })) as {
      results?: Array<{
        pageId: string;
        title: string;
        type: string;
        slug: string;
        compiledTruth: string;
        highlights?: string[];
      }>;
    };

    // deepSearch fans a single source chunk out to every page it's attributed
    // to, so tangential pages surface with the SAME chunk text as their
    // highlight. Dedupe highlights across results and cap to the most relevant
    // few, so the model (and the widget) get unique, page-specific evidence
    // instead of one chunk repeated down the list.
    const seenHighlight = new Set<string>();
    const dedupeKey = (text: string) => text.trim().toLowerCase().slice(0, 140);
    const results = (raw.results ?? []).slice(0, 6).map((result) => {
      const uniqueHighlight = (result.highlights ?? [])
        .map((h) => h.trim())
        .find((h) => h.length > 0 && !seenHighlight.has(dedupeKey(h)));
      if (uniqueHighlight) {
        seenHighlight.add(dedupeKey(uniqueHighlight));
      }
      return {
        pageId: result.pageId,
        title: result.title,
        type: result.type,
        slug: result.slug,
        compiledTruth: result.compiledTruth,
        // When this page's only highlight is a chunk already shown above, drop
        // it — the model/widget then falls back to this page's own compiled
        // truth rather than repeating the same excerpt.
        highlights: uniqueHighlight ? [uniqueHighlight] : [],
      };
    });

    return { results, found: results.length };
  },
});

const countByDimension = createTool<
  { groupBy: ChatDimension; sinceDays?: number },
  ChartWidget
>({
  description:
    "Return a bar chart of org event counts grouped by actor or source over a recent window.",
  inputSchema: z.object({
    groupBy: z.enum(["actor", "source"]),
    sinceDays: z.number().optional(),
  }),
  execute: async (toolCtx, input): Promise<ChartWidget> => {
    if (!toolCtx.threadId) {
      throw new Error("AUTH: missing thread context");
    }

    const orgId = await toolCtx.runQuery(internal.search.getOrgIdForThread, {
      threadId: toolCtx.threadId,
    });
    if (!orgId) {
      throw new Error("AUTH: no org context for thread");
    }

    const sinceDays = normalizeBoundedInteger(
      input.sinceDays,
      CHAT_DEFAULT_SINCE_DAYS,
      1,
      365,
    );
    const untilMs = Date.now();
    const { buckets, truncated } = await toolCtx.runQuery(
      internal.spark.chatEventBuckets,
      {
        orgId,
        groupBy: input.groupBy,
        sinceMs: untilMs - sinceDays * DAY_MS,
        untilMs,
      },
    );

    return {
      chartType: "bar",
      title: truncated
        ? `Events by ${input.groupBy} (most recent ${CHAT_EVENT_SCAN_LIMIT.toLocaleString()} events)`
        : `Events by ${input.groupBy}`,
      xLabel: input.groupBy,
      yLabel: "Events",
      data: buckets.slice(0, CHAT_BUCKET_LIMIT),
      truncated,
    };
  },
});

const trendOverTime = createTool<{ days?: number }, ChartWidget>({
  description:
    "Return a line chart of org event counts per UTC calendar day, including zero-count days.",
  inputSchema: z.object({
    days: z.number().optional(),
  }),
  execute: async (toolCtx, input): Promise<ChartWidget> => {
    if (!toolCtx.threadId) {
      throw new Error("AUTH: missing thread context");
    }

    const orgId = await toolCtx.runQuery(internal.search.getOrgIdForThread, {
      threadId: toolCtx.threadId,
    });
    if (!orgId) {
      throw new Error("AUTH: no org context for thread");
    }

    const days = normalizeBoundedInteger(
      input.days,
      CHAT_DEFAULT_TREND_DAYS,
      3,
      60,
    );
    const todayStartMs = getUtcDayStartMs(Date.now());
    const sinceMs = todayStartMs - (days - 1) * DAY_MS;
    const { trend, truncated } = await toolCtx.runQuery(
      internal.spark.chatEventTrend,
      {
        orgId,
        sinceMs,
        untilMs: todayStartMs + DAY_MS,
        days,
      },
    );

    return {
      chartType: "line",
      title: truncated
        ? `Events / day (last ${days}d — capped at ${CHAT_EVENT_SCAN_LIMIT.toLocaleString()} events, early days undercounted)`
        : `Events / day (last ${days}d)`,
      xLabel: "Date",
      yLabel: "Events",
      data: trend,
      truncated,
    };
  },
});

const splitOf = createTool<
  { groupBy: ChatDimension; sinceDays?: number },
  ChartWidget
>({
  description:
    "Return a pie chart of org event share grouped by actor or source over a recent window.",
  inputSchema: z.object({
    groupBy: z.enum(["actor", "source"]),
    sinceDays: z.number().optional(),
  }),
  execute: async (toolCtx, input): Promise<ChartWidget> => {
    if (!toolCtx.threadId) {
      throw new Error("AUTH: missing thread context");
    }

    const orgId = await toolCtx.runQuery(internal.search.getOrgIdForThread, {
      threadId: toolCtx.threadId,
    });
    if (!orgId) {
      throw new Error("AUTH: no org context for thread");
    }

    const sinceDays = normalizeBoundedInteger(
      input.sinceDays,
      CHAT_DEFAULT_SINCE_DAYS,
      1,
      365,
    );
    const untilMs = Date.now();
    const { buckets, truncated } = await toolCtx.runQuery(
      internal.spark.chatEventBuckets,
      {
        orgId,
        groupBy: input.groupBy,
        sinceMs: untilMs - sinceDays * DAY_MS,
        untilMs,
      },
    );
    const total = buckets.reduce(
      (sum: number, bucket: ChartBucketDatum) => sum + bucket.value,
      0,
    );
    const data = buckets.slice(0, CHAT_SPLIT_LIMIT).map((bucket: ChartBucketDatum) => ({
      ...bucket,
      percentage: total === 0 ? 0 : Math.round((bucket.value / total) * 100),
    }));

    return {
      chartType: "pie",
      title: truncated
        ? `Event share by ${input.groupBy} (most recent ${CHAT_EVENT_SCAN_LIMIT.toLocaleString()} events)`
        : `Event share by ${input.groupBy}`,
      total,
      data,
      truncated,
    };
  },
});

const getStat = createTool<{ metric: ChatStatMetric }, StatWidget>({
  description:
    "Return a numeric KPI from real org event and session data.",
  inputSchema: z.object({
    metric: z.enum([
      "events_this_week",
      "sessions_this_week",
      "active_sessions",
      "total_events",
    ]),
  }),
  execute: async (toolCtx, input): Promise<StatWidget> => {
    if (!toolCtx.threadId) {
      throw new Error("AUTH: missing thread context");
    }

    const orgId = await toolCtx.runQuery(internal.search.getOrgIdForThread, {
      threadId: toolCtx.threadId,
    });
    if (!orgId) {
      throw new Error("AUTH: no org context for thread");
    }

    const metric = input.metric;
    const untilMs = Date.now();
    const sinceMs = metric.endsWith("_this_week")
      ? getUtcWeekStartMs(untilMs)
      : 0;
    const stat = await toolCtx.runQuery(internal.spark.chatStat, {
      orgId,
      metric,
      sinceMs,
      untilMs,
    });

    const baseContext = getStatContext(metric);
    const context = stat.truncated
      ? `${baseContext} Capped at ${CHAT_EVENT_SCAN_LIMIT.toLocaleString()} — the true total is higher.`
      : baseContext;
    return {
      widgetType: "stat",
      label: getStatLabel(metric),
      value: stat.value,
      context,
    };
  },
});

const listSessions = createTool<
  { actor?: string; limit?: number },
  SessionListWidget
>({
  description:
    "Return recent org work sessions, optionally filtered by actor.",
  inputSchema: z.object({
    actor: z.string().optional(),
    limit: z.number().optional(),
  }),
  execute: async (toolCtx, input): Promise<SessionListWidget> => {
    if (!toolCtx.threadId) {
      throw new Error("AUTH: missing thread context");
    }

    const orgId = await toolCtx.runQuery(internal.search.getOrgIdForThread, {
      threadId: toolCtx.threadId,
    });
    if (!orgId) {
      throw new Error("AUTH: no org context for thread");
    }

    const limit = normalizeBoundedInteger(
      input.limit,
      CHAT_DEFAULT_SESSION_LIMIT,
      1,
      CHAT_MAX_SESSION_LIMIT,
    );
    const actor = input.actor?.trim() || undefined;
    const sessions = await toolCtx.runQuery(internal.spark.chatRecentSessions, {
      orgId,
      actor,
      limit,
    });

    return {
      widgetType: "sessionList",
      title: actor ? `Recent sessions for ${actor}` : "Recent sessions",
      total: sessions.length,
      sessions,
    };
  },
});

// Agent-name → usage source attribution for the shared handler (A-11).
const AGENT_USAGE_SOURCES: Record<string, UsageSource> = {
  Spark: "chat",
  "Spark Synthesizer": "synthesizer",
  "Spark Linter": "linter",
};

const usageHandler = async (
  // The agent lib types ctx over GenericDataModel; accept unknown and cast to
  // this app's ActionCtx (contravariance makes the precise type unassignable).
  ctx: unknown,
  args: {
    threadId?: string;
    agentName?: string;
    model: string;
    usage: {
      // ai v6 names first; v4/v5 names kept as fallback so a framework bump
      // in either direction cannot zero out recorded usage.
      inputTokens?: number;
      outputTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
    providerMetadata?: unknown;
  },
) => {
  const inputTokens = args.usage.inputTokens ?? args.usage.promptTokens ?? 0;
  const outputTokens =
    args.usage.outputTokens ?? args.usage.completionTokens ?? 0;
  const cacheReadInputTokens = getNestedNumber(args.providerMetadata, [
    "anthropic",
    "cacheReadInputTokens",
  ]);
  const cacheCreationInputTokens = getNestedNumber(args.providerMetadata, [
    "anthropic",
    "cacheCreationInputTokens",
  ]);
  const costCents = calculateCostCents(
    args.model,
    { promptTokens: inputTokens, completionTokens: outputTokens },
    args.providerMetadata,
  );

  console.warn("spark:usage", {
    model: args.model,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    costCents,
  });

  // Persist one row per call (A-11). Fail-soft: a usage-write failure must
  // never fail the generation that triggered it.
  try {
    if (!args.threadId) {
      return;
    }
    const actionCtx = ctx as ActionCtx;
    const orgId = (await actionCtx.runQuery(internal.search.getOrgIdForThread, {
      threadId: args.threadId,
    })) as Id<"orgs"> | null;
    if (!orgId) {
      return;
    }
    await actionCtx.runMutation(internal.usage.recordUsage, {
      orgId,
      source: AGENT_USAGE_SOURCES[args.agentName ?? ""] ?? "chat",
      model: args.model,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      costCents,
    });
  } catch (error) {
    console.warn("spark:usageRecordFailed", {
      model: args.model,
      error: String(error),
    });
  }
};

const sparkChat = new Agent(components.agent, {
  name: "Spark",
  languageModel: anthropic("claude-opus-4-6"),
  instructions: [
    "You are Spark, the org intelligence layer.",
    "Ground every answer in org data; never invent facts.",
    "Prefer a tool whenever the user asks for a chart, graph, trend, split, comparison, count, KPI, recent sessions, who did the most work, or what Spark already knows about a topic.",
    "Write one short sentence before calling a tool.",
    "After a tool returns, ALWAYS write the actual answer in prose: directly address what was asked (e.g. what it is, why it matters, what changed) grounded in the returned data. The tool's widget is supporting evidence, not the answer — never stop at it.",
    "Call searchKnowledge at most once per question — do not repeat the same or a near-identical search; if the first results are thin, synthesize what you can and note the gap rather than searching again.",
    "When you search knowledge, synthesize only the genuinely relevant results into a tight narrative, name the specific pages you used, and ignore tangential or duplicate matches. If nothing relevant came back, say so plainly.",
    "Keep answers precise and cite uncertainty.",
  ].join(" "),
  tools: {
    searchKnowledge,
    getKnowledgeItem,
    listKnowledgeSources,
    summarizeKnowledge,
    addKnowledgeItem,
    createAgent,
    countByDimension,
    trendOverTime,
    splitOf,
    getStat,
    listSessions,
  },
  usageHandler,
});

const synthesizerAgent = new Agent(components.agent, {
  name: "Spark Synthesizer",
  languageModel: anthropic("claude-sonnet-4-6"),
  instructions:
    "Compress recent org activity into concise narratives grounded in the provided evidence.",
  usageHandler,
});

const linterAgent = new Agent(components.agent, {
  name: "Spark Linter",
  languageModel: anthropic("claude-sonnet-4-6"),
  instructions:
    "Flag quality issues, stale knowledge, contradictions, and missing context with minimal commentary.",
  usageHandler,
});

export const orgQuery = customQuery(query, {
  args: {},
  input: async (ctx, args) => {
    const orgId = await getOrgIdFromAuth(ctx);
    return { ctx: { orgId }, args };
  },
});

export const orgMutation = customMutation(mutation, {
  args: {},
  input: async (ctx, args) => {
    const orgId = await getOrgIdFromAuth(ctx);
    return { ctx: { orgId }, args };
  },
});

type ArgsValidators = Record<string, Validator<any, any, any>>;
type ArgsObject<A extends ArgsValidators> = { [K in keyof A]: Infer<A[K]> };

/** Public org-scoped action that only forwards to an internal `*ForOrg` action. */
function delegateForOrg<A extends ArgsValidators, R>(
  args: A,
  delegate: FunctionReference<
    "action",
    "public" | "internal",
    ArgsObject<A> & { orgId: OrgId },
    R
  >,
): RegisteredAction<"public", ArgsObject<A>, Promise<R>> {
  return action({
    args,
    handler: async (ctx: ActionCtx, a: ArgsObject<A>): Promise<R> => {
      const orgId = await getOrgIdFromAuth(ctx);
      const runDelegate = ctx.runAction as (
        ref: typeof delegate,
        args: ArgsObject<A> & { orgId: OrgId },
      ) => Promise<R>;
      return runDelegate(delegate, { orgId, ...a } as ArgsObject<A> & {
        orgId: OrgId;
      });
    },
  } as any) as RegisteredAction<"public", ArgsObject<A>, Promise<R>>;
}

/** Public integration-admin action that only forwards to an internal `*ForOrg` action. */
function delegateForIntegrationAdminOrg<A extends ArgsValidators, R>(
  args: A,
  delegate: FunctionReference<
    "action",
    "public" | "internal",
    ArgsObject<A> & { orgId: OrgId },
    R
  >,
): RegisteredAction<"public", ArgsObject<A>, Promise<R>> {
  return action({
    args,
    handler: async (ctx: ActionCtx, a: ArgsObject<A>): Promise<R> => {
      const orgId = await requireIntegrationAdminOrgIdFromAuth(ctx);
      const runDelegate = ctx.runAction as (
        ref: typeof delegate,
        args: ArgsObject<A> & { orgId: OrgId },
      ) => Promise<R>;
      return runDelegate(delegate, { orgId, ...a } as ArgsObject<A> & {
        orgId: OrgId;
      });
    },
  } as any) as RegisteredAction<"public", ArgsObject<A>, Promise<R>>;
}

export const integrationAdminQuery = customQuery(query, {
  args: {},
  input: async (ctx, args) => {
    const orgId = await requireIntegrationAdminOrgIdFromAuth(ctx);
    return { ctx: { orgId }, args };
  },
});

export const integrationAdminMutation = customMutation(mutation, {
  args: {},
  input: async (ctx, args) => {
    const orgId = await requireIntegrationAdminOrgIdFromAuth(ctx);
    return { ctx: { orgId }, args };
  },
});

export const resolveOrgIdByClerkOrgId = internalQuery({
  args: {
    clerkOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    return resolveOrgId({ db: ctx.db }, args.clerkOrgId);
  },
});

export const getTeamMemberRoleForOrgUser = internalQuery({
  args: {
    orgId: v.id("orgs"),
    clerkUserId: v.string(),
  },
  handler: async (ctx, args) => {
    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_org_clerkUser", (q) =>
        q.eq("orgId", args.orgId).eq("clerkUserId", args.clerkUserId),
      )
      .first();
    return member?.role ?? null;
  },
});

export const resolveOrgIdByComposioUserId = internalQuery({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const org = await ctx.db.get(args.userId as OrgId);
      if (org) {
        return org._id;
      }
    } catch {
      // Fall through to the legacy Clerk org lookup for pre-migration payloads.
    }

    return resolveOrgId({ db: ctx.db }, args.userId);
  },
});

export const resolveOrgIdByGithubInstallationId = internalQuery({
  args: {
    installationId: v.number(),
  },
  // Returns null instead of throwing when no org has linked this
  // installation yet. The ingest dispatcher uses null to silently skip
  // unknown installations — events arriving during the install race window
  // (after GitHub fires the `installation.created` webhook but before the
  // post-install callback page has called `linkGithubInstallation`) would
  // otherwise produce loud 500s and trigger GitHub redelivery retries.
  handler: async (ctx, args): Promise<OrgId | null> => {
    const orgs = await ctx.db
      .query("orgs")
      .withIndex("by_githubInstallationId", (q) =>
        q.eq("githubInstallationId", args.installationId),
      )
      .take(2);
    if (orgs.length > 1) {
      console.error("spark:github-installation-duplicate", {
        installationId: args.installationId,
        orgIds: orgs.map((org) => org._id),
      });
      return null;
    }
    const org = orgs[0];
    if (!org) {
      return null;
    }
    return org._id;
  },
});

export const setGithubInstallationId = internalMutation({
  args: {
    orgId: v.id("orgs"),
    githubInstallationId: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.orgId, {
      githubInstallationId: args.githubInstallationId,
    });
  },
});

export const listOrgIdsPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId")
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: page.page.map((org) => org._id),
    };
  },
});

type OrgFanOutContext = RunQueryContext;

async function forEachOrgIdPage(
  ctx: OrgFanOutContext,
  onOrgId: (orgId: OrgId) => Promise<void>,
  options?: { includeOrgIds?: ReadonlySet<string> },
): Promise<number> {
  let cursor: string | null = null;
  let orgCount = 0;

  do {
    const orgPage = (await ctx.runQuery(listOrgIdsPageRef, {
      paginationOpts: {
        numItems: ORG_FANOUT_PAGE_SIZE,
        cursor,
      },
    })) as PaginationResult<OrgId>;

    for (const orgId of orgPage.page) {
      orgCount += 1;
      if (
        options?.includeOrgIds &&
        !options.includeOrgIds.has(orgId as string)
      ) {
        continue;
      }
      await onOrgId(orgId);
    }

    cursor = orgPage.isDone ? null : orgPage.continueCursor;
  } while (cursor !== null);

  return orgCount;
}

async function listUnprocessedEventCandidates(
  ctx: Pick<QueryCtx, "db">,
  args: { orgId: Id<"orgs">; limit: number },
): Promise<Doc<"events">[]> {
  const explicitUnprocessedCandidates = await ctx.db
    .query("events")
    .withIndex("by_org_unprocessed", (q) =>
      q.eq("orgId", args.orgId).eq("processed", false),
    )
    .take(args.limit);
  const legacyUnprocessedCandidates = await ctx.db
    .query("events")
    .withIndex("by_org_unprocessed", (q) =>
      q.eq("orgId", args.orgId).eq("processed", undefined),
    )
    .take(args.limit);

  return [...explicitUnprocessedCandidates, ...legacyUnprocessedCandidates]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(0, args.limit);
}

function isClaimableUnprocessedEvent(
  event: Pick<Doc<"events">, "claimedAt">,
  staleThreshold: number,
): boolean {
  return !event.claimedAt || event.claimedAt < staleThreshold;
}

async function ensureEventActorIdentityReady(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  event: Doc<"events">,
): Promise<boolean> {
  const ref = getEventActorIdentityRef(event);
  if (!ref) {
    return true;
  }
  if (event.actorEntityId || event.actorIdentityResolvedAt) {
    return true;
  }

  const cached = await ctx.db
    .query("identityCache")
    .withIndex("by_org_source_gid", (q) =>
      q
        .eq("orgId", event.orgId)
        .eq("source", ref.source)
        .eq("gid", ref.gid),
    )
    .first();
  if (cached?.entityId) {
    await ctx.db.patch(event._id, {
      actorEntityId: cached.entityId,
      actorIdentityResolvedAt: Date.now(),
    });
    return true;
  }

  await ctx.scheduler.runAfter(0, internal.spark.resolveEventEntities, {
    eventId: event._id,
  });
  return false;
}

export const hasClaimableUnprocessedEvents = internalQuery({
  args: {
    orgId: v.id("orgs"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const now = args.now ?? Date.now();
    const staleThreshold = now - CLAIM_TIMEOUT_MS;
    const candidates = await listUnprocessedEventCandidates(ctx, {
      orgId: args.orgId,
      limit: CLAIM_BATCH_SIZE,
    });

    return candidates.some((event) =>
      isClaimableUnprocessedEvent(event, staleThreshold),
    );
  },
});

export const claimUnprocessedEvents = internalMutation({
  args: {
    orgId: v.id("orgs"),
    now: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ eventIds: Id<"events">[]; count: number }> => {
    const now = args.now ?? Date.now();
    const staleThreshold = now - CLAIM_TIMEOUT_MS;
    const candidates = await listUnprocessedEventCandidates(ctx, {
      orgId: args.orgId,
      limit: CLAIM_BATCH_SIZE,
    });

    const claimable: Doc<"events">[] = [];
    for (const event of candidates) {
      if (!isClaimableUnprocessedEvent(event, staleThreshold)) {
        continue;
      }
      if (!(await ensureEventActorIdentityReady(ctx, event))) {
        continue;
      }
      claimable.push(event);
    }

    if (claimable.length === 0) {
      return { eventIds: [], count: 0 };
    }

    const eventIds: Id<"events">[] = [];
    for (const event of claimable) {
      await ctx.db.patch(event._id, { processed: false, claimedAt: now });
      eventIds.push(event._id);
    }

    return { eventIds, count: eventIds.length };
  },
});

export const getEventsByIds = internalQuery({
  args: {
    eventIds: v.array(v.id("events")),
  },
  handler: async (ctx, args) => {
    const events: Doc<"events">[] = [];
    for (const eventId of args.eventIds) {
      const event = await ctx.db.get(eventId);
      if (event) {
        events.push(event);
      }
    }
    return events;
  },
});

export const unclaimEvents = internalMutation({
  args: {
    eventIds: v.array(v.id("events")),
  },
  handler: async (ctx, args) => {
    for (const eventId of args.eventIds) {
      await ctx.db.patch(eventId, { claimedAt: undefined });
    }

    return { count: args.eventIds.length };
  },
});

// Mark events as fully processed without materializing a session — used for
// trivial Asana micro-update clusters the extractor deliberately drops. Setting
// processed:true (not merely clearing claimedAt like unclaimEvents) is required
// so claimUnprocessedEvents does not re-claim them on the next 5-minute pass.
export const markEventsProcessed = internalMutation({
  args: {
    eventIds: v.array(v.id("events")),
  },
  handler: async (ctx, args) => {
    for (const eventId of args.eventIds) {
      await ctx.db.patch(eventId, { processed: true, claimedAt: undefined });
    }

    return { count: args.eventIds.length };
  },
});

export const insertSessionAndMarkEvents = internalMutation({
  args: {
    orgId: v.id("orgs"),
    knowledgeBaseId: v.id("knowledgeBases"),
    actor: v.string(),
    actorEntityId: v.optional(v.id("entities")),
    repo: v.optional(v.string()),
    title: v.string(),
    compiledTruth: v.string(),
    evidenceTimeline: v.array(
      v.object({
        source: v.string(),
        channel: v.string(),
        timestamp: v.number(),
        content: v.string(),
      }),
    ),
    tags: v.array(v.string()),
    workType: v.optional(v.string()),
    complexity: v.optional(
      v.union(
        v.literal("low"),
        v.literal("moderate"),
        v.literal("high"),
      ),
    ),
    skills: v.optional(v.array(v.string())),
    confidence: v.union(
      v.literal("high"),
      v.literal("medium"),
      v.literal("low"),
    ),
    startTime: v.number(),
    endTime: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("complete")),
    eventIds: v.array(v.id("events")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const actorSlugKey = args.actorEntityId ?? args.actor;
    const slug = `session-${slugify(actorSlugKey)}-${args.startTime}`;
    const existingPage = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_slug", (q) =>
        q.eq("orgId", args.orgId).eq("slug", slug),
      )
      .first();

    if (existingPage?.sessionId) {
      let existingPageEventPatch:
        | { eventCount: number; eventIds: Id<"events">[] }
        | null = null;
      const existingSession = await ctx.db.get(existingPage.sessionId);
      if (existingSession) {
        const insertedSessionEventCount = await recordSessionEventMemberships(
          ctx,
          {
            sessionId: existingSession._id,
            orgId: args.orgId,
            eventIds: args.eventIds,
            createdAt: now,
          },
        );
        if (insertedSessionEventCount > 0) {
          const eventIdSummary = boundSessionEventIds(
            mergeEventIdsPreserveOrder(
              existingSession.eventIds ?? [],
              args.eventIds,
            ),
          );
          const nextEventCount = Math.max(
            existingSession.eventCount + insertedSessionEventCount,
            eventIdSummary.length,
          );
          await ctx.db.patch(existingSession._id, {
            eventCount: nextEventCount,
            eventIds: eventIdSummary,
            ...(args.actorEntityId && !existingSession.actorEntityId
              ? { actorEntityId: args.actorEntityId }
              : {}),
          });
          existingPageEventPatch = {
            eventCount: nextEventCount,
            eventIds: eventIdSummary,
          };
        } else if (args.actorEntityId && !existingSession.actorEntityId) {
          await ctx.db.patch(existingSession._id, {
            actorEntityId: args.actorEntityId,
          });
        }
      }
      const metadataPatch: Partial<Doc<"knowledgePages">> =
        existingPageEventPatch ?? {};
      if (args.actorEntityId && existingPage.actorEntityId === undefined) {
        metadataPatch.actorEntityId = args.actorEntityId;
      }
      if (args.workType !== undefined && existingPage.workType === undefined) {
        metadataPatch.workType = args.workType;
      }
      if (
        args.complexity !== undefined &&
        existingPage.complexity === undefined
      ) {
        metadataPatch.complexity = args.complexity;
      }
      if (
        args.skills !== undefined &&
        args.skills.length > 0 &&
        (existingPage.skills === undefined || existingPage.skills.length === 0)
      ) {
        metadataPatch.skills = args.skills;
      }
      if (Object.keys(metadataPatch).length > 0) {
        const pagePatch = {
          ...metadataPatch,
          updatedAt: now,
        } satisfies Partial<KnowledgePageState>;
        const latestVersion = await ctx.db
          .query("pageVersions")
          .withIndex("by_page", (q) => q.eq("pageId", existingPage._id))
          .order("desc")
          .first();
        await ctx.db.patch(existingPage._id, pagePatch);
        await insertPageVersion(ctx, {
          pageId: existingPage._id,
          page: applyKnowledgePagePatch(existingPage, pagePatch),
          changeReason: "Updated session page metadata",
          changedBy: "system",
          version: (latestVersion?.version ?? 0) + 1,
          createdAt: now,
        });
      }
      await recordKnowledgePageEvidence(ctx, {
        pageId: existingPage._id,
        orgId: args.orgId,
        entries: args.evidenceTimeline,
        createdAt: now,
      });

      for (const eventId of args.eventIds) {
        await ctx.db.patch(eventId, { processed: true });
      }

      return {
        sessionId: existingPage.sessionId,
        knowledgePageId: existingPage._id,
        skipped: true,
      };
    }

    const candidateSessions = args.actorEntityId
      ? Array.from(
          new Map(
            [
              ...(await ctx.db
                .query("sessions")
                .withIndex("by_org_actorEntity", (q) =>
                  q
                    .eq("orgId", args.orgId)
                    .eq("actorEntityId", args.actorEntityId),
                )
                .order("desc")
                .take(25)),
              ...(await ctx.db
                .query("sessions")
                .withIndex("by_org_actor", (q) =>
                  q.eq("orgId", args.orgId).eq("actor", args.actor),
                )
                .order("desc")
                .take(25)),
            ].map((session) => [session._id, session] as const),
          ).values(),
        )
      : await ctx.db
          .query("sessions")
          .withIndex("by_org_actor", (q) =>
            q.eq("orgId", args.orgId).eq("actor", args.actor),
          )
          .order("desc")
          .take(25);
    candidateSessions.sort((left, right) => right.startTime - left.startTime);
    let continuationSession: Doc<"sessions"> | null = null;
    for (const candidateSession of candidateSessions) {
      if (candidateSession.status !== "active") {
        continue;
      }
      const latestTimestamp = await getLatestEventTimestamp(ctx, candidateSession);
      if (
        args.startTime >= latestTimestamp &&
        args.startTime - latestTimestamp <= SESSION_GAP_MS
      ) {
        continuationSession = candidateSession;
        break;
      }
    }

    if (continuationSession) {
      const continuationPage = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_sessionId", (q) =>
          q.eq("orgId", args.orgId).eq("sessionId", continuationSession._id),
        )
        .first();

      if (continuationPage) {
        const insertedSessionEventCount = await recordSessionEventMemberships(
          ctx,
          {
            sessionId: continuationSession._id,
            orgId: args.orgId,
            eventIds: args.eventIds,
            createdAt: now,
          },
        );
        const mergedEventIds = mergeEventIdsPreserveOrder(
          continuationSession.eventIds ?? [],
          args.eventIds,
        );
        const eventIdSummary = boundSessionEventIds(mergedEventIds);
        const nextEventCount = Math.max(
          continuationSession.eventCount + insertedSessionEventCount,
          eventIdSummary.length,
        );
        const mergedRepo = mergeSessionRepo(continuationSession.repo, args.repo);
        await ctx.db.patch(continuationSession._id, {
          repo: mergedRepo,
          eventCount: nextEventCount,
          eventIds: eventIdSummary,
          endTime: args.endTime,
          status: args.status,
          ...(args.actorEntityId && !continuationSession.actorEntityId
            ? { actorEntityId: args.actorEntityId }
            : {}),
        });

        const mergedSkills = dedupeStringsPreserveOrder([
          ...(continuationPage.skills ?? []),
          ...(args.skills ?? []),
        ]);
        const pagePatch = {
          title: continuationPage.title || args.title,
          compiledTruth: appendSessionContinuationText(
            continuationPage.compiledTruth,
            args.compiledTruth,
          ),
          evidenceTimeline: boundKnowledgePageEvidenceTimeline(
            mergeEvidenceTimeline(
              continuationPage.evidenceTimeline,
              args.evidenceTimeline,
            ),
          ),
          tags: dedupeStringsPreserveOrder([
            ...continuationPage.tags,
            ...args.tags,
          ]),
          confidence: continuationPage.confidence,
          actorEntityId:
            continuationPage.actorEntityId ?? args.actorEntityId,
          repo: mergedRepo,
          sessionEndTime: args.endTime,
          eventCount: nextEventCount,
          eventIds: eventIdSummary,
          workType: continuationPage.workType ?? args.workType,
          complexity: continuationPage.complexity ?? args.complexity,
          skills: mergedSkills.length > 0 ? mergedSkills : undefined,
          knowledgeBridgeStatus: "pending" as const,
          knowledgeBridgeAttemptedAt: now,
          knowledgeBridgeCompletedAt: undefined,
          knowledgeBridgeError: undefined,
          // Backdate to the activity time (newest real event), not write-time,
          // so backfilled/old sessions date to when they happened.
          lastConfirmed: args.endTime ?? args.startTime,
          updatedAt: now,
        } satisfies Partial<KnowledgePageState>;
        const latestVersion = await ctx.db
          .query("pageVersions")
          .withIndex("by_page", (q) => q.eq("pageId", continuationPage._id))
          .order("desc")
          .first();
        await ctx.db.patch(continuationPage._id, pagePatch);
        await recordKnowledgePageEvidence(ctx, {
          pageId: continuationPage._id,
          orgId: args.orgId,
          entries: args.evidenceTimeline,
          createdAt: now,
        });
        await insertPageVersion(ctx, {
          pageId: continuationPage._id,
          page: applyKnowledgePagePatch(continuationPage, pagePatch),
          changeReason: "Extended active session",
          changedBy: "system",
          version: (latestVersion?.version ?? 0) + 1,
          createdAt: now,
        });

        for (const eventId of args.eventIds) {
          await ctx.db.patch(eventId, { processed: true });
        }

        // Do NOT re-bridge on every extension. Each extension appended a
        // "## Continuation" block, changing compiledTruth and therefore the
        // session-source content hash, which defeated the by_hash source dedup
        // and minted a fresh session source + re-extraction every 5 minutes —
        // fanning duplicate "session" evidence rows across related pages. The
        // session is now bridged exactly once, when it goes stale and is closed
        // by closeStaleActiveSessions, capturing the final narrative.
        return {
          sessionId: continuationSession._id,
          knowledgePageId: continuationPage._id,
          skipped: true,
          extended: true,
        };
      }
    }

    const eventIdSummary = boundSessionEventIds(args.eventIds);
    const sessionId = await ctx.db.insert("sessions", {
      orgId: args.orgId,
      actor: args.actor,
      actorEntityId: args.actorEntityId,
      repo: args.repo,
      title: args.title,
      startTime: args.startTime,
      endTime: args.endTime,
      eventCount: args.eventIds.length,
      status: args.status,
      eventIds: eventIdSummary,
    });
    await recordSessionEventMemberships(ctx, {
      sessionId,
      orgId: args.orgId,
      eventIds: args.eventIds,
      createdAt: now,
    });
    const pageState = {
      orgId: args.orgId,
      knowledgeBaseId: args.knowledgeBaseId,
      type: "session",
      title: args.title,
      slug,
      compiledTruth: args.compiledTruth,
      evidenceTimeline: boundKnowledgePageEvidenceTimeline(args.evidenceTimeline),
      tags: args.tags,
      confidence: args.confidence,
      sessionId,
      actor: args.actor,
      actorEntityId: args.actorEntityId,
      repo: args.repo,
      sessionStartTime: args.startTime,
      sessionEndTime: args.endTime,
      eventCount: args.eventIds.length,
      eventIds: eventIdSummary,
      workType: args.workType,
      complexity: args.complexity,
      skills: args.skills,
      sourceCount: 1,
      // Backdate to the activity time (newest real event), not write-time.
      lastConfirmed: args.endTime ?? args.startTime,
      knowledgeBridgeStatus: "pending",
      knowledgeBridgeAttemptedAt: now,
      status: "active",
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
    } satisfies KnowledgePageState;
    const knowledgePageId = await ctx.db.insert("knowledgePages", pageState);
    await recordKnowledgePageEvidence(ctx, {
      pageId: knowledgePageId,
      orgId: args.orgId,
      entries: args.evidenceTimeline,
      createdAt: now,
    });
    await insertPageVersion(ctx, {
      pageId: knowledgePageId,
      page: pageState,
      changeReason: "Initial session page",
      changedBy: "system",
      version: 1,
      createdAt: now,
    });
    const kb = await ctx.db.get(args.knowledgeBaseId);
    if (kb) await ctx.db.patch(args.knowledgeBaseId, { pageCount: (kb.pageCount ?? 0) + 1 });

    for (const eventId of args.eventIds) {
      await ctx.db.patch(eventId, { processed: true });
    }

    // Bridge a brand-new session immediately only when it is already complete
    // (e.g. a backfilled / fully-past cluster). An active session is bridged
    // once later, on the active->complete transition in closeStaleActiveSessions,
    // so its narrative is captured whole rather than re-bridged on every extend.
    if (args.status === "complete") {
      await ctx.scheduler.runAfter(0, internal.knowledge.bridgeSessionToKnowledge, {
        sessionId,
        orgId: args.orgId,
      });
    }

    return { sessionId, knowledgePageId, skipped: false };
  },
});

export const getSessionsByOrg = internalQuery({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("sessions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .collect();
  },
});

export const chatEventBuckets = internalQuery({
  args: {
    orgId: v.id("orgs"),
    groupBy: v.union(v.literal("actor"), v.literal("source")),
    sinceMs: v.number(),
    untilMs: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ buckets: ChartBucketDatum[]; truncated: boolean }> => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_org", (q) =>
        q.eq("orgId", args.orgId).gte("timestamp", args.sinceMs).lt("timestamp", args.untilMs),
      )
      .order("desc")
      .take(CHAT_EVENT_SCAN_LIMIT);
    const counts = new Map<string, number>();

    for (const event of events) {
      const rawCategory = args.groupBy === "actor" ? event.actor : event.source;
      const category = rawCategory.trim() || "Unknown";
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    const buckets = [...counts.entries()]
      .map(([category, value]) => ({ category, value }))
      .sort((left, right) => right.value - left.value || left.category.localeCompare(right.category));
    return { buckets, truncated: events.length >= CHAT_EVENT_SCAN_LIMIT };
  },
});

export const chatEventTrend = internalQuery({
  args: {
    orgId: v.id("orgs"),
    sinceMs: v.number(),
    untilMs: v.number(),
    days: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ trend: ChartTrendDatum[]; truncated: boolean }> => {
    const counts = new Map<string, number>();
    for (let offset = 0; offset < args.days; offset += 1) {
      const date = new Date(args.sinceMs + offset * DAY_MS).toISOString().slice(0, 10);
      counts.set(date, 0);
    }

    const events = await ctx.db
      .query("events")
      .withIndex("by_org", (q) =>
        q.eq("orgId", args.orgId).gte("timestamp", args.sinceMs).lt("timestamp", args.untilMs),
      )
      .order("desc")
      .take(CHAT_EVENT_SCAN_LIMIT);

    for (const event of events) {
      const date = new Date(event.timestamp).toISOString().slice(0, 10);
      if (counts.has(date)) {
        counts.set(date, (counts.get(date) ?? 0) + 1);
      }
    }

    // desc + cap means the OLDEST days in range are dropped first when the scan
    // saturates, so a truncated trend systematically under-counts early days.
    const trend = [...counts.entries()].map(([date, value]) => ({ date, value }));
    return { trend, truncated: events.length >= CHAT_EVENT_SCAN_LIMIT };
  },
});

export const chatStat = internalQuery({
  args: {
    orgId: v.id("orgs"),
    metric: v.union(
      v.literal("events_this_week"),
      v.literal("sessions_this_week"),
      v.literal("active_sessions"),
      v.literal("total_events"),
    ),
    sinceMs: v.number(),
    untilMs: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ value: number; truncated: boolean }> => {
    if (args.metric === "events_this_week") {
      const events = await ctx.db
        .query("events")
        .withIndex("by_org", (q) =>
          q.eq("orgId", args.orgId).gte("timestamp", args.sinceMs).lt("timestamp", args.untilMs),
        )
        .order("desc")
        .take(CHAT_EVENT_SCAN_LIMIT);
      return {
        value: events.length,
        truncated: events.length >= CHAT_EVENT_SCAN_LIMIT,
      };
    }

    if (args.metric === "sessions_this_week") {
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_org", (q) =>
          q.eq("orgId", args.orgId).gte("startTime", args.sinceMs).lt("startTime", args.untilMs),
        )
        .order("desc")
        .take(CHAT_SESSION_SCAN_LIMIT);
      return {
        value: sessions.length,
        truncated: sessions.length >= CHAT_SESSION_SCAN_LIMIT,
      };
    }

    if (args.metric === "active_sessions") {
      const sessions = await ctx.db
        .query("sessions")
        .withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", "active"),
        )
        .order("desc")
        .take(CHAT_SESSION_SCAN_LIMIT);
      return {
        value: sessions.length,
        truncated: sessions.length >= CHAT_SESSION_SCAN_LIMIT,
      };
    }

    const events = await ctx.db
      .query("events")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(CHAT_EVENT_SCAN_LIMIT);
    return {
      value: events.length,
      truncated: events.length >= CHAT_EVENT_SCAN_LIMIT,
    };
  },
});

export const chatRecentSessions = internalQuery({
  args: {
    orgId: v.id("orgs"),
    actor: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<ChatSessionListItem[]> => {
    const limit = normalizeBoundedInteger(
      args.limit,
      CHAT_DEFAULT_SESSION_LIMIT,
      1,
      CHAT_MAX_SESSION_LIMIT,
    );
    const actor = args.actor?.trim();
    const sessions = actor
      ? await ctx.db
          .query("sessions")
          .withIndex("by_org_actor", (q) =>
            q.eq("orgId", args.orgId).eq("actor", actor),
          )
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("sessions")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .order("desc")
          .take(limit);

    return sessions.map((session) => ({
      id: session._id,
      title: session.title,
      actor: session.actor,
      project: session.repo ?? "—",
      date: new Date(session.startTime).toISOString().slice(0, 10),
      eventCount: session.eventCount,
      summary: session.title,
    }));
  },
});

export const closeStaleActiveSessions = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const staleBefore = now - SESSION_GAP_MS;
    const sessionPage = await ctx.db
      .query("sessions")
      .withIndex("by_status_startTime", (q) =>
        q.eq("status", "active").lt("startTime", staleBefore),
      )
      .paginate({
        cursor: args.cursor ?? null,
        numItems: STALE_ACTIVE_SESSION_CLOSE_BATCH_SIZE,
      });

    let closedCount = 0;
    let stillActiveCount = 0;
    let missingPageCount = 0;

    for (const session of sessionPage.page) {
      const latestTimestamp = await getLatestEventTimestamp(ctx, session);
      if (latestTimestamp >= staleBefore) {
        stillActiveCount += 1;
        continue;
      }

      await ctx.db.patch(session._id, {
        status: "complete",
        endTime: latestTimestamp,
      });

      const page = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_sessionId", (q) =>
          q.eq("orgId", session.orgId).eq("sessionId", session._id),
        )
        .first();

      if (!page) {
        missingPageCount += 1;
        closedCount += 1;
        continue;
      }

      // Bridge the now-complete session to knowledge exactly once, here, on the
      // active->complete transition. Active sessions are no longer bridged on
      // every extension (see insertSessionAndMarkEvents), so this is where a
      // worked-then-idle session reaches the KB — with its final narrative.
      const shouldBridge = page.knowledgeBridgeStatus !== "completed";
      const pagePatch = {
        sessionEndTime: latestTimestamp,
        // Backdate to the last real event in the session, not write-time.
        lastConfirmed: latestTimestamp,
        ...(shouldBridge
          ? {
              knowledgeBridgeStatus: "pending" as const,
              knowledgeBridgeAttemptedAt: now,
            }
          : {}),
        updatedAt: now,
      } satisfies Partial<KnowledgePageState>;
      const latestVersion = await ctx.db
        .query("pageVersions")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .order("desc")
        .first();
      await ctx.db.patch(page._id, pagePatch);
      await insertPageVersion(ctx, {
        pageId: page._id,
        page: applyKnowledgePagePatch(page, pagePatch),
        changeReason: "Closed stale active session",
        changedBy: "system",
        version: (latestVersion?.version ?? 0) + 1,
        createdAt: now,
      });
      if (shouldBridge) {
        // The page stays status:"active" on purpose: bridgeSessionToKnowledge
        // only runs for active session pages, and listStuckSessionPages (the
        // recovery sweep) only scans active pages, so a failed bridge here is
        // still retried. Idempotency comes from the by_hash session-source dedup
        // (content no longer changes once the session is closed).
        await ctx.scheduler.runAfter(0, internal.knowledge.bridgeSessionToKnowledge, {
          sessionId: session._id,
          orgId: session.orgId,
        });
      }
      closedCount += 1;
    }

    const scheduledContinuation =
      !sessionPage.isDone && sessionPage.continueCursor !== null;
    if (scheduledContinuation) {
      await ctx.scheduler.runAfter(0, internal.spark.closeStaleActiveSessions, {
        cursor: sessionPage.continueCursor,
        now,
      });
    }

    return {
      scannedCount: sessionPage.page.length,
      closedCount,
      stillActiveCount,
      missingPageCount,
      scheduledContinuation,
      continueCursor: sessionPage.isDone ? null : sessionPage.continueCursor,
    };
  },
});

export const insertThreadOrg = internalMutation({
  args: {
    threadId: v.string(),
    orgId: v.id("orgs"),
    userId: v.string(),
    purpose: v.union(v.literal("chat"), v.literal("pulse")),
  },
  handler: async (ctx, args) => {
    if (args.purpose === "pulse") {
      const existingPulseThread = await ctx.db
        .query("threadOrgs")
        .withIndex("by_org_purpose_user", (q) =>
          q.eq("orgId", args.orgId).eq("purpose", "pulse").eq("userId", args.userId),
        )
        .first();
      if (existingPulseThread) {
        return {
          threadOrgId: existingPulseThread._id,
          threadId: existingPulseThread.threadId,
          purpose: existingPulseThread.purpose,
          reused: true,
        } satisfies ThreadOrgMappingResult;
      }
    }

    const threadOrgId = await ctx.db.insert("threadOrgs", {
      threadId: args.threadId,
      orgId: args.orgId,
      userId: args.userId,
      purpose: args.purpose,
      createdAt: Date.now(),
    });

    return {
      threadOrgId,
      threadId: args.threadId,
      purpose: args.purpose,
      reused: false,
    } satisfies ThreadOrgMappingResult;
  },
});

export const getPulseThread = internalQuery({
  args: {
    orgId: v.id("orgs"),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("threadOrgs")
      .withIndex("by_org_purpose_user", (q) =>
        q.eq("orgId", args.orgId).eq("purpose", "pulse").eq("userId", args.userId),
      )
      .first();
  },
});

async function assertThreadAccess(
  ctx: AuthLookupContext & { db: QueryCtx["db"] },
  threadId: string,
): Promise<ThreadAccess> {
  const orgId = await getOrgIdFromAuth(ctx);
  const userId = await getUserIdFromAuth(ctx);
  const threadOrg = await ctx.db
    .query("threadOrgs")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .first();

  if (!threadOrg || threadOrg.orgId !== orgId || threadOrg.userId !== userId) {
    throw new Error("AUTH: thread not found for this org/user");
  }

  return { orgId, userId, threadOrg };
}

export const getThreadsForUser = orgQuery({
  args: {
    paginationOpts: v.optional(paginationOptsValidator),
  },
  handler: async (ctx, args): Promise<PaginationResult<ThreadListItem>> => {
    const userId = await getUserIdFromAuth(ctx);
    const requestedPageSize = args.paginationOpts?.numItems;
    const normalizedPageSize = Math.trunc(
      requestedPageSize ?? THREADS_FOR_USER_DEFAULT_PAGE_SIZE,
    );
    const numItems = Number.isFinite(normalizedPageSize)
      ? Math.max(1, Math.min(normalizedPageSize, THREADS_FOR_USER_MAX_PAGE_SIZE))
      : THREADS_FOR_USER_DEFAULT_PAGE_SIZE;
    const page = await ctx.db
      .query("threadOrgs")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", ctx.orgId).eq("userId", userId),
      )
      .order("desc")
      .paginate({
        ...(args.paginationOpts ?? {}),
        cursor: args.paginationOpts?.cursor ?? null,
        numItems,
      });

    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (threadOrg) => {
          // Prefer the stored title (AI-generated / renamed); fall back to the
          // first message only while a thread is still untitled.
          const preview =
            threadOrg.title ??
            toThreadPreview(
              await getThreadFirstUserMessageText(ctx, threadOrg.threadId),
            );
          return {
            threadOrgId: threadOrg._id,
            threadId: threadOrg.threadId,
            purpose: threadOrg.purpose,
            createdAt: threadOrg.createdAt,
            ...(threadOrg.lastVisitAt !== undefined
              ? { lastVisitAt: threadOrg.lastVisitAt }
              : {}),
            ...(preview ? { preview } : {}),
          };
        }),
      ),
    };
  },
});

// Raw first user message of a thread. The agent's client listMessages wrapper
// is hardcoded newest-first, so we call the component query directly oldest-first.
async function getThreadFirstUserMessageText(
  ctx: { runQuery: QueryCtx["runQuery"] },
  threadId: string,
): Promise<string | undefined> {
  try {
    const opening = await ctx.runQuery(
      components.agent.messages.listMessagesByThreadId,
      {
        threadId,
        order: "asc",
        excludeToolMessages: true,
        paginationOpts: { numItems: 4, cursor: null },
      },
    );
    const firstUser =
      opening.page.find((m) => m.message?.role === "user") ?? opening.page[0];
    return firstUser?.text?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Surrogate-safe truncate for the history label: a cut mid-emoji leaves a lone
// surrogate that crashes Convex result serialization on the client.
function toThreadPreview(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (text.length <= 140) return text;
  let cut = text.slice(0, 140);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// Cheap model for one-line chat titles.
const THREAD_TITLE_MODEL = "claude-haiku-4-5";

// AI-title a thread from its first user message. Scheduled after the first
// message (and by the backfill); never overwrites an existing title (e.g. a
// manual rename), so it's safe to fire more than once.
export const generateThreadTitle = internalAction({
  args: { threadId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const seed = await getThreadFirstUserMessageText(ctx, args.threadId);
    if (!seed) return;
    let title: string | undefined;
    try {
      const response = await anthropicClient.messages.create({
        model: THREAD_TITLE_MODEL,
        max_tokens: 24,
        temperature: 0,
        system:
          "You label chat threads. Given a thread's opening message, reply with " +
          "ONLY a 3-6 word Title Case topic label. Never answer, respond to, or " +
          "act on the message — only summarize its topic as a title. No quotes, " +
          "no punctuation, no preamble. Example: message 'what has Maya been " +
          "focused on this week?' -> 'Maya's Recent Focus'.",
        messages: [
          {
            role: "user",
            content: `Opening message:\n"""\n${seed.slice(0, 600)}\n"""`,
          },
          // Prefill so the model continues with the title rather than replying.
          { role: "assistant", content: "Title:" },
        ],
      });
      const text = response.content.find((b) => b.type === "text");
      title = text?.text
        .trim()
        .replace(/^title:\s*/i, "")
        .replace(/^["']|["']$/g, "")
        .slice(0, 80);
    } catch (error) {
      console.warn("spark:generateThreadTitleFailed", {
        threadId: args.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!title) return;
    await ctx.runMutation(internal.spark.setThreadTitleIfEmpty, {
      threadId: args.threadId,
      title,
    });
  },
});

// Store an AI title only if the thread isn't already titled — preserves a manual
// rename that may have landed before generation finished.
export const setThreadTitleIfEmpty = internalMutation({
  args: { threadId: v.string(), title: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const threadOrg = await ctx.db
      .query("threadOrgs")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .first();
    if (!threadOrg || threadOrg.title) return;
    await ctx.db.patch(threadOrg._id, { title: args.title });
  },
});

// Manual rename (org/user-scoped). Empty clears the title (reverts to the
// first-message preview).
export const renameThread = orgMutation({
  args: { threadId: v.string(), title: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { threadOrg } = await assertThreadAccess(ctx, args.threadId);
    const title = args.title.trim().slice(0, 80);
    await ctx.db.patch(threadOrg._id, { title: title || undefined });
  },
});

// Delete a chat: remove the threadOrg (drops it from history immediately) and
// schedule cleanup of the agent thread + its messages.
export const deleteThread = orgMutation({
  args: { threadId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { threadOrg } = await assertThreadAccess(ctx, args.threadId);
    await ctx.db.delete(threadOrg._id);
    await ctx.scheduler.runAfter(0, internal.spark.cleanupAgentThread, {
      threadId: args.threadId,
    });
  },
});

// Best-effort deletion of the agent thread + all its messages/streams. Runs
// async after deleteThread; a failure just leaves orphaned agent data.
export const cleanupAgentThread = internalAction({
  args: { threadId: v.string() },
  handler: async (ctx, args): Promise<void> => {
    try {
      await ctx.runAction(components.agent.threads.deleteAllForThreadIdSync, {
        threadId: args.threadId,
      });
    } catch (error) {
      console.warn("spark:cleanupAgentThreadFailed", {
        threadId: args.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

export const listThreadMessages = orgQuery({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    await assertThreadAccess(ctx, args.threadId);
    const streams = await sparkChat.syncStreams(ctx, {
      threadId: args.threadId,
      streamArgs: args.streamArgs,
    });
    const paginated = await sparkChat.listMessages(ctx, {
      threadId: args.threadId,
      paginationOpts: args.paginationOpts,
    });
    return { ...paginated, streams };
  },
});


// --- Pulse (U-41/U-42): the briefing is a pre-prompted chat thread -----------

const PULSE_STALE_MS = 30 * 60 * 1000;

// The CEO briefing prompt (spec/ux/pulse.md). Same agent, same tools, same
// Report Model — only the question is system-generated.
function buildPulseBriefingPrompt(args: { sinceMs?: number }): string {
  const sinceLine = args.sinceMs
    ? `since ${new Date(args.sinceMs).toISOString()}`
    : "since the last briefing";
  return [
    "You are delivering the intelligence briefing for this organization.",
    "Using the org's knowledge base and live data tools, answer four questions:",
    "",
    `1. WHAT changed ${sinceLine}?`,
    "2. WHY are the most important changes happening?",
    "3. SO WHAT — implications? What's at risk? What's emerging?",
    "4. NOW WHAT — what needs attention? What decision is waiting? What",
    "   questions should the reader be asking?",
    "",
    "Lead with the most important thing. Be opinionated — you have a point of",
    "view. Use inline widgets for evidence. This is a briefing, not a data",
    "dump. Cite knowledge pages by title. If findings exist (searchKnowledge",
    'with the finding type), weave the high-severity ones into the narrative.',
  ].join("\n");
}

// Refresh the caller's Pulse thread: if the latest message is older than the
// staleness window (or force=true), save the system-generated briefing prompt
// and schedule the same streaming generation path as any chat reply (U-42).
// lastVisitAt advances so the next briefing knows the "since" boundary.
export const refreshPulse = orgMutation({
  args: {
    threadId: v.string(),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ refreshed: boolean; lastMessageAt: number | null }> => {
    const { threadOrg } = await assertThreadAccess(ctx, args.threadId);
    if (threadOrg.purpose !== "pulse") {
      throw new Error("BAD_REQUEST: refreshPulse requires a pulse thread");
    }

    const latest = await ctx.runQuery(
      components.agent.messages.listMessagesByThreadId,
      {
        threadId: args.threadId,
        order: "desc",
        excludeToolMessages: true,
        paginationOpts: { numItems: 1, cursor: null },
      },
    );
    const lastMessageAt = latest.page[0]?._creationTime ?? null;
    const now = Date.now();
    const stale =
      lastMessageAt === null || now - lastMessageAt > PULSE_STALE_MS;

    if (!stale && !args.force) {
      return { refreshed: false, lastMessageAt };
    }

    const { messageId } = await sparkChat.saveMessage(ctx, {
      threadId: args.threadId,
      prompt: buildPulseBriefingPrompt({ sinceMs: threadOrg.lastVisitAt }),
    });
    await ctx.scheduler.runAfter(0, internal.spark.streamChatResponse, {
      threadId: args.threadId,
      promptMessageId: messageId,
    });
    await ctx.db.patch(threadOrg._id, { lastVisitAt: now });
    return { refreshed: true, lastMessageAt };
  },
});

export const sendMessage = orgMutation({
  args: {
    threadId: v.string(),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    const { threadOrg } = await assertThreadAccess(ctx, args.threadId);
    const { messageId } = await sparkChat.saveMessage(ctx, {
      threadId: args.threadId,
      prompt: args.prompt,
    });

    await ctx.scheduler.runAfter(0, internal.spark.streamChatResponse, {
      threadId: args.threadId,
      promptMessageId: messageId,
    });

    // First message of an untitled thread → AI-title it for the history list.
    if (!threadOrg.title) {
      await ctx.scheduler.runAfter(0, internal.spark.generateThreadTitle, {
        threadId: args.threadId,
      });
    }

    return { messageId };
  },
});

export const streamChatResponse = internalAction({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    // This scheduled action is the single entry point for every chat reply. A
    // model/tool/stream failure here rejects silently in the background and the
    // client is left with a partial message that never completes. Guard it: log
    // for diagnosis and persist a fallback assistant message so the UI renders
    // an error state instead of hanging.
    try {
      const { thread } = await sparkChat.continueThread(ctx, {
        threadId: args.threadId,
      });
      const result = await thread.streamText(
        // stopWhen lets the model take follow-up steps AFTER a tool call so it
        // synthesizes a grounded answer instead of stopping at the tool/widget
        // output (the AI SDK default stops after the first step).
        { promptMessageId: args.promptMessageId, stopWhen: stepCountIs(8) },
        // Word-level deltas (throttled) make the client stream read smoothly
        // instead of arriving in coarse bursts; pairs with useSmoothText.
        { saveStreamDeltas: { chunking: "word", throttleMs: 100 } },
      );
      await result.consumeStream();
    } catch (error) {
      console.error("spark:streamChatResponse", {
        threadId: args.threadId,
        promptMessageId: args.promptMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await sparkChat.saveMessage(ctx, {
          threadId: args.threadId,
          message: {
            role: "assistant",
            content:
              "Sorry — something went wrong generating a response. Please try again.",
          },
        });
      } catch (saveError) {
        console.error("spark:streamChatResponse:fallback", {
          threadId: args.threadId,
          promptMessageId: args.promptMessageId,
          error:
            saveError instanceof Error ? saveError.message : String(saveError),
        });
      }
    }
  },
});

export const createThreadForUser = action({
  args: {
    purpose: v.optional(v.union(v.literal("chat"), v.literal("pulse"))),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ threadId: string; reused: boolean }> => {
    const orgId = await getOrgIdFromAuth(ctx);
    const userId = await getUserIdFromAuth(ctx);
    const purpose = args.purpose ?? "chat";

    if (purpose === "pulse") {
      const existingThread = await ctx.runQuery(internal.spark.getPulseThread, {
        orgId,
        userId,
      }) as Doc<"threadOrgs"> | null;
      if (existingThread) {
        return { threadId: existingThread.threadId, reused: true };
      }
    }

    const { thread } = await sparkChat.createThread(ctx, { userId });
    const createdThreadId = thread.threadId;
    const mapping = await ctx.runMutation(insertThreadOrgRef, {
      threadId: createdThreadId,
      orgId,
      userId,
      purpose,
    });

    if (mapping.reused && mapping.threadId !== createdThreadId) {
      await sparkChat.deleteThreadAsync(ctx, { threadId: createdThreadId });
    }

    return { threadId: mapping.threadId, reused: mapping.reused };
  },
});

export const createComposioConnectLink = action({
  args: {
    toolkit: v.string(),
    callbackUrl: v.optional(v.string()),
  },
  handler: async (
    ctx: ActionCtx,
    args: { toolkit: string; callbackUrl?: string },
  ): Promise<unknown> => {
    const orgId = await requireIntegrationAdminOrgIdFromAuth(ctx);
    return ctx.runAction(internal.composio.createConnectLinkForOrg, {
      orgId,
      toolkit: args.toolkit,
      callbackUrl: args.callbackUrl,
    });
  },
});

// Typed refs for composio delegates (makeFunctionReference breaks the
// spark ↔ composio type cycle that forced the loose delegate wrappers).
const listConnectedToolkitsForOrgRef = makeFunctionReference<
  "action",
  { orgId: OrgId },
  unknown
>("composio:listConnectedToolkitsForOrg");
const disconnectToolkitForOrgRef = makeFunctionReference<
  "action",
  { orgId: OrgId; toolkit: string },
  { disconnected: number; triggersDeleted: number }
>("composio:disconnectToolkitForOrg");
const listWatchedAsanaProjectsForOrgRef = makeFunctionReference<
  "action",
  { orgId: OrgId },
  unknown
>("composio:listWatchedAsanaProjectsForOrg");
const listAvailableAsanaProjectsForOrgRef = makeFunctionReference<
  "action",
  { orgId: OrgId },
  unknown
>("composio:listAvailableAsanaProjectsForOrg");
const listAvailableSlackChannelsForOrgRef = makeFunctionReference<
  "action",
  { orgId: OrgId },
  unknown
>("composio:listAvailableSlackChannelsForOrg");
const listWatchedSlackChannelsForOrgRef = makeFunctionReference<
  "action",
  { orgId: OrgId },
  unknown
>("composio:listWatchedSlackChannelsForOrg");
const syncWatchedSlackChannelsForOrgRef = makeFunctionReference<
  "action",
  { orgId: OrgId; channelIds: string[] },
  unknown
>("composio:syncWatchedSlackChannelsForOrg");
const syncWatchedAsanaProjectsForOrgRef = makeFunctionReference<
  "action",
  { orgId: OrgId; projectGids: string[] },
  unknown
>("composio:syncWatchedAsanaProjectsForOrg");

export const listConnectedToolkits = delegateForOrg({}, listConnectedToolkitsForOrgRef);

export const disconnectToolkit = delegateForIntegrationAdminOrg({ toolkit: v.string() }, disconnectToolkitForOrgRef);

export const getGithubInstallation = orgQuery({
  args: {},
  handler: async (ctx) => {
    const org = await ctx.db.get(ctx.orgId);
    return { installationId: org?.githubInstallationId ?? null };
  },
});

function validateGithubInstallationId(installationId: number): number {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("BAD_REQUEST: GitHub installationId must be a positive integer");
  }
  return installationId;
}


// --- GitHub App install flow (Pipe 1a onboarding) -----------------------------
//
// createGithubInstallLink issues an install URL whose `state` is a signed,
// short-TTL org token. GitHub carries `state` through to the app's Setup URL
// (POST-install redirect), so /github/setup can link installation.id to the
// issuing org without a logged-in session on the callback — the signature IS
// the authorization, minted only for integration admins.

const GITHUB_INSTALL_STATE_TTL_MS = 30 * 60 * 1000;

type GithubInstallStatePayload = {
  kind: "github-install";
  orgId: OrgId;
  exp: number;
  jti: string;
};

async function buildGithubInstallState(orgId: OrgId): Promise<string> {
  const signingSecret = getManagedMcpSigningSecret();
  if (!signingSecret) {
    throw new Error("CONFIG: SPARK_MCP_SIGNING_SECRET is not configured");
  }
  const payload: GithubInstallStatePayload = {
    kind: "github-install",
    orgId,
    exp: Date.now() + GITHUB_INSTALL_STATE_TTL_MS,
    jti: crypto.randomUUID(),
  };
  const payloadJson = JSON.stringify(payload);
  const signature = await signHmacSha256(signingSecret, payloadJson);
  return `${base64EncodeText(payloadJson)}.${signature}`;
}

export async function verifyGithubInstallState(state: string): Promise<OrgId> {
  const signingSecret = getManagedMcpSigningSecret();
  if (!signingSecret) {
    throw new Error("AUTH: signing secret is not configured");
  }
  const [encodedPayload, providedSignature, ...rest] = state.trim().split(".");
  if (!encodedPayload || !providedSignature || rest.length > 0) {
    throw new Error("AUTH: invalid install state");
  }
  const payloadJson = base64DecodeText(encodedPayload);
  const expectedSignature = await signHmacSha256(signingSecret, payloadJson);
  if (!constantTimeEquals(expectedSignature, providedSignature)) {
    throw new Error("AUTH: invalid install state signature");
  }
  const payload = JSON.parse(payloadJson) as GithubInstallStatePayload;
  if (payload.kind !== "github-install" || typeof payload.orgId !== "string") {
    throw new Error("AUTH: invalid install state payload");
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    throw new Error("AUTH: install state expired");
  }
  return payload.orgId;
}

export const createGithubInstallLink = action({
  args: {},
  handler: async (ctx: ActionCtx): Promise<{ url: string }> => {
    const orgId = await requireIntegrationAdminOrgIdFromAuth(ctx);
    const appSlug = process.env.GITHUB_APP_SLUG;
    if (!appSlug) {
      throw new Error("CONFIG: GITHUB_APP_SLUG is not configured");
    }
    const state = await buildGithubInstallState(orgId);
    return {
      url: `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`,
    };
  },
});

// Callback-side linking with the same validation + cross-org conflict rules as
// the manual integration-admin path.
export const linkGithubInstallationFromCallback = internalMutation({
  args: {
    orgId: v.id("orgs"),
    installationId: v.number(),
  },
  handler: async (ctx, args): Promise<{ installationId: number }> => {
    const installationId = validateGithubInstallationId(args.installationId);
    const linkedOrgs = await ctx.db
      .query("orgs")
      .withIndex("by_githubInstallationId", (q) =>
        q.eq("githubInstallationId", installationId),
      )
      .take(2);
    const conflictingOrg = linkedOrgs.find((org) => org._id !== args.orgId);
    if (conflictingOrg) {
      throw new Error(
        "BAD_REQUEST: GitHub installation is already linked to another org",
      );
    }
    await ctx.db.patch(args.orgId, { githubInstallationId: installationId });
    return { installationId };
  },
});

export const linkGithubInstallation = integrationAdminMutation({
  args: { installationId: v.number() },
  handler: async (ctx, args) => {
    const installationId = validateGithubInstallationId(args.installationId);
    const linkedOrgs = await ctx.db
      .query("orgs")
      .withIndex("by_githubInstallationId", (q) =>
        q.eq("githubInstallationId", installationId),
      )
      .take(2);
    const conflictingOrg = linkedOrgs.find((org) => org._id !== ctx.orgId);
    if (conflictingOrg) {
      throw new Error("BAD_REQUEST: GitHub installation is already linked to another org");
    }

    await ctx.db.patch(ctx.orgId, {
      githubInstallationId: installationId,
    });
    return { installationId };
  },
});

export const unlinkGithubInstallation = integrationAdminMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(ctx.orgId, { githubInstallationId: undefined });
    return { ok: true };
  },
});

export const listWatchedAsanaProjects = delegateForOrg({}, listWatchedAsanaProjectsForOrgRef);

export const listAvailableAsanaProjects = delegateForOrg({}, listAvailableAsanaProjectsForOrgRef);

const RESOLVE_IDENTITIES_MAX_REFS = 500;

export const resolveIdentities = action({
  args: {
    refs: v.array(v.object({ source: v.string(), gid: v.string() })),
  },
  handler: async (
    ctx: ActionCtx,
    args: { refs: Array<{ source: string; gid: string }> },
  ): Promise<
    Array<{
      source: string;
      gid: string;
      name: string | null;
      photoUrl: string | null;
    }>
  > => {
    const orgId = await getOrgIdFromAuth(ctx);
    // resolveIdentitiesForOrg issues one external Composio fetch per uncached
    // ref, so an oversized client array could fan out into thousands of serial
    // calls. The real caller passes a de-duped, page-sized set well under this
    // cap; clamp (and log) anything larger.
    const refs = args.refs.slice(0, RESOLVE_IDENTITIES_MAX_REFS);
    if (args.refs.length > RESOLVE_IDENTITIES_MAX_REFS) {
      console.warn("spark:resolveIdentities:clamped", {
        orgId,
        requested: args.refs.length,
        cap: RESOLVE_IDENTITIES_MAX_REFS,
      });
    }
    return ctx.runAction(internal.ingest.resolveIdentitiesForOrg, {
      orgId,
      refs,
    });
  },
});

// Single entity detail — canonical identity plus linked source aliases,
// org-scoped check on read.
export const getEntity = orgQuery({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
    const entity = await ctx.db.get(args.entityId);
    if (!entity || entity.orgId !== ctx.orgId) {
      return null;
    }

    const aliases = await ctx.db
      .query("identityCache")
      .withIndex("by_entity", (q) => q.eq("entityId", args.entityId))
      .collect();

    return {
      _id: entity._id,
      displayName: entity.displayName,
      photoUrl: entity.photoUrl ?? null,
      emails: entity.emails,
      kind: entity.kind,
      aliases: aliases.map((alias) => ({
        source: alias.source,
        gid: alias.gid,
        name: alias.name ?? null,
        photoUrl: alias.photoUrl ?? null,
      })),
    };
  },
});

// Entity typeahead — name-substring match over the org's entities, optionally
// scoped to a kind. Powers the Home "who" slot. (Promoted from playground.ts so
// a frontend-facing query lives in core, like getEntity.)
export const searchEntities = orgQuery({
  args: {
    query: v.optional(v.string()),
    kind: v.optional(
      v.union(
        v.literal("person"),
        v.literal("project"),
        v.literal("bot"),
        v.literal("system"),
        v.literal("shared"),
        v.literal("unknown"),
      ),
    ),
    excludeId: v.optional(v.id("entities")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("entities")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .take(500);
    const needle = (args.query ?? "").trim().toLowerCase();
    const max = normalizeBoundedInteger(args.limit, 20, 1, 100);
    const out: Array<{
      _id: Id<"entities">;
      displayName: string;
      kind: string;
      photoUrl: string | null;
    }> = [];
    for (const entity of all) {
      if (args.excludeId && entity._id === args.excludeId) {
        continue;
      }
      if (args.kind && entity.kind !== args.kind) {
        continue;
      }
      if (needle && !entity.displayName.toLowerCase().includes(needle)) {
        continue;
      }
      out.push({
        _id: entity._id,
        displayName: entity.displayName,
        kind: entity.kind,
        photoUrl: entity.photoUrl ?? null,
      });
      if (out.length >= max) {
        break;
      }
    }
    return out;
  },
});

// Suggested duplicate people for the merge UI. Email/team-member duplicates are
// merged automatically (deterministic); this surfaces the NON-deterministic
// long tail a human should confirm: person entities that share a normalized
// display name or the same photo. Read-only — the UI calls mergeEntityInto on
// confirm. Raw "source:gid" placeholder names are skipped (not real names).
export const suggestEntityDuplicates = orgQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const people = (
      await ctx.db
        .query("entities")
        .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
        .take(2000)
    ).filter((e) => e.kind === "person");

    const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const byName = new Map<string, typeof people>();
    const byPhoto = new Map<string, typeof people>();
    for (const e of people) {
      const nk = normName(e.displayName);
      if (nk.length > 0 && !/^[a-z0-9_-]+:/.test(nk)) {
        byName.set(nk, [...(byName.get(nk) ?? []), e]);
      }
      if (e.photoUrl) {
        byPhoto.set(e.photoUrl, [...(byPhoto.get(e.photoUrl) ?? []), e]);
      }
    }

    const summarize = (e: Doc<"entities">) => ({
      _id: e._id,
      displayName: e.displayName,
      photoUrl: e.photoUrl ?? null,
      emails: e.emails,
      teamMemberLinked: Boolean(e.teamMemberId),
    });
    const groups: Array<{
      reason: "name" | "photo";
      key: string;
      entities: ReturnType<typeof summarize>[];
    }> = [];
    for (const [key, arr] of byName) {
      if (arr.length > 1) groups.push({ reason: "name", key, entities: arr.map(summarize) });
    }
    for (const [key, arr] of byPhoto) {
      if (arr.length > 1) groups.push({ reason: "photo", key, entities: arr.map(summarize) });
    }
    const max = normalizeBoundedInteger(args.limit, 50, 1, 200);
    return groups.slice(0, max);
  },
});

export const listAvailableSlackChannels = delegateForOrg({}, listAvailableSlackChannelsForOrgRef);

export const listWatchedSlackChannels = delegateForOrg({}, listWatchedSlackChannelsForOrgRef);

export const syncWatchedSlackChannels = delegateForIntegrationAdminOrg({ channelIds: v.array(v.string()) }, syncWatchedSlackChannelsForOrgRef);

export const syncWatchedAsanaProjects = delegateForIntegrationAdminOrg({ projectGids: v.array(v.string()) }, syncWatchedAsanaProjectsForOrgRef);

export const extractionFanOut = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let scheduled = 0;

    const orgCount = await forEachOrgIdPage(ctx, async (orgId) => {
      const hasWork = await ctx.runQuery(
        internal.spark.hasClaimableUnprocessedEvents,
        {
          orgId,
          now,
        },
      );
      if (!hasWork) {
        return;
      }

      await ctx.scheduler.runAfter(0, internal.spark.runExtractor, { orgId });
      scheduled += 1;
    });

    return { scheduled, orgCount };
  },
});

export const runExtractor = internalAction({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ sessionCount: number; eventCount: number }> => {
    const claimed = (await ctx.runMutation(internal.spark.claimUnprocessedEvents, {
      orgId: args.orgId,
    })) as { eventIds: Id<"events">[]; count: number };

    if (claimed.count === 0) {
      return { sessionCount: 0, eventCount: 0 };
    }

    const events = (await ctx.runQuery(internal.spark.getEventsByIds, {
      eventIds: claimed.eventIds,
    })) as Doc<"events">[];
    const clusters = clusterEventsIntoSessions(events, Date.now());
    const { knowledgeBaseId } = await ctx.runMutation(
      internal.knowledge.ensureKnowledgeBase,
      {
        orgId: args.orgId,
      },
    );
    let sessionCount = 0;

    for (const cluster of clusters) {
      // Drop low-signal noise clusters (any tool) before the (LLM) enrichment so
      // they never become a session page. Mark them processed so the extractor
      // does not re-claim them next pass.
      if (isNoiseCluster(cluster.events)) {
        await ctx.runMutation(internal.spark.markEventsProcessed, {
          eventIds: cluster.events.map((event) => event._id),
        });
        continue;
      }

      let enrichment: SessionEnrichment;
      try {
        enrichment = await enrichSessionCluster({
          cluster,
          orgId: args.orgId,
          sessionCount: clusters.length,
        });
        // Persist enrichment usage (A-11, source: extractor). Fail-soft.
        try {
          await ctx.runMutation(internal.usage.recordUsage, {
            orgId: args.orgId,
            source: "extractor",
            model: "claude-sonnet-4-6",
            inputTokens: enrichment.usage.promptTokens ?? 0,
            outputTokens: enrichment.usage.completionTokens ?? 0,
            cacheReadInputTokens: getNestedNumber(enrichment.providerMetadata, [
              "anthropic",
              "cacheReadInputTokens",
            ]),
            cacheCreationInputTokens: getNestedNumber(
              enrichment.providerMetadata,
              ["anthropic", "cacheCreationInputTokens"],
            ),
            costCents: calculateCostCents(
              "claude-sonnet-4-6",
              enrichment.usage,
              enrichment.providerMetadata,
            ),
          });
        } catch (usageError) {
          console.warn("spark:usageRecordFailed", {
            source: "extractor",
            error: String(usageError),
          });
        }
      } catch (err) {
        console.warn("spark:enrichment-failed", {
          orgId: args.orgId,
          actor: cluster.actor,
          eventCount: cluster.events.length,
          error: String(err),
        });
        await ctx.runMutation(internal.spark.unclaimEvents, {
          eventIds: cluster.events.map((event) => event._id),
        });
        continue;
      }

      const insertResult = await ctx.runMutation(
        internal.spark.insertSessionAndMarkEvents,
        {
          orgId: args.orgId,
          knowledgeBaseId,
          actor: cluster.actor,
          actorEntityId: cluster.actorEntityId,
          repo: cluster.repo,
          title: enrichment.title,
          compiledTruth: enrichment.compiledTruth,
          // Collapse byte-identical rows (e.g. a burst of "notes changed on X"
          // Asana stories) to one per real change before they reach the page
          // timeline. Events are sorted oldest-first, so the kept row dates to
          // when the change first happened.
          evidenceTimeline: dedupeEvidenceEntries(
            cluster.events.map((event) => ({
              source: event.actor,
              channel: event.source,
              timestamp: event.timestamp,
              content: event.summary,
            })),
          ),
          tags: enrichment.tags,
          workType: enrichment.workType,
          complexity: enrichment.complexity,
          skills: enrichment.skills,
          confidence: enrichment.confidence,
          startTime: cluster.startTime,
          endTime: cluster.endTime,
          status: cluster.status,
          eventIds: cluster.events.map((event) => event._id),
        },
      );

      if (!insertResult.skipped) {
        sessionCount += 1;
      }
    }

    return { sessionCount, eventCount: events.length };
  },
});

export const getOrgById = internalQuery({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) {
      throw new Error("BAD_REQUEST: org not found");
    }
    return org;
  },
});

export const upsertTeamMember = internalMutation({
  args: {
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    clerkMembershipId: v.string(),
    clerkEventTimestamp: v.number(),
    name: v.string(),
    email: v.string(),
    role: v.union(
      v.literal("admin"),
      v.literal("member"),
      v.literal("viewer"),
    ),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();
    if (!org) {
      return;
    }

    const syncState = await ctx.db
      .query("clerkMembershipSyncStates")
      .withIndex("by_clerkOrg_user", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", args.clerkUserId),
      )
      .first();
    if (
      syncState &&
      (syncState.sourceUpdatedAt > args.clerkEventTimestamp ||
        (syncState.status === "deleted" &&
          syncState.sourceUpdatedAt >= args.clerkEventTimestamp))
    ) {
      return;
    }

    if (syncState) {
      await ctx.db.patch(syncState._id, {
        orgId: org._id,
        clerkMembershipId: args.clerkMembershipId,
        status: "active",
        sourceUpdatedAt: args.clerkEventTimestamp,
      });
    } else {
      await ctx.db.insert("clerkMembershipSyncStates", {
        orgId: org._id,
        clerkOrgId: args.clerkOrgId,
        clerkUserId: args.clerkUserId,
        clerkMembershipId: args.clerkMembershipId,
        status: "active",
        sourceUpdatedAt: args.clerkEventTimestamp,
      });
    }

    const existingMember = await ctx.db
      .query("teamMembers")
      .withIndex("by_org_clerkUser", (q) =>
        q.eq("orgId", org._id).eq("clerkUserId", args.clerkUserId),
      )
      .first();

    // Lowercase so the by_org_email join with alias emails (also normalized) is
    // case-insensitive.
    const memberEmail = normalizeEmail(args.email) ?? args.email;
    if (existingMember) {
      await ctx.db.patch(existingMember._id, {
        name: args.name,
        email: memberEmail,
        role: args.role,
        clerkMembershipId: args.clerkMembershipId,
        clerkMembershipUpdatedAt: args.clerkEventTimestamp,
      });
      return;
    }

    await ctx.db.insert("teamMembers", {
      orgId: org._id,
      clerkUserId: args.clerkUserId,
      name: args.name,
      email: memberEmail,
      role: args.role,
      clerkMembershipId: args.clerkMembershipId,
      clerkMembershipUpdatedAt: args.clerkEventTimestamp,
    });
  },
});

export const deleteTeamMember = internalMutation({
  args: {
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    clerkMembershipId: v.string(),
    clerkEventTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();
    if (!org) {
      return;
    }

    const syncState = await ctx.db
      .query("clerkMembershipSyncStates")
      .withIndex("by_clerkOrg_user", (q) =>
        q.eq("clerkOrgId", args.clerkOrgId).eq("clerkUserId", args.clerkUserId),
      )
      .first();
    if (syncState && syncState.sourceUpdatedAt > args.clerkEventTimestamp) {
      return;
    }

    if (syncState) {
      await ctx.db.patch(syncState._id, {
        orgId: org._id,
        clerkMembershipId: args.clerkMembershipId,
        status: "deleted",
        sourceUpdatedAt: args.clerkEventTimestamp,
      });
    } else {
      await ctx.db.insert("clerkMembershipSyncStates", {
        orgId: org._id,
        clerkOrgId: args.clerkOrgId,
        clerkUserId: args.clerkUserId,
        clerkMembershipId: args.clerkMembershipId,
        status: "deleted",
        sourceUpdatedAt: args.clerkEventTimestamp,
      });
    }

    const member = await ctx.db
      .query("teamMembers")
      .withIndex("by_org_clerkUser", (q) =>
        q.eq("orgId", org._id).eq("clerkUserId", args.clerkUserId),
      )
      .first();

    if (member) {
      await ctx.db.delete(member._id);
    }
  },
});

export const debugIntegrationAdminAuthProof = internalMutation({
  args: {
    caseName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caseName = args.caseName ?? "integration-admin-auth-proof";
    const slug = caseName.replace(/[^a-zA-Z0-9:_-]/g, "-");
    const clerkOrgId = `debug:${slug}`;
    const clerkUserId = `user_${slug.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const results: Array<{
      case: string;
      expected: "allow" | "deny";
      actual: "allow" | "deny";
      error?: string;
    }> = [];
    let orgId: OrgId | null = null;

    async function cleanupOrg(targetOrgId: OrgId) {
      const members = await ctx.db
        .query("teamMembers")
        .withIndex("by_org", (q) => q.eq("orgId", targetOrgId))
        .collect();
      for (const member of members) {
        await ctx.db.delete(member._id);
      }
      await ctx.db.delete(targetOrgId);
    }

    async function cleanupExisting() {
      const existing = await ctx.db
        .query("orgs")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
        .first();
      if (existing) {
        await cleanupOrg(existing._id);
      }
    }

    async function setMemberRole(role: Doc<"teamMembers">["role"] | null) {
      if (!orgId) {
        throw new Error("debug proof org not initialized");
      }
      const existing = await ctx.db
        .query("teamMembers")
        .withIndex("by_org_clerkUser", (q) =>
          q.eq("orgId", orgId as OrgId).eq("clerkUserId", clerkUserId),
        )
        .first();

      if (role === null) {
        if (existing) {
          await ctx.db.delete(existing._id);
        }
        return;
      }

      if (existing) {
        await ctx.db.patch(existing._id, { role });
        return;
      }

      await ctx.db.insert("teamMembers", {
        orgId,
        clerkUserId,
        name: "Integration Admin Auth Proof",
        email: "integration-admin-auth-proof@example.test",
        role,
      });
    }

    function identity(extra: Record<string, unknown> = {}) {
      return {
        org_id: clerkOrgId,
        subject: clerkUserId,
        ...extra,
      };
    }

    async function expectAllow(label: string, simulatedIdentity: unknown) {
      try {
        const authorizedOrgId = await requireIntegrationAdminOrgIdFromIdentity(
          { db: ctx.db },
          simulatedIdentity,
        );
        if (authorizedOrgId !== orgId) {
          throw new Error("authorized org mismatch");
        }
        results.push({ case: label, expected: "allow", actual: "allow" });
      } catch (error) {
        results.push({
          case: label,
          expected: "allow",
          actual: "deny",
          error: String(error),
        });
        throw error;
      }
    }

    async function expectDeny(label: string, simulatedIdentity: unknown) {
      try {
        await requireIntegrationAdminOrgIdFromIdentity(
          { db: ctx.db },
          simulatedIdentity,
        );
        const error = new Error(`${label} unexpectedly allowed`);
        results.push({
          case: label,
          expected: "deny",
          actual: "allow",
          error: error.message,
        });
        throw error;
      } catch (error) {
        if (!String(error).includes("AUTH: integration admin role required")) {
          results.push({
            case: label,
            expected: "deny",
            actual: "deny",
            error: String(error),
          });
          throw error;
        }
        results.push({ case: label, expected: "deny", actual: "deny" });
      }
    }

    await cleanupExisting();

    try {
      orgId = await ctx.db.insert("orgs", {
        clerkOrgId,
        name: "Integration Admin Auth Proof",
        plan: "debug",
        billingStatus: "debug",
      });

      await setMemberRole(null);
      await expectAllow(
        "clear admin claim allows without synced teamMember row",
        identity({ org_role: "org:admin" }),
      );
      await expectAllow(
        "compact Clerk organization role claim allows without synced teamMember row",
        identity({ o: { id: clerkOrgId, rol: "admin" } }),
      );

      await setMemberRole("admin");
      await expectDeny(
        "clear non-admin claim denies even with stale admin row",
        identity({ org_role: "org:member" }),
      );
      await expectDeny(
        "compact Clerk non-admin role claim denies even with stale admin row",
        identity({ o: { id: clerkOrgId, rol: "member" } }),
      );

      await setMemberRole("admin");
      await expectAllow("no claim plus teamMember admin allows", identity());

      await setMemberRole("member");
      await expectDeny("no claim plus teamMember member denies", identity());

      await setMemberRole("viewer");
      await expectDeny("no claim plus teamMember viewer denies", identity());

      await setMemberRole(null);
      await expectDeny("no claim plus missing teamMember row denies", identity());

      return { ok: true, results };
    } finally {
      if (orgId) {
        await cleanupOrg(orgId);
      }
    }
  },
});

export const syncTeamMemberProfile = internalMutation({
  args: {
    clerkUserId: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .collect();

    for (const member of members) {
      await ctx.db.patch(member._id, {
        name: args.name,
        ...(args.email ? { email: args.email } : {}),
      });
    }
  },
});

export const saveAnthropicEnvironmentId = internalMutation({
  args: {
    orgId: v.id("orgs"),
    environmentId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.orgId, {
      anthropicEnvironmentId: args.environmentId,
    });
  },
});

export const claimEnvironmentCreation = internalMutation({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) {
      throw new Error("BAD_REQUEST: org not found");
    }

    if (
      org.anthropicEnvironmentId &&
      org.anthropicEnvironmentId !== "__creating__" &&
      org.anthropicEnvironmentId !== ""
    ) {
      return {
        existingId: org.anthropicEnvironmentId,
        shouldCreate: false,
      };
    }

    if (org.anthropicEnvironmentId === "__creating__") {
      return {
        existingId: null,
        shouldCreate: false,
      };
    }

    await ctx.db.patch(args.orgId, { anthropicEnvironmentId: "__creating__" });
    return {
      existingId: null,
      shouldCreate: true,
    };
  },
});

async function createComposioSessionForOrg(
  ctx: RunActionContext,
  args: {
    orgId: OrgId;
  },
): Promise<ComposioSessionMcp | null> {
  return ctx.runAction(internal.composio.createSessionForOrg, args) as Promise<
    ComposioSessionMcp | null
  >;
}

function buildManagedMcpUrl(args: {
  orgId: OrgId;
  managedMcpToken: string;
}): string {
  const serverUrl = process.env.SPARK_MCP_URL;
  if (!serverUrl) {
    throw new Error("CONFIG: SPARK_MCP_URL is not configured");
  }

  const url = new URL(serverUrl);
  if (url.searchParams.has("token")) {
    throw new Error("CONFIG: SPARK_MCP_URL must not include a token query parameter");
  }
  return url.toString();
}

async function createManagedMcpVaultAttachment(
  client: Anthropic,
  args: {
    orgId: OrgId;
    purpose: ManagedMcpPurpose;
    managedMcpUrl: string;
    managedMcpToken: string;
    expiresAt: number;
  },
): Promise<ManagedMcpVaultAttachment> {
  const vault = await client.beta.vaults.create({
    display_name: `Spark MCP ${String(args.orgId)}`,
    metadata: {
      sparkOrgId: String(args.orgId),
      sparkPurpose: args.purpose,
      sparkCredentialKind: "managed-mcp",
    },
  });

  try {
    const credential = await client.beta.vaults.credentials.create(vault.id, {
      auth: {
        type: "static_bearer",
        token: args.managedMcpToken,
        mcp_server_url: args.managedMcpUrl,
      },
      display_name: "Spark managed MCP bearer",
      metadata: {
        sparkOrgId: String(args.orgId),
        sparkPurpose: args.purpose,
        expiresAt: new Date(args.expiresAt).toISOString(),
      },
    });
    return { vaultId: vault.id, credentialId: credential.id };
  } catch (error) {
    await cleanupManagedMcpVaultAttachment(client, { vaultId: vault.id });
    throw error;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupManagedMcpVaultAttachment(
  client: Anthropic,
  attachment: ManagedMcpVaultAttachment,
): Promise<void> {
  if (attachment.credentialId) {
    try {
      await client.beta.vaults.credentials.delete(attachment.credentialId, {
        vault_id: attachment.vaultId,
      });
    } catch (error) {
      console.warn("spark:managedMcpVaultCleanup", {
        vaultId: attachment.vaultId,
        credentialId: attachment.credentialId,
        error: getErrorMessage(error),
      });
    }
  }

  try {
    await client.beta.vaults.delete(attachment.vaultId);
  } catch (error) {
    console.warn("spark:managedMcpVaultCleanup", {
      vaultId: attachment.vaultId,
      error: getErrorMessage(error),
    });
  }
}

async function cleanupManagedAgent(
  client: Anthropic,
  agentId: string,
): Promise<void> {
  try {
    await client.beta.agents.archive(agentId);
  } catch (error) {
    console.warn("spark:managedAgentCleanup", {
      agentId,
      error: getErrorMessage(error),
    });
  }
}

async function buildManagedToolsets(args: {
  org: Doc<"orgs">;
  managedMcpUrl: string;
  composioSession: ComposioSessionMcp | null;
}): Promise<ManagedToolsetBundle> {
  const tools: ManagedAgentToolDefinition[] = [
    {
      type: "agent_toolset_20260401",
      default_config: {
        enabled: true,
        permission_policy: { type: "always_allow" },
      },
    },
  ];
  const mcp_servers: ManagedAgentMcpServer[] = [
    {
      type: "url",
      name: "spark-convex",
      url: args.managedMcpUrl,
    },
  ];
  tools.push({
    type: "mcp_toolset",
    mcp_server_name: "spark-convex",
    default_config: {
      enabled: true,
      permission_policy: { type: "always_allow" },
    },
  });

  if (args.composioSession) {
    console.warn("spark:managedToolsets", {
      orgId: args.org._id,
      message: "Skipping Composio MCP because it is deferred for Tier 0",
    });
  }

  return { tools, mcp_servers };
}

function logManagedModelUsage(
  sessionId: string,
  event: BetaManagedAgentsSpanModelRequestEndEvent,
): void {
  console.warn("spark:managedSessionModelUsage", {
    sessionId,
    usage: {
      cacheCreationInputTokens: event.model_usage.cache_creation_input_tokens,
      cacheReadInputTokens: event.model_usage.cache_read_input_tokens,
      inputTokens: event.model_usage.input_tokens,
      outputTokens: event.model_usage.output_tokens,
      speed: event.model_usage.speed ?? null,
    },
  });
}

async function collectManagedSessionResult(
  client: Anthropic,
  sessionId: string,
): Promise<ManagedAgentResult> {
  const stream = await client.beta.sessions.events.stream(sessionId);
  const outputParts: string[] = [];
  let lastErrorMessage: string | null = null;
  let sawTerminalState = false;
  const withCapturedError = (message: string) =>
    lastErrorMessage ? `${message}. Last session error: ${lastErrorMessage}` : message;

  for await (const event of stream) {
    switch (event.type) {
      case "agent.message":
        for (const block of event.content) {
          if (block.type === "text") {
            outputParts.push(block.text);
          }
        }
        break;
      case "span.model_request_end":
        logManagedModelUsage(sessionId, event);
        break;
      case "session.error":
        lastErrorMessage = event.error.message;
        console.warn("spark:managedSessionError", {
          sessionId,
          error: {
            message: event.error.message,
            retryStatus: event.error.retry_status.type,
            type: event.error.type,
          },
        });
        break;
      case "session.status_idle":
        switch (event.stop_reason.type) {
          case "end_turn":
            sawTerminalState = true;
            break;
          case "requires_action":
            throw new Error(
              "BAD_REQUEST: managed agent paused with stop_reason requires_action; Tier 0 does not support user.custom_tool_result or user.tool_confirmation",
            );
          case "retries_exhausted":
            throw new Error(
              `BAD_REQUEST: managed agent stopped with stop_reason ${JSON.stringify(event.stop_reason)}`,
            );
          default:
            throw new Error(
              `BAD_REQUEST: managed agent stopped with unexpected stop_reason ${JSON.stringify(event.stop_reason)}`,
            );
        }
        break;
      case "session.status_terminated":
        sawTerminalState = true;
        break;
      default:
        break;
    }

    if (sawTerminalState) {
      break;
    }
  }

  const session = await client.beta.sessions.retrieve(sessionId);
  console.warn("spark:managedSessionUsage", {
    sessionId,
    status: session.status,
    usage: session.usage,
  });

  if (!sawTerminalState && session.status !== "idle" && session.status !== "terminated") {
    throw new Error(
      withCapturedError(
        `BAD_REQUEST: managed agent session ended unexpectedly with status ${session.status}`,
      ),
    );
  }

  const output = outputParts.join("").trim();
  if (!output) {
    throw new Error(withCapturedError("BAD_REQUEST: managed agent returned no text output"));
  }

  return {
    output,
    usage: {
      inputTokens: session.usage.input_tokens ?? 0,
      outputTokens: session.usage.output_tokens ?? 0,
    },
  };
}

async function runManagedAgentSession(
  ctx: RunQueryContext & RunMutationContext,
  args: {
    orgId: OrgId;
    name: string;
    model: string;
    system: string;
    message: string;
    purpose: ManagedMcpPurpose;
    agentId?: Id<"agentDefinitions">;
  },
): Promise<ManagedAgentResult> {
  const org = (await ctx.runQuery(internal.spark.getOrgById, {
    orgId: args.orgId,
  })) as Doc<"orgs">;

  const client =
    org.anthropicApiKey
      ? new Anthropic({ apiKey: org.anthropicApiKey })
      : new Anthropic();

  const managedMcpToken = await buildManagedMcpToken({
    orgId: args.orgId,
    purpose: args.purpose,
  });

  const managedMcpUrl = buildManagedMcpUrl({
    orgId: args.orgId,
    managedMcpToken: managedMcpToken.token,
  });
  const toolsets = await buildManagedToolsets({
    org,
    managedMcpUrl,
    composioSession: null,
  });

  let managedAgentId: string | null = null;
  let managedMcpVault: ManagedMcpVaultAttachment | null = null;
  try {
    const agent = await client.beta.agents.create({
      name: args.name,
      model: args.model,
      system: args.system,
      tools: toolsets.tools,
      mcp_servers: toolsets.mcp_servers,
    });
    managedAgentId = agent.id;

    let environmentId = org.anthropicEnvironmentId;
    if (!environmentId || environmentId === "__creating__") {
      const claim = (await ctx.runMutation(
        internal.spark.claimEnvironmentCreation,
        {
          orgId: args.orgId,
        },
      )) as { existingId: string | null; shouldCreate: boolean };

      if (claim.shouldCreate) {
        try {
          const environment = await client.beta.environments.create({
            name: `spark-${String(args.orgId)}`,
            config: {
              type: "cloud",
              networking: { type: "unrestricted" },
            },
          });
          environmentId = environment.id;
          await ctx.runMutation(internal.spark.saveAnthropicEnvironmentId, {
            orgId: args.orgId,
            environmentId,
          });
        } catch (error) {
          await ctx.runMutation(internal.spark.saveAnthropicEnvironmentId, {
            orgId: args.orgId,
            environmentId: "",
          });
          throw error;
        }
      } else if (claim.existingId) {
        environmentId = claim.existingId;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const freshOrg = (await ctx.runQuery(internal.spark.getOrgById, {
          orgId: args.orgId,
        })) as Doc<"orgs">;
        environmentId = freshOrg.anthropicEnvironmentId;
        if (!environmentId || environmentId === "__creating__") {
          throw new Error(
            "Environment creation in progress by another action - retry",
          );
        }
      }
    }

    managedMcpVault = await createManagedMcpVaultAttachment(client, {
      orgId: args.orgId,
      purpose: args.purpose,
      managedMcpUrl,
      managedMcpToken: managedMcpToken.token,
      expiresAt: managedMcpToken.expiresAt,
    });

    const session = await client.beta.sessions.create({
      agent: {
        type: "agent",
        id: agent.id,
        version: agent.version,
      },
      environment_id: environmentId,
      vault_ids: [managedMcpVault.vaultId],
      title: args.name,
    });

    const [result] = await Promise.all([
      collectManagedSessionResult(client, session.id),
      client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: args.message }],
          },
        ],
      }),
    ]);

    // Persist session-level usage (A-11). Fail-soft: never fail a completed
    // agent run over a bookkeeping write.
    try {
      await ctx.runMutation(internal.usage.recordUsage, {
        orgId: args.orgId,
        agentId: args.agentId,
        source:
          args.purpose === "dream-cycle" ? "dream-cycle" : "customer-agent",
        model: args.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costCents: calculateCostCents(
          args.model,
          {
            promptTokens: result.usage.inputTokens,
            completionTokens: result.usage.outputTokens,
          },
          undefined,
        ),
      });
    } catch (error) {
      console.warn("spark:usageRecordFailed", {
        purpose: args.purpose,
        error: String(error),
      });
    }

    return result;
  } finally {
    if (managedMcpVault) {
      await cleanupManagedMcpVaultAttachment(client, managedMcpVault);
    }
    if (managedAgentId) {
      await cleanupManagedAgent(client, managedAgentId);
    }
  }
}

export const runCustomerAgent = internalAction({
  args: {
    orgId: v.id("orgs"),
    name: v.string(),
    model: v.string(),
    system: v.string(),
    message: v.string(),
    agentId: v.optional(v.id("agentDefinitions")),
  },
  handler: async (
    ctx: ActionCtx,
    args: {
      orgId: OrgId;
      name: string;
      model: string;
      system: string;
      message: string;
      agentId?: Id<"agentDefinitions">;
    },
  ): Promise<ManagedAgentResult> => {
    return runManagedAgentSession(ctx, {
      ...args,
      purpose: "customer-agent",
    });
  },
});

export const runDreamCycle = internalAction({
  args: {
    orgId: v.id("orgs"),
    prompt: v.string(),
  },
  handler: async (
    ctx: ActionCtx,
    args: { orgId: OrgId; prompt: string },
  ): Promise<ManagedAgentResult> => {
    return runManagedAgentSession(ctx, {
      orgId: args.orgId,
      name: "Spark Dream Cycle",
      model: "claude-opus-4-6",
      // Full Spark Mind persona + output contract live in dreamCycle.ts and
      // travel with the prompt; this system block is the runtime guard rail.
      system: DREAM_SYSTEM_PROMPT,
      message: args.prompt,
      purpose: "dream-cycle",
    });
  },
});

export const mcpSearch = internalAction({
  args: {
    orgId: v.id("orgs"),
    query: v.string(),
  },
  handler: async (
    ctx: ActionCtx,
    args: { orgId: OrgId; query: string },
  ): Promise<unknown> => {
    return ctx.runAction(internal.search.deepSearch, {
      orgId: args.orgId,
      query: args.query,
      limit: 10,
    });
  },
});

const MCP_ASK_MODEL = "claude-sonnet-4-6";
const MCP_ASK_MAX_RESULTS = 8;
const MCP_ASK_TRUTH_CHARS = 1200;

export const mcpAsk = internalAction({
  args: {
    orgId: v.id("orgs"),
    question: v.string(),
  },
  handler: async (
    ctx: ActionCtx,
    args: { orgId: OrgId; question: string },
  ): Promise<string> => {
    const search = (await ctx.runAction(internal.search.deepSearch, {
      orgId: args.orgId,
      query: args.question,
      limit: MCP_ASK_MAX_RESULTS,
    })) as {
      results: Array<{ title: string; slug: string; type: string; compiledTruth: string }>;
    };

    if (search.results.length === 0) {
      return "No relevant knowledge found for this question in the org's knowledge base.";
    }

    const contextBlock = search.results
      .map(
        (result, index) =>
          `<page index="${index + 1}" slug="${result.slug}" type="${result.type}" title="${result.title}">\n` +
          `${result.compiledTruth.slice(0, MCP_ASK_TRUTH_CHARS)}\n</page>`,
      )
      .join("\n\n");

    const response = await withRetriableCall(classifyAnthropicRetry, async () =>
      anthropicClient.messages.create({
        model: MCP_ASK_MODEL,
        max_tokens: 1500,
        temperature: 0,
        system: [
          {
            type: "text" as const,
            text:
              "You answer questions about an organization using ONLY the provided " +
              "knowledge pages. Cite pages inline as [title]. If the pages do not " +
              "answer the question, say what is missing. Never invent knowledge.",
            cache_control: { type: "ephemeral" as const },
          },
        ],
        messages: [
          {
            role: "user" as const,
            content: `Question: ${args.question}\n\nKnowledge pages:\n${contextBlock}`,
          },
        ],
      }),
    );

    // A-11: spark_ask is a real model call — record its usage.
    try {
      await ctx.runMutation(internal.usage.recordUsage, {
        orgId: args.orgId,
        source: "chat",
        model: MCP_ASK_MODEL,
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        costCents: calculateCostCents(
          MCP_ASK_MODEL,
          {
            promptTokens: response.usage.input_tokens ?? 0,
            completionTokens: response.usage.output_tokens ?? 0,
          },
          undefined,
        ),
      });
    } catch (usageError) {
      console.warn("spark:usageRecordFailed", {
        source: "mcp-ask",
        error: String(usageError),
      });
    }

    const answer = extractAnthropicText(response.content);
    return answer || "The model returned no answer text.";
  },
});

type McpEntityProfile = {
  found: boolean;
  entity?: {
    slug: string;
    title: string;
    type: string;
    compiledTruth: string;
    tags: string[];
    confidence: string;
    lastConfirmed: number;
    evidence: Array<{
      source: string;
      channel: string;
      timestamp: number;
      content: string;
    }>;
  };
};

const MCP_ENTITY_EVIDENCE_LIMIT = 15;

// Entity profile lookup: entityId is the page slug (preferred) or a name.
// Names resolve through the entity-typed page whose title matches; profiles
// are knowledge pages (D-7), so this returns Compiled Truth + recent evidence.
export const mcpEntityLookup = internalQuery({
  args: {
    orgId: v.id("orgs"),
    entityId: v.string(),
  },
  handler: async (ctx, args): Promise<McpEntityProfile> => {
    const needle = args.entityId.trim();
    if (!needle) {
      return { found: false };
    }
    let page = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_slug", (q) => q.eq("orgId", args.orgId).eq("slug", needle))
      .first();
    if (!page) {
      const entityPages = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_type", (q) => q.eq("orgId", args.orgId).eq("type", "entity"))
        .order("desc")
        .take(200);
      const lowered = needle.toLowerCase();
      page =
        entityPages.find((candidate) => candidate.title.toLowerCase() === lowered) ??
        entityPages.find((candidate) =>
          candidate.title.toLowerCase().includes(lowered),
        ) ??
        null;
    }
    if (!page || page.status !== "active") {
      return { found: false };
    }
    const evidenceRows = await ctx.db
      .query("knowledgePageEvidence")
      .withIndex("by_page_key", (q) => q.eq("pageId", page!._id))
      .order("desc")
      .take(MCP_ENTITY_EVIDENCE_LIMIT);
    return {
      found: true,
      entity: {
        slug: page.slug,
        title: page.title,
        type: page.type,
        compiledTruth: page.compiledTruth,
        tags: page.tags,
        confidence: page.confidence,
        lastConfirmed: page.lastConfirmed,
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

export const mcpEntity = internalAction({
  args: {
    orgId: v.id("orgs"),
    entityId: v.string(),
  },
  handler: async (
    ctx: ActionCtx,
    args: { orgId: OrgId; entityId: string },
  ): Promise<McpEntityProfile> => {
    return ctx.runQuery(internal.spark.mcpEntityLookup, {
      orgId: args.orgId,
      entityId: args.entityId,
    });
  },
});

type InsertEventArgs = {
  orgId: OrgId;
  source: string;
  via: Doc<"events">["via"];
  type: string;
  actor: string;
  summary: string;
  timestamp: number;
  sourceDeliveryId?: string;
  actorRef?: { source: string; gid: string };
  raw: unknown;
};

export const insertEvent = internalMutation({
  args: {
    orgId: v.id("orgs"),
    source: v.string(),
    via: EVENT_VIA_VALIDATOR,
    type: v.string(),
    actor: v.string(),
    summary: v.string(),
    timestamp: v.number(),
    sourceDeliveryId: v.optional(v.string()),
    actorRef: v.optional(v.object({ source: v.string(), gid: v.string() })),
    raw: v.any(),
  },
  handler: async (ctx: MutationCtx, args: InsertEventArgs): Promise<Id<"events">> => {
    const db = ctx.db as any;
    if (args.sourceDeliveryId) {
      const existingDelivery = (await ctx.db
        .query("events")
        .withIndex("by_org_source_via_delivery", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("source", args.source)
            .eq("via", args.via)
            .eq("sourceDeliveryId", args.sourceDeliveryId),
        )
        .first()) as Doc<"events"> | null;
      if (existingDelivery) {
        return existingDelivery._id;
      }
    }

    // Tool-agnostic burst coalescing: collapse a flurry of edits to the same
    // field of the same object within a time window into the first event. Only
    // fires for verb:"updated" field-edit bursts (classifyEvent.coalesceKeyFor);
    // substantive/discrete events are never coalesced. Replaces per-tool field
    // whitelists (e.g. ASANA_TASK_UPDATED_FIELDS) for every source at once.
    const coalesceKey = coalesceKeyFor(
      classifyEvent(args.source, args.type, args.raw),
      args.timestamp,
    );
    if (coalesceKey) {
      const existingBurst = (await ctx.db
        .query("events")
        .withIndex("by_org_source_coalesce", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("source", args.source)
            .eq("coalesceKey", coalesceKey),
        )
        .first()) as Doc<"events"> | null;
      if (existingBurst) {
        return existingBurst._id;
      }
    }

    const eventId = await ctx.db.insert("events", {
      orgId: args.orgId,
      source: args.source,
      via: args.via,
      type: args.type,
      actor: args.actor,
      summary: args.summary,
      timestamp: args.timestamp,
      ...(args.sourceDeliveryId ? { sourceDeliveryId: args.sourceDeliveryId } : {}),
      ...(args.actorRef ? { actorRef: args.actorRef } : {}),
      ...(coalesceKey ? { coalesceKey } : {}),
      raw: args.raw,
      processed: false,
    });

    await ctx.scheduler.runAfter(0, internal.spark.resolveEventEntities, {
      eventId,
    });

    return eventId;
  },
});

// Watermark for the Gorgias poller (convex/composio.ts). Gorgias has no Composio
// triggers, so its poll cursor is derived from the events it has already
// written: the newest "gorgias" event's timestamp is the last
// ticket.updated_datetime ingested. No dedicated state table needed.
export const getLastGorgiasUpdatedMs = internalQuery({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args): Promise<number | null> => {
    const last = await ctx.db
      .query("events")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", args.orgId).eq("source", "gorgias"),
      )
      .order("desc")
      .first();
    return last?.timestamp ?? null;
  },
});

// Earliest event for a source — backfills use this as their upper bound so they
// fill the gap *up to* where live (webhook/trigger) capture began and never
// duplicate live events (which key on per-delivery ids, not the entity ids
// backfill uses). null = no events yet for this source (backfill up to now).
export const getEarliestEventMsBySource = internalQuery({
  args: { orgId: v.id("orgs"), source: v.string() },
  handler: async (ctx, args): Promise<number | null> => {
    const first = await ctx.db
      .query("events")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", args.orgId).eq("source", args.source),
      )
      .order("asc")
      .first();
    return first?.timestamp ?? null;
  },
});

export const getEventById = internalQuery({
  args: {
    eventId: v.id("events"),
  },
  handler: async (ctx, args): Promise<Doc<"events"> | null> => {
    return ctx.db.get(args.eventId);
  },
});

export const getCachedIdentities = internalQuery({
  args: {
    orgId: v.id("orgs"),
    refs: v.array(v.object({ source: v.string(), gid: v.string() })),
  },
  handler: async (ctx, args) => {
    const rows: Array<{
      source: string;
      gid: string;
      name?: string;
      photoUrl?: string;
      email?: string;
      entityId?: Id<"entities">;
      fetchedAt: number;
    }> = [];
    for (const ref of args.refs) {
      const row = await ctx.db
        .query("identityCache")
        .withIndex("by_org_source_gid", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("source", ref.source)
            .eq("gid", ref.gid),
        )
        .first();
      if (row) {
        rows.push({
          source: row.source,
          gid: row.gid,
          name: row.name,
          photoUrl: row.photoUrl,
          email: row.email,
          entityId: row.entityId,
          fetchedAt: row.fetchedAt,
        });
      }
    }
    return rows;
  },
});

export const upsertCachedIdentity = internalMutation({
  args: {
    orgId: v.id("orgs"),
    source: v.string(),
    gid: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    fetchedAt: v.number(),
    clearEntityId: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("identityCache")
      .withIndex("by_org_source_gid", (q) =>
        q
          .eq("orgId", args.orgId)
          .eq("source", args.source)
          .eq("gid", args.gid),
      )
      .first();
    const fields = {
      name: args.name,
      photoUrl: args.photoUrl,
      fetchedAt: args.fetchedAt,
      ...(args.email !== undefined ? { email: args.email } : {}),
    };
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...fields,
        ...(args.clearEntityId ? { entityId: undefined } : {}),
      });
      return existing._id;
    }
    return ctx.db.insert("identityCache", {
      orgId: args.orgId,
      source: args.source,
      gid: args.gid,
      ...fields,
    });
  },
});

type IdentityFields = {
  name?: string;
  email?: string;
  photoUrl?: string;
};

const entityKindValidator = v.union(
  v.literal("person"),
  v.literal("project"),
  v.literal("bot"),
  v.literal("system"),
  v.literal("shared"),
  v.literal("unknown"),
);

type EntityKind = Infer<typeof entityKindValidator>;

type IdentityFetchResult = {
  name: string | null;
  email: string | null;
  photoUrl: string | null;
};

type IdentityFetchOptions = {
  quiet?: boolean;
};

type AsanaActorIdentityKind = "user" | "project" | "section" | "task";

type ResolvedEntity = {
  entityId: Id<"entities">;
  entity: Doc<"entities"> | null;
};

function extractIdentityByPaths(result: unknown, paths: string[][]): string | null {
  const outer = getRecord(result);
  if (outer && outer.successful === false) return null;
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
      if (typeof cursor === "string" && cursor.length > 0) return cursor;
    }
  }
  return null;
}

async function fetchComposioIdentityForActor(
  orgId: OrgId,
  fetcher: ComposioFetcher,
  id: string,
  options: IdentityFetchOptions = {},
): Promise<IdentityFetchResult> {
  const empty = { name: null, email: null, photoUrl: null };
  const logWarnings = options.quiet !== true;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    console.warn("spark:composio-resolve-failed", {
      orgId,
      slug: fetcher.slug,
      id,
      error: "CONFIG: COMPOSIO_API_KEY is not configured",
    });
    return empty;
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
          arguments: { [fetcher.argKey]: id },
          ...(fetcher.version ? { version: fetcher.version } : {}),
        }),
      },
    );
    if (!resp.ok) {
      if (logWarnings) {
        console.warn("spark:composio-resolve-failed", {
          orgId,
          slug: fetcher.slug,
          id,
          error: `REST execute returned ${resp.status}`,
        });
      }
      return empty;
    }
    result = await resp.json();
  } catch (err) {
    if (logWarnings) {
      console.warn("spark:composio-resolve-failed", {
        orgId,
        slug: fetcher.slug,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return empty;
  }

  return {
    name: extractIdentityByPaths(result, fetcher.namePaths),
    email: extractIdentityByPaths(result, fetcher.emailPaths ?? []),
    photoUrl: extractIdentityByPaths(result, fetcher.photoPaths ?? []),
  };
}

const ASANA_ACTOR_IDENTITY_FETCHERS: Array<{
  kind: AsanaActorIdentityKind;
  fetcher: ComposioFetcher;
}> = [
  { kind: "user", fetcher: ASANA_RESOURCE_FETCHERS.user },
  { kind: "project", fetcher: ASANA_RESOURCE_FETCHERS.project },
  { kind: "section", fetcher: ASANA_RESOURCE_FETCHERS.section },
  { kind: "task", fetcher: ASANA_RESOURCE_FETCHERS.task },
];

async function fetchAsanaActorIdentity(
  orgId: OrgId,
  gid: string,
): Promise<IdentityFetchResult & { kind: AsanaActorIdentityKind | null }> {
  for (const candidate of ASANA_ACTOR_IDENTITY_FETCHERS) {
    const identity = await fetchComposioIdentityForActor(
      orgId,
      candidate.fetcher,
      gid,
      { quiet: true },
    );
    if (identity.name) {
      return { ...identity, kind: candidate.kind };
    }
  }

  console.warn("spark:composio-resolve-no-name", {
    orgId,
    source: "asana",
    id: gid,
    attemptedKinds: ASANA_ACTOR_IDENTITY_FETCHERS.map(
      (candidate) => candidate.kind,
    ),
    attemptedSlugs: ASANA_ACTOR_IDENTITY_FETCHERS.map(
      (candidate) => candidate.fetcher.slug,
    ),
  });
  return { name: null, email: null, photoUrl: null, kind: null };
}

function asanaActorEntityKind(
  kind: AsanaActorIdentityKind | null,
): EntityKind | null {
  if (kind === "user") return "person";
  if (kind === "project") return "project";
  return null;
}

function getActorIdentityFetcher(source: string): ComposioFetcher | null {
  if (source === "slack") return SLACK_USER_FETCHER;
  return null;
}

function isRawEntityDisplayName(value: string): boolean {
  const trimmed = value.trim();
  return /^(asana|slack|github):/i.test(trimmed) || /^\d{10,}$/.test(trimmed);
}

function isHumanDisplayName(value: string | undefined): value is string {
  if (!value) return false;
  if (value.includes("@")) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  return !isRawEntityDisplayName(value);
}

function displayNameQuality(name: string): number {
  const trimmed = name.trim();
  if (trimmed.length === 0 || isRawEntityDisplayName(trimmed)) return 0;
  if (!/[a-z]/.test(trimmed)) return 1;
  return 2;
}

function mergeEmail(emails: string[], email: string | undefined): string[] {
  if (!email) return emails;
  const exists = emails.some(
    (candidate) => candidate.toLowerCase() === email.toLowerCase(),
  );
  return exists ? emails : [...emails, email];
}

async function getOrgEntityById(
  ctx: MutationCtx,
  orgId: OrgId,
  entityId: Id<"entities">,
): Promise<Doc<"entities"> | null> {
  const entity = await ctx.db.get(entityId);
  return entity?.orgId === orgId ? entity : null;
}

async function improveEntity(
  ctx: MutationCtx,
  entity: Doc<"entities"> | null,
  fields: IdentityFields & { now: number },
): Promise<void> {
  if (!entity) return;
  const patch: {
    displayName?: string;
    photoUrl?: string;
    emails?: string[];
    updatedAt?: number;
  } = {};
  const emails = mergeEmail(entity.emails, fields.email);
  if (emails.length !== entity.emails.length) patch.emails = emails;
  if (entity.teamMemberId) {
    const member = await ctx.db.get(entity.teamMemberId);
    if (member?.name.trim() && member.name !== entity.displayName) {
      patch.displayName = member.name;
    }
  } else if (
    isHumanDisplayName(fields.name) &&
    displayNameQuality(fields.name) > displayNameQuality(entity.displayName)
  ) {
    patch.displayName = fields.name;
  }
  if (!entity.photoUrl && fields.photoUrl) patch.photoUrl = fields.photoUrl;
  if (Object.keys(patch).length === 0) return;
  patch.updatedAt = fields.now;
  await ctx.db.patch(entity._id, patch);
}

async function findTeamMemberForAlias(
  ctx: MutationCtx,
  orgId: OrgId,
  source: string,
  gid: string,
  email: string | undefined,
): Promise<Doc<"teamMembers"> | null> {
  if (email) {
    return ctx.db
      .query("teamMembers")
      .withIndex("by_org_email", (q) =>
        q.eq("orgId", orgId).eq("email", email),
      )
      .first();
  }
  if (source !== "github") return null;
  return ctx.db
    .query("teamMembers")
    .withIndex("by_org_github", (q) =>
      q.eq("orgId", orgId).eq("githubLogin", gid),
    )
    .first();
}

async function resolveEntityForAlias(
  ctx: MutationCtx,
  orgId: OrgId,
  source: string,
  gid: string,
  kind: EntityKind,
  fields: IdentityFields,
  now: number,
): Promise<ResolvedEntity> {
  let resolved: ResolvedEntity | null = null;
  let member: Doc<"teamMembers"> | null = null;
  let checkedMember = false;

  if (fields.email) {
    const aliases = await ctx.db
      .query("identityCache")
      .withIndex("by_org_email", (q) =>
        q.eq("orgId", orgId).eq("email", fields.email),
      )
      .take(10);
    const linkedEntityId = aliases.find((row) => row.entityId)?.entityId;
    if (linkedEntityId) {
      resolved = {
        entityId: linkedEntityId,
        entity: await getOrgEntityById(ctx, orgId, linkedEntityId),
      };
    }
  }

  if (!resolved) {
    checkedMember = true;
    member = await findTeamMemberForAlias(
      ctx,
      orgId,
      source,
      gid,
      fields.email,
    );
  }

  if (!resolved && member) {
    const matchedMember = member;
    const entity = await ctx.db
      .query("entities")
      .withIndex("by_org_teamMember", (q) =>
        q.eq("orgId", orgId).eq("teamMemberId", matchedMember._id),
      )
      .first();
    if (entity) {
      resolved = { entityId: entity._id, entity };
    } else {
      const memberEmail = normalizeOptionalString(matchedMember.email);
      const entityId = await ctx.db.insert("entities", {
        orgId,
        kind,
        displayName: matchedMember.name,
        ...(fields.photoUrl ? { photoUrl: fields.photoUrl } : {}),
        emails: memberEmail ? [memberEmail] : [],
        teamMemberId: matchedMember._id,
        createdAt: now,
        updatedAt: now,
      });
      resolved = { entityId, entity: null };
    }
  }

  if (!resolved) {
    const entityId = await ctx.db.insert("entities", {
      orgId,
      kind,
      displayName: fields.name ?? `${source}:${gid}`,
      ...(fields.photoUrl ? { photoUrl: fields.photoUrl } : {}),
      emails: fields.email ? [fields.email] : [],
      createdAt: now,
      updatedAt: now,
    });
    resolved = { entityId, entity: null };
  }

  const entity =
    resolved.entity ?? (await getOrgEntityById(ctx, orgId, resolved.entityId));
  if (!entity || entity.teamMemberId) {
    return { entityId: resolved.entityId, entity };
  }
  if (!checkedMember) {
    member = await findTeamMemberForAlias(ctx, orgId, source, gid, fields.email);
  }
  if (!member || member.name.trim().length === 0) {
    return { entityId: resolved.entityId, entity };
  }
  await ctx.db.patch(entity._id, {
    teamMemberId: member._id,
    displayName: member.name,
  });
  return {
    entityId: resolved.entityId,
    entity: await getOrgEntityById(ctx, orgId, resolved.entityId),
  };
}

function buildAliasFields(
  args: IdentityFields & { fetchedAt: number },
): IdentityFields & { fetchedAt: number } {
  return {
    ...(args.name ? { name: args.name } : {}),
    ...(args.email ? { email: args.email } : {}),
    ...(args.photoUrl ? { photoUrl: args.photoUrl } : {}),
    fetchedAt: args.fetchedAt,
  };
}

async function createEntityForAlias(
  ctx: MutationCtx,
  orgId: OrgId,
  source: string,
  gid: string,
  kind: EntityKind,
  fields: IdentityFields,
  now: number,
): Promise<ResolvedEntity> {
  const entityId = await ctx.db.insert("entities", {
    orgId,
    kind,
    displayName: fields.name ?? `${source}:${gid}`,
    ...(fields.photoUrl ? { photoUrl: fields.photoUrl } : {}),
    emails: fields.email ? [fields.email] : [],
    createdAt: now,
    updatedAt: now,
  });
  return { entityId, entity: null };
}

async function resolveProjectForAlias(
  ctx: MutationCtx,
  orgId: OrgId,
  source: string,
  gid: string,
  kind: EntityKind,
  fields: IdentityFields,
  now: number,
): Promise<ResolvedEntity> {
  const displayName = fields.name ?? `${source}:${gid}`;
  const existing = await ctx.db
    .query("entities")
    .withIndex("by_org_kind_displayName", (q) =>
      q.eq("orgId", orgId).eq("kind", kind).eq("displayName", displayName),
    )
    .first();
  if (existing) {
    return { entityId: existing._id, entity: existing };
  }
  return createEntityForAlias(ctx, orgId, source, gid, kind, fields, now);
}

export const linkEntityAlias = internalMutation({
  args: {
    orgId: v.id("orgs"),
    source: v.string(),
    gid: v.string(),
    kind: v.optional(entityKindValidator),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    fetchedAt: v.number(),
  },
  handler: async (ctx, args): Promise<{ entityId: Id<"entities"> }> => {
    const now = Date.now();
    const fields = {
      name: normalizeOptionalString(args.name),
      email: normalizeEmail(args.email),
      photoUrl: normalizeOptionalString(args.photoUrl),
    };
    const kind = args.kind ?? "person";
    const aliasFields = buildAliasFields({
      ...fields,
      fetchedAt: args.fetchedAt,
    });
    const alias = await ctx.db
      .query("identityCache")
      .withIndex("by_org_source_gid", (q) =>
        q
          .eq("orgId", args.orgId)
          .eq("source", args.source)
          .eq("gid", args.gid),
      )
      .first();

    if (alias?.entityId) {
      await ctx.db.patch(alias._id, aliasFields);
      await improveEntity(
        ctx,
        await getOrgEntityById(ctx, args.orgId, alias.entityId),
        { ...fields, now },
      );
      return { entityId: alias.entityId };
    }

    const resolved =
      kind === "person"
        ? await resolveEntityForAlias(
            ctx,
            args.orgId,
            args.source,
            args.gid,
            kind,
            fields,
            now,
          )
        : kind === "project"
          ? await resolveProjectForAlias(
              ctx,
              args.orgId,
              args.source,
              args.gid,
              kind,
              fields,
              now,
            )
          : await createEntityForAlias(
              ctx,
              args.orgId,
              args.source,
              args.gid,
              kind,
              fields,
              now,
            );
    if (alias) {
      await ctx.db.patch(alias._id, {
        ...aliasFields,
        entityId: resolved.entityId,
      });
    } else {
      await ctx.db.insert("identityCache", {
        orgId: args.orgId,
        source: args.source,
        gid: args.gid,
        ...aliasFields,
        entityId: resolved.entityId,
      });
    }

    await improveEntity(ctx, resolved.entity, { ...fields, now });
    return { entityId: resolved.entityId };
  },
});

export const resolveEntityForActor = internalAction({
  args: {
    orgId: v.id("orgs"),
    source: v.string(),
    gid: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    // Optional kind override from deterministic payload signals (e.g. bot
    // detection in resolveEventEntities). Falls through to "person" when absent.
    kind: v.optional(entityKindValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ entityId: Id<"entities"> | null }> => {
    const now = Date.now();
    const cached = await ctx.runQuery(internal.spark.getCachedIdentities, {
      orgId: args.orgId,
      refs: [{ source: args.source, gid: args.gid }],
    });
    const hit = cached[0];
    if (hit?.entityId && now - hit.fetchedAt < IDENTITY_TTL_MS) {
      return { entityId: hit.entityId };
    }

    const known = {
      name:
        normalizeOptionalString(args.name) ??
        normalizeOptionalString(hit?.name) ??
        undefined,
      email:
        normalizeOptionalString(args.email) ??
        normalizeOptionalString(hit?.email) ??
        undefined,
      photoUrl: normalizeOptionalString(hit?.photoUrl),
    };
    let kind: EntityKind | null = args.kind ?? "person";
    if (args.source === "asana") {
      const fetched = await fetchAsanaActorIdentity(args.orgId, args.gid);
      known.name = normalizeOptionalString(fetched.name) ?? known.name;
      known.email = normalizeOptionalString(fetched.email) ?? known.email;
      known.photoUrl =
        normalizeOptionalString(fetched.photoUrl) ?? known.photoUrl;
      kind = asanaActorEntityKind(fetched.kind);
      if (!kind) {
        await ctx.runMutation(internal.spark.upsertCachedIdentity, {
          orgId: args.orgId,
          source: args.source,
          gid: args.gid,
          name: known.name,
          email: known.email,
          photoUrl: known.photoUrl,
          fetchedAt: Date.now(),
          clearEntityId: true,
        });
        return { entityId: null };
      }
    } else {
      const fetcher = getActorIdentityFetcher(args.source);
      if (fetcher) {
        const fetched = await fetchComposioIdentityForActor(
          args.orgId,
          fetcher,
          args.gid,
        );
        known.name = normalizeOptionalString(fetched.name) ?? known.name;
        known.email = normalizeOptionalString(fetched.email) ?? known.email;
        known.photoUrl =
          normalizeOptionalString(fetched.photoUrl) ?? known.photoUrl;
      }
    }
    if (args.source === "github" && !known.name) {
      known.name = args.gid;
    }

    return ctx.runMutation(internal.spark.linkEntityAlias, {
      orgId: args.orgId,
      source: args.source,
      gid: args.gid,
      kind,
      name: known.name,
      email: known.email,
      photoUrl: known.photoUrl,
      fetchedAt: Date.now(),
    });
  },
});

// Deterministic bot detection from the raw event payload. Returns a kind
// override ("bot") for clearly non-human actors, or null to fall through to the
// normal person/project resolution. Only unambiguous, source-native payload
// signals are used — no network calls and no name-based guessing. Ambiguous
// cases (system/shared) are intentionally left to synthesis-time reconciliation.
function detectActorEntityKind(event: Doc<"events">): EntityKind | null {
  const raw = getRecord(event.raw);
  if (!raw) return null;
  if (event.source === "github") {
    const sender = getRecord(raw.sender);
    if (getString(sender, "type") === "Bot") return "bot";
    const login = getString(sender, "login");
    if (login && /\[bot\]$/i.test(login)) return "bot";
    return null;
  }
  // Slack markers ride on bot-user posts (which carry a `user` id, so an actorRef
  // exists to attach the hint to). Pure webhook bot_messages have no `user` → no
  // actorRef → no entity is created either way, so there is nothing to mislabel.
  if (event.source === "slack") {
    const data = getRecord(raw.data);
    if (!data) return null;
    if (getString(data, "bot_id")) return "bot";
    if (getString(data, "subtype") === "bot_message") return "bot";
    if (getRecord(data.bot_profile)) return "bot";
    return null;
  }
  return null;
}

async function resolveEventEntityRef(
  ctx: ActionCtx,
  ref: { orgId: OrgId; source: string; gid: string; kind?: EntityKind | null },
): Promise<{ entityId: Id<"entities"> | null; resolved: boolean }> {
  try {
    const resolved = (await ctx.runAction(internal.spark.resolveEntityForActor, {
      orgId: ref.orgId,
      source: ref.source,
      gid: ref.gid,
      ...(ref.kind ? { kind: ref.kind } : {}),
    })) as { entityId: Id<"entities"> | null };
    return { entityId: resolved.entityId, resolved: true };
  } catch (error) {
    console.warn("spark:resolveEventEntities failed to resolve entity", {
      orgId: ref.orgId,
      source: ref.source,
      gid: ref.gid,
      error: error instanceof Error ? error.message : String(error),
    });
    return { entityId: null, resolved: false };
  }
}

export const markEventActorIdentityResolved = internalMutation({
  args: {
    eventId: v.id("events"),
    actorEntityId: v.optional(v.id("entities")),
    resolvedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.patch(args.eventId, {
      ...(args.actorEntityId ? { actorEntityId: args.actorEntityId } : {}),
      actorIdentityResolvedAt: args.resolvedAt,
    });
    return null;
  },
});

async function resolveGithubRepoProject(
  ctx: ActionCtx,
  orgId: OrgId,
  repoName: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.spark.linkEntityAlias, {
      orgId,
      source: "github",
      gid: repoName,
      kind: "project",
      name: repoName,
      fetchedAt: Date.now(),
    });
  } catch (error) {
    console.warn("spark:resolveEventEntities failed to resolve repo project", {
      orgId,
      repoName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const resolveEventEntities = internalAction({
  args: {
    eventId: v.id("events"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const event: Doc<"events"> | null = await ctx.runQuery(
      internal.spark.getEventById,
      {
        eventId: args.eventId,
      },
    );
    if (!event) {
      return null;
    }

    const actorKindHint = detectActorEntityKind(event);
    const actorRef = getEventActorIdentityRef(event);

    if (actorRef) {
      const resolvedActor = await resolveEventEntityRef(ctx, {
        orgId: event.orgId,
        source: actorRef.source,
        gid: actorRef.gid,
        kind: actorKindHint,
      });
      if (resolvedActor.resolved) {
        await ctx.runMutation(internal.spark.markEventActorIdentityResolved, {
          eventId: event._id,
          ...(resolvedActor.entityId
            ? { actorEntityId: resolvedActor.entityId }
            : {}),
          resolvedAt: Date.now(),
        });
      }
    }

    if (event.source === "asana") {
      const raw = getRecord(event.raw);
      const projectGid = getString(getRecord(raw?.data), "project_gid");
      if (projectGid) {
        await resolveEventEntityRef(ctx, {
          orgId: event.orgId,
          source: "asana",
          gid: projectGid,
        });
      }
    }

    if (event.source === "github") {
      const repoName = readRepoName(event.raw);
      if (repoName) {
        await resolveGithubRepoProject(ctx, event.orgId, repoName);
      }
    }

    return null;
  },
});

export const mcpPush = internalAction({
  args: {
    orgId: v.id("orgs"),
    payload: v.any(),
  },
  handler: async (
    ctx: ActionCtx,
    args: { orgId: OrgId; payload: unknown },
  ): Promise<Id<"events">> => {
    const payload = getRecord(args.payload);
    if (!payload) {
      throw new Error("BAD_REQUEST: MCP push payload must be an object");
    }
    const event = validateMcpPushPayload(payload);

    return (await ctx.runMutation(internal.spark.insertEvent, {
      orgId: args.orgId,
      source: event.source,
      via: "api",
      type: event.type,
      actor: event.actor,
      summary: event.summary,
      timestamp: event.timestamp,
      ...(event.sourceDeliveryId ? { sourceDeliveryId: event.sourceDeliveryId } : {}),
      raw: payload,
    })) as Id<"events">;
  },
});

async function hashTokenSha256(token: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function generateApiKeyPlaintext(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sk_live_${base64url}`;
}

function extractApiKeyPrefix(plaintextKey: string): string {
  return plaintextKey.slice(0, 16);
}

type IntegrationAdminQueryCtx = QueryCtx & { orgId: OrgId };
type IntegrationAdminMutationCtx = MutationCtx & { orgId: OrgId };
type ApiKeyAuthResult = {
  orgId: OrgId;
  apiKeyId: Id<"apiKeys">;
};
type McpRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
  bucket: string;
  count: number;
};

async function patchMcpApiKeyLastUsed(
  ctx: MutationCtx,
  apiKey: Doc<"apiKeys">,
  now: number,
): Promise<void> {
  if (
    apiKey.lastUsedAt &&
    apiKey.lastUsedAt > now - MCP_API_KEY_LAST_USED_UPDATE_INTERVAL_MS
  ) {
    return;
  }

  await ctx.db.patch(apiKey._id, { lastUsedAt: now });
}

export const listApiKeys = integrationAdminQuery({
  args: {},
  handler: async (ctx): Promise<unknown[]> => {
    const apiKeys = await ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.orgId))
      .collect();

    return apiKeys.map((apiKey: Doc<"apiKeys">) => ({
      _id: apiKey._id,
      _creationTime: apiKey._creationTime,
      apiKeyId: apiKey._id,
      keyPrefix: apiKey.keyPrefix,
      label: apiKey.label,
      createdAt: apiKey.createdAt,
      createdBy: apiKey.createdBy,
      revokedAt: apiKey.revokedAt,
      lastUsedAt: apiKey.lastUsedAt,
    }));
  },
});

export const createApiKey = integrationAdminMutation({
  args: {
    label: v.string(),
  },
  handler: async (
    ctx: IntegrationAdminMutationCtx,
    args: { label: string },
  ): Promise<unknown> => {
    const createdAt = Date.now();
    const createdBy = await getUserIdFromAuth(ctx);
    const db = ctx.db as any;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const plaintextKey = generateApiKeyPlaintext();
      const keyHash = await hashTokenSha256(plaintextKey);
      const existing = (await db
        .query("apiKeys")
        .withIndex("by_keyHash", (q: any) => q.eq("keyHash", keyHash))
        .first()) as Doc<"apiKeys"> | null;

      if (existing) {
        continue;
      }

      const keyPrefix = extractApiKeyPrefix(plaintextKey);
      const apiKeyId = (await db.insert("apiKeys", {
        orgId: ctx.orgId,
        keyHash,
        keyPrefix,
        label: args.label,
        createdAt,
        createdBy,
      })) as Id<"apiKeys">;

      return {
        apiKeyId,
        plaintextKey,
        keyPrefix,
        label: args.label,
        createdAt,
      };
    }

    throw new Error("INTERNAL: failed to generate unique API key after 5 attempts");
  },
});

export const revokeApiKey = integrationAdminMutation({
  args: {
    apiKeyId: v.id("apiKeys"),
  },
  handler: async (ctx, args): Promise<{ revoked: boolean }> => {
    const apiKey = await ctx.db.get(args.apiKeyId);
    if (!apiKey || apiKey.orgId !== ctx.orgId) {
      throw new Error("NOT_FOUND: API key not found");
    }
    if (apiKey.revokedAt) {
      throw new Error("BAD_REQUEST: API key already revoked");
    }

    await ctx.db.patch(args.apiKeyId, { revokedAt: Date.now() });
    await ctx.scheduler.runAfter(
      0,
      internal.spark.deleteMcpRateLimitRowsForApiKey,
      { apiKeyId: args.apiKeyId },
    );
    return { revoked: true };
  },
});

function getMcpRateLimitWindow(now: number, toolClass: McpToolClass) {
  const minute = Math.floor(now / MCP_RATE_LIMIT_WINDOW_MS);
  const windowStart = minute * MCP_RATE_LIMIT_WINDOW_MS;
  return {
    bucket: `${toolClass}:${minute}`,
    windowStart,
    resetAt: windowStart + MCP_RATE_LIMIT_WINDOW_MS,
  };
}

export const lookupOrgByApiKeyHash = internalMutation({
  args: {
    keyHash: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { keyHash: string },
  ): Promise<OrgId> => {
    const db = ctx.db as any;
    const apiKey = (await db
      .query("apiKeys")
      .withIndex("by_keyHash", (q: any) => q.eq("keyHash", args.keyHash))
      .first()) as Doc<"apiKeys"> | null;

    if (!apiKey || apiKey.revokedAt) {
      throw new Error("AUTH: invalid API key");
    }

    await db.patch(apiKey._id, { lastUsedAt: Date.now() });
    return apiKey.orgId;
  },
});

export const lookupMcpApiKeyAuthByHash = internalMutation({
  args: {
    keyHash: v.string(),
  },
  returns: MCP_AUTH_RETURN_VALIDATOR,
  handler: async (
    ctx: MutationCtx,
    args: { keyHash: string },
  ): Promise<ApiKeyAuthResult> => {
    const db = ctx.db as any;
    const apiKey = (await db
      .query("apiKeys")
      .withIndex("by_keyHash", (q: any) => q.eq("keyHash", args.keyHash))
      .first()) as Doc<"apiKeys"> | null;

    if (!apiKey || apiKey.revokedAt) {
      throw new Error("AUTH: invalid API key");
    }

    return { orgId: apiKey.orgId, apiKeyId: apiKey._id };
  },
});

export const checkMcpApiKeyRateLimit = internalMutation({
  args: {
    orgId: v.id("orgs"),
    apiKeyId: v.id("apiKeys"),
    toolClass: MCP_TOOL_CLASS_VALIDATOR,
    now: v.optional(v.number()),
  },
  returns: MCP_RATE_LIMIT_RETURN_VALIDATOR,
  handler: async (
    ctx: MutationCtx,
    args: { orgId: OrgId; apiKeyId: Id<"apiKeys">; toolClass: McpToolClass; now?: number },
  ): Promise<McpRateLimitResult> => {
    const db = ctx.db as any;
    const apiKey = await ctx.db.get(args.apiKeyId);
    if (!apiKey || apiKey.revokedAt || apiKey.orgId !== args.orgId) {
      throw new Error("AUTH: invalid API key");
    }

    const now = args.now ?? Date.now();
    const limit = MCP_RATE_LIMITS[args.toolClass];
    const { bucket, windowStart, resetAt } = getMcpRateLimitWindow(
      now,
      args.toolClass,
    );
    const retryAfterMs = Math.max(resetAt - now, 0);
    const existing = (await db
      .query("mcpRateLimits")
      .withIndex("by_apiKey_bucket", (q: any) =>
        q.eq("apiKeyId", args.apiKeyId).eq("bucket", bucket),
      )
      .first()) as Doc<"mcpRateLimits"> | null;

    if (!existing) {
      await db.insert("mcpRateLimits", {
        orgId: args.orgId,
        apiKeyId: args.apiKeyId,
        bucket,
        toolClass: args.toolClass,
        count: 1,
        windowStart,
        updatedAt: now,
      });
      await patchMcpApiKeyLastUsed(ctx, apiKey, now);
      return {
        allowed: true,
        limit,
        remaining: limit - 1,
        resetAt,
        retryAfterMs,
        bucket,
        count: 1,
      };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterMs,
        bucket,
        count: existing.count,
      };
    }

    const nextCount = existing.count + 1;
    await db.patch(existing._id, {
      count: nextCount,
      updatedAt: now,
    });
    await patchMcpApiKeyLastUsed(ctx, apiKey, now);
    return {
      allowed: true,
      limit,
      remaining: Math.max(limit - nextCount, 0),
      resetAt,
      retryAfterMs,
      bucket,
      count: nextCount,
    };
  },
});

export const deleteMcpRateLimitRowsForApiKey = internalMutation({
  args: {
    apiKeyId: v.id("apiKeys"),
  },
  returns: DELETED_COUNT_RETURN_VALIDATOR,
  handler: async (
    ctx: MutationCtx,
    args: { apiKeyId: Id<"apiKeys"> },
  ): Promise<{ deleted: number }> => {
    const db = ctx.db as any;
    const rows = (await db
      .query("mcpRateLimits")
      .withIndex("by_apiKey", (q: any) => q.eq("apiKeyId", args.apiKeyId))
      .take(MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE)) as Doc<"mcpRateLimits">[];

    for (const row of rows) {
      await db.delete(row._id);
    }

    if (rows.length === MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.spark.deleteMcpRateLimitRowsForApiKey,
        { apiKeyId: args.apiKeyId },
      );
    }

    return { deleted: rows.length };
  },
});

export const deleteOldMcpRateLimitRowsForOrg = internalMutation({
  args: {
    orgId: v.id("orgs"),
    olderThan: v.number(),
  },
  returns: DELETED_COUNT_RETURN_VALIDATOR,
  handler: async (
    ctx: MutationCtx,
    args: { orgId: OrgId; olderThan: number },
  ): Promise<{ deleted: number }> => {
    const db = ctx.db as any;
    const rows = (await db
      .query("mcpRateLimits")
      .withIndex("by_org_updated", (q: any) =>
        q.eq("orgId", args.orgId).lt("updatedAt", args.olderThan),
      )
      .take(MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE)) as Doc<"mcpRateLimits">[];

    for (const row of rows) {
      await db.delete(row._id);
    }

    if (rows.length === MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.spark.deleteOldMcpRateLimitRowsForOrg,
        args,
      );
    }

    return { deleted: rows.length };
  },
});

export const cleanupMcpRateLimitRows = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    scheduled: number;
    now: number;
    olderThan: number;
  }> => {
    const now = Date.now();
    const olderThan = now - MCP_RATE_LIMIT_RETENTION_MS;
    const orgCount = await forEachOrgIdPage(ctx, async (orgId) => {
      await ctx.scheduler.runAfter(
        0,
        internal.spark.deleteOldMcpRateLimitRowsForOrg,
        { orgId, olderThan },
      );
    });

    console.log("spark:cleanupMcpRateLimitRows", {
      scheduled: orgCount,
      now,
      olderThan,
    });

    return {
      scheduled: orgCount,
      now,
      olderThan,
    };
  },
});

export const issueManagedMcpToken = internalAction({
  args: {
    orgId: v.id("orgs"),
    purpose: MANAGED_MCP_PURPOSE_VALIDATOR,
  },
  handler: async (
    _ctx: ActionCtx,
    args: { orgId: OrgId; purpose: ManagedMcpPurpose },
  ): Promise<{ token: string; expiresAt: number }> => {
    return buildManagedMcpToken(args);
  },
});

export const lookupOrgByManagedMcpToken = internalAction({
  args: {
    bearerToken: v.string(),
  },
  handler: async (
    _ctx: ActionCtx,
    args: { bearerToken: string },
  ): Promise<OrgId> => {
    return verifyManagedMcpToken({ bearerToken: args.bearerToken });
  },
});

export const lookupOrgByApiKey = internalAction({
  args: {
    bearerToken: v.string(),
  },
  handler: async (
    ctx: ActionCtx,
    args: { bearerToken: string },
  ): Promise<OrgId> => {
    const trimmedToken = args.bearerToken.trim();
    if (!trimmedToken) {
      throw new Error("AUTH: missing bearer token");
    }

    const keyHash = await hashTokenSha256(trimmedToken);
    return (await ctx.runMutation(internal.spark.lookupOrgByApiKeyHash, { keyHash })) as OrgId;
  },
});

export const lookupMcpApiKeyAuth = internalAction({
  args: {
    bearerToken: v.string(),
  },
  returns: MCP_AUTH_RETURN_VALIDATOR,
  handler: async (
    ctx: ActionCtx,
    args: { bearerToken: string },
  ): Promise<ApiKeyAuthResult> => {
    const trimmedToken = args.bearerToken.trim();
    if (!trimmedToken) {
      throw new Error("AUTH: missing bearer token");
    }

    const keyHash = await hashTokenSha256(trimmedToken);
    return (await ctx.runMutation(internal.spark.lookupMcpApiKeyAuthByHash, { keyHash })) as ApiKeyAuthResult;
  },
});

function hasSynthesisInputs(inputs: SynthesisInputs): boolean {
  return (
    inputs.sessionPages.length > 0 ||
    inputs.updatedPages.length > 0 ||
    inputs.goalPages.length > 0 ||
    inputs.findingPages.length > 0 ||
    inputs.lowerSyntheses.length > 0
  );
}

function isSynthesisDependencyFailureTerminal(
  readiness: SynthesisDependencyReadiness,
): boolean {
  return readiness.terminalFailed.length > 0;
}

function formatSynthesisDependencyError(
  readiness: SynthesisDependencyReadiness,
): string {
  const parts = [
    `Dependency syntheses not ready for ${readiness.period}`,
    `lowerPeriod=${readiness.lowerPeriod ?? "none"}`,
    `completed=${readiness.completedCount}/${readiness.expectedCount}`,
    `missing=${readiness.missing.length}`,
    `inProgress=${readiness.inProgress.length}`,
    `retryableFailed=${readiness.retryableFailed.length}`,
    `terminalFailed=${readiness.terminalFailed.length}`,
  ];
  const sample =
    readiness.terminalFailed[0] ??
    readiness.inProgress[0] ??
    readiness.retryableFailed[0] ??
    readiness.missing[0] ??
    null;
  if (sample) {
    parts.push(`sample=${sample.timestamp}-${sample.windowEnd}`);
  }
  return parts.join("; ");
}

async function fanOutSynthesesForPeriod(
  ctx: RunQueryContext & RunMutationContext & RunSchedulerContext,
  period: SynthesisPeriod,
  options?: { includeOrgIds?: ReadonlySet<string>; now?: number },
) {
  const now = options?.now ?? Date.now();
  const window = getLatestClosedSynthesisWindow(period, now);

  let eligible = 0;
  let scheduled = 0;
  let skippedNoRelevantKnowledge = 0;
  let skippedCompleted = 0;
  let skippedFreshInProgress = 0;
  let reclaimed = 0;
  let deferredDependencies = 0;
  let blockedDependencies = 0;

  const orgCount = await forEachOrgIdPage(ctx, async (orgId) => {
    const fanOutState = (await ctx.runQuery(getSynthesisFanOutStateRef, {
      orgId,
      period,
      timestamp: window.timestamp,
      windowEnd: window.windowEnd,
    })) as SynthesisFanOutState;

    const requiresDeterministicWindowRow =
      fanOutState.targetStatus === null || fanOutState.targetStatus === "failed";
    if (!fanOutState.hasRelevantKnowledge && !requiresDeterministicWindowRow) {
      skippedNoRelevantKnowledge += 1;
      return;
    }

    const dependencyReadiness =
      period === "daily"
        ? null
        : ((await ctx.runQuery(getSynthesisDependencyReadinessRef, {
            orgId,
            period,
            timestamp: window.timestamp,
            windowEnd: window.windowEnd,
          })) as SynthesisDependencyReadiness);

    eligible += 1;
    const claim = (await ctx.runMutation(claimSynthesisRunRef, {
      orgId,
      period,
      timestamp: window.timestamp,
      windowEnd: window.windowEnd,
      now,
    })) as {
      status:
        | "claimed"
        | "skipped_completed"
        | "skipped_terminal_failed"
        | "skipped_fresh_in_progress"
        | "reclaimed_stale"
        | "reclaimed_failed";
      synthesisId: Id<"syntheses">;
    };

    if (claim.status === "skipped_completed") {
      skippedCompleted += 1;
      return;
    }
    if (claim.status === "skipped_terminal_failed") {
      skippedCompleted += 1;
      return;
    }
    if (claim.status === "skipped_fresh_in_progress") {
      skippedFreshInProgress += 1;
      return;
    }

    if (dependencyReadiness && !dependencyReadiness.ready) {
      if (
        claim.status === "reclaimed_stale" ||
        claim.status === "reclaimed_failed"
      ) {
        reclaimed += 1;
      }

      const terminalDependency =
        isSynthesisDependencyFailureTerminal(dependencyReadiness);
      const failureKind: SynthesisFailureKind = terminalDependency
        ? "fatal"
        : "dependency_wait";
      const failure = await ctx.runMutation(markSynthesisFailedRef, {
        synthesisId: claim.synthesisId,
        error: formatSynthesisDependencyError(dependencyReadiness),
        failureKind,
        nextRetryAt: terminalDependency
          ? undefined
          : (dependencyReadiness.nextRetryAt ?? undefined),
        now,
      });
      if (terminalDependency) {
        blockedDependencies += 1;
      } else if (failure.status === "failed") {
        deferredDependencies += 1;
      }
      return;
    }

    if (
      claim.status === "reclaimed_stale" ||
      claim.status === "reclaimed_failed"
    ) {
      reclaimed += 1;
    }

    await ctx.scheduler.runAfter(0, runSynthesisActionRef, {
      synthesisId: claim.synthesisId,
    });
    scheduled += 1;
  }, options);

  console.log("spark:synthesisFanOut", {
    period,
    timestamp: window.timestamp,
    windowEnd: window.windowEnd,
    orgCount,
    eligible,
    scheduled,
    skippedNoRelevantKnowledge,
    skippedCompleted,
    skippedFreshInProgress,
    reclaimed,
    deferredDependencies,
    blockedDependencies,
  });

  return {
    period,
    timestamp: window.timestamp,
    windowEnd: window.windowEnd,
    orgCount,
    eligible,
    scheduled,
    skippedNoRelevantKnowledge,
    skippedCompleted,
    skippedFreshInProgress,
    reclaimed,
    deferredDependencies,
    blockedDependencies,
  };
}

async function finalizeSynthesisOrMarkFailed(
  ctx: RunMutationContext,
  args: {
    synthesisId: Id<"syntheses">;
    summary: string;
    actors: string[];
    repos: string[];
    sourcePageIds: Id<"knowledgePages">[];
    sourceSynthesisIds: Id<"syntheses">[];
    inputTokensCached?: number;
    inputTokensUncached?: number;
    outputTokens?: number;
    warnings?: string[];
    expectedClaimedAt?: number;
  },
): Promise<any> {
  return await ctx.runMutation(finalizeSynthesisRunRef, args);
}

export const runSynthesisAction = internalAction({
  args: {
    synthesisId: v.id("syntheses"),
  },
  handler: async (ctx, args): Promise<SynthesisActionResult> => {
    const startedAt = Date.now();
    const synthesis = (await ctx.runQuery(getSynthesisRunByIdRef, {
      synthesisId: args.synthesisId,
    })) as Doc<"syntheses"> | null;

    if (!synthesis) {
      console.warn("spark:runSynthesisAction", {
        synthesisId: args.synthesisId,
        status: "skipped_missing",
      });
      return {
        status: "skipped_missing",
        synthesisId: args.synthesisId,
        durationMs: Date.now() - startedAt,
      };
    }

    if (synthesis.status === "completed" || synthesis.status === "failed") {
      console.log("spark:runSynthesisAction", {
        synthesisId: synthesis._id,
        orgId: synthesis.orgId,
        period: synthesis.period,
        status: "skipped_terminal",
        terminalStatus: synthesis.status,
      });
      return {
        status: "skipped_terminal",
        synthesisId: synthesis._id,
        orgId: synthesis.orgId,
        period: synthesis.period,
        durationMs: Date.now() - startedAt,
      };
    }

    if (synthesis.status !== "in_progress") {
      console.warn("spark:runSynthesisAction", {
        synthesisId: synthesis._id,
        orgId: synthesis.orgId,
        period: synthesis.period,
        status: "skipped_not_in_progress",
        rowStatus: synthesis.status,
      });
      return {
        status: "skipped_not_in_progress",
        synthesisId: synthesis._id,
        orgId: synthesis.orgId,
        period: synthesis.period,
        durationMs: Date.now() - startedAt,
      };
    }

    const claimGuard =
      synthesis.claimedAt === undefined
        ? {}
        : { expectedClaimedAt: synthesis.claimedAt };

    try {
      if (synthesis.period !== "daily") {
        const dependencyReadiness = (await ctx.runQuery(
          getSynthesisDependencyReadinessRef,
          {
            orgId: synthesis.orgId,
            period: synthesis.period,
            timestamp: synthesis.timestamp,
            windowEnd: synthesis.windowEnd,
          },
        )) as SynthesisDependencyReadiness;

        if (!dependencyReadiness.ready) {
          const terminalDependency =
            isSynthesisDependencyFailureTerminal(dependencyReadiness);
          const message = formatSynthesisDependencyError(dependencyReadiness);
          const failureKind: SynthesisFailureKind = terminalDependency
            ? "fatal"
            : "dependency_wait";
          const failureResult = await ctx.runMutation(markSynthesisFailedRef, {
            synthesisId: synthesis._id,
            error: message,
            failureKind,
            nextRetryAt: terminalDependency
              ? undefined
              : (dependencyReadiness.nextRetryAt ?? undefined),
            ...claimGuard,
          });
          if (failureResult.status === "skipped_stale_claim") {
            console.warn("spark:runSynthesisAction", {
              synthesisId: synthesis._id,
              orgId: synthesis.orgId,
              period: synthesis.period,
              status: "skipped_stale_claim",
              failureKind,
              expectedClaimedAt: failureResult.expectedClaimedAt,
              currentClaimedAt: failureResult.currentClaimedAt,
              currentStatus: failureResult.currentStatus,
              durationMs: Date.now() - startedAt,
              error: message,
            });
            return {
              status: "skipped_stale_claim",
              synthesisId: synthesis._id,
              orgId: synthesis.orgId,
              period: synthesis.period,
              durationMs: Date.now() - startedAt,
              error: message,
            };
          }

          console.warn("spark:runSynthesisAction", {
            synthesisId: synthesis._id,
            orgId: synthesis.orgId,
            period: synthesis.period,
            status: terminalDependency
              ? "blocked_dependency_terminal"
              : "deferred_dependency_not_ready",
            failureKind,
            retryCount: failureResult.retryCount,
            nextRetryAt: failureResult.nextRetryAt ?? null,
            terminalFailure: failureResult.terminalFailure ?? false,
            durationMs: Date.now() - startedAt,
            error: message,
          });
          return {
            status: "failed",
            synthesisId: synthesis._id,
            orgId: synthesis.orgId,
            period: synthesis.period,
            durationMs: Date.now() - startedAt,
            error: message,
          };
        }
      }

      const inputs = (await ctx.runQuery(getSynthesisInputsRef, {
        orgId: synthesis.orgId,
        period: synthesis.period,
        timestamp: synthesis.timestamp,
        windowEnd: synthesis.windowEnd,
        limit: SYNTHESIS_INPUT_LIMIT,
      })) as SynthesisInputs;

      if (!hasSynthesisInputs(inputs)) {
        const warnings: string[] = [];
        const finalizeResult = await finalizeSynthesisOrMarkFailed(ctx, {
          synthesisId: synthesis._id,
          summary: buildNoActivitySummary(
            synthesis.period,
            synthesis.timestamp,
            synthesis.windowEnd,
          ),
          actors: [],
          repos: [],
          sourcePageIds: [],
          sourceSynthesisIds: [],
          warnings,
          ...claimGuard,
        });
        if (finalizeResult.status === "skipped_stale_claim") {
          console.warn("spark:runSynthesisAction", {
            synthesisId: synthesis._id,
            orgId: synthesis.orgId,
            period: synthesis.period,
            status: "skipped_stale_claim",
            expectedClaimedAt: finalizeResult.expectedClaimedAt,
            currentClaimedAt: finalizeResult.currentClaimedAt,
            currentStatus: finalizeResult.currentStatus,
            durationMs: Date.now() - startedAt,
          });
          return {
            status: "skipped_stale_claim",
            synthesisId: synthesis._id,
            orgId: synthesis.orgId,
            period: synthesis.period,
            durationMs: Date.now() - startedAt,
          };
        }

        console.log("spark:runSynthesisAction", {
          synthesisId: synthesis._id,
          orgId: synthesis.orgId,
          period: synthesis.period,
          status: "completed_no_activity",
          durationMs: Date.now() - startedAt,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        });
        return {
          status: "completed_no_activity",
          synthesisId: synthesis._id,
          orgId: synthesis.orgId,
          period: synthesis.period,
          durationMs: Date.now() - startedAt,
        };
      }

      const evidencePack = buildSynthesisEvidencePack(inputs);
      const org = (await ctx.runQuery(internal.spark.getOrgById, {
        orgId: synthesis.orgId,
      })) as Doc<"orgs">;
      const client = org.anthropicApiKey
        ? new Anthropic({ apiKey: org.anthropicApiKey })
        : anthropicClient;

      let attempts = 0;
      const response = await withRetriableCall(classifyAnthropicRetry, async () => {
        attempts += 1;
        return client.messages.parse({
          model: SYNTHESIS_MODEL,
          max_tokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
          temperature: 0,
          system: [
            {
              type: "text" as const,
              text: SYNTHESIS_SYSTEM_PROMPT,
              cache_control: SYNTHESIS_CACHE_CONTROL,
            },
          ],
          messages: [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: SYNTHESIS_USER_STABLE_PREFIX,
                  cache_control: SYNTHESIS_CACHE_CONTROL,
                },
                {
                  type: "text" as const,
                  text: evidencePack.prompt,
                },
              ],
            },
          ],
          output_config: {
            format: zodOutputFormat(SYNTHESIS_OUTPUT_SCHEMA as any) as any,
          },
        });
      });

      const parsedOutput = response.parsed_output as {
        summary: string;
        actors: string[];
        repos: string[];
      } | null;
      if (!parsedOutput) {
        throw new Error("Synthesis parse returned no parsed output");
      }

      const warnings = [...evidencePack.warnings];
      const summary = normalizeSynthesisSummary(parsedOutput.summary, warnings);
      const actors = dedupeSortedStrings([
        ...evidencePack.actors,
        ...parsedOutput.actors,
      ]);
      const repos = dedupeSortedStrings([
        ...evidencePack.repos,
        ...parsedOutput.repos,
      ]);
      const inputTokensCached = response.usage.cache_read_input_tokens ?? 0;
      const inputTokensUncached =
        (response.usage.input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0);
      const outputTokens = response.usage.output_tokens ?? 0;

      // Persist synthesis usage (A-11, source: synthesizer). Fail-soft.
      try {
        await ctx.runMutation(internal.usage.recordUsage, {
          orgId: synthesis.orgId,
          source: "synthesizer",
          model: SYNTHESIS_MODEL,
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens:
            response.usage.cache_creation_input_tokens ?? 0,
          costCents: calculateCostCents(
            SYNTHESIS_MODEL,
            {
              promptTokens: response.usage.input_tokens ?? 0,
              completionTokens: outputTokens,
            },
            {
              anthropic: {
                cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
                cacheCreationInputTokens:
                  response.usage.cache_creation_input_tokens ?? 0,
              },
            },
          ),
        });
      } catch (usageError) {
        console.warn("spark:usageRecordFailed", {
          source: "synthesizer",
          error: String(usageError),
        });
      }

      const finalizeResult = await finalizeSynthesisOrMarkFailed(ctx, {
        synthesisId: synthesis._id,
        summary,
        actors,
        repos,
        sourcePageIds: evidencePack.sourcePageIds,
        sourceSynthesisIds: evidencePack.sourceSynthesisIds,
        inputTokensCached,
        inputTokensUncached,
        outputTokens,
        warnings,
        ...claimGuard,
      });
      if (finalizeResult.status === "skipped_stale_claim") {
        console.warn("spark:runSynthesisAction", {
          synthesisId: synthesis._id,
          orgId: synthesis.orgId,
          period: synthesis.period,
          status: "skipped_stale_claim",
          expectedClaimedAt: finalizeResult.expectedClaimedAt,
          currentClaimedAt: finalizeResult.currentClaimedAt,
          currentStatus: finalizeResult.currentStatus,
          durationMs: Date.now() - startedAt,
        });
        return {
          status: "skipped_stale_claim",
          synthesisId: synthesis._id,
          orgId: synthesis.orgId,
          period: synthesis.period,
          durationMs: Date.now() - startedAt,
          attempts,
          warnings,
        };
      }

      console.log("spark:runSynthesisAction", {
        synthesisId: synthesis._id,
        orgId: synthesis.orgId,
        period: synthesis.period,
        status: "completed",
        durationMs: Date.now() - startedAt,
        attempts,
        cachedInputTokens: inputTokensCached,
        uncachedInputTokens: inputTokensUncached,
        outputTokens,
        estimatedInputTokens: evidencePack.estimatedInputTokens,
        warnings,
      });
      return {
        status: "completed",
        synthesisId: synthesis._id,
        orgId: synthesis.orgId,
        period: synthesis.period,
        durationMs: Date.now() - startedAt,
        attempts,
        warnings,
      };
    } catch (error) {
      const message = getSynthesisErrorMessage(error);
      const failureKind = isFatalAnthropicError(error)
        ? "fatal"
        : classifyAnthropicRetry(error)
          ? "transient_exhausted"
          : "unexpected";
      const failureResult = await ctx.runMutation(markSynthesisFailedRef, {
        synthesisId: synthesis._id,
        error: message,
        failureKind,
        ...claimGuard,
      });
      if (failureResult.status === "skipped_stale_claim") {
        console.warn("spark:runSynthesisAction", {
          synthesisId: synthesis._id,
          orgId: synthesis.orgId,
          period: synthesis.period,
          status: "skipped_stale_claim",
          failureKind,
          expectedClaimedAt: failureResult.expectedClaimedAt,
          currentClaimedAt: failureResult.currentClaimedAt,
          currentStatus: failureResult.currentStatus,
          durationMs: Date.now() - startedAt,
          error: message,
        });
        return {
          status: "skipped_stale_claim",
          synthesisId: synthesis._id,
          orgId: synthesis.orgId,
          period: synthesis.period,
          durationMs: Date.now() - startedAt,
          error: message,
        };
      }

      console.error("spark:runSynthesisAction", {
        synthesisId: synthesis._id,
        orgId: synthesis.orgId,
        period: synthesis.period,
        status: "failed",
        failureKind,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return {
        status: "failed",
        synthesisId: synthesis._id,
        orgId: synthesis.orgId,
        period: synthesis.period,
        durationMs: Date.now() - startedAt,
        error: message,
      };
    }
  },
});

export const dailySynthesis = internalAction({
  args: {},
  handler: async (ctx) => fanOutSynthesesForPeriod(ctx, "daily"),
});

export const weeklySynthesis = internalAction({
  args: {},
  handler: async (ctx) => fanOutSynthesesForPeriod(ctx, "weekly"),
});

export const monthlySynthesis = internalAction({
  args: {},
  handler: async (ctx) => fanOutSynthesesForPeriod(ctx, "monthly"),
});

export const debugDailySynthesisForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    fanOutSynthesesForPeriod(ctx, "daily", {
      includeOrgIds: new Set([args.orgId as string]),
      now: args.now,
    }),
});

export const debugWeeklySynthesisForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    fanOutSynthesesForPeriod(ctx, "weekly", {
      includeOrgIds: new Set([args.orgId as string]),
      now: args.now,
    }),
});

export const debugMonthlySynthesisForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    fanOutSynthesesForPeriod(ctx, "monthly", {
      includeOrgIds: new Set([args.orgId as string]),
      now: args.now,
    }),
});

export const runLinter = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const orgCount = await forEachOrgIdPage(ctx, async (orgId) => {
      await ctx.scheduler.runAfter(0, runLinterForOrgRef, {
        orgId,
        now,
      });
    });

    console.log("spark:runLinter", {
      scheduled: orgCount,
      now,
    });

    return {
      scheduled: orgCount,
      now,
    };
  },
});

export const runLinterForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    now: v.optional(v.number()),
    candidateCursor: v.optional(v.string()),
    activeSlugs: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<RunLinterForOrgResult> => {
    const startedAt = Date.now();
    const now = args.now ?? startedAt;
    const staleBefore = now - LINTER_STALE_DECISION_MS;
    const orphanGraceBefore = now - LINTER_GRACE_MS;
    const weakProvenanceGraceBefore = now - LINTER_GRACE_MS;
    const candidateResult = (await ctx.runQuery(listLinterCandidatesRef, {
      orgId: args.orgId,
      staleBefore,
      orphanGraceBefore,
      weakProvenanceGraceBefore,
      limit: LINTER_CANDIDATE_BATCH_SIZE,
      cursor: args.candidateCursor,
    })) as LinterCandidateResult;

    const staleDecisionFindings = candidateResult.pages
      .filter(
        (page) =>
          page.type === "decision" && page.lastConfirmed < staleBefore,
      )
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((page) => buildStaleDecisionFinding(page, now));

    // Orphan-page and weak-provenance findings are intentionally disabled. In an
    // auto-generated, event-sourced KB they fire on a large fraction of pages
    // (every page starts from a single source; many one-off facts legitimately
    // have no inbound links), so they only produce noise. Only stale-decision
    // deterministic findings remain (plus the separate AI contradiction linter).
    // Existing instances are archived out of the active view.
    const activeFindings = [...staleDecisionFindings];
    const activeSlugs = dedupeSortedStrings(
      activeFindings.map((finding) => finding.slug),
    );
    const accumulatedActiveSlugs = dedupeSortedStrings([
      ...(args.activeSlugs ?? []),
      ...activeSlugs,
    ]);

    for (const finding of activeFindings) {
      await ctx.runMutation(upsertLinterFindingRef, {
        orgId: args.orgId,
        ...finding,
      });
    }

    let scheduledContinuation = false;
    if (candidateResult.nextCursor !== null) {
      scheduledContinuation = true;
      await ctx.scheduler.runAfter(0, runLinterForOrgRef, {
        orgId: args.orgId,
        now,
        candidateCursor: candidateResult.nextCursor,
        activeSlugs: accumulatedActiveSlugs,
      });
    }

    let resolved: {
      resolvedCount: number;
      resolvedSlugs: string[];
    } = {
      resolvedCount: 0,
      resolvedSlugs: [],
    };
    if (candidateResult.isDone) {
      resolved = (await ctx.runMutation(resolveObsoleteLinterFindingsRef, {
        orgId: args.orgId,
        activeSlugs: accumulatedActiveSlugs,
        managedTags: [...LINTER_DETERMINISTIC_TAGS],
        limit: LINTER_OBSOLETE_FINDING_BATCH_SIZE,
      })) as {
        resolvedCount: number;
        resolvedSlugs: string[];
      };
    }

    let contradictionStatus: AiContradictionStatus = candidateResult.isDone
      ? "skipped_no_candidates"
      : "skipped_continuation";
    let contradictionCandidatePairs = 0;
    let contradictionFindings: AiContradictionFindingInput[] = [];
    let contradictionActiveSlugs: string[] = [];
    let contradictionResolvedCount = 0;
    let contradictionResolvedSlugs: string[] = [];
    let contradictionWarnings: string[] = [];
    let contradictionError: string | undefined;

    if (candidateResult.isDone) {
      try {
      const contradictionCandidates = (await ctx.runQuery(
        listContradictionCandidatePairsRef,
        {
          orgId: args.orgId,
          pageLimit: LINTER_CONTRADICTION_PAGE_LIMIT,
          pairLimit: LINTER_CONTRADICTION_PAIR_LIMIT,
        },
      )) as { pairs: ContradictionCandidatePair[] };
      const evidencePack = buildContradictionEvidencePack(
        contradictionCandidates.pairs,
      );
      contradictionCandidatePairs = evidencePack.pairs.length;
      contradictionWarnings = [...evidencePack.warnings];
      let contradictionAttempts = 0;
      let cacheReadInputTokens = 0;
      let uncachedInputTokens = 0;
      let outputTokens = 0;

      if (evidencePack.pairs.length > 0) {
        const org = (await ctx.runQuery(internal.spark.getOrgById, {
          orgId: args.orgId,
        })) as Doc<"orgs">;
        const client = org.anthropicApiKey
          ? new Anthropic({ apiKey: org.anthropicApiKey })
          : anthropicClient;

        const response = await withRetriableCall(classifyAnthropicRetry, async () => {
          contradictionAttempts += 1;
          return client.messages.parse({
            model: LINTER_CONTRADICTION_MODEL,
            max_tokens: LINTER_CONTRADICTION_MAX_OUTPUT_TOKENS,
            temperature: 0,
            system: [
              {
                type: "text" as const,
                text: CONTRADICTION_LINTER_SYSTEM_PROMPT,
                cache_control: LINTER_CONTRADICTION_CACHE_CONTROL,
              },
            ],
            messages: [
              {
                role: "user" as const,
                content: [
                  {
                    type: "text" as const,
                    text: CONTRADICTION_LINTER_USER_STABLE_PREFIX,
                    cache_control: LINTER_CONTRADICTION_CACHE_CONTROL,
                  },
                  {
                    type: "text" as const,
                    text: evidencePack.prompt,
                  },
                ],
              },
            ],
            output_config: {
              format: zodOutputFormat(CONTRADICTION_LINTER_OUTPUT_SCHEMA as any) as any,
            },
          });
        });

        const parsedOutput = response.parsed_output as ContradictionLinterOutput | null;
        if (!parsedOutput) {
          throw new Error("Contradiction linter parse returned no parsed output");
        }
        cacheReadInputTokens = response.usage.cache_read_input_tokens ?? 0;
        uncachedInputTokens =
          (response.usage.input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0);
        outputTokens = response.usage.output_tokens ?? 0;

        // Persist linter usage (A-11, source: linter). Fail-soft.
        try {
          await ctx.runMutation(internal.usage.recordUsage, {
            orgId: args.orgId,
            source: "linter",
            model: LINTER_CONTRADICTION_MODEL,
            inputTokens: response.usage.input_tokens ?? 0,
            outputTokens,
            cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens:
              response.usage.cache_creation_input_tokens ?? 0,
            costCents: calculateCostCents(
              LINTER_CONTRADICTION_MODEL,
              {
                promptTokens: response.usage.input_tokens ?? 0,
                completionTokens: outputTokens,
              },
              {
                anthropic: {
                  cacheReadInputTokens:
                    response.usage.cache_read_input_tokens ?? 0,
                  cacheCreationInputTokens:
                    response.usage.cache_creation_input_tokens ?? 0,
                },
              },
            ),
          });
        } catch (usageError) {
          console.warn("spark:usageRecordFailed", {
            source: "linter",
            error: String(usageError),
          });
        }

        contradictionWarnings.push(
          ...dedupeStringsPreserveOrder(parsedOutput.warnings ?? []).map(
            (warning) =>
              clipSynthesisText(
                warning,
                LINTER_CONTRADICTION_EVIDENCE_CHAR_LIMIT,
              ),
          ),
        );
        const pairByKey = new Map(
          evidencePack.pairs.map((pair) => [pair.pairKey, pair]),
        );
        contradictionFindings = normalizeAiContradictionFindings({
          output: parsedOutput,
          pairByKey,
          warnings: contradictionWarnings,
        });
        contradictionActiveSlugs = dedupeSortedStrings(
          contradictionFindings.map((finding) => finding.slug),
        );

        for (const finding of contradictionFindings) {
          await ctx.runMutation(upsertLinterFindingRef, {
            orgId: args.orgId,
            slug: finding.slug,
            title: finding.title,
            compiledTruth: finding.compiledTruth,
            evidenceTimeline: finding.evidenceTimeline,
            tags: finding.tags,
            confidence: finding.confidence,
            severity: finding.severity,
            findingType: finding.findingType,
            implication: finding.implication,
            relatedPageIds: finding.relatedPageIds,
          });
        }
      }

      const contradictionResolved = (await ctx.runMutation(
        resolveObsoleteLinterFindingsRef,
        {
          orgId: args.orgId,
          activeSlugs: contradictionActiveSlugs,
          managedTags: [...LINTER_AI_CONTRADICTION_TAGS],
          managedSlugs: evidencePack.candidateFindingSlugs,
          managedSourcePairKeys: evidencePack.candidateSourcePairKeys,
          limit: LINTER_OBSOLETE_FINDING_BATCH_SIZE,
        },
      )) as {
        resolvedCount: number;
        resolvedSlugs: string[];
      };
      contradictionResolvedCount = contradictionResolved.resolvedCount;
      contradictionResolvedSlugs = contradictionResolved.resolvedSlugs;
      contradictionWarnings = dedupeSortedStrings(contradictionWarnings);

      if (evidencePack.pairs.length > 0) {
        contradictionStatus = "succeeded";

        console.log("spark:runLinterForOrg:contradictions", {
          orgId: args.orgId,
          status: contradictionStatus,
          candidates: contradictionCandidatePairs,
          findings: contradictionFindings.length,
          activeSlugs: contradictionActiveSlugs,
          resolvedCount: contradictionResolvedCount,
          attempts: contradictionAttempts,
          cachedInputTokens: cacheReadInputTokens,
          uncachedInputTokens,
          outputTokens,
          estimatedInputTokens: evidencePack.estimatedInputTokens,
          warnings: contradictionWarnings,
        });
      }
      } catch (error) {
      contradictionStatus = "failed";
      contradictionError = clipSynthesisText(
        getSynthesisErrorMessage(error),
        LINTER_CONTRADICTION_ERROR_TAIL_CHARS,
      );
      const failureKind = isFatalAnthropicError(error)
        ? "fatal"
        : classifyAnthropicRetry(error)
          ? "transient_exhausted"
          : "unexpected";
      contradictionWarnings = dedupeSortedStrings(contradictionWarnings);
      console.error("spark:runLinterForOrg:contradictions", {
        orgId: args.orgId,
        status: contradictionStatus,
        failureKind,
        candidates: contradictionCandidatePairs,
        error: contradictionError,
        warnings: contradictionWarnings,
      });
      }
    }

    const durationMs = Date.now() - startedAt;
    console.log("spark:runLinterForOrg", {
      orgId: args.orgId,
      candidateBatchDone: candidateResult.isDone,
      candidateScannedCount: candidateResult.scannedCount,
      scheduledContinuation,
      staleDecision: staleDecisionFindings.length,
      orphanPage: 0,
      weakProvenance: 0,
      activeSlugs: accumulatedActiveSlugs,
      resolvedCount: resolved.resolvedCount,
      contradictionStatus,
      contradiction: contradictionFindings.length,
      contradictionCandidatePairs,
      contradictionResolvedCount,
      durationMs,
    });

    return {
      orgId: args.orgId,
      candidateBatchDone: candidateResult.isDone,
      candidateScannedCount: candidateResult.scannedCount,
      scheduledContinuation,
      continueCursor: candidateResult.nextCursor,
      staleDecision: staleDecisionFindings.length,
      orphanPage: 0,
      weakProvenance: 0,
      activeSlugs: accumulatedActiveSlugs,
      resolvedCount: resolved.resolvedCount,
      resolvedSlugs: resolved.resolvedSlugs,
      contradictionStatus,
      contradiction: contradictionFindings.length,
      contradictionCandidatePairs,
      contradictionActiveSlugs,
      contradictionResolvedCount,
      contradictionResolvedSlugs,
      contradictionWarnings,
      contradictionError,
      durationMs,
    };
  },
});

export const synthesisStaleSweep = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const staleBefore = now - SYNTHESIS_CLAIM_STALE_MS;
    const staleRuns = (await ctx.runQuery(findStaleSynthesisRunsRef, {
      staleBefore,
      limit: SYNTHESIS_SWEEP_LIMIT,
    })) as SynthesisRunSummary[];
    const failedRuns = (await ctx.runQuery(findRecoverableFailedSynthesisRunsRef, {
      now,
      limit: SYNTHESIS_SWEEP_LIMIT,
    })) as SynthesisRunSummary[];

    let staleReclaimed = 0;
    let staleScheduled = 0;
    let staleSkipped = 0;
    let failedReclaimed = 0;
    let failedScheduled = 0;
    let failedSkipped = 0;

    for (const staleRun of staleRuns) {
      const claim = (await ctx.runMutation(claimSynthesisRunRef, {
        orgId: staleRun.orgId,
        period: staleRun.period,
        timestamp: staleRun.timestamp,
        windowEnd: staleRun.windowEnd,
        now,
      })) as {
        status:
          | "claimed"
          | "skipped_completed"
          | "skipped_terminal_failed"
          | "skipped_fresh_in_progress"
          | "reclaimed_stale"
          | "reclaimed_failed";
        synthesisId: Id<"syntheses">;
      };

      if (claim.status !== "reclaimed_stale") {
        staleSkipped += 1;
        continue;
      }

      staleReclaimed += 1;
      await ctx.scheduler.runAfter(0, runSynthesisActionRef, {
        synthesisId: claim.synthesisId,
      });
      staleScheduled += 1;
    }

    for (const failedRun of failedRuns) {
      const claim = (await ctx.runMutation(claimSynthesisRunRef, {
        orgId: failedRun.orgId,
        period: failedRun.period,
        timestamp: failedRun.timestamp,
        windowEnd: failedRun.windowEnd,
        now,
      })) as {
        status:
          | "claimed"
          | "skipped_completed"
          | "skipped_terminal_failed"
          | "skipped_fresh_in_progress"
          | "reclaimed_stale"
          | "reclaimed_failed";
        synthesisId: Id<"syntheses">;
      };

      if (claim.status !== "reclaimed_failed") {
        failedSkipped += 1;
        continue;
      }

      failedReclaimed += 1;
      await ctx.scheduler.runAfter(0, runSynthesisActionRef, {
        synthesisId: claim.synthesisId,
      });
      failedScheduled += 1;
    }

    console.log("spark:synthesisStaleSweep", {
      staleBefore,
      found: staleRuns.length,
      reclaimed: staleReclaimed,
      scheduled: staleScheduled,
      skipped: staleSkipped,
      staleFound: staleRuns.length,
      staleReclaimed,
      staleScheduled,
      staleSkipped,
      failedFound: failedRuns.length,
      failedReclaimed,
      failedScheduled,
      failedSkipped,
    });

    return {
      staleBefore,
      found: staleRuns.length,
      reclaimed: staleReclaimed,
      scheduled: staleScheduled,
      skipped: staleSkipped,
      staleFound: staleRuns.length,
      staleReclaimed,
      staleScheduled,
      staleSkipped,
      failedFound: failedRuns.length,
      failedReclaimed,
      failedScheduled,
      failedSkipped,
    };
  },
});
