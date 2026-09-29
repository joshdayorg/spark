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

function fail(message) {
  console.error(`Composio webhook no-org proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractExportedFunction(text, exportName) {
  const marker = `export const ${exportName} =`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find export ${exportName}`);
  }
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  return text.slice(start, nextExport === -1 ? text.length : nextExport);
}

const normalizeAndInsert = extractExportedFunction(ingest, "normalizeAndInsert");
const composioStart = normalizeAndInsert.indexOf(
  'if (getString(body, "type") === "composio.trigger.message")',
);
const bearerStart = normalizeAndInsert.indexOf(
  'if (authHeader?.startsWith("Bearer "))',
  composioStart,
);

if (composioStart === -1 || bearerStart === -1) {
  fail("could not isolate Composio webhook branch");
}

const composioBranch = normalizeAndInsert.slice(composioStart, bearerStart);
const signatureIndex = composioBranch.indexOf("await verifyComposioWebhookSignature");
const lookupIndex = composioBranch.indexOf("internal.spark.resolveOrgIdByComposioUserId");
const nullGuardIndex = composioBranch.indexOf("if (orgId === null)");
const adapterIndex = composioBranch.indexOf("new Composio({ apiKey: composioApiKey })");
const insertIndex = composioBranch.indexOf("ctx.runMutation(internal.spark.insertEvent");

assert(
  signatureIndex !== -1 && lookupIndex !== -1 && signatureIndex < lookupIndex,
  "Composio webhook signature must be verified before resolving metadata.user_id",
);
assert(
  /\)\) as OrgId \| null;/.test(composioBranch),
  "resolveOrgIdByComposioUserId result must be treated as nullable",
);
assert(
  /const triggerSlug = getString\(metadata, "trigger_slug"\);[\s\S]*resolveOrgIdByComposioUserId/.test(
    composioBranch,
  ),
  "trigger slug must be available for stale mapping diagnostics before lookup handling",
);
assert(
  /if \(orgId === null\) \{[\s\S]*console\.warn\("spark:composio-webhook-no-org", \{[\s\S]*userId: clerkOrgId,[\s\S]*triggerSlug,[\s\S]*sourceDeliveryId,[\s\S]*return null;[\s\S]*\}/.test(
    composioBranch,
  ),
  "missing or stale Composio org mappings must warn and acknowledge without inserting",
);
assert(
  nullGuardIndex !== -1 &&
    adapterIndex !== -1 &&
    insertIndex !== -1 &&
    nullGuardIndex < adapterIndex &&
    nullGuardIndex < insertIndex,
  "stale mapping guard must run before adapter calls or insertEvent",
);

console.log(
  "Composio webhook no-org proof passed: stale metadata.user_id mappings are acknowledged before event insertion.",
);
NODE
