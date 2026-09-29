#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const schema = fs.readFileSync(path.join(repoRoot, "convex", "schema.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`Extraction fan-out claimable events proof failed: ${message}`);
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
  const asyncMarker = `async function ${functionName}`;
  const markerStart = text.indexOf(marker);
  const asyncMarkerStart = text.indexOf(asyncMarker);
  const start = markerStart === -1 ? asyncMarkerStart : markerStart;
  if (start === -1) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + marker.length);
  const nextAsyncFunction = text.indexOf("\nasync function ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const boundaries = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = boundaries.length === 0 ? text.length : Math.min(...boundaries);
  return text.slice(start, end);
}

const listUnprocessedEventCandidates = extractFunction(
  spark,
  "listUnprocessedEventCandidates",
);
const isClaimableUnprocessedEvent = extractFunction(
  spark,
  "isClaimableUnprocessedEvent",
);
const hasClaimableUnprocessedEvents = extractExportedFunction(
  spark,
  "hasClaimableUnprocessedEvents",
);
const claimUnprocessedEvents = extractExportedFunction(
  spark,
  "claimUnprocessedEvents",
);
const extractionFanOut = extractExportedFunction(spark, "extractionFanOut");

assert(
  /processed:\s*v\.optional\(v\.boolean\(\)\).*undefined is unprocessed/.test(schema),
  "events.processed must remain migration-safe for legacy missing values",
);
assert(
  /\.index\("by_org_unprocessed", \["orgId", "processed", "timestamp"\]\)/.test(schema),
  "events must keep the processed/timestamp index",
);
assert(
  /const CLAIM_TIMEOUT_MS = 10 \* 60 \* 1000;/.test(spark) &&
    /const CLAIM_BATCH_SIZE = 100;/.test(spark),
  "extractor claim timeout and batch limit must remain explicit",
);

assert(
  /\.withIndex\("by_org_unprocessed", \(q\) =>[\s\S]*\.eq\("processed", false\)[\s\S]*\.take\(args\.limit\)/.test(listUnprocessedEventCandidates) &&
    /\.withIndex\("by_org_unprocessed", \(q\) =>[\s\S]*\.eq\("processed", undefined\)[\s\S]*\.take\(args\.limit\)/.test(listUnprocessedEventCandidates),
  "shared candidate loader must include explicit and legacy unprocessed rows with bounded reads",
);
assert(
  /\.sort\(\(left, right\) => left\.timestamp - right\.timestamp\)[\s\S]*\.slice\(0, args\.limit\)/.test(listUnprocessedEventCandidates),
  "shared candidate loader must merge candidate sets into a bounded timestamp-ordered batch",
);
assert(
  /return !event\.claimedAt \|\| event\.claimedAt < staleThreshold;/.test(isClaimableUnprocessedEvent),
  "claimable predicate must reject fresh claimed rows and allow unclaimed or stale rows",
);

assert(
  /now:\s*v\.optional\(v\.number\(\)\)/.test(hasClaimableUnprocessedEvents) &&
    /const now = args\.now \?\? Date\.now\(\);/.test(hasClaimableUnprocessedEvents) &&
    /const staleThreshold = now - CLAIM_TIMEOUT_MS;/.test(hasClaimableUnprocessedEvents),
  "fan-out preflight must accept deterministic now and use the claim timeout",
);
assert(
  /listUnprocessedEventCandidates\(ctx,[\s\S]*limit: CLAIM_BATCH_SIZE/.test(hasClaimableUnprocessedEvents) &&
    /return candidates\.some\(\(event\) =>[\s\S]*isClaimableUnprocessedEvent\(event, staleThreshold\)/.test(hasClaimableUnprocessedEvents),
  "fan-out preflight must mirror claim candidate and claimable predicates",
);
assert(
  /now:\s*v\.optional\(v\.number\(\)\)/.test(claimUnprocessedEvents) &&
    /const now = args\.now \?\? Date\.now\(\);/.test(claimUnprocessedEvents) &&
    /const staleThreshold = now - CLAIM_TIMEOUT_MS;/.test(claimUnprocessedEvents) &&
    /listUnprocessedEventCandidates\(ctx,[\s\S]*limit: CLAIM_BATCH_SIZE/.test(claimUnprocessedEvents) &&
    /for \(const event of candidates\) \{[\s\S]*!isClaimableUnprocessedEvent\(event, staleThreshold\)[\s\S]*continue;[\s\S]*claimable\.push\(event\);/.test(claimUnprocessedEvents),
  "claim mutation must use the same deterministic stale threshold and claimable predicate",
);
assert(
  /ctx\.db\.patch\(event\._id, \{ processed: false, claimedAt: now \}\)/.test(claimUnprocessedEvents),
  "claim mutation must backfill legacy processed state while claiming",
);
assert(
  /const now = Date\.now\(\);/.test(extractionFanOut) &&
    /internal\.spark\.hasClaimableUnprocessedEvents/.test(extractionFanOut) &&
    /orgId,[\s\S]*now,/.test(extractionFanOut) &&
    /ctx\.scheduler\.runAfter\(0, internal\.spark\.runExtractor, \{ orgId \}\)/.test(extractionFanOut),
  "extraction fan-out must schedule only orgs with claimable events using a shared now",
);
assert(
  !/internal\.spark\.hasUnprocessedEvents/.test(extractionFanOut),
  "extraction fan-out must not use the old non-claimable preflight",
);

console.log("Extraction fan-out claimable events proof passed: fan-out skips fresh leases while legacy and stale rows remain claimable.");
NODE
