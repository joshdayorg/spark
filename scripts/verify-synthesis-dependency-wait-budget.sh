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
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`Synthesis dependency wait budget proof failed: ${message}`);
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

const markSynthesisFailed = extractExportedFunction(
  knowledge,
  "markSynthesisFailed",
);
const isTerminalFailedSynthesis = extractFunction(
  knowledge,
  "isTerminalFailedSynthesis",
);
const fanOutSynthesesForPeriod = extractFunction(
  spark,
  "fanOutSynthesesForPeriod",
);
const runSynthesisAction = extractExportedFunction(spark, "runSynthesisAction");

assert(
  /v\.literal\("dependency_wait"\)/.test(schema),
  "schema must allow dependency_wait synthesis failures",
);
assert(
  /type SynthesisFailureKind =[\s\S]*"dependency_wait";/.test(knowledge) &&
    /type SynthesisFailureKind =[\s\S]*"dependency_wait";/.test(spark),
  "both synthesis failure kind unions must include dependency_wait",
);
assert(
  /const SYNTHESIS_FAILURE_KIND_VALIDATOR = v\.union\([\s\S]*v\.literal\("dependency_wait"\)/.test(knowledge),
  "knowledge validator must accept dependency_wait",
);
assert(
  /nextRetryAt:\s*v\.optional\(v\.number\(\)\)/.test(markSynthesisFailed) &&
    /nextRetryAt\?: number;/.test(spark),
  "markSynthesisFailed must accept an explicit dependency retry timestamp",
);

assert(
  /synthesis\.failureKind !== "dependency_wait"[\s\S]*SYNTHESIS_FAILED_MAX_RETRIES/.test(isTerminalFailedSynthesis),
  "dependency_wait rows must not become terminal from retryCount alone",
);
assert(
  /const dependencyWait = failureKind === "dependency_wait";/.test(markSynthesisFailed),
  "markSynthesisFailed must identify dependency waits separately",
);
assert(
  /const retryCount = dependencyWait\s*\?\s*\(synthesis\.retryCount \?\? 0\)\s*:\s*\(synthesis\.retryCount \?\? 0\) \+ 1;/.test(markSynthesisFailed),
  "dependency_wait must preserve retryCount instead of incrementing it",
);
assert(
  /const terminalFailure =[\s\S]*failureKind === "fatal"[\s\S]*!dependencyWait[\s\S]*retryCount >= SYNTHESIS_FAILED_MAX_RETRIES/.test(markSynthesisFailed),
  "terminalFailure must only use retryCount for non-dependency failures",
);
assert(
  /dependencyWait[\s\S]*args\.nextRetryAt \?\? now \+ SYNTHESIS_FAILED_RETRY_BACKOFF_MS\[0\]/.test(markSynthesisFailed),
  "dependency_wait must schedule a retry without using execution retry budget",
);
assert(
  /retryCount: retryCount > 0 \? retryCount : undefined/.test(markSynthesisFailed),
  "dependency_wait should not persist a synthetic zero retry count",
);

assert(
  /const failureKind: SynthesisFailureKind = terminalDependency\s*\?\s*"fatal"\s*:\s*"dependency_wait";/.test(fanOutSynthesesForPeriod),
  "fan-out dependency deferrals must use dependency_wait",
);
assert(
  /nextRetryAt: terminalDependency\s*\?\s*undefined\s*:\s*\(dependencyReadiness\.nextRetryAt \?\? undefined\)/.test(fanOutSynthesesForPeriod),
  "fan-out dependency deferrals must pass dependency retry timing",
);
assert(
  /const failureKind: SynthesisFailureKind = terminalDependency\s*\?\s*"fatal"\s*:\s*"dependency_wait";/.test(runSynthesisAction),
  "runSynthesisAction dependency deferrals must use dependency_wait",
);
assert(
  /nextRetryAt: terminalDependency\s*\?\s*undefined\s*:\s*\(dependencyReadiness\.nextRetryAt \?\? undefined\)/.test(runSynthesisAction),
  "runSynthesisAction dependency deferrals must pass dependency retry timing",
);
assert(
  !/terminalDependency \? "fatal" : "unexpected"/.test(spark),
  "dependency readiness branches must not classify non-terminal waits as unexpected failures",
);

console.log("Synthesis dependency wait budget proof passed: non-terminal dependency waits stay recoverable without spending failure retries.");
NODE
