# Spark — deep dive

An AI that understands your company. Signals flow in from where your team works, get transformed into structured knowledge, and a reasoning engine produces strategic intelligence nobody asked for. Intelligence that compounds.

```
WORLD (GitHub, Slack, Asana, MCP, custom — more via Composio)
  │
  ▼
SENSE ─── Signals arrive through pipes
  │        One HTTP endpoint. One normalizer. One events table.
  │        Source tells you where (github, slack). Via tells you how (webhook, composio, api).
  │        The downstream doesn't care which pipe carried it.
  │
  ▼
THINK ─── Extractor clusters events into sessions
  │        AI reads each session, understands what happened
  │        Writes knowledge pages — facts, patterns, decisions
  │        Every knowledge page: Compiled Truth above the line, Evidence Timeline below.
  │
  ▼
REFLECT ── Spark Mind reasons over the full knowledge base
  │         "Three Q1 decisions contradict each other."
  │         "60% maintenance for 3 months — nobody named it a strategic choice."
  │         Output: Findings — intelligence nobody asked for
  │         Findings feed back into the knowledge base. The loop deepens.
  │
  ▼
ACT ────── Intelligence flows out through six surfaces:
           Chat · Pulse · Knowledge · Findings · Agents · MCP
```

---

## The Stack

Four platforms. Our code is the thinnest possible glue between them.

```
┌─────────────────────────────────────────────────────┐
│                      SPARK                          │
│                                                     │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │  Convex   │  │ Anthropic │  │    Composio      │ │
│  │           │  │           │  │                  │ │
│  │ Database  │  │ Spark's   │  │ OAuth + triggers │ │
│  │ Real-time │  │ brain     │  │ for all tools    │ │
│  │ Agents    │  │ (Chat,    │  │ (GitHub, Slack,  │ │
│  │ Crons     │  │  Extract, │  │  Asana, ...)     │ │
│  │ HTTP      │  │  Reason)  │  │                  │ │
│  └─────┬─────┘  └─────┬─────┘  └────────┬─────────┘ │
│        │              │                  │           │
│        └──────────────┼──────────────────┘           │
│                       │                              │
│                 ┌─────┴─────┐                        │
│                 │   Clerk   │                        │
│                 │ Auth/Orgs │                        │
│                 └───────────┘                        │
└─────────────────────────────────────────────────────┘
```

| Platform | Role |
|----------|------|
| **Convex** | Database, real-time subscriptions, backend functions, crons, agent runtime (`@convex-dev/agent`), vector retrieval (`@convex-dev/rag`) |
| **Anthropic** | Reasoning and generation — chat, extraction, synthesis (Managed Agents with event streaming) |
| **OpenAI** | Embeddings — `text-embedding-3-large` vector index for knowledge retrieval |
| **Cohere** | Reranking — prunes hybrid search results before synthesis |
| **Composio** | Integration hub — OAuth, triggers from connected tools, outbound delivery via MCP |
| **Clerk** | Auth — user identity, org management, multi-tenant JWT |

---

## How Signals Flow

Everything starts with a signal from the world.

```
                    ┌─────────────────┐
  GitHub webhooks ──┤                 │
  Composio triggers─┤  POST /ingest   │──→ events table
  API push ─────────┤  (http.ts)      │     (normalized)
                    └─────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Extraction     │    Every 5 min:
                    │  Fan-Out        │    "Which orgs have
                    │  (crons.ts)     │     new events?"
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Extractor      │    Per org:
                    │  (spark.ts)     │    Claim events →
                    │                 │    cluster by actor →
                    │  AI titles each │    30-min sessions →
                    └─────────────────┘    sessions table
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
  ┌───────▼───────┐ ┌───────▼───────┐ ┌───────▼───────┐
  │  Spark Chat   │ │  MCP Server   │ │  Customer     │
  │  @convex-dev/ │ │  POST /mcp    │ │  Agents       │
  │  agent with   │ │  4 tools:     │ │  Managed      │
  │  knowledge-   │ │  search, ask, │ │  Agents API   │
  │  search tools │ │  entity, push │ │  + Composio   │
  └───────────────┘ └───────────────┘ └───────────────┘
```

