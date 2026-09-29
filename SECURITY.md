# Security Policy

## Reporting

Report vulnerabilities privately through GitHub private vulnerability
reporting: <https://github.com/joshdayorg/spark/security/advisories/new>.
Do not open public issues for exploitable bugs. Include the affected file or
function, the steps to reproduce, and the impact you expect.

## Model

- **Tenancy:** every table is org-scoped; orgId derives from the Clerk JWT
  server-side and is never accepted from clients. AI-facing tools resolve org
  from the agent thread, never from model input.
- **Ingest auth:** GitHub App HMAC (X-Hub-Signature-256, constant-time),
  Composio webhook HMAC, bearer API keys (stored as SHA-256 hashes,
  revocable, rate-limited per key).
- **MCP:** org-scoped API keys + short-TTL signed tokens for Managed Agent
  sessions; per-key minute-bucket rate limits.
- **Secrets:** live only in Convex deployment env vars. `.env*` is
  gitignored (`.env.example` holds names only, with empty values). The public
  repository starts from a fresh history; the tree was scanned with gitleaks
  and pattern checks before release.
- **MCP browser origins:** the `/mcp` endpoint allows only localhost origins by
  default. Set `MCP_ALLOWED_ORIGINS` (comma-separated) to replace that list
  with your own frontend origins. Wildcards are ignored, so the setting fails
  closed. Non-browser MCP clients are not affected.
- **Operator functions:** `convex/debug.ts` holds only internal functions
  (probes, fixtures, repairs). `convex/playground.ts` holds internal repair and
  backfill functions plus three Clerk-authenticated, org-scoped entity edits.
  Internal functions are not reachable from the internet; they run only with
  deployment credentials (`npx convex run`). Protect those credentials like a
  database password.
- **AI-generated queries:** there is no free-form query execution; chat tools
  run typed, index-bounded queries with org injection at the infrastructure
  level.
