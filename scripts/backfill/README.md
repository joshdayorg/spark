# Historical backfills — standalone by design

The in-Convex backfill actions (`backfillSlackForOrg`, `backfillAsanaForOrg`,
`backfillGithubForOrg`) were removed on 2026-08-30. They violated the
one-normalizer rule (S-10): they lived in `convex/composio.ts` as
internalActions and inserted events directly via `internal.spark.insertEvent`,
bypassing `POST /ingest` — its normalization, signature verification, and the
ingest auth gate.

## The sanctioned pattern

Backfills are operator tooling, not product surface. Re-implement them as
standalone scripts (this directory) that:

1. Read history from the source API (Slack/Asana/GitHub) with operator
   credentials — never Convex env secrets.
2. POST each item to `https://<deployment>.convex.site/ingest` through the
   **API pipe**: `Authorization: Bearer <org-api-key>`, body with
   `source`, `type`, `actor`, `summary`, `timestamp` (the original event
   time), and a stable `sourceDeliveryId` so re-runs dedupe server-side.
3. Rate-limit themselves (the API pipe allows 60 writes/min per key).

The removed implementations are not part of this public repository. When
you write a standalone backfill, take the source-API details from the vendor
docs: Slack message timestamps (`ts` is seconds with a fractional part), Asana
story filtering, and GitHub App JWT authentication. Keep attribution rules the
same as the live normalizer in `convex/ingest.ts`.