1. **World → Events:** GitHub/Slack/Asana activity hits the ingest endpoint. The normalizer identifies the source, verifies auth, extracts universal fields (source, via, type, actor, summary, timestamp), preserves the raw payload, writes one row to `events`.

2. **Events → Sessions:** Every 5 minutes, the extraction cron asks "which orgs have unprocessed events?" For each org with work, it atomically claims a batch of events, clusters them by actor within 30-minute windows, AI generates a session title, and writes to `sessions`. The claim mechanism prevents duplicate processing when cron runs overlap.

3. **Sessions → Knowledge:** The knowledge layer extracts facts, patterns, and decisions from sessions into `knowledgePages`. The synthesizer compresses: daily reads events, weekly reads daily, monthly reads weekly. Each layer adds interpretive context the layer below didn't have. Fractal compounding.

4. **Knowledge → Findings:** *(Phase 4)* Spark Mind (Dream Cycle) reads the full knowledge base overnight and reasons about it. Output: Findings — strategic intelligence nobody asked for. Findings feed back into the knowledge base.

5. **Intelligence → Surfaces:** Spark Chat answers questions grounded in org data. Pulse writes the CEO briefing before anyone asks. Customer agents run scheduled on Managed Agents with Composio MCP for delivery. External agents query via MCP.

---

## The Ingestion Model

Three pipes feed into one normalizer. The downstream doesn't care which pipe carried the signal.

### Pipe 1a: GitHub App Webhooks

A GitHub App delivers events for every installed org to `POST /ingest`. One app-level HMAC-SHA256 secret (`GITHUB_APP_WEBHOOK_SECRET`, header `X-Hub-Signature-256`) authenticates each delivery; the org is resolved from `installation.id` on the payload (linked to a Spark org by an integration admin via `linkGithubInstallation`).

```
GitHub App webhook → POST /ingest
  → X-Hub-Signature-256 header
  → verify HMAC-SHA256 against the app webhook secret
  → resolve org from installation.id → githubInstallationId lookup
  → normalize (sender.login as actor, X-GitHub-Event as type)
  → events table
```

### Pipe 1b: Composio Triggers (Slack, Asana — extensible to any Composio toolkit)

Composio fires triggers on connected workspace activity. Wired toolkits today: Asana and Slack (see `convex/composioConfig.ts`; adding a toolkit is a code checklist, documented in SETUP.md). V3 payload format with `metadata` (routing) and `data` (the actual event).

```
Composio trigger → POST /ingest
  → type: "composio.trigger.message"
  → verify HMAC signature
  → resolve org from metadata.user_id
  → extract actor from body.data (per-source field probing)
  → normalize
  → events table
```

### Pipe 1c: API Push (MCP, custom integrations)

Bearer token auth for external agents and custom integrations. Caller provides structured event fields.

```
External agent → POST /ingest
  → Authorization: Bearer <api-key>
  → SHA-256 hash → org lookup
  → caller provides source, type, actor, summary
  → events table
```

---

## How Auth Works

| Boundary | Method |
|----------|--------|
| Frontend → Convex | Clerk JWT → `orgQuery`/`orgMutation` wrappers extract orgId |
| GitHub → Ingest | App-level HMAC-SHA256 (`X-Hub-Signature-256`, `GITHUB_APP_WEBHOOK_SECRET`), constant-time comparison; org from `installation.id` |
| Composio → Ingest | HMAC signature verification |
| External → Ingest/MCP | Bearer API key → SHA-256 hash → org lookup |
| Managed Agents → MCP | Signed short-lived token (HMAC, 1hr TTL, JTI) |

**Iron rule:** orgId is never accepted as a client argument. Public endpoints derive it from Clerk JWT. Internal functions accept it as an explicit parameter.

