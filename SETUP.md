# SETUP — run Spark on your own accounts

This guide takes an outside operator from clone to a working backend: signals
flowing in, knowledge forming, chat answering, agents running. Time budget:
~45–60 minutes if you already have the vendor accounts, most of it in vendor
dashboards. Add time for account sign-ups and for the Anthropic Managed Agents
beta, if you want customer agents and the Dream Cycle.

Spark's backend is a Convex app. There is no server to run — `npx convex dev`
(or a Convex production deployment) is the runtime.

## 0. Prerequisites

- Node 20+ and npm (the repo pins Node 24 in `.node-version`)
- Accounts: [Convex](https://convex.dev), [Clerk](https://clerk.com),
  [Anthropic](https://console.anthropic.com), [OpenAI](https://platform.openai.com),
  [Composio](https://composio.dev) (for Slack/Asana intake + agent delivery),
  optionally [Cohere](https://cohere.com) (search reranking)
- A GitHub org you can install a GitHub App on (for GitHub intake)

## 1. Clone + install

```bash
git clone https://github.com/joshdayorg/spark.git
cd spark
npm install
```

## 2. Convex

```bash
npx convex dev --configure
```

Pick "create a new project". This writes `.env.local` with your deployment
name and starts the dev deployment. Your HTTP endpoints live at
`https://<deployment>.convex.site`.

Quality gates (run them now to confirm a clean baseline):

```bash
npm test                                   # 72 verification scripts + behavioral tests
npx tsc -p convex/tsconfig.json --noEmit   # offline typecheck (= npm run typecheck:offline)
```

Note: `npm run typecheck` (convex codegen --typecheck) needs a configured
Convex deployment; the tsc line above is the offline equivalent. You can run
both gates before step 2 — they need no accounts or keys.

## 3. Environment variables

Copy `.env.example` for reference and set each var on the Convex deployment:

```bash
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<slug>.clerk.accounts.dev
# ...one per var; see .env.example for what each does and where to get it
```

## 4. Clerk (auth + orgs)

1. Create a Clerk application. Enable **Organizations**.
2. JWT template: create one named `convex` (Convex reads it by this name).
3. Copy the issuer domain → `CLERK_JWT_ISSUER_DOMAIN`.
4. Webhook: endpoint `https://<deployment>.convex.site/clerk/webhooks`,
   subscribe to user + organizationMembership events, copy the signing
   secret → `CLERK_WEBHOOK_SECRET`. This keeps `teamMembers` in sync.

## 5. Composio (Slack + Asana intake, agent delivery)

Composio is self-serve for CONNECTING tools, with a one-time project setup:

1. Create a Composio project → API key → `COMPOSIO_API_KEY`.
2. Auth configs: create one per toolkit (Slack, Asana) in the Composio
   dashboard → copy IDs → `SLACK_AUTH_CONFIG_ID`, `ASANA_AUTH_CONFIG_ID`.
   (Default Composio-branded consent screens work; custom OAuth apps make the
   consent screen show your brand instead.)
3. Webhook subscription (once per project):

   ```bash
   curl -X POST https://backend.composio.dev/api/v3.1/webhook_subscriptions \
     -H "x-api-key: $COMPOSIO_API_KEY" -H "content-type: application/json" \
     -d '{"webhook_url": "https://<deployment>.convex.site/ingest",
          "enabled_events": ["composio.trigger.message"]}'
   ```

   Store the returned signing secret → `COMPOSIO_WEBHOOK_SECRET`.

   Use **one Composio project per Spark deployment.** When Spark reconciles
   the webhook subscription (`composio:ensureComposioWebhookSubscription`), it
   prefers a subscription whose URL matches this deployment. If the project has
   exactly one subscription, Spark adopts it and points it at this
   deployment's `/ingest`, even if it was created for another URL.
4. After that, org admins connect tools through Connect Links — from the CLI
   (`composio:createConnectLinkForOrg`, see §10) or from your own UI
   (`createComposioConnectLink`). No code, no dashboard.

**Honest scope:** connecting Slack/Asana is self-serve. ADDING a new toolkit
(e.g. Notion, Jira, Gorgias) is a code checklist, not config:
add the toolkit descriptor + trigger→type map in `convex/composioConfig.ts`,
actor extraction in `convex/ingest.ts`, optionally an auth-config env var,
and a verify script. Plan ~half a day per toolkit.

## 6. GitHub (GitHub App — not Composio)

1. Create a GitHub App on your account/org:
   - Webhook URL: `https://<deployment>.convex.site/ingest`
   - Webhook secret: generate one → `GITHUB_APP_WEBHOOK_SECRET`
   - Permissions/events: contents + pull requests + issues + pushes (read),
     subscribe to push, pull_request, issues, issue_comment.
2. Install the app on the org whose activity Spark should absorb.
3. Set the app's **Setup URL** to
   `https://<deployment>.convex.site/github/setup` (enable "Redirect on
   update"), and set `GITHUB_APP_SLUG` to the app's URL slug.
4. Self-serve install: an integration admin generates an install link
   (`createGithubInstallLink`) and installs through it — the post-install
   redirect links `installation.id` to their org automatically (signed,
   30-minute state token). Fallback: `linkGithubInstallation` with the
   `installation.id` from the install page URL.

## 7. Anthropic / OpenAI / Cohere

- `ANTHROPIC_API_KEY` — all reasoning. Managed Agents (customer agents +
  Dream Cycle) additionally require the Managed Agents beta on your key;
  chat/extraction/synthesis run fine without it (S-9 isolates the beta from
  the critical path).
- `OPENAI_API_KEY` — embeddings for vector search.
- `COHERE_API_KEY` — optional; deep search skips reranking when unset.

## 8. MCP server

```bash
npx convex env set SPARK_MCP_URL https://<deployment>.convex.site/mcp
npx convex env set SPARK_MCP_SIGNING_SECRET $(openssl rand -hex 32)
npx convex env set MCP_ALLOWED_ORIGINS https://your-frontend.example
```

Create an org API key (integration admin, `createApiKey`) and point any MCP
client at `SPARK_MCP_URL` with it. Tools: `spark_search`, `spark_ask`,
`spark_entity`, `spark_push`.

## 9. Smoke test

With `npx convex dev` running and an org created through Clerk:

```bash
# 1. Push a test signal through the API pipe
curl -X POST https://<deployment>.convex.site/ingest \
  -H "Authorization: Bearer <org-api-key>" -H "content-type: application/json" \
  -d '{"source":"custom","type":"note","actor":"setup-test",
       "summary":"Spark setup smoke test","timestamp":'$(date +%s000)'}'

# 2. Within ~5 minutes the extraction cron clusters it into a session and a
#    session knowledge page appears (knowledgePages, type "session").

# 3. Search it via MCP
#    spark_search {"query": "setup smoke test"}
```

If all three land, the loop is alive: signal → event → session → knowledge →
search.

## Troubleshooting

- `npm run typecheck` fails immediately → it needs a running local backend;
  use `npx tsc -p convex/tsconfig.json --noEmit`.
- `convex dev` schema validation errors on old local data → your local
  snapshot predates the current schema; clear the local dev deployment or
  migrate the offending rows.
- MCP requests from a browser fail with a CORS error → add the page's origin
  to `MCP_ALLOWED_ORIGINS`. The default allows only localhost dev origins.
- Composio events not arriving → check the webhook subscription exists and
  `COMPOSIO_WEBHOOK_SECRET` matches; the ingest route rejects bad signatures.
- GitHub events 401 → `GITHUB_APP_WEBHOOK_SECRET` mismatch, or the
  installation was never linked to an org.

## 10. Headless admin (no frontend required)

Spark's posture is headless/agentic-first: the backend + MCP server is the
product; the official web UI is a separate, optional repo. As a self-hoster
you hold deployment credentials, so every admin action is one
`npx convex run` away (internal functions run with deployment auth — guard
your Convex credentials accordingly). The five commands:

```bash
# 1. Resolve your org's Convex id (after Clerk org creation + webhook sync)
npx convex run spark:resolveOrgIdByClerkOrgId '{"clerkOrgId":"org_..."}'

# 2. Mint an org API key (prints the plaintext once) — powers MCP + API ingest
npx convex run debug:yellow2aCreateApiKey '{"orgId":"<orgId>","label":"admin"}'

# 3. Composio Connect Link for a toolkit (open the printed URL to OAuth)
npx convex run composio:createConnectLinkForOrg '{"orgId":"<orgId>","toolkit":"slack"}'

# 4. Link a GitHub App installation to the org (id from the install page URL;
#    the browser flow via /github/setup does this automatically instead)
npx convex run spark:linkGithubInstallationFromCallback '{"orgId":"<orgId>","installationId":12345678}'

# 5. Choose which Slack channels / Asana projects Spark watches
npx convex run composio:syncWatchedSlackChannelsForOrg '{"orgId":"<orgId>","channelIds":["C0123..."]}'
npx convex run composio:syncWatchedAsanaProjectsForOrg '{"orgId":"<orgId>","projectGids":["120..."]}'
```

(List available targets first with `composio:listAvailableSlackChannelsForOrg`
/ `composio:listAvailableAsanaProjectsForOrg`.) From here, everything else is
reachable through MCP: point any client at `SPARK_MCP_URL` with the key from
step 2 and use `spark_search`, `spark_ask`, `spark_entity`, `spark_push`.
