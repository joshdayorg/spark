#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const debug = fs.readFileSync(path.join(repoRoot, "convex", "debug.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const http = fs.readFileSync(path.join(repoRoot, "convex", "http.ts"), "utf8");
const mcpPushContract = fs.readFileSync(
  path.join(repoRoot, "convex", "mcpPushContract.ts"),
  "utf8",
);

function fail(message) {
  console.error(`Yellow 2 debug probe safety proof failed: ${message}`);
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

const debugKeyGuard = extractFunction(debug, "assertYellow2DebugApiKey");
const countGuard = extractFunction(debug, "validateYellow2RateLimitSeedCount");
const indexedEventLoader = extractFunction(
  debug,
  "listYellow2McpSmokeEventsByCase",
);
const cleanup = extractFunction(debug, "cleanupYellow2aMcpSmokeArtifacts");
const revokeApiKey = extractExportedFunction(debug, "yellow2aRevokeApiKey");
const seedRateLimit = extractExportedFunction(debug, "yellow2c1SeedMcpRateLimit");
const countEvents = extractExportedFunction(debug, "yellow2c1CountEventsByCase");
const mcpPush = extractExportedFunction(spark, "mcpPush");

assert(
  /createdBy !== YELLOW2A_DEBUG_API_KEY_CREATED_BY/.test(debugKeyGuard) &&
    /Yellow 2 debug API key required/.test(debugKeyGuard),
  "destructive Yellow 2 API-key probes must share a debug-key sentinel guard",
);
assert(
  /assertYellow2DebugApiKey\(apiKey\);/.test(revokeApiKey),
  "yellow2aRevokeApiKey must reject non-debug API keys before revoking",
);
assert(
  /assertYellow2DebugApiKey\(apiKey, args\.orgId\);/.test(seedRateLimit),
  "yellow2c1SeedMcpRateLimit must reject non-debug API keys for the target org",
);
assert(
  /Number\.isSafeInteger\(count\)/.test(countGuard) &&
    /count < 0/.test(countGuard) &&
    /YELLOW2C1_MAX_DEBUG_RATE_LIMIT_COUNT/.test(countGuard) &&
    /validateYellow2RateLimitSeedCount\(args\.count\);/.test(seedRateLimit),
  "yellow2c1SeedMcpRateLimit must bound seeded debug rate-limit counts",
);
assert(
  /eventIds\?: Id<"events">\[\]/.test(indexedEventLoader) &&
    /for \(const eventId of args\.eventIds\)/.test(indexedEventLoader),
  "Yellow 2 event cleanup must support explicit event-id cleanup",
);
assert(
  /\.withIndex\("by_org_source_via_delivery"/.test(indexedEventLoader) &&
    /\.eq\("orgId", args\.orgId\)/.test(indexedEventLoader) &&
    /\.eq\("source", "custom"\)/.test(indexedEventLoader) &&
    /\.eq\("via", "api"\)/.test(indexedEventLoader) &&
    /\.gte\("sourceDeliveryId", prefix\)/.test(indexedEventLoader) &&
    /\.lt\("sourceDeliveryId", upperBound\)/.test(indexedEventLoader) &&
    /\.take\(YELLOW2_MCP_SMOKE_EVENT_SCAN_LIMIT \+ 1\)/.test(indexedEventLoader),
  "Yellow 2 event lookup must use the scoped sourceDeliveryId index with a bounded take",
);
assert(
  /listYellow2McpSmokeEventsByCase\(ctx/.test(cleanup) &&
    !/\.query\("events"\)[\s\S]*\.withIndex\("by_org"/.test(cleanup),
  "Yellow 2 cleanup must not collect all events for an org",
);
assert(
  /listYellow2McpSmokeEventsByCase\(ctx/.test(countEvents) &&
    /truncated/.test(countEvents) &&
    !/\.query\("events"\)[\s\S]*\.withIndex\("by_org"/.test(countEvents),
  "Yellow 2 count-by-case must use indexed bounded lookup and report truncation",
);
assert(
  /sourceDeliveryId\?: string;/.test(mcpPushContract) &&
    /readOptionalTrimmedString\(payload, "sourceDeliveryId"\)/.test(
      mcpPushContract,
    ),
  "spark_push validation must accept a non-empty optional sourceDeliveryId",
);
assert(
  /\.\.\.\(event\.sourceDeliveryId \? \{ sourceDeliveryId: event\.sourceDeliveryId \} : \{\}\)/.test(
    mcpPush,
  ),
  "mcpPush must persist the optional sourceDeliveryId through insertEvent",
);
assert(
  /sourceDeliveryId: z4\.string\(\)\.min\(1\)\.optional\(\)/.test(http),
  "MCP protocol spark_push schema must expose optional sourceDeliveryId",
);

console.log(
  "Yellow 2 debug probe safety proof passed: destructive API-key probes are debug-gated and event probes use bounded indexed lookup.",
);
NODE