---

## How Composio Works

Composio is invisible infrastructure. Customers connect their tools in Settings. Spark absorbs all activity.

```
Customer clicks "Connect GitHub" in Settings
  → createComposioConnectLink() returns OAuth URL
  → Customer authorizes → credentials stored in Composio
  → GitHub is NOT Composio: install the Spark GitHub App on the org,
    link installation.id in Settings (integration admin)
  → GitHub events flow directly to POST /ingest (app-level HMAC auth)
  → Other tools (Slack, Asana) fire via Composio triggers
  → Customer's agents get Composio MCP → can send Slack msgs, create tasks
```

One Spark Composio API key. Per-org isolation via `user_id` = Spark orgId on session creation.

---

# The Knowledge Layer

Everything above turned signals into structured events. This section turns them into understanding — a knowledge base that writes itself.

## How Knowledge Forms

Anything readable can become a source — a paste, a URL, a file, a captured work session. Each source flows through the same pipeline.

```
                        ┌──────────────────────┐
  Pastes ───────────────┤                      │
  URLs ─────────────────┤    createSource      │──→ sources table
  Files ────────────────┤   (knowledge.ts)     │    (dedup via contentHash)
  Captured sessions ────┤                      │
                        └──────────┬───────────┘
                                   │
                        ┌──────────▼───────────┐
                        │    processSource     │    Markdown-aware chunking
                        │                      │    → 800-token chunks, 150 overlap
                        │  AI context prefix   │    Sonnet writes a 50–100-token
                        │     per chunk        │    contextual header per chunk
                        │                      │    → rag.add embeds for retrieval
                        └──────────┬───────────┘
                                   │
                        ┌──────────▼───────────┐
                        │ extractKnowledgeFrom │    Single AI call per source:
                        │      Source          │    → stitch chunks with XML tags
                        │                      │    → Sonnet emits JSON extractions
                        │                      │    → upsert knowledgePages (by slug)
                        └──────────┬───────────┘
                                   │
               ┌───────────────────┼────────────────────┐
               │                   │                    │
        ┌──────▼──────┐   ┌────────▼───────┐   ┌───────▼──────┐
        │ knowledge   │   │  sourceAttri-  │   │  references  │
        │ Pages       │   │  butions       │   │  (typed      │
        │  + versions │   │  (every claim  │   │   edges)     │
        │             │   │   → a source)  │   │              │
        └─────────────┘   └────────────────┘   └──────────────┘
```

1. **Source intake.** `createSource` (in `knowledge.ts`) inserts into the `sources` table, SHA-256-hashes the content, and dedups against `sources.by_hash`. If the same content already completed successfully, return `{duplicate: true}` and do nothing. If it exists but is stuck or failed, return `{resumed: true}` and schedule a fresh ingest. Otherwise create a new source + `ingestJobs` row, schedule `processSource`.

