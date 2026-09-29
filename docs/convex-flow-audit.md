# Convex Flow Audit — source-derived inventory

_Generated from committed source (2026-08-30). This file is the inventory that `scripts/verify-convex-flow-inventory.sh` checks against `convex/schema.ts`, `convex/crons.ts`, and `convex/http.ts`. Regenerate it whenever tables, crons, or HTTP routes change._

## Counts

- Tables: 25
- Cron schedules: 12
- HTTP route registrations: 7

## Tables (convex/schema.ts)

- `events`
- `entities`
- `identityCache`
- `sessions`
- `sessionScores`
- `orgs`
- `teamMembers`
- `clerkMembershipSyncStates`
- `apiKeys`
- `mcpRateLimits`
- `threadOrgs`
- `knowledgeBases`
- `knowledgePages`
- `pageVersions`
- `references`
- `knowledgePageEvidence`
- `sourceAttributions`
- `sessionEvents`
- `sources`
- `sourceChunks`
- `ingestJobs`
- `agentDefinitions`
- `agentRuns`
- `usage`
- `syntheses`

## Cron schedules (convex/crons.ts)

- `extraction-fan-out`
- `close-stale-active-sessions`
- `bridge-stuck-sessions`
- `daily-synthesis`
- `weekly-synthesis`
- `monthly-synthesis`
- `synthesis-stale-sweep`
- `knowledge-lint`
- `dream-cycle`
- `agent-scheduler`
- `mcp-rate-limit-retention`
- `gorgias-poll`

## HTTP route registrations (convex/http.ts)

- `POST /ingest`
- `POST /clerk/webhooks`
- `OPTIONS /mcp`
- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`
- `GET /github/setup`

## Ingest routing note

GitHub, Composio, and API push share `POST /ingest` — one normalizer, one events table. Signals are routed by header/body inspection inside the single handler, not by a separate `/ingest/webhook/<orgId>` route.
