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
  console.error(`Linter bounded candidate scan proof failed: ${message}`);
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
  const nextAsyncFunction = text.indexOf(
    "\nasync function ",
    start + marker.length,
  );
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const boundaries = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = boundaries.length === 0 ? text.length : Math.min(...boundaries);
  return text.slice(start, end);
}

const listBasePages = extractFunction(knowledge, "listLinterCandidateBasePages");
const boundedSignals = extractFunction(knowledge, "getBoundedLinterPageSignals");
const listLinterCandidates = extractExportedFunction(knowledge, "listLinterCandidates");
const resolveObsoleteLinterFindings = extractExportedFunction(
  knowledge,
  "resolveObsoleteLinterFindings",
);
const runLinterForOrg = extractExportedFunction(spark, "runLinterForOrg");

for (const [indexName, fields] of [
  ["by_org_type_status_createdAt", '["orgId", "type", "status", "createdAt"]'],
  ["by_org_type_status_lastConfirmed", '["orgId", "type", "status", "lastConfirmed"]'],
  ["by_org_type_status_updatedAt", '["orgId", "type", "status", "updatedAt"]'],
]) {
  assert(
    schema.includes(`.index("${indexName}", ${fields})`),
    `schema must define ${indexName}`,
  );
}

assert(
  /const LINTER_CANDIDATE_DEFAULT_LIMIT = 200;/.test(knowledge) &&
    /const LINTER_RELATION_SCAN_LIMIT = 50;/.test(knowledge) &&
    /const LINTER_OBSOLETE_FINDING_SCAN_LIMIT = 200;/.test(knowledge),
  "bounded linter constants must be present",
);
assert(
  /const LINTER_MAINTENANCE_CANDIDATE_TYPES = \[[\s\S]*"fact"[\s\S]*"decision"[\s\S]*"entity"[\s\S]*"pattern"[\s\S]*"project"[\s\S]*"question"[\s\S]*"goal"[\s\S]*\] as const/.test(
    knowledge,
  ),
  "maintenance candidate types must be explicit and exclude session/finding",
);
assert(
  /state\.phase === "staleDecision"[\s\S]*\.withIndex\("by_org_type_status_lastConfirmed", \(q\) =>[\s\S]*\.eq\("type", "decision"\)[\s\S]*\.eq\("status", "active"\)[\s\S]*\.lt\("lastConfirmed", args\.staleBefore\)[\s\S]*\.paginate\(\{[\s\S]*cursor: state\.cursor,[\s\S]*numItems: args\.limit/.test(
    listBasePages,
  ),
  "stale-decision candidates must use paginated type/status/lastConfirmed reads",
);
assert(
  /const candidateType =[\s\S]*LINTER_MAINTENANCE_CANDIDATE_TYPES\[maintenanceState\.typeIndex\][\s\S]*\.withIndex\("by_org_type_status_createdAt", \(q\) =>[\s\S]*\.eq\("type", candidateType\)[\s\S]*\.eq\("status", "active"\)[\s\S]*\.lt\("createdAt", args\.candidateCreatedBefore\)[\s\S]*\.paginate\(\{[\s\S]*cursor: maintenanceState\.cursor,[\s\S]*numItems: args\.limit/.test(
    listBasePages,
  ),
  "orphan/weak-provenance candidates must use paginated per-type createdAt reads",
);
assert(
  /decodeLinterCandidateCursor\(args\.cursor\)/.test(listBasePages) &&
    !/while\s*\(/.test(listBasePages) &&
    /getNextLinterCandidateCursor\(state, page\)/.test(listBasePages) &&
    /nextCursor:[\s\S]*encodeLinterCandidateCursor\(nextState\)/.test(
      listBasePages,
    ) &&
    /isDone: nextState === null/.test(listBasePages) &&
    /scannedCount: page\.page\.length/.test(listBasePages),
  "candidate helper must execute one paginated query and return cursor accounting for continuation",
);
assert(
  !/\.collect\(\)/.test(listLinterCandidates) &&
    /listLinterCandidateBasePages\(ctx/.test(listLinterCandidates) &&
    /getBoundedLinterPageSignals\(ctx, page\)/.test(listLinterCandidates) &&
    /cursor: args\.cursor/.test(listLinterCandidates) &&
    /nextCursor: boundedPageResult\.nextCursor/.test(listLinterCandidates),
  "listLinterCandidates must avoid unbounded collect and expose continuation",
);
assert(
  !/\.collect\(\)/.test(boundedSignals) &&
    /\.withIndex\("by_to", \(q\) => q\.eq\("toPageId", page\._id\)\)[\s\S]*\.take\(LINTER_RELATION_SCAN_LIMIT\)/.test(
      boundedSignals,
    ) &&
    /\.withIndex\("by_page", \(q\) => q\.eq\("pageId", page\._id\)\)[\s\S]*\.take\(1\)/.test(
      boundedSignals,
    ),
  "per-page linter relationship probes must use bounded reads",
);
assert(
  !/\.collect\(\)/.test(resolveObsoleteLinterFindings) &&
    /limit: v\.optional\(v\.number\(\)\)/.test(resolveObsoleteLinterFindings) &&
    /\.withIndex\("by_org_type_status_updatedAt", \(q\) =>[\s\S]*\.eq\("type", "finding"\)[\s\S]*\.eq\("status", "active"\)[\s\S]*\.take\(limit\)/.test(
      resolveObsoleteLinterFindings,
    ),
  "obsolete linter finding cleanup must use bounded active-finding reads",
);
assert(
  /limit: LINTER_CANDIDATE_BATCH_SIZE/.test(runLinterForOrg) &&
    /limit: LINTER_OBSOLETE_FINDING_BATCH_SIZE/.test(runLinterForOrg),
  "runLinterForOrg must pass explicit bounded batch sizes",
);

console.log("Linter bounded candidate scan proof passed: candidate and obsolete-finding reads are indexed and capped.");
NODE
