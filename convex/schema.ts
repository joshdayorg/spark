import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const knowledgePageSnapshotValidator = v.object({
  orgId: v.id("orgs"),
  knowledgeBaseId: v.id("knowledgeBases"),
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
  title: v.string(),
  slug: v.string(),
  compiledTruth: v.string(),
  // LLM-written starter chip question + fuller chat prefill prompt (recent-signal chips).
  starterQuestion: v.optional(v.string()),
  starterPrompt: v.optional(v.string()),
  evidenceTimeline: v.array(
    v.object({
      source: v.string(),
      channel: v.string(),
      timestamp: v.number(),
      content: v.string(),
    }),
  ),
  entity: v.optional(v.string()),
  tags: v.array(v.string()),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
  lastConfirmed: v.number(),
  sourceCount: v.number(),
  identity: v.optional(v.object({ source: v.string(), gid: v.string() })),
  entityId: v.optional(v.id("entities")),
  severity: v.optional(
    v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
  ),
  findingType: v.optional(
    v.union(
      v.literal("contradiction"),
      v.literal("strategic_gap"),
      v.literal("resource_drift"),
      v.literal("emerging_capability"),
      v.literal("stale_decision"),
      v.literal("unanswered_question"),
      v.literal("blind_spot"),
    ),
  ),
  findingStatus: v.optional(
    v.union(
      v.literal("new"),
      v.literal("acknowledged"),
      v.literal("investigating"),
      v.literal("resolved"),
      v.literal("dismissed"),
    ),
  ),
  implication: v.optional(v.string()),
  sourceAgent: v.optional(v.string()),
  sourceRun: v.optional(v.string()),
  owner: v.optional(v.string()),
  targetDate: v.optional(v.number()),
  goalStatus: v.optional(
    v.union(
      v.literal("active"),
      v.literal("achieved"),
      v.literal("abandoned"),
    ),
  ),
  sessionId: v.optional(v.id("sessions")),
  actor: v.optional(v.string()),
  actorEntityId: v.optional(v.id("entities")),
  repo: v.optional(v.string()),
  sessionStartTime: v.optional(v.number()),
  sessionEndTime: v.optional(v.number()),
  eventCount: v.optional(v.number()),
  eventIds: v.optional(v.array(v.id("events"))),
  workType: v.optional(v.string()),
  complexity: v.optional(
    v.union(v.literal("low"), v.literal("moderate"), v.literal("high")),
  ),
  skills: v.optional(v.array(v.string())),
  associatedSessionIds: v.optional(v.array(v.id("sessions"))),
  knowledgePageIds: v.optional(v.array(v.id("knowledgePages"))),
  knowledgeBridgeStatus: v.optional(
    v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
    ),
  ),
  knowledgeBridgeAttemptedAt: v.optional(v.number()),
  knowledgeBridgeCompletedAt: v.optional(v.number()),
  knowledgeBridgeError: v.optional(v.string()),
  status: v.union(v.literal("draft"), v.literal("active"), v.literal("archived")),
  createdBy: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export default defineSchema({
  // events — all signals from all sources
  events: defineTable({
    orgId: v.id("orgs"),
    source: v.string(), // "github", "slack", "asana", "notion", "custom"
    via: v.union(
      v.literal("webhook"),
      v.literal("composio"),
      v.literal("api"),
    ),
    type: v.string(), // "push", "pull_request", "task_updated", "message"
    actor: v.string(), // Person name/ID from source
    actorRef: v.optional(v.object({ source: v.string(), gid: v.string() })), // Stable source identity for the actor when the source provides one.
    actorEntityId: v.optional(v.id("entities")), // Canonical entity for the actor after identity resolution.
    actorIdentityResolvedAt: v.optional(v.number()), // Resolution checkpoint; set even when no canonical entity is created.
    summary: v.string(), // One-line human-readable description
    timestamp: v.number(), // Source timestamp (when it happened)
    sourceDeliveryId: v.optional(v.string()), // Stable provider delivery/redelivery ID
    raw: v.any(), // Full original payload
    processed: v.optional(v.boolean()), // Optional until legacy rows are backfilled; undefined is unprocessed
    claimedAt: v.optional(v.number()),
    // Set on coalescible field-edit bursts (classifyEvent.coalesceKeyFor): a
    // burst of edits to the same field of the same object within a time window
    // shares this key, so insertEvent keeps only the first. Absent on
    // substantive/discrete events. Tool-agnostic burst suppression.
    coalesceKey: v.optional(v.string()),
  })
    .index("by_org", ["orgId", "timestamp"])
    .index("by_org_unprocessed", ["orgId", "processed", "timestamp"])
    .index("by_org_source", ["orgId", "source", "timestamp"])
    .index("by_org_actor", ["orgId", "actor", "timestamp"])
    .index("by_org_actorEntity", ["orgId", "actorEntityId", "timestamp"])
    .index("by_org_source_via_delivery", [
      "orgId",
      "source",
      "via",
      "sourceDeliveryId",
    ])
    .index("by_org_source_coalesce", ["orgId", "source", "coalesceKey"]),

  // entities — canonical org-scoped actors linked from source aliases and team members.
  entities: defineTable({
    orgId: v.id("orgs"),
    kind: v.union(
      v.literal("person"),
      v.literal("project"),
      v.literal("bot"),
      v.literal("system"),
      v.literal("shared"),
      v.literal("unknown"),
    ),
    displayName: v.string(),
    photoUrl: v.optional(v.string()),
    emails: v.array(v.string()),
    teamMemberId: v.optional(v.id("teamMembers")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_kind_displayName", ["orgId", "kind", "displayName"])
    .index("by_org_teamMember", ["orgId", "teamMemberId"]),

  // identityCache — resolved name+photo for opaque source ids (gid->name/photo), per org. Refreshed on a TTL by the resolveIdentities action.
  identityCache: defineTable({
    orgId: v.id("orgs"),
    source: v.string(),
    gid: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    photoUrl: v.optional(v.string()),
    entityId: v.optional(v.id("entities")),
    fetchedAt: v.number(),
  })
    .index("by_org_source_gid", ["orgId", "source", "gid"])
    .index("by_org_email", ["orgId", "email"])
    .index("by_org_name", ["orgId", "name"])
    .index("by_entity", ["entityId"]),

  // sessions — clustered work sessions
  sessions: defineTable({
    orgId: v.id("orgs"),
    actor: v.string(),
    actorEntityId: v.optional(v.id("entities")),
    repo: v.optional(v.string()),
    title: v.string(), // AI-generated
    startTime: v.number(),
    endTime: v.optional(v.number()),
    eventCount: v.number(),
    status: v.union(v.literal("active"), v.literal("complete")),
    eventIds: v.optional(v.array(v.id("events"))),
  })
    .index("by_org", ["orgId", "startTime"])
    .index("by_org_actor", ["orgId", "actor", "startTime"])
    .index("by_org_actorEntity", ["orgId", "actorEntityId", "startTime"])
    .index("by_org_status", ["orgId", "status", "startTime"])
    .index("by_status_startTime", ["status", "startTime"]),

  // sessionScores — scoring results (dimensions TBD, scored by customer agent)
  sessionScores: defineTable({
    orgId: v.id("orgs"),
    sessionId: v.id("sessions"),
    scorerVersion: v.optional(v.string()),
    scores: v.optional(v.any()),
    summary: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    scoredAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_org", ["orgId", "scoredAt"]),

  // orgs — multi-tenancy and org config
  orgs: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    logo: v.optional(v.string()),
    plan: v.optional(v.string()),
    billingStatus: v.optional(v.string()),
    anthropicApiKey: v.optional(v.string()),
    anthropicEnvironmentId: v.optional(v.string()),
    composioApiKey: v.optional(v.string()),
    githubInstallationId: v.optional(v.number()),
  })
    .index("by_clerkOrgId", ["clerkOrgId"])
    .index("by_githubInstallationId", ["githubInstallationId"]),

  // teamMembers — people in the org (synced from Clerk)
  teamMembers: defineTable({
    orgId: v.id("orgs"),
    clerkUserId: v.string(),
    name: v.string(),
    email: v.string(),
    role: v.union(
      v.literal("admin"),
      v.literal("member"),
      v.literal("viewer"),
    ),
    githubLogin: v.optional(v.string()),
    clerkMembershipId: v.optional(v.string()),
    clerkMembershipUpdatedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_clerkUser", ["orgId", "clerkUserId"])
    .index("by_org_email", ["orgId", "email"])
    .index("by_org_github", ["orgId", "githubLogin"])
    .index("by_clerkUserId", ["clerkUserId"]),

  // clerkMembershipSyncStates — durable ordering state for async Clerk membership webhooks
  clerkMembershipSyncStates: defineTable({
    orgId: v.id("orgs"),
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    clerkMembershipId: v.string(),
    status: v.union(v.literal("active"), v.literal("deleted")),
    sourceUpdatedAt: v.number(),
  })
    .index("by_clerkOrg_user", ["clerkOrgId", "clerkUserId"])
    .index("by_membershipId", ["clerkMembershipId"]),

  // apiKeys — org-scoped API keys for HTTP API and MCP
  apiKeys: defineTable({
    orgId: v.id("orgs"),
    keyHash: v.string(), // SHA-256 hash. Plaintext shown once.
    keyPrefix: v.string(), // First 8 chars for display
    label: v.string(),
    createdAt: v.number(),
    createdBy: v.string(),
    revokedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_keyHash", ["keyHash"]),

  // mcpRateLimits — per-API-key MCP minute buckets
  mcpRateLimits: defineTable({
    orgId: v.id("orgs"),
    apiKeyId: v.id("apiKeys"),
    bucket: v.string(),
    toolClass: v.union(v.literal("read"), v.literal("write"), v.literal("ask")),
    count: v.number(),
    windowStart: v.number(),
    updatedAt: v.number(),
  })
    .index("by_apiKey", ["apiKeyId"])
    .index("by_apiKey_bucket", ["apiKeyId", "bucket"])
    .index("by_org_updated", ["orgId", "updatedAt"]),

  // threadOrgs — maps @convex-dev/agent threads to orgs and users
  threadOrgs: defineTable({
    threadId: v.string(),
    orgId: v.id("orgs"),
    userId: v.string(),
    purpose: v.union(v.literal("chat"), v.literal("pulse")),
    lastVisitAt: v.optional(v.number()),
    createdAt: v.number(),
    // Short title for the chat-history list: AI-generated from the first message
    // on send, or set manually via renameThread.
    title: v.optional(v.string()),
  })
    .index("by_org_user", ["orgId", "userId", "createdAt"])
    .index("by_org_purpose_user", ["orgId", "purpose", "userId"])
    .index("by_threadId", ["threadId"]),

  // knowledgeBases — org-scoped knowledge base container (one per org)
  knowledgeBases: defineTable({
    orgId: v.id("orgs"),
    name: v.string(), // Default: "Knowledge Base"
    description: v.optional(v.string()),
    pageCount: v.number(), // Denormalized count
    sourceCount: v.number(), // Denormalized count
    lastIngestAt: v.optional(v.number()), // Last time a source was ingested
    createdAt: v.number(),
  }).index("by_org", ["orgId"]),

  // knowledgePages — the knowledge base (9 types, Compiled Truth + Evidence Timeline)
  knowledgePages: defineTable({
    orgId: v.id("orgs"),
    knowledgeBaseId: v.id("knowledgeBases"),
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
    title: v.string(),
    slug: v.string(),
    compiledTruth: v.string(), // Markdown — rewritable AI synthesis
    // LLM-written starter chip question + fuller chat prefill prompt (recent-signal chips).
    starterQuestion: v.optional(v.string()),
    starterPrompt: v.optional(v.string()),
    evidenceTimeline: v.array(
      v.object({
        source: v.string(), // Who/what contributed this evidence
        channel: v.string(), // Where it came from
        timestamp: v.number(), // When
        content: v.string(), // The evidence itself
      }),
    ),
    entity: v.optional(v.string()), // Entity name (for entity/project profiles)
    identity: v.optional(v.object({ source: v.string(), gid: v.string() })), // Set for entity/project pages so the UI can resolve name+photo
    entityId: v.optional(v.id("entities")),
    tags: v.array(v.string()),
    confidence: v.union(
      v.literal("high"),
      v.literal("medium"),
      v.literal("low"),
    ),
    lastConfirmed: v.number(),
    sourceCount: v.number(),

    // Finding-only fields (type: "finding")
    severity: v.optional(
      v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    ),
    findingType: v.optional(
      v.union(
        v.literal("contradiction"),
        v.literal("strategic_gap"),
        v.literal("resource_drift"),
        v.literal("emerging_capability"),
        v.literal("stale_decision"),
        v.literal("unanswered_question"),
        v.literal("blind_spot"),
      ),
    ),
    findingStatus: v.optional(
      v.union(
        v.literal("new"),
        v.literal("acknowledged"),
        v.literal("investigating"),
        v.literal("resolved"),
        v.literal("dismissed"),
      ),
    ),
    implication: v.optional(v.string()),
    sourceAgent: v.optional(v.string()),
    sourceRun: v.optional(v.string()), // External/component run reference.

    // Goal-only fields (type: "goal")
    owner: v.optional(v.string()),
    targetDate: v.optional(v.number()),
    goalStatus: v.optional(
      v.union(
        v.literal("active"),
        v.literal("achieved"),
        v.literal("abandoned"),
      ),
    ),

    // Session-only fields (type: "session")
    sessionId: v.optional(v.id("sessions")),
    actor: v.optional(v.string()),
    actorEntityId: v.optional(v.id("entities")),
    repo: v.optional(v.string()),
    sessionStartTime: v.optional(v.number()),
    sessionEndTime: v.optional(v.number()),
    eventCount: v.optional(v.number()),
    eventIds: v.optional(v.array(v.id("events"))),
    workType: v.optional(v.string()),
    complexity: v.optional(
      v.union(
        v.literal("low"),
        v.literal("moderate"),
        v.literal("high"),
      ),
    ),
    skills: v.optional(v.array(v.string())),
    associatedSessionIds: v.optional(v.array(v.id("sessions"))),
    knowledgePageIds: v.optional(v.array(v.id("knowledgePages"))),
    knowledgeBridgeStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
    knowledgeBridgeAttemptedAt: v.optional(v.number()),
    knowledgeBridgeCompletedAt: v.optional(v.number()),
    knowledgeBridgeError: v.optional(v.string()),

    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    createdBy: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_type", ["orgId", "type", "updatedAt"])
    .index("by_type_status_updatedAt", ["type", "status", "updatedAt"])
    .index("by_org_type_status_updatedAt", ["orgId", "type", "status", "updatedAt"])
    .index("by_org_type_status_createdAt", ["orgId", "type", "status", "createdAt"])
    .index("by_org_type_status_lastConfirmed", ["orgId", "type", "status", "lastConfirmed"])
    .index("by_org_type_status_sessionEndTime", ["orgId", "type", "status", "sessionEndTime"])
    .index("by_org_type_status_targetDate", ["orgId", "type", "status", "targetDate"])
    .index("by_org_type_status_severity_updatedAt", ["orgId", "type", "status", "severity", "updatedAt"])
    .index("by_org_slug", ["orgId", "slug"])
    .index("by_org_sessionId", ["orgId", "sessionId"])
    .index("by_org_status", ["orgId", "status", "updatedAt"])
    .index("by_org_entity", ["orgId", "entityId"])
    .index("by_org_actorEntity", ["orgId", "actorEntityId"])
    .index("by_kb", ["knowledgeBaseId", "status"])
    .searchIndex("search_pages", {
      searchField: "compiledTruth",
      filterFields: ["orgId", "type", "status"],
    }),

  // pageVersions — version history for knowledge pages
  pageVersions: defineTable({
    pageId: v.id("knowledgePages"),
    orgId: v.id("orgs"),
    title: v.string(),
    content: v.string(),
    changeReason: v.optional(v.string()),
    changedBy: v.string(), // "system" or Clerk user ID
    sourceIds: v.optional(v.array(v.id("sources"))),
    snapshot: v.optional(knowledgePageSnapshotValidator), // Legacy rows may predate full snapshots.
    version: v.number(), // Monotonically increasing
    createdAt: v.number(),
  })
    .index("by_page", ["pageId", "version"])
    .index("by_org", ["orgId"]),

  // references — bidirectional cross-references between knowledge pages
  references: defineTable({
    orgId: v.id("orgs"),
    fromPageId: v.id("knowledgePages"),
    toPageId: v.id("knowledgePages"),
    referenceType: v.union(
      v.literal("mentions"),
      v.literal("depends_on"),
      v.literal("contradicts"),
      v.literal("supersedes"),
      v.literal("part_of"),
      v.literal("related_to"),
    ),
    context: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_from", ["fromPageId", "referenceType"])
    .index("by_to", ["toPageId", "referenceType"])
    .index("by_org_type", ["orgId", "referenceType"]),

  // knowledgePageEvidence — append-only page evidence outside bounded page docs
  knowledgePageEvidence: defineTable({
    pageId: v.id("knowledgePages"),
    orgId: v.id("orgs"),
    source: v.string(),
    channel: v.string(),
    timestamp: v.number(),
    content: v.string(),
    evidenceKey: v.string(),
    createdAt: v.number(),
  })
    .index("by_page", ["pageId", "createdAt"])
    .index("by_page_key", ["pageId", "evidenceKey"])
    .index("by_org", ["orgId"]),

  // sourceAttributions — provenance: every claim traces to a source
  sourceAttributions: defineTable({
    pageId: v.id("knowledgePages"),
    sourceId: v.id("sources"),
    chunkId: v.optional(v.id("sourceChunks")), // Chunk-level provenance (when known)
    orgId: v.id("orgs"),
    excerpt: v.string(),
    createdAt: v.number(),
  })
    .index("by_page", ["pageId"])
    .index("by_source", ["sourceId"])
    .index("by_source_created", ["sourceId", "createdAt"])
    .index("by_chunk", ["chunkId"])
    .index("by_org", ["orgId"]),

  // sessionEvents — append-only session/event membership outside bounded parent docs
  sessionEvents: defineTable({
    sessionId: v.id("sessions"),
    orgId: v.id("orgs"),
    eventId: v.id("events"),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId", "createdAt"])
    .index("by_session_event", ["sessionId", "eventId"])
    .index("by_event", ["eventId"])
    .index("by_org", ["orgId"]),

  // sources — ingested content (URLs, files, pastes, sessions, enrichments)
  sources: defineTable({
    orgId: v.id("orgs"),
    knowledgeBaseId: v.id("knowledgeBases"),
    title: v.string(),
    sourceType: v.union(
      v.literal("url"),
      v.literal("file"),
      v.literal("paste"),
      v.literal("session"),
      v.literal("enrichment"),
    ),
    url: v.optional(v.string()),
    fileId: v.optional(v.string()),
    content: v.optional(v.string()),
    contentHash: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("processed"),
    ),
    sessionId: v.optional(v.id("sessions")),
    // When the underlying activity actually happened (e.g. a session's end
    // time), distinct from createdAt (when the source row was written). Used to
    // backdate evidence dates for backfilled/historical content.
    occurredAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org_status", ["orgId", "status", "createdAt"])
    .index("by_kb", ["knowledgeBaseId", "status"])
    .index("by_session", ["sessionId"])
    .index("by_session_created", ["sessionId", "createdAt"])
    .index("by_hash", ["orgId", "contentHash"]),

  // sourceChunks — chunked content with contextual prefixes for search
  sourceChunks: defineTable({
    sourceId: v.id("sources"),
    orgId: v.id("orgs"),
    chunkIndex: v.number(), // Order within the source
    content: v.string(), // Raw chunk content
    contextPrefix: v.optional(v.string()), // 50-100 tokens of LLM-generated context (K-12)
    searchableText: v.optional(v.string()), // Context prefix + raw content for BM25 retrieval; optional during legacy backfill.
    tokenCount: v.number(), // Required — token count for this chunk
  })
    .index("by_source", ["sourceId", "chunkIndex"])
    .index("by_org", ["orgId"])
    .searchIndex("search_content", {
      searchField: "searchableText",
      filterFields: ["orgId"],
    }),

  // ingestJobs — knowledge pipeline state machine (one job per source)
  ingestJobs: defineTable({
    orgId: v.id("orgs"),
    sourceId: v.id("sources"),
    knowledgeBaseId: v.id("knowledgeBases"),
    status: v.union(
      v.literal("pending"),
      v.literal("chunking"),
      v.literal("extracting"),
      v.literal("synthesizing"),
      v.literal("cross_referencing"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    currentStep: v.optional(v.string()), // Human-readable step description
    progress: v.optional(
      v.object({
        entitiesExtracted: v.number(),
        pagesCreated: v.number(),
        pagesUpdated: v.number(),
        referencesCreated: v.number(),
      }),
    ),
    error: v.optional(v.string()),
    extractionLeaseVersion: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_source", ["sourceId"])
    .index("by_source_created", ["sourceId", "createdAt"]),

  // agentDefinitions — customer agent configs (spec/data-model.md Phase 3,
  // ux/agents.md). System agents (extractor/synthesizer/linter/Spark Mind)
  // are NOT stored here — they live in source code.
  agentDefinitions: defineTable({
    orgId: v.id("orgs"),
    name: v.string(),
    description: v.string(),
    instructions: v.string(),
    modelTier: v.union(v.literal("fast"), v.literal("thorough")),
    // "hourly" | "daily" | "weekly" | "every <N>m" | "every <N>h". Parsed by
    // computeNextRunAt in agents.ts; unparseable schedules stay unscheduled.
    schedule: v.optional(v.string()),
    delivery: v.optional(
      v.object({
        channel: v.string(),
        target: v.string(),
        condition: v.optional(v.string()),
      }),
    ),
    rubric: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("errored"),
      v.literal("archived"),
    ),
    anthropicAgentId: v.optional(v.string()),
    anthropicEnvironmentId: v.optional(v.string()),
    version: v.number(),
    // Bounded rollback history (U-38): last snapshots of editable config,
    // newest last, capped in code (AGENT_VERSION_HISTORY_LIMIT).
    versionHistory: v.optional(
      v.array(
        v.object({
          version: v.number(),
          name: v.string(),
          description: v.string(),
          instructions: v.string(),
          modelTier: v.union(v.literal("fast"), v.literal("thorough")),
          schedule: v.optional(v.string()),
          rubric: v.optional(v.string()),
          savedAt: v.number(),
        }),
      ),
    ),
    // Scheduling substrate (api.md Pipe 4 "cron fires matching schedules").
    nextRunAt: v.optional(v.number()),
    lastRunAt: v.optional(v.number()),
    consecutiveFailures: v.optional(v.number()),
    // U-51 cost controls: per-agent monthly cap + alert threshold (cents).
    monthlyBudgetCents: v.optional(v.number()),
    budgetAlertCents: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId", "status"])
    .index("by_org_name", ["orgId", "name"])
    .index("by_status_nextRunAt", ["status", "nextRunAt"]),

  // agentRuns — run history per customer agent (spec/data-model.md Phase 3).
  agentRuns: defineTable({
    orgId: v.id("orgs"),
    agentDefinitionId: v.id("agentDefinitions"),
    anthropicSessionId: v.optional(v.string()),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    outcome: v.optional(
      v.union(
        v.literal("satisfied"),
        v.literal("failed"),
        v.literal("needs_revision"),
      ),
    ),
    startTime: v.number(),
    endTime: v.optional(v.number()),
    duration: v.optional(v.number()),
    outputText: v.optional(v.string()),
    tokenUsage: v.optional(
      v.object({
        inputTokens: v.number(),
        outputTokens: v.number(),
        cacheReadInputTokens: v.optional(v.number()),
        cacheCreationInputTokens: v.optional(v.number()),
      }),
    ),
    costCents: v.optional(v.number()),
    error: v.optional(v.string()),
    stopReason: v.optional(v.string()),
    trigger: v.optional(
      v.union(v.literal("schedule"), v.literal("manual"), v.literal("chat")),
    ),
  })
    .index("by_agent", ["agentDefinitionId", "startTime"])
    .index("by_org", ["orgId", "startTime"])
    .index("by_org_outcome", ["orgId", "outcome"]),

  // usage — one row per AI call across all surfaces (spec A-11). Substrate
  // for per-org cost dashboards, budget caps (U-51), and metered billing.
  // agentId (per-customer-agent attribution) is added when agentDefinitions
  // lands; until then rows attribute by source only.
  usage: defineTable({
    orgId: v.id("orgs"),
    // Per-customer-agent attribution (spec-STATED by_org_agent index).
    agentId: v.optional(v.id("agentDefinitions")),
    source: v.union(
      v.literal("chat"),
      v.literal("extractor"),
      v.literal("synthesizer"),
      v.literal("linter"),
      v.literal("customer-agent"),
      v.literal("dream-cycle"),
    ),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadInputTokens: v.number(),
    cacheCreationInputTokens: v.number(),
    costCents: v.number(),
    timestamp: v.number(),
  })
    .index("by_org", ["orgId", "timestamp"])
    .index("by_org_source", ["orgId", "source", "timestamp"])
    .index("by_org_agent", ["orgId", "agentId", "timestamp"]),

  // syntheses — durable daily/weekly/monthly summaries for later AI flows
  syntheses: defineTable({
    orgId: v.id("orgs"),
    period: v.union(
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("monthly"),
    ),
    timestamp: v.number(),
    windowEnd: v.number(),
    summary: v.optional(v.string()),
    actors: v.optional(v.array(v.string())),
    repos: v.optional(v.array(v.string())),
    sourcePageIds: v.optional(v.array(v.id("knowledgePages"))),
    sourceSynthesisIds: v.optional(v.array(v.id("syntheses"))),
    inputTokensCached: v.optional(v.number()),
    inputTokensUncached: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    warnings: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    claimedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    failureKind: v.optional(
      v.union(
        v.literal("fatal"),
        v.literal("transient_exhausted"),
        v.literal("unexpected"),
        v.literal("dependency_wait"),
      ),
    ),
    retryCount: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
    terminalFailure: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_period", ["orgId", "period", "timestamp"])
    .index("by_org", ["orgId", "timestamp"])
    .index("by_status", ["status"])
    .index("by_status_claimedAt", ["status", "claimedAt", "timestamp"])
    .index("by_status_nextRetryAt", ["status", "nextRetryAt", "timestamp"])
    .index("by_status_updatedAt", ["status", "updatedAt", "timestamp"])
    .index("by_org_period_status_timestamp", ["orgId", "period", "status", "timestamp"]),
});
