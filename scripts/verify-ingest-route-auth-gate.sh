#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const http = fs.readFileSync(path.join(repoRoot, "convex", "http.ts"), "utf8");
const ingest = fs.readFileSync(path.join(repoRoot, "convex", "ingest.ts"), "utf8");

function fail(message) {
  console.error(`Ingest route auth gate proof failed: ${message}`);
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
  const nextRoute = text.indexOf("\nhttp.route", start + marker.length);
  const candidates = [nextFunction, nextAsyncFunction, nextRoute].filter(
    (index) => index !== -1,
  );
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

function extractRoute(text, routePath) {
  const marker = `path: "${routePath}"`;
  const pathIndex = text.indexOf(marker);
  if (pathIndex === -1) {
    fail(`could not find route ${routePath}`);
  }
  const start = text.lastIndexOf("http.route({", pathIndex);
  if (start === -1) {
    fail(`could not find route start for ${routePath}`);
  }
  const nextRoute = text.indexOf("\nhttp.route", pathIndex + marker.length);
  return text.slice(start, nextRoute === -1 ? text.length : nextRoute);
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

const gate = extractFunction(http, "assertAuthorizedIngestRequest");
const ingestRoute = extractRoute(http, "/ingest");
const normalizeAndInsert = extractExportedFunction(ingest, "normalizeAndInsert");

assert(
  /getBearerTokenFromAuthorization\(headers\.get\("authorization"\)\)/.test(gate),
  "ingest route gate must accept API-key bearer auth as an explicit trust signal",
);
assert(
  /getNonEmptyHeader\(headers, "x-github-event"\)[\s\S]*getNonEmptyHeader\(headers, "x-hub-signature-256"\)/.test(
    gate,
  ),
  "ingest route gate must require GitHub event and signature headers",
);
assert(
  /getNonEmptyHeader\(headers, "webhook-id"\)[\s\S]*getNonEmptyHeader\(headers, "webhook-timestamp"\)[\s\S]*getNonEmptyHeader\(headers, "webhook-signature"\)/.test(
    gate,
  ),
  "ingest route gate must require Composio webhook id, timestamp, and signature headers",
);
assert(
  /throw new Error\(\s*"AUTH: ingest requires/.test(gate),
  "ingest route gate must reject requests without an accepted trust signal",
);
assert(
  /assertAuthorizedIngestRequest\(request\);[\s\S]*const parsed = await parseJsonRequest\(request\);[\s\S]*ctx\.runAction\(internal\.ingest\.normalizeAndInsert, parsed\)/.test(
    ingestRoute,
  ),
  "POST /ingest must authorize before parsing JSON or dispatching normalizeAndInsert",
);
assert(
  ingestRoute.indexOf("assertAuthorizedIngestRequest(request);") <
    ingestRoute.indexOf("parseJsonRequest(request)") &&
    ingestRoute.indexOf("assertAuthorizedIngestRequest(request);") <
      ingestRoute.indexOf("internal.ingest.normalizeAndInsert"),
  "POST /ingest guard must run before any body parsing or write action dispatch",
);
assert(
  /verifyHmacSha256\(\{[\s\S]*providedSignature: headers\.get\("x-hub-signature-256"\)/.test(
    normalizeAndInsert,
  ),
  "normalizeAndInsert must still verify GitHub webhook signatures after the route preflight",
);
assert(
  /verifyComposioWebhookSignature\(\{[\s\S]*webhookSignature: headers\.get\("webhook-signature"\)/.test(
    normalizeAndInsert,
  ),
  "normalizeAndInsert must still verify Composio webhook signatures after the route preflight",
);
assert(
  /authHeader\?\.startsWith\("Bearer "\)/.test(normalizeAndInsert) &&
    /lookupOrgByApiKey/.test(normalizeAndInsert),
  "normalizeAndInsert must still resolve Bearer API keys after the route preflight",
);

console.log(
  "Ingest route auth gate proof passed: public ingest rejects unauthenticated writes before parsing or dispatch.",
);
NODE
