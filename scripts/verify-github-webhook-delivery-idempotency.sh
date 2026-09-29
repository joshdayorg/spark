#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const ingest = fs.readFileSync(path.join(repoRoot, "convex", "ingest.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const schema = fs.readFileSync(path.join(repoRoot, "convex", "schema.ts"), "utf8");

function fail(message) {
  console.error(`GitHub webhook delivery idempotency proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractBlock(text, startMarker, endMarker = null) {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    fail(`could not find ${startMarker}`);
  }
  if (endMarker === null) {
    return text.slice(start);
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? text.length : end);
}

const insertGithubWebhookEvent = extractBlock(
  ingest,
  "async function insertGithubWebhookEvent",
  "// =====================",
);
const githubBranch = extractBlock(
  ingest,
  "if (githubEvent) {",
  'if (getString(body, "type") === "composio.trigger.message")',
);
const insertEvent = extractBlock(
  spark,
  "export const insertEvent = internalMutation",
  "export const ingestTestEvents = internalMutation",
);
const deliveryDedupe = extractBlock(
  insertEvent,
  "if (args.sourceDeliveryId) {",
  "return ctx.db.insert",
);
const eventsSchema = extractBlock(
  schema,
  "events: defineTable",
  "sessions: defineTable",
);

assert(
  /sourceDeliveryId\?: string;/.test(insertGithubWebhookEvent),
  "insertGithubWebhookEvent must accept sourceDeliveryId",
);
assert(
  /sourceDeliveryId: v\.optional\(v\.string\(\)\)/.test(eventsSchema),
  "events schema must persist sourceDeliveryId",
);
assert(
  /\.index\("by_org_source_via_delivery",[\s\S]*"orgId"[\s\S]*"source"[\s\S]*"via"[\s\S]*"sourceDeliveryId"/.test(eventsSchema),
  "events schema must keep the provider delivery index",
);
assert(
  /const sourceDeliveryId = normalizeOptionalString\(\s*headers\.get\("x-github-delivery"\),?\s*\);/.test(githubBranch),
  "GitHub ingest branch must read and normalize x-github-delivery",
);
assert(
  githubBranch.indexOf("const sourceDeliveryId = normalizeOptionalString") <
    githubBranch.indexOf("return insertGithubWebhookEvent"),
  "GitHub ingest branch must normalize the delivery id before event insertion",
);
assert(
  /insertGithubWebhookEvent\(ctx, \{[\s\S]*orgId,[\s\S]*githubEvent,[\s\S]*sourceDeliveryId,[\s\S]*body,[\s\S]*\}\)/.test(githubBranch),
  "GitHub ingest branch must forward sourceDeliveryId into insertGithubWebhookEvent",
);
assert(
  /ctx\.runMutation\(internal\.spark\.insertEvent, \{[\s\S]*source: "github",[\s\S]*via: "webhook",[\s\S]*\.\.\.\(args\.sourceDeliveryId \? \{ sourceDeliveryId: args\.sourceDeliveryId \} : \{\}\),[\s\S]*raw: args\.body,[\s\S]*\}\);/.test(
    insertGithubWebhookEvent,
  ),
  "insertGithubWebhookEvent must forward sourceDeliveryId to insertEvent without deriving it from raw payload data",
);
assert(
  /\.query\("events"\)[\s\S]*\.withIndex\("by_org_source_via_delivery", \(q\) =>[\s\S]*\.eq\("orgId", args\.orgId\)[\s\S]*\.eq\("source", args\.source\)[\s\S]*\.eq\("via", args\.via\)[\s\S]*\.eq\("sourceDeliveryId", args\.sourceDeliveryId\)[\s\S]*\.first\(\)/.test(deliveryDedupe),
  "insertEvent must query the indexed provider delivery key",
);
assert(
  /return existingDelivery\._id;/.test(deliveryDedupe),
  "insertEvent must return the existing delivery event id",
);
assert(
  insertEvent.indexOf("if (args.sourceDeliveryId) {") < insertEvent.indexOf("ctx.db.insert"),
  "sourceDeliveryId dedupe must run before insert",
);
assert(
  /ctx\.db\.insert\("events", \{[\s\S]*\.\.\.\(args\.sourceDeliveryId \? \{ sourceDeliveryId: args\.sourceDeliveryId \} : \{\}\),[\s\S]*raw: args\.raw/.test(
    insertEvent,
  ),
  "insertEvent must persist sourceDeliveryId on newly inserted events",
);

console.log("GitHub webhook delivery idempotency proof passed: x-github-delivery is stored and deduped through the delivery index.");
NODE
