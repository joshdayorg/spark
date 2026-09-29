#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const crons = fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8");
const schema = fs.readFileSync(path.join(repoRoot, "convex", "schema.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");
const debug = fs.readFileSync(path.join(repoRoot, "convex", "debug.ts"), "utf8");

function fail(message) {
  console.error(`Synthesis stale sweep bounded query proof failed: ${message}`);
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
  const boundaries = [nextFunction, nextExport].filter((index) => index !== -1);
  const end = boundaries.length === 0 ? text.length : Math.min(...boundaries);
  return text.slice(start, end);
}

const synthesisStaleSweep = extractExportedFunction(spark, "synthesisStaleSweep");
const findStaleSynthesisRuns = extractExportedFunction(
  knowledge,
  "findStaleSynthesisRuns",
);
const findRecoverableFailedSynthesisRuns = extractExportedFunction(
  knowledge,
  "findRecoverableFailedSynthesisRuns",
);
const isTerminalFailedSynthesis = extractFunction(
  knowledge,
  "isTerminalFailedSynthesis",
);
const getRecoverableFailedSynthesisDueAt = extractFunction(
  knowledge,
  "getRecoverableFailedSynthesisDueAt",
);
const p7ProbeSynthesisStaleSweep = extractExportedFunction(
  debug,
  "p7ProbeSynthesisStaleSweep",
);
const p7ProbeFailedSynthesisRecovery = extractExportedFunction(
  debug,
  "p7ProbeFailedSynthesisRecovery",
);

for (const [indexName, fields] of [
  ["by_status_claimedAt", '["status", "claimedAt", "timestamp"]'],
  ["by_status_nextRetryAt", '["status", "nextRetryAt", "timestamp"]'],
  ["by_status_updatedAt", '["status", "updatedAt", "timestamp"]'],
]) {
  assert(
    schema.includes(`.index("${indexName}", ${fields})`),
    `schema must define ${indexName}`,
  );
}

assert(
  /crons\.interval\(\s*"synthesis-stale-sweep",\s*\{\s*minutes:\s*30\s*\},[\s\S]*internal\.spark\.synthesisStaleSweep/.test(crons),
  "synthesis-stale-sweep must remain scheduled every 30 minutes",
);
assert(
  /const SYNTHESIS_SWEEP_LIMIT = 100;/.test(spark),
  "synthesisStaleSweep must keep an explicit sweep limit",
);
assert(
  /findStaleSynthesisRunsRef[\s\S]*staleBefore,[\s\S]*limit: SYNTHESIS_SWEEP_LIMIT/.test(synthesisStaleSweep) &&
    /findRecoverableFailedSynthesisRunsRef[\s\S]*now,[\s\S]*limit: SYNTHESIS_SWEEP_LIMIT/.test(synthesisStaleSweep),
  "synthesisStaleSweep must pass the sweep limit into both finder queries",
);

for (const [name, text] of [
  ["findStaleSynthesisRuns", findStaleSynthesisRuns],
  ["findRecoverableFailedSynthesisRuns", findRecoverableFailedSynthesisRuns],
]) {
  assert(!/\.collect\(\)/.test(text), `${name} must not collect unbounded status partitions`);
  assert(!/\.withIndex\("by_status",/.test(text), `${name} must not use status-only scans`);
}

assert(
  /const limit = Math\.max\(1, Math\.min\(Math\.trunc\(args\.limit \?\? 100\), 200\)\);/.test(findStaleSynthesisRuns) &&
    /\.withIndex\("by_status_claimedAt", \(q\) =>[\s\S]*\.eq\("status", "in_progress"\)\.lt\("claimedAt", args\.staleBefore\)[\s\S]*\.take\(limit\)/.test(findStaleSynthesisRuns),
  "stale finder must push in_progress/stale cutoff into by_status_claimedAt and take(limit)",
);
assert(
  /const limit = Math\.max\(1, Math\.min\(Math\.trunc\(args\.limit \?\? 100\), 200\)\);/.test(findRecoverableFailedSynthesisRuns) &&
    /\.withIndex\("by_status_nextRetryAt", \(q\) =>[\s\S]*\.eq\("status", "failed"\)\.lte\("nextRetryAt", args\.now\)[\s\S]*\.take\(limit\)/.test(findRecoverableFailedSynthesisRuns) &&
    /\.withIndex\("by_status_updatedAt", \(q\) =>[\s\S]*\.eq\("status", "failed"\)\.lt\("updatedAt", legacyRetryCutoff\)[\s\S]*\.take\(limit\)/.test(findRecoverableFailedSynthesisRuns),
  "failed finder must use bounded due-retry and legacy-retry index reads",
);
assert(
  /const failed = uniqueDocsById\(\[\.\.\.scheduledRetryFailed, \.\.\.legacyFailed\]\);/.test(findRecoverableFailedSynthesisRuns),
  "failed finder must dedupe overlap between scheduled and legacy retry reads",
);
assert(
  /if \(isTerminalFailedSynthesis\(synthesis\)\) \{[\s\S]*return false;/.test(findRecoverableFailedSynthesisRuns) &&
    /return getRecoverableFailedSynthesisDueAt\(synthesis\) <= args\.now;/.test(findRecoverableFailedSynthesisRuns),
  "failed finder must exclude terminal failures while keeping due recoverable rows",
);
assert(
  /synthesis\.terminalFailure === true[\s\S]*synthesis\.failureKind === "fatal"[\s\S]*synthesis\.failureKind !== "dependency_wait"[\s\S]*SYNTHESIS_FAILED_MAX_RETRIES/.test(isTerminalFailedSynthesis),
  "terminal failure detection must skip dependency_wait rows and reject fatal/cap-exhausted rows",
);
assert(
  /synthesis\.nextRetryAt \?\?[\s\S]*synthesis\.updatedAt \+ SYNTHESIS_LEGACY_FAILED_RETRY_DELAY_MS/.test(getRecoverableFailedSynthesisDueAt),
  "recoverable failed due time must support legacy rows missing nextRetryAt",
);
assert(
  /claim\.status !== "reclaimed_stale"[\s\S]*staleSkipped \+= 1/.test(synthesisStaleSweep) &&
    /claim\.status !== "reclaimed_failed"[\s\S]*failedSkipped \+= 1/.test(synthesisStaleSweep) &&
    /ctx\.scheduler\.runAfter\(0, runSynthesisActionRef/.test(synthesisStaleSweep),
  "stale sweep must reclaim only matching rows and schedule recovered syntheses",
);
assert(
  /sweep\.staleFound >= 1/.test(p7ProbeSynthesisStaleSweep) &&
    /sweep\.staleReclaimed >= 1/.test(p7ProbeSynthesisStaleSweep) &&
    /sweep\.staleScheduled >= 1/.test(p7ProbeSynthesisStaleSweep),
  "P7 stale sweep probe must cover stale in_progress recovery",
);
assert(
  /recoverySweep\.failedFound === 1/.test(p7ProbeFailedSynthesisRecovery) &&
    /terminalSweep\.failedFound === 0/.test(p7ProbeFailedSynthesisRecovery),
  "P7 failure recovery probe must cover retryable recovery and terminal skip behavior",
);

console.log("Synthesis stale sweep bounded query proof passed: stale and failed recovery reads use indexed limits instead of unbounded status scans.");
NODE
