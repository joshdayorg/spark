/**
 * Persistent dev utilities for deploy-time sanity and shakedown inspection.
 *
 * Born out of the 2026-04-21 Part 4a unblock where a misdiagnosis about
 * stale rows cost an hour; `inventory` + `listSources` are now the
 * first stop before any Phase deploy. Read-only.
 *
 * PROCESS.md Pre-Ship Ritual: run `npx convex run debug:inventory` + check
 * `node --version` (must be v18/20/22/24) before `convex dev --once`.
 */

import {
  makeFunctionReference,
  paginationOptsValidator,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
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
import { rag, slugify } from "./knowledge";
import {
  debugNormalizeAiContradictionFindingsForTest,
  debugParseSessionEnrichmentForTest,
} from "./spark";
import { githubTimestamp } from "./ingestTimestamps";
import {
  insertPageVersion,
  type KnowledgePageState,
} from "./knowledgePageVersions";

const P5_JOB_STATUS_VALIDATOR = v.union(
  v.literal("pending"),
  v.literal("chunking"),
  v.literal("extracting"),
  v.literal("synthesizing"),
  v.literal("cross_referencing"),
  v.literal("completed"),
  v.literal("failed"),
);
const P5_SOURCE_STATUS_VALIDATOR = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("processed"),
);
const P5_PAGE_STATUS_VALIDATOR = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("archived"),
);
const P5_BRIDGE_STATUS_VALIDATOR = v.union(
  v.literal("pending"),
  v.literal("completed"),
  v.literal("failed"),
);

type InventoryOrg = {
  _id: Id<"orgs">;
  name: string;
  clerkOrgId: string;
  createdAt: number;
};
type InventoryEventsByOrg = {
  orgId: string;
  count: number;
  firstTs: number;
  lastTs: number;
  firstIso: string;
  lastIso: string;
  sampleTypes: string[];
  orgExists: boolean;
};
type InventoryResult = {
  orgs: InventoryOrg[];
  eventsByOrg: InventoryEventsByOrg[];
  eventsOrphaned: number;
  eventsTotal: number;
};
type InventoryCleanupResult = {
  deletedEvents: number;
  deletedOrgs: number;
  passes: number;
};
type P5ExistingPageUpsertSeed = {
  orgId: Id<"orgs">;
  knowledgeBaseId: Id<"knowledgeBases">;
  pageId: Id<"knowledgePages">;
  oldSourceId: Id<"sources">;
  newSourceId: Id<"sources">;
  sameTitleSameEvidenceSourceId: Id<"sources">;
  typeConflictSourceId: Id<"sources">;
  jobId: Id<"ingestJobs">;
  sameTitleSameEvidenceJobId: Id<"ingestJobs">;
  typeConflictJobId: Id<"ingestJobs">;
  caseSlug: string;
  expected: {
    slug: string;
    title: string;
    compiledTruth: string;
    tags: string[];
    confidence: "high" | "medium" | "low";
    entity: string;
    evidence: string;
  };
};
type P5ExistingPageUpsertState = {
  livePage: {
    type: Doc<"knowledgePages">["type"];
    title: string;
    compiledTruth: string;
    tags: string[];
    confidence: "high" | "medium" | "low";
    entity: string | null;
    sourceCount: number;
    evidenceTimeline: Array<{
      source: string;
      channel: string;
      content: string;
    }>;
  };
  latestVersion: {
    title: string;
    content: string;
    version: number;
  } | null;
  evidenceCount: number;
  versionCount: number;
  attributionCount: number;
  distinctAttributionSourceCount: number;
  sourceAttributionSourceIds: Array<Id<"sources">>;
  sourceAttributionCount: number;
  sourceCount: number;
};
type RunQueryContext = Pick<ActionCtx, "runQuery">;
type SessionMetadataInsertResult = {
  skipped: boolean;
  knowledgePageId: Id<"knowledgePages">;
};
type SessionMetadataInspectResult = {
  _id: Id<"knowledgePages">;
  workType?: string;
  complexity?: "low" | "moderate" | "high";
  skills?: string[];
  tags: string[];
  eventProcessed: boolean | null;
};
type BaselineLiveSearchResult = {
  _id: Id<"knowledgePages">;
  title: string;
  slug: string | null;
  type: Doc<"knowledgePages">["type"];
  snippet: string;
  score: number;
};
type BaselineDeepSearchResult = {
  pageId: Id<"knowledgePages">;
  title: string;
  slug: string | null;
  type: Doc<"knowledgePages">["type"];
  compiledTruth: string;
  relevanceScore: number;
  sourceChunkIds: Id<"sourceChunks">[];
  highlights: string[];
};
type BaselineDeepSearchRawResult = Omit<BaselineDeepSearchResult, "slug">;
type BaselineDeepSearchResponse = {
  results: BaselineDeepSearchRawResult[];
  meta: {
    bm25Count: number;
    vectorCount: number;
    fusedCount: number;
    rerankedCount: number;
    cohereSearchUnits: number;
  };
};
type BaselineSeedFixtureResult = {
  orgId: Id<"orgs">;
  knowledgeBaseId: Id<"knowledgeBases">;
  ragSeeds: BaselineRagSeed[];
  corpus: {
    pageCount: number;
    sourceCount: number;
    chunkCount: number;
    attributionCount: number;
    referenceCount: number;
    sessionPageCount: number;
  };
};
type BaselineSearchResult = {
  id: string;
  category: string;
  query: string;
  liveSearch: {
    results: BaselineLiveSearchResult[];
    error: string | null;
  };
  deepSearch: {
    results: BaselineDeepSearchResult[];
    meta: BaselineDeepSearchResponse["meta"] | null;
    error: string | null;
  };
};
type BaselineSearchFailure = {
  id: string;
  category: string;
  query: string;
  surface: "liveSearch" | "deepSearch";
  error: string;
};

const INVENTORY_PAGE_SIZE = 1000;
const INVENTORY_PROBE_EVENT_COUNT = 10001;
const INVENTORY_PROBE_BATCH_SIZE = 100;
const INVENTORY_PROBE_WRITE_PAUSE_MS = 250;
const INVENTORY_PROBE_CLERK_PREFIX = "debug:inventory-pagination";
const INVENTORY_PROBE_FIXTURE = "debug:probeInventoryPagination";
const INVENTORY_PROBE_SOURCE = "debug";
const INVENTORY_PROBE_ACTOR = "debug:probeInventoryPagination";
const p5RecoverStaleSessionBridgeJobRef = makeFunctionReference<
  "mutation",
  {
    jobId: Id<"ingestJobs">;
    staleBefore: number;
  },
  {
    scheduled: boolean;
    action: "processSource" | "extractKnowledgeFromSource" | null;
    reason: string;
  }
>("knowledge:recoverStaleSessionBridgeJob");
const p5SeedExtractionLeaseProbeRef = makeFunctionReference<
  "mutation",
  { caseName: string },
  {
    orgId: Id<"orgs">;
    knowledgeBaseId: Id<"knowledgeBases">;
    sourceId: Id<"sources">;
    jobId: Id<"ingestJobs">;
    caseSlug: string;
  }
>("debug:p5SeedExtractionLeaseProbe");
const p5InspectExtractionEvidenceArtifactsRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    sourceId: Id<"sources">;
    slugs: string[];
  },
  {
    pageCount: number;
    pageVersionCount: number;
    sourceAttributionCount: number;
    pages: Array<{
      pageId: Id<"knowledgePages">;
      slug: string;
      versionCount: number;
    }>;
  }
>("debug:p5InspectExtractionEvidenceArtifacts");
const p5SeedMentionDirectedEdgesProbeRef = makeFunctionReference<
  "mutation",
  { caseName: string },
  {
    orgId: Id<"orgs">;
    knowledgeBaseId: Id<"knowledgeBases">;
    sourceId: Id<"sources">;
    jobId: Id<"ingestJobs">;
    caseSlug: string;
    pages: Array<{
      pageId: Id<"knowledgePages">;
      slug: string;
      title: string;
      compiledTruth: string;
      entity?: string;
      tags: string[];
    }>;
    pageIds: {
      source: Id<"knowledgePages">;
      target: Id<"knowledgePages">;
      shortSlugNegative: Id<"knowledgePages">;
      api: Id<"knowledgePages">;
      shortSlugPositive: Id<"knowledgePages">;
    };
    slugs: {
      source: string;
      target: string;
      shortSlugNegative: string;
      api: string;
      shortSlugPositive: string;
    };
    probeNow: number;
  }
>("debug:p5SeedMentionDirectedEdgesProbe");
const p5GetIngestJobByIdRef = makeFunctionReference<
  "query",
  { jobId: Id<"ingestJobs"> },
  Doc<"ingestJobs"> | null
>("knowledge:getIngestJobById");
const p5ClaimKnowledgeExtractionLeaseRef = makeFunctionReference<
  "mutation",
  {
    jobId: Id<"ingestJobs">;
  },
  {
    leaseVersion: number;
  }
>("knowledge:claimKnowledgeExtractionLease");
const p5ApplyKnowledgeExtractionsRef = makeFunctionReference<
  "mutation",
  {
    sourceId: Id<"sources">;
    jobId: Id<"ingestJobs">;
    expectedLeaseVersion: number;
    extractions: Array<{
      type: "fact" | "decision" | "entity" | "pattern";
      title: string;
      slug: string;
      compiledTruth: string;
      confidence: "high" | "medium" | "low";
      tags: string[];
      entity?: string;
      supportingEvidence: Array<{ chunkIndex: number; excerpt: string }>;
    }>;
  },
  {
    pagesCreated: number;
    pagesUpdated: number;
    attributionsCreated: number;
    pageCountDelta: number;
    pages: Array<{
      pageId: Id<"knowledgePages">;
      slug: string;
      title: string;
      compiledTruth: string;
      entity?: string;
      tags: string[];
    }>;
  }
>("knowledge:applyKnowledgeExtractions");
const p5CreateMentionReferencesRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    jobId: Id<"ingestJobs">;
    pages: Array<{
      pageId: Id<"knowledgePages">;
      slug: string;
      title: string;
      compiledTruth: string;
      entity?: string;
      tags: string[];
    }>;
  },
  {
    referencesCreated: number;
  }
>("knowledge:createMentionReferences");
const p5ListLinterCandidatesRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    staleBefore: number;
    orphanGraceBefore: number;
    weakProvenanceGraceBefore: number;
    limit?: number;
  },
  {
    pages: Array<{
      _id: Id<"knowledgePages">;
      slug: string;
      inboundReferenceCount: number;
      attributionCount: number;
    }>;
  }
>("knowledge:listLinterCandidates");
const p5SeedExistingPageUpsertRef = makeFunctionReference<
  "mutation",
  { caseName: string },
  P5ExistingPageUpsertSeed
>("debug:p5SeedExistingPageUpsert");
const p5GetExistingPageUpsertStateRef = makeFunctionReference<
  "query",
  {
    pageId: Id<"knowledgePages">;
    sourceId: Id<"sources">;
  },
  P5ExistingPageUpsertState
>("debug:p5GetExistingPageUpsertState");
const probeSessionRelationshipIdSeedRef = makeFunctionReference<
  "mutation",
  { caseName: string },
  {
    orgId: Id<"orgs">;
    knowledgeBaseId: Id<"knowledgeBases">;
    sessionId: Id<"sessions">;
    sessionPageId: Id<"knowledgePages">;
    knowledgePageId: Id<"knowledgePages">;
  }
>("debug:probeSessionRelationshipIdSeed");
const probeSessionRelationshipIdPatchRef = makeFunctionReference<
  "mutation",
  {
    pageId: Id<"knowledgePages">;
    knowledgePageIds?: unknown[];
    associatedSessionIds?: unknown[];
  },
  {
    pageId: Id<"knowledgePages">;
    knowledgePageIds?: unknown[];
    associatedSessionIds?: unknown[];
  }
>("debug:probeSessionRelationshipIdPatch");
const probeSessionRelationshipIdCleanupRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    knowledgeBaseId: Id<"knowledgeBases">;
    sessionId: Id<"sessions">;
    pageIds: Id<"knowledgePages">[];
  },
  {
    deletedPages: number;
    deletedSession: boolean;
    deletedKnowledgeBase: boolean;
    deletedOrg: boolean;
    remainingPages: number;
    remainingSessions: number;
  }
>("debug:probeSessionRelationshipIdCleanup");
const p7SeedLinterSynthFixtureRef = makeFunctionReference<
  "mutation",
  { fixture: string },
  {
    orgId: Id<"orgs">;
    canonicalWindow: {
      period: "daily";
      timestamp: number;
      windowEnd: number;
    };
    repairSlugs: {
      staleDecisionSlug: string;
      orphanPageSlug: string;
      weakProvenanceSlug: string;
    };
    ids: {
      pageIdsBySlug: Record<string, Id<"knowledgePages"> | null>;
    };
  }
>("debug:p7SeedLinterSynthFixture");
const p7SeedStaleSynthesisRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    period: "daily" | "weekly" | "monthly";
    timestamp: number;
    status?: "in_progress" | "failed";
    failureKind?: "fatal" | "transient_exhausted" | "unexpected";
    retryCount?: number;
    nextRetryAt?: number;
    terminalFailure?: boolean;
    updatedAt?: number;
  },
  {
    synthesisId: Id<"syntheses">;
    period: "daily" | "weekly" | "monthly";
    timestamp: number;
    claimedAt: number;
  }
>("debug:p7SeedStaleSynthesis");
const p7EnsureNoActivityOrgRef = makeFunctionReference<
  "mutation",
  {},
  {
    orgId: Id<"orgs">;
    clerkOrgId: string;
  }
>("debug:p7EnsureNoActivityOrg");
const p7ClearSynthesesForOrgRef = makeFunctionReference<
  "mutation",
  { orgId: Id<"orgs"> },
  { deleted: number }
>("debug:p7ClearSynthesesForOrg");
const p7CleanupSynthesisPaginationFixtureBatchRef = makeFunctionReference<
  "mutation",
  { fixture: string; batchSize: number },
  { deletedSyntheses: number; deletedOrgs: number; remaining: number }
>("debug:p7CleanupSynthesisPaginationFixtureBatch");
const p7SeedSynthesisPaginationOrgsBatchRef = makeFunctionReference<
  "mutation",
  { fixture: string; prefix: string; startOrdinal: number; count: number },
  {
    inserted: number;
    reused: number;
    firstClerkOrgId: string | null;
    lastClerkOrgId: string | null;
    targetOrgId: Id<"orgs"> | null;
  }
>("debug:p7SeedSynthesisPaginationOrgsBatch");
const p7GetOrgByClerkOrgIdRef = makeFunctionReference<
  "query",
  { clerkOrgId: string },
  { orgId: Id<"orgs">; clerkOrgId: string } | null
>("debug:p7GetOrgByClerkOrgId");
const p7GetSynthesisForOrgWindowRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    period: "daily" | "weekly" | "monthly";
    timestamp: number;
  },
  Doc<"syntheses"> | null
>("debug:p7GetSynthesisForOrgWindow");
const p7ClaimSynthesisRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    period: "daily" | "weekly" | "monthly";
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
const p7GetSynthesisByIdRef = makeFunctionReference<
  "query",
  {
    synthesisId: Id<"syntheses">;
  },
  Doc<"syntheses"> | null
>("knowledge:getSynthesisRunById");
const p7RunSynthesisActionRef = makeFunctionReference<
  "action",
  {
    synthesisId: Id<"syntheses">;
  },
  {
    status:
      | "completed"
      | "completed_no_activity"
      | "failed"
      | "skipped_missing"
      | "skipped_terminal"
      | "skipped_not_in_progress"
      | "skipped_stale_claim";
    synthesisId: Id<"syntheses">;
    durationMs: number;
  }
>("spark:runSynthesisAction");
const p7GetSynthesisDependencyReadinessRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    period: "daily" | "weekly" | "monthly";
    timestamp: number;
    windowEnd: number;
  },
  P7SynthesisDependencyReadiness
>("knowledge:getSynthesisDependencyReadiness");
const p7GetSynthesisInputsRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    period: "daily" | "weekly" | "monthly";
    timestamp: number;
    windowEnd: number;
    limit?: number;
  },
  {
    lowerSyntheses: Array<{
      _id: Id<"syntheses">;
      period: "daily" | "weekly" | "monthly";
      timestamp: number;
      windowEnd: number;
    }>;
  }
>("knowledge:getSynthesisInputs");
const p7DebugDailySynthesisForOrgRef = makeFunctionReference<
  "action",
  {
    orgId: Id<"orgs">;
    now?: number;
  },
  {
    period: "daily";
    timestamp: number;
    windowEnd: number;
    orgCount: number;
    eligible: number;
    scheduled: number;
    skippedNoRelevantKnowledge: number;
    skippedCompleted: number;
    skippedFreshInProgress: number;
    reclaimed: number;
  }
>("spark:debugDailySynthesisForOrg");
const p7DebugWeeklySynthesisForOrgRef = makeFunctionReference<
  "action",
  {
    orgId: Id<"orgs">;
    now?: number;
  },
  {
    period: "weekly";
    timestamp: number;
    windowEnd: number;
    orgCount: number;
    eligible: number;
    scheduled: number;
    skippedNoRelevantKnowledge: number;
    skippedCompleted: number;
    skippedFreshInProgress: number;
    reclaimed: number;
    deferredDependencies: number;
    blockedDependencies: number;
  }
>("spark:debugWeeklySynthesisForOrg");
const p7FinalizeSynthesisRef = makeFunctionReference<
  "mutation",
  {
    synthesisId: Id<"syntheses">;
    summary: string;
    actors: string[];
    repos: string[];
    sourcePageIds: Id<"knowledgePages">[];
    sourceSynthesisIds: Id<"syntheses">[];
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
const p7FailSynthesisRef = makeFunctionReference<
  "mutation",
  {
    synthesisId: Id<"syntheses">;
    error: string;
    failureKind?: "fatal" | "transient_exhausted" | "unexpected";
    now?: number;
    expectedClaimedAt?: number;
  },
  {
    status: "failed" | "skipped_completed" | "skipped_stale_claim";
    synthesisId: Id<"syntheses">;
    error?: string;
    failureKind?: "fatal" | "transient_exhausted" | "unexpected";
    retryCount?: number;
    nextRetryAt?: number;
    terminalFailure?: boolean;
    expectedClaimedAt?: number;
    currentClaimedAt?: number | null;
    currentStatus?: Doc<"syntheses">["status"];
  }
>("knowledge:markSynthesisFailed");
const p7SynthesisStaleSweepRef = makeFunctionReference<
  "action",
  {},
  {
    staleBefore: number;
    found: number;
    reclaimed: number;
    scheduled: number;
    skipped: number;
    staleFound: number;
    staleReclaimed: number;
    staleScheduled: number;
    staleSkipped: number;
    failedFound: number;
    failedReclaimed: number;
    failedScheduled: number;
    failedSkipped: number;
  }
>("spark:synthesisStaleSweep");
const p7RunLinterForOrgRef = makeFunctionReference<
  "action",
  {
    orgId: Id<"orgs">;
    now?: number;
  },
  {
    orgId: Id<"orgs">;
    staleDecision: number;
    orphanPage: number;
    weakProvenance: number;
    activeSlugs: string[];
    resolvedCount: number;
    resolvedSlugs: string[];
    contradictionStatus:
      | "succeeded"
      | "failed"
      | "skipped_no_candidates";
    contradiction: number;
    contradictionCandidatePairs: number;
    contradictionActiveSlugs: string[];
    contradictionResolvedCount: number;
    contradictionResolvedSlugs: string[];
    contradictionWarnings: string[];
    contradictionError?: string;
    durationMs: number;
  }
>("spark:runLinterForOrg");
const p7RepairFixturePageRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    slug: string;
    repair: "add_attribution" | "add_inbound_reference" | "confirm_decision";
  },
  {
    pageId: Id<"knowledgePages">;
    slug: string;
    repair: "add_attribution" | "add_inbound_reference" | "confirm_decision";
    action: string;
    sourceId?: Id<"sources">;
    chunkId?: Id<"sourceChunks">;
    fromPageId?: Id<"knowledgePages">;
    confirmedAt?: number;
    sourceCount?: number;
  }
>("debug:p7RepairFixturePage");
const p7SeedAiContradictionFixtureRef = makeFunctionReference<
  "mutation",
  { fixture: string },
  {
    orgId: Id<"orgs">;
    knowledgeBaseId: Id<"knowledgeBases">;
    probeNow: number;
    expectedFindingSlug: string;
    unmanagedFindingSlug: string;
    contradictionSlugs: {
      left: string;
      right: string;
      hardNegative: string;
    };
    ids: {
      pageIdsBySlug: Record<string, Id<"knowledgePages"> | null>;
    };
  }
>("debug:p7SeedAiContradictionFixture");
const p7RepairAiContradictionFixtureRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    fixture: string;
  },
  {
    repairedSlug: string;
    action: "aligned";
  }
>("debug:p7RepairAiContradictionFixture");
const p7SetOrgAnthropicApiKeyRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    apiKey: string | null;
  },
  {
    orgId: Id<"orgs">;
    hasApiKey: boolean;
  }
>("debug:p7SetOrgAnthropicApiKey");
const p7SetFindingStatusRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    slug: string;
    findingStatus:
      | "new"
      | "acknowledged"
      | "investigating"
      | "resolved"
      | "dismissed";
  },
  {
    slug: string;
    findingStatus:
      | "new"
      | "acknowledged"
      | "investigating"
      | "resolved"
      | "dismissed";
  }
>("debug:p7SetFindingStatus");
const getKnowledgePagesByTypeRef = makeFunctionReference<
  "query",
  {
    orgId: Id<"orgs">;
    type:
      | "fact"
      | "pattern"
      | "decision"
      | "entity"
      | "project"
      | "question"
      | "finding"
      | "goal"
      | "session";
  },
  Doc<"knowledgePages">[]
>("debug:getKnowledgePagesByType");
const listReferencesByTargetRef = makeFunctionReference<
  "query",
  { toPageId: Id<"knowledgePages"> },
  Array<{
    _id: Id<"references">;
    fromPageId: Id<"knowledgePages">;
    toPageId: Id<"knowledgePages">;
    referenceType: Doc<"references">["referenceType"];
    createdAt: number;
  }>
>("debug:listReferencesByTarget");
const probeSessionExtractorMetadataSeedRef = makeFunctionReference<
  "mutation",
  { caseName: string },
  {
    orgId: Id<"orgs">;
    knowledgeBaseId: Id<"knowledgeBases">;
    eventId: Id<"events">;
    actor: string;
    startTime: number;
    endTime: number;
  }
>("debug:probeSessionExtractorMetadataSeed");
const probeSessionExtractorMetadataClearRef = makeFunctionReference<
  "mutation",
  { pageId: Id<"knowledgePages"> },
  { pageId: Id<"knowledgePages"> }
>("debug:probeSessionExtractorMetadataClear");
const probeSessionExtractorMetadataInspectRef = makeFunctionReference<
  "query",
  { pageId: Id<"knowledgePages"> },
  {
    _id: Id<"knowledgePages">;
    workType?: string;
    complexity?: "low" | "moderate" | "high";
    skills?: string[];
    tags: string[];
    eventProcessed: boolean | null;
  }
>("debug:probeSessionExtractorMetadataInspect");
const inventoryRef = makeFunctionReference<"action", {}, InventoryResult>("debug:inventory");
const inventoryOrgsPageRef = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  PaginationResult<Doc<"orgs">>
>("debug:inventoryOrgsPage");
const inventoryEventsPageRef = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  PaginationResult<Doc<"events">>
>("debug:inventoryEventsPage");
const inventoryProbeEnsureOrgRef = makeFunctionReference<
  "mutation",
  { caseName: string },
  { orgId: Id<"orgs"> }
>("debug:inventoryProbeEnsureOrg");
const inventoryProbeSeedEventsBatchRef = makeFunctionReference<
  "mutation",
  {
    orgId: Id<"orgs">;
    caseName: string;
    startIndex: number;
    count: number;
    baseTimestamp: number;
  },
  { inserted: number }
>("debug:inventoryProbeSeedEventsBatch");
const inventoryProbeSeedOrphanEventRef = makeFunctionReference<
  "mutation",
  {
    caseName: string;
    index: number;
    timestamp: number;
  },
  { orphanOrgId: Id<"orgs">; orphanEventId: Id<"events"> }
>("debug:inventoryProbeSeedOrphanEvent");
const inventoryProbeDeleteEventsRef = makeFunctionReference<
  "mutation",
  { caseName: string; eventIds: Id<"events">[] },
  { deleted: number }
>("debug:inventoryProbeDeleteEvents");
const inventoryProbeDeleteOrgsRef = makeFunctionReference<
  "mutation",
  { caseName: string },
  { deleted: number }
>("debug:inventoryProbeDeleteOrgs");

/**
 * Read-only inventory: how many orgs exist, and how many events each has.
 * Run: npx convex run debug:inventory
 *
 * Returns the shape:
 *   {
 *     orgs: [{ _id, name, clerkOrgId, createdAt }, ...],
 *     eventsByOrg: [{ orgId, count, firstTs, lastTs, sampleTypes }, ...],
 *     eventsOrphaned: number,  // events whose orgId doesn't match any org row
 *     eventsTotal: number,
 *   }
 */
export const inventoryOrgsPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<unknown> => {
    return await ctx.db.query("orgs").paginate(args.paginationOpts);
  },
});

export const inventoryEventsPage = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<unknown> => {
    return await ctx.db.query("events").paginate(args.paginationOpts);
  },
});

async function collectInventory(ctx: ActionCtx): Promise<InventoryResult> {
  const orgs: Doc<"orgs">[] = [];
  let orgCursor: string | null = null;
  do {
    const page = (await ctx.runQuery(inventoryOrgsPageRef, {
      paginationOpts: { numItems: INVENTORY_PAGE_SIZE, cursor: orgCursor },
    })) as PaginationResult<Doc<"orgs">>;
    orgs.push(...page.page);
    orgCursor = page.isDone ? null : page.continueCursor;
  } while (orgCursor !== null);

  const orgIds = new Set(orgs.map((o) => o._id as string));
  const byOrg = new Map<
    string,
    {
      orgId: string;
      count: number;
      firstTs: number;
      lastTs: number;
      sampleTypes: Set<string>;
    }
  >();

  let orphaned = 0;
  let eventsTotal = 0;
  let eventCursor: string | null = null;
  do {
    const page = (await ctx.runQuery(inventoryEventsPageRef, {
      paginationOpts: { numItems: INVENTORY_PAGE_SIZE, cursor: eventCursor },
    })) as PaginationResult<Doc<"events">>;
    eventsTotal += page.page.length;

    for (const e of page.page) {
      const id = e.orgId as unknown as string;
      if (!orgIds.has(id)) orphaned++;

      const slot = byOrg.get(id);
      if (!slot) {
        byOrg.set(id, {
          orgId: id,
          count: 1,
          firstTs: e.timestamp,
          lastTs: e.timestamp,
          sampleTypes: new Set([e.type]),
        });
      } else {
        slot.count++;
        if (e.timestamp < slot.firstTs) slot.firstTs = e.timestamp;
        if (e.timestamp > slot.lastTs) slot.lastTs = e.timestamp;
        if (slot.sampleTypes.size < 5) slot.sampleTypes.add(e.type);
      }
    }

    eventCursor = page.isDone ? null : page.continueCursor;
  } while (eventCursor !== null);

  return {
    orgs: orgs.map((o) => ({
      _id: o._id,
      name: o.name,
      clerkOrgId: o.clerkOrgId,
      createdAt: o._creationTime,
    })),
    eventsByOrg: [...byOrg.values()].map((s) => ({
      orgId: s.orgId,
      count: s.count,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      firstIso: new Date(s.firstTs).toISOString(),
      lastIso: new Date(s.lastTs).toISOString(),
      sampleTypes: [...s.sampleTypes],
      orgExists: orgIds.has(s.orgId),
    })),
    eventsOrphaned: orphaned,
    eventsTotal,
  };
}

export const inventory = internalAction({
  args: {},
  handler: async (ctx) => {
    return await collectInventory(ctx);
  },
});

function inventoryProbeClerkOrgId(caseName: string, role: "valid" | "orphan") {
  return `${INVENTORY_PROBE_CLERK_PREFIX}:${caseName}:${role}`;
}

function getInventoryProbeRecord(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return raw as { fixture?: unknown; caseName?: unknown; role?: unknown };
}

function isInventoryProbeRole(role: unknown): role is "valid" | "orphan" {
  return role === "valid" || role === "orphan";
}

function isInventoryPaginationFixtureEvent(
  event: Doc<"events"> | null,
  caseName: string,
) {
  if (!event) {
    return false;
  }
  const raw = getInventoryProbeRecord(event.raw);
  if (
    raw?.fixture !== INVENTORY_PROBE_FIXTURE ||
    raw.caseName !== caseName ||
    !isInventoryProbeRole(raw.role)
  ) {
    return false;
  }
  return (
    event.source === INVENTORY_PROBE_SOURCE &&
    event.via === "api" &&
    event.actor === INVENTORY_PROBE_ACTOR &&
    event.type === `inventory.pagination.${raw.role}`
  );
}

function pauseInventoryProbeWrites() {
  return new Promise((resolve) => setTimeout(resolve, INVENTORY_PROBE_WRITE_PAUSE_MS));
}

async function cleanupInventoryProbeCase(
  ctx: ActionCtx,
  caseName: string,
): Promise<InventoryCleanupResult> {
  let deletedEvents = 0;
  let passes = 0;

  for (let pass = 0; pass < 20; pass++) {
    passes += 1;
    let passDeleted = 0;
    let cursor: string | null = null;

    do {
      const page = (await ctx.runQuery(inventoryEventsPageRef, {
        paginationOpts: { numItems: INVENTORY_PAGE_SIZE, cursor },
      })) as PaginationResult<Doc<"events">>;
      const eventIds = page.page
        .filter((event) => isInventoryPaginationFixtureEvent(event, caseName))
        .map((event) => event._id);

      for (let i = 0; i < eventIds.length; i += INVENTORY_PROBE_BATCH_SIZE) {
        const deleted = await ctx.runMutation(inventoryProbeDeleteEventsRef, {
          caseName,
          eventIds: eventIds.slice(i, i + INVENTORY_PROBE_BATCH_SIZE),
        });
        passDeleted += deleted.deleted;
        if (deleted.deleted > 0) {
          await pauseInventoryProbeWrites();
        }
      }

      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);

    deletedEvents += passDeleted;
    if (passDeleted === 0) {
      break;
    }
  }

  const orgCleanup = await ctx.runMutation(inventoryProbeDeleteOrgsRef, { caseName });
  return { deletedEvents, deletedOrgs: orgCleanup.deleted, passes };
}

export const inventoryProbeEnsureOrg = internalMutation({
  args: { caseName: v.string() },
  handler: async (ctx, args) => {
    const clerkOrgId = inventoryProbeClerkOrgId(args.caseName, "valid");
    let org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
      .first();
    if (!org) {
      const orgId = await ctx.db.insert("orgs", {
        clerkOrgId,
        name: `Debug inventory pagination ${args.caseName}`,
      });
      org = await ctx.db.get(orgId);
    }
    if (!org) {
      throw new Error("Failed to create inventory pagination fixture org");
    }
    return { orgId: org._id };
  },
});

export const inventoryProbeSeedEventsBatch = internalMutation({
  args: {
    orgId: v.id("orgs"),
    caseName: v.string(),
    startIndex: v.number(),
    count: v.number(),
    baseTimestamp: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isInteger(args.count) ||
      args.count < 1 ||
      args.count > INVENTORY_PROBE_BATCH_SIZE
    ) {
      throw new Error(
        `count must be an integer between 1 and ${INVENTORY_PROBE_BATCH_SIZE}`,
      );
    }

    let inserted = 0;
    for (let offset = 0; offset < args.count; offset++) {
      const index = args.startIndex + offset;
      await ctx.db.insert("events", {
        orgId: args.orgId,
        source: INVENTORY_PROBE_SOURCE,
        via: "api",
        type: "inventory.pagination.valid",
        actor: INVENTORY_PROBE_ACTOR,
        summary: `Inventory pagination fixture event ${index}`,
        timestamp: args.baseTimestamp + index,
        raw: {
          fixture: INVENTORY_PROBE_FIXTURE,
          caseName: args.caseName,
          role: "valid",
          index,
        },
        processed: true,
      });
      inserted += 1;
    }
    return { inserted };
  },
});

export const inventoryProbeSeedOrphanEvent = internalMutation({
  args: {
    caseName: v.string(),
    index: v.number(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const orphanOrgId = await ctx.db.insert("orgs", {
      clerkOrgId: inventoryProbeClerkOrgId(args.caseName, "orphan"),
      name: `Debug inventory pagination orphan ${args.caseName}`,
    });
    const orphanEventId = await ctx.db.insert("events", {
      orgId: orphanOrgId,
      source: INVENTORY_PROBE_SOURCE,
      via: "api",
      type: "inventory.pagination.orphan",
      actor: INVENTORY_PROBE_ACTOR,
      summary: `Inventory pagination orphan fixture event ${args.index}`,
      timestamp: args.timestamp,
      raw: {
        fixture: INVENTORY_PROBE_FIXTURE,
        caseName: args.caseName,
        role: "orphan",
        index: args.index,
      },
      processed: true,
    });
    await ctx.db.delete(orphanOrgId);
    return { orphanOrgId, orphanEventId };
  },
});

export const inventoryProbeDeleteEvents = internalMutation({
  args: {
    caseName: v.string(),
    eventIds: v.array(v.id("events")),
  },
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const eventId of args.eventIds) {
      const event = await ctx.db.get(eventId);
      if (!isInventoryPaginationFixtureEvent(event, args.caseName)) {
        continue;
      }
      await ctx.db.delete(eventId);
      deleted += 1;
    }
    return { deleted };
  },
});

export const inventoryProbeDeleteOrgs = internalMutation({
  args: { caseName: v.string() },
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const role of ["valid", "orphan"] as const) {
      const orgs = await ctx.db
        .query("orgs")
        .withIndex("by_clerkOrgId", (q) =>
          q.eq("clerkOrgId", inventoryProbeClerkOrgId(args.caseName, role)),
        )
        .collect();
      for (const org of orgs) {
        await ctx.db.delete(org._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});

export const cleanupInventoryPagination = internalAction({
  args: { caseName: v.string() },
  handler: async (ctx, args) => {
    return await cleanupInventoryProbeCase(ctx, args.caseName);
  },
});

export const probeInventoryPagination = internalAction({
  args: {
    caseName: v.string(),
    eventCount: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.eventCount !== INVENTORY_PROBE_EVENT_COUNT) {
      throw new Error(
        `eventCount must be exactly ${INVENTORY_PROBE_EVENT_COUNT} for the inventory pagination proof`,
      );
    }

    await cleanupInventoryProbeCase(ctx, args.caseName);
    const before = await ctx.runAction(inventoryRef, {});
    const validCount = args.eventCount - 1;
    const baseTimestamp = Date.now();

    let result:
      | {
          validOrgId: Id<"orgs">;
          orphanOrgId: Id<"orgs">;
          orphanEventId: Id<"events">;
          seededEvents: number;
          eventDelta: number;
          orphanDelta: number;
          validOrgCount: number;
          orphanOrgCount: number;
        }
      | null = null;
    let cleanup: InventoryCleanupResult | null = null;

    try {
      const org = await ctx.runMutation(inventoryProbeEnsureOrgRef, {
        caseName: args.caseName,
      });

      let seededEvents = 0;
      for (let startIndex = 0; startIndex < validCount; startIndex += INVENTORY_PROBE_BATCH_SIZE) {
        const count = Math.min(INVENTORY_PROBE_BATCH_SIZE, validCount - startIndex);
        const batch = await ctx.runMutation(inventoryProbeSeedEventsBatchRef, {
          orgId: org.orgId,
          caseName: args.caseName,
          startIndex,
          count,
          baseTimestamp,
        });
        seededEvents += batch.inserted;
        await pauseInventoryProbeWrites();
      }

      const orphan = await ctx.runMutation(inventoryProbeSeedOrphanEventRef, {
        caseName: args.caseName,
        index: validCount,
        timestamp: baseTimestamp + validCount,
      });
      seededEvents += 1;

      const observed = await ctx.runAction(inventoryRef, {});
      const validOrgId = org.orgId as unknown as string;
      const orphanOrgId = orphan.orphanOrgId as unknown as string;
      const validRow = observed.eventsByOrg.find((row) => row.orgId === validOrgId);
      const orphanRow = observed.eventsByOrg.find((row) => row.orgId === orphanOrgId);
      const eventDelta = observed.eventsTotal - before.eventsTotal;
      const orphanDelta = observed.eventsOrphaned - before.eventsOrphaned;

      if (seededEvents !== args.eventCount) {
        throw new Error(`Seeded ${seededEvents} events; expected ${args.eventCount}`);
      }
      if (eventDelta < args.eventCount) {
        throw new Error(`Inventory event delta ${eventDelta}; expected at least ${args.eventCount}`);
      }
      if (orphanDelta < 1) {
        throw new Error(`Inventory orphan delta ${orphanDelta}; expected at least 1`);
      }
      if (!validRow || validRow.count !== validCount || !validRow.orgExists) {
        throw new Error(
          `Inventory valid fixture count ${
            validRow?.count ?? 0
          }; expected ${validCount} with an existing org`,
        );
      }
      if (!orphanRow || orphanRow.count !== 1 || orphanRow.orgExists) {
        throw new Error("Inventory did not count the orphan fixture event beyond the 10k boundary");
      }

      result = {
        validOrgId: org.orgId,
        orphanOrgId: orphan.orphanOrgId,
        orphanEventId: orphan.orphanEventId,
        seededEvents,
        eventDelta,
        orphanDelta,
        validOrgCount: validRow.count,
        orphanOrgCount: orphanRow.count,
      };
    } finally {
      cleanup = await cleanupInventoryProbeCase(ctx, args.caseName);
    }

    if (!result || !cleanup) {
      throw new Error("Inventory pagination probe did not complete");
    }

    const postCleanup = await ctx.runAction(inventoryRef, {});
    return {
      ok: true,
      caseName: args.caseName,
      requestedEvents: args.eventCount,
      seededEvents: result.seededEvents,
      baseline: {
        eventsTotal: before.eventsTotal,
        eventsOrphaned: before.eventsOrphaned,
      },
      observed: {
        eventDelta: result.eventDelta,
        orphanDelta: result.orphanDelta,
        validOrgId: result.validOrgId,
        validOrgCount: result.validOrgCount,
        orphanOrgId: result.orphanOrgId,
        orphanEventId: result.orphanEventId,
        orphanOrgCount: result.orphanOrgCount,
      },
      cleanup: {
        ...cleanup,
        completed: true,
      },
      postCleanup: {
        eventDelta: postCleanup.eventsTotal - before.eventsTotal,
        orphanDelta: postCleanup.eventsOrphaned - before.eventsOrphaned,
      },
    };
  },
});

export const debugSearchKeyword = internalQuery({
  args: {
    orgId: v.id("orgs"),
    q: v.string(),
  },
  handler: async (ctx, { orgId, q }) =>
    ctx.db
      .query("sourceChunks")
      .withSearchIndex("search_content", (s) =>
        s.search("searchableText", q).eq("orgId", orgId),
      )
      .take(5),
});

export const debugSearchVector = internalAction({
  args: {
    orgId: v.id("orgs"),
    q: v.string(),
  },
  // Org isolation is enforced by `namespace: orgId` (vector index partition);
  // `filters: []` is intentional: no sourceType filter for this dev helper.
  handler: async (ctx, { orgId, q }) =>
    rag.search(ctx, { namespace: orgId, query: q, limit: 5, filters: [] }),
});

/**
 * List sources + their latest ingest job for an org.
 * Useful for finding extraction targets and seeing which sources are
 * in which state of the ingestion pipeline.
 *
 * Run: npx convex run debug:listSources '{"orgId":"<id>"}'
 */
export const listSources = internalQuery({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, { orgId }) => {
    const allSources = await ctx.db.query("sources").collect();
    const allJobs = await ctx.db.query("ingestJobs").collect();
    const sources = allSources.filter((s) => s.orgId === orgId);
    const jobs = allJobs.filter((j) => j.orgId === orgId);
    const jobBySource = new Map<string, typeof jobs>();
    for (const j of jobs) {
      const k = j.sourceId as unknown as string;
      if (!jobBySource.has(k)) jobBySource.set(k, []);
      jobBySource.get(k)!.push(j);
    }
    return Promise.all(sources.map(async (s) => {
      const relatedJobs = (jobBySource.get(s._id as unknown as string) ?? [])
        .sort((a, b) => b._creationTime - a._creationTime);
      const latest = relatedJobs[0];
      const chunkCount = (
        await ctx.db
          .query("sourceChunks")
          .withIndex("by_source", (q) => q.eq("sourceId", s._id))
          .collect()
      ).length;
      return {
        sourceId: s._id,
        title: s.title,
        sourceType: s.sourceType,
        status: s.status,
        chunkCount,
        createdAt: s._creationTime,
        latestJobId: latest?._id ?? null,
        latestJobStatus: latest?.status ?? null,
        latestJobProgress: latest?.progress ?? null,
        jobCount: relatedJobs.length,
      };
    }));
  },
});

export const getKnowledgePagesByType = internalQuery({
  args: {
    orgId: v.id("orgs"),
    type: v.union(
      v.literal("fact"),
      v.literal("pattern"),
      v.literal("decision"),
      v.literal("entity"),
      v.literal("project"),
      v.literal("question"),
      v.literal("finding"),
      v.literal("goal"),
      v.literal("session"),
    ),
  },
  handler: async (ctx, args) => {
    return ctx.db
      .query("knowledgePages")
      .withIndex("by_org_type", (q) =>
        q.eq("orgId", args.orgId).eq("type", args.type),
      )
      .order("desc")
      .collect();
  },
});

export const listReferencesByTarget = internalQuery({
  args: { toPageId: v.id("knowledgePages") },
  handler: async (ctx, args) => {
    const refs = await ctx.db
      .query("references")
      .withIndex("by_to", (q) => q.eq("toPageId", args.toPageId))
      .collect();

    return refs.map((r) => ({
      _id: r._id,
      fromPageId: r.fromPageId,
      toPageId: r.toPageId,
      referenceType: r.referenceType,
      createdAt: r.createdAt,
    }));
  },
});

/**
 * Dev-only custom event ingest for extractor smoke tests.
 * Do not call from production paths.
 *
 * Run: npx convex run debug:ingestCustomEvents '{"orgId":"<id>","actor":"<actor>","events":[...]}'
 */
export const ingestCustomEvents = internalMutation({
  args: {
    orgId: v.id("orgs"),
    actor: v.string(),
    events: v.array(v.object({
      source: v.string(),
      type: v.string(),
      summary: v.string(),
      raw: v.any(),
      timestampOffsetMs: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const eventIds: Id<"events">[] = [];

    for (const event of args.events) {
      const eventId = await ctx.db.insert("events", {
        orgId: args.orgId,
        source: event.source,
        via: "api",
        type: event.type,
        actor: args.actor,
        summary: event.summary,
        timestamp: now + event.timestampOffsetMs,
        raw: event.raw,
        processed: false,
      });
      eventIds.push(eventId);
    }

    return { count: eventIds.length, eventIds };
  },
});

export const probeSessionExtractorMetadataSeed = internalMutation({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const caseSlug = slugify(`${args.caseName}-${now}`);
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: `session-metadata-${caseSlug}`,
      name: `Session Metadata ${args.caseName}`,
    });
    const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
      orgId,
      name: `Session Metadata KB ${args.caseName}`,
      pageCount: 0,
      sourceCount: 0,
      createdAt: now,
    });
    const actor = `Metadata Probe ${caseSlug}`;
    const startTime = now - 60_000;
    const endTime = now;
    const eventId = await ctx.db.insert("events", {
      orgId,
      source: "debug",
      via: "api",
      type: "session_metadata_probe",
      actor,
      summary: `Session metadata probe event for ${args.caseName}`,
      timestamp: startTime,
      raw: { caseName: args.caseName },
      processed: false,
    });

    return { orgId, knowledgeBaseId, eventId, actor, startTime, endTime };
  },
});

export const probeSessionExtractorMetadataClear = internalMutation({
  args: {
    pageId: v.id("knowledgePages"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.pageId, {
      workType: undefined,
      complexity: undefined,
      skills: undefined,
      updatedAt: Date.now(),
    });
    return { pageId: args.pageId };
  },
});

export const probeSessionExtractorMetadataInspect = internalQuery({
  args: {
    pageId: v.id("knowledgePages"),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (!page) {
      throw new Error(`Probe page ${args.pageId} not found`);
    }
    const eventId = page.eventIds?.[0];
    const event = eventId ? await ctx.db.get(eventId) : null;

    return {
      _id: page._id,
      workType: page.workType,
      complexity: page.complexity,
      skills: page.skills,
      tags: page.tags,
      eventProcessed: event ? event.processed === true : null,
    };
  },
});

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`SessionMetadataProbe: ${message}`);
  }
}

function assertRelationshipIdProbe(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`SessionRelationshipIdProbe: ${message}`);
  }
}

function assertP5ExistingPageUpsertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`P5ExistingPageUpsertProbe: ${message}`);
  }
}

function assertP5MentionDirectedEdgesProbe(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`P5MentionDirectedEdgesProbe: ${message}`);
  }
}

function assertP5ExtractionLeaseProbe(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(`P5ExtractionLeaseProbe: ${message}`);
  }
}

type RelationshipIdProbeAttempt = {
  name: string;
  ok: boolean;
  rejected: boolean;
  error: string | null;
};
type RelationshipIdProbeCleanup = {
  deletedPages: number;
  deletedSession: boolean;
  deletedKnowledgeBase: boolean;
  deletedOrg: boolean;
  remainingPages: number;
  remainingSessions: number;
};

async function captureRelationshipIdProbeAttempt(
  name: string,
  run: () => Promise<unknown>,
): Promise<RelationshipIdProbeAttempt> {
  try {
    await run();
    return { name, ok: true, rejected: false, error: null };
  } catch (error) {
    return {
      name,
      ok: false,
      rejected: true,
      error: getErrorMessage(error),
    };
  }
}

export const probeSessionRelationshipIdSeed = internalMutation({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const caseSlug = slugify(`${args.caseName}-${now}`);
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: `relationship-id-${caseSlug}`,
      name: `Relationship ID ${args.caseName}`,
    });
    const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
      orgId,
      name: `Relationship ID KB ${args.caseName}`,
      pageCount: 2,
      sourceCount: 0,
      createdAt: now,
    });
    const sessionId = await ctx.db.insert("sessions", {
      orgId,
      actor: "Relationship ID Probe",
      repo: "spark",
      title: `Relationship ID ${args.caseName}`,
      startTime: now - 60_000,
      endTime: now,
      eventCount: 0,
      status: "complete",
      eventIds: [],
    });
    const sessionPageId = await ctx.db.insert("knowledgePages", {
      orgId,
      knowledgeBaseId,
      type: "session",
      title: `Relationship ID Session ${args.caseName}`,
      slug: `relationship-id-session-${caseSlug}`,
      compiledTruth: `Relationship ID session page for ${args.caseName}.`,
      evidenceTimeline: [],
      tags: ["debug:relationship-id"],
      confidence: "high",
      lastConfirmed: now,
      sourceCount: 0,
      sessionId,
      actor: "Relationship ID Probe",
      repo: "spark",
      sessionStartTime: now - 60_000,
      sessionEndTime: now,
      eventCount: 0,
      eventIds: [],
      knowledgePageIds: [],
      associatedSessionIds: [],
      knowledgeBridgeStatus: "completed",
      status: "active",
      createdBy: "debug:probeSessionRelationshipIdSeed",
      createdAt: now,
      updatedAt: now,
    });
    const knowledgePageId = await ctx.db.insert("knowledgePages", {
      orgId,
      knowledgeBaseId,
      type: "fact",
      title: `Relationship ID Fact ${args.caseName}`,
      slug: `relationship-id-fact-${caseSlug}`,
      compiledTruth: `Relationship ID fact page for ${args.caseName}.`,
      evidenceTimeline: [],
      tags: ["debug:relationship-id"],
      confidence: "high",
      lastConfirmed: now,
      sourceCount: 0,
      status: "active",
      createdBy: "debug:probeSessionRelationshipIdSeed",
      createdAt: now,
      updatedAt: now,
    });

    return { orgId, knowledgeBaseId, sessionId, sessionPageId, knowledgePageId };
  },
});

export const probeSessionRelationshipIdPatch = internalMutation({
  args: {
    pageId: v.id("knowledgePages"),
    knowledgePageIds: v.optional(v.array(v.any())),
    associatedSessionIds: v.optional(v.array(v.any())),
  },
  handler: async (ctx, args) => {
    const patch: {
      knowledgePageIds?: unknown[];
      associatedSessionIds?: unknown[];
      updatedAt: number;
    } = { updatedAt: Date.now() };
    if (args.knowledgePageIds !== undefined) {
      patch.knowledgePageIds = args.knowledgePageIds;
    }
    if (args.associatedSessionIds !== undefined) {
      patch.associatedSessionIds = args.associatedSessionIds;
    }

    await ctx.db.patch(args.pageId, patch as {
      knowledgePageIds?: Id<"knowledgePages">[];
      associatedSessionIds?: Id<"sessions">[];
      updatedAt: number;
    });
    return {
      pageId: args.pageId,
      knowledgePageIds: args.knowledgePageIds,
      associatedSessionIds: args.associatedSessionIds,
    };
  },
});

export const probeSessionRelationshipIdCleanup = internalMutation({
  args: {
    orgId: v.id("orgs"),
    knowledgeBaseId: v.id("knowledgeBases"),
    sessionId: v.id("sessions"),
    pageIds: v.array(v.id("knowledgePages")),
  },
  handler: async (ctx, args) => {
    let deletedPages = 0;
    for (const pageId of args.pageIds) {
      const page = await ctx.db.get(pageId);
      if (page) {
        await ctx.db.delete(pageId);
        deletedPages += 1;
      }
    }

    const session = await ctx.db.get(args.sessionId);
    if (session) {
      await ctx.db.delete(args.sessionId);
    }
    const knowledgeBase = await ctx.db.get(args.knowledgeBaseId);
    if (knowledgeBase) {
      await ctx.db.delete(args.knowledgeBaseId);
    }
    const org = await ctx.db.get(args.orgId);
    if (org) {
      await ctx.db.delete(args.orgId);
    }

    const remainingPages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_kb", (q) => q.eq("knowledgeBaseId", args.knowledgeBaseId))
      .collect();
    const remainingSessions = await ctx.db
      .query("sessions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    return {
      deletedPages,
      deletedSession: Boolean(session),
      deletedKnowledgeBase: Boolean(knowledgeBase),
      deletedOrg: Boolean(org),
      remainingPages: remainingPages.length,
      remainingSessions: remainingSessions.length,
    };
  },
});

export const probeSessionRelationshipIdValidation = internalAction({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const seed = await ctx.runMutation(probeSessionRelationshipIdSeedRef, args);
    const attempts: RelationshipIdProbeAttempt[] = [];
    let cleanup: RelationshipIdProbeCleanup | null = null;

    try {
      attempts.push(await captureRelationshipIdProbeAttempt(
        "validKnowledgePageIds",
        () => ctx.runMutation(probeSessionRelationshipIdPatchRef, {
          pageId: seed.sessionPageId,
          knowledgePageIds: [seed.knowledgePageId],
        }),
      ));
      attempts.push(await captureRelationshipIdProbeAttempt(
        "validAssociatedSessionIds",
        () => ctx.runMutation(probeSessionRelationshipIdPatchRef, {
          pageId: seed.sessionPageId,
          associatedSessionIds: [seed.sessionId],
        }),
      ));
      attempts.push(await captureRelationshipIdProbeAttempt(
        "malformedKnowledgePageIds",
        () => ctx.runMutation(probeSessionRelationshipIdPatchRef, {
          pageId: seed.sessionPageId,
          knowledgePageIds: ["not-a-convex-id"],
        }),
      ));
      attempts.push(await captureRelationshipIdProbeAttempt(
        "wrongTableKnowledgePageIds",
        () => ctx.runMutation(probeSessionRelationshipIdPatchRef, {
          pageId: seed.sessionPageId,
          knowledgePageIds: [seed.sessionId],
        }),
      ));
      attempts.push(await captureRelationshipIdProbeAttempt(
        "malformedAssociatedSessionIds",
        () => ctx.runMutation(probeSessionRelationshipIdPatchRef, {
          pageId: seed.sessionPageId,
          associatedSessionIds: ["not-a-convex-id"],
        }),
      ));
      attempts.push(await captureRelationshipIdProbeAttempt(
        "wrongTableAssociatedSessionIds",
        () => ctx.runMutation(probeSessionRelationshipIdPatchRef, {
          pageId: seed.sessionPageId,
          associatedSessionIds: [seed.knowledgePageId],
        }),
      ));
    } finally {
      cleanup = await ctx.runMutation(probeSessionRelationshipIdCleanupRef, {
        orgId: seed.orgId,
        knowledgeBaseId: seed.knowledgeBaseId,
        sessionId: seed.sessionId,
        pageIds: [seed.sessionPageId, seed.knowledgePageId],
      });
    }

    const byName = new Map(attempts.map((attempt) => [attempt.name, attempt]));
    assertRelationshipIdProbe(
      byName.get("validKnowledgePageIds")?.ok === true,
      "valid knowledgePageIds were rejected",
    );
    assertRelationshipIdProbe(
      byName.get("validAssociatedSessionIds")?.ok === true,
      "valid associatedSessionIds were rejected",
    );
    assertRelationshipIdProbe(
      byName.get("malformedKnowledgePageIds")?.rejected === true,
      "malformed knowledgePageIds were accepted",
    );
    assertRelationshipIdProbe(
      byName.get("wrongTableKnowledgePageIds")?.rejected === true,
      "wrong-table knowledgePageIds were accepted",
    );
    assertRelationshipIdProbe(
      byName.get("malformedAssociatedSessionIds")?.rejected === true,
      "malformed associatedSessionIds were accepted",
    );
    assertRelationshipIdProbe(
      byName.get("wrongTableAssociatedSessionIds")?.rejected === true,
      "wrong-table associatedSessionIds were accepted",
    );
    assertRelationshipIdProbe(
      cleanup?.remainingPages === 0 && cleanup?.remainingSessions === 0,
      "fixture cleanup left session relationship rows behind",
    );

    return {
      ok: true,
      caseName: args.caseName,
      seed,
      attempts,
      cleanup,
    };
  },
});

function makeSessionMetadataProbeText(mode: "happy" | "malformed"): string {
  if (mode === "happy") {
    return [
      "# Metadata Happy Session",
      "",
      "Implemented the auth feature with React state changes.",
      "",
      "```json",
      JSON.stringify({
        title: "Metadata Happy Session",
        workType: "feature",
        complexity: "moderate",
        skills: ["Auth", "react", "auth"],
        tags: [
          "workType:feature",
          "complexity:moderate",
          "skill:auth",
          "skill:react",
        ],
        confidence: "high",
      }),
      "```",
    ].join("\n");
  }

  return [
    "# Metadata Malformed Session",
    "",
    "Processed a noisy debug event without enough detail.",
    "",
    "```json",
    JSON.stringify({
      title: "Metadata Malformed Session",
      workType: "spaceship",
      complexity: "extreme",
      skills: ["", "   ", 42],
      tags: ["workType:spaceship", "complexity:extreme", "skill:"],
      confidence: "medium",
    }),
    "```",
  ].join("\n");
}

/**
 * Deterministic session metadata probe. Does not call Anthropic.
 *
 * Run:
 *   npx convex run debug:probeSessionExtractorMetadata '{"caseName":"metadata-happy","mode":"happy"}'
 *   npx convex run debug:probeSessionExtractorMetadata '{"caseName":"metadata-malformed","mode":"malformed"}'
 */
export const probeSessionExtractorMetadata = internalAction({
  args: {
    caseName: v.string(),
    mode: v.union(v.literal("happy"), v.literal("malformed")),
  },
  handler: async (ctx, args) => {
    const parsed = debugParseSessionEnrichmentForTest({
      text: makeSessionMetadataProbeText(args.mode),
      actor: "Metadata Probe",
      startTime: Date.now(),
    });
    const seed = (await ctx.runMutation(probeSessionExtractorMetadataSeedRef, {
      caseName: args.caseName,
    })) as {
      orgId: Id<"orgs">;
      knowledgeBaseId: Id<"knowledgeBases">;
      eventId: Id<"events">;
      actor: string;
      startTime: number;
      endTime: number;
    };
    const insertResult = (await ctx.runMutation(
      internal.spark.insertSessionAndMarkEvents,
      {
        orgId: seed.orgId,
        knowledgeBaseId: seed.knowledgeBaseId,
        actor: seed.actor,
        repo: "spark",
        title: parsed.title,
        compiledTruth: parsed.compiledTruth,
        evidenceTimeline: [{
          source: seed.actor,
          channel: "debug",
          timestamp: seed.startTime,
          content: `Session metadata proof ${args.caseName}`,
        }],
        tags: parsed.tags,
        workType: parsed.workType,
        complexity: parsed.complexity,
        skills: parsed.skills,
        confidence: parsed.confidence,
        startTime: seed.startTime,
        endTime: seed.endTime,
        status: "complete",
        eventIds: [seed.eventId],
      },
    )) as SessionMetadataInsertResult;
    await ctx.runMutation(probeSessionExtractorMetadataClearRef, {
      pageId: insertResult.knowledgePageId,
    });
    const duplicateResult = (await ctx.runMutation(
      internal.spark.insertSessionAndMarkEvents,
      {
        orgId: seed.orgId,
        knowledgeBaseId: seed.knowledgeBaseId,
        actor: seed.actor,
        repo: "spark",
        title: parsed.title,
        compiledTruth: parsed.compiledTruth,
        evidenceTimeline: [{
          source: seed.actor,
          channel: "debug",
          timestamp: seed.startTime,
          content: `Session metadata duplicate proof ${args.caseName}`,
        }],
        tags: parsed.tags,
        workType: parsed.workType,
        complexity: parsed.complexity,
        skills: parsed.skills,
        confidence: parsed.confidence,
        startTime: seed.startTime,
        endTime: seed.endTime,
        status: "complete",
        eventIds: [seed.eventId],
      },
    )) as SessionMetadataInsertResult;
    const page = (await ctx.runQuery(probeSessionExtractorMetadataInspectRef, {
      pageId: duplicateResult.knowledgePageId,
    })) as SessionMetadataInspectResult;

    assertProbe(insertResult.skipped === false, "initial insert was skipped");
    assertProbe(duplicateResult.skipped === true, "duplicate insert was not skipped");
    assertProbe(
      insertResult.knowledgePageId === duplicateResult.knowledgePageId,
      "duplicate path created a second page",
    );
    assertProbe(page.eventProcessed === true, "event was not marked processed");

    if (args.mode === "happy") {
      assertProbe(page.workType === "feature", "workType was not persisted");
      assertProbe(page.complexity === "moderate", "complexity was not persisted");
      assertProbe(page.skills?.includes("auth") === true, "skill auth missing");
      assertProbe(
        page.tags.includes("workType:feature") &&
          page.tags.includes("complexity:moderate") &&
          page.tags.includes("skill:auth"),
        "search tags were not preserved",
      );
    } else {
      assertProbe(page.workType === "other", "unknown workType did not fall back");
      assertProbe(page.complexity === undefined, "invalid complexity was persisted");
      assertProbe(
        page.skills === undefined || page.skills.length === 0,
        "empty/invalid skills were persisted",
      );
      assertProbe(
        page.tags.includes("workType:other") &&
          page.tags.includes("complexity:extreme") &&
          page.tags.includes("skill:"),
        "malformed tags were not preserved enough for search inspection",
      );
    }

    return {
      ok: true,
      mode: args.mode,
      parsed,
      page,
      insertSkipped: insertResult.skipped,
      duplicateSkipped: duplicateResult.skipped,
    };
  },
});

/**
 * Dev-only Part 5 recovery fixture builder.
 * Not used by production paths; intended only for `npx convex run debug:p5*` probes.
 */
export const p5SeedExtractorEvents = internalMutation({
  args: {
    caseName: v.string(),
    eventCount: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const caseSlug = slugify(`${args.caseName}-${now}`);
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: `p5-extractor-${caseSlug}`,
      name: `P5 Extractor ${args.caseName}`,
    });
    const eventIds: Id<"events">[] = [];
    for (let index = 0; index < args.eventCount; index += 1) {
      eventIds.push(await ctx.db.insert("events", {
        orgId,
        source: "p5-probe",
        via: "api",
        type: "probe_event",
        actor: "P5 Extractor Probe",
        summary: `Implemented recovery step ${index + 1} for Spark session bridge`,
        timestamp: now + index * 1000,
        raw: { caseName: args.caseName, index },
        processed: false,
      }));
    }
    return { orgId, eventIds, eventCount: eventIds.length };
  },
});

export const p5SeedExtractionLeaseProbe = internalMutation({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const caseSlug = slugify(`${args.caseName}-${now}`);
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: `p5-lease-${caseSlug}`,
      name: `P5 Lease ${args.caseName}`,
    });
    const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
      orgId,
      name: `P5 Lease KB ${args.caseName}`,
      pageCount: 0,
      sourceCount: 1,
      createdAt: now,
    });
    const sourceId = await ctx.db.insert("sources", {
      orgId,
      knowledgeBaseId,
      title: `P5 Lease ${args.caseName}`,
      sourceType: "session",
      content: "P5 extraction lease probe content",
      contentHash: `p5-lease-${caseSlug}`,
      status: "processing",
      createdAt: now,
    });
    const jobId = await ctx.db.insert("ingestJobs", {
      orgId,
      sourceId,
      knowledgeBaseId,
      status: "synthesizing",
      currentStep: "P5 extraction lease probe",
      extractionLeaseVersion: 0,
      progress: {
        entitiesExtracted: 5,
        pagesCreated: 4,
        pagesUpdated: 3,
        referencesCreated: 2,
      },
      startedAt: now,
      createdAt: now,
    });
    await ctx.db.insert("sourceChunks", {
      sourceId,
      orgId,
      chunkIndex: 0,
      content:
        "P5 extraction lease probe evidence includes Lease source evidence and Lease target evidence.",
      contextPrefix: "P5 extraction lease probe context",
      searchableText: sourceChunkSearchableText(
        "P5 extraction lease probe evidence includes Lease source evidence and Lease target evidence.",
        "P5 extraction lease probe context",
      ),
      tokenCount: 12,
    });

    return { orgId, knowledgeBaseId, sourceId, jobId, caseSlug };
  },
});

export const p5InspectExtractionEvidenceArtifacts = internalQuery({
  args: {
    orgId: v.id("orgs"),
    sourceId: v.id("sources"),
    slugs: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const pages = [];
    let pageVersionCount = 0;
    for (const slug of args.slugs) {
      const page = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) =>
          q.eq("orgId", args.orgId).eq("slug", slug),
        )
        .first();
      if (!page) {
        continue;
      }
      const versions = await ctx.db
        .query("pageVersions")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      pageVersionCount += versions.length;
      pages.push({
        pageId: page._id,
        slug: page.slug,
        versionCount: versions.length,
      });
    }

    const sourceAttributions = await ctx.db
      .query("sourceAttributions")
      .withIndex("by_source", (q) => q.eq("sourceId", args.sourceId))
      .collect();

    return {
      pageCount: pages.length,
      pageVersionCount,
      sourceAttributionCount: sourceAttributions.length,
      pages,
    };
  },
});

export const p5ProbeExtractionLeaseAndProgress = internalAction({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const seed = await ctx.runMutation(p5SeedExtractionLeaseProbeRef, {
      caseName: args.caseName,
    });
    const extractions = [
      {
        type: "entity" as const,
        title: `P5 Lease Source ${seed.caseSlug}`,
        slug: `p5-lease-source-${seed.caseSlug}`,
        compiledTruth: `Mentions p5 lease target ${seed.caseSlug}.`,
        confidence: "high" as const,
        tags: ["p5-recovery", `target-${seed.caseSlug}`],
        entity: `P5 Lease Source ${seed.caseSlug}`,
        supportingEvidence: [{ chunkIndex: 0, excerpt: "Lease source evidence" }],
      },
      {
        type: "fact" as const,
        title: `P5 Lease Target ${seed.caseSlug}`,
        slug: `p5-lease-target-${seed.caseSlug}`,
        compiledTruth: `Mentions p5 lease source ${seed.caseSlug}.`,
        confidence: "high" as const,
        tags: ["p5-recovery", `source-${seed.caseSlug}`],
        supportingEvidence: [{ chunkIndex: 0, excerpt: "Lease target evidence" }],
      },
    ];

    const firstLease = await ctx.runMutation(p5ClaimKnowledgeExtractionLeaseRef, {
      jobId: seed.jobId,
    });
    const secondLease = await ctx.runMutation(p5ClaimKnowledgeExtractionLeaseRef, {
      jobId: seed.jobId,
    });

    let staleApplyError: string | null = null;
    try {
      await ctx.runMutation(p5ApplyKnowledgeExtractionsRef, {
        sourceId: seed.sourceId,
        jobId: seed.jobId,
        expectedLeaseVersion: firstLease.leaseVersion,
        extractions,
      });
    } catch (error) {
      staleApplyError = error instanceof Error ? error.message : String(error);
    }

    const firstApply = await ctx.runMutation(p5ApplyKnowledgeExtractionsRef, {
      sourceId: seed.sourceId,
      jobId: seed.jobId,
      expectedLeaseVersion: secondLease.leaseVersion,
      extractions,
    });
    const duplicateApply = await ctx.runMutation(p5ApplyKnowledgeExtractionsRef, {
      sourceId: seed.sourceId,
      jobId: seed.jobId,
      expectedLeaseVersion: secondLease.leaseVersion,
      extractions,
    });
    const refs = await ctx.runMutation(p5CreateMentionReferencesRef, {
      orgId: seed.orgId,
      jobId: seed.jobId,
      pages: firstApply.pages,
    });
    const duplicateRefs = await ctx.runMutation(p5CreateMentionReferencesRef, {
      orgId: seed.orgId,
      jobId: seed.jobId,
      pages: firstApply.pages,
    });
    const job = await ctx.runQuery(p5GetIngestJobByIdRef, {
      jobId: seed.jobId,
    });
    const staleApplyRejected =
      staleApplyError?.includes("StaleTransition") ?? false;
    const finalProgress = job?.progress ?? null;
    const finalLeaseVersion = job?.extractionLeaseVersion ?? null;

    assertP5ExtractionLeaseProbe(
      firstLease.leaseVersion === 1,
      `expected first lease version 1, got ${firstLease.leaseVersion}`,
    );
    assertP5ExtractionLeaseProbe(
      secondLease.leaseVersion === 2,
      `expected second lease version 2, got ${secondLease.leaseVersion}`,
    );
    assertP5ExtractionLeaseProbe(
      staleApplyRejected,
      `expected stale apply to reject with StaleTransition, got ${
        staleApplyError ?? "no error"
      }`,
    );
    assertP5ExtractionLeaseProbe(
      firstApply.pagesCreated === 2 &&
        firstApply.pagesUpdated === 0 &&
        firstApply.attributionsCreated === 2 &&
        firstApply.pageCountDelta === 2 &&
        firstApply.pages.length === 2,
      `expected first apply to create two pages/attributions, got ${JSON.stringify(firstApply)}`,
    );
    assertP5ExtractionLeaseProbe(
      duplicateApply.pagesCreated === 0 &&
        duplicateApply.pagesUpdated === 0 &&
        duplicateApply.attributionsCreated === 0 &&
        duplicateApply.pageCountDelta === 0 &&
        duplicateApply.pages.length === 2,
      `expected duplicate apply to be idempotent, got ${JSON.stringify(duplicateApply)}`,
    );
    assertP5ExtractionLeaseProbe(
      refs.referencesCreated === 2,
      `expected first reference pass to create two references, got ${refs.referencesCreated}`,
    );
    assertP5ExtractionLeaseProbe(
      duplicateRefs.referencesCreated === 0,
      `expected duplicate reference pass to create zero references, got ${duplicateRefs.referencesCreated}`,
    );
    assertP5ExtractionLeaseProbe(
      finalProgress !== null,
      "expected ingest job progress after probe writes",
    );
    assertP5ExtractionLeaseProbe(
      finalProgress.entitiesExtracted === 5 &&
        finalProgress.pagesCreated === 4 &&
        finalProgress.pagesUpdated === 3 &&
        finalProgress.referencesCreated === 4,
      `expected final progress to preserve monotonic counters, got ${JSON.stringify(finalProgress)}`,
    );
    assertP5ExtractionLeaseProbe(
      finalLeaseVersion === secondLease.leaseVersion,
      `expected final lease version ${secondLease.leaseVersion}, got ${finalLeaseVersion}`,
    );

    return {
      seed,
      firstLease,
      secondLease,
      staleApplyRejected,
      staleApplyError,
      firstApply,
      duplicateApply,
      refs,
      duplicateRefs,
      finalProgress,
      finalLeaseVersion,
    };
  },
});

export const p5ProbeExtractionEvidenceValidation = internalAction({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const seed = await ctx.runMutation(p5SeedExtractionLeaseProbeRef, {
      caseName: args.caseName,
    });
    const lease = await ctx.runMutation(p5ClaimKnowledgeExtractionLeaseRef, {
      jobId: seed.jobId,
    });
    const slug = `p5-evidence-validation-${seed.caseSlug}`;
    const baseExtraction = {
      type: "fact" as const,
      title: `P5 Evidence Validation ${seed.caseSlug}`,
      slug,
      compiledTruth: `Evidence validation proof for ${seed.caseSlug}.`,
      confidence: "high" as const,
      tags: ["p5-evidence-validation", seed.caseSlug],
    };

    let invalidError: string | null = null;
    try {
      await ctx.runMutation(p5ApplyKnowledgeExtractionsRef, {
        sourceId: seed.sourceId,
        jobId: seed.jobId,
        expectedLeaseVersion: lease.leaseVersion,
        extractions: [
          {
            ...baseExtraction,
            supportingEvidence: [
              { chunkIndex: 0, excerpt: "hallucinated absent evidence" },
            ],
          },
        ],
      });
    } catch (error) {
      invalidError = error instanceof Error ? error.message : String(error);
    }

    assertP5ExtractionLeaseProbe(
      invalidError?.includes("Supporting evidence excerpt") === true,
      `expected invalid excerpt rejection, got ${invalidError ?? "no error"}`,
    );

    const afterInvalid = await ctx.runQuery(
      p5InspectExtractionEvidenceArtifactsRef,
      {
        orgId: seed.orgId,
        sourceId: seed.sourceId,
        slugs: [slug],
      },
    );
    assertP5ExtractionLeaseProbe(
      afterInvalid.pageCount === 0 &&
        afterInvalid.pageVersionCount === 0 &&
        afterInvalid.sourceAttributionCount === 0,
      `expected invalid excerpt to leave no durable artifacts, got ${JSON.stringify(afterInvalid)}`,
    );

    const validApply = await ctx.runMutation(p5ApplyKnowledgeExtractionsRef, {
      sourceId: seed.sourceId,
      jobId: seed.jobId,
      expectedLeaseVersion: lease.leaseVersion,
      extractions: [
        {
          ...baseExtraction,
          supportingEvidence: [
            { chunkIndex: 0, excerpt: "Lease source evidence" },
          ],
        },
      ],
    });
    assertP5ExtractionLeaseProbe(
      validApply.pagesCreated === 1 &&
        validApply.attributionsCreated === 1 &&
        validApply.pageCountDelta === 1,
      `expected valid verbatim evidence to create one page and attribution, got ${JSON.stringify(validApply)}`,
    );

    const afterValid = await ctx.runQuery(
      p5InspectExtractionEvidenceArtifactsRef,
      {
        orgId: seed.orgId,
        sourceId: seed.sourceId,
        slugs: [slug],
      },
    );
    assertP5ExtractionLeaseProbe(
      afterValid.pageCount === 1 &&
        afterValid.pageVersionCount === 1 &&
        afterValid.sourceAttributionCount === 1,
      `expected valid verbatim evidence to persist one page/version/attribution set, got ${JSON.stringify(afterValid)}`,
    );

    return {
      ok: true,
      seed,
      invalidError,
      afterInvalid,
      validApply,
      afterValid,
    };
  },
});

export const p5SeedMentionDirectedEdgesProbe = internalMutation({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const caseSlug = slugify(`${args.caseName}-${now}`);
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: `p5-mention-directed-${caseSlug}`,
      name: `P5 Mention Directed ${args.caseName}`,
    });
    const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
      orgId,
      name: `P5 Mention Directed KB ${args.caseName}`,
      pageCount: 5,
      sourceCount: 1,
      createdAt: now,
    });
    const sourceId = await ctx.db.insert("sources", {
      orgId,
      knowledgeBaseId,
      title: `P5 Mention Directed ${args.caseName}`,
      sourceType: "paste",
      content: "P5 mention directed edges probe content",
      contentHash: `p5-mention-directed-${caseSlug}`,
      status: "processing",
      createdAt: now,
    });
    const jobId = await ctx.db.insert("ingestJobs", {
      orgId,
      sourceId,
      knowledgeBaseId,
      status: "cross_referencing",
      currentStep: "P5 mention directed edges probe",
      progress: {
        entitiesExtracted: 5,
        pagesCreated: 5,
        pagesUpdated: 0,
        referencesCreated: 0,
      },
      startedAt: now,
      createdAt: now,
    });

    const insertPage = async (page: {
      title: string;
      slug: string;
      compiledTruth: string;
      tags?: string[];
      entity?: string;
    }) => {
      const pageId = await ctx.db.insert("knowledgePages", {
        orgId,
        knowledgeBaseId,
        type: "fact",
        title: page.title,
        slug: page.slug,
        compiledTruth: page.compiledTruth,
        evidenceTimeline: [
          {
            source: "P5 mention directed probe",
            channel: "debug",
            timestamp: now,
            content: page.compiledTruth,
          },
        ],
        entity: page.entity,
        tags: page.tags ?? ["p5-mention-directed", caseSlug],
        confidence: "high",
        lastConfirmed: now,
        sourceCount: 1,
        status: "active",
        createdBy: "system",
        createdAt: now,
        updatedAt: now,
      });
      return {
        pageId,
        slug: page.slug,
        title: page.title,
        compiledTruth: page.compiledTruth,
        entity: page.entity,
        tags: page.tags ?? ["p5-mention-directed", caseSlug],
      };
    };

    const sourcePage = await insertPage({
      title: `P5 Mention Source ${caseSlug}`,
      slug: `p5-mention-source-${caseSlug}`,
      compiledTruth: `This page cites p5 mention target ${caseSlug} as the downstream dependency.`,
    });
    const targetPage = await insertPage({
      title: `P5 Mention Target ${caseSlug}`,
      slug: `p5-mention-target-${caseSlug}`,
      compiledTruth: "This target page records independent status and does not cite the source page.",
    });
    const shortSlugNegativePage = await insertPage({
      title: `P5 Capitalization Rules ${caseSlug}`,
      slug: `p5-capitalization-rules-${caseSlug}`,
      compiledTruth: "Capitalization rules are ongoing in build notes.",
    });
    const apiPage = await insertPage({
      title: `API ${caseSlug}`,
      slug: "api",
      compiledTruth: "Stable platform contract page.",
      entity: "API",
      tags: ["api"],
    });
    const shortSlugPositivePage = await insertPage({
      title: `P5 API Consumer ${caseSlug}`,
      slug: `p5-api-consumer-${caseSlug}`,
      compiledTruth: "The API contract is referenced as a standalone token.",
    });

    return {
      orgId,
      knowledgeBaseId,
      sourceId,
      jobId,
      caseSlug,
      pages: [
        sourcePage,
        targetPage,
        shortSlugNegativePage,
        apiPage,
        shortSlugPositivePage,
      ],
      pageIds: {
        source: sourcePage.pageId,
        target: targetPage.pageId,
        shortSlugNegative: shortSlugNegativePage.pageId,
        api: apiPage.pageId,
        shortSlugPositive: shortSlugPositivePage.pageId,
      },
      slugs: {
        source: sourcePage.slug,
        target: targetPage.slug,
        shortSlugNegative: shortSlugNegativePage.slug,
        api: apiPage.slug,
        shortSlugPositive: shortSlugPositivePage.slug,
      },
      probeNow: now,
    };
  },
});

export const p5ProbeMentionDirectedEdges = internalAction({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const seed = await ctx.runMutation(p5SeedMentionDirectedEdgesProbeRef, {
      caseName: args.caseName,
    });

    const firstRefs = await ctx.runMutation(p5CreateMentionReferencesRef, {
      orgId: seed.orgId,
      jobId: seed.jobId,
      pages: seed.pages,
    });
    const duplicateRefs = await ctx.runMutation(p5CreateMentionReferencesRef, {
      orgId: seed.orgId,
      jobId: seed.jobId,
      pages: seed.pages,
    });

    const [
      sourceInboundRefs,
      targetInboundRefs,
      negativeInboundRefs,
      apiInboundRefs,
      positiveInboundRefs,
      linterCandidates,
      job,
    ] = await Promise.all([
      ctx.runQuery(listReferencesByTargetRef, {
        toPageId: seed.pageIds.source,
      }),
      ctx.runQuery(listReferencesByTargetRef, {
        toPageId: seed.pageIds.target,
      }),
      ctx.runQuery(listReferencesByTargetRef, {
        toPageId: seed.pageIds.shortSlugNegative,
      }),
      ctx.runQuery(listReferencesByTargetRef, {
        toPageId: seed.pageIds.api,
      }),
      ctx.runQuery(listReferencesByTargetRef, {
        toPageId: seed.pageIds.shortSlugPositive,
      }),
      ctx.runQuery(p5ListLinterCandidatesRef, {
        orgId: seed.orgId,
        staleBefore: seed.probeNow + 1,
        orphanGraceBefore: seed.probeNow + 1,
        weakProvenanceGraceBefore: seed.probeNow + 1,
        limit: 20,
      }),
      ctx.runQuery(p5GetIngestJobByIdRef, {
        jobId: seed.jobId,
      }),
    ]);

    assertP5MentionDirectedEdgesProbe(
      firstRefs.referencesCreated === 2,
      `expected exactly two observed directed references, got ${firstRefs.referencesCreated}`,
    );
    assertP5MentionDirectedEdgesProbe(
      duplicateRefs.referencesCreated === 0,
      `duplicate reference creation inserted ${duplicateRefs.referencesCreated} rows`,
    );
    assertP5MentionDirectedEdgesProbe(
      sourceInboundRefs.length === 0,
      "source page received a fabricated inbound reference",
    );
    assertP5MentionDirectedEdgesProbe(
      targetInboundRefs.length === 1 &&
        targetInboundRefs[0]?.fromPageId === seed.pageIds.source,
      "target page did not receive exactly one inbound reference from source",
    );
    assertP5MentionDirectedEdgesProbe(
      negativeInboundRefs.length === 0,
      "capitalization short-slug negative page received an inbound reference",
    );
    assertP5MentionDirectedEdgesProbe(
      apiInboundRefs.length === 1 &&
        apiInboundRefs[0]?.fromPageId === seed.pageIds.shortSlugPositive,
      "standalone api token did not create exactly one inbound reference",
    );
    assertP5MentionDirectedEdgesProbe(
      positiveInboundRefs.length === 0,
      "standalone api source page received a fabricated reverse inbound reference",
    );

    const linterBySlug = new Map(
      linterCandidates.pages.map((page) => [page.slug, page]),
    );
    const sourceCandidate = linterBySlug.get(seed.slugs.source);
    const targetCandidate = linterBySlug.get(seed.slugs.target);
    assertP5MentionDirectedEdgesProbe(
      sourceCandidate?.inboundReferenceCount === 0,
      `linter counted fabricated inbound references for source: ${sourceCandidate?.inboundReferenceCount}`,
    );
    assertP5MentionDirectedEdgesProbe(
      targetCandidate?.inboundReferenceCount === 1,
      `linter did not count the observed inbound reference for target: ${targetCandidate?.inboundReferenceCount}`,
    );

    return {
      ok: true,
      seed: {
        orgId: seed.orgId,
        knowledgeBaseId: seed.knowledgeBaseId,
        sourceId: seed.sourceId,
        jobId: seed.jobId,
        caseSlug: seed.caseSlug,
        slugs: seed.slugs,
      },
      firstRefs,
      duplicateRefs,
      inboundCounts: {
        source: sourceInboundRefs.length,
        target: targetInboundRefs.length,
        shortSlugNegative: negativeInboundRefs.length,
        api: apiInboundRefs.length,
        shortSlugPositive: positiveInboundRefs.length,
      },
      linterInboundCounts: {
        source: sourceCandidate?.inboundReferenceCount ?? null,
        target: targetCandidate?.inboundReferenceCount ?? null,
      },
      finalProgress: job?.progress ?? null,
    };
  },
});

export const p5SeedExistingPageUpsert = internalMutation({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args): Promise<P5ExistingPageUpsertSeed> => {
    const now = Date.now();
    const caseSlug = slugify(`${args.caseName}-${now}`);
    const pageSlug = `p5-existing-upsert-${caseSlug}`;
    const oldSourceTitle = `P5 Existing Old ${args.caseName}`;
    const newSourceTitle = `P5 Existing New ${args.caseName}`;
    const typeConflictSourceTitle = `P5 Existing Type Conflict ${args.caseName}`;
    const oldEvidence = `Old compiled truth evidence for ${caseSlug}`;
    const newEvidence = `New compiled truth evidence for ${caseSlug}`;
    const typeConflictEvidence = `Type conflict evidence for ${caseSlug}`;
    const expected = {
      slug: pageSlug,
      title: `P5 Existing New Title ${caseSlug}`,
      compiledTruth: `New compiled truth for ${caseSlug}. This should replace the old current-state synthesis.`,
      tags: ["p5-existing-upsert", "new-current-state", caseSlug],
      confidence: "medium" as const,
      entity: `P5 Existing New Entity ${caseSlug}`,
      evidence: newEvidence,
    };

    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: `p5-existing-upsert-${caseSlug}`,
      name: `P5 Existing Upsert ${args.caseName}`,
    });
    const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
      orgId,
      name: `P5 Existing Upsert KB ${args.caseName}`,
      pageCount: 1,
      sourceCount: 4,
      createdAt: now,
    });
    const oldSourceId = await ctx.db.insert("sources", {
      orgId,
      knowledgeBaseId,
      title: oldSourceTitle,
      sourceType: "paste",
      content: oldEvidence,
      contentHash: `p5-existing-old-${caseSlug}`,
      status: "processed",
      createdAt: now - 2000,
    });
    const oldChunkId = await ctx.db.insert("sourceChunks", {
      sourceId: oldSourceId,
      orgId,
      chunkIndex: 0,
      content: oldEvidence,
      contextPrefix: "Old existing-page upsert context",
      searchableText: sourceChunkSearchableText(
        oldEvidence,
        "Old existing-page upsert context",
      ),
      tokenCount: 8,
    });
    const newSourceId = await ctx.db.insert("sources", {
      orgId,
      knowledgeBaseId,
      title: newSourceTitle,
      sourceType: "paste",
      content: newEvidence,
      contentHash: `p5-existing-new-${caseSlug}`,
      status: "processing",
      createdAt: now - 1000,
    });
    await ctx.db.insert("sourceChunks", {
      sourceId: newSourceId,
      orgId,
      chunkIndex: 0,
      content: newEvidence,
      contextPrefix: "New existing-page upsert context",
      searchableText: sourceChunkSearchableText(
        newEvidence,
        "New existing-page upsert context",
      ),
      tokenCount: 8,
    });
    const sameTitleSameEvidenceSourceId = await ctx.db.insert("sources", {
      orgId,
      knowledgeBaseId,
      title: newSourceTitle,
      sourceType: "paste",
      content: newEvidence,
      contentHash: `p5-existing-same-evidence-${caseSlug}`,
      status: "processing",
      createdAt: now - 500,
    });
    await ctx.db.insert("sourceChunks", {
      sourceId: sameTitleSameEvidenceSourceId,
      orgId,
      chunkIndex: 0,
      content: newEvidence,
      contextPrefix: "Same-title same-evidence existing-page upsert context",
      searchableText: sourceChunkSearchableText(
        newEvidence,
        "Same-title same-evidence existing-page upsert context",
      ),
      tokenCount: 8,
    });
    const typeConflictSourceId = await ctx.db.insert("sources", {
      orgId,
      knowledgeBaseId,
      title: typeConflictSourceTitle,
      sourceType: "paste",
      content: typeConflictEvidence,
      contentHash: `p5-existing-type-conflict-${caseSlug}`,
      status: "processing",
      createdAt: now - 250,
    });
    await ctx.db.insert("sourceChunks", {
      sourceId: typeConflictSourceId,
      orgId,
      chunkIndex: 0,
      content: typeConflictEvidence,
      contextPrefix: "Type-conflict existing-page upsert context",
      searchableText: sourceChunkSearchableText(
        typeConflictEvidence,
        "Type-conflict existing-page upsert context",
      ),
      tokenCount: 8,
    });
    const pageState = {
      orgId,
      knowledgeBaseId,
      type: "decision",
      title: `P5 Existing Old Title ${caseSlug}`,
      slug: pageSlug,
      compiledTruth: `Old compiled truth for ${caseSlug}.`,
      evidenceTimeline: [
        {
          source: oldSourceTitle,
          channel: "paste",
          timestamp: now - 2000,
          content: oldEvidence,
        },
      ],
      entity: `P5 Existing Old Entity ${caseSlug}`,
      tags: ["p5-existing-upsert", "old-current-state"],
      confidence: "low",
      sourceCount: 1,
      lastConfirmed: now - 2000,
      status: "active",
      createdBy: "debug:p5SeedExistingPageUpsert",
      createdAt: now - 2000,
      updatedAt: now - 2000,
    } satisfies KnowledgePageState;
    const pageId = await ctx.db.insert("knowledgePages", pageState);
    await insertPageVersion(ctx, {
      pageId,
      page: pageState,
      changeReason: `Initial debug seed from ${oldSourceTitle}`,
      changedBy: "debug:p5SeedExistingPageUpsert",
      sourceIds: [oldSourceId],
      version: 1,
      createdAt: now - 2000,
    });
    await ctx.db.insert("sourceAttributions", {
      pageId,
      sourceId: oldSourceId,
      chunkId: oldChunkId,
      orgId,
      excerpt: oldEvidence,
      createdAt: now - 2000,
    });
    const jobId = await ctx.db.insert("ingestJobs", {
      orgId,
      sourceId: newSourceId,
      knowledgeBaseId,
      status: "synthesizing",
      currentStep: "P5 existing-page upsert probe",
      extractionLeaseVersion: 0,
      progress: {
        entitiesExtracted: 0,
        pagesCreated: 0,
        pagesUpdated: 0,
        referencesCreated: 0,
      },
      startedAt: now - 1000,
      createdAt: now - 1000,
    });
    const sameTitleSameEvidenceJobId = await ctx.db.insert("ingestJobs", {
      orgId,
      sourceId: sameTitleSameEvidenceSourceId,
      knowledgeBaseId,
      status: "synthesizing",
      currentStep: "P5 existing-page same-title same-evidence probe",
      extractionLeaseVersion: 0,
      progress: {
        entitiesExtracted: 0,
        pagesCreated: 0,
        pagesUpdated: 0,
        referencesCreated: 0,
      },
      startedAt: now - 500,
      createdAt: now - 500,
    });
    const typeConflictJobId = await ctx.db.insert("ingestJobs", {
      orgId,
      sourceId: typeConflictSourceId,
      knowledgeBaseId,
      status: "synthesizing",
      currentStep: "P5 existing-page type-conflict probe",
      extractionLeaseVersion: 0,
      progress: {
        entitiesExtracted: 0,
        pagesCreated: 0,
        pagesUpdated: 0,
        referencesCreated: 0,
      },
      startedAt: now - 250,
      createdAt: now - 250,
    });

    return {
      orgId,
      knowledgeBaseId,
      pageId,
      oldSourceId,
      newSourceId,
      sameTitleSameEvidenceSourceId,
      typeConflictSourceId,
      jobId,
      sameTitleSameEvidenceJobId,
      typeConflictJobId,
      caseSlug,
      expected,
    };
  },
});

export const p5GetExistingPageUpsertState = internalQuery({
  args: {
    pageId: v.id("knowledgePages"),
    sourceId: v.id("sources"),
  },
  handler: async (ctx, args): Promise<P5ExistingPageUpsertState> => {
    const page = await ctx.db.get(args.pageId);
    if (!page) {
      throw new Error(`Knowledge page ${args.pageId} was not found`);
    }
    const versions = await ctx.db
      .query("pageVersions")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .collect();
    const attributions = await ctx.db
      .query("sourceAttributions")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .collect();
    const sortedVersions = [...versions].sort((left, right) => left.version - right.version);
    const latestVersion =
      sortedVersions.length > 0 ? sortedVersions[sortedVersions.length - 1] : null;
    const sourceAttributionSourceIds = Array.from(
      new Set(attributions.map((attribution) => attribution.sourceId)),
    );

    return {
      livePage: {
        type: page.type,
        title: page.title,
        compiledTruth: page.compiledTruth,
        tags: page.tags,
        confidence: page.confidence,
        entity: page.entity ?? null,
        sourceCount: page.sourceCount,
        evidenceTimeline: page.evidenceTimeline.map((entry) => ({
          source: entry.source,
          channel: entry.channel,
          content: entry.content,
        })),
      },
      latestVersion: latestVersion
        ? {
            title: latestVersion.title,
            content: latestVersion.content,
            version: latestVersion.version,
          }
        : null,
      evidenceCount: page.evidenceTimeline.length,
      versionCount: sortedVersions.length,
      attributionCount: attributions.length,
      distinctAttributionSourceCount: sourceAttributionSourceIds.length,
      sourceAttributionSourceIds,
      sourceAttributionCount: attributions.filter(
        (attribution) => attribution.sourceId === args.sourceId,
      ).length,
      sourceCount: page.sourceCount,
    };
  },
});

export const p5ProbeExistingPageUpsert = internalAction({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const seed = await ctx.runMutation(p5SeedExistingPageUpsertRef, {
      caseName: args.caseName,
    });
    const extraction = {
      type: "decision" as const,
      title: seed.expected.title,
      slug: seed.expected.slug,
      compiledTruth: seed.expected.compiledTruth,
      confidence: seed.expected.confidence,
      tags: seed.expected.tags,
      entity: seed.expected.entity,
      supportingEvidence: [{ chunkIndex: 0, excerpt: seed.expected.evidence }],
    };

    const firstApply = await ctx.runMutation(p5ApplyKnowledgeExtractionsRef, {
      sourceId: seed.newSourceId,
      jobId: seed.jobId,
      expectedLeaseVersion: 0,
      extractions: [extraction],
    });
    const firstState = await ctx.runQuery(p5GetExistingPageUpsertStateRef, {
      pageId: seed.pageId,
      sourceId: seed.newSourceId,
    });
    const duplicateApply = await ctx.runMutation(p5ApplyKnowledgeExtractionsRef, {
      sourceId: seed.newSourceId,
      jobId: seed.jobId,
      expectedLeaseVersion: 0,
      extractions: [extraction],
    });
    const duplicateState = await ctx.runQuery(p5GetExistingPageUpsertStateRef, {
      pageId: seed.pageId,
      sourceId: seed.newSourceId,
    });

    const changedTruthSameEvidenceExtraction = {
      ...extraction,
      title: `${seed.expected.title} Changed`,
      compiledTruth: `${seed.expected.compiledTruth} Changed with the same evidence excerpt.`,
      tags: [...seed.expected.tags, "same-evidence-change"],
    };
    const changedTruthSameEvidenceApply = await ctx.runMutation(
      p5ApplyKnowledgeExtractionsRef,
      {
        sourceId: seed.newSourceId,
        jobId: seed.jobId,
        expectedLeaseVersion: 0,
        extractions: [changedTruthSameEvidenceExtraction],
      },
    );
    const changedTruthSameEvidenceState = await ctx.runQuery(
      p5GetExistingPageUpsertStateRef,
      {
        pageId: seed.pageId,
        sourceId: seed.newSourceId,
      },
    );
    const sameTitleSameEvidenceApply = await ctx.runMutation(
      p5ApplyKnowledgeExtractionsRef,
      {
        sourceId: seed.sameTitleSameEvidenceSourceId,
        jobId: seed.sameTitleSameEvidenceJobId,
        expectedLeaseVersion: 0,
        extractions: [changedTruthSameEvidenceExtraction],
      },
    );
    const sameTitleSameEvidenceState = await ctx.runQuery(
      p5GetExistingPageUpsertStateRef,
      {
        pageId: seed.pageId,
        sourceId: seed.sameTitleSameEvidenceSourceId,
      },
    );

    const typeConflictExtraction = {
      ...changedTruthSameEvidenceExtraction,
      type: "fact" as const,
      title: `${seed.expected.title} Type Conflict Should Not Persist`,
      compiledTruth: `${seed.expected.compiledTruth} Type conflict should not persist.`,
      tags: [...seed.expected.tags, "type-conflict-should-not-persist"],
      supportingEvidence: [
        { chunkIndex: 0, excerpt: `Type conflict evidence for ${seed.caseSlug}` },
      ],
    };
    let typeConflictError: string | null = null;
    try {
      await ctx.runMutation(p5ApplyKnowledgeExtractionsRef, {
        sourceId: seed.typeConflictSourceId,
        jobId: seed.typeConflictJobId,
        expectedLeaseVersion: 0,
        extractions: [typeConflictExtraction],
      });
    } catch (error) {
      typeConflictError = error instanceof Error ? error.message : String(error);
    }
    const typeConflictState = await ctx.runQuery(p5GetExistingPageUpsertStateRef, {
      pageId: seed.pageId,
      sourceId: seed.typeConflictSourceId,
    });

    const duplicateStable =
      duplicateApply.pagesCreated === 0 &&
      duplicateApply.pagesUpdated === 0 &&
      duplicateApply.attributionsCreated === 0 &&
      duplicateApply.pageCountDelta === 0 &&
      duplicateState.sourceCount === firstState.sourceCount &&
      duplicateState.evidenceCount === firstState.evidenceCount &&
      duplicateState.versionCount === firstState.versionCount &&
      duplicateState.attributionCount === firstState.attributionCount;
    const changedTruthEvidenceCountStable =
      changedTruthSameEvidenceState.evidenceCount === duplicateState.evidenceCount;
    const changedTruthSourceCountStable =
      changedTruthSameEvidenceState.sourceCount === duplicateState.sourceCount;
    const changedTruthVersionCountIncremented =
      changedTruthSameEvidenceState.versionCount === duplicateState.versionCount + 1;
    const sameTitleSameEvidenceSourceCountIncremented =
      sameTitleSameEvidenceState.sourceCount ===
      changedTruthSameEvidenceState.sourceCount + 1;
    const sameTitleSameEvidenceDistinctAttributionIncremented =
      sameTitleSameEvidenceState.distinctAttributionSourceCount ===
      changedTruthSameEvidenceState.distinctAttributionSourceCount + 1;
    const sameTitleSameEvidenceEvidenceCountStable =
      sameTitleSameEvidenceState.evidenceCount ===
      changedTruthSameEvidenceState.evidenceCount;
    const sameTitleSameEvidenceHasAttribution =
      sameTitleSameEvidenceState.sourceAttributionCount === 1;
    const typeConflictRejected =
      typeConflictError?.includes("BAD_REQUEST") === true &&
      typeConflictError.includes("type conflict");
    const typeConflictLivePageUnchanged =
      JSON.stringify(typeConflictState.livePage) ===
      JSON.stringify(sameTitleSameEvidenceState.livePage);
    const typeConflictProvenUnchanged =
      typeConflictState.sourceCount === sameTitleSameEvidenceState.sourceCount &&
      typeConflictState.evidenceCount === sameTitleSameEvidenceState.evidenceCount &&
      typeConflictState.versionCount === sameTitleSameEvidenceState.versionCount &&
      typeConflictState.attributionCount === sameTitleSameEvidenceState.attributionCount &&
      typeConflictState.distinctAttributionSourceCount ===
        sameTitleSameEvidenceState.distinctAttributionSourceCount &&
      typeConflictState.sourceAttributionCount === 0 &&
      typeConflictLivePageUnchanged;

    assertP5ExistingPageUpsertProbe(firstApply.pagesCreated === 0, "first apply created a page");
    assertP5ExistingPageUpsertProbe(firstApply.pagesUpdated === 1, "first apply did not update the existing page");
    assertP5ExistingPageUpsertProbe(firstApply.attributionsCreated === 1, "first apply did not create one attribution");
    assertP5ExistingPageUpsertProbe(firstApply.pageCountDelta === 0, "first apply changed pageCountDelta");
    assertP5ExistingPageUpsertProbe(firstState.livePage.type === "decision", "first apply changed page type");
    assertP5ExistingPageUpsertProbe(firstState.livePage.title === seed.expected.title, "first apply did not update title");
    assertP5ExistingPageUpsertProbe(firstState.livePage.compiledTruth === seed.expected.compiledTruth, "first apply did not update compiled truth");
    assertP5ExistingPageUpsertProbe(firstState.sourceCount === 2, "first apply did not increment sourceCount");
    assertP5ExistingPageUpsertProbe(duplicateStable, "duplicate same-payload apply was not idempotent");
    assertP5ExistingPageUpsertProbe(changedTruthEvidenceCountStable, "same-source same-evidence current-state update appended evidence");
    assertP5ExistingPageUpsertProbe(changedTruthSourceCountStable, "same-source same-evidence current-state update changed sourceCount");
    assertP5ExistingPageUpsertProbe(changedTruthVersionCountIncremented, "same-source same-evidence current-state update did not create a version");
    assertP5ExistingPageUpsertProbe(sameTitleSameEvidenceApply.attributionsCreated === 1, "same-title same-evidence distinct source did not create an attribution");
    assertP5ExistingPageUpsertProbe(sameTitleSameEvidenceSourceCountIncremented, "same-title same-evidence distinct source did not increment sourceCount");
    assertP5ExistingPageUpsertProbe(sameTitleSameEvidenceDistinctAttributionIncremented, "same-title same-evidence distinct source did not increase distinct attribution sources");
    assertP5ExistingPageUpsertProbe(sameTitleSameEvidenceEvidenceCountStable, "same-title same-evidence distinct source appended duplicate evidence");
    assertP5ExistingPageUpsertProbe(sameTitleSameEvidenceHasAttribution, "same-title same-evidence distinct source attribution is missing");
    assertP5ExistingPageUpsertProbe(typeConflictRejected, "same-slug different-type extraction was not rejected");
    assertP5ExistingPageUpsertProbe(typeConflictProvenUnchanged, "type conflict mutated the live page");

    return {
      seed,
      expected: seed.expected,
      firstApply,
      firstState,
      duplicateApply,
      duplicateState,
      livePage: duplicateState.livePage,
      latestVersion: duplicateState.latestVersion,
      changedTruthSameEvidenceCase: {
        apply: changedTruthSameEvidenceApply,
        state: changedTruthSameEvidenceState,
        evidenceCountStable: changedTruthEvidenceCountStable,
        sourceCountStable: changedTruthSourceCountStable,
        versionCountIncremented: changedTruthVersionCountIncremented,
      },
      sameTitleSameEvidenceDistinctSourceCase: {
        apply: sameTitleSameEvidenceApply,
        state: sameTitleSameEvidenceState,
        evidenceCountStable: sameTitleSameEvidenceEvidenceCountStable,
        sourceCountIncremented: sameTitleSameEvidenceSourceCountIncremented,
        distinctAttributionSourceCountIncremented:
          sameTitleSameEvidenceDistinctAttributionIncremented,
        sourceAttributionCreated: sameTitleSameEvidenceHasAttribution,
      },
      typeConflictCase: {
        rejected: typeConflictRejected,
        error: typeConflictError,
        state: typeConflictState,
        livePageUnchanged: typeConflictLivePageUnchanged,
        noMutationProven: typeConflictProvenUnchanged,
      },
    };
  },
});

export const p5SeedSessionBridgeProbe = internalMutation({
  args: {
    caseName: v.string(),
    eventCount: v.optional(v.number()),
    pageAgeMs: v.optional(v.number()),
    jobAgeMs: v.optional(v.number()),
    sessionPageStatus: v.optional(P5_PAGE_STATUS_VALIDATOR),
    bridgeStatus: v.optional(P5_BRIDGE_STATUS_VALIDATOR),
    withSource: v.optional(v.boolean()),
    sourceStatus: v.optional(P5_SOURCE_STATUS_VALIDATOR),
    jobStatus: v.optional(P5_JOB_STATUS_VALIDATOR),
    extractedPageCount: v.optional(v.number()),
    knowledgeBasePageCount: v.optional(v.number()),
    jobCompletedAt: v.optional(v.boolean()),
    newerZombieStatus: v.optional(P5_JOB_STATUS_VALIDATOR),
    wikilinkTargetStatus: v.optional(P5_PAGE_STATUS_VALIDATOR),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const pageAgeMs = args.pageAgeMs ?? 31 * 60 * 1000;
    const jobAgeMs = args.jobAgeMs ?? 31 * 60 * 1000;
    const eventCount = args.eventCount ?? 0;
    const caseSlug = slugify(`${args.caseName}-${now}`);
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: `p5-${caseSlug}`,
      name: `P5 ${args.caseName}`,
    });
    const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
      orgId,
      name: `P5 KB ${args.caseName}`,
      pageCount: args.knowledgeBasePageCount ?? 0,
      sourceCount: (args.withSource ?? true) ? 1 : 0,
      createdAt: now,
    });

    const eventIds: Id<"events">[] = [];
    for (let index = 0; index < eventCount; index += 1) {
      eventIds.push(await ctx.db.insert("events", {
        orgId,
        source: "p5-probe",
        via: "api",
        type: "probe_event",
        actor: "P5 Probe",
        summary: `P5 probe event ${index + 1} for ${args.caseName}`,
        timestamp: now - eventCount * 1000 + index * 1000,
        raw: { caseName: args.caseName, index },
        processed: true,
      }));
    }

    const sessionId = await ctx.db.insert("sessions", {
      orgId,
      actor: "P5 Probe",
      repo: "spark",
      title: `P5 ${args.caseName}`,
      startTime: now - eventCount * 1000,
      endTime: now,
      eventCount,
      status: "complete",
      eventIds,
    });

    const targetTitle = `P5 ${args.caseName} Target`;
    const compiledTruth = args.wikilinkTargetStatus
      ? `P5 recovery probe for [[${targetTitle}]].`
      : `P5 recovery probe for ${args.caseName}.`;
    const sessionPageId = await ctx.db.insert("knowledgePages", {
      orgId,
      knowledgeBaseId,
      type: "session",
      title: `P5 ${args.caseName}`,
      slug: `p5-session-${caseSlug}`,
      compiledTruth,
      evidenceTimeline: eventIds.map((eventId, index) => ({
        source: "P5 Probe",
        channel: "p5-probe",
        timestamp: now - eventCount * 1000 + index * 1000,
        content: `P5 probe event ${index + 1}: ${eventId}`,
      })),
      tags: ["p5-recovery"],
      confidence: "high",
      sessionId,
      actor: "P5 Probe",
      repo: "spark",
      sessionStartTime: now - eventCount * 1000,
      sessionEndTime: now,
      eventCount,
      eventIds,
      knowledgePageIds: [],
      knowledgeBridgeStatus: args.bridgeStatus,
      sourceCount: 1,
      lastConfirmed: now,
      status: args.sessionPageStatus ?? "active",
      createdBy: "debug:p5SeedSessionBridgeProbe",
      createdAt: now - pageAgeMs,
      updatedAt: now - pageAgeMs,
    });

    let wikilinkTargetPageId: Id<"knowledgePages"> | null = null;
    if (args.wikilinkTargetStatus) {
      wikilinkTargetPageId = await ctx.db.insert("knowledgePages", {
        orgId,
        knowledgeBaseId,
        type: "entity",
        title: targetTitle,
        slug: slugify(targetTitle),
        compiledTruth: `Target page for ${args.caseName}`,
        evidenceTimeline: [],
        entity: targetTitle,
        tags: ["p5-recovery"],
        confidence: "high",
        sourceCount: 1,
        lastConfirmed: now,
        status: args.wikilinkTargetStatus,
        createdBy: "debug:p5SeedSessionBridgeProbe",
        createdAt: now,
        updatedAt: now,
      });
    }

    let sourceId: Id<"sources"> | null = null;
    let jobId: Id<"ingestJobs"> | null = null;
    const extractedPageIds: Id<"knowledgePages">[] = [];
    const content = compiledTruth;
    const contentHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`session:${sessionId}:${content}`),
    ).then((buffer) => Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join(""));

    if (args.withSource ?? true) {
      sourceId = await ctx.db.insert("sources", {
        orgId,
        knowledgeBaseId,
        title: `P5 ${args.caseName}`,
        sourceType: "session",
        content,
        contentHash,
        status: args.sourceStatus ?? "processed",
        sessionId,
        createdAt: now - jobAgeMs,
      });
      jobId = await ctx.db.insert("ingestJobs", {
        orgId,
        sourceId,
        knowledgeBaseId,
        status: args.jobStatus ?? "completed",
        currentStep: `P5 ${args.jobStatus ?? "completed"}`,
        extractionLeaseVersion: 0,
        progress: {
          entitiesExtracted: 0,
          pagesCreated: args.extractedPageCount ?? 0,
          pagesUpdated: 0,
          referencesCreated: 0,
        },
        startedAt: now - jobAgeMs,
        completedAt:
          (args.jobCompletedAt ?? ((args.jobStatus ?? "completed") === "completed"))
            ? now - jobAgeMs
            : undefined,
        createdAt: now - jobAgeMs,
      });

      for (let index = 0; index < (args.extractedPageCount ?? 0); index += 1) {
        const pageId = await ctx.db.insert("knowledgePages", {
          orgId,
          knowledgeBaseId,
          type: "fact",
          title: `P5 ${args.caseName} Fact ${index + 1}`,
          slug: `p5-${caseSlug}-fact-${index + 1}`,
          compiledTruth: `Fact ${index + 1} from ${args.caseName}`,
          evidenceTimeline: [{
            source: `P5 ${args.caseName}`,
            channel: "session",
            timestamp: now,
            content: `Evidence ${index + 1}`,
          }],
          tags: ["p5-recovery"],
          confidence: "high",
          sourceCount: 1,
          lastConfirmed: now,
          status: "active",
          createdBy: "debug:p5SeedSessionBridgeProbe",
          createdAt: now,
          updatedAt: now,
        });
        extractedPageIds.push(pageId);
        await ctx.db.insert("sourceAttributions", {
          pageId,
          sourceId,
          orgId,
          excerpt: `Evidence ${index + 1}`,
          createdAt: now,
        });
      }

      if (args.newerZombieStatus) {
        await ctx.db.insert("ingestJobs", {
          orgId,
          sourceId,
          knowledgeBaseId,
          status: args.newerZombieStatus,
          currentStep: `P5 newer zombie ${args.newerZombieStatus}`,
          startedAt: now - Math.floor(jobAgeMs / 2),
          extractionLeaseVersion: 0,
          createdAt: now,
        });
      }
    }

    return {
      orgId,
      knowledgeBaseId,
      sessionId,
      sessionPageId,
      sourceId,
      jobId,
      extractedPageIds,
      wikilinkTargetPageId,
      createSourceArgs: {
        orgId,
        knowledgeBaseId,
        title: `P5 ${args.caseName}`,
        sourceType: "session" as const,
        content,
        sessionId,
      },
    };
  },
});

export const p5InspectBridgeProbe = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    const sessionPage = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_type", (q) =>
        q.eq("orgId", session.orgId).eq("type", "session"),
      )
      .filter((q) => q.eq(q.field("sessionId"), args.sessionId))
      .first();
    if (!sessionPage) {
      throw new Error(`Session page ${args.sessionId} not found`);
    }

    const sources = await ctx.db
      .query("sources")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    const jobs = (
      await Promise.all(sources.map((source) =>
        ctx.db
          .query("ingestJobs")
          .withIndex("by_source", (q) => q.eq("sourceId", source._id))
          .collect(),
      ))
    ).flat().sort((left, right) => right._creationTime - left._creationTime);
    const attributions = (
      await Promise.all(sources.map((source) =>
        ctx.db
          .query("sourceAttributions")
          .withIndex("by_source", (q) => q.eq("sourceId", source._id))
          .collect(),
      ))
    ).flat();
    const partOfRefs = await ctx.db
      .query("references")
      .withIndex("by_to", (q) =>
        q.eq("toPageId", sessionPage._id).eq("referenceType", "part_of"),
      )
      .collect();
    const mentionRefs = await ctx.db
      .query("references")
      .withIndex("by_from", (q) =>
        q.eq("fromPageId", sessionPage._id).eq("referenceType", "mentions"),
      )
      .collect();
    const partOfKeys = partOfRefs.map((ref) => `${ref.fromPageId}:${ref.toPageId}`);
    const duplicatePartOfKeys = partOfKeys.filter(
      (key, index) => partOfKeys.indexOf(key) !== index,
    );
    const activeStatuses = new Set(["pending", "chunking", "extracting", "synthesizing", "cross_referencing"]);
    const stuckCutoff = Date.now() - 30 * 60 * 1000;
    const knowledgeBase = await ctx.db.get(sessionPage.knowledgeBaseId);

    return {
      sessionId: args.sessionId,
      knowledgeBase: knowledgeBase
        ? {
            id: knowledgeBase._id,
            pageCount: knowledgeBase.pageCount,
            lastIngestAt: knowledgeBase.lastIngestAt ?? null,
          }
        : null,
      sessionPage: {
        id: sessionPage._id,
        status: sessionPage.status,
        updatedAt: sessionPage.updatedAt,
        knowledgeBridgeStatus: sessionPage.knowledgeBridgeStatus ?? null,
        knowledgeBridgeCompletedAt: sessionPage.knowledgeBridgeCompletedAt ?? null,
        knowledgePageIds: sessionPage.knowledgePageIds ?? [],
        knowledgePageIdCount: sessionPage.knowledgePageIds?.length ?? 0,
        isStuckCandidate:
          sessionPage.status === "active" &&
          sessionPage.updatedAt < stuckCutoff &&
          sessionPage.knowledgeBridgeStatus !== "completed" &&
          (!sessionPage.knowledgePageIds || sessionPage.knowledgePageIds.length === 0),
      },
      sources: sources.map((source) => ({
        id: source._id,
        status: source.status,
        createdAt: source.createdAt,
      })),
      jobs: jobs.map((job) => ({
        id: job._id,
        status: job.status,
        currentStep: job.currentStep ?? null,
        error: job.error ?? null,
        startedAt: job.startedAt ?? null,
        completedAt: job.completedAt ?? null,
        extractionLeaseVersion: job.extractionLeaseVersion ?? null,
        createdAt: job.createdAt,
        progress: job.progress ?? null,
      })),
      activeJobCount: jobs.filter((job) => activeStatuses.has(job.status)).length,
      completedJobCount: jobs.filter((job) => job.status === "completed" || job.completedAt !== undefined).length,
      attributionCount: attributions.length,
      attributionPageIds: Array.from(new Set(attributions.map((a) => a.pageId))),
      partOfRefCount: partOfRefs.length,
      duplicatePartOfKeys,
      mentionRefCount: mentionRefs.length,
      mentionTargets: mentionRefs.map((ref) => ref.toPageId),
    };
  },
});

export const p5RecoverStaleJobTwice = internalAction({
  args: {
    jobId: v.id("ingestJobs"),
    staleBefore: v.number(),
  },
  handler: async (ctx, args) => {
    const first = await ctx.runMutation(p5RecoverStaleSessionBridgeJobRef, args);
    const second = await ctx.runMutation(p5RecoverStaleSessionBridgeJobRef, args);

    return { first, second };
  },
});

export const p5ListStuckCandidates = internalQuery({
  args: {
    orgId: v.id("orgs"),
    cutoff: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cutoff = args.cutoff ?? Date.now() - 30 * 60 * 1000;
    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_type", (q) =>
        q.eq("orgId", args.orgId).eq("type", "session"),
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "active"),
          q.lt(q.field("updatedAt"), cutoff),
        ),
      )
      .collect();

    return pages
      .filter((page): page is Doc<"knowledgePages"> & { sessionId: Id<"sessions"> } =>
        Boolean(page.sessionId) &&
        page.knowledgeBridgeStatus !== "completed" &&
        (!page.knowledgePageIds || page.knowledgePageIds.length === 0),
      )
      .map((page) => ({
        sessionId: page.sessionId,
        pageId: page._id,
        status: page.status,
        knowledgeBridgeStatus: page.knowledgeBridgeStatus ?? null,
        knowledgePageIds: page.knowledgePageIds ?? [],
      }));
  },
});

type BaselinePageSpec = {
  slug: string;
  title: string;
  type: Doc<"knowledgePages">["type"];
  compiledTruth: string;
  sourceContent: string;
  contextPrefix: string;
  attributionExcerpt: string;
  tags: string[];
  confidence: Doc<"knowledgePages">["confidence"];
  entity?: string;
  sourceType: Doc<"sources">["sourceType"];
  session?: {
    actor: string;
    repo: string;
    startTime: number;
    endTime: number;
    eventCount: number;
    workType: string;
    complexity: "low" | "moderate" | "high";
    skills: string[];
  };
  references?: Array<{
    targetSlug: string;
    referenceType: Doc<"references">["referenceType"];
    context?: string;
  }>;
};

type BaselineRagSeed = {
  slug: string;
  sourceId: Id<"sources">;
  chunkIndex: number;
  title: string;
  sourceType: Doc<"sources">["sourceType"];
  ragText: string;
  contentHash: string;
};

const BASELINE_FIXTURE = "phase2-part6-v1";
const BASELINE_CLERK_ORG_ID = "part6-baseline-v1";
const BASELINE_ORG_NAME = "Part 6 Baseline Eval";
const BASELINE_CREATED_BY = "debug:runSearchBaseline";
const BASELINE_CHANNEL = "eval-fixture";
const BASELINE_TAG = "part6-baseline";
const BASELINE_TIMESTAMP = Date.parse("2026-05-07T12:00:00.000Z");
const BASELINE_VECTOR_PROBE_QUERY = "How does org isolation work in vector search?";
const BASELINE_BM25_PROBE_QUERY = "What is Compiled Truth?";
const BASELINE_HARD_NEGATIVE_THRESHOLD = 0.3;

const SEARCH_BASELINE_PAGES: readonly BaselinePageSpec[] = [
  {
    slug: "cohere-reranking-decision",
    title: "Cohere Reranking Decision",
    type: "decision",
    compiledTruth:
      "Cohere reranking decision: Spark chose Cohere for reranking because hybrid search already gathers recall with BM25 and vector retrieval, so the last step needs precise semantic ordering. Cohere exposes relevance scores and search-unit billing, which makes search quality measurement and cost tracking straightforward.",
    sourceContent:
      "Cohere reranking decision. Spark chose Cohere for reranking because the retrieval stack already gathers candidates from BM25 chunk search and vector search. The remaining job is semantic precision on fused candidates. Cohere provides strong relevance ordering, explicit relevance scores, search-unit billing, and stable index mapping back to source chunks. The team decided to keep Cohere as the reranking layer and measure baseline quality before any tuning pass.",
    contextPrefix:
      "Decision note explaining why Spark chose Cohere for reranking in the hybrid search stack.",
    attributionExcerpt:
      "Spark chose Cohere for reranking because the retrieval stack already gathers candidates from BM25 chunk search and vector search.",
    tags: ["search", "reranking", "cohere"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "openai-embedding-model",
    title: "OpenAI Embedding Model",
    type: "fact",
    compiledTruth:
      "OpenAI embedding model: Spark uses text-embedding-3-large for the RAG index. The embedding model produces 3072-dimensional vectors, which match the configured embedding dimension in the knowledge pipeline.",
    sourceContent:
      "OpenAI embedding model. Spark uses the OpenAI text-embedding-3-large embedding model for vector retrieval in the RAG component. The pipeline stores 3072-dimensional embeddings so semantic search can operate over source chunks inside each org namespace.",
    contextPrefix:
      "Fact sheet describing the embedding model Spark uses for vector search.",
    attributionExcerpt:
      "Spark uses the OpenAI text-embedding-3-large embedding model for vector retrieval in the RAG component.",
    tags: ["search", "embeddings", "openai"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "hybrid-search-split-decision",
    title: "Hybrid Search Split Decision",
    type: "decision",
    compiledTruth:
      "Hybrid search split decision: search is split into a BM25 live path and a deeper vector path because they optimize for different needs. BM25 gives instant keystroke recall on exact words, while vector retrieval improves semantic recall for longer questions before reranking.",
    sourceContent:
      "Hybrid search split decision. Spark keeps live search as BM25 over knowledge pages for instant feedback while the deeper path performs BM25 chunk recall, vector recall, reciprocal rank fusion, and reranking. The split exists because exact token lookup and semantic question answering have different latency and recall requirements.",
    contextPrefix:
      "Design decision describing why Spark separates BM25 live search from deeper vector search.",
    attributionExcerpt:
      "Spark keeps live search as BM25 over knowledge pages for instant feedback while the deeper path performs BM25 chunk recall, vector recall, reciprocal rank fusion, and reranking.",
    tags: ["search", "bm25", "vector"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "compiled-truth-definition",
    title: "Compiled Truth Definition",
    type: "fact",
    compiledTruth:
      "Compiled Truth definition: Compiled Truth is the rewritable markdown synthesis at the center of each knowledge page. It stores the current best answer, while the evidence timeline and source attributions preserve provenance and revision history.",
    sourceContent:
      "Compiled Truth definition. In Spark, Compiled Truth is the rewritable markdown synthesis for a knowledge page. It holds the current best statement of what the system believes, and it stays grounded because the evidence timeline and source attributions keep the supporting provenance visible.",
    contextPrefix:
      "Definition page for the meaning of Compiled Truth inside Spark knowledge pages.",
    attributionExcerpt:
      "In Spark, Compiled Truth is the rewritable markdown synthesis for a knowledge page.",
    tags: ["knowledge", "compiled-truth"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "knowledge-operations",
    title: "Knowledge Operations",
    type: "fact",
    compiledTruth:
      "Knowledge operations: the three operations on knowledge are ingest, retrieve, and synthesize. Spark first ingests evidence, then retrieves relevant knowledge, then synthesizes durable understanding from the retrieved material.",
    sourceContent:
      "Knowledge operations. Spark treats knowledge work as three operations on knowledge: ingest, retrieve, and synthesize. Ingest turns raw evidence into searchable material, retrieve pulls back the right knowledge for a question, and synthesize compresses evidence into durable pages, findings, and briefings.",
    contextPrefix:
      "Fact page naming Spark's three operations on knowledge.",
    attributionExcerpt:
      "Spark treats knowledge work as three operations on knowledge: ingest, retrieve, and synthesize.",
    tags: ["knowledge", "operations"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "dream-cycle",
    title: "Dream Cycle",
    type: "pattern",
    compiledTruth:
      "Dream Cycle: the Dream Cycle runs a speculative sensemaking pass over the org. It surfaces hypotheses, weak signals, and strategic possibilities, and it labels them as conjecture until later evidence confirms or rejects them.",
    sourceContent:
      "Dream Cycle. The Dream Cycle is Spark's speculative sensemaking loop. It is not the retrieval system itself; instead it scans the org for patterns, weak signals, open questions, and promising hypotheses so later knowledge work can confirm or disprove them.",
    contextPrefix:
      "Pattern page describing what the Dream Cycle does inside Spark.",
    attributionExcerpt:
      "The Dream Cycle is Spark's speculative sensemaking loop.",
    tags: ["dream-cycle", "pattern"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "contextual-chunking",
    title: "Contextual Chunking",
    type: "fact",
    compiledTruth:
      "Contextual chunking: a chunk targets 800 tokens with 150 tokens of overlap. Spark writes a short context prefix for each chunk so the chunk carries document-level framing before BM25, vector retrieval, and reranking inspect it.",
    sourceContent:
      "Contextual chunking. Spark chunks source material at roughly 800 tokens with 150-token overlap. For each chunk, Spark writes a short context prefix that explains where the chunk sits in the source document. That contextual prefix improves keyword matching, semantic retrieval, and later reranking because the chunk carries local meaning plus document framing.",
    contextPrefix:
      "Implementation note on Spark's contextual chunking strategy and token sizes.",
    attributionExcerpt:
      "Spark chunks source material at roughly 800 tokens with 150-token overlap.",
    tags: ["chunking", "retrieval"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "reranker-model",
    title: "Reranker Model",
    type: "fact",
    compiledTruth:
      "Reranker model: Spark uses Cohere rerank-v4.0-pro for reranking and falls back to rerank-v3.5 only if the newer model is unavailable. The reranker produces the relevanceScore used in deep search evaluation.",
    sourceContent:
      "Reranker model. Spark's deep search path uses Cohere rerank-v4.0-pro as the primary reranker model. If that model is invalid or unavailable, the code falls back to rerank-v3.5. The returned relevanceScore becomes the final deep-search ranking signal for baseline measurement.",
    contextPrefix:
      "Fact page listing the reranker model used by Spark deep search.",
    attributionExcerpt:
      "Spark's deep search path uses Cohere rerank-v4.0-pro as the primary reranker model.",
    tags: ["reranking", "cohere", "models"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "anthropic-contextual-retrieval-improvement",
    title: "Anthropic Contextual Retrieval Improvement",
    type: "fact",
    compiledTruth:
      "Anthropic contextual retrieval improvement: the improvement comes from giving each chunk a short contextual header or prefix so the chunk keeps document-level meaning. Spark uses that contextual framing because contextual retrieval is reported to improve retrieval quality over plain isolated chunks.",
    sourceContent:
      "Anthropic contextual retrieval improvement. Anthropic's contextual retrieval idea improves search by attaching a concise context header to every chunk. Instead of retrieving an isolated paragraph, the retriever sees both the chunk and a compact explanation of where it belongs. Spark adopts that idea through context prefixes on source chunks.",
    contextPrefix:
      "Fact page summarizing Anthropic's contextual retrieval improvement and Spark's usage of it.",
    attributionExcerpt:
      "Anthropic's contextual retrieval idea improves search by attaching a concise context header to every chunk.",
    tags: ["anthropic", "retrieval", "context"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "vector-org-isolation",
    title: "Vector Org Isolation",
    type: "decision",
    compiledTruth:
      "Vector org isolation: org isolation in vector search uses the orgId as the RAG namespace. Deep search only queries vectors inside that namespace, so vector recall never crosses org boundaries.",
    sourceContent:
      "Vector org isolation. Spark preserves org isolation in vector search by using the orgId as the vector namespace for RAG. Every vector add and vector search call uses that namespace, which means one org cannot retrieve chunks from another org even if the text is semantically similar.",
    contextPrefix:
      "Decision note explaining how org isolation works in vector search.",
    attributionExcerpt:
      "Spark preserves org isolation in vector search by using the orgId as the vector namespace for RAG.",
    tags: ["vector", "security", "org-isolation"],
    confidence: "high",
    sourceType: "paste",
  },
  {
    slug: "session-knowledge-bridge",
    title: "Session Knowledge Bridge",
    type: "session",
    compiledTruth:
      "Session knowledge bridge: the session knowledge bridge takes a completed session page, creates a deterministic session source, runs chunking and knowledge extraction, then finalizes the session page with the extracted knowledge page IDs. The bridge turns raw session summaries into searchable knowledge.",
    sourceContent:
      "Session knowledge bridge. The bridge starts from a completed session page, creates a session source in the knowledge base, chunks the session summary, extracts durable knowledge pages, writes source attributions, and then finalizes the session page with the resulting knowledge page ids. The result is that session content becomes retrievable knowledge instead of remaining only a transient summary.",
    contextPrefix:
      "Session note describing what the session knowledge bridge did.",
    attributionExcerpt:
      "The bridge starts from a completed session page, creates a session source in the knowledge base, chunks the session summary, extracts durable knowledge pages, writes source attributions, and then finalizes the session page with the resulting knowledge page ids.",
    tags: ["session", "knowledge-bridge"],
    confidence: "high",
    sourceType: "session",
    session: {
      actor: "Spark Builder",
      repo: "spark",
      startTime: Date.parse("2026-04-25T18:00:00.000Z"),
      endTime: Date.parse("2026-04-25T19:30:00.000Z"),
      eventCount: 12,
      workType: "bridge",
      complexity: "high",
      skills: ["convex", "knowledge"],
    },
    references: [
      {
        targetSlug: "bridge-sweep-repair",
        referenceType: "related_to",
        context: "Bridge sweep repair resumes stalled knowledge bridge work.",
      },
    ],
  },
  {
    slug: "extraction-recovery-hardening",
    title: "Extraction Recovery Hardening",
    type: "session",
    compiledTruth:
      "Extraction recovery hardening: the session that hardened extraction recovery added extraction lease versioning, stale transition rejection, durable completion guards, and safer recovery for interrupted extraction work.",
    sourceContent:
      "Extraction recovery hardening. The session that hardened extraction recovery introduced an extraction lease version, rejected stale transitions, protected completed work from later failures, and made recovery idempotent when a synthesis or cross-referencing step was interrupted.",
    contextPrefix:
      "Session note identifying which session hardened extraction recovery.",
    attributionExcerpt:
      "The session that hardened extraction recovery introduced an extraction lease version, rejected stale transitions, protected completed work from later failures, and made recovery idempotent when a synthesis or cross-referencing step was interrupted.",
    tags: ["session", "recovery", "extraction"],
    confidence: "high",
    sourceType: "session",
    session: {
      actor: "Spark Builder",
      repo: "spark",
      startTime: Date.parse("2026-04-26T02:00:00.000Z"),
      endTime: Date.parse("2026-04-26T03:10:00.000Z"),
      eventCount: 9,
      workType: "recovery",
      complexity: "high",
      skills: ["convex", "reliability"],
    },
  },
  {
    slug: "session-enrichment-tests",
    title: "Session Enrichment Tests",
    type: "session",
    compiledTruth:
      "Session enrichment tests: the tests that ran on session enrichment covered custom event ingest, session bridge source creation, extraction idempotency, and recovery sweep probes for stuck session pages.",
    sourceContent:
      "Session enrichment tests. Tests on session enrichment ran custom event ingest probes, session bridge source creation checks, extraction idempotency checks, and recovery sweep probes for stale or failed session knowledge bridge jobs.",
    contextPrefix:
      "Session note listing which tests ran on session enrichment.",
    attributionExcerpt:
      "Tests on session enrichment ran custom event ingest probes, session bridge source creation checks, extraction idempotency checks, and recovery sweep probes for stale or failed session knowledge bridge jobs.",
    tags: ["session", "tests", "enrichment"],
    confidence: "high",
    sourceType: "session",
    session: {
      actor: "Spark Builder",
      repo: "spark",
      startTime: Date.parse("2026-04-26T16:00:00.000Z"),
      endTime: Date.parse("2026-04-26T17:00:00.000Z"),
      eventCount: 7,
      workType: "testing",
      complexity: "moderate",
      skills: ["testing", "convex"],
    },
  },
  {
    slug: "bridge-sweep-repair",
    title: "Bridge Sweep Repair",
    type: "fact",
    compiledTruth:
      "Bridge sweep repair: the bridge sweep repair rescues active session pages that are stuck without completed knowledge pages. It retries stale jobs, repairs failed jobs with durable attributions, and re-finalizes session pages that already have extracted knowledge.",
    sourceContent:
      "Bridge sweep repair. The sweep repairs active session pages that still have a pending or failed knowledge bridge by finding stale jobs, retrying interrupted chunking or extraction work, repairing failed jobs that already wrote durable attributions, and finalizing session pages when the extracted knowledge already exists.",
    contextPrefix:
      "Fact page describing what the bridge sweep repair fixes.",
    attributionExcerpt:
      "The sweep repairs active session pages that still have a pending or failed knowledge bridge by finding stale jobs, retrying interrupted chunking or extraction work, repairing failed jobs that already wrote durable attributions, and finalizing session pages when the extracted knowledge already exists.",
    tags: ["recovery", "session-bridge"],
    confidence: "high",
    sourceType: "paste",
    references: [
      {
        targetSlug: "session-knowledge-bridge",
        referenceType: "related_to",
        context: "Repairs the same bridge lifecycle when it stalls.",
      },
    ],
  },
  {
    slug: "knowledge-pipeline-overview",
    title: "Knowledge Pipeline Overview",
    type: "pattern",
    compiledTruth:
      "Knowledge pipeline overview: the full knowledge pipeline runs from events to sessions, sessions to session pages, session pages to sources, sources to contextual chunks, chunks to retrieval and extraction, and then to source attributions, references, findings, and synthesized outputs.",
    sourceContent:
      "Knowledge pipeline overview. Spark starts with events, groups them into sessions, writes session pages, bridges those pages into sources, chunks the sources with context prefixes, indexes the chunks for BM25 and vector retrieval, extracts durable knowledge pages, writes source attributions and references, and finally produces findings and synthesized briefings.",
    contextPrefix:
      "Pattern page laying out the full knowledge pipeline from events to findings.",
    attributionExcerpt:
      "Spark starts with events, groups them into sessions, writes session pages, bridges those pages into sources, chunks the sources with context prefixes, indexes the chunks for BM25 and vector retrieval, extracts durable knowledge pages, writes source attributions and references, and finally produces findings and synthesized briefings.",
    tags: ["pipeline", "knowledge"],
    confidence: "high",
    sourceType: "paste",
    references: [
      {
        targetSlug: "source-attribution-format",
        referenceType: "mentions",
        context: "Attributions appear after extraction in the pipeline.",
      },
    ],
  },
  {
    slug: "decision-update-ledger",
    title: "Decision Update Ledger",
    type: "decision",
    compiledTruth:
      "Decision update ledger: decisions updated since first made include replacing keyword-only lookup with hybrid BM25 plus vector retrieval and replacing candidate ordering without reranking with Cohere reranking. The ledger records what changed and why it changed.",
    sourceContent:
      "Decision update ledger. The decisions that changed after the first implementation were the move from keyword-only lookup to hybrid BM25 plus vector retrieval and the move from unre-ranked candidate ordering to Cohere reranking. The ledger exists so the team can see which decisions were superseded and why.",
    contextPrefix:
      "Decision note tracking which search decisions were updated after first being made.",
    attributionExcerpt:
      "The decisions that changed after the first implementation were the move from keyword-only lookup to hybrid BM25 plus vector retrieval and the move from unre-ranked candidate ordering to Cohere reranking.",
    tags: ["decision", "history"],
    confidence: "high",
    sourceType: "paste",
    references: [
      {
        targetSlug: "cohere-reranking-decision",
        referenceType: "mentions",
        context: "Tracks the reranking decision change.",
      },
      {
        targetSlug: "hybrid-search-split-decision",
        referenceType: "mentions",
        context: "Tracks the move away from keyword-only lookup.",
      },
    ],
  },
  {
    slug: "source-attribution-format",
    title: "Source Attribution Format",
    type: "fact",
    compiledTruth:
      "Source attribution format: each source attribution stores pageId, sourceId, optional chunkId, orgId, excerpt, and createdAt. Excerpts are verbatim evidence tied to specific chunks when the chunk id is known.",
    sourceContent:
      "Source attribution format. Spark records provenance with source attributions shaped as pageId, sourceId, optional chunkId, orgId, excerpt, and createdAt. The excerpt should stay verbatim so a retrieved page can point back to the exact evidence that supported the claim.",
    contextPrefix:
      "Fact page documenting how source attribution is formatted in Spark.",
    attributionExcerpt:
      "Spark records provenance with source attributions shaped as pageId, sourceId, optional chunkId, orgId, excerpt, and createdAt.",
    tags: ["provenance", "attribution"],
    confidence: "high",
    sourceType: "paste",
  },
] as const;

const BASELINE_QUERY_VALIDATOR = v.object({
  id: v.string(),
  category: v.string(),
  query: v.string(),
});

const baselineSeedFixtureRef = makeFunctionReference<
  "mutation",
  { fixture: string },
  {
    orgId: Id<"orgs">;
    knowledgeBaseId: Id<"knowledgeBases">;
    ragSeeds: BaselineRagSeed[];
    corpus: {
      pageCount: number;
      sourceCount: number;
      chunkCount: number;
      attributionCount: number;
      referenceCount: number;
      sessionPageCount: number;
    };
  }
>("debug:seedSearchBaselineFixture");

function getSearchBaselineFixture(fixture: string): readonly BaselinePageSpec[] {
  if (fixture !== BASELINE_FIXTURE) {
    throw new Error(
      `Unsupported baseline fixture ${fixture}; expected ${BASELINE_FIXTURE}`,
    );
  }
  return SEARCH_BASELINE_PAGES;
}

function dedupeStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function tokenCountForFixture(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function sourceChunkSearchableText(content: string, contextPrefix?: string): string {
  return contextPrefix ? `${contextPrefix}\n\n${content}` : content;
}

async function deleteSearchBaselineChunkGraph(
  ctx: MutationCtx,
  chunk: Doc<"sourceChunks">,
  deletedAttributionIds: Set<Id<"sourceAttributions">>,
) {
  const attributions = await ctx.db
    .query("sourceAttributions")
    .withIndex("by_chunk", (q) => q.eq("chunkId", chunk._id))
    .collect();
  for (const attribution of attributions) {
    if (deletedAttributionIds.has(attribution._id)) {
      continue;
    }
    deletedAttributionIds.add(attribution._id);
    await ctx.db.delete(attribution._id);
  }

  await ctx.db.delete(chunk._id);
}

async function deleteSearchBaselinePageGraph(
  ctx: MutationCtx,
  page: Doc<"knowledgePages">,
  deletedReferenceIds: Set<Id<"references">>,
  deletedAttributionIds: Set<Id<"sourceAttributions">>,
) {
  const references = [
    ...(await ctx.db
      .query("references")
      .withIndex("by_from", (q) => q.eq("fromPageId", page._id))
      .collect()),
    ...(await ctx.db
      .query("references")
      .withIndex("by_to", (q) => q.eq("toPageId", page._id))
      .collect()),
  ];
  for (const reference of references) {
    if (deletedReferenceIds.has(reference._id)) {
      continue;
    }
    deletedReferenceIds.add(reference._id);
    await ctx.db.delete(reference._id);
  }

  const attributions = await ctx.db
    .query("sourceAttributions")
    .withIndex("by_page", (q) => q.eq("pageId", page._id))
    .collect();
  for (const attribution of attributions) {
    if (deletedAttributionIds.has(attribution._id)) {
      continue;
    }
    deletedAttributionIds.add(attribution._id);
    await ctx.db.delete(attribution._id);
  }

  const versions = await ctx.db
    .query("pageVersions")
    .withIndex("by_page", (q) => q.eq("pageId", page._id))
    .collect();
  for (const version of versions) {
    await ctx.db.delete(version._id);
  }

  await ctx.db.delete(page._id);
}

async function deleteSearchBaselineSourceGraph(
  ctx: MutationCtx,
  source: Doc<"sources">,
  deletedAttributionIds: Set<Id<"sourceAttributions">>,
) {
  const attributions = await ctx.db
    .query("sourceAttributions")
    .withIndex("by_source", (q) => q.eq("sourceId", source._id))
    .collect();
  for (const attribution of attributions) {
    if (deletedAttributionIds.has(attribution._id)) {
      continue;
    }
    deletedAttributionIds.add(attribution._id);
    await ctx.db.delete(attribution._id);
  }

  const chunks = await ctx.db
    .query("sourceChunks")
    .withIndex("by_source", (q) => q.eq("sourceId", source._id))
    .collect();
  for (const chunk of chunks) {
    await deleteSearchBaselineChunkGraph(ctx, chunk, deletedAttributionIds);
  }

  await ctx.db.delete(source._id);
}

async function reconcileSearchBaselineFixtureRows(
  ctx: MutationCtx,
  args: {
    knowledgeBaseId: Id<"knowledgeBases">;
    expectedPageSlugs: Set<string>;
    expectedSourceHashes: Set<string>;
  },
) {
  const deletedReferenceIds = new Set<Id<"references">>();
  const deletedAttributionIds = new Set<Id<"sourceAttributions">>();

  const pages = await ctx.db
    .query("knowledgePages")
    .withIndex("by_kb", (q) => q.eq("knowledgeBaseId", args.knowledgeBaseId))
    .collect();
  const seenPageSlugs = new Set<string>();
  for (const page of pages) {
    if (
      !args.expectedPageSlugs.has(page.slug) ||
      seenPageSlugs.has(page.slug)
    ) {
      await deleteSearchBaselinePageGraph(
        ctx,
        page,
        deletedReferenceIds,
        deletedAttributionIds,
      );
      continue;
    }
    seenPageSlugs.add(page.slug);
  }

  const sources = await ctx.db
    .query("sources")
    .withIndex("by_kb", (q) => q.eq("knowledgeBaseId", args.knowledgeBaseId))
    .collect();
  const seenSourceHashes = new Set<string>();
  for (const source of sources) {
    if (
      !source.contentHash ||
      !args.expectedSourceHashes.has(source.contentHash) ||
      seenSourceHashes.has(source.contentHash)
    ) {
      await deleteSearchBaselineSourceGraph(ctx, source, deletedAttributionIds);
      continue;
    }
    seenSourceHashes.add(source.contentHash);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortLiveResults<T extends { score: number; title: string; slug?: string | null; _id: string }>(
  results: readonly T[],
): T[] {
  return [...results].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const titleCompare = left.title.localeCompare(right.title);
    if (titleCompare !== 0) {
      return titleCompare;
    }
    const slugCompare = (left.slug ?? "").localeCompare(right.slug ?? "");
    if (slugCompare !== 0) {
      return slugCompare;
    }
    return left._id.localeCompare(right._id);
  });
}

function sortDeepResults<
  T extends { relevanceScore: number; title: string; slug?: string | null; pageId: string },
>(results: readonly T[]): T[] {
  return [...results].sort((left, right) => {
    if (right.relevanceScore !== left.relevanceScore) {
      return right.relevanceScore - left.relevanceScore;
    }
    const titleCompare = left.title.localeCompare(right.title);
    if (titleCompare !== 0) {
      return titleCompare;
    }
    const slugCompare = (left.slug ?? "").localeCompare(right.slug ?? "");
    if (slugCompare !== 0) {
      return slugCompare;
    }
    return left.pageId.localeCompare(right.pageId);
  });
}

function collectBaselineSearchFailures(
  results: readonly BaselineSearchResult[],
): BaselineSearchFailure[] {
  const failures: BaselineSearchFailure[] = [];
  for (const result of results) {
    if (result.liveSearch.error) {
      failures.push({
        id: result.id,
        category: result.category,
        query: result.query,
        surface: "liveSearch",
        error: result.liveSearch.error,
      });
    }
    if (result.deepSearch.error) {
      failures.push({
        id: result.id,
        category: result.category,
        query: result.query,
        surface: "deepSearch",
        error: result.deepSearch.error,
      });
    }
  }
  return failures;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function getYellow2aRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

const YELLOW2A_DEBUG_API_KEY_CREATED_BY = "debug:yellow2aCreateApiKey";
const YELLOW2_MCP_SMOKE_EVENT_SCAN_LIMIT = 200;
const YELLOW2C1_MAX_DEBUG_RATE_LIMIT_COUNT = 10_000;

type Yellow2DbCtx = { db: QueryCtx["db"] };

function yellow2McpSmokeSourceDeliveryPrefix(caseName: string) {
  return `debug:yellow2:mcp:${encodeURIComponent(caseName)}:`;
}

function yellow2McpSmokeSourceDeliveryId(caseName: string, suffix: string) {
  return `${yellow2McpSmokeSourceDeliveryPrefix(caseName)}${encodeURIComponent(suffix)}`;
}

function nextAsciiPrefix(prefix: string) {
  if (prefix.length === 0) {
    throw new Error("Yellow 2 prefix must not be empty");
  }
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 127) {
    throw new Error("Yellow 2 prefix must be ASCII");
  }
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

function assertYellow2DebugApiKey(
  apiKey: Doc<"apiKeys"> | null,
  orgId?: Id<"orgs">,
): asserts apiKey is Doc<"apiKeys"> {
  if (
    !apiKey ||
    (orgId && apiKey.orgId !== orgId) ||
    apiKey.createdBy !== YELLOW2A_DEBUG_API_KEY_CREATED_BY
  ) {
    throw new Error("Yellow 2 debug API key required");
  }
}

function validateYellow2RateLimitSeedCount(count: number) {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > YELLOW2C1_MAX_DEBUG_RATE_LIMIT_COUNT
  ) {
    throw new Error(
      `Yellow 2C1 rate-limit count must be an integer between 0 and ${YELLOW2C1_MAX_DEBUG_RATE_LIMIT_COUNT}`,
    );
  }
}

function isYellow2McpSmokeEvent(event: Doc<"events">, caseName: string) {
  const raw = getYellow2aRecord(event.raw);
  if (
    raw?.caseName !== caseName ||
    event.via !== "api" ||
    event.source !== "custom"
  ) {
    return false;
  }
  return (
    (event.actor === "yellow2a" &&
      event.type.startsWith("yellow2a_mcp_http_")) ||
    (event.actor === "yellow2b" &&
      event.type.startsWith("yellow2b_mcp_protocol_")) ||
    (event.actor === "yellow2c1" && event.type.startsWith("yellow2c1_"))
  );
}

async function listYellow2McpSmokeEventsByCase(
  ctx: Yellow2DbCtx,
  args: {
    orgId: Id<"orgs">;
    caseName: string;
    eventIds?: Id<"events">[];
  },
): Promise<{ events: Doc<"events">[]; truncated: boolean }> {
  if (args.eventIds) {
    const events: Doc<"events">[] = [];
    for (const eventId of args.eventIds) {
      const event = await ctx.db.get(eventId);
      if (
        event &&
        event.orgId === args.orgId &&
        isYellow2McpSmokeEvent(event, args.caseName)
      ) {
        events.push(event);
      }
    }
    return { events, truncated: false };
  }

  const prefix = yellow2McpSmokeSourceDeliveryPrefix(args.caseName);
  const upperBound = nextAsciiPrefix(prefix);
  const candidates = await ctx.db
    .query("events")
    .withIndex("by_org_source_via_delivery", (q) =>
      q
        .eq("orgId", args.orgId)
        .eq("source", "custom")
        .eq("via", "api")
        .gte("sourceDeliveryId", prefix)
        .lt("sourceDeliveryId", upperBound),
    )
    .take(YELLOW2_MCP_SMOKE_EVENT_SCAN_LIMIT + 1);
  const truncated = candidates.length > YELLOW2_MCP_SMOKE_EVENT_SCAN_LIMIT;
  const events = candidates
    .slice(0, YELLOW2_MCP_SMOKE_EVENT_SCAN_LIMIT)
    .filter((event) => isYellow2McpSmokeEvent(event, args.caseName));
  return { events, truncated };
}

function assertYellow2CleanupSafety(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(`Yellow2CleanupSafetyProbe: ${message}`);
  }
}

async function cleanupYellow2aMcpSmokeArtifacts(
  ctx: MutationCtx,
  args: {
    orgId: Id<"orgs">;
    caseName: string;
    apiKeyId?: Id<"apiKeys">;
    apiKeyLabel?: string;
    eventIds?: Id<"events">[];
  },
) {
  const { events, truncated: eventsTruncated } =
    await listYellow2McpSmokeEventsByCase(ctx, {
      orgId: args.orgId,
      caseName: args.caseName,
      ...(args.eventIds ? { eventIds: args.eventIds } : {}),
    });
  let deletedEvents = 0;
  for (const event of events) {
    await ctx.db.delete(event._id);
    deletedEvents += 1;
  }

  const apiKeyIds = new Set<Id<"apiKeys">>();
  if (args.apiKeyId) {
    apiKeyIds.add(args.apiKeyId);
  }
  if (args.apiKeyLabel) {
    const matchingKeys = await ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const apiKey of matchingKeys) {
      if (
        apiKey.label === args.apiKeyLabel &&
        apiKey.createdBy === YELLOW2A_DEBUG_API_KEY_CREATED_BY
      ) {
        apiKeyIds.add(apiKey._id);
      }
    }
  }

  let deletedApiKeys = 0;
  let deletedRateLimitRows = 0;
  for (const apiKeyId of apiKeyIds) {
    const apiKey = await ctx.db.get(apiKeyId);
    if (
      !apiKey ||
      apiKey.orgId !== args.orgId ||
      apiKey.createdBy !== YELLOW2A_DEBUG_API_KEY_CREATED_BY
    ) {
      continue;
    }
    const rateLimitRows = await ctx.db
      .query("mcpRateLimits")
      .withIndex("by_apiKey", (q) => q.eq("apiKeyId", apiKey._id))
      .collect();
    for (const row of rateLimitRows) {
      await ctx.db.delete(row._id);
      deletedRateLimitRows += 1;
    }
    await ctx.db.delete(apiKey._id);
    deletedApiKeys += 1;
  }

  return {
    deletedEvents,
    deletedApiKeys,
    deletedRateLimitRows,
    eventsTruncated,
  };
}

const YELLOW2_MCP_TOOL_CLASS_VALIDATOR = v.union(
  v.literal("read"),
  v.literal("write"),
  v.literal("ask"),
);

type Yellow2McpToolClass = "read" | "write" | "ask";

function getYellow2McpRateLimitWindow(
  now: number,
  toolClass: Yellow2McpToolClass,
) {
  const minute = Math.floor(now / 60_000);
  const windowStart = minute * 60_000;
  return {
    bucket: `${toolClass}:${minute}`,
    windowStart,
    resetAt: windowStart + 60_000,
  };
}

function generateYellow2aApiKeyPlaintext(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `sk_live_${base64url}`;
}

export const yellow2aCreateApiKey = internalMutation({
  args: {
    orgId: v.id("orgs"),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) {
      throw new Error(`Yellow 2A org ${args.orgId} not found`);
    }

    const createdAt = Date.now();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const plaintextKey = generateYellow2aApiKeyPlaintext();
      const keyHash = await sha256Hex(plaintextKey);
      const existing = await ctx.db
        .query("apiKeys")
        .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
        .first();
      if (existing) {
        continue;
      }

      const apiKeyId = await ctx.db.insert("apiKeys", {
        orgId: args.orgId,
        keyHash,
        keyPrefix: plaintextKey.slice(0, 16),
        label: args.label,
        createdAt,
        createdBy: YELLOW2A_DEBUG_API_KEY_CREATED_BY,
      });

      return {
        apiKeyId,
        plaintextKey,
        keyPrefix: plaintextKey.slice(0, 16),
        createdAt,
      };
    }

    throw new Error("Yellow 2A failed to generate unique API key");
  },
});

export const yellow2EnsureMcpSmokeOrg = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();

    if (existing) {
      return { orgId: existing._id, created: false };
    }

    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      plan: "debug",
      billingStatus: "debug",
    });

    return { orgId, created: true };
  },
});

export const yellow2aInspectApiKey = internalQuery({
  args: {
    apiKeyId: v.id("apiKeys"),
  },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db.get(args.apiKeyId);
    if (!apiKey) {
      return null;
    }
    return {
      apiKeyId: apiKey._id,
      orgId: apiKey.orgId,
      keyPrefix: apiKey.keyPrefix,
      label: apiKey.label,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt ?? null,
      lastUsedAt: apiKey.lastUsedAt ?? null,
    };
  },
});

export const yellow2aRevokeApiKey = internalMutation({
  args: {
    apiKeyId: v.id("apiKeys"),
  },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db.get(args.apiKeyId);
    if (!apiKey) {
      return { revoked: false, missing: true, revokedAt: null };
    }
    assertYellow2DebugApiKey(apiKey);
    if (apiKey.revokedAt) {
      return { revoked: false, missing: false, revokedAt: apiKey.revokedAt };
    }

    const revokedAt = Date.now();
    await ctx.db.patch(apiKey._id, { revokedAt });
    return { revoked: true, missing: false, revokedAt };
  },
});

export const yellow2aGetEvent = internalQuery({
  args: {
    eventId: v.id("events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) {
      return null;
    }

    const raw = getYellow2aRecord(event.raw);
    return {
      eventId: event._id,
      orgId: event.orgId,
      source: event.source,
      via: event.via,
      type: event.type,
      actor: event.actor,
      summary: event.summary,
      timestamp: event.timestamp,
      processed: event.processed ?? null,
      raw: event.raw,
      rawCaseName: typeof raw?.caseName === "string" ? raw.caseName : null,
      rawHasTool: raw ? Object.prototype.hasOwnProperty.call(raw, "tool") : false,
    };
  },
});

export const yellow2aCleanupMcpSmoke = internalMutation({
  args: {
    orgId: v.id("orgs"),
    caseName: v.string(),
    apiKeyId: v.optional(v.id("apiKeys")),
    apiKeyLabel: v.optional(v.string()),
    eventIds: v.optional(v.array(v.id("events"))),
  },
  handler: async (ctx, args) => {
    return await cleanupYellow2aMcpSmokeArtifacts(ctx, args);
  },
});

export const yellow2aProbeCleanupSafety = internalMutation({
  args: {
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const caseName = `${args.caseName}-${now}`;
    const debugLabel = `Yellow 2 cleanup safety debug ${caseName}`;
    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: `debug:yellow2-cleanup-safety:${caseName}`,
      name: `Yellow 2 cleanup safety ${caseName}`,
      plan: "debug",
      billingStatus: "debug",
    });
    const debugApiKeyId = await ctx.db.insert("apiKeys", {
      orgId,
      keyHash: `debug-cleanup-safety-debug:${caseName}`,
      keyPrefix: "debug_cleanup",
      label: debugLabel,
      createdAt: now,
      createdBy: YELLOW2A_DEBUG_API_KEY_CREATED_BY,
    });
    const nonDebugApiKeyId = await ctx.db.insert("apiKeys", {
      orgId,
      keyHash: `debug-cleanup-safety-real:${caseName}`,
      keyPrefix: "real_cleanup",
      label: `Real key with same cleanup case ${caseName}`,
      createdAt: now,
      createdBy: "user:cleanup-safety",
    });
    const debugRateLimitId = await ctx.db.insert("mcpRateLimits", {
      orgId,
      apiKeyId: debugApiKeyId,
      bucket: `read:${caseName}`,
      toolClass: "read",
      count: 1,
      windowStart: now,
      updatedAt: now,
    });
    const nonDebugRateLimitId = await ctx.db.insert("mcpRateLimits", {
      orgId,
      apiKeyId: nonDebugApiKeyId,
      bucket: `read:${caseName}`,
      toolClass: "read",
      count: 1,
      windowStart: now,
      updatedAt: now,
    });
    const smokeEventId = await ctx.db.insert("events", {
      orgId,
      source: "custom",
      via: "api",
      type: "yellow2a_mcp_http_smoke",
      actor: "yellow2a",
      summary: `Yellow 2 cleanup safety smoke ${caseName}`,
      timestamp: now,
      sourceDeliveryId: yellow2McpSmokeSourceDeliveryId(
        caseName,
        "cleanup-safety-smoke",
      ),
      raw: { caseName, probe: "yellow2aProbeCleanupSafety", role: "smoke" },
      processed: false,
    });
    const nonSmokeEventId = await ctx.db.insert("events", {
      orgId,
      source: "custom",
      via: "api",
      type: "customer_real_event",
      actor: "customer-user",
      summary: `Real event sharing cleanup case ${caseName}`,
      timestamp: now,
      raw: { caseName, role: "not-smoke" },
      processed: false,
    });

    const cleanup = await cleanupYellow2aMcpSmokeArtifacts(ctx, {
      orgId,
      caseName,
      apiKeyId: nonDebugApiKeyId,
      apiKeyLabel: debugLabel,
    });

    const debugApiKey = await ctx.db.get(debugApiKeyId);
    const nonDebugApiKey = await ctx.db.get(nonDebugApiKeyId);
    const debugRateLimit = await ctx.db.get(debugRateLimitId);
    const nonDebugRateLimit = await ctx.db.get(nonDebugRateLimitId);
    const smokeEvent = await ctx.db.get(smokeEventId);
    const nonSmokeEvent = await ctx.db.get(nonSmokeEventId);

    assertYellow2CleanupSafety(
      cleanup.deletedApiKeys === 1,
      `expected one debug API key deletion, got ${cleanup.deletedApiKeys}`,
    );
    assertYellow2CleanupSafety(
      cleanup.deletedRateLimitRows === 1,
      `expected one debug rate-limit deletion, got ${cleanup.deletedRateLimitRows}`,
    );
    assertYellow2CleanupSafety(
      cleanup.deletedEvents === 1,
      `expected one smoke event deletion, got ${cleanup.deletedEvents}`,
    );
    assertYellow2CleanupSafety(!debugApiKey, "debug API key was retained");
    assertYellow2CleanupSafety(nonDebugApiKey, "non-debug API key was deleted");
    assertYellow2CleanupSafety(!debugRateLimit, "debug rate-limit row was retained");
    assertYellow2CleanupSafety(nonDebugRateLimit, "non-debug rate-limit row was deleted");
    assertYellow2CleanupSafety(!smokeEvent, "smoke event was retained");
    assertYellow2CleanupSafety(nonSmokeEvent, "non-smoke event was deleted");

    await ctx.db.delete(nonDebugRateLimitId);
    await ctx.db.delete(nonDebugApiKeyId);
    await ctx.db.delete(nonSmokeEventId);
    await ctx.db.delete(orgId);

    return {
      ok: true,
      caseName,
      cleanup,
    };
  },
});

export const yellow2c1SeedMcpRateLimit = internalMutation({
  args: {
    orgId: v.id("orgs"),
    apiKeyId: v.id("apiKeys"),
    toolClass: YELLOW2_MCP_TOOL_CLASS_VALIDATOR,
    count: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db.get(args.apiKeyId);
    assertYellow2DebugApiKey(apiKey, args.orgId);
    validateYellow2RateLimitSeedCount(args.count);

    const now = args.now ?? Date.now();
    if (!Number.isFinite(now)) {
      throw new Error("Yellow 2C1 now must be finite");
    }
    const { bucket, windowStart, resetAt } = getYellow2McpRateLimitWindow(
      now,
      args.toolClass,
    );
    const existing = await ctx.db
      .query("mcpRateLimits")
      .withIndex("by_apiKey_bucket", (q) =>
        q.eq("apiKeyId", args.apiKeyId).eq("bucket", bucket),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        orgId: args.orgId,
        toolClass: args.toolClass,
        count: args.count,
        windowStart,
        updatedAt: now,
      });
      return {
        rateLimitId: existing._id,
        bucket,
        count: args.count,
        windowStart,
        resetAt,
      };
    }

    const rateLimitId = await ctx.db.insert("mcpRateLimits", {
      orgId: args.orgId,
      apiKeyId: args.apiKeyId,
      bucket,
      toolClass: args.toolClass,
      count: args.count,
      windowStart,
      updatedAt: now,
    });

    return { rateLimitId, bucket, count: args.count, windowStart, resetAt };
  },
});

export const yellow2c1InspectMcpRateLimit = internalQuery({
  args: {
    apiKeyId: v.id("apiKeys"),
    toolClass: YELLOW2_MCP_TOOL_CLASS_VALIDATOR,
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const { bucket, windowStart, resetAt } = getYellow2McpRateLimitWindow(
      now,
      args.toolClass,
    );
    const row = await ctx.db
      .query("mcpRateLimits")
      .withIndex("by_apiKey_bucket", (q) =>
        q.eq("apiKeyId", args.apiKeyId).eq("bucket", bucket),
      )
      .first();

    return row
      ? {
          rateLimitId: row._id,
          orgId: row.orgId,
          apiKeyId: row.apiKeyId,
          bucket: row.bucket,
          toolClass: row.toolClass,
          count: row.count,
          windowStart: row.windowStart,
          resetAt,
          updatedAt: row.updatedAt,
        }
      : {
          rateLimitId: null,
          apiKeyId: args.apiKeyId,
          bucket,
          toolClass: args.toolClass,
          count: 0,
          windowStart,
          resetAt,
          updatedAt: null,
        };
  },
});

export const yellow2c1CountEventsByCase = internalQuery({
  args: {
    orgId: v.id("orgs"),
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const { events, truncated } = await listYellow2McpSmokeEventsByCase(ctx, {
      orgId: args.orgId,
      caseName: args.caseName,
    });

    return {
      count: events.length,
      truncated,
      eventIds: events.map((event) => event._id),
    };
  },
});

export const githubWebhookIdempotencyEnsureOrg = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    webhookSecret: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        plan: "debug",
        billingStatus: "debug",
      });
      return { orgId: existing._id, created: false };
    }

    const orgId = await ctx.db.insert("orgs", {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      plan: "debug",
      billingStatus: "debug",
    });

    return { orgId, created: true };
  },
});

export const githubWebhookIdempotencyInspectEvents = internalQuery({
  args: {
    orgId: v.id("orgs"),
    caseName: v.string(),
    sourceDeliveryId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sourceDeliveryId = args.sourceDeliveryId?.trim();
    const candidates = sourceDeliveryId
      ? await ctx.db
          .query("events")
          .withIndex("by_org_source_via_delivery", (q) =>
            q
              .eq("orgId", args.orgId)
              .eq("source", "github")
              .eq("via", "webhook")
              .eq("sourceDeliveryId", sourceDeliveryId),
          )
          .collect()
      : await ctx.db
          .query("events")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect();

    const matching = candidates.filter((event) => {
      const raw = getYellow2aRecord(event.raw);
      return (
        event.source === "github" &&
        event.via === "webhook" &&
        raw?.caseName === args.caseName &&
        (!sourceDeliveryId || event.sourceDeliveryId === sourceDeliveryId)
      );
    });

    return {
      count: matching.length,
      eventIds: matching.map((event) => event._id),
      events: matching.map((event) => ({
        eventId: event._id,
        sourceDeliveryId: event.sourceDeliveryId ?? null,
        type: event.type,
        summary: event.summary,
        timestamp: event.timestamp,
      })),
    };
  },
});

export const githubWebhookIdempotencyCleanup = internalMutation({
  args: {
    orgId: v.id("orgs"),
    caseName: v.string(),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    let deletedEvents = 0;
    for (const event of events) {
      const raw = getYellow2aRecord(event.raw);
      if (
        event.source === "github" &&
        event.via === "webhook" &&
        raw?.caseName === args.caseName
      ) {
        await ctx.db.delete(event._id);
        deletedEvents += 1;
      }
    }

    return { deletedEvents };
  },
});

export const seedSearchBaselineFixture = internalMutation({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    const fixturePages = getSearchBaselineFixture(args.fixture);

    let org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", BASELINE_CLERK_ORG_ID))
      .first();
    if (!org) {
      const orgId = await ctx.db.insert("orgs", {
        clerkOrgId: BASELINE_CLERK_ORG_ID,
        name: BASELINE_ORG_NAME,
      });
      org = await ctx.db.get(orgId);
    }
    if (!org) {
      throw new Error("Failed to create baseline eval org");
    }
    if (org.name !== BASELINE_ORG_NAME) {
      await ctx.db.patch(org._id, { name: BASELINE_ORG_NAME });
    }

    const knowledgeBases = await ctx.db
      .query("knowledgeBases")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    if (knowledgeBases.length > 1) {
      throw new Error(
        `Baseline eval org ${BASELINE_CLERK_ORG_ID} has ${knowledgeBases.length} knowledge bases; expected 1`,
      );
    }

    let knowledgeBase = knowledgeBases[0] ?? null;
    if (!knowledgeBase) {
      const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
        orgId: org._id,
        name: "Baseline Eval Knowledge Base",
        description: "Deterministic search baseline fixture for Phase 2 Part 6.",
        pageCount: 0,
        sourceCount: 0,
        createdAt: BASELINE_TIMESTAMP,
      });
      const createdKnowledgeBase = await ctx.db.get(knowledgeBaseId);
      if (!createdKnowledgeBase) {
        throw new Error("Failed to create baseline knowledge base");
      }
      knowledgeBase = createdKnowledgeBase;
    }
    if (!knowledgeBase) {
      throw new Error("Failed to create baseline knowledge base");
    }

    const expectedPageSlugs = new Set(fixturePages.map((spec) => spec.slug));
    const expectedSourceHashes = new Set(
      await Promise.all(
        fixturePages.map((spec) =>
          sha256Hex(
            `${args.fixture}:${spec.slug}:${spec.contextPrefix}:${spec.sourceContent}`,
          ),
        ),
      ),
    );
    await reconcileSearchBaselineFixtureRows(ctx, {
      knowledgeBaseId: knowledgeBase._id,
      expectedPageSlugs,
      expectedSourceHashes,
    });

    const pageIdBySlug = new Map<string, Id<"knowledgePages">>();
    const sourceIdBySlug = new Map<string, Id<"sources">>();
    const chunkIdBySlug = new Map<string, Id<"sourceChunks">>();
    const ragSeeds: BaselineRagSeed[] = [];

    for (const spec of fixturePages) {
      const pagePatch = {
        knowledgeBaseId: knowledgeBase._id,
        type: spec.type,
        title: spec.title,
        slug: spec.slug,
        compiledTruth: spec.compiledTruth,
        evidenceTimeline: [
          {
            source: spec.title,
            channel: BASELINE_CHANNEL,
            timestamp: BASELINE_TIMESTAMP,
            content: spec.attributionExcerpt,
          },
        ],
        entity: spec.entity,
        tags: dedupeStrings([BASELINE_TAG, ...spec.tags]),
        confidence: spec.confidence,
        lastConfirmed: BASELINE_TIMESTAMP,
        sourceCount: 1,
        status: "active" as const,
        createdBy: BASELINE_CREATED_BY,
        updatedAt: BASELINE_TIMESTAMP,
        ...(spec.session
          ? {
              actor: spec.session.actor,
              repo: spec.session.repo,
              sessionStartTime: spec.session.startTime,
              sessionEndTime: spec.session.endTime,
              eventCount: spec.session.eventCount,
              workType: spec.session.workType,
              complexity: spec.session.complexity,
              skills: spec.session.skills,
              knowledgeBridgeStatus: "completed" as const,
              knowledgeBridgeAttemptedAt: BASELINE_TIMESTAMP,
              knowledgeBridgeCompletedAt: BASELINE_TIMESTAMP,
              knowledgePageIds: [] as Id<"knowledgePages">[],
            }
          : {}),
      };

      const existingPage = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) => q.eq("orgId", org._id).eq("slug", spec.slug))
        .first();
      let pageId = existingPage?._id ?? null;
      if (!existingPage) {
        pageId = await ctx.db.insert("knowledgePages", {
          orgId: org._id,
          createdAt: BASELINE_TIMESTAMP,
          ...pagePatch,
        });
      } else {
        await ctx.db.patch(existingPage._id, pagePatch);
      }
      if (!pageId) {
        throw new Error(`Failed to upsert baseline page ${spec.slug}`);
      }
      pageIdBySlug.set(spec.slug, pageId);

      const sourceContentHash = await sha256Hex(
        `${args.fixture}:${spec.slug}:${spec.contextPrefix}:${spec.sourceContent}`,
      );
      const existingSource = await ctx.db
        .query("sources")
        .withIndex("by_hash", (q) => q.eq("orgId", org._id).eq("contentHash", sourceContentHash))
        .first();
      let sourceId = existingSource?._id ?? null;
      const sourcePatch = {
        knowledgeBaseId: knowledgeBase._id,
        title: spec.title,
        sourceType: spec.sourceType,
        content: spec.sourceContent,
        contentHash: sourceContentHash,
        status: "processed" as const,
      };
      if (!existingSource) {
        sourceId = await ctx.db.insert("sources", {
          orgId: org._id,
          createdAt: BASELINE_TIMESTAMP,
          ...sourcePatch,
        });
      } else {
        await ctx.db.patch(existingSource._id, sourcePatch);
      }
      if (!sourceId) {
        throw new Error(`Failed to upsert baseline source ${spec.slug}`);
      }
      sourceIdBySlug.set(spec.slug, sourceId);

      const existingChunk = await ctx.db
        .query("sourceChunks")
        .withIndex("by_source", (q) => q.eq("sourceId", sourceId).eq("chunkIndex", 0))
        .first();
      const chunkPatch = {
        orgId: org._id,
        content: spec.sourceContent,
        contextPrefix: spec.contextPrefix,
        searchableText: sourceChunkSearchableText(
          spec.sourceContent,
          spec.contextPrefix,
        ),
        tokenCount: tokenCountForFixture(spec.sourceContent),
      };
      let chunkId = existingChunk?._id ?? null;
      if (!existingChunk) {
        chunkId = await ctx.db.insert("sourceChunks", {
          sourceId,
          chunkIndex: 0,
          ...chunkPatch,
        });
      } else {
        await ctx.db.patch(existingChunk._id, chunkPatch);
      }
      if (!chunkId) {
        throw new Error(`Failed to upsert baseline chunk ${spec.slug}`);
      }
      chunkIdBySlug.set(spec.slug, chunkId);

      const sourceChunks = await ctx.db
        .query("sourceChunks")
        .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
        .collect();
      const deletedChunkAttributionIds = new Set<Id<"sourceAttributions">>();
      for (const sourceChunk of sourceChunks) {
        if (sourceChunk._id !== chunkId) {
          await deleteSearchBaselineChunkGraph(
            ctx,
            sourceChunk,
            deletedChunkAttributionIds,
          );
        }
      }

      const attributions = await ctx.db
        .query("sourceAttributions")
        .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
        .collect();
      let matchingAttribution: Doc<"sourceAttributions"> | null = null;
      for (const attribution of attributions) {
        if (
          attribution.pageId === pageId &&
          attribution.chunkId === chunkId &&
          !matchingAttribution
        ) {
          matchingAttribution = attribution;
          continue;
        }
        await ctx.db.delete(attribution._id);
      }
      if (!matchingAttribution) {
        await ctx.db.insert("sourceAttributions", {
          pageId,
          sourceId,
          chunkId,
          orgId: org._id,
          excerpt: spec.attributionExcerpt,
          createdAt: BASELINE_TIMESTAMP,
        });
      } else if (matchingAttribution.excerpt !== spec.attributionExcerpt) {
        await ctx.db.patch(matchingAttribution._id, {
          excerpt: spec.attributionExcerpt,
        });
      }

      const ragText = `${spec.contextPrefix}\n\n${spec.sourceContent}`;
      ragSeeds.push({
        slug: spec.slug,
        sourceId,
        chunkIndex: 0,
        title: spec.title,
        sourceType: spec.sourceType,
        ragText,
        contentHash: await sha256Hex(ragText),
      });
    }

    const slugByPageId = new Map(
      Array.from(pageIdBySlug.entries()).map(([slug, pageId]) => [pageId, slug]),
    );
    const expectedReferenceKeys = new Set(
      fixturePages.flatMap((spec) =>
        (spec.references ?? []).map((reference) => {
          const fromPageId = pageIdBySlug.get(spec.slug);
          const toPageId = pageIdBySlug.get(reference.targetSlug);
          return `${fromPageId}:${toPageId}:${reference.referenceType}`;
        }),
      ),
    );

    for (const spec of fixturePages) {
      const fromPageId = pageIdBySlug.get(spec.slug);
      if (!fromPageId) {
        continue;
      }
      const existingReferences = await ctx.db
        .query("references")
        .withIndex("by_from", (q) => q.eq("fromPageId", fromPageId))
        .collect();
      const keptReferenceKeys = new Set<string>();
      for (const reference of existingReferences) {
        const referenceKey = `${reference.fromPageId}:${reference.toPageId}:${reference.referenceType}`;
        const targetSlug = slugByPageId.get(reference.toPageId);
        if (
          !targetSlug ||
          !expectedReferenceKeys.has(referenceKey) ||
          keptReferenceKeys.has(referenceKey)
        ) {
          await ctx.db.delete(reference._id);
          continue;
        }
        keptReferenceKeys.add(referenceKey);
      }

      for (const reference of spec.references ?? []) {
        const toPageId = pageIdBySlug.get(reference.targetSlug);
        if (!toPageId) {
          throw new Error(
            `Reference target ${reference.targetSlug} missing for baseline page ${spec.slug}`,
          );
        }
        const matchingReferences = await ctx.db
          .query("references")
          .withIndex("by_from", (q) =>
            q.eq("fromPageId", fromPageId).eq("referenceType", reference.referenceType),
          )
          .collect();
        const existingReference = matchingReferences.find(
          (candidate) => candidate.toPageId === toPageId,
        );
        if (!existingReference) {
          await ctx.db.insert("references", {
            orgId: org._id,
            fromPageId,
            toPageId,
            referenceType: reference.referenceType,
            context: reference.context,
            createdAt: BASELINE_TIMESTAMP,
          });
        } else if (existingReference.context !== reference.context) {
          await ctx.db.patch(existingReference._id, {
            context: reference.context,
          });
        }
      }
    }

    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_kb", (q) => q.eq("knowledgeBaseId", knowledgeBase._id))
      .collect();
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_kb", (q) => q.eq("knowledgeBaseId", knowledgeBase._id))
      .collect();
    const chunks = (
      await Promise.all(
        sources.map((source) =>
          ctx.db
            .query("sourceChunks")
            .withIndex("by_source", (q) => q.eq("sourceId", source._id))
            .collect(),
        ),
      )
    ).flat();
    const attributions = (
      await Promise.all(
        sources.map((source) =>
          ctx.db
            .query("sourceAttributions")
            .withIndex("by_source", (q) => q.eq("sourceId", source._id))
            .collect(),
        ),
      )
    ).flat();
    const references = (
      await Promise.all(
        pages.map((page) =>
          ctx.db
            .query("references")
            .withIndex("by_from", (q) => q.eq("fromPageId", page._id))
            .collect(),
        ),
      )
    ).flat();

    const unexpectedPages = pages.filter((page) => !expectedPageSlugs.has(page.slug));
    if (unexpectedPages.length > 0) {
      throw new Error(
        `Baseline knowledge base contains unexpected pages: ${unexpectedPages
          .map((page) => page.slug)
          .join(", ")}`,
      );
    }
    if (pages.length !== fixturePages.length) {
      throw new Error(
        `Baseline knowledge base has ${pages.length} pages; expected ${fixturePages.length}`,
      );
    }
    const unexpectedSources = sources.filter(
      (source) => !source.contentHash || !expectedSourceHashes.has(source.contentHash),
    );
    if (unexpectedSources.length > 0) {
      throw new Error(
        `Baseline knowledge base contains unexpected sources: ${unexpectedSources
          .map((source) => source.title)
          .join(", ")}`,
      );
    }
    if (sources.length !== fixturePages.length) {
      throw new Error(
        `Baseline knowledge base has ${sources.length} sources; expected ${fixturePages.length}`,
      );
    }
    const expectedSourceIds = new Set(Array.from(sourceIdBySlug.values()));
    const malformedChunks = chunks.filter(
      (chunk) => chunk.chunkIndex !== 0 || !expectedSourceIds.has(chunk.sourceId),
    );
    if (malformedChunks.length > 0) {
      throw new Error(
        `Baseline knowledge base contains unexpected chunks: ${malformedChunks.length}`,
      );
    }
    if (chunks.length !== fixturePages.length) {
      throw new Error(
        `Baseline knowledge base has ${chunks.length} chunks; expected ${fixturePages.length}`,
      );
    }
    const expectedAttributionKeys = new Set(
      fixturePages.map((spec) => {
        const pageId = pageIdBySlug.get(spec.slug);
        const sourceId = sourceIdBySlug.get(spec.slug);
        const chunkId = chunkIdBySlug.get(spec.slug);
        return `${pageId}:${sourceId}:${chunkId}`;
      }),
    );
    const unexpectedAttributions = attributions.filter(
      (attribution) =>
        !expectedAttributionKeys.has(
          `${attribution.pageId}:${attribution.sourceId}:${attribution.chunkId ?? ""}`,
        ),
    );
    if (unexpectedAttributions.length > 0) {
      throw new Error(
        `Baseline knowledge base contains unexpected source attributions: ${unexpectedAttributions.length}`,
      );
    }
    if (attributions.length !== expectedAttributionKeys.size) {
      throw new Error(
        `Baseline knowledge base has ${attributions.length} source attributions; expected ${expectedAttributionKeys.size}`,
      );
    }
    const unexpectedReferences = references.filter(
      (reference) =>
        !expectedReferenceKeys.has(
          `${reference.fromPageId}:${reference.toPageId}:${reference.referenceType}`,
        ),
    );
    if (unexpectedReferences.length > 0) {
      throw new Error(
        `Baseline knowledge base contains unexpected references: ${unexpectedReferences.length}`,
      );
    }
    if (references.length !== expectedReferenceKeys.size) {
      throw new Error(
        `Baseline knowledge base has ${references.length} references; expected ${expectedReferenceKeys.size}`,
      );
    }

    await ctx.db.patch(knowledgeBase._id, {
      name: "Baseline Eval Knowledge Base",
      description: "Deterministic search baseline fixture for Phase 2 Part 6.",
      pageCount: fixturePages.length,
      sourceCount: fixturePages.length,
      lastIngestAt: BASELINE_TIMESTAMP,
    });

    return {
      orgId: org._id,
      knowledgeBaseId: knowledgeBase._id,
      ragSeeds,
      corpus: {
        pageCount: pages.length,
        sourceCount: sources.length,
        chunkCount: chunks.length,
        attributionCount: attributions.length,
        referenceCount: references.length,
        sessionPageCount: pages.filter((page) => page.type === "session").length,
      },
    };
  },
});

export const runSearchBaseline = internalAction({
  args: {
    fixture: v.string(),
    queries: v.array(BASELINE_QUERY_VALIDATOR),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    getSearchBaselineFixture(args.fixture);

    if (!process.env.COHERE_API_KEY) {
      throw new Error("CONFIG: COHERE_API_KEY is not configured for local Convex runtime");
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("CONFIG: OPENAI_API_KEY is not configured for local Convex runtime");
    }

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 10);
    const seeded = (await ctx.runMutation(baselineSeedFixtureRef, {
      fixture: args.fixture,
    })) as BaselineSeedFixtureResult;

    let ragEntriesCreated = 0;
    for (const seed of seeded.ragSeeds) {
      const ragResult = await rag.add(ctx, {
        namespace: seeded.orgId,
        chunks: [{ text: seed.ragText }],
        key: `${seed.sourceId}:${seed.chunkIndex}`,
        contentHash: seed.contentHash,
        title: seed.title,
        filterValues: [{ name: "sourceType", value: seed.sourceType }],
      });
      if (ragResult.created) {
        ragEntriesCreated += 1;
      }
    }

    const bm25Probe = (await ctx.runQuery(internal.search.bm25ChunkSearch, {
      orgId: seeded.orgId,
      query: BASELINE_BM25_PROBE_QUERY,
      limit: 5,
    })) as Array<{ chunkId: Id<"sourceChunks">; score: number }>;
    if (bm25Probe.length === 0) {
      throw new Error(
        `Preflight failed: BM25 chunk search returned no results for "${BASELINE_BM25_PROBE_QUERY}"`,
      );
    }

    const vectorProbe = await rag.search(ctx, {
      namespace: seeded.orgId,
      query: BASELINE_VECTOR_PROBE_QUERY,
      limit: 5,
      filters: [],
    });
    if (vectorProbe.results.length === 0) {
      throw new Error(
        `Preflight failed: vector search returned no results for "${BASELINE_VECTOR_PROBE_QUERY}"`,
      );
    }

    const firstPositiveQuery = args.queries.find((query) => query.category !== "E");
    if (!firstPositiveQuery) {
      throw new Error("Baseline requires at least one non-negative probe query");
    }

    const firstDeepProbe = (await ctx.runAction(internal.search.deepSearch, {
      orgId: seeded.orgId,
      query: firstPositiveQuery.query,
      limit,
    })) as BaselineDeepSearchResponse;

    const baselineResults: BaselineSearchResult[] = [];
    for (const query of args.queries) {
      const pageIds = new Set<Id<"knowledgePages">>();
      let liveSearch:
        | {
            results: Array<{
              _id: Id<"knowledgePages">;
              title: string;
              slug: string | null;
              type: Doc<"knowledgePages">["type"];
              snippet: string;
              score: number;
            }>;
            error: string | null;
          }
        | undefined;
      let deepSearch:
        | {
            results: Array<{
              pageId: Id<"knowledgePages">;
              title: string;
              slug: string | null;
              type: Doc<"knowledgePages">["type"];
              compiledTruth: string;
              relevanceScore: number;
              sourceChunkIds: Id<"sourceChunks">[];
              highlights: string[];
            }>;
            meta: {
              bm25Count: number;
              vectorCount: number;
              fusedCount: number;
              rerankedCount: number;
              cohereSearchUnits: number;
            } | null;
            error: string | null;
          }
        | undefined;

      try {
        const rawLiveResults = (await ctx.runQuery(internal.search.liveSearch, {
          orgId: seeded.orgId,
          query: query.query,
          limit,
        })) as Omit<BaselineLiveSearchResult, "slug">[];
        for (const result of rawLiveResults) {
          pageIds.add(result._id);
        }
        liveSearch = {
          results: rawLiveResults.map((result) => ({
            ...result,
            slug: null,
          })),
          error: null,
        };
      } catch (error) {
        liveSearch = {
          results: [],
          error: getErrorMessage(error),
        };
      }

      try {
        const rawDeepResult: BaselineDeepSearchResponse =
          query.id === firstPositiveQuery.id
            ? firstDeepProbe
            : ((await ctx.runAction(internal.search.deepSearch, {
                orgId: seeded.orgId,
                query: query.query,
                limit,
              })) as BaselineDeepSearchResponse);
        for (const result of rawDeepResult.results) {
          pageIds.add(result.pageId);
        }
        deepSearch = {
          results: rawDeepResult.results.map((result) => ({
            ...result,
            slug: null,
          })),
          meta: rawDeepResult.meta,
          error: null,
        };
      } catch (error) {
        deepSearch = {
          results: [],
          meta: null,
          error: getErrorMessage(error),
        };
      }

      const pages: Array<Doc<"knowledgePages"> | null> = pageIds.size
        ? ((await ctx.runQuery(internal.search.getPagesByIds, {
            pageIds: Array.from(pageIds),
          })) as Array<Doc<"knowledgePages"> | null>)
        : [];
      const pageById = new Map(
        pages
          .filter((page): page is Doc<"knowledgePages"> => page !== null)
          .map((page) => [page._id, page]),
      );

      baselineResults.push({
        id: query.id,
        category: query.category,
        query: query.query,
        liveSearch: liveSearch
          ? {
              ...liveSearch,
              results: sortLiveResults(
                liveSearch.results.map((result) => ({
                  ...result,
                  slug: pageById.get(result._id)?.slug ?? null,
                })),
              ),
            }
          : { results: [], error: "live search did not run" },
        deepSearch: deepSearch
          ? {
              ...deepSearch,
              results: sortDeepResults(
                deepSearch.results.map((result) => ({
                  ...result,
                  slug: pageById.get(result.pageId)?.slug ?? null,
                })),
              ),
            }
          : { results: [], meta: null, error: "deep search did not run" },
      });
    }

    const cohereSearchUnits = baselineResults.reduce((total, result) => {
      return total + (result.deepSearch.meta?.cohereSearchUnits ?? 0);
    }, 0);
    const warnings: string[] = [];
    const failedQueries = collectBaselineSearchFailures(baselineResults);
    if (failedQueries.length > 0) {
      console.warn("spark:search-baseline-query-failures", {
        fixture: args.fixture,
        failedQueries,
      });
      const failureLabels = failedQueries.map(
        (failure) => `${failure.id}:${failure.surface}`,
      );
      throw new Error(
        `Search baseline failed query execution for ${failureLabels.join(", ")}`,
      );
    }
    if (cohereSearchUnits > 30) {
      warnings.push(
        `Cohere search units exceeded the guardrail: ${cohereSearchUnits} > 30`,
      );
    }
    const hardNegativeAlerts = baselineResults
      .filter((result) => result.category === "E")
      .filter((result) =>
        (result.deepSearch.results[0]?.relevanceScore ?? 0) >=
        BASELINE_HARD_NEGATIVE_THRESHOLD,
      )
      .map((result) => result.id);
    if (hardNegativeAlerts.length > 0) {
      warnings.push(
        `Deep search returned high-score hard negatives for: ${hardNegativeAlerts.join(", ")}`,
      );
    }

    return {
      fixture: args.fixture,
      org: {
        id: seeded.orgId,
        clerkOrgId: BASELINE_CLERK_ORG_ID,
        name: BASELINE_ORG_NAME,
        knowledgeBaseId: seeded.knowledgeBaseId,
      },
      corpus: seeded.corpus,
      seeding: {
        ragEntriesCreated,
        ragEntriesRequested: seeded.ragSeeds.length,
      },
      preflight: {
        bm25ProbeQuery: BASELINE_BM25_PROBE_QUERY,
        bm25ProbeCount: bm25Probe.length,
        vectorProbeQuery: BASELINE_VECTOR_PROBE_QUERY,
        vectorProbeCount: vectorProbe.results.length,
        deepProbeQueryId: firstPositiveQuery.id,
        hardNegativeThreshold: BASELINE_HARD_NEGATIVE_THRESHOLD,
      },
      warnings,
      cohereSearchUnits,
      queries: baselineResults,
    };
  },
});

const P7_PERIOD_VALIDATOR = v.union(
  v.literal("daily"),
  v.literal("weekly"),
  v.literal("monthly"),
);
const P7_SYNTHESIS_FAILURE_KIND_VALIDATOR = v.union(
  v.literal("fatal"),
  v.literal("transient_exhausted"),
  v.literal("unexpected"),
);
const P7_SYNTHESIS_FAILED_MAX_RETRIES = 3;
const P7_REPAIR_VALIDATOR = v.union(
  v.literal("add_attribution"),
  v.literal("add_inbound_reference"),
  v.literal("confirm_decision"),
);
const P7_FINDING_STATUS_VALIDATOR = v.union(
  v.literal("new"),
  v.literal("acknowledged"),
  v.literal("investigating"),
  v.literal("resolved"),
  v.literal("dismissed"),
);
const P7_FIXTURE = "phase2-part7-v1";
const P7_CLERK_ORG_ID = "part7-linter-synth-v1";
const P7_ORG_NAME = "Part 7 Linter Synth Eval";
const P7_KB_NAME = "Part 7 Linter Synth Knowledge Base";
const P7_KB_DESCRIPTION =
  "Deterministic fixture for Phase 2 Part 7 linter and synthesis probes.";
const P7_CREATED_BY = "debug:p7SeedLinterSynthFixture";
const P7_SOURCE_CHANNEL = "eval-fixture";
const P7_FIXTURE_TAG = "fixture:phase2-part7-v1";
const P7_DAILY_TIMESTAMP = Date.UTC(2025, 4, 6, 0, 0, 0, 0);
const P7_DAILY_WINDOW_END = P7_DAILY_TIMESTAMP + 24 * 60 * 60 * 1000;
const P7_NO_ACTIVITY_CLERK_ORG_ID = "part7-synth-no-activity-v1";
const P7_NO_ACTIVITY_ORG_NAME = "Part 7 Synth No Activity";
const P7_SYNTHESIS_PAGINATION_CLERK_PREFIX = "part7-synth-pagination-";
const P7_SYNTHESIS_PAGINATION_ORG_COUNT = 1001;
const P7_SYNTHESIS_PAGINATION_BATCH_SIZE = 100;
const P7_SYNTHESIS_PAGINATION_TARGET_ORDINAL = 1001;
const P7_STALE_DECISION_LAST_CONFIRMED = Date.UTC(2025, 1, 18, 17, 0, 0, 0);
const P7_GOAL_TARGET_DATE = Date.UTC(2025, 5, 30, 0, 0, 0, 0);
const P7_GOAL_SLUG = "part7-goal-checkout-reliability";
const P7_FRESH_DECISION_SLUG = "part7-decision-checkout-guardrails";
const P7_STALE_DECISION_SLUG = "part7-decision-retire-legacy-sync";
const P7_SESSION_ONE_SLUG = "part7-session-checkout-latency";
const P7_SESSION_TWO_SLUG = "part7-session-release-readiness";
const P7_ORPHAN_PAGE_SLUG = "part7-orphan-rollout-notes";
const P7_WEAK_PROVENANCE_SLUG = "part7-weak-provenance-incident-handoff";
const P7_FINDING_SLUG = "part7-finding-alert-fatigue";
const P7_LINTER_FINDING_PREFIX = "finding-linter-";
const P7_LINTER_PROBE_NOW = P7_DAILY_WINDOW_END + 24 * 60 * 60 * 1000 + 1000;
const P7_AI_FIXTURE = "phase2-part7-v2";
const P7_AI_CLERK_ORG_ID = "part7-ai-contradiction-v2";
const P7_AI_ORG_NAME = "Part 7 AI Contradiction Eval";
const P7_AI_KB_NAME = "Part 7 AI Contradiction Knowledge Base";
const P7_AI_KB_DESCRIPTION =
  "Isolated fixture for Phase 2 Part 7d2 AI contradiction probes.";
const P7_AI_FIXTURE_TAG = "fixture:phase2-part7-v2";
const P7_AI_CREATED_BY = "debug:p7SeedAiContradictionFixture";
const P7_AI_SOURCE_CHANNEL = "eval-fixture-ai";
const P7_AI_TIMESTAMP = Date.UTC(2026, 4, 8, 12, 0, 0, 0);
const P7_AI_PROBE_NOW = P7_AI_TIMESTAMP + 60 * 60 * 1000;
const P7E_FIXTURE = "phase2-part7e-v1";
const P7_AI_LEFT_SLUG = "part7-ai-checkout-guardrail-disabled";
const P7_AI_RIGHT_SLUG = "part7-ai-checkout-guardrail-enabled";
const P7_AI_HARD_NEGATIVE_SLUG = "part7-ai-mobile-guardrail-enabled";
const P7_AI_EXPECTED_FINDING_SLUG =
  `finding-linter-contradiction-${P7_AI_LEFT_SLUG}--${P7_AI_RIGHT_SLUG}`;
const P7_AI_UNMANAGED_FINDING_SLUG =
  "finding-linter-contradiction-preexisting-checkout-guardrail--preexisting-mobile-guardrail";

type P7Period = "daily" | "weekly" | "monthly";
type P7SynthesisDependencyReadiness = {
  ready: boolean;
  period: P7Period;
  lowerPeriod: P7Period | null;
  expectedCount: number;
  completedCount: number;
  missing: Array<{ period: P7Period; timestamp: number; windowEnd: number }>;
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
type P7Repair =
  | "add_attribution"
  | "add_inbound_reference"
  | "confirm_decision";
type P7ReferenceType =
  | "mentions"
  | "depends_on"
  | "contradicts"
  | "supersedes"
  | "part_of"
  | "related_to";
type P7FixtureReferenceSpec = {
  targetSlug: string;
  referenceType: P7ReferenceType;
  context: string;
};
type P7FixturePageSpec = {
  slug: string;
  type: Doc<"knowledgePages">["type"];
  title: string;
  compiledTruth: string;
  sourceContent: string;
  contextPrefix: string;
  attributionExcerpt: string;
  tags: string[];
  confidence: Doc<"knowledgePages">["confidence"];
  sourceType: Doc<"sources">["sourceType"];
  references?: readonly P7FixtureReferenceSpec[];
  omitAttribution?: boolean;
  lastConfirmed: number;
  createdAt: number;
  updatedAt: number;
  finding?: {
    severity: NonNullable<Doc<"knowledgePages">["severity"]>;
    findingType: NonNullable<Doc<"knowledgePages">["findingType"]>;
    findingStatus: NonNullable<Doc<"knowledgePages">["findingStatus"]>;
    implication: string;
    sourceAgent: string;
  };
  goal?: {
    owner: string;
    targetDate: number;
    goalStatus: NonNullable<Doc<"knowledgePages">["goalStatus"]>;
  };
  session?: {
    actor: string;
    repo: string;
    startTime: number;
    endTime: number;
    eventCount: number;
    workType: string;
    complexity: NonNullable<Doc<"knowledgePages">["complexity"]>;
    skills: string[];
  };
};

const P7_FIXTURE_PAGES: readonly P7FixturePageSpec[] = [
  {
    slug: P7_GOAL_SLUG,
    type: "goal",
    title: "Stabilize checkout reliability before launch",
    compiledTruth:
      "The team is actively reducing checkout regressions before the next launch window. This goal keeps rollback guardrails, incident handoff quality, and release readiness aligned around checkout reliability.",
    sourceContent:
      "Goal review notes: keep checkout reliability work focused on rollback guardrails, release readiness, and cleaner incident handoffs before the launch window.",
    contextPrefix: "Goal evidence for the May 2025 checkout reliability push.",
    attributionExcerpt:
      "Keep checkout reliability work focused on rollback guardrails, release readiness, and cleaner incident handoffs before launch.",
    tags: [P7_FIXTURE_TAG, "goal:checkout", "priority:launch"],
    confidence: "high",
    sourceType: "paste",
    lastConfirmed: P7_DAILY_WINDOW_END - 15 * 60 * 1000,
    createdAt: P7_DAILY_TIMESTAMP - 7 * 24 * 60 * 60 * 1000,
    updatedAt: P7_DAILY_WINDOW_END - 15 * 60 * 1000,
    goal: {
      owner: "Avery",
      targetDate: P7_GOAL_TARGET_DATE,
      goalStatus: "active",
    },
  },
  {
    slug: P7_FRESH_DECISION_SLUG,
    type: "decision",
    title: "Keep checkout rollback guardrails enabled",
    compiledTruth:
      "The team will keep the checkout rollback guardrail enabled until latency and error rates stay within target for seven consecutive days. This decision remains active and was reconfirmed during the current daily synthesis window.",
    sourceContent:
      "Decision log: keep the checkout rollback guardrail enabled until latency and error rates remain healthy for seven straight days.",
    contextPrefix: "Decision evidence captured during the Part 7 daily window.",
    attributionExcerpt:
      "Keep the checkout rollback guardrail enabled until latency and error rates remain healthy for seven straight days.",
    tags: [P7_FIXTURE_TAG, "decision:active", "area:checkout"],
    confidence: "high",
    sourceType: "paste",
    references: [
      {
        targetSlug: P7_GOAL_SLUG,
        referenceType: "related_to",
        context: "This decision supports the active checkout reliability goal.",
      },
    ],
    lastConfirmed: P7_DAILY_WINDOW_END - 30 * 60 * 1000,
    createdAt: P7_DAILY_TIMESTAMP - 3 * 24 * 60 * 60 * 1000,
    updatedAt: P7_DAILY_WINDOW_END - 30 * 60 * 1000,
  },
  {
    slug: P7_STALE_DECISION_SLUG,
    type: "decision",
    title: "Retire the legacy sync worker after API parity",
    compiledTruth:
      "The team planned to retire the legacy sync worker after the new API path reached parity. The page is still active, but it has not been reconfirmed in the current cycle and is the intended stale decision candidate for Part 7 lint probes.",
    sourceContent:
      "Decision log: retire the legacy sync worker after the new API path reaches parity across checkout and support workflows.",
    contextPrefix: "Older decision evidence retained for Part 7 stale-decision probes.",
    attributionExcerpt:
      "Retire the legacy sync worker after the new API path reaches parity across checkout and support workflows.",
    tags: [P7_FIXTURE_TAG, "decision:stale-candidate", "area:legacy-sync"],
    confidence: "medium",
    sourceType: "paste",
    references: [
      {
        targetSlug: P7_GOAL_SLUG,
        referenceType: "related_to",
        context: "The retirement work was originally tied to the reliability goal.",
      },
    ],
    lastConfirmed: P7_STALE_DECISION_LAST_CONFIRMED,
    createdAt: P7_STALE_DECISION_LAST_CONFIRMED,
    updatedAt: P7_STALE_DECISION_LAST_CONFIRMED,
  },
  {
    slug: P7_SESSION_ONE_SLUG,
    type: "session",
    title: "Checkout latency investigation and rollback guardrail review",
    compiledTruth:
      "Avery investigated checkout latency regressions, narrowed the issue to a cache invalidation path, and kept the rollback guardrail in place while the release checklist was tightened. The session directly supported the current checkout reliability goal.",
    sourceContent:
      "Session notes: Avery compared checkout latency before and after a cache invalidation change, kept the rollback guardrail enabled, and tightened the release checklist.",
    contextPrefix: "Session evidence from the Part 7 daily synthesis window.",
    attributionExcerpt:
      "Avery compared checkout latency before and after a cache invalidation change and tightened the release checklist.",
    tags: [P7_FIXTURE_TAG, "window:daily", "actor:avery", "repo:spark-web"],
    confidence: "high",
    sourceType: "session",
    references: [
      {
        targetSlug: P7_GOAL_SLUG,
        referenceType: "related_to",
        context: "The session contributed directly to the active reliability goal.",
      },
      {
        targetSlug: P7_FRESH_DECISION_SLUG,
        referenceType: "mentions",
        context: "The session reaffirmed the rollback guardrail decision.",
      },
    ],
    lastConfirmed: P7_DAILY_WINDOW_END - 45 * 60 * 1000,
    createdAt: P7_DAILY_TIMESTAMP + 60 * 60 * 1000,
    updatedAt: P7_DAILY_TIMESTAMP + 150 * 60 * 1000,
    session: {
      actor: "Avery",
      repo: "spark-web",
      startTime: P7_DAILY_TIMESTAMP + 60 * 60 * 1000,
      endTime: P7_DAILY_TIMESTAMP + 150 * 60 * 1000,
      eventCount: 8,
      workType: "investigation",
      complexity: "moderate",
      skills: ["nextjs", "observability", "payments"],
    },
  },
  {
    slug: P7_SESSION_TWO_SLUG,
    type: "session",
    title: "Release readiness pass for checkout and API parity",
    compiledTruth:
      "Riley reviewed release readiness across checkout and the API parity work, documented open risks, and surfaced that the legacy sync retirement decision had not been reconfirmed. The session stays inside the same daily synthesis window as the latency investigation.",
    sourceContent:
      "Session notes: Riley reviewed release readiness, checked API parity gaps, and flagged that the legacy sync retirement decision had not been reconfirmed.",
    contextPrefix: "Second session inside the same Part 7 daily synthesis window.",
    attributionExcerpt:
      "Riley reviewed release readiness, checked API parity gaps, and flagged that the legacy sync retirement decision had not been reconfirmed.",
    tags: [P7_FIXTURE_TAG, "window:daily", "actor:riley", "repo:spark-api"],
    confidence: "high",
    sourceType: "session",
    references: [
      {
        targetSlug: P7_GOAL_SLUG,
        referenceType: "related_to",
        context: "The release-readiness work supported the same goal window.",
      },
      {
        targetSlug: P7_STALE_DECISION_SLUG,
        referenceType: "mentions",
        context: "The session called out the older legacy sync retirement decision.",
      },
    ],
    lastConfirmed: P7_DAILY_WINDOW_END - 20 * 60 * 1000,
    createdAt: P7_DAILY_TIMESTAMP + 9 * 60 * 60 * 1000,
    updatedAt: P7_DAILY_TIMESTAMP + 11 * 60 * 60 * 1000,
    session: {
      actor: "Riley",
      repo: "spark-api",
      startTime: P7_DAILY_TIMESTAMP + 9 * 60 * 60 * 1000,
      endTime: P7_DAILY_TIMESTAMP + 11 * 60 * 60 * 1000,
      eventCount: 6,
      workType: "review",
      complexity: "moderate",
      skills: ["api-design", "release", "payments"],
    },
  },
  {
    slug: P7_ORPHAN_PAGE_SLUG,
    type: "fact",
    title: "Rollout notes for the support handoff",
    compiledTruth:
      "Support handoff notes captured the manual rollout checks for checkout support coverage. The page is intentionally left without inbound references so it can serve as the orphan page candidate for Part 7 lint probes.",
    sourceContent:
      "Fact notes: support handoff checklist covers manual rollout checks and customer-impact triage during checkout releases.",
    contextPrefix: "Standalone fact page retained for orphan-page probing.",
    attributionExcerpt:
      "Support handoff checklist covers manual rollout checks and customer-impact triage during checkout releases.",
    tags: [P7_FIXTURE_TAG, "lint:orphan-candidate", "area:support"],
    confidence: "medium",
    sourceType: "paste",
    lastConfirmed: P7_DAILY_TIMESTAMP + 7 * 60 * 60 * 1000,
    createdAt: P7_DAILY_TIMESTAMP + 7 * 60 * 60 * 1000,
    updatedAt: P7_DAILY_TIMESTAMP + 7 * 60 * 60 * 1000,
  },
  {
    slug: P7_WEAK_PROVENANCE_SLUG,
    type: "pattern",
    title: "Incident handoffs are still inconsistent",
    compiledTruth:
      "Incident handoffs still vary across repos and leave too much cleanup for the next person on call. This page is intentionally seeded without a durable source attribution so it can serve as the weak provenance candidate for Part 7 lint probes.",
    sourceContent:
      "Pattern notes: incident handoffs vary across repos, making on-call transitions slower and harder to verify.",
    contextPrefix: "Pattern page for weak-provenance probing in Part 7.",
    attributionExcerpt:
      "Incident handoffs vary across repos, making on-call transitions slower and harder to verify.",
    tags: [P7_FIXTURE_TAG, "lint:weak-provenance-candidate", "area:incident-response"],
    confidence: "medium",
    sourceType: "paste",
    omitAttribution: true,
    lastConfirmed: P7_DAILY_TIMESTAMP + 8 * 60 * 60 * 1000,
    createdAt: P7_DAILY_TIMESTAMP + 8 * 60 * 60 * 1000,
    updatedAt: P7_DAILY_TIMESTAMP + 8 * 60 * 60 * 1000,
  },
  {
    slug: P7_FINDING_SLUG,
    type: "finding",
    title: "Alert fatigue is masking checkout regressions",
    compiledTruth:
      "The team already has an open finding that alert fatigue is hiding meaningful checkout regressions. It points at inconsistent incident handoffs and older decisions that still influence release readiness work.",
    sourceContent:
      "Finding notes: alert fatigue is hiding checkout regressions because incident handoffs are inconsistent and older release assumptions still linger.",
    contextPrefix: "Existing finding page retained for Part 7 fixture coverage.",
    attributionExcerpt:
      "Alert fatigue is hiding checkout regressions because incident handoffs are inconsistent and older release assumptions still linger.",
    tags: [P7_FIXTURE_TAG, "finding:existing", "area:alerts"],
    confidence: "high",
    sourceType: "paste",
    references: [
      {
        targetSlug: P7_WEAK_PROVENANCE_SLUG,
        referenceType: "related_to",
        context: "The open finding is linked to the incident handoff pattern.",
      },
      {
        targetSlug: P7_STALE_DECISION_SLUG,
        referenceType: "mentions",
        context: "The finding still references the older legacy sync retirement decision.",
      },
    ],
    lastConfirmed: P7_DAILY_TIMESTAMP + 10 * 60 * 60 * 1000,
    createdAt: P7_DAILY_TIMESTAMP + 10 * 60 * 60 * 1000,
    updatedAt: P7_DAILY_TIMESTAMP + 10 * 60 * 60 * 1000,
    finding: {
      severity: "medium",
      findingType: "blind_spot",
      findingStatus: "investigating",
      implication:
        "Release and incident work still depends on incomplete handoff context.",
      sourceAgent: "linter",
    },
  },
];

const P7_AI_REPAIRED_LEFT_TRUTH =
  "The checkout rollback guardrail remains enabled for all production checkout traffic. This aligns the web rollout policy with the production checkout guardrail page.";

const P7_AI_FIXTURE_PAGES: readonly P7FixturePageSpec[] = [
  {
    slug: P7_AI_LEFT_SLUG,
    type: "decision",
    title: "Production checkout guardrail disabled",
    compiledTruth:
      "The checkout rollback guardrail is disabled for all production checkout traffic. The team should continue the production rollout without automatic rollback protection.",
    sourceContent:
      "Decision memo: the checkout rollback guardrail is disabled for all production checkout traffic, and production rollout work should proceed without automatic rollback protection.",
    contextPrefix:
      "AI contradiction fixture page asserting the production checkout guardrail is disabled.",
    attributionExcerpt:
      "The checkout rollback guardrail is disabled for all production checkout traffic.",
    tags: [
      P7_AI_FIXTURE_TAG,
      "area:checkout",
      "guardrail:rollback",
      "scope:production",
    ],
    confidence: "high",
    sourceType: "paste",
    lastConfirmed: P7_AI_TIMESTAMP,
    createdAt: P7_AI_TIMESTAMP,
    updatedAt: P7_AI_TIMESTAMP,
  },
  {
    slug: P7_AI_RIGHT_SLUG,
    type: "decision",
    title: "Production checkout guardrail enabled",
    compiledTruth:
      "The checkout rollback guardrail remains enabled for all production checkout traffic. Production checkout releases must keep automatic rollback protection active until error rates stay within target for seven consecutive days.",
    sourceContent:
      "Decision memo: the checkout rollback guardrail remains enabled for all production checkout traffic until error rates stay within target for seven consecutive days.",
    contextPrefix:
      "AI contradiction fixture page asserting the production checkout guardrail is enabled.",
    attributionExcerpt:
      "The checkout rollback guardrail remains enabled for all production checkout traffic.",
    tags: [
      P7_AI_FIXTURE_TAG,
      "area:checkout",
      "guardrail:rollback",
      "scope:production",
    ],
    confidence: "high",
    sourceType: "paste",
    lastConfirmed: P7_AI_TIMESTAMP,
    createdAt: P7_AI_TIMESTAMP,
    updatedAt: P7_AI_TIMESTAMP,
  },
  {
    slug: P7_AI_HARD_NEGATIVE_SLUG,
    type: "project",
    title: "Mobile beta checkout guardrail stays enabled",
    compiledTruth:
      "The mobile beta checkout guardrail remains enabled only for beta traffic. This page does not set the production web checkout rollback policy.",
    sourceContent:
      "Project note: mobile beta checkout keeps its guardrail enabled for beta traffic only and does not decide production web checkout rollback policy.",
    contextPrefix:
      "AI contradiction hard-negative fixture page with related checkout guardrail context but a different scope.",
    attributionExcerpt:
      "Mobile beta checkout keeps its guardrail enabled for beta traffic only.",
    tags: [
      P7_AI_FIXTURE_TAG,
      "area:checkout",
      "guardrail:rollback",
      "scope:mobile-beta",
    ],
    confidence: "high",
    sourceType: "paste",
    lastConfirmed: P7_AI_TIMESTAMP,
    createdAt: P7_AI_TIMESTAMP,
    updatedAt: P7_AI_TIMESTAMP,
  },
];

function getP7FixturePages(fixture: string): readonly P7FixturePageSpec[] {
  if (fixture !== P7_FIXTURE) {
    throw new Error(`Unsupported Part 7 fixture ${fixture}; expected ${P7_FIXTURE}`);
  }
  return P7_FIXTURE_PAGES;
}

function getP7FixturePageBySlug(slug: string): P7FixturePageSpec {
  const spec = P7_FIXTURE_PAGES.find((candidate) => candidate.slug === slug);
  if (!spec) {
    throw new Error(`Unknown Part 7 fixture page slug ${slug}`);
  }
  return spec;
}

function getP7WindowEnd(period: P7Period, timestamp: number): number {
  if (period === "daily") {
    return timestamp + 24 * 60 * 60 * 1000;
  }
  if (period === "weekly") {
    return timestamp + 7 * 24 * 60 * 60 * 1000;
  }
  const start = new Date(timestamp);
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
}

function getP7LatestClosedDailyWindow(now: number = Date.now()): {
  period: "daily";
  timestamp: number;
  windowEnd: number;
} {
  const current = new Date(now);
  const windowEnd = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  );
  return {
    period: "daily",
    timestamp: windowEnd - 24 * 60 * 60 * 1000,
    windowEnd,
  };
}

async function p7ClaimAndFinalizeSynthesis(
  ctx: ActionCtx,
  args: {
    orgId: Id<"orgs">;
    period: P7Period;
    timestamp: number;
    summary: string;
    sourceSynthesisIds?: Id<"syntheses">[];
  },
) {
  const windowEnd = getP7WindowEnd(args.period, args.timestamp);
  const claim = await ctx.runMutation(p7ClaimSynthesisRef, {
    orgId: args.orgId,
    period: args.period,
    timestamp: args.timestamp,
    windowEnd,
    now: args.timestamp + 60 * 1000,
  });
  assertP7Probe(
    claim.status === "claimed" ||
      claim.status === "reclaimed_stale" ||
      claim.status === "reclaimed_failed",
    `Expected ${args.period} synthesis claim for deterministic finalize, got ${claim.status}`,
  );

  const finalize = await ctx.runMutation(p7FinalizeSynthesisRef, {
    synthesisId: claim.synthesisId,
    summary: args.summary,
    actors: [],
    repos: [],
    sourcePageIds: [],
    sourceSynthesisIds: args.sourceSynthesisIds ?? [],
    warnings: [],
  });
  assertP7Probe(
    finalize.status === "completed",
    `Expected ${args.period} deterministic finalize to complete, got ${finalize.status}`,
  );

  const synthesis = await ctx.runQuery(p7GetSynthesisByIdRef, {
    synthesisId: claim.synthesisId,
  });
  assertP7Probe(synthesis, "Expected deterministic finalized synthesis row");
  return synthesis;
}

function assertP7SynthesisPaginationFixture(fixture: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(fixture)) {
    throw new Error(`Invalid Part 7 synthesis pagination fixture ${fixture}`);
  }
}

function getP7SynthesisPaginationPrefix(fixture: string): string {
  assertP7SynthesisPaginationFixture(fixture);
  return `${P7_SYNTHESIS_PAGINATION_CLERK_PREFIX}${fixture}-`;
}

function getP7SynthesisPaginationClerkOrgId(
  prefix: string,
  ordinal: number,
): string {
  return `${prefix}${String(ordinal).padStart(4, "0")}`;
}

function getP7SynthesisPaginationOrdinal(
  prefix: string,
  clerkOrgId: string,
): number | null {
  if (!clerkOrgId.startsWith(prefix)) {
    return null;
  }
  const suffix = clerkOrgId.slice(prefix.length);
  if (!/^[0-9]{4}$/.test(suffix)) {
    return null;
  }
  const ordinal = Number.parseInt(suffix, 10);
  if (ordinal < 1 || ordinal > P7_SYNTHESIS_PAGINATION_ORG_COUNT) {
    return null;
  }
  return ordinal;
}

async function getP7SourceHash(spec: P7FixturePageSpec): Promise<string> {
  return sha256Hex(
    `${P7_FIXTURE}:${spec.slug}:${spec.contextPrefix}:${spec.sourceContent}`,
  );
}

async function getP7AiSourceHash(spec: P7FixturePageSpec): Promise<string> {
  return sha256Hex(
    `${P7_AI_FIXTURE}:${spec.slug}:${spec.contextPrefix}:${spec.sourceContent}`,
  );
}

function getP7DeterministicFindingSlugs(repairSlugs: {
  staleDecisionSlug: string;
  orphanPageSlug: string;
  weakProvenanceSlug: string;
}) {
  return {
    staleDecision: `finding-linter-stale-decision-${repairSlugs.staleDecisionSlug}`,
    orphanPage: `finding-linter-orphan-${repairSlugs.orphanPageSlug}`,
    weakProvenance:
      `finding-linter-weak-provenance-${repairSlugs.weakProvenanceSlug}`,
  };
}

function assertP7Probe(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeP7AiCandidatePage(args: {
  id: Id<"knowledgePages">;
  slug: string;
  title: string;
  type: Doc<"knowledgePages">["type"];
  compiledTruth: string;
  tags: string[];
}): {
  _id: Id<"knowledgePages">;
  slug: string;
  title: string;
  type: Doc<"knowledgePages">["type"];
  compiledTruth: string;
  tags: string[];
  confidence: "high";
  lastConfirmed: number;
  updatedAt: number;
  evidenceTimeline: Array<{
    source: string;
    channel: string;
    timestamp: number;
    content: string;
  }>;
} {
  return {
    _id: args.id,
    slug: args.slug,
    title: args.title,
    type: args.type,
    compiledTruth: args.compiledTruth,
    tags: [...args.tags],
    confidence: "high",
    lastConfirmed: P7_AI_TIMESTAMP,
    updatedAt: P7_AI_TIMESTAMP,
    evidenceTimeline: [
      {
        source: args.title,
        channel: P7_AI_SOURCE_CHANNEL,
        timestamp: P7_AI_TIMESTAMP,
        content: args.compiledTruth,
      },
    ],
  };
}

function makeP7AiContradictionPair(args: {
  left: ReturnType<typeof makeP7AiCandidatePage>;
  right: ReturnType<typeof makeP7AiCandidatePage>;
  overlapReason: string;
}) {
  const [left, right] = [args.left, args.right].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  return {
    pairKey: `${left.slug}--${right.slug}`,
    sourcePairKey: [left._id as string, right._id as string]
      .sort((leftId, rightId) => leftId.localeCompare(rightId))
      .join("--"),
    left,
    right,
    overlapReason: args.overlapReason,
  };
}

async function listP7FindingPages(
  ctx: RunQueryContext,
  orgId: Id<"orgs">,
): Promise<Doc<"knowledgePages">[]> {
  const findingPages = (await ctx.runQuery(getKnowledgePagesByTypeRef, {
    orgId,
    type: "finding",
  })) as Doc<"knowledgePages">[];

  return findingPages.sort((left, right) => left.slug.localeCompare(right.slug));
}

async function getP7RelatedRefCount(
  ctx: RunQueryContext,
  findingId: Id<"knowledgePages">,
  targetPageId: Id<"knowledgePages">,
): Promise<number> {
  const refs = (await ctx.runQuery(listReferencesByTargetRef, {
    toPageId: targetPageId,
  })) as Array<{
    fromPageId: Id<"knowledgePages">;
    referenceType: Doc<"references">["referenceType"];
  }>;

  return refs.filter(
    (reference) =>
      reference.fromPageId === findingId &&
      reference.referenceType === "related_to",
  ).length;
}

export const p7SeedLinterSynthFixture = internalMutation({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    const fixturePages = getP7FixturePages(args.fixture);

    let org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", P7_CLERK_ORG_ID))
      .first();
    if (!org) {
      const orgId = await ctx.db.insert("orgs", {
        clerkOrgId: P7_CLERK_ORG_ID,
        name: P7_ORG_NAME,
      });
      org = await ctx.db.get(orgId);
    }
    if (!org) {
      throw new Error("Failed to create Part 7 fixture org");
    }
    if (org.name !== P7_ORG_NAME) {
      await ctx.db.patch(org._id, { name: P7_ORG_NAME });
    }

    const knowledgeBases = await ctx.db
      .query("knowledgeBases")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    let knowledgeBase =
      knowledgeBases.find((candidate) => candidate.name === P7_KB_NAME) ??
      knowledgeBases[0] ??
      null;
    if (!knowledgeBase) {
      const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
        orgId: org._id,
        name: P7_KB_NAME,
        description: P7_KB_DESCRIPTION,
        pageCount: 0,
        sourceCount: 0,
        createdAt: P7_DAILY_TIMESTAMP,
      });
      const createdKnowledgeBase = await ctx.db.get(knowledgeBaseId);
      if (!createdKnowledgeBase) {
        throw new Error("Failed to create Part 7 fixture knowledge base");
      }
      knowledgeBase = createdKnowledgeBase;
    }
    if (!knowledgeBase) {
      throw new Error("Failed to create Part 7 fixture knowledge base");
    }

    const staleLinterFindings = (
      await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_type", (q) =>
          q.eq("orgId", org._id).eq("type", "finding"),
        )
        .collect()
    ).filter(
      (page) =>
        page.sourceAgent === "linter" &&
        page.slug.startsWith(P7_LINTER_FINDING_PREFIX),
    );
    const deletedReferenceIds = new Set<Id<"references">>();
    for (const finding of staleLinterFindings) {
      const references = [
        ...(await ctx.db
          .query("references")
          .withIndex("by_from", (q) => q.eq("fromPageId", finding._id))
          .collect()),
        ...(await ctx.db
          .query("references")
          .withIndex("by_to", (q) => q.eq("toPageId", finding._id))
          .collect()),
      ];
      for (const reference of references) {
        if (deletedReferenceIds.has(reference._id)) {
          continue;
        }
        deletedReferenceIds.add(reference._id);
        await ctx.db.delete(reference._id);
      }

      const attributions = await ctx.db
        .query("sourceAttributions")
        .withIndex("by_page", (q) => q.eq("pageId", finding._id))
        .collect();
      for (const attribution of attributions) {
        await ctx.db.delete(attribution._id);
      }

      const versions = await ctx.db
        .query("pageVersions")
        .withIndex("by_page", (q) => q.eq("pageId", finding._id))
        .collect();
      for (const version of versions) {
        await ctx.db.delete(version._id);
      }

      await ctx.db.delete(finding._id);
    }

    const pageIdBySlug = new Map<string, Id<"knowledgePages">>();
    const sourceIdBySlug = new Map<string, Id<"sources">>();
    const chunkIdBySlug = new Map<string, Id<"sourceChunks">>();

    for (const spec of fixturePages) {
      const pagePatch = {
        knowledgeBaseId: knowledgeBase._id,
        type: spec.type,
        title: spec.title,
        slug: spec.slug,
        compiledTruth: spec.compiledTruth,
        evidenceTimeline: [
          {
            source: spec.title,
            channel: P7_SOURCE_CHANNEL,
            timestamp: spec.updatedAt,
            content: spec.attributionExcerpt,
          },
        ],
        tags: dedupeStrings(spec.tags),
        confidence: spec.confidence,
        lastConfirmed: spec.lastConfirmed,
        sourceCount: spec.omitAttribution ? 1 : 2,
        severity: spec.finding?.severity,
        findingType: spec.finding?.findingType,
        findingStatus: spec.finding?.findingStatus,
        implication: spec.finding?.implication,
        sourceAgent: spec.finding?.sourceAgent,
        owner: spec.goal?.owner,
        targetDate: spec.goal?.targetDate,
        goalStatus: spec.goal?.goalStatus,
        sessionId: undefined,
        actor: spec.session?.actor,
        repo: spec.session?.repo,
        sessionStartTime: spec.session?.startTime,
        sessionEndTime: spec.session?.endTime,
        eventCount: spec.session?.eventCount,
        eventIds: undefined,
        workType: spec.session?.workType,
        complexity: spec.session?.complexity,
        skills: spec.session?.skills,
        associatedSessionIds: undefined,
        knowledgePageIds: spec.session ? [] : undefined,
        knowledgeBridgeStatus: spec.session ? ("completed" as const) : undefined,
        knowledgeBridgeAttemptedAt: spec.session ? spec.updatedAt : undefined,
        knowledgeBridgeCompletedAt: spec.session ? spec.updatedAt : undefined,
        knowledgeBridgeError: undefined,
        status: "active" as const,
        createdBy: P7_CREATED_BY,
        updatedAt: spec.updatedAt,
      };

      const existingPage = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) => q.eq("orgId", org._id).eq("slug", spec.slug))
        .first();
      let pageId = existingPage?._id ?? null;
      if (!existingPage) {
        pageId = await ctx.db.insert("knowledgePages", {
          orgId: org._id,
          createdAt: spec.createdAt,
          ...pagePatch,
        });
      } else {
        await ctx.db.patch(existingPage._id, pagePatch);
      }
      if (!pageId) {
        throw new Error(`Failed to upsert Part 7 page ${spec.slug}`);
      }
      pageIdBySlug.set(spec.slug, pageId);

      const sourceContentHash = await getP7SourceHash(spec);
      const existingSource = await ctx.db
        .query("sources")
        .withIndex("by_hash", (q) => q.eq("orgId", org._id).eq("contentHash", sourceContentHash))
        .first();
      let sourceId = existingSource?._id ?? null;
      const sourcePatch = {
        knowledgeBaseId: knowledgeBase._id,
        title: spec.title,
        sourceType: spec.sourceType,
        content: spec.sourceContent,
        contentHash: sourceContentHash,
        status: "processed" as const,
        sessionId: undefined,
      };
      if (!existingSource) {
        sourceId = await ctx.db.insert("sources", {
          orgId: org._id,
          createdAt: spec.createdAt,
          ...sourcePatch,
        });
      } else {
        await ctx.db.patch(existingSource._id, sourcePatch);
      }
      if (!sourceId) {
        throw new Error(`Failed to upsert Part 7 source ${spec.slug}`);
      }
      sourceIdBySlug.set(spec.slug, sourceId);

      const existingChunk = await ctx.db
        .query("sourceChunks")
        .withIndex("by_source", (q) => q.eq("sourceId", sourceId).eq("chunkIndex", 0))
        .first();
      const chunkPatch = {
        orgId: org._id,
        content: spec.sourceContent,
        contextPrefix: spec.contextPrefix,
        searchableText: sourceChunkSearchableText(
          spec.sourceContent,
          spec.contextPrefix,
        ),
        tokenCount: tokenCountForFixture(spec.sourceContent),
      };
      let chunkId = existingChunk?._id ?? null;
      if (!existingChunk) {
        chunkId = await ctx.db.insert("sourceChunks", {
          sourceId,
          chunkIndex: 0,
          ...chunkPatch,
        });
      } else {
        await ctx.db.patch(existingChunk._id, chunkPatch);
      }
      if (!chunkId) {
        throw new Error(`Failed to upsert Part 7 chunk ${spec.slug}`);
      }
      chunkIdBySlug.set(spec.slug, chunkId);

      if (!spec.omitAttribution) {
        const attributions = await ctx.db
          .query("sourceAttributions")
          .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
          .collect();
        const matchingAttribution = attributions.find(
          (candidate) => candidate.pageId === pageId && candidate.chunkId === chunkId,
        );
        if (!matchingAttribution) {
          await ctx.db.insert("sourceAttributions", {
            pageId,
            sourceId,
            chunkId,
            orgId: org._id,
            excerpt: spec.attributionExcerpt,
            createdAt: spec.updatedAt,
          });
        } else if (matchingAttribution.excerpt !== spec.attributionExcerpt) {
          await ctx.db.patch(matchingAttribution._id, {
            excerpt: spec.attributionExcerpt,
          });
        }
      } else {
        const attributions = await ctx.db
          .query("sourceAttributions")
          .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
          .collect();
        for (const attribution of attributions) {
          if (attribution.pageId === pageId) {
            await ctx.db.delete(attribution._id);
          }
        }
      }
    }

    for (const spec of fixturePages) {
      const fromPageId = pageIdBySlug.get(spec.slug);
      if (!fromPageId || !spec.references?.length) {
        continue;
      }
      for (const reference of spec.references) {
        const toPageId = pageIdBySlug.get(reference.targetSlug);
        if (!toPageId) {
          throw new Error(
            `Part 7 reference target ${reference.targetSlug} missing for ${spec.slug}`,
          );
        }
        const existingReferences = await ctx.db
          .query("references")
          .withIndex("by_from", (q) =>
            q.eq("fromPageId", fromPageId).eq("referenceType", reference.referenceType),
          )
          .collect();
        const existingReference = existingReferences.find(
          (candidate) => candidate.toPageId === toPageId,
        );
        if (!existingReference) {
          await ctx.db.insert("references", {
            orgId: org._id,
            fromPageId,
            toPageId,
            referenceType: reference.referenceType,
            context: reference.context,
            createdAt: spec.updatedAt,
          });
        } else if (existingReference.context !== reference.context) {
          await ctx.db.patch(existingReference._id, {
            context: reference.context,
          });
        }
      }
    }

    const slugByPageId = new Map(
      Array.from(pageIdBySlug.entries()).map(([slug, pageId]) => [pageId, slug]),
    );
    const expectedReferenceKeys = new Set(
      fixturePages.flatMap((spec) =>
        (spec.references ?? []).map(
          (reference) =>
            `${spec.slug}|${reference.referenceType}|${reference.targetSlug}`,
        ),
      ),
    );
    for (const [fromSlug, fromPageId] of pageIdBySlug.entries()) {
      const existingReferences = await ctx.db
        .query("references")
        .withIndex("by_from", (q) => q.eq("fromPageId", fromPageId))
        .collect();
      for (const reference of existingReferences) {
        const targetSlug = slugByPageId.get(reference.toPageId);
        const referenceKey = targetSlug
          ? `${fromSlug}|${reference.referenceType}|${targetSlug}`
          : null;
        if (!referenceKey || !expectedReferenceKeys.has(referenceKey)) {
          await ctx.db.delete(reference._id);
        }
      }
    }

    const pages = await ctx.db
      .query("knowledgePages")
      .withIndex("by_kb", (q) => q.eq("knowledgeBaseId", knowledgeBase._id))
      .collect();
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_kb", (q) => q.eq("knowledgeBaseId", knowledgeBase._id))
      .collect();
    const chunks = (
      await Promise.all(
        sources.map((source) =>
          ctx.db
            .query("sourceChunks")
            .withIndex("by_source", (q) => q.eq("sourceId", source._id))
            .collect(),
        ),
      )
    ).flat();
    const attributions = (
      await Promise.all(
        sources.map((source) =>
          ctx.db
            .query("sourceAttributions")
            .withIndex("by_source", (q) => q.eq("sourceId", source._id))
            .collect(),
        ),
      )
    ).flat();
    const references = (
      await Promise.all(
        pages.map((page) =>
          ctx.db
            .query("references")
            .withIndex("by_from", (q) => q.eq("fromPageId", page._id))
            .collect(),
        ),
      )
    ).flat();
    const syntheses = await ctx.db
      .query("syntheses")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();

    const expectedPageSlugs = new Set(fixturePages.map((spec) => spec.slug));
    const unexpectedPages = pages.filter(
      (page) =>
        !expectedPageSlugs.has(page.slug) &&
        !(
          page.type === "finding" &&
          page.sourceAgent === "linter" &&
          page.slug.startsWith(P7_LINTER_FINDING_PREFIX)
        ),
    );
    if (unexpectedPages.length > 0) {
      throw new Error(
        `Part 7 knowledge base contains unexpected pages: ${unexpectedPages
          .map((page) => page.slug)
          .join(", ")}`,
      );
    }
    const seededPages = pages.filter((page) => expectedPageSlugs.has(page.slug));
    if (seededPages.length !== fixturePages.length) {
      throw new Error(
        `Part 7 knowledge base has ${seededPages.length} seeded pages; expected ${fixturePages.length}`,
      );
    }

    const expectedSourceHashes = new Set(
      await Promise.all(fixturePages.map((spec) => getP7SourceHash(spec))),
    );
    const unexpectedSources = sources.filter(
      (source) => !source.contentHash || !expectedSourceHashes.has(source.contentHash),
    );
    if (unexpectedSources.length > 0) {
      throw new Error(
        `Part 7 knowledge base contains unexpected sources: ${unexpectedSources
          .map((source) => source.title)
          .join(", ")}`,
      );
    }
    if (sources.length !== fixturePages.length) {
      throw new Error(
        `Part 7 knowledge base has ${sources.length} sources; expected ${fixturePages.length}`,
      );
    }
    const expectedSourceIds = new Set(Array.from(sourceIdBySlug.values()));
    const malformedChunks = chunks.filter(
      (chunk) => chunk.chunkIndex !== 0 || !expectedSourceIds.has(chunk.sourceId),
    );
    if (malformedChunks.length > 0) {
      throw new Error(`Part 7 knowledge base contains unexpected chunks: ${malformedChunks.length}`);
    }
    if (chunks.length !== fixturePages.length) {
      throw new Error(
        `Part 7 knowledge base has ${chunks.length} chunks; expected ${fixturePages.length}`,
      );
    }

    await ctx.db.patch(knowledgeBase._id, {
      name: P7_KB_NAME,
      description: P7_KB_DESCRIPTION,
      pageCount: pages.length,
      sourceCount: sources.length,
      lastIngestAt: P7_DAILY_WINDOW_END,
    });

    return {
      fixture: args.fixture,
      orgId: org._id,
      knowledgeBaseId: knowledgeBase._id,
      canonicalWindow: {
        period: "daily" as const,
        timestamp: P7_DAILY_TIMESTAMP,
        timestampIso: new Date(P7_DAILY_TIMESTAMP).toISOString(),
        windowEnd: P7_DAILY_WINDOW_END,
        windowEndIso: new Date(P7_DAILY_WINDOW_END).toISOString(),
      },
      repairSlugs: {
        staleDecisionSlug: P7_STALE_DECISION_SLUG,
        orphanPageSlug: P7_ORPHAN_PAGE_SLUG,
        weakProvenanceSlug: P7_WEAK_PROVENANCE_SLUG,
      },
      pages: fixturePages.map((spec) => ({
        slug: spec.slug,
        type: spec.type,
        pageId: pageIdBySlug.get(spec.slug) ?? null,
      })),
      counts: {
        pages: pages.length,
        sources: sources.length,
        chunks: chunks.length,
        attributions: attributions.length,
        references: references.length,
        syntheses: syntheses.length,
        sessionPages: pages.filter((page) => page.type === "session").length,
        decisionPages: pages.filter((page) => page.type === "decision").length,
        goalPages: pages.filter((page) => page.type === "goal").length,
        findingPages: pages.filter((page) => page.type === "finding").length,
      },
      ids: {
        pageIdsBySlug: Object.fromEntries(pageIdBySlug),
        sourceIdsBySlug: Object.fromEntries(sourceIdBySlug),
        chunkIdsBySlug: Object.fromEntries(chunkIdBySlug),
      },
    };
  },
});

export const p7SeedAiContradictionFixture = internalMutation({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.fixture !== P7_AI_FIXTURE) {
      throw new Error(
        `Unsupported Part 7 AI fixture ${args.fixture}; expected ${P7_AI_FIXTURE}`,
      );
    }

    let org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", P7_AI_CLERK_ORG_ID))
      .first();
    if (!org) {
      const orgId = await ctx.db.insert("orgs", {
        clerkOrgId: P7_AI_CLERK_ORG_ID,
        name: P7_AI_ORG_NAME,
      });
      org = await ctx.db.get(orgId);
    }
    if (!org) {
      throw new Error("Failed to create Part 7 AI fixture org");
    }
    await ctx.db.patch(org._id, {
      name: P7_AI_ORG_NAME,
      anthropicApiKey: undefined,
    });

    const existingKnowledgeBases = await ctx.db
      .query("knowledgeBases")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    let knowledgeBase =
      existingKnowledgeBases.find((candidate) => candidate.name === P7_AI_KB_NAME) ??
      existingKnowledgeBases[0] ??
      null;
    if (!knowledgeBase) {
      const knowledgeBaseId = await ctx.db.insert("knowledgeBases", {
        orgId: org._id,
        name: P7_AI_KB_NAME,
        description: P7_AI_KB_DESCRIPTION,
        pageCount: 0,
        sourceCount: 0,
        createdAt: P7_AI_TIMESTAMP,
      });
      const createdKnowledgeBase = await ctx.db.get(knowledgeBaseId);
      if (!createdKnowledgeBase) {
        throw new Error("Failed to create Part 7 AI fixture knowledge base");
      }
      knowledgeBase = createdKnowledgeBase;
    }
    if (!knowledgeBase) {
      throw new Error("Failed to create Part 7 AI fixture knowledge base");
    }

    const pageTypes: Array<Doc<"knowledgePages">["type"]> = [
      "fact",
      "pattern",
      "decision",
      "entity",
      "project",
      "question",
      "finding",
      "goal",
      "session",
    ];
    const existingPages = (
      await Promise.all(
        pageTypes.map((type) =>
          ctx.db
            .query("knowledgePages")
            .withIndex("by_org_type", (q) =>
              q.eq("orgId", org._id).eq("type", type),
            )
            .collect(),
        ),
      )
    ).flat();
    const deletedReferenceIds = new Set<Id<"references">>();
    for (const page of existingPages) {
      const references = [
        ...(await ctx.db
          .query("references")
          .withIndex("by_from", (q) => q.eq("fromPageId", page._id))
          .collect()),
        ...(await ctx.db
          .query("references")
          .withIndex("by_to", (q) => q.eq("toPageId", page._id))
          .collect()),
      ];
      for (const reference of references) {
        if (deletedReferenceIds.has(reference._id)) {
          continue;
        }
        deletedReferenceIds.add(reference._id);
        await ctx.db.delete(reference._id);
      }

      const attributions = await ctx.db
        .query("sourceAttributions")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      for (const attribution of attributions) {
        await ctx.db.delete(attribution._id);
      }

      const versions = await ctx.db
        .query("pageVersions")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      for (const version of versions) {
        await ctx.db.delete(version._id);
      }
    }

    const sourceStatuses: Array<Doc<"sources">["status"]> = [
      "pending",
      "processing",
      "processed",
    ];
    const existingSources = (
      await Promise.all(
        sourceStatuses.map((status) =>
          ctx.db
            .query("sources")
            .withIndex("by_org_status", (q) =>
              q.eq("orgId", org._id).eq("status", status),
            )
            .collect(),
        ),
      )
    ).flat();
    const deletedAttributionIds = new Set<Id<"sourceAttributions">>();
    for (const source of existingSources) {
      const chunks = await ctx.db
        .query("sourceChunks")
        .withIndex("by_source", (q) => q.eq("sourceId", source._id))
        .collect();
      for (const chunk of chunks) {
        await ctx.db.delete(chunk._id);
      }

      const attributions = await ctx.db
        .query("sourceAttributions")
        .withIndex("by_source", (q) => q.eq("sourceId", source._id))
        .collect();
      for (const attribution of attributions) {
        if (deletedAttributionIds.has(attribution._id)) {
          continue;
        }
        deletedAttributionIds.add(attribution._id);
        await ctx.db.delete(attribution._id);
      }

      const jobs = await ctx.db
        .query("ingestJobs")
        .withIndex("by_source", (q) => q.eq("sourceId", source._id))
        .collect();
      for (const job of jobs) {
        await ctx.db.delete(job._id);
      }

      await ctx.db.delete(source._id);
    }

    const syntheses = await ctx.db
      .query("syntheses")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    for (const synthesis of syntheses) {
      await ctx.db.delete(synthesis._id);
    }

    for (const page of existingPages) {
      await ctx.db.delete(page._id);
    }

    const pageIdBySlug = new Map<string, Id<"knowledgePages">>();
    const sourceIdBySlug = new Map<string, Id<"sources">>();
    const chunkIdBySlug = new Map<string, Id<"sourceChunks">>();

    for (const spec of P7_AI_FIXTURE_PAGES) {
      const pageId = await ctx.db.insert("knowledgePages", {
        orgId: org._id,
        knowledgeBaseId: knowledgeBase._id,
        type: spec.type,
        title: spec.title,
        slug: spec.slug,
        compiledTruth: spec.compiledTruth,
        evidenceTimeline: [
          {
            source: spec.title,
            channel: P7_AI_SOURCE_CHANNEL,
            timestamp: spec.updatedAt,
            content: spec.attributionExcerpt,
          },
        ],
        tags: dedupeStrings(spec.tags),
        confidence: spec.confidence,
        lastConfirmed: spec.lastConfirmed,
        sourceCount: 2,
        status: "active",
        createdBy: P7_AI_CREATED_BY,
        createdAt: spec.createdAt,
        updatedAt: spec.updatedAt,
      });
      pageIdBySlug.set(spec.slug, pageId);

      const sourceId = await ctx.db.insert("sources", {
        orgId: org._id,
        knowledgeBaseId: knowledgeBase._id,
        title: spec.title,
        sourceType: spec.sourceType,
        content: spec.sourceContent,
        contentHash: await getP7AiSourceHash(spec),
        status: "processed",
        createdAt: spec.createdAt,
      });
      sourceIdBySlug.set(spec.slug, sourceId);

      const chunkId = await ctx.db.insert("sourceChunks", {
        sourceId,
        orgId: org._id,
        chunkIndex: 0,
        content: spec.sourceContent,
        contextPrefix: spec.contextPrefix,
        searchableText: sourceChunkSearchableText(
          spec.sourceContent,
          spec.contextPrefix,
        ),
        tokenCount: tokenCountForFixture(spec.sourceContent),
      });
      chunkIdBySlug.set(spec.slug, chunkId);

      await ctx.db.insert("sourceAttributions", {
        pageId,
        sourceId,
        chunkId,
        orgId: org._id,
        excerpt: spec.attributionExcerpt,
        createdAt: spec.updatedAt,
      });
    }

    const unmanagedFindingLeftPageId = pageIdBySlug.get(P7_AI_LEFT_SLUG) ?? null;
    const unmanagedFindingRightPageId =
      pageIdBySlug.get(P7_AI_RIGHT_SLUG) ?? null;
    if (!unmanagedFindingLeftPageId || !unmanagedFindingRightPageId) {
      throw new Error("Part 7 AI fixture source pages missing for unmanaged finding");
    }

    const unmanagedFindingId = await ctx.db.insert("knowledgePages", {
      orgId: org._id,
      knowledgeBaseId: knowledgeBase._id,
      type: "finding",
      title: "Preexisting AI contradiction retained for managed-slug scoping",
      slug: P7_AI_UNMANAGED_FINDING_SLUG,
      compiledTruth:
        "This preexisting AI contradiction finding is intentionally unrelated to the evaluated candidate-pack slugs. It must remain open unless the active pack explicitly manages this slug.",
      evidenceTimeline: [
        {
          source: "Part 7 AI preexisting finding",
          channel: P7_AI_SOURCE_CHANNEL,
          timestamp: P7_AI_TIMESTAMP,
          content:
            "Preexisting AI contradiction retained to prove managed-slug scoped resolution.",
        },
      ],
      tags: [P7_AI_FIXTURE_TAG, "lint:ai", "lint:contradiction"],
      confidence: "low",
      lastConfirmed: P7_AI_TIMESTAMP,
      sourceCount: 2,
      severity: "low",
      findingType: "contradiction",
      findingStatus: "investigating",
      implication:
        "AI contradiction resolution must only touch slugs managed by the evaluated candidate pack.",
      sourceAgent: "linter",
      status: "active",
      createdBy: P7_AI_CREATED_BY,
      createdAt: P7_AI_TIMESTAMP,
      updatedAt: P7_AI_TIMESTAMP,
    });
    await ctx.db.insert("references", {
      orgId: org._id,
      fromPageId: unmanagedFindingId,
      toPageId: unmanagedFindingLeftPageId,
      referenceType: "related_to",
      createdAt: P7_AI_TIMESTAMP,
    });
    await ctx.db.insert("references", {
      orgId: org._id,
      fromPageId: unmanagedFindingId,
      toPageId: unmanagedFindingRightPageId,
      referenceType: "related_to",
      createdAt: P7_AI_TIMESTAMP,
    });

    await ctx.db.patch(knowledgeBase._id, {
      name: P7_AI_KB_NAME,
      description: P7_AI_KB_DESCRIPTION,
      pageCount: P7_AI_FIXTURE_PAGES.length + 1,
      sourceCount: P7_AI_FIXTURE_PAGES.length,
      lastIngestAt: P7_AI_TIMESTAMP,
    });

    return {
      fixture: args.fixture,
      orgId: org._id,
      knowledgeBaseId: knowledgeBase._id,
      probeNow: P7_AI_PROBE_NOW,
      expectedFindingSlug: P7_AI_EXPECTED_FINDING_SLUG,
      unmanagedFindingSlug: P7_AI_UNMANAGED_FINDING_SLUG,
      contradictionSlugs: {
        left: P7_AI_LEFT_SLUG,
        right: P7_AI_RIGHT_SLUG,
        hardNegative: P7_AI_HARD_NEGATIVE_SLUG,
      },
      pages: P7_AI_FIXTURE_PAGES.map((spec) => ({
        slug: spec.slug,
        type: spec.type,
        pageId: pageIdBySlug.get(spec.slug) ?? null,
      })),
      ids: {
        pageIdsBySlug: Object.fromEntries(pageIdBySlug),
        sourceIdsBySlug: Object.fromEntries(sourceIdBySlug),
        chunkIdsBySlug: Object.fromEntries(chunkIdBySlug),
      },
    };
  },
});

export const p7ListSyntheses = internalQuery({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, { orgId }) => {
    return ctx.db
      .query("syntheses")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .order("desc")
      .collect();
  },
});

export const p7ClearSynthesesForOrg = internalMutation({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, { orgId }) => {
    const syntheses = await ctx.db
      .query("syntheses")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    for (const synthesis of syntheses) {
      await ctx.db.delete(synthesis._id);
    }
    return { deleted: syntheses.length };
  },
});

export const p7CleanupSynthesisPaginationFixtureBatch = internalMutation({
  args: {
    fixture: v.string(),
    batchSize: v.number(),
  },
  handler: async (ctx, args) => {
    const prefix = getP7SynthesisPaginationPrefix(args.fixture);
    const batchSize = Math.max(
      1,
      Math.min(
        Math.trunc(args.batchSize),
        P7_SYNTHESIS_PAGINATION_BATCH_SIZE,
      ),
    );
    const orgs = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) =>
        q.gte("clerkOrgId", prefix).lt("clerkOrgId", `${prefix}\uffff`),
      )
      .take(batchSize);
    const unsafeOrg = orgs.find(
      (org) => getP7SynthesisPaginationOrdinal(prefix, org.clerkOrgId) === null,
    );
    if (unsafeOrg) {
      throw new Error(
        `Refusing to clean non-fixture Part 7 pagination org ${unsafeOrg.clerkOrgId}`,
      );
    }

    let deletedSyntheses = 0;
    for (const org of orgs) {
      const syntheses = await ctx.db
        .query("syntheses")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .collect();
      for (const synthesis of syntheses) {
        await ctx.db.delete(synthesis._id);
        deletedSyntheses += 1;
      }
      await ctx.db.delete(org._id);
    }

    const remaining = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) =>
        q.gte("clerkOrgId", prefix).lt("clerkOrgId", `${prefix}\uffff`),
      )
      .take(1);

    return {
      deletedSyntheses,
      deletedOrgs: orgs.length,
      remaining: remaining.length,
    };
  },
});

export const p7SeedSynthesisPaginationOrgsBatch = internalMutation({
  args: {
    fixture: v.string(),
    prefix: v.string(),
    startOrdinal: v.number(),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    const startOrdinal = Math.max(1, Math.trunc(args.startOrdinal));
    const count = Math.max(
      0,
      Math.min(Math.trunc(args.count), P7_SYNTHESIS_PAGINATION_BATCH_SIZE),
    );
    let inserted = 0;
    let reused = 0;
    let firstClerkOrgId: string | null = null;
    let lastClerkOrgId: string | null = null;
    let targetOrgId: Id<"orgs"> | null = null;

    for (let offset = 0; offset < count; offset += 1) {
      const ordinal = startOrdinal + offset;
      const clerkOrgId = getP7SynthesisPaginationClerkOrgId(args.prefix, ordinal);
      firstClerkOrgId ??= clerkOrgId;
      lastClerkOrgId = clerkOrgId;

      let org = await ctx.db
        .query("orgs")
        .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
        .first();
      const name = `Part 7 Synth Pagination ${args.fixture} ${String(ordinal).padStart(4, "0")}`;
      if (!org) {
        const orgId = await ctx.db.insert("orgs", {
          clerkOrgId,
          name,
        });
        org = await ctx.db.get(orgId);
        inserted += 1;
      } else {
        reused += 1;
        if (org.name !== name) {
          await ctx.db.patch(org._id, { name });
        }
      }

      if (!org) {
        throw new Error(`Failed to seed synthesis pagination org ${clerkOrgId}`);
      }

      if (ordinal === P7_SYNTHESIS_PAGINATION_TARGET_ORDINAL) {
        targetOrgId = org._id;
      }
    }

    return {
      inserted,
      reused,
      firstClerkOrgId,
      lastClerkOrgId,
      targetOrgId,
    };
  },
});

export const p7GetOrgByClerkOrgId = internalQuery({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();
    return org ? { orgId: org._id, clerkOrgId: org.clerkOrgId } : null;
  },
});

export const p7GetSynthesisForOrgWindow = internalQuery({
  args: {
    orgId: v.id("orgs"),
    period: P7_PERIOD_VALIDATOR,
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const syntheses = await ctx.db
      .query("syntheses")
      .withIndex("by_org_period", (q) =>
        q.eq("orgId", args.orgId).eq("period", args.period).eq("timestamp", args.timestamp),
      )
      .collect();
    if (syntheses.length > 1) {
      throw new Error(
        `Expected at most one synthesis for pagination probe target, found ${syntheses.length}`,
      );
    }
    return syntheses[0] ?? null;
  },
});

export const p7SeedStaleSynthesis = internalMutation({
  args: {
    orgId: v.id("orgs"),
    period: P7_PERIOD_VALIDATOR,
    timestamp: v.number(),
    status: v.optional(v.union(v.literal("in_progress"), v.literal("failed"))),
    failureKind: v.optional(P7_SYNTHESIS_FAILURE_KIND_VALIDATOR),
    retryCount: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
    terminalFailure: v.optional(v.boolean()),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("syntheses")
      .withIndex("by_org_period", (q) =>
        q.eq("orgId", args.orgId).eq("period", args.period).eq("timestamp", args.timestamp),
      )
      .collect();
    if (existing.length > 1) {
      throw new Error(
        `Expected at most one synthesis for ${args.period} ${args.timestamp}, found ${existing.length}`,
      );
    }

    const status = args.status ?? "in_progress";
    const claimedAt = args.timestamp - 6 * 60 * 60 * 1000;
    const windowEnd = getP7WindowEnd(args.period, args.timestamp);
    const updatedAt = args.updatedAt ?? args.timestamp;
    const failureInsertFields =
      status === "failed"
        ? {
            ...(args.failureKind === undefined
              ? {}
              : { failureKind: args.failureKind }),
            ...(args.retryCount === undefined
              ? {}
              : { retryCount: args.retryCount }),
            ...(args.nextRetryAt === undefined
              ? {}
              : { nextRetryAt: args.nextRetryAt }),
            ...(args.terminalFailure === undefined
              ? {}
              : { terminalFailure: args.terminalFailure }),
          }
        : {};
    const failurePatchFields =
      status === "failed"
        ? {
            failureKind: args.failureKind,
            retryCount: args.retryCount,
            nextRetryAt: args.nextRetryAt,
            terminalFailure: args.terminalFailure,
          }
        : {
            failureKind: undefined,
            retryCount: args.retryCount,
            nextRetryAt: undefined,
            terminalFailure: undefined,
          };
    let synthesisId = existing[0]?._id ?? null;

    if (!existing[0]) {
      synthesisId = await ctx.db.insert("syntheses", {
        orgId: args.orgId,
        period: args.period,
        timestamp: args.timestamp,
        windowEnd,
        status,
        claimedAt,
        ...(status === "failed"
          ? { error: "debug seeded failed synthesis" }
          : {}),
        ...failureInsertFields,
        createdAt: updatedAt,
        updatedAt,
      });
    } else {
      await ctx.db.patch(existing[0]._id, {
        windowEnd,
        status,
        claimedAt,
        completedAt: undefined,
        error: status === "failed" ? "debug seeded failed synthesis" : undefined,
        ...failurePatchFields,
        updatedAt,
      });
    }

    if (!synthesisId) {
      throw new Error("Failed to seed stale synthesis");
    }

    return {
      synthesisId,
      period: args.period,
      timestamp: args.timestamp,
      claimedAt,
    };
  },
});

export const p7EnsureNoActivityOrg = internalMutation({
  args: {},
  handler: async (ctx) => {
    let org = await ctx.db
      .query("orgs")
      .withIndex("by_clerkOrgId", (q) =>
        q.eq("clerkOrgId", P7_NO_ACTIVITY_CLERK_ORG_ID),
      )
      .first();

    if (!org) {
      const orgId = await ctx.db.insert("orgs", {
        clerkOrgId: P7_NO_ACTIVITY_CLERK_ORG_ID,
        name: P7_NO_ACTIVITY_ORG_NAME,
      });
      org = await ctx.db.get(orgId);
    }

    if (!org) {
      throw new Error("Failed to create Part 7 no-activity org");
    }

    if (org.name !== P7_NO_ACTIVITY_ORG_NAME) {
      await ctx.db.patch(org._id, { name: P7_NO_ACTIVITY_ORG_NAME });
    }

    return {
      orgId: org._id,
      clerkOrgId: org.clerkOrgId,
    };
  },
});

export const p7ProbeSynthesisLifecycle = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    const fixtureSeed = await ctx.runMutation(p7SeedLinterSynthFixtureRef, {
      fixture: args.fixture,
    });
    const emptyOrg = await ctx.runMutation(p7EnsureNoActivityOrgRef, {});
    const baseNow = Date.now();
    const noActivityTimestamp = baseNow;
    const noActivityWindowEnd = noActivityTimestamp + 24 * 60 * 60 * 1000;
    const freshInProgressTimestamp =
      noActivityTimestamp + 24 * 60 * 60 * 1000;

    const firstClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: noActivityTimestamp,
      windowEnd: noActivityWindowEnd,
      now: baseNow,
    });
    const rowAfterClaim = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: firstClaim.synthesisId,
    });
    const actionResult = await ctx.runAction(p7RunSynthesisActionRef, {
      synthesisId: firstClaim.synthesisId,
    });
    const rowAfterAction = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: firstClaim.synthesisId,
    });
    const duplicateClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: noActivityTimestamp,
      windowEnd: noActivityWindowEnd,
      now: baseNow + 60 * 1000,
    });
    const freshClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: freshInProgressTimestamp,
      windowEnd: getP7WindowEnd("daily", freshInProgressTimestamp),
      now: baseNow,
    });
    const freshOverlap = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: freshInProgressTimestamp,
      windowEnd: getP7WindowEnd("daily", freshInProgressTimestamp),
      now: baseNow + 5 * 60 * 1000,
    });
    const failResult = await ctx.runMutation(p7FailSynthesisRef, {
      synthesisId: firstClaim.synthesisId,
      error:
        "Probe failure should not downgrade a completed synthesis row.",
    });
    const rowAfterFail = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: firstClaim.synthesisId,
    });

    assertP7Probe(
      firstClaim.status === "claimed",
      `Expected initial synthesis claim, got ${firstClaim.status}`,
    );
    assertP7Probe(
      rowAfterClaim?.status === "in_progress",
      `Expected claimed synthesis row to be in_progress, got ${
        rowAfterClaim?.status ?? null
      }`,
    );
    assertP7Probe(
      actionResult.status === "completed_no_activity",
      `Expected no-activity action completion, got ${actionResult.status}`,
    );
    assertP7Probe(
      rowAfterAction?.status === "completed",
      `Expected row after action to be completed, got ${
        rowAfterAction?.status ?? null
      }`,
    );
    assertP7Probe(
      rowAfterAction?.summary?.includes("No activity was captured") === true,
      "Expected row after action to store no-activity summary",
    );
    assertP7Probe(
      duplicateClaim.status === "skipped_completed",
      `Expected duplicate claim to skip completed row, got ${duplicateClaim.status}`,
    );
    assertP7Probe(
      freshClaim.status === "claimed",
      `Expected fresh in-progress seed claim, got ${freshClaim.status}`,
    );
    assertP7Probe(
      freshOverlap.status === "skipped_fresh_in_progress",
      `Expected fresh overlap to skip in-progress row, got ${freshOverlap.status}`,
    );
    assertP7Probe(
      failResult.status === "skipped_completed",
      `Expected failure write to skip completed row, got ${failResult.status}`,
    );
    assertP7Probe(
      rowAfterFail?.status === "completed",
      `Expected completed row to remain completed after failure write, got ${
        rowAfterFail?.status ?? null
      }`,
    );

    return {
      fixture: args.fixture,
      fixtureOrgId: fixtureSeed.orgId,
      noActivityOrgId: emptyOrg.orgId,
      claimInsert: {
        status: firstClaim.status,
        synthesisId: firstClaim.synthesisId,
        rowStatusAfterClaim: rowAfterClaim?.status ?? null,
      },
      actionFinalize: {
        status: actionResult.status,
        rowStatusAfterAction: rowAfterAction?.status ?? null,
        summary: rowAfterAction?.summary ?? null,
        noActivitySummary:
          rowAfterAction?.summary?.includes("No activity was captured") ?? false,
      },
      duplicateClaim: {
        status: duplicateClaim.status,
      },
      freshInProgressOverlap: {
        firstStatus: freshClaim.status,
        secondStatus: freshOverlap.status,
        synthesisId: freshClaim.synthesisId,
      },
      failDoesNotDowngradeCompleted: {
        failStatus: failResult.status,
        rowStatusAfterFail: rowAfterFail?.status ?? null,
      },
    };
  },
});

export const p7ProbeSynthesisStaleSweep = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(p7SeedLinterSynthFixtureRef, {
      fixture: args.fixture,
    });
    const emptyOrg = await ctx.runMutation(p7EnsureNoActivityOrgRef, {});
    const staleTimestamp = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const staleSeed = await ctx.runMutation(p7SeedStaleSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: staleTimestamp,
    });
    const beforeSweep = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: staleSeed.synthesisId,
    });
    const sweep = await ctx.runAction(p7SynthesisStaleSweepRef, {});

    let afterSweep = beforeSweep;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      afterSweep = await ctx.runQuery(p7GetSynthesisByIdRef, {
        synthesisId: staleSeed.synthesisId,
      });
      if (afterSweep?.status === "completed") {
        break;
      }
    }
    const reclaimedClaimAdvanced =
      (afterSweep?.claimedAt ?? 0) > (beforeSweep?.claimedAt ?? 0);
    const completedNoActivity =
      afterSweep?.summary?.includes("No activity was captured") ?? false;

    assertP7Probe(
      beforeSweep?.status === "in_progress",
      `Expected stale seed to start in_progress, got ${beforeSweep?.status ?? null}`,
    );
    assertP7Probe(
      beforeSweep?.claimedAt !== undefined,
      "Expected stale seed to include claimedAt before sweep",
    );
    assertP7Probe(
      sweep.staleFound >= 1,
      `Expected stale sweep to find at least one stale synthesis, got ${sweep.staleFound}`,
    );
    assertP7Probe(
      sweep.staleReclaimed >= 1,
      `Expected stale sweep to reclaim at least one synthesis, got ${sweep.staleReclaimed}`,
    );
    assertP7Probe(
      sweep.staleScheduled >= 1,
      `Expected stale sweep to schedule at least one synthesis, got ${sweep.staleScheduled}`,
    );
    assertP7Probe(
      reclaimedClaimAdvanced,
      `Expected stale sweep to advance claimedAt, got ${JSON.stringify({
        before: beforeSweep?.claimedAt ?? null,
        after: afterSweep?.claimedAt ?? null,
      })}`,
    );
    assertP7Probe(
      afterSweep?.status === "completed",
      `Expected stale synthesis to complete after sweep, got ${
        afterSweep?.status ?? null
      }`,
    );
    assertP7Probe(
      afterSweep?.completedAt !== undefined,
      "Expected stale synthesis to store completedAt after sweep",
    );
    assertP7Probe(
      completedNoActivity,
      "Expected stale sweep completion to store no-activity summary",
    );

    return {
      fixture: args.fixture,
      noActivityOrgId: emptyOrg.orgId,
      staleSeed,
      sweep,
      beforeSweep: {
        status: beforeSweep?.status ?? null,
        claimedAt: beforeSweep?.claimedAt ?? null,
      },
      afterSweep: {
        status: afterSweep?.status ?? null,
        claimedAt: afterSweep?.claimedAt ?? null,
        completedAt: afterSweep?.completedAt ?? null,
        summary: afterSweep?.summary ?? null,
      },
      reclaimedClaimAdvanced,
      completedNoActivity,
    };
  },
});

export const p7eProbeSynthesisClaimGuard = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.fixture !== P7E_FIXTURE) {
      throw new Error(
        `Unsupported Part 7e fixture ${args.fixture}; expected ${P7E_FIXTURE}`,
      );
    }

    const emptyOrg = await ctx.runMutation(p7EnsureNoActivityOrgRef, {});
    const baseNow = Date.now();
    const timestamp = baseNow + 7 * 24 * 60 * 60 * 1000;
    const windowEnd = getP7WindowEnd("daily", timestamp);
    const firstClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp,
      windowEnd,
      now: baseNow,
    });
    assertP7Probe(
      firstClaim.status === "claimed",
      `Expected first 7e claim to insert, got ${firstClaim.status}`,
    );

    const rowAfterFirstClaim = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: firstClaim.synthesisId,
    });
    const originalClaimedAt = rowAfterFirstClaim?.claimedAt;
    assertP7Probe(
      originalClaimedAt !== undefined,
      "7e claim guard probe expected claimedAt after first claim",
    );

    const reclaimNow = baseNow + 31 * 60 * 1000;
    const reclaimedClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp,
      windowEnd,
      now: reclaimNow,
    });
    assertP7Probe(
      reclaimedClaim.status === "reclaimed_stale",
      `Expected stale reclaim, got ${reclaimedClaim.status}`,
    );

    const staleFinalize = await ctx.runMutation(p7FinalizeSynthesisRef, {
      synthesisId: firstClaim.synthesisId,
      summary: "Stale action completion must not win after reclaim.",
      actors: [],
      repos: [],
      sourcePageIds: [],
      sourceSynthesisIds: [],
      warnings: [],
      expectedClaimedAt: originalClaimedAt,
    });
    assertP7Probe(
      staleFinalize.status === "skipped_stale_claim",
      `Expected stale finalize to be skipped, got ${staleFinalize.status}`,
    );

    const staleFailure = await ctx.runMutation(p7FailSynthesisRef, {
      synthesisId: firstClaim.synthesisId,
      error: "Stale action failure must not downgrade a reclaimed row.",
      expectedClaimedAt: originalClaimedAt,
    });
    assertP7Probe(
      staleFailure.status === "skipped_stale_claim",
      `Expected stale failure to be skipped, got ${staleFailure.status}`,
    );

    const rowAfterStaleWrites = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: firstClaim.synthesisId,
    });
    assertP7Probe(
      rowAfterStaleWrites?.status === "in_progress" &&
        rowAfterStaleWrites.claimedAt === reclaimNow,
      `Expected reclaimed row to stay in_progress, got ${JSON.stringify({
        status: rowAfterStaleWrites?.status ?? null,
        claimedAt: rowAfterStaleWrites?.claimedAt ?? null,
      })}`,
    );

    const replacementAction = await ctx.runAction(p7RunSynthesisActionRef, {
      synthesisId: firstClaim.synthesisId,
    });
    assertP7Probe(
      replacementAction.status === "completed_no_activity",
      `Expected replacement action to complete no-activity row, got ${replacementAction.status}`,
    );

    const rowAfterReplacement = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: firstClaim.synthesisId,
    });
    assertP7Probe(
      rowAfterReplacement,
      "Expected replacement synthesis row to exist",
    );
    assertP7Probe(
      rowAfterReplacement.status === "completed",
      `Expected replacement row to be completed, got ${rowAfterReplacement.status}`,
    );

    const duplicateFinalize = await ctx.runMutation(p7FinalizeSynthesisRef, {
      synthesisId: firstClaim.synthesisId,
      summary: rowAfterReplacement.summary ?? "",
      actors: rowAfterReplacement.actors ?? [],
      repos: rowAfterReplacement.repos ?? [],
      sourcePageIds: rowAfterReplacement.sourcePageIds ?? [],
      sourceSynthesisIds: rowAfterReplacement.sourceSynthesisIds ?? [],
      warnings: rowAfterReplacement.warnings ?? [],
      expectedClaimedAt: originalClaimedAt,
    });
    assertP7Probe(
      duplicateFinalize.status === "completed" &&
        duplicateFinalize.idempotent === true,
      `Expected duplicate completed finalize to be idempotent, got ${JSON.stringify(duplicateFinalize)}`,
    );

    const completedFailure = await ctx.runMutation(p7FailSynthesisRef, {
      synthesisId: firstClaim.synthesisId,
      error: "Completed row must not be downgraded by stale failure.",
      expectedClaimedAt: originalClaimedAt,
    });
    assertP7Probe(
      completedFailure.status === "skipped_completed",
      `Expected completed failure to be skipped, got ${completedFailure.status}`,
    );

    return {
      fixture: args.fixture,
      noActivityOrgId: emptyOrg.orgId,
      firstClaim,
      originalClaimedAt,
      reclaimedClaim,
      staleFinalize,
      staleFailure,
      rowAfterStaleWrites: {
        status: rowAfterStaleWrites?.status ?? null,
        claimedAt: rowAfterStaleWrites?.claimedAt ?? null,
      },
      replacementAction,
      rowAfterReplacement: {
        status: rowAfterReplacement.status,
        claimedAt: rowAfterReplacement.claimedAt ?? null,
        completedAt: rowAfterReplacement.completedAt ?? null,
        noActivitySummary:
          rowAfterReplacement.summary?.includes("No activity was captured") ??
          false,
      },
      duplicateFinalize,
      completedFailure,
    };
  },
});

export const p7ProbeFailedSynthesisRecovery = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(p7SeedLinterSynthFixtureRef, {
      fixture: args.fixture,
    });
    const emptyOrg = await ctx.runMutation(p7EnsureNoActivityOrgRef, {});
    const cleanup = await ctx.runMutation(p7ClearSynthesesForOrgRef, {
      orgId: emptyOrg.orgId,
    });
    const baseNow = Date.now();
    const retryableTimestamp = baseNow - 10 * 24 * 60 * 60 * 1000;
    const fatalTimestamp = retryableTimestamp + 60 * 1000;
    const capTimestamp = retryableTimestamp + 2 * 60 * 1000;
    const directFinalizeTimestamp = retryableTimestamp + 3 * 60 * 1000;

    const retryableSeed = await ctx.runMutation(p7SeedStaleSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: retryableTimestamp,
      status: "failed",
      failureKind: "transient_exhausted",
      retryCount: 1,
      nextRetryAt: baseNow - 60 * 1000,
      terminalFailure: false,
      updatedAt: retryableTimestamp,
    });
    const retryableBeforeSweep = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: retryableSeed.synthesisId,
    });
    const recoverySweep = await ctx.runAction(p7SynthesisStaleSweepRef, {});
    assertP7Probe(
      recoverySweep.failedFound === 1,
      `Expected one recoverable failed synthesis, got ${recoverySweep.failedFound}`,
    );
    assertP7Probe(
      recoverySweep.failedReclaimed === 1,
      `Expected one failed synthesis reclaimed, got ${recoverySweep.failedReclaimed}`,
    );
    assertP7Probe(
      recoverySweep.failedScheduled === 1,
      `Expected one failed synthesis scheduled, got ${recoverySweep.failedScheduled}`,
    );

    let retryableAfterSweep = retryableBeforeSweep;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      retryableAfterSweep = await ctx.runQuery(p7GetSynthesisByIdRef, {
        synthesisId: retryableSeed.synthesisId,
      });
      if (retryableAfterSweep?.status === "completed") {
        break;
      }
    }
    assertP7Probe(
      retryableAfterSweep?.status === "completed",
      `Expected retryable failed synthesis to complete, got ${retryableAfterSweep?.status ?? null}`,
    );
    assertP7Probe(
      retryableAfterSweep.summary?.includes("No activity was captured"),
      "Expected recovered failed synthesis to complete with no-activity summary",
    );
    assertP7Probe(
      (retryableAfterSweep.failureKind ?? null) === null &&
        (retryableAfterSweep.retryCount ?? null) === null &&
        (retryableAfterSweep.nextRetryAt ?? null) === null &&
        (retryableAfterSweep.terminalFailure ?? null) === null,
      "Expected recovered completed synthesis to clear failure metadata",
    );

    const directFinalizeSeed = await ctx.runMutation(p7SeedStaleSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: directFinalizeTimestamp,
      status: "failed",
      failureKind: "fatal",
      retryCount: 2,
      nextRetryAt: baseNow - 30 * 1000,
      terminalFailure: true,
      updatedAt: directFinalizeTimestamp,
    });
    const directFinalize = await ctx.runMutation(p7FinalizeSynthesisRef, {
      synthesisId: directFinalizeSeed.synthesisId,
      summary: "Manual completion should clear failure metadata.",
      actors: [],
      repos: [],
      sourcePageIds: [],
      sourceSynthesisIds: [],
      warnings: [],
    });
    assertP7Probe(
      directFinalize.status === "completed",
      `Expected direct failed synthesis finalization to complete, got ${directFinalize.status}`,
    );
    const directAfterFinalize = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: directFinalizeSeed.synthesisId,
    });
    assertP7Probe(
      directAfterFinalize?.status === "completed",
      `Expected direct finalized synthesis row to be completed, got ${directAfterFinalize?.status ?? null}`,
    );
    assertP7Probe(
      (directAfterFinalize.failureKind ?? null) === null &&
        (directAfterFinalize.retryCount ?? null) === null &&
        (directAfterFinalize.nextRetryAt ?? null) === null &&
        (directAfterFinalize.terminalFailure ?? null) === null,
      "Expected direct finalized synthesis to clear failure metadata",
    );

    const fatalSeed = await ctx.runMutation(p7SeedStaleSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: fatalTimestamp,
      status: "failed",
      failureKind: "fatal",
      retryCount: 1,
      terminalFailure: true,
      updatedAt: fatalTimestamp,
    });
    const capSeed = await ctx.runMutation(p7SeedStaleSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: capTimestamp,
      status: "failed",
      failureKind: "unexpected",
      retryCount: P7_SYNTHESIS_FAILED_MAX_RETRIES,
      terminalFailure: true,
      updatedAt: capTimestamp,
    });
    const terminalSweep = await ctx.runAction(p7SynthesisStaleSweepRef, {});
    assertP7Probe(
      terminalSweep.failedFound === 0,
      `Expected terminal failed syntheses to be skipped, got ${terminalSweep.failedFound}`,
    );

    const fatalAfterSweep = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: fatalSeed.synthesisId,
    });
    const capAfterSweep = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: capSeed.synthesisId,
    });
    assertP7Probe(
      fatalAfterSweep?.status === "failed" &&
        fatalAfterSweep.terminalFailure === true,
      "Expected fatal failed synthesis to remain terminal failed",
    );
    assertP7Probe(
      capAfterSweep?.status === "failed" &&
        capAfterSweep.terminalFailure === true,
      "Expected cap-exhausted failed synthesis to remain terminal failed",
    );

    return {
      fixture: args.fixture,
      noActivityOrgId: emptyOrg.orgId,
      cleanup,
      retryableSeed,
      retryableBeforeSweep: {
        status: retryableBeforeSweep?.status ?? null,
        failureKind: retryableBeforeSweep?.failureKind ?? null,
        retryCount: retryableBeforeSweep?.retryCount ?? null,
        nextRetryAt: retryableBeforeSweep?.nextRetryAt ?? null,
        terminalFailure: retryableBeforeSweep?.terminalFailure ?? null,
      },
      recoverySweep,
      retryableAfterSweep: {
        status: retryableAfterSweep?.status ?? null,
        claimedAt: retryableAfterSweep?.claimedAt ?? null,
        completedAt: retryableAfterSweep?.completedAt ?? null,
        summary: retryableAfterSweep?.summary ?? null,
        failureKind: retryableAfterSweep?.failureKind ?? null,
        retryCount: retryableAfterSweep?.retryCount ?? null,
        nextRetryAt: retryableAfterSweep?.nextRetryAt ?? null,
        terminalFailure: retryableAfterSweep?.terminalFailure ?? null,
        noActivitySummary:
          retryableAfterSweep?.summary?.includes("No activity was captured") ??
          false,
      },
      directFinalize,
      directAfterFinalize: {
        status: directAfterFinalize?.status ?? null,
        summary: directAfterFinalize?.summary ?? null,
        failureKind: directAfterFinalize?.failureKind ?? null,
        retryCount: directAfterFinalize?.retryCount ?? null,
        nextRetryAt: directAfterFinalize?.nextRetryAt ?? null,
        terminalFailure: directAfterFinalize?.terminalFailure ?? null,
      },
      terminalSweep,
      fatalAfterSweep: {
        status: fatalAfterSweep?.status ?? null,
        terminalFailure: fatalAfterSweep?.terminalFailure ?? null,
      },
      capAfterSweep: {
        status: capAfterSweep?.status ?? null,
        retryCount: capAfterSweep?.retryCount ?? null,
        terminalFailure: capAfterSweep?.terminalFailure ?? null,
      },
    };
  },
});

export const p7ProbeSynthesisDependencyReadiness = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(p7SeedLinterSynthFixtureRef, {
      fixture: args.fixture,
    });
    const emptyOrg = await ctx.runMutation(p7EnsureNoActivityOrgRef, {});
    const cleanup = await ctx.runMutation(p7ClearSynthesesForOrgRef, {
      orgId: emptyOrg.orgId,
    });

    const dayMs = 24 * 60 * 60 * 1000;
    const weeklyTimestamp = Date.UTC(2026, 4, 11, 0, 0, 0, 0);
    const weeklyWindowEnd = weeklyTimestamp + 7 * dayMs;
    const sundayTimestamp = weeklyTimestamp + 6 * dayMs;
    const runNow = weeklyWindowEnd + 60 * 60 * 1000;

    const sundaySeed = await ctx.runMutation(p7SeedStaleSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: sundayTimestamp,
      status: "in_progress",
      updatedAt: sundayTimestamp,
    });
    const weeklyReadinessBefore = await ctx.runQuery(
      p7GetSynthesisDependencyReadinessRef,
      {
        orgId: emptyOrg.orgId,
        period: "weekly",
        timestamp: weeklyTimestamp,
        windowEnd: weeklyWindowEnd,
      },
    );
    assertP7Probe(
      weeklyReadinessBefore.ready === false &&
        weeklyReadinessBefore.expectedCount === 7 &&
        weeklyReadinessBefore.inProgress.length === 1,
      `Expected weekly dependency readiness to block on in-progress daily, got ${JSON.stringify(weeklyReadinessBefore)}`,
    );

    const weeklyClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "weekly",
      timestamp: weeklyTimestamp,
      windowEnd: weeklyWindowEnd,
      now: runNow,
    });
    const weeklyDeferredAction = await ctx.runAction(p7RunSynthesisActionRef, {
      synthesisId: weeklyClaim.synthesisId,
    });
    const weeklyAfterDeferred = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: weeklyClaim.synthesisId,
    });
    assertP7Probe(
      weeklyDeferredAction.status === "failed" &&
        weeklyAfterDeferred?.status === "failed" &&
        !weeklyAfterDeferred.summary?.includes("No activity was captured") &&
        weeklyAfterDeferred.error?.includes("Dependency syntheses not ready"),
      "Expected weekly action to defer instead of completing no-activity",
    );

    const sundayFinalize = await ctx.runMutation(p7FinalizeSynthesisRef, {
      synthesisId: sundaySeed.synthesisId,
      summary: "Debug daily dependency summary: Sunday.",
      actors: [],
      repos: [],
      sourcePageIds: [],
      sourceSynthesisIds: [],
      warnings: [],
    });
    assertP7Probe(
      sundayFinalize.status === "completed",
      `Expected Sunday daily finalize to complete, got ${sundayFinalize.status}`,
    );
    const completedDailyIds: Id<"syntheses">[] = [sundaySeed.synthesisId];
    for (let offset = 0; offset < 6; offset += 1) {
      const timestamp = weeklyTimestamp + offset * dayMs;
      const daily = await p7ClaimAndFinalizeSynthesis(ctx, {
        orgId: emptyOrg.orgId,
        period: "daily",
        timestamp,
        summary: `Debug daily dependency summary: day ${offset + 1}.`,
      });
      completedDailyIds.push(daily._id);
    }

    const weeklyReadinessAfter = await ctx.runQuery(
      p7GetSynthesisDependencyReadinessRef,
      {
        orgId: emptyOrg.orgId,
        period: "weekly",
        timestamp: weeklyTimestamp,
        windowEnd: weeklyWindowEnd,
      },
    );
    assertP7Probe(
      weeklyReadinessAfter.ready === true &&
        weeklyReadinessAfter.completedCount === 7,
      `Expected weekly dependencies ready after daily completion, got ${JSON.stringify(weeklyReadinessAfter)}`,
    );

    const retryClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "weekly",
      timestamp: weeklyTimestamp,
      windowEnd: weeklyWindowEnd,
      now: (weeklyAfterDeferred?.nextRetryAt ?? runNow) + 1000,
    });
    assertP7Probe(
      retryClaim.status === "reclaimed_failed",
      `Expected weekly retry claim to reclaim failed row, got ${retryClaim.status}`,
    );
    const weeklyInputs = await ctx.runQuery(p7GetSynthesisInputsRef, {
      orgId: emptyOrg.orgId,
      period: "weekly",
      timestamp: weeklyTimestamp,
      windowEnd: weeklyWindowEnd,
      limit: 20,
    });
    assertP7Probe(
      weeklyInputs.lowerSyntheses.some(
        (synthesis) => synthesis._id === sundaySeed.synthesisId,
      ),
      "Expected weekly inputs to include the completed Sunday daily synthesis",
    );
    const weeklyFinalize = await ctx.runMutation(p7FinalizeSynthesisRef, {
      synthesisId: retryClaim.synthesisId,
      summary: "Debug weekly dependency summary.",
      actors: [],
      repos: [],
      sourcePageIds: [],
      sourceSynthesisIds: weeklyInputs.lowerSyntheses.map((synthesis) => synthesis._id),
      warnings: [],
    });
    assertP7Probe(
      weeklyFinalize.status === "completed",
      `Expected weekly deterministic finalize after dependencies, got ${weeklyFinalize.status}`,
    );
    const weeklyAfterComplete = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: retryClaim.synthesisId,
    });
    assertP7Probe(
      weeklyAfterComplete?.status === "completed" &&
        (weeklyAfterComplete.sourceSynthesisIds ?? []).includes(
          sundaySeed.synthesisId,
        ),
      "Expected weekly synthesis to complete with the completed daily source",
    );

    await ctx.runMutation(p7ClearSynthesesForOrgRef, {
      orgId: emptyOrg.orgId,
    });
    const terminalDaily = await ctx.runMutation(p7SeedStaleSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "daily",
      timestamp: sundayTimestamp,
      status: "failed",
      failureKind: "fatal",
      retryCount: 1,
      terminalFailure: true,
      updatedAt: sundayTimestamp,
    });
    const terminalClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "weekly",
      timestamp: weeklyTimestamp,
      windowEnd: weeklyWindowEnd,
      now: runNow + dayMs,
    });
    const terminalAction = await ctx.runAction(p7RunSynthesisActionRef, {
      synthesisId: terminalClaim.synthesisId,
    });
    const weeklyAfterTerminal = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: terminalClaim.synthesisId,
    });
    assertP7Probe(
      terminalAction.status === "failed" &&
        weeklyAfterTerminal?.status === "failed" &&
        weeklyAfterTerminal.failureKind === "fatal" &&
        weeklyAfterTerminal.terminalFailure === true,
      "Expected terminal lower dependency to terminally fail weekly synthesis",
    );

    await ctx.runMutation(p7ClearSynthesesForOrgRef, {
      orgId: emptyOrg.orgId,
    });
    const monthlyTimestamp = Date.UTC(2026, 4, 1, 0, 0, 0, 0);
    const monthlyWindowEnd = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
    const weeklyDependencyTimestamp = Date.UTC(2026, 4, 4, 0, 0, 0, 0);
    const monthlyWeeklySeed = await ctx.runMutation(p7SeedStaleSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "weekly",
      timestamp: weeklyDependencyTimestamp,
      status: "in_progress",
      updatedAt: weeklyDependencyTimestamp,
    });
    const monthlyReadiness = await ctx.runQuery(
      p7GetSynthesisDependencyReadinessRef,
      {
        orgId: emptyOrg.orgId,
        period: "monthly",
        timestamp: monthlyTimestamp,
        windowEnd: monthlyWindowEnd,
      },
    );
    assertP7Probe(
      monthlyReadiness.ready === false &&
        monthlyReadiness.expectedCount === 4 &&
        monthlyReadiness.inProgress.length === 1,
      `Expected monthly readiness to block on in-progress weekly, got ${JSON.stringify(monthlyReadiness)}`,
    );
    const monthlyClaim = await ctx.runMutation(p7ClaimSynthesisRef, {
      orgId: emptyOrg.orgId,
      period: "monthly",
      timestamp: monthlyTimestamp,
      windowEnd: monthlyWindowEnd,
      now: monthlyWindowEnd + 60 * 60 * 1000,
    });
    const monthlyAction = await ctx.runAction(p7RunSynthesisActionRef, {
      synthesisId: monthlyClaim.synthesisId,
    });
    const monthlyAfterDeferred = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: monthlyClaim.synthesisId,
    });
    assertP7Probe(
      monthlyAction.status === "failed" &&
        monthlyAfterDeferred?.status === "failed" &&
        !monthlyAfterDeferred.summary?.includes("No activity was captured"),
      "Expected monthly action to defer instead of completing no-activity",
    );

    await ctx.runMutation(p7ClearSynthesesForOrgRef, {
      orgId: emptyOrg.orgId,
    });
    const missingFanOut = await ctx.runAction(p7DebugWeeklySynthesisForOrgRef, {
      orgId: emptyOrg.orgId,
      now: Date.UTC(2026, 4, 19, 12, 0, 0, 0),
    });
    const weeklyMissingRow = await ctx.runQuery(p7GetSynthesisForOrgWindowRef, {
      orgId: emptyOrg.orgId,
      period: "weekly",
      timestamp: weeklyTimestamp,
    });
    assertP7Probe(
      weeklyMissingRow,
      "Expected fan-out to create a failed weekly dependency row",
    );
    const weeklyAfterMissing = await ctx.runQuery(p7GetSynthesisByIdRef, {
      synthesisId: weeklyMissingRow._id,
    });
    assertP7Probe(
      missingFanOut.deferredDependencies === 1 &&
        missingFanOut.scheduled === 0 &&
        weeklyAfterMissing?.status === "failed" &&
        !weeklyAfterMissing.summary?.includes("No activity was captured"),
      "Expected fan-out to defer weekly synthesis with missing lower dependencies",
    );

    return {
      fixture: args.fixture,
      noActivityOrgId: emptyOrg.orgId,
      cleanup,
      weeklyDefersInProgressDaily: {
        readiness: weeklyReadinessBefore,
        actionStatus: weeklyDeferredAction.status,
        rowStatus: weeklyAfterDeferred?.status ?? null,
        retryCount: weeklyAfterDeferred?.retryCount ?? null,
        nextRetryAt: weeklyAfterDeferred?.nextRetryAt ?? null,
        noActivitySummary:
          weeklyAfterDeferred?.summary?.includes("No activity was captured") ??
          false,
      },
      weeklyRunsAfterDailyComplete: {
        readiness: weeklyReadinessAfter,
        retryClaimStatus: retryClaim.status,
        finalizeStatus: weeklyFinalize.status,
        completedDailyCount: completedDailyIds.length,
        lowerInputCount: weeklyInputs.lowerSyntheses.length,
        includesSundayDaily:
          weeklyAfterComplete?.sourceSynthesisIds?.includes(
            sundaySeed.synthesisId,
          ) ?? false,
      },
      terminalDependencyBlocksHigher: {
        dependencySynthesisId: terminalDaily.synthesisId,
        actionStatus: terminalAction.status,
        rowStatus: weeklyAfterTerminal?.status ?? null,
        failureKind: weeklyAfterTerminal?.failureKind ?? null,
        terminalFailure: weeklyAfterTerminal?.terminalFailure ?? null,
      },
      monthlyDefersInProgressWeekly: {
        dependencySynthesisId: monthlyWeeklySeed.synthesisId,
        readiness: monthlyReadiness,
        actionStatus: monthlyAction.status,
        rowStatus: monthlyAfterDeferred?.status ?? null,
        noActivitySummary:
          monthlyAfterDeferred?.summary?.includes("No activity was captured") ??
          false,
      },
      missingDependencyDefers: {
        fanOut: missingFanOut,
        rowStatus: weeklyAfterMissing?.status ?? null,
        noActivitySummary:
          weeklyAfterMissing?.summary?.includes("No activity was captured") ??
          false,
      },
    };
  },
});

export const p7ProbeSynthesisOrgPagination = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    const prefix = getP7SynthesisPaginationPrefix(args.fixture);
    const targetClerkOrgId = getP7SynthesisPaginationClerkOrgId(
      prefix,
      P7_SYNTHESIS_PAGINATION_TARGET_ORDINAL,
    );

    const cleanupFixture = async () => {
      let deletedSyntheses = 0;
      let deletedOrgs = 0;
      for (let pass = 0; pass < 20; pass += 1) {
        const result = await ctx.runMutation(
          p7CleanupSynthesisPaginationFixtureBatchRef,
          {
            fixture: args.fixture,
            batchSize: P7_SYNTHESIS_PAGINATION_BATCH_SIZE,
          },
        );
        deletedSyntheses += result.deletedSyntheses;
        deletedOrgs += result.deletedOrgs;
        if (result.remaining === 0) {
          return { deletedSyntheses, deletedOrgs, passes: pass + 1 };
        }
      }
      throw new Error(`Failed to clean synthesis pagination fixture ${prefix}`);
    };

    const cleanupBefore = await cleanupFixture();

    let seeded = 0;
    let reused = 0;
    let targetOrgId: Id<"orgs"> | null = null;
    for (
      let startOrdinal = 1;
      startOrdinal <= P7_SYNTHESIS_PAGINATION_ORG_COUNT;
      startOrdinal += P7_SYNTHESIS_PAGINATION_BATCH_SIZE
    ) {
      const count = Math.min(
        P7_SYNTHESIS_PAGINATION_BATCH_SIZE,
        P7_SYNTHESIS_PAGINATION_ORG_COUNT - startOrdinal + 1,
      );
      const seedBatch = await ctx.runMutation(
        p7SeedSynthesisPaginationOrgsBatchRef,
        {
          fixture: args.fixture,
          prefix,
          startOrdinal,
          count,
        },
      );
      seeded += seedBatch.inserted;
      reused += seedBatch.reused;
      targetOrgId ??= seedBatch.targetOrgId;
    }

    if (!targetOrgId) {
      const targetOrg = await ctx.runQuery(p7GetOrgByClerkOrgIdRef, {
        clerkOrgId: targetClerkOrgId,
      });
      targetOrgId = targetOrg?.orgId ?? null;
    }
    assertP7Probe(targetOrgId, `Target org ${targetClerkOrgId} was not seeded`);

    const window = getP7LatestClosedDailyWindow();
    const beforeFanOut = await ctx.runQuery(p7GetSynthesisForOrgWindowRef, {
      orgId: targetOrgId,
      period: window.period,
      timestamp: window.timestamp,
    });
    assertP7Probe(
      beforeFanOut === null,
      "Expected target synthesis row to be absent before fan-out",
    );

    const fanOut = await ctx.runAction(p7DebugDailySynthesisForOrgRef, {
      orgId: targetOrgId,
    });
    assertP7Probe(
      fanOut.orgCount >= P7_SYNTHESIS_PAGINATION_ORG_COUNT,
      `Expected fan-out to scan at least ${P7_SYNTHESIS_PAGINATION_ORG_COUNT} orgs, scanned ${fanOut.orgCount}`,
    );
    assertP7Probe(
      fanOut.eligible === 1 && fanOut.scheduled === 1,
      `Expected target-only fan-out to schedule exactly one synthesis, got ${JSON.stringify({
        eligible: fanOut.eligible,
        scheduled: fanOut.scheduled,
      })}`,
    );

    let targetSynthesis = await ctx.runQuery(p7GetSynthesisForOrgWindowRef, {
      orgId: targetOrgId,
      period: window.period,
      timestamp: window.timestamp,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        targetSynthesis?.status === "completed" &&
        targetSynthesis.summary?.includes("No activity was captured")
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      targetSynthesis = await ctx.runQuery(p7GetSynthesisForOrgWindowRef, {
        orgId: targetOrgId,
        period: window.period,
        timestamp: window.timestamp,
      });
    }

    assertP7Probe(
      targetSynthesis,
      "Expected target synthesis row after paginated fan-out",
    );
    assertP7Probe(
      targetSynthesis.status === "completed",
      `Expected target synthesis to complete, got ${targetSynthesis.status}`,
    );
    assertP7Probe(
      targetSynthesis.summary?.includes("No activity was captured"),
      "Expected target synthesis to complete without provider activity",
    );

    const targetAfterFirstThousand =
      P7_SYNTHESIS_PAGINATION_TARGET_ORDINAL > 1000;
    const oldCappedPathWouldMissTarget =
      P7_SYNTHESIS_PAGINATION_TARGET_ORDINAL - 1 >= 1000;
    assertP7Probe(
      targetAfterFirstThousand && oldCappedPathWouldMissTarget,
      "Expected target ordinal to prove the old 1000-row cap would miss it",
    );

    const targetSynthesisSummary = {
      synthesisId: targetSynthesis._id,
      status: targetSynthesis.status,
      completedAt: targetSynthesis.completedAt ?? null,
      noActivitySummary:
        targetSynthesis.summary?.includes("No activity was captured") ?? false,
      sourcePageIds: targetSynthesis.sourcePageIds?.length ?? 0,
      sourceSynthesisIds: targetSynthesis.sourceSynthesisIds?.length ?? 0,
      inputTokensCached: targetSynthesis.inputTokensCached ?? null,
      inputTokensUncached: targetSynthesis.inputTokensUncached ?? null,
      outputTokens: targetSynthesis.outputTokens ?? null,
    };
    const cleanupAfter = await cleanupFixture();

    return {
      fixture: args.fixture,
      prefix,
      seeded,
      reused,
      cleanupBefore,
      target: {
        orgId: targetOrgId,
        clerkOrgId: targetClerkOrgId,
        fixtureOrdinal: P7_SYNTHESIS_PAGINATION_TARGET_ORDINAL,
        targetAfterFirstThousand,
        oldCappedPathWouldMissTarget,
      },
      window,
      fanOut,
      targetSynthesis: targetSynthesisSummary,
      cleanupAfter,
    };
  },
});

export const p7ProbeDeterministicLinter = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    const fixtureSeed = await ctx.runMutation(p7SeedLinterSynthFixtureRef, {
      fixture: args.fixture,
    });
    const expectedFindingSlugs = getP7DeterministicFindingSlugs(
      fixtureSeed.repairSlugs,
    );
    const expectedSlugList = Object.values(expectedFindingSlugs).sort((left, right) =>
      left.localeCompare(right),
    );

    const firstRun = await ctx.runAction(p7RunLinterForOrgRef, {
      orgId: fixtureSeed.orgId,
      now: P7_LINTER_PROBE_NOW,
    });
    assertP7Probe(
      JSON.stringify(firstRun.activeSlugs) === JSON.stringify(expectedSlugList),
      `Unexpected active linter slugs after first run: ${firstRun.activeSlugs.join(", ")}`,
    );

    const firstFindingPages = await listP7FindingPages(ctx, fixtureSeed.orgId);
    const firstDeterministicFindings = firstFindingPages.filter((page) =>
      page.slug.startsWith(P7_LINTER_FINDING_PREFIX),
    );
    assertP7Probe(
      firstDeterministicFindings.length === expectedSlugList.length,
      `Expected ${expectedSlugList.length} deterministic findings, found ${firstDeterministicFindings.length}`,
    );
    assertP7Probe(
      expectedSlugList.every((slug) =>
        firstDeterministicFindings.some((page) => page.slug === slug),
      ),
      "Missing expected deterministic linter finding pages after first run",
    );

    const firstRefCounts = {
      [expectedFindingSlugs.staleDecision]: await getP7RelatedRefCount(
        ctx,
        firstDeterministicFindings.find(
          (page) => page.slug === expectedFindingSlugs.staleDecision,
        )!._id,
        fixtureSeed.ids.pageIdsBySlug[fixtureSeed.repairSlugs.staleDecisionSlug]!,
      ),
      [expectedFindingSlugs.orphanPage]: await getP7RelatedRefCount(
        ctx,
        firstDeterministicFindings.find(
          (page) => page.slug === expectedFindingSlugs.orphanPage,
        )!._id,
        fixtureSeed.ids.pageIdsBySlug[fixtureSeed.repairSlugs.orphanPageSlug]!,
      ),
      [expectedFindingSlugs.weakProvenance]: await getP7RelatedRefCount(
        ctx,
        firstDeterministicFindings.find(
          (page) => page.slug === expectedFindingSlugs.weakProvenance,
        )!._id,
        fixtureSeed.ids.pageIdsBySlug[fixtureSeed.repairSlugs.weakProvenanceSlug]!,
      ),
    };
    assertP7Probe(
      Object.values(firstRefCounts).every((count) => count === 1),
      `Deterministic finding references were duplicated on first run: ${JSON.stringify(firstRefCounts)}`,
    );

    const secondRun = await ctx.runAction(p7RunLinterForOrgRef, {
      orgId: fixtureSeed.orgId,
      now: P7_LINTER_PROBE_NOW,
    });
    assertP7Probe(
      JSON.stringify(secondRun.activeSlugs) === JSON.stringify(expectedSlugList),
      `Unexpected active linter slugs after second run: ${secondRun.activeSlugs.join(", ")}`,
    );

    const secondFindingPages = await listP7FindingPages(ctx, fixtureSeed.orgId);
    const secondDeterministicFindings = secondFindingPages.filter((page) =>
      page.slug.startsWith(P7_LINTER_FINDING_PREFIX),
    );
    assertP7Probe(
      secondDeterministicFindings.length === expectedSlugList.length,
      `Expected ${expectedSlugList.length} deterministic findings after rerun, found ${secondDeterministicFindings.length}`,
    );

    const secondRefCounts = {
      [expectedFindingSlugs.staleDecision]: await getP7RelatedRefCount(
        ctx,
        secondDeterministicFindings.find(
          (page) => page.slug === expectedFindingSlugs.staleDecision,
        )!._id,
        fixtureSeed.ids.pageIdsBySlug[fixtureSeed.repairSlugs.staleDecisionSlug]!,
      ),
      [expectedFindingSlugs.orphanPage]: await getP7RelatedRefCount(
        ctx,
        secondDeterministicFindings.find(
          (page) => page.slug === expectedFindingSlugs.orphanPage,
        )!._id,
        fixtureSeed.ids.pageIdsBySlug[fixtureSeed.repairSlugs.orphanPageSlug]!,
      ),
      [expectedFindingSlugs.weakProvenance]: await getP7RelatedRefCount(
        ctx,
        secondDeterministicFindings.find(
          (page) => page.slug === expectedFindingSlugs.weakProvenance,
        )!._id,
        fixtureSeed.ids.pageIdsBySlug[fixtureSeed.repairSlugs.weakProvenanceSlug]!,
      ),
    };
    assertP7Probe(
      Object.values(secondRefCounts).every((count) => count === 1),
      `Deterministic finding references were duplicated on rerun: ${JSON.stringify(secondRefCounts)}`,
    );

    const existingFixtureFinding = secondFindingPages.find(
      (page) => page.slug === P7_FINDING_SLUG,
    );
    assertP7Probe(
      existingFixtureFinding?.findingStatus === "investigating",
      `Existing fixture finding ${P7_FINDING_SLUG} should remain investigating`,
    );

    return {
      fixture: args.fixture,
      orgId: fixtureSeed.orgId,
      probeNow: P7_LINTER_PROBE_NOW,
      expectedFindingSlugs: expectedSlugList,
      firstRun,
      secondRun,
      findingPages: secondDeterministicFindings.map((page) => ({
        slug: page.slug,
        findingType: page.findingType ?? null,
        findingStatus: page.findingStatus ?? null,
        severity: page.severity ?? null,
        tags: [...page.tags].sort((left, right) => left.localeCompare(right)),
      })),
      refCounts: secondRefCounts,
      existingFixtureFindingStatus: existingFixtureFinding?.findingStatus ?? null,
    };
  },
});

export const p7ProbeDeterministicLinterResolve = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    const fixtureSeed = await ctx.runMutation(p7SeedLinterSynthFixtureRef, {
      fixture: args.fixture,
    });
    const expectedFindingSlugs = getP7DeterministicFindingSlugs(
      fixtureSeed.repairSlugs,
    );
    const expectedSlugList = Object.values(expectedFindingSlugs).sort((left, right) =>
      left.localeCompare(right),
    );

    const initialRun = await ctx.runAction(p7RunLinterForOrgRef, {
      orgId: fixtureSeed.orgId,
      now: P7_LINTER_PROBE_NOW,
    });
    assertP7Probe(
      JSON.stringify(initialRun.activeSlugs) === JSON.stringify(expectedSlugList),
      `Expected deterministic findings before repair, got ${initialRun.activeSlugs.join(", ")}`,
    );

    const repairs = [
      await ctx.runMutation(p7RepairFixturePageRef, {
        orgId: fixtureSeed.orgId,
        slug: fixtureSeed.repairSlugs.staleDecisionSlug,
        repair: "confirm_decision",
      }),
      await ctx.runMutation(p7RepairFixturePageRef, {
        orgId: fixtureSeed.orgId,
        slug: fixtureSeed.repairSlugs.orphanPageSlug,
        repair: "add_inbound_reference",
      }),
      await ctx.runMutation(p7RepairFixturePageRef, {
        orgId: fixtureSeed.orgId,
        slug: fixtureSeed.repairSlugs.weakProvenanceSlug,
        repair: "add_attribution",
      }),
    ];

    const rerun = await ctx.runAction(p7RunLinterForOrgRef, {
      orgId: fixtureSeed.orgId,
      now: P7_LINTER_PROBE_NOW,
    });
    assertP7Probe(
      rerun.activeSlugs.length === 0,
      `Expected no active deterministic findings after repairs, got ${rerun.activeSlugs.join(", ")}`,
    );

    const findingPages = await listP7FindingPages(ctx, fixtureSeed.orgId);
    const resolvedFindings = expectedSlugList.map((slug) =>
      findingPages.find((page) => page.slug === slug),
    );
    assertP7Probe(
      resolvedFindings.every((page) => page?.findingStatus === "resolved"),
      "Expected repaired deterministic findings to be marked resolved",
    );

    const existingFixtureFinding = findingPages.find(
      (page) => page.slug === P7_FINDING_SLUG,
    );
    assertP7Probe(
      existingFixtureFinding?.findingStatus === "investigating",
      `Existing fixture finding ${P7_FINDING_SLUG} should remain investigating after repairs`,
    );

    return {
      fixture: args.fixture,
      orgId: fixtureSeed.orgId,
      probeNow: P7_LINTER_PROBE_NOW,
      initialRun,
      repairs,
      rerun,
      resolvedFindingStatuses: resolvedFindings.map((page) => ({
        slug: page?.slug ?? null,
        findingStatus: page?.findingStatus ?? null,
      })),
      existingFixtureFindingStatus: existingFixtureFinding?.findingStatus ?? null,
    };
  },
});

export const p7RepairAiContradictionFixture = internalMutation({
  args: {
    orgId: v.id("orgs"),
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.fixture !== P7_AI_FIXTURE) {
      throw new Error(
        `Unsupported Part 7 AI fixture ${args.fixture}; expected ${P7_AI_FIXTURE}`,
      );
    }
    const page = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_slug", (q) =>
        q.eq("orgId", args.orgId).eq("slug", P7_AI_LEFT_SLUG),
      )
      .first();
    if (!page) {
      throw new Error(`Part 7 AI fixture page ${P7_AI_LEFT_SLUG} was not found`);
    }

    const repairedAt = Date.now();
    await ctx.db.patch(page._id, {
      title: "Production checkout guardrail aligned",
      compiledTruth: P7_AI_REPAIRED_LEFT_TRUTH,
      evidenceTimeline: [
        {
          source: "Part 7 AI repair",
          channel: P7_AI_SOURCE_CHANNEL,
          timestamp: repairedAt,
          content: P7_AI_REPAIRED_LEFT_TRUTH,
        },
      ],
      lastConfirmed: repairedAt,
      updatedAt: repairedAt,
    });

    return {
      repairedSlug: P7_AI_LEFT_SLUG,
      action: "aligned" as const,
    };
  },
});

export const p7SetOrgAnthropicApiKey = internalMutation({
  args: {
    orgId: v.id("orgs"),
    apiKey: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (!org) {
      throw new Error(`Org ${args.orgId} was not found`);
    }
    await ctx.db.patch(args.orgId, {
      anthropicApiKey: args.apiKey === null ? undefined : args.apiKey,
    });
    return {
      orgId: args.orgId,
      hasApiKey: args.apiKey !== null,
    };
  },
});

export const p7SetFindingStatus = internalMutation({
  args: {
    orgId: v.id("orgs"),
    slug: v.string(),
    findingStatus: P7_FINDING_STATUS_VALIDATOR,
  },
  handler: async (ctx, args) => {
    const finding = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_slug", (q) =>
        q.eq("orgId", args.orgId).eq("slug", args.slug),
      )
      .first();
    if (!finding || finding.type !== "finding") {
      throw new Error(`Finding ${args.slug} was not found in org ${args.orgId}`);
    }
    await ctx.db.patch(finding._id, {
      findingStatus: args.findingStatus,
      updatedAt: Date.now(),
    });
    return {
      slug: args.slug,
      findingStatus: args.findingStatus,
    };
  },
});

export const p7ProbeAiContradictionLinter = internalAction({
  args: {
    fixture: v.string(),
  },
  handler: async (ctx, args) => {
    const fixtureSeed = await ctx.runMutation(p7SeedAiContradictionFixtureRef, {
      fixture: args.fixture,
    });
    const expectedSlug = fixtureSeed.expectedFindingSlug;
    const unmanagedFindingSlug = fixtureSeed.unmanagedFindingSlug;
    const leftPageId =
      fixtureSeed.ids.pageIdsBySlug[fixtureSeed.contradictionSlugs.left];
    const rightPageId =
      fixtureSeed.ids.pageIdsBySlug[fixtureSeed.contradictionSlugs.right];
    const hardNegativePageId =
      fixtureSeed.ids.pageIdsBySlug[fixtureSeed.contradictionSlugs.hardNegative];
    assertP7Probe(leftPageId, "Missing left AI contradiction source page id");
    assertP7Probe(rightPageId, "Missing right AI contradiction source page id");
    assertP7Probe(
      hardNegativePageId,
      "Missing hard-negative AI contradiction source page id",
    );

    const leftCandidate = makeP7AiCandidatePage({
      id: leftPageId,
      slug: P7_AI_LEFT_SLUG,
      title: "Production checkout guardrail disabled",
      type: "decision",
      compiledTruth:
        "The checkout rollback guardrail is disabled for all production checkout traffic. The team should continue the production rollout without automatic rollback protection.",
      tags: [
        P7_AI_FIXTURE_TAG,
        "area:checkout",
        "guardrail:rollback",
        "scope:production",
      ],
    });
    const rightCandidate = makeP7AiCandidatePage({
      id: rightPageId,
      slug: P7_AI_RIGHT_SLUG,
      title: "Production checkout guardrail enabled",
      type: "decision",
      compiledTruth:
        "The checkout rollback guardrail remains enabled for all production checkout traffic. Production checkout releases must keep automatic rollback protection active until error rates stay within target for seven consecutive days.",
      tags: [
        P7_AI_FIXTURE_TAG,
        "area:checkout",
        "guardrail:rollback",
        "scope:production",
      ],
    });
    const hardNegativeCandidate = makeP7AiCandidatePage({
      id: hardNegativePageId,
      slug: P7_AI_HARD_NEGATIVE_SLUG,
      title: "Mobile beta checkout guardrail stays enabled",
      type: "project",
      compiledTruth:
        "The mobile beta checkout guardrail remains enabled only for beta traffic. This page does not set the production web checkout rollback policy.",
      tags: [
        P7_AI_FIXTURE_TAG,
        "area:checkout",
        "guardrail:rollback",
        "scope:mobile-beta",
      ],
    });
    const deterministicContradictionPair = makeP7AiContradictionPair({
      left: leftCandidate,
      right: rightCandidate,
      overlapReason: "shared tags: area:checkout, guardrail:rollback",
    });
    const deterministicHardNegativePair = makeP7AiContradictionPair({
      left: leftCandidate,
      right: hardNegativeCandidate,
      overlapReason: "shared tags: area:checkout, guardrail:rollback",
    });
    const deterministicNormalization =
      debugNormalizeAiContradictionFindingsForTest({
        pairs: [deterministicContradictionPair, deterministicHardNegativePair],
        output: {
          contradictions: [
            {
              pairKey: deterministicContradictionPair.pairKey,
              severity: "high",
              confidence: "high",
              title: "Bad weak-evidence contradiction",
              claim:
                "This intentionally bad output omits a direct citation to the right page.",
              leftAssertion:
                "The production checkout rollback guardrail is disabled for all production traffic.",
              rightAssertion:
                "The production checkout rollback guardrail remains enabled for all production traffic.",
              incompatibility:
                "These policies cannot both be true now for the same production checkout flow.",
              implication:
                "Weakly cited contradictions must not become durable findings.",
              sameScope: true,
              sameScopeReason:
                "Both pages describe the same production checkout rollback guardrail policy for current production traffic.",
              currentConflict: true,
              canBothBeTrue: false,
              isStaleOrSuperseded: false,
              isHistoricalTransition: false,
              isMereDetailDifference: false,
              isWeakProvenanceOnly: false,
              notStaleOrSupersededReason:
                "Both pages are framed as current active production policy.",
              evidence: [
                `${P7_AI_LEFT_SLUG}: disabled for all production checkout traffic.`,
                "Uncited summary: another page supposedly says the opposite.",
              ],
            },
            {
              pairKey: deterministicHardNegativePair.pairKey,
              severity: "high",
              confidence: "high",
              title: "Bad scope-compatible contradiction",
              claim:
                "This intentionally bad output claims the mobile beta page contradicts the production page.",
              leftAssertion:
                "Production checkout has the rollback guardrail disabled for all production traffic.",
              rightAssertion:
                "Mobile beta checkout keeps the guardrail enabled for beta traffic only.",
              incompatibility:
                "The model incorrectly claims these policies are incompatible.",
              implication:
                "A sloppy model could misclassify scope differences as contradictions.",
              sameScope: true,
              sameScopeReason:
                "This is intentionally wrong and should be rejected because the scopes are different.",
              currentConflict: true,
              canBothBeTrue: false,
              isStaleOrSuperseded: false,
              isHistoricalTransition: false,
              isMereDetailDifference: false,
              isWeakProvenanceOnly: false,
              notStaleOrSupersededReason:
                "Both pages are current, but the pair is still not a real contradiction.",
              evidence: [
                `${P7_AI_LEFT_SLUG}: disabled for all production checkout traffic.`,
                `${P7_AI_HARD_NEGATIVE_SLUG}: enabled for beta traffic only.`,
              ],
            },
            {
              pairKey: deterministicContradictionPair.pairKey,
              severity: "high",
              confidence: "high",
              title: "Production guardrail policy conflict",
              claim:
                "The two production checkout pages make opposite current claims about whether the rollback guardrail is enabled.",
              leftAssertion:
                "The production checkout rollback guardrail is disabled for all production traffic.",
              rightAssertion:
                "The production checkout rollback guardrail remains enabled for all production traffic.",
              incompatibility:
                "These are opposite current production policy states for the same rollback guardrail, so they cannot both be true now.",
              implication:
                "Operators could deploy the wrong rollback policy for production checkout.",
              sameScope: true,
              sameScopeReason:
                "Both assertions target the same production checkout rollout scope.",
              currentConflict: true,
              canBothBeTrue: false,
              isStaleOrSuperseded: false,
              isHistoricalTransition: false,
              isMereDetailDifference: false,
              isWeakProvenanceOnly: false,
              notStaleOrSupersededReason:
                "Both pages are framed as current active production policy and neither page says it is outdated or replaced.",
              evidence: [
                `${P7_AI_LEFT_SLUG}: disabled for all production checkout traffic.`,
                `${P7_AI_RIGHT_SLUG}: enabled for all production checkout traffic.`,
              ],
            },
          ],
        },
      });
    assertP7Probe(
      deterministicNormalization.findings.length === 1 &&
        deterministicNormalization.findings[0]?.slug === expectedSlug,
      `Deterministic contradiction normalization should keep only ${expectedSlug}, got ${JSON.stringify(deterministicNormalization)}`,
    );
    assertP7Probe(
      deterministicNormalization.warnings.some((warning) =>
        warning.includes("explicit scope tags disagree"),
      ),
      `Expected deterministic normalization to reject scope mismatch, got ${JSON.stringify(deterministicNormalization.warnings)}`,
    );
    assertP7Probe(
      deterministicNormalization.warnings.some((warning) =>
        warning.includes("evidence must cite both source pages directly"),
      ),
      `Expected deterministic normalization to reject weak evidence, got ${JSON.stringify(deterministicNormalization.warnings)}`,
    );

    const firstRun = await ctx.runAction(p7RunLinterForOrgRef, {
      orgId: fixtureSeed.orgId,
      now: fixtureSeed.probeNow,
    });
    assertP7Probe(
      firstRun.contradictionStatus === "succeeded",
      `Expected first AI contradiction run to succeed, got ${firstRun.contradictionStatus}: ${firstRun.contradictionError ?? ""}`,
    );
    assertP7Probe(
      firstRun.contradictionCandidatePairs >= 2,
      `Expected at least two AI contradiction candidate pairs, got ${firstRun.contradictionCandidatePairs}`,
    );
    assertP7Probe(
      firstRun.contradiction === 1 &&
        firstRun.contradictionActiveSlugs[0] === expectedSlug,
      `Expected exactly one AI contradiction ${expectedSlug}, got ${firstRun.contradictionActiveSlugs.join(", ")}`,
    );

    const firstFindingPages = await listP7FindingPages(ctx, fixtureSeed.orgId);
    const firstAiFindings = firstFindingPages.filter(
      (page) =>
        page.sourceAgent === "linter" &&
        page.tags.includes("lint:ai") &&
        page.tags.includes("lint:contradiction"),
    );
    assertP7Probe(
      firstAiFindings.length === 2,
      `Expected one managed and one unmanaged AI contradiction finding, found ${firstAiFindings.length}`,
    );
    const firstFinding = firstAiFindings.find((page) => page.slug === expectedSlug);
    const firstUnmanagedFinding = firstAiFindings.find(
      (page) => page.slug === unmanagedFindingSlug,
    );
    assertP7Probe(firstFinding, `Expected managed AI contradiction ${expectedSlug}`);
    assertP7Probe(
      firstUnmanagedFinding?.findingStatus === "investigating",
      `Expected unmanaged AI contradiction ${unmanagedFindingSlug} to stay investigating, got ${firstUnmanagedFinding?.findingStatus}`,
    );
    assertP7Probe(
      firstFinding.slug === expectedSlug &&
        firstFinding.findingType === "contradiction" &&
        firstFinding.sourceAgent === "linter" &&
        firstFinding.findingStatus === "new",
      `Unexpected first AI contradiction finding shape: ${JSON.stringify({
        slug: firstFinding.slug,
        findingType: firstFinding.findingType,
        sourceAgent: firstFinding.sourceAgent,
        findingStatus: firstFinding.findingStatus,
      })}`,
    );
    const firstRefCounts = {
      left: await getP7RelatedRefCount(ctx, firstFinding._id, leftPageId),
      right: await getP7RelatedRefCount(ctx, firstFinding._id, rightPageId),
    };
    assertP7Probe(
      firstRefCounts.left === 1 && firstRefCounts.right === 1,
      `AI contradiction finding references were not exactly once on first run: ${JSON.stringify(firstRefCounts)}`,
    );

    await ctx.runMutation(p7SetFindingStatusRef, {
      orgId: fixtureSeed.orgId,
      slug: expectedSlug,
      findingStatus: "investigating",
    });
    const secondRun = await ctx.runAction(p7RunLinterForOrgRef, {
      orgId: fixtureSeed.orgId,
      now: fixtureSeed.probeNow,
    });
    assertP7Probe(
      secondRun.contradictionStatus === "succeeded" &&
        secondRun.contradiction === 1 &&
        secondRun.contradictionActiveSlugs[0] === expectedSlug,
      `Expected idempotent AI contradiction rerun, got ${JSON.stringify({
        status: secondRun.contradictionStatus,
        count: secondRun.contradiction,
        slugs: secondRun.contradictionActiveSlugs,
      })}`,
    );

    const secondFindingPages = await listP7FindingPages(ctx, fixtureSeed.orgId);
    const secondAiFindings = secondFindingPages.filter(
      (page) =>
        page.sourceAgent === "linter" &&
        page.tags.includes("lint:ai") &&
        page.tags.includes("lint:contradiction"),
    );
    assertP7Probe(
      secondAiFindings.length === 2,
      `Expected no duplicate managed AI contradiction findings after rerun, found ${secondAiFindings.length}`,
    );
    const secondFinding = secondAiFindings.find((page) => page.slug === expectedSlug);
    const secondUnmanagedFinding = secondAiFindings.find(
      (page) => page.slug === unmanagedFindingSlug,
    );
    assertP7Probe(secondFinding, `Expected rerun to keep managed slug ${expectedSlug}`);
    assertP7Probe(
      secondFinding.findingStatus === "investigating",
      `Expected open AI contradiction status to stay investigating, got ${secondFinding.findingStatus}`,
    );
    assertP7Probe(
      secondUnmanagedFinding?.findingStatus === "investigating",
      `Expected unmanaged AI contradiction ${unmanagedFindingSlug} to stay investigating after rerun, got ${secondUnmanagedFinding?.findingStatus}`,
    );
    const secondRefCounts = {
      left: await getP7RelatedRefCount(ctx, secondFinding._id, leftPageId),
      right: await getP7RelatedRefCount(ctx, secondFinding._id, rightPageId),
    };
    assertP7Probe(
      secondRefCounts.left === 1 && secondRefCounts.right === 1,
      `AI contradiction references were duplicated on rerun: ${JSON.stringify(secondRefCounts)}`,
    );

    const repair = await ctx.runMutation(p7RepairAiContradictionFixtureRef, {
      orgId: fixtureSeed.orgId,
      fixture: args.fixture,
    });

    await ctx.runMutation(p7SetOrgAnthropicApiKeyRef, {
      orgId: fixtureSeed.orgId,
      apiKey: "not-a-real-key-part7-contradiction-probe",
    });
    let failureRun: {
      contradictionStatus:
        | "succeeded"
        | "failed"
        | "skipped_no_candidates";
      contradictionError?: string;
    } | null = null;
    try {
      failureRun = await ctx.runAction(p7RunLinterForOrgRef, {
        orgId: fixtureSeed.orgId,
        now: fixtureSeed.probeNow,
      });
    } finally {
      await ctx.runMutation(p7SetOrgAnthropicApiKeyRef, {
        orgId: fixtureSeed.orgId,
        apiKey: null,
      });
    }
    assertP7Probe(failureRun, "Forced AI failure run did not return");
    assertP7Probe(
      failureRun.contradictionStatus === "failed",
      `Expected forced AI failure, got ${failureRun.contradictionStatus}`,
    );

    const afterFailureFindingPages = await listP7FindingPages(
      ctx,
      fixtureSeed.orgId,
    );
    const afterFailureFinding = afterFailureFindingPages.find(
      (page) => page.slug === expectedSlug,
    );
    const afterFailureUnmanagedFinding = afterFailureFindingPages.find(
      (page) => page.slug === unmanagedFindingSlug,
    );
    assertP7Probe(
      afterFailureFinding?.findingStatus === "investigating",
      `AI failure should not resolve existing contradiction finding; got ${afterFailureFinding?.findingStatus}`,
    );
    assertP7Probe(
      afterFailureUnmanagedFinding?.findingStatus === "investigating",
      `AI failure should not resolve unmanaged contradiction finding; got ${afterFailureUnmanagedFinding?.findingStatus}`,
    );

    const repairedRun = await ctx.runAction(p7RunLinterForOrgRef, {
      orgId: fixtureSeed.orgId,
      now: fixtureSeed.probeNow,
    });
    assertP7Probe(
      repairedRun.contradictionStatus === "succeeded",
      `Expected repaired AI contradiction run to succeed, got ${repairedRun.contradictionStatus}: ${repairedRun.contradictionError ?? ""}`,
    );
    assertP7Probe(
      repairedRun.contradiction === 0 &&
        repairedRun.contradictionResolvedSlugs.includes(expectedSlug),
      `Expected repaired run to resolve ${expectedSlug}, got ${JSON.stringify({
        count: repairedRun.contradiction,
        resolved: repairedRun.contradictionResolvedSlugs,
      })}`,
    );

    const finalFindingPages = await listP7FindingPages(ctx, fixtureSeed.orgId);
    const finalFinding = finalFindingPages.find(
      (page) => page.slug === expectedSlug,
    );
    const finalUnmanagedFinding = finalFindingPages.find(
      (page) => page.slug === unmanagedFindingSlug,
    );
    assertP7Probe(
      finalFinding?.findingStatus === "resolved",
      `Expected repaired AI contradiction finding to be resolved, got ${finalFinding?.findingStatus}`,
    );
    assertP7Probe(
      finalUnmanagedFinding?.findingStatus === "investigating",
      `Expected unmanaged AI contradiction finding to remain investigating, got ${finalUnmanagedFinding?.findingStatus}`,
    );

    return {
      fixture: args.fixture,
      orgId: fixtureSeed.orgId,
      probeNow: fixtureSeed.probeNow,
      expectedFindingSlug: expectedSlug,
      unmanagedFindingSlug,
      deterministicNormalization,
      firstRun,
      firstFinding: {
        slug: firstFinding.slug,
        findingType: firstFinding.findingType ?? null,
        findingStatus: firstFinding.findingStatus ?? null,
        sourceAgent: firstFinding.sourceAgent ?? null,
        tags: [...firstFinding.tags].sort((left, right) =>
          left.localeCompare(right),
        ),
      },
      firstRefCounts,
      secondRun,
      secondFindingStatus: secondFinding.findingStatus ?? null,
      secondRefCounts,
      repair,
      failureRun,
      afterFailureFindingStatus: afterFailureFinding?.findingStatus ?? null,
      afterFailureUnmanagedFindingStatus:
        afterFailureUnmanagedFinding?.findingStatus ?? null,
      repairedRun,
      finalFindingStatus: finalFinding?.findingStatus ?? null,
      finalUnmanagedFindingStatus: finalUnmanagedFinding?.findingStatus ?? null,
    };
  },
});

export const p7RepairFixturePage = internalMutation({
  args: {
    orgId: v.id("orgs"),
    slug: v.string(),
    repair: P7_REPAIR_VALIDATOR,
  },
  handler: async (ctx, args) => {
    const spec = getP7FixturePageBySlug(args.slug);
    const page = await ctx.db
      .query("knowledgePages")
      .withIndex("by_org_slug", (q) => q.eq("orgId", args.orgId).eq("slug", args.slug))
      .first();
    if (!page) {
      throw new Error(`Part 7 fixture page ${args.slug} was not found in org ${args.orgId}`);
    }

    if (args.repair === "add_attribution") {
      const sourceHash = await getP7SourceHash(spec);
      const source = await ctx.db
        .query("sources")
        .withIndex("by_hash", (q) => q.eq("orgId", args.orgId).eq("contentHash", sourceHash))
        .first();
      if (!source) {
        throw new Error(`Part 7 fixture source missing for ${args.slug}`);
      }
      const chunk = await ctx.db
        .query("sourceChunks")
        .withIndex("by_source", (q) => q.eq("sourceId", source._id).eq("chunkIndex", 0))
        .first();
      if (!chunk) {
        throw new Error(`Part 7 fixture chunk missing for ${args.slug}`);
      }

      const attributions = await ctx.db
        .query("sourceAttributions")
        .withIndex("by_source", (q) => q.eq("sourceId", source._id))
        .collect();
      const existingAttribution = attributions.find(
        (candidate) => candidate.pageId === page._id && candidate.chunkId === chunk._id,
      );
      const repairedAt = Date.now();
      let action: "created" | "updated" | "noop" = "noop";

      if (!existingAttribution) {
        await ctx.db.insert("sourceAttributions", {
          pageId: page._id,
          sourceId: source._id,
          chunkId: chunk._id,
          orgId: args.orgId,
          excerpt: spec.attributionExcerpt,
          createdAt: repairedAt,
        });
        action = "created";
      } else if (existingAttribution.excerpt !== spec.attributionExcerpt) {
        await ctx.db.patch(existingAttribution._id, {
          excerpt: spec.attributionExcerpt,
        });
        action = "updated";
      }

      await ctx.db.patch(page._id, {
        sourceCount: Math.max(page.sourceCount, 2),
        updatedAt: repairedAt,
      });

      return {
        pageId: page._id,
        slug: args.slug,
        repair: args.repair,
        action,
        sourceId: source._id,
        chunkId: chunk._id,
        sourceCount: Math.max(page.sourceCount, 2),
      };
    }

    if (args.repair === "add_inbound_reference") {
      const referenceType = "related_to" as const;
      const fromSlug =
        args.slug === P7_SESSION_ONE_SLUG ? P7_SESSION_TWO_SLUG : P7_SESSION_ONE_SLUG;
      const fromPage = await ctx.db
        .query("knowledgePages")
        .withIndex("by_org_slug", (q) => q.eq("orgId", args.orgId).eq("slug", fromSlug))
        .first();
      if (!fromPage) {
        throw new Error(`Part 7 fixture source page ${fromSlug} was not found`);
      }

      const existingReferences = await ctx.db
        .query("references")
        .withIndex("by_from", (q) =>
          q.eq("fromPageId", fromPage._id).eq("referenceType", referenceType),
        )
        .collect();
      const existingReference = existingReferences.find(
        (candidate) => candidate.toPageId === page._id,
      );
      const repairedAt = Date.now();
      const context = `Repair link from ${fromSlug} to ${args.slug} to clear the orphan-page probe.`;
      let action: "created" | "updated" | "noop" = "noop";

      if (!existingReference) {
        await ctx.db.insert("references", {
          orgId: args.orgId,
          fromPageId: fromPage._id,
          toPageId: page._id,
          referenceType,
          context,
          createdAt: repairedAt,
        });
        action = "created";
      } else if (existingReference.context !== context) {
        await ctx.db.patch(existingReference._id, { context });
        action = "updated";
      }

      return {
        pageId: page._id,
        slug: args.slug,
        repair: args.repair,
        action,
        fromPageId: fromPage._id,
      };
    }

    if (page.type !== "decision") {
      throw new Error(`confirm_decision requires a decision page; ${args.slug} is ${page.type}`);
    }

    const confirmedAt = Date.now();
    await ctx.db.patch(page._id, {
      lastConfirmed: confirmedAt,
      updatedAt: confirmedAt,
      tags: dedupeStrings([...page.tags, "decision:confirmed"]),
    });

    return {
      pageId: page._id,
      slug: args.slug,
      repair: args.repair as P7Repair,
      action: "confirmed",
      confirmedAt,
    };
  },
});

export const probeGithubTimestampExtraction = internalAction({
  args: {},
  handler: async () => {
    const controlledFallbackNow = Date.parse("2030-01-01T00:00:00.000Z");
    const cases = [
      {
        name: "pull_request.updated_at beats controlled now",
        event: "pull_request",
        body: {
          pull_request: {
            updated_at: "2024-01-02T03:04:05.000Z",
          },
        },
        expected: Date.parse("2024-01-02T03:04:05.000Z"),
      },
      {
        name: "push head_commit.timestamp wins",
        event: "push",
        body: {
          head_commit: {
            timestamp: "2024-02-03T04:05:06.000Z",
          },
          repository: {
            pushed_at: "2024-02-04T00:00:00.000Z",
          },
        },
        expected: Date.parse("2024-02-03T04:05:06.000Z"),
      },
      {
        name: "push commits timestamps use latest valid commit",
        event: "push",
        body: {
          head_commit: null,
          commits: [
            { timestamp: "2024-03-01T10:00:00.000Z" },
            { timestamp: "invalid" },
            { timestamp: "2024-03-01T12:00:00.000Z" },
          ],
        },
        expected: Date.parse("2024-03-01T12:00:00.000Z"),
      },
      {
        name: "invalid nested candidate falls through to valid update time",
        event: "pull_request",
        body: {
          action: "closed",
          pull_request: {
            merged_at: "not-a-date",
            closed_at: "",
            updated_at: "2024-04-05T06:07:08.000Z",
            created_at: "2024-04-01T00:00:00.000Z",
          },
        },
        expected: Date.parse("2024-04-05T06:07:08.000Z"),
      },
      {
        name: "no valid candidate uses controlled fallback now",
        event: "issues",
        body: {
          issue: {
            updated_at: "invalid",
            created_at: "",
          },
          repository: {
            updated_at: "also-invalid",
          },
        },
        expected: controlledFallbackNow,
      },
      {
        name: "numeric zero timestamp remains valid",
        event: "push",
        body: {
          head_commit: {
            timestamp: 0,
          },
        },
        expected: 0,
      },
    ];

    const results = cases.map((testCase) => {
      const actual = githubTimestamp(
        testCase.body,
        testCase.event,
        controlledFallbackNow,
      );
      if (actual !== testCase.expected) {
        throw new Error(
          `${testCase.name}: expected ${testCase.expected}, got ${actual}`,
        );
      }
      return {
        name: testCase.name,
        event: testCase.event,
        timestamp: actual,
        iso: new Date(actual).toISOString(),
      };
    });

    return {
      ok: true,
      cases: results,
      insertedEventTimestampProof:
        "insertGithubWebhookEvent passes githubTimestamp(args.body, args.githubEvent) directly to internal.spark.insertEvent.timestamp",
    };
  },
});
