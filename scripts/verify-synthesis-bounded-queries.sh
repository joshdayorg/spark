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
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");

function fail(message) {
  console.error(`Synthesis bounded query proof failed: ${message}`);
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
  const start = text.indexOf(marker) === -1
    ? text.indexOf(asyncMarker)
    : text.indexOf(marker);
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

const findStaleSynthesisRuns = extractExportedFunction(
  knowledge,
  "findStaleSynthesisRuns",
);
const findRecoverableFailedSynthesisRuns = extractExportedFunction(
  knowledge,
  "findRecoverableFailedSynthesisRuns",
);
const getSynthesisDependencyReadiness = extractExportedFunction(
  knowledge,
  "getSynthesisDependencyReadiness",
);
const getSynthesisFanOutState = extractExportedFunction(
  knowledge,
  "getSynthesisFanOutState",
);
const getSynthesisInputs = extractExportedFunction(
  knowledge,
  "getSynthesisInputs",
);
const sessionCandidates = extractFunction(
  knowledge,
  "listSynthesisSessionCandidates",
);
const updatedCandidates = extractFunction(
  knowledge,
  "listUpdatedSynthesisCandidates",
);
const goalCandidates = extractFunction(
  knowledge,
  "listSynthesisGoalCandidates",
);
const findingCandidates = extractFunction(
  knowledge,
  "listSynthesisFindingCandidates",
);
const lowerSyntheses = extractFunction(
  knowledge,
  "listCompletedLowerSynthesesForWindow",
);

for (const [indexName, fields] of [
  ["by_org_type_status_updatedAt", '["orgId", "type", "status", "updatedAt"]'],
  ["by_org_type_status_sessionEndTime", '["orgId", "type", "status", "sessionEndTime"]'],
  ["by_org_type_status_targetDate", '["orgId", "type", "status", "targetDate"]'],
  ["by_org_type_status_severity_updatedAt", '["orgId", "type", "status", "severity", "updatedAt"]'],
  ["by_status_claimedAt", '["status", "claimedAt", "timestamp"]'],
  ["by_status_nextRetryAt", '["status", "nextRetryAt", "timestamp"]'],
  ["by_status_updatedAt", '["status", "updatedAt", "timestamp"]'],
  ["by_org_period_status_timestamp", '["orgId", "period", "status", "timestamp"]'],
]) {
  assert(
    schema.includes(`.index("${indexName}", ${fields})`),
    `schema must define ${indexName}`,
  );
}

assert(
  /const SYNTHESIS_INPUT_QUERY_CANDIDATE_MAX = 200;/.test(knowledge) &&
    /const SYNTHESIS_FAN_OUT_RELEVANCE_LIMIT = 25;/.test(knowledge) &&
    /const SYNTHESIS_DEPENDENCY_ROWS_PER_WINDOW_LIMIT = 4;/.test(knowledge),
  "bounded synthesis read constants must be present",
);

for (const [name, text] of [
  ["findStaleSynthesisRuns", findStaleSynthesisRuns],
  ["findRecoverableFailedSynthesisRuns", findRecoverableFailedSynthesisRuns],
  ["getSynthesisDependencyReadiness", getSynthesisDependencyReadiness],
  ["getSynthesisFanOutState", getSynthesisFanOutState],
  ["getSynthesisInputs", getSynthesisInputs],
]) {
  assert(!/\.collect\(\)/.test(text), `${name} must not collect unbounded query results`);
  assert(!/\.filter\(\(q\)/.test(text), `${name} must not use Convex filters after scans`);
}

assert(
  /\.withIndex\("by_status_claimedAt", \(q\) =>[\s\S]*\.eq\("status", "in_progress"\)\.lt\("claimedAt", args\.staleBefore\)[\s\S]*\.take\(limit\)/.test(findStaleSynthesisRuns),
  "stale synthesis finder must use status/claimedAt index with take(limit)",
);
assert(
  /\.withIndex\("by_status_nextRetryAt", \(q\) =>[\s\S]*\.eq\("status", "failed"\)\.lte\("nextRetryAt", args\.now\)[\s\S]*\.take\(limit\)/.test(findRecoverableFailedSynthesisRuns) &&
    /\.withIndex\("by_status_updatedAt", \(q\) =>[\s\S]*\.eq\("status", "failed"\)\.lt\("updatedAt", legacyRetryCutoff\)[\s\S]*\.take\(limit\)/.test(findRecoverableFailedSynthesisRuns) &&
    /const failed = uniqueDocsById\(\[\.\.\.scheduledRetryFailed, \.\.\.legacyFailed\]\);/.test(findRecoverableFailedSynthesisRuns),
  "failed synthesis finder must use bounded retry and legacy indexes",
);
assert(
  /expected\.map\(\(dependency\) =>[\s\S]*\.withIndex\("by_org_period", \(q\) =>[\s\S]*\.eq\("timestamp", dependency\.timestamp\)[\s\S]*\.take\(SYNTHESIS_DEPENDENCY_ROWS_PER_WINDOW_LIMIT\)/.test(getSynthesisDependencyReadiness),
  "dependency readiness must read only bounded expected windows",
);

assert(
  /listSynthesisSessionCandidates\(ctx/.test(getSynthesisFanOutState) &&
    /listUpdatedSynthesisCandidates\(ctx/.test(getSynthesisFanOutState) &&
    /listCompletedLowerSynthesesForWindow\(ctx/.test(getSynthesisFanOutState) &&
    /\.take\(2\)/.test(getSynthesisFanOutState),
  "fan-out state must use bounded helper reads and bounded target lookup",
);
assert(
  /const pageReadLimit = clampSynthesisCandidateReadLimit\(pageLimit\);/.test(getSynthesisInputs) &&
    /listSynthesisSessionCandidates\(ctx/.test(getSynthesisInputs) &&
    /listUpdatedSynthesisCandidates\(ctx/.test(getSynthesisInputs) &&
    /listSynthesisGoalCandidates\(ctx/.test(getSynthesisInputs) &&
    /listSynthesisFindingCandidates\(ctx/.test(getSynthesisInputs) &&
    /listCompletedLowerSynthesesForWindow\(ctx/.test(getSynthesisInputs),
  "synthesis inputs must use bounded helper reads",
);

for (const [name, text] of [
  ["listSynthesisSessionCandidates", sessionCandidates],
  ["listUpdatedSynthesisCandidates", updatedCandidates],
  ["listSynthesisGoalCandidates", goalCandidates],
  ["listSynthesisFindingCandidates", findingCandidates],
  ["listCompletedLowerSynthesesForWindow", lowerSyntheses],
]) {
  assert(!/\.collect\(\)/.test(text), `${name} must not collect`);
  assert(!/\.filter\(\(q\)/.test(text), `${name} must not use Convex filters`);
  assert(/\.take\(args\.readLimit\)/.test(text), `${name} must cap reads with args.readLimit`);
}

assert(
  /by_org_type_status_sessionEndTime/.test(sessionCandidates) &&
    /by_org_type_status_updatedAt/.test(sessionCandidates),
  "session candidates must use bounded session window indexes",
);
assert(
  /by_org_status/.test(updatedCandidates) &&
    /\.gte\("updatedAt", args\.timestamp\)[\s\S]*\.lt\("updatedAt", args\.windowEnd\)/.test(updatedCandidates),
  "updated page candidates must push updatedAt window into the index",
);
assert(
  /by_org_type_status_targetDate/.test(goalCandidates) &&
    /by_org_type_status_updatedAt/.test(goalCandidates),
  "goal candidates must use bounded target date and recency indexes",
);
assert(
  /by_org_type_status_severity_updatedAt/.test(findingCandidates) &&
    /by_org_type_status_updatedAt/.test(findingCandidates),
  "finding candidates must use bounded severity and recency indexes",
);
assert(
  /by_org_period_status_timestamp/.test(lowerSyntheses) &&
    /\.eq\("status", "completed"\)[\s\S]*\.gte\("timestamp", args\.timestamp\)[\s\S]*\.lt\("timestamp", args\.windowEnd\)/.test(lowerSyntheses),
  "lower synthesis candidates must push status and timestamp window into the index",
);

console.log("Synthesis bounded query proof passed: synthesis inputs and recovery sweeps use indexed bounded reads.");
NODE
