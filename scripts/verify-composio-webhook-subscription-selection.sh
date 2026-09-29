#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const composio = fs.readFileSync(
  path.join(repoRoot, "convex", "composio.ts"),
  "utf8",
);

function fail(message) {
  console.error(`Composio webhook subscription proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractFunction(text, functionName) {
  const marker = `function ${functionName}`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + marker.length);
  const nextAsyncFunction = text.indexOf("\nasync function ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const candidates = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
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

const findSubscription = extractFunction(
  composio,
  "findComposioWebhookSubscription",
);
const desiredPredicate = extractFunction(
  composio,
  "isDesiredComposioWebhookSubscription",
);
const updateSubscription = extractFunction(
  composio,
  "updateComposioWebhookSubscription",
);
const ensureSubscription = extractExportedFunction(
  composio,
  "ensureComposioWebhookSubscription",
);

assert(
  /const COMPOSIO_WEBHOOK_ENABLED_EVENTS = \["composio\.trigger\.message"\];/.test(
    composio,
  ) && /const COMPOSIO_WEBHOOK_VERSION = "V3";/.test(composio),
  "desired webhook event and version constants must be explicit",
);
assert(
  !/subscriptions\[0\]/.test(ensureSubscription),
  "ensureComposioWebhookSubscription must not manage the first listed subscription blindly",
);
assert(
  /getString\(subscription, "webhook_url"\) === webhookUrl/.test(
    desiredPredicate,
  ) &&
    /getString\(subscription, "version"\) === COMPOSIO_WEBHOOK_VERSION/.test(
      desiredPredicate,
    ) &&
    /getStringArray\(subscription, "enabled_events"\)/.test(desiredPredicate),
  "desired subscription predicate must match webhook URL, version, and enabled events",
);
assert(
  /records\.find\(\(subscription\) =>[\s\S]*isDesiredComposioWebhookSubscription\(subscription, webhookUrl\)/.test(
    findSubscription,
  ) &&
    /records\.find\([\s\S]*getString\(subscription, "webhook_url"\) === webhookUrl/.test(
      findSubscription,
    ) &&
    /records\.length === 1 \? records\[0\] : null/.test(findSubscription),
  "subscription selection must prefer exact matches and only fall back to the documented singleton subscription",
);
assert(
  /encodeURIComponent\(subscriptionId\)/.test(updateSubscription) &&
    /webhook_url: webhookUrl/.test(updateSubscription) &&
    /enabled_events: COMPOSIO_WEBHOOK_ENABLED_EVENTS/.test(updateSubscription) &&
    /version: COMPOSIO_WEBHOOK_VERSION/.test(updateSubscription),
  "updates must target the matched subscription id and preserve desired URL/events/version",
);
assert(
  /const refreshedSubscriptions = await listComposioWebhookSubscriptions\(apiKey\);[\s\S]*const racedSubscription = findComposioWebhookSubscription\([\s\S]*refreshedSubscriptions,[\s\S]*args\.webhookUrl/.test(
    ensureSubscription,
  ),
  "ensureComposioWebhookSubscription must re-check for a raced subscription before creating",
);
assert(
  /createResponse\.status === 409[\s\S]*const conflictSubscriptions = await listComposioWebhookSubscriptions\(apiKey\);[\s\S]*const conflictSubscription = findComposioWebhookSubscription\([\s\S]*conflictSubscriptions,[\s\S]*args\.webhookUrl/.test(
    ensureSubscription,
  ),
  "create conflict path must re-read and adopt the matching subscription",
);
assert(
  /body: JSON\.stringify\(\{[\s\S]*webhook_url: args\.webhookUrl,[\s\S]*enabled_events: COMPOSIO_WEBHOOK_ENABLED_EVENTS,[\s\S]*version: COMPOSIO_WEBHOOK_VERSION/.test(
    ensureSubscription,
  ),
  "create request must use the desired webhook URL, events, and version",
);

console.log(
  "Composio webhook subscription proof passed: reconciliation selects exact subscriptions, adopts the documented singleton, and re-checks before create.",
);
NODE
