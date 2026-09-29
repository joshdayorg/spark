#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`MCP API-key lastUsedAt proof failed: ${message}`);
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

function extractFunction(text, functionName) {
  const marker = `function ${functionName}`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const candidates = [nextFunction, nextExport].filter((index) => index !== -1);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

const lookupAuth = extractExportedFunction(spark, "lookupMcpApiKeyAuthByHash");
const checkRateLimit = extractExportedFunction(spark, "checkMcpApiKeyRateLimit");
const lastUsedHelper = extractFunction(spark, "patchMcpApiKeyLastUsed");
const deniedBranchMatch = checkRateLimit.match(
  /if \(existing\.count >= limit\) \{([\s\S]*?)\n    \}/,
);
const lastUsedCallCount = [
  ...checkRateLimit.matchAll(/await patchMcpApiKeyLastUsed\(ctx, apiKey, now\);/g),
].length;

assert(
  /const MCP_API_KEY_LAST_USED_UPDATE_INTERVAL_MS = 5 \* 60 \* 1000;/.test(spark),
  "lastUsedAt update interval must be explicit and coarse",
);
assert(
  /apiKey\.lastUsedAt > now - MCP_API_KEY_LAST_USED_UPDATE_INTERVAL_MS/.test(
    lastUsedHelper,
  ) && /ctx\.db\.patch\(apiKey\._id, \{ lastUsedAt: now \}\)/.test(lastUsedHelper),
  "lastUsedAt helper must throttle writes before patching apiKeys",
);
assert(
  !/lastUsedAt/.test(lookupAuth) && !/db\.patch\(apiKey\._id/.test(lookupAuth),
  "MCP API-key auth lookup must not patch lastUsedAt before parsing or rate limiting",
);
assert(
  deniedBranchMatch,
  "could not find over-limit branch in checkMcpApiKeyRateLimit",
);
assert(
  !/patchMcpApiKeyLastUsed/.test(deniedBranchMatch[1]) &&
    /allowed: false/.test(deniedBranchMatch[1]),
  "over-limit requests must return without patching apiKeys.lastUsedAt",
);
assert(
  lastUsedCallCount === 2,
  `expected lastUsedAt to be patched only in the two allowed rate-limit branches; got ${lastUsedCallCount}`,
);
assert(
  /if \(!existing\) \{[\s\S]*await db\.insert\("mcpRateLimits"[\s\S]*await patchMcpApiKeyLastUsed\(ctx, apiKey, now\);[\s\S]*allowed: true/.test(
    checkRateLimit,
  ),
  "first request in a bucket must patch lastUsedAt only after creating an allowed bucket",
);
assert(
  /const nextCount = existing\.count \+ 1;[\s\S]*await db\.patch\(existing\._id[\s\S]*await patchMcpApiKeyLastUsed\(ctx, apiKey, now\);[\s\S]*allowed: true/.test(
    checkRateLimit,
  ),
  "subsequent under-limit requests must patch lastUsedAt only after allowed rate-limit accounting",
);

console.log(
  "MCP API-key lastUsedAt proof passed: auth lookup is read-only and only allowed, throttled tool calls update usage.",
);
NODE