2. **Chunking.** `processSource` splits content into 800-token chunks with 150-token overlap. Fenced code blocks (` ``` `, ` ~~~ `) and HTML block regions are "protected" — they never split mid-block, even if oversized. Unprotected prose splits on paragraph → line → sentence → whitespace-preferred character range.

3. **Context prefixes.** For each chunk, a Sonnet call (`max_tokens: 160`, `temperature: 0`) writes a 50–100-token header: *what section of the document this chunk lives in, what came before, what it's talking about.* The prefix is prepended to the chunk before vector embedding. Retrieval quality jumps because a chunk that reads "She said yes" now embeds with "Decision meeting about Stripe Connect migration; Maya asks if we proceed. She said yes."

4. **Vector indexing.** `@convex-dev/rag` (OpenAI `text-embedding-3-large`, 3072 dims) embeds `contextPrefix + "\n\n" + chunk.content` and stores it in an org-namespaced vector index.

5. **Extraction.** `extractKnowledgeFromSource` stitches all chunks back into one document, sends them to Sonnet in one call, parses the returned JSON into knowledge pages.

6. **Cross-references.** As pages are written, mentions between them become typed directed edges in the `references` table. The knowledge base is a graph, not a list.

## The Knowledge Page Model

Every knowledge page has two sections. The split is the heart of the whole thing.

```
┌─────────────────────────────────────────────────────┐
│  COMPILED TRUTH  (rewritable AI synthesis)          │
│  ─────────────────                                  │
│  Sonnet's current best understanding. Gets          │
│  rewritten as new evidence arrives.                 │
│                                                     │
│  "Checkout runs on the platform's extensions API.   │
│   Payment flow goes through Stripe Connect          │
│   (confirmed in Maya's Feb 2026 decision doc        │
│   and the March migration PRs)."                    │
│                                                     │
├─────────────────────────────────────────────────────┤
│  EVIDENCE TIMELINE  (append-only history)           │
│  ─────────────────                                  │
│  Every piece of evidence that shaped the Compiled   │
│  Truth, tagged with source + channel + timestamp.   │
│  Never rewritten, only appended.                    │
│                                                     │
│  [2026-02-14 Maya, decision doc]                    │
│    "Using Stripe Connect for checkout payments."    │
│  [2026-03-02 Sam, Slack #eng]                       │
│    "Checkout extensions API v2 live in prod."       │
│  [2026-04-11 Maya, PR #2847]                        │
│    "Migrate checkout webhooks to extensions."       │
└─────────────────────────────────────────────────────┘
```

Rewriting above the line, appending below the line. Compiled Truth stays current; Evidence Timeline preserves history. When a decision gets reversed, the new rationale flows into Compiled Truth and the old rationale stays in the timeline where it belongs.

Nine page types, each with its own schema extensions:

| Type | Purpose |
|------|---------|
| `fact` | A discrete truth about the org (tech stack, team structure, product state) |
| `pattern` | Recurring behavior or tendency (how the team releases, where bugs cluster) |
| `decision` | Why a choice was made, with rationale and tradeoffs preserved |
| `entity` | A person, tool, or system referenced across the knowledge base |
| `project` | A bounded piece of work — what it is, who owns it, where it stands |
| `question` | An open question the org hasn't answered yet |
| `finding` | Strategic intelligence from Spark Mind (contradictions, gaps, drift) |
| `goal` | A desired outcome with owner, target date, and status |
| `session` | A captured work session — an actor, a time window, what happened |

Every write updates `pageVersions` with the new state and a `changeReason`. History is preserved at the page level, not just the evidence level.

## The Ingest Job Lifecycle

One job per source. The state machine walks one direction only; failure jumps out to `failed`.

```
pending ──→ chunking ──→ extracting ──→ synthesizing ──→ cross_referencing ──→ completed
   │           │             │               │                    │
   └───────────┴─────────────┴───────────────┴────────────────────┴──→ failed
```

| Status | Set by | Exit condition |
|--------|--------|----------------|
| `pending` | `createSource` | `processSource` picks it up → `chunking` |
| `chunking` | `markSourceChunking` | Chunks persisted + embedded → `extracting` |
| `extracting` | `markIngestJobExtracting` | Extraction action begins → `synthesizing` |
| `synthesizing` | `markIngestJobSynthesizing` | Pages + attributions written → `cross_referencing` |
| `cross_referencing` | `markIngestJobCrossReferencing` | References created → `completed` |
| `completed` | `completeKnowledgeExtraction` | Terminal. Replay returns early. |
| `failed` | `markIngestJobFailed` / `markKnowledgeExtractionFailed` | Terminal. Re-ingest creates a fresh job. |

Live progress on `ingestJobs.progress`: `entitiesExtracted`, `pagesCreated`, `pagesUpdated`, `referencesCreated`. Updated throughout extraction so the UI streams a real progress bar, not a fake one.

**Failure handling.** Anthropic calls retry on rate limits (`[1s, 4s, 16s]`) and transient network errors (`[2s, 8s]`). If all retries fail, the job is marked `failed` with the error message persisted on `ingestJobs.error`. No job-level auto-retry: re-ingesting creates a new job. This is intentional — silent retries hide systemic problems; visible failures surface them.

## How Extraction Works

One AI call per source. Not one per chunk — Sonnet sees the full document stitched back together, which means it understands context across chunk boundaries.

```
  Stitched chunks
       │
       ▼
  ┌───────────────────────────────────────────────┐
  │  System block (cached, byte-identical)        │
  │  ─────────────                                │
  │  "You are an extractor. Output JSON with      │
  │   extractions[] containing facts, patterns,   │
  │   decisions, and entities. Each must have:    │
  │   type, title, compiledTruth, confidence,     │
  │   supportingEvidence[], tags[]."              │
  │                                               │
  │  [cache_control: ephemeral]                   │
  ├───────────────────────────────────────────────┤
  │  User block (per-source)                      │
  │  ─────────────                                │
  │  Document title: <title>                      │
  │  Source type: paste                           │
  │  Source attribution: [Source: Maya, paste,    │
  │                       2026-04-21 17:32 PDT]   │
  │                                               │
  │  <chunk index="0" contextPrefix="...">        │
  │  <raw chunk content>                          │
  │  </chunk>                                     │
  │  <chunk index="1" contextPrefix="...">        │
  │  ...                                          │
  └───────────────────────────────────────────────┘
       │
       ▼
  claude-sonnet-4-6 (temperature=0, max_tokens=12000)
       │
       ▼
  JSON: { extractions: [ { type, title, slug, compiledTruth, ... } ] }
       │
       ▼
  Parse + validate → upsert knowledgePages (slug-based)
                  → insert pageVersions (new or updated)
                  → insert sourceAttributions (per evidence item)
                  → insert references (per mention)
```

**Why system stays byte-identical.** Prompt caching. The instruction block is cached on the first call; every extraction afterward hits the cache at ~90% discount. Source-specific context (title, attribution tag, chunks) lives in the user message so it doesn't invalidate the cache.

**Why one call, not many.** Cross-chunk understanding. If chunk 3 says "the migration" and chunk 7 says "Maya decided to ship it in Q2," those belong in the same decision page. Per-chunk extraction would miss that — you'd end up with two disconnected fragments.

**Slug-based upsert.** Sonnet emits a stable slug per extraction. If a page with that slug exists, new evidence appends to the Evidence Timeline and a new `pageVersions` row captures the updated state. If not, create. Slugs stay stable across runs because the same content produces the same titles, which produce the same slugs.

**Cost tracking.** Every call logs `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens` under `knowledge:extraction`. Cached runs cost a fraction of cold runs.

## How Dedup + Idempotency Work

Two checks at two layers. Both earned — both were bug sources during shakedown.

**Source-level dedup (contentHash).** `createSource` SHA-256s the content and queries `sources.by_hash` on `(orgId, contentHash)`. If a match exists and its latest job completed successfully, return `{duplicate: true, jobId: null}` without inserting anything. If the match exists but the job is stuck or failed, return `{resumed: true}` and schedule a fresh ingest.

**Job-level idempotency (completed-guard).** `extractKnowledgeFromSource` checks `job.status === "completed"` as its first action. If the job is already done, return zeros immediately. This matters when cron retries or manual re-triggers land on an already-processed source — replay is safe, free, and sub-second.

## How Search Works

Two search paths, each tuned for what it does.

```
  ┌─────────────────────────────────────────────────────┐
  │                     LIVE SEARCH                     │
  │                                                     │
  │  User types in the search box                       │
  │  │                                                  │
  │  ▼                                                  │
  │  Convex query (reactive) → BM25 on sourceChunks     │
  │  │                         .search_content          │
  │  ▼                                                  │
  │  Results stream as user types (sub-100ms)           │
  └─────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────┐
  │                    DEEP SEARCH                      │
  │                                                     │
  │  User asks a question                               │
  │  │                                                  │
  │  ▼                                                  │
  │  Convex action → BM25 on sourceChunks (top 50)      │
  │                → Vector search via @convex-dev/rag  │
  │                  (embed query → cosine similarity)  │
  │                → Reciprocal Rank Fusion merge       │
  │                → Reranker prunes to top 10          │
  │                → Sonnet reads chunks + knowledge    │
  │                  pages → synthesized answer         │
  │                                                     │
  │  Answer with inline citations → Chat                │
  └─────────────────────────────────────────────────────┘
```

**Why the split.** Convex vector search is only available in actions, not queries. Live search needs reactive updates as the user types, so it's BM25-only in a query. Deep search runs in an action, so it can use both.

**Why hybrid for deep.** Exact-term matches and semantic matches don't agree, and both matter. BM25 finds "Stripe Connect"; vector finds "payment rails." Reciprocal Rank Fusion merges them without overweighting either. A reranker prunes to the highest-signal chunks before Sonnet reads them.

## How Cross-References Work

Pages mention other pages. Every mention becomes a typed, directed edge in the `references` table.

| Type | Meaning |
|------|---------|
| `mentions` | Page A references Page B |
| `depends_on` | Page A depends on Page B |
| `contradicts` | Page A's claim conflicts with Page B's claim |
| `supersedes` | Page A replaces Page B |
| `part_of` | Page A is a sub-component of Page B |
| `related_to` | Page A and Page B are topically linked |

The knowledge base forms a graph, not a list. Contradictions get surfaced by Spark Mind during Dream Cycle. `supersedes` preserves history — you never lose the old decision, just mark it replaced. `related_to` drives recommendations in Chat ("you might also want to look at…").

Every claim on every page traces to a `sourceAttributions` row: `pageId × sourceId × chunkId × excerpt`. Click any sentence in Compiled Truth, see the chunk it came from, jump to the source. No black boxes.

---

## The Backend

The backend, organized by responsibility area:

| File | What it does |
|------|-------------|
| `convex/schema.ts` | Table definitions organized by domain — ingestion (events, sessions), identity & tenancy (orgs, teamMembers, apiKeys), knowledge (sources, pages, versions, attributions, references, chunks, ingest jobs), synthesis, and MCP/agent surface. See `convex/schema.ts` for the authoritative list. |
| `convex/spark.ts` | **CORE GLUE** — auth helpers, agent definitions (Spark Chat, Synthesizer, Linter; extraction uses the Anthropic SDK directly rather than an agent runtime), extraction pipeline with claim/lease and 30-min clustering, thread↔org bridge, Managed Agents event-streaming wrapper, MCP tool handlers, API key lookup, signed MCP tokens |
| `convex/knowledge.ts` | **KNOWLEDGE LAYER** — source intake, dedup, markdown-aware chunking with overlap, AI context prefix generation, ingest job state machine, single-call extraction with prompt caching, page versioning, source attribution, cross-references, BM25 live + hybrid deep search |
| `convex/composio.ts` | Node-only Composio integration — Connect Link, session creation, GitHub webhook setup/update/delete, OAuth token retrieval |
| `convex/ingest.ts` | Signal normalizer — three-pipe intake (native webhooks, Composio V3 triggers, API push), HMAC verification, actor/timestamp/summary extraction |
| `convex/http.ts` | HTTP router: `POST /ingest` (signal intake), `POST /clerk/webhooks` (team sync), `/mcp` (OPTIONS/POST/GET/DELETE — MCP protocol and tool dispatch) |
| `convex/crons.ts` | Operational schedules covering extraction fan-out, session bridge recovery, daily/weekly/monthly synthesis cadence, knowledge linting, and stale-session and rate-limit upkeep — see `convex/crons.ts` for the authoritative list |
| `convex/convex.config.ts` | Registers `@convex-dev/agent` + `@convex-dev/rag` components |
| `convex/debug.ts` | Read-only dev utilities: org/event inventory, per-org source + job inspection |

Operational schedules in `convex/crons.ts` cover these purpose areas:

- **Extraction fan-out** — polls for orgs with unprocessed events and dispatches per-org extraction work
- **Session bridge recovery** — sweeps stuck session bridges to prevent stalled ingest
- **Synthesis cadence** — daily, weekly, and monthly compression runs that deepen interpretive context over time
- **Knowledge linting** — periodic quality pass over the knowledge base
- **Stale-session and rate-limit upkeep** — clears expired state to keep operational tables clean

See `convex/crons.ts` for schedule names, cadences, and target functions.

---

## Code Properties

- **Zero `.filter()` on large scans** — all hot-path queries use `.withIndex()` or `.withSearchIndex()`
- **Correct HMAC** — raw request body preserved for signature verification
- **v6 Agent API** — `createTool` uses `inputSchema` + `execute`, `zod/v3`
- **Real Managed Agents API** — `sessions.events.send()` + `sessions.events.stream()` with proper stop-reason handling
- **Dual Anthropic key model** — system key by default, per-org BYOK override
- **Atomic extraction** — claim/lease mechanism prevents duplicate session creation from concurrent cron runs
- **AI-generated context prefixes** — every chunk has a Sonnet-written contextual header, not a heuristic one
- **Markdown-aware chunking** — fenced code blocks and HTML regions never split mid-block
- **Prompt caching across sources** — byte-identical system prompts hit Anthropic's cache at ~90% discount
- **Idempotent replay** — re-running a completed job returns zeros in sub-second, without any AI calls

---

## What's Being Built

### Phase 1: Core Plumbing — ✅ Shipped
Events ingestion, extraction pipeline, Managed Agents wrapper, MCP server, auth model, multi-tenant.

### Phase 2: Knowledge Layer — ✅ Shipped
The heart of the product. Sources, markdown-aware chunking with AI context prefixes, single-call extraction, `knowledgePages` with Compiled Truth + Evidence Timeline, typed cross-references, source attribution on every claim, BM25 live search + hybrid deep search.

### Phase 3: Synthesis + Agents — ✅ Shipped
Daily → weekly → monthly synthesis compression. Customer agents: `agentDefinitions`/`agentRuns`, claim-once scheduler, per-agent monthly budget caps enforced before session creation, templates, versioned edits with rollback, and per-call usage tracking (`usage` table) across every AI surface. (Metered billing on top of the usage table is future work.)

### Phase 4: Dream Cycle — ✅ Shipped (first iteration)
Spark Mind reads the org's knowledge base overnight (03:30 UTC fan-out) and reasons about it via a Managed Agent with Spark MCP access. Output: Findings — up to 7 per run across the seven types (contradiction, strategic gap, resource drift, emerging capability, stale decision, unanswered question, blind spot), written idempotently into `knowledgePages` and fed back into the loop. Auto-resolve and progressive-trust push delivery are deliberately conservative for now.

---

## How it was built

Spark was built spec-first, with AI coding agents doing most of the implementation under human review. Every feature went through the same loop:

1. **Write the brief** against the spec, with verified API docs.
2. **Review and plan.** An agent reads the code and the spec, then proposes changes.
3. **Check the plan against vendor docs** to catch wrong API assumptions before any code is written.
4. **Build** from the reviewed plan.
5. **Audit** against the success criteria, the spec and the SDK types, then pin the result with a `scripts/verify-*.sh` proof.

The proof scripts are the durable record of that process: each one names the contract it protects.

## Specs

The original design specs are not published. This repository is the source of truth: the code in `convex/`, this deep dive, the [README](../README.md), [SETUP](../SETUP.md) and the proof scripts. To propose a design change, open an issue on [github.com/joshdayorg/spark](https://github.com/joshdayorg/spark/issues).
