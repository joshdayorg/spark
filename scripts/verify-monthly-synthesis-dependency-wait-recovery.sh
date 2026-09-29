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
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const debug = fs.readFileSync(path.join(repoRoot, "convex", "debug.ts"), "utf8");

function fail(message) {
  console.error(`Monthly synthesis dependency wait proof failed: ${message}`);
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

const monthlySynthesis = extractExportedFunction(spark, "monthlySynthesis");
const fanOutSynthesesForPeriod = extractFunction(
  spark,
  "fanOutSynthesesForPeriod",
);
const runSynthesisAction = extractExportedFunction(spark, "runSynthesisAction");
const claimSynthesisRun = extractExportedFunction(knowledge, "claimSynthesisRun");
const findRecoverableFailedSynthesisRuns = extractExportedFunction(
  knowledge,
  "findRecoverableFailedSynthesisRuns",
);
const markSynthesisFailed = extractExportedFunction(
  knowledge,
  "markSynthesisFailed",
);
const isTerminalFailedSynthesis = extractFunction(
  knowledge,
  "isTerminalFailedSynthesis",
);
const p7ProbeSynthesisDependencyReadiness = extractExportedFunction(
  debug,
  "p7ProbeSynthesisDependencyReadiness",
);

assert(
  /crons\.cron\(\s*"monthly-synthesis",\s*"0 10 1 \* \*",[\s\S]*internal\.spark\.monthlySynthesis/.test(crons),
  "monthly-synthesis cron must use cron syntax and target internal.spark.monthlySynthesis",
);
assert(
  /handler:\s*async \(ctx\) => fanOutSynthesesForPeriod\(ctx, "monthly"\)/.test(monthlySynthesis),
  "monthlySynthesis must use the shared monthly fan-out path",
);
assert(
  /period === "daily"\s*\?\s*null\s*:\s*\(\(await ctx\.runQuery\(getSynthesisDependencyReadinessRef/.test(fanOutSynthesesForPeriod),
  "monthly fan-out must check lower-period dependency readiness",
);
assert(
  /const failureKind: SynthesisFailureKind = terminalDependency\s*\?\s*"fatal"\s*:\s*"dependency_wait";/.test(fanOutSynthesesForPeriod),
  "monthly fan-out must classify non-terminal weekly waits as dependency_wait",
);
assert(
  /nextRetryAt: terminalDependency\s*\?\s*undefined\s*:\s*\(dependencyReadiness\.nextRetryAt \?\? undefined\)/.test(fanOutSynthesesForPeriod),
  "monthly fan-out must preserve dependency retry timing",
);
assert(
  /const failureKind: SynthesisFailureKind = terminalDependency\s*\?\s*"fatal"\s*:\s*"dependency_wait";/.test(runSynthesisAction),
  "monthly action retry path must classify non-terminal weekly waits as dependency_wait",
);
assert(
  /const retryCount = dependencyWait\s*\?\s*\(synthesis\.retryCount \?\? 0\)\s*:\s*\(synthesis\.retryCount \?\? 0\) \+ 1;/.test(markSynthesisFailed),
  "dependency_wait failures must not consume synthesis retry budget",
);
assert(
  /failureKind !== "dependency_wait"[\s\S]*SYNTHESIS_FAILED_MAX_RETRIES/.test(isTerminalFailedSynthesis),
  "dependency_wait rows must not become terminal when the retry cap would otherwise be hit",
);
assert(
  /if \(isTerminalFailedSynthesis\(current\)\) \{[\s\S]*skipped_terminal_failed/.test(claimSynthesisRun),
  "claimSynthesisRun must rely on dependency_wait-aware terminal failure checks",
);
assert(
  /if \(isTerminalFailedSynthesis\(synthesis\)\) \{[\s\S]*return false;/.test(findRecoverableFailedSynthesisRuns) &&
    /getRecoverableFailedSynthesisDueAt\(synthesis\) <= args\.now/.test(findRecoverableFailedSynthesisRuns),
  "recoverable failed discovery must keep non-terminal dependency_wait rows retryable when due",
);
assert(
  /period: "monthly"[\s\S]*monthlyReadiness\.ready === false[\s\S]*monthlyReadiness\.inProgress\.length === 1/.test(p7ProbeSynthesisDependencyReadiness) &&
    /monthlyAfterDeferred\?\.status === "failed"/.test(p7ProbeSynthesisDependencyReadiness),
  "P7 probe must cover monthly deferral on an in-progress weekly dependency",
);
assert(
  !/terminalDependency \? "fatal" : "unexpected"/.test(spark),
  "non-terminal dependency waits must not regress to unexpected failures",
);

console.log("Monthly synthesis dependency wait proof passed: weekly dependency waits remain recoverable and cannot terminally fail monthly synthesis by retry cap.");
NODE
