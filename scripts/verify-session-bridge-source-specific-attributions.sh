#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");

function fail(message) {
  console.error(`Session bridge source-specific attribution proof failed: ${message}`);
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

const getSessionBridgeState = extractExportedFunction(
  knowledge,
  "getSessionBridgeState",
);
const sweepStuckSessionBridges = extractExportedFunction(
  knowledge,
  "sweepStuckSessionBridges",
);

const failedBranchStart = sweepStuckSessionBridges.indexOf(
  'if (latestJob?.status === "failed")',
);
const stuckWarningStart = sweepStuckSessionBridges.indexOf(
  'console.warn("knowledge:sessionBridgeStuck"',
  failedBranchStart,
);
assert(failedBranchStart !== -1, "sweep must keep an explicit failed latest-job branch");
assert(stuckWarningStart !== -1, "sweep failed branch boundary not found");
const failedBranch = sweepStuckSessionBridges.slice(
  failedBranchStart,
  stuckWarningStart,
);

assert(
  /latestJobExtractedPageIds: Array<Id<"knowledgePages">>;/.test(knowledge),
  "getSessionBridgeState function reference must expose latest-job source page IDs",
);
assert(
  /const extractedPageIdsBySourceId = new Map<[\s\S]*Id<"sources">,[\s\S]*Set<Id<"knowledgePages">>[\s\S]*>\(\);/.test(getSessionBridgeState),
  "bridge state must group extracted page IDs by source ID",
);
assert(
  /extractedPageIdsBySourceId\.get\(attribution\.sourceId\)/.test(getSessionBridgeState) &&
    /extractedPageIdsBySourceId\.set\(attribution\.sourceId, pageIds\)/.test(getSessionBridgeState),
  "bridge state must populate the source-keyed attribution map from each attribution source",
);
assert(
  /const latestJob = jobs\[0\] \?\? null;/.test(getSessionBridgeState),
  "bridge state must identify the latest job once for source-specific checks",
);
assert(
  /latestJobExtractedPageIds: latestJob\s*\?\s*Array\.from\(extractedPageIdsBySourceId\.get\(latestJob\.sourceId\) \?\? \[\]\)\s*:\s*\[\]/.test(getSessionBridgeState),
  "bridge state must return page IDs only for the latest job's own source",
);

assert(
  /latestJobExtractedPageIds,/.test(sweepStuckSessionBridges),
  "sweep must read latest-job source page IDs from bridge state",
);
assert(
  /if \(latestJobExtractedPageIds\.length > 0\)/.test(failedBranch),
  "failed latest-job recovery must be gated by latest-job source attributions",
);
assert(
  !/if \(extractedPageIds\.length > 0\)/.test(failedBranch),
  "failed latest-job recovery must not be gated by aggregate session attributions",
);
assert(
  /recoverFailedSessionBridgeJobWithAttributionsRef,[\s\S]*jobId: latestJob\._id/.test(failedBranch),
  "source-specific durable attribution recovery must still target the latest failed job",
);
assert(
  /retryFailedSessionBridgeSourceRef,[\s\S]*sourceId: latestJob\.sourceId/.test(failedBranch),
  "failed latest-job retry must target the latest failed job's source",
);
assert(
  /knowledge:failedSessionBridgeAttributionRecoverySkipped[\s\S]*sourceId: latestJob\.sourceId/.test(failedBranch) &&
    /knowledge:sessionBridgeFailedRetrySkipped[\s\S]*sourceId: latestJob\.sourceId/.test(failedBranch),
  "failed bridge logs must report the latest failed job's source",
);

console.log("Session bridge source-specific attribution proof passed: latest failed jobs no longer recover from older source attributions.");
NODE
