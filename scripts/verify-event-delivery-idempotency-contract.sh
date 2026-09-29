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

function fail(message) {
  console.error(`Event delivery idempotency contract proof failed: ${message}`);
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

const composioBranch = extractBlock(
  ingest,
  'if (getString(body, "type") === "composio.trigger.message")',
  'if (authHeader?.startsWith("Bearer "))',
);
const apiBranch = extractBlock(
  ingest,
  'if (authHeader?.startsWith("Bearer "))',
  'throw new Error("BAD_REQUEST: unsupported ingest source")',
);
const insertEvent = extractBlock(
  spark,
  "export const insertEvent = internalMutation",
  "export const ingestTestEvents = internalMutation",
);

assert(
  /const sourceDeliveryId = normalizeOptionalString\(headers\.get\("webhook-id"\)\)/.test(
    composioBranch,
  ),
  "Composio branch must normalize webhook-id as sourceDeliveryId",
);
assert(
  /webhookId: sourceDeliveryId \?\? null/.test(composioBranch),
  "Composio signature verification must use the normalized webhook id",
);
assert(
  /\.\.\.\(sourceDeliveryId \? \{ sourceDeliveryId \} : \{\}\)/.test(
    composioBranch,
  ),
  "Composio insertEvent call must persist sourceDeliveryId",
);
assert(
  /const sourceDeliveryId = normalizeOptionalString\([\s\S]*getString\(payload, "sourceDeliveryId"\)[\s\S]*\)/.test(
    apiBranch,
  ),
  "API ingest branch must accept explicit sourceDeliveryId",
);
assert(
  /\.\.\.\(sourceDeliveryId \? \{ sourceDeliveryId \} : \{\}\)/.test(
    apiBranch,
  ),
  "API insertEvent call must pass explicit sourceDeliveryId",
);
assert(
  /sourceDeliveryId: v\.optional\(v\.string\(\)\)/.test(insertEvent),
  "insertEvent must accept sourceDeliveryId (real validator after the loose* burn-down)",
);
assert(
  /\.withIndex\("by_org_source_via_delivery", \(q\) =>[\s\S]*\.eq\("orgId", args\.orgId\)[\s\S]*\.eq\("source", args\.source\)[\s\S]*\.eq\("via", args\.via\)[\s\S]*\.eq\("sourceDeliveryId", args\.sourceDeliveryId\)/.test(
    insertEvent,
  ),
  "insertEvent must dedupe only through the scoped sourceDeliveryId index",
);
assert(
  !/const rawId\s*=/.test(insertEvent) &&
    !/existingId === rawId/.test(insertEvent) &&
    !/\.withIndex\("by_org", \(q\) => q\.eq\("orgId", args\.orgId\)\)[\s\S]*\.take\(100\)/.test(insertEvent),
  "insertEvent must not dedupe distinct events by an arbitrary raw.id scan",
);

console.log("Event delivery idempotency contract proof passed: provider delivery ids dedupe retries without raw.id data loss.");
NODE
