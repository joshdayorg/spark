# Tool-agnostic event pipeline

Status: **design note, partly shipped.** Steps 1, 2 and 4 are in `main`.
Step 3 and steps 5–6 are planned, not built (see below).

## Why

Spark will ingest **hundreds of Composio toolkits**. Branching core logic on
`source === "asana"` (or hand-writing a registry row per tool) does not scale —
the Asana evidence/session over-population we just fixed would recur for Notion,
Linear, Jira, Gorgias, … forever.

Principle: **classify every event into one canonical vocabulary at the edge;
make all core logic operate on that vocabulary, never on the tool.** Per-tool
work shrinks to **convention + heuristics first, thin overrides by exception** —
maintenance is O(verbs + exceptions), not O(tools).

## Canonical taxonomy (`convex/classifyEvent.ts`)

Every event, any source, maps to:

- **verb** — `created | updated | commented | assigned | moved | status_changed
  | closed | merged | mentioned | reacted | attached | renamed | deleted |
  linked | other`
- **tier** — `substantive | routine | trivial` (signal weight)
- **object** — `{ source, kind, gid?, name? }` (the work unit: task/pr/ticket/…)
- **field?** — which field changed (drives keystroke-burst coalescing)
- **container?** — `{ source, kind, gid? }` (repo / channel / project)

`classifyEvent(source, rawType, payload): Classification` — pure, no Convex/env
imports (importable from any runtime, like `composioConfig.ts`).

### Three layers (in order)

1. **Registry** — declarative `${source}:${rawType}` overrides for the handful
   of known high-value pairs (Asana/Slack/GitHub/Gorgias). Each pair is keyed by
   BOTH the raw Composio slug AND the persisted `events.type`
   (`COMPOSIO_TRIGGER_TYPE_MAP` collapses the former into the latter), because
   step-2/4 read `Doc<events>.type` while a future insert-boundary caller has the
   raw slug. Verb may be derived (`@github_action` from `payload.action`,
   `@asana_field` from `change_field`, `@gorgias_status` from the status token).
2. **Slug heuristic** — the scaling core. First-match token rules over the
   lowercased `rawType` (`/comment/→commented`, `/updat|edit/→updated`,
   `/creat|add|open/→created`, …) + a CI/automation/bot override → `trivial`.
   Covers any unmapped Composio toolkit (`NOTION_PAGE_UPDATED`,
   `LINEAR_ISSUE_CREATED`, …) and free-form api/mcp types with **zero config**.
3. **Cached LLM classifier** — NOT built (stub only). When built: cache on
   `(source, rawType)` only (verb/tier/kind are a property of the type, not the
   instance), so the LLM runs at most once per novel type.

Object/field/container are extracted by a path-walker that tries the payload
as-is AND nested under `data` / `data.data` (live Composio webhooks nest under
`body.data`, the REST resolver double-nests, backfill/Gorgias/GitHub-App
payloads are flat). One walker, all shapes.

## Adding a new tool

1. Subscribe to its triggers (data — ideally fetched from Composio's trigger
   catalog; `TRIGGER_TOOLKITS` in `composioConfig.ts` should become data-driven).
2. Events flow through `classifyEvent` → sensible `verb`/`tier`/`object`
   automatically (heuristic) → coalesced, clustered, noise-gated by the same
   generic core.
3. Write code **only** to override a misclassification: add a registry row
   and/or an object/field path. An admin view of events with `verb:other` /
   low-confidence classification surfaces which few tools need it.

## Migration steps

### Done

- **Step 1 — `convex/classifyEvent.ts`** (+ `scripts/test-classify-event.ts`,
  26 checks). Pure module. Collision-free.
- **Step 2 — generic noise gate.** `isTrivialAsanaCluster` /
  `LOW_VALUE_ASANA_EVENT_TYPES` deleted; replaced by `isNoiseCluster(events)` =
  *no substantive event AND < 2 distinct signals* (`spark.ts`), where signal =
  `verb|field|object.gid`. Strict **superset** of the old Asana gate. Call swapped
  in `runExtractor`.
- **Step 4 — object-aware clustering.** `clusterEventsIntoSessions` buckets by
  `actorKey | getEventSessionScope(event)` (container-first: repo/channel/project,
  else durable object). Stops the synthetic-"asana" actor lumping every project
  into one mega-session; scope-less events keep actor-only behavior.

### Planned (not built)

- **Step 3 — generic coalescing at insert** (replaces the per-tool
  `ASANA_TASK_UPDATED_FIELDS` whitelist). Add optional `coalesceKey: string` +
  index `by_org_source_coalesce` `[orgId, source, coalesceKey]` to `events`
  (additive, no backfill). In `insertEvent`, when `classifyEvent` yields a
  coalescible event (`verb ∈ {updated,moved,status_changed} && tier ≤ routine &&
  object.gid`), compute `coalesce:${object.gid}:${verb}:${field}:${floor(ts/5min)}`
  and point-lookup the index; on hit, drop the burst duplicate. Use a NEW field,
  **not** `sourceDeliveryId` (which must stay for real provider-redelivery
  idempotency). Substantive/gid-less events never coalesce.
  - **Order:** wire the GitHub webhook insert (`ingest.ts`
    `insertGithubWebhookEvent`) and the Gorgias poller first, then the live
    Composio boundary in `ingest.ts`. Add the coalesceKey computation on a new
    line near the `insertEvent` call.

- **Steps 5–6 — persist the taxonomy.**
  Add `verb/tier/object/field` columns + `by_org_object` index to `events`; run
  `classifyEvent` ONCE at each insert boundary and persist; collapse
  `asanaAdapter`/`slackAdapter`/the inline GitHub builders into one
  `buildEvent(source, rawType, payload)`; fold `getEventActorIdentityRef`
  (`spark.ts` + the `knowledge.ts` duplicate) into persisted `actorRef`; replace
  `readRepoName`/`readRepoNames` and the two `resolveEventEntities`
  source branches with persisted `object.container`; replace
  `asanaSummary`/`githubSummary` with `templateSummary(verb, object, actor,
  container)`. The insert boundary in `ingest.ts` and `asanaAdapter.build`
  carry the Asana attribution rules; keep `scripts/verify-asana-attribution-semantics.sh`
  green when you change them.

## Behavior changes to confirm

- **Lone CI/automation clusters now gate** (a single `workflow_run`/`check_run`
  no longer mints a session). Intended. Code pushes are `substantive`, so a lone
  push still forms a session (no coverage regression).
- **Asana completion is now `substantive`** (`task_updated`+`change_field=completed`
  → `closed`), so a lone completion survives the gate (it used to be lumped into
  Asana noise).
- **Session granularity** is now container-scoped (per repo/channel/project)
  instead of per-actor-only. `getEventSessionScope` is **TUNABLE**: flip the two
  `if` blocks to object-first for per-task / per-issue sessions.
- Slack bot-vs-human tiering is **inert until step 5/6** — all four `SLACKBOT_*`
  slugs collapse to `events.type = "message"` before persist, so a `Doc<events>`
  reader can't tell them apart; bot=trivial only works once the raw slug is
  plumbed to the insert boundary.

## Testing

`scripts/test-classify-event.ts` is a standalone TypeScript check (it is not
part of `npm test`). Run it via transpile:

```
npx tsc convex/classifyEvent.ts scripts/test-classify-event.ts \
  --outDir /tmp/cetest --module commonjs --target es2022 \
  --moduleResolution node --esModuleInterop --skipLibCheck --noCheck
node /tmp/cetest/scripts/test-classify-event.js
```
