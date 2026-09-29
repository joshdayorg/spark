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
  console.error(`Linter contradiction candidate indexing proof failed: ${message}`);
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

const listContradictionCandidatePages = extractFunction(
  knowledge,
  "listContradictionCandidatePages",
);
const listContradictionCandidatePairs = extractExportedFunction(
  knowledge,
  "listContradictionCandidatePairs",
);

assert(
  schema.includes(
    '.index("by_org_type_status_updatedAt", ["orgId", "type", "status", "updatedAt"])',
  ),
  "schema must expose an org/type/status/updatedAt index for candidate discovery",
);
assert(
  /const LINTER_CONTRADICTION_CANDIDATE_TYPES = \[[\s\S]*"decision"[\s\S]*"pattern"[\s\S]*"project"[\s\S]*"goal"[\s\S]*"question"[\s\S]*"entity"[\s\S]*\] as const/.test(
    knowledge,
  ),
  "candidate types must be an iterable literal list",
);
assert(
  /LINTER_CONTRADICTION_CANDIDATE_TYPES\.map\(\(type\) =>[\s\S]*\.withIndex\("by_org_type_status_updatedAt", \(q\) =>[\s\S]*\.eq\("orgId", args\.orgId\)\.eq\("type", type\)\.eq\("status", "active"\)[\s\S]*\.order\("desc"\)[\s\S]*\.take\(args\.pageLimit\)/.test(
    listContradictionCandidatePages,
  ),
  "candidate loader must query each candidate type through storage before applying pageLimit",
);
assert(
  /pagesByType[\s\S]*\.flat\(\)[\s\S]*right\.updatedAt - left\.updatedAt[\s\S]*\.slice\(0, args\.pageLimit\)/.test(
    listContradictionCandidatePages,
  ),
  "candidate loader must merge per-type reads and cap the merged updatedAt-ordered result",
);
assert(
  /const boundedPages = await listContradictionCandidatePages\(ctx, \{[\s\S]*orgId: args\.orgId,[\s\S]*pageLimit,[\s\S]*\}\);/.test(
    listContradictionCandidatePairs,
  ),
  "pair discovery must consume the indexed candidate-page loader",
);
assert(
  !/\.query\("knowledgePages"\)[\s\S]*\.withIndex\("by_org_status"/.test(
    listContradictionCandidatePairs,
  ),
  "pair discovery must not read newest active pages before filtering candidate types",
);
assert(
  !/LINTER_CONTRADICTION_ACTIVE_SCAN_MULTIPLIER|const scanLimit|\.filter\(\s*\(?page\)?\s*=>[\s\S]*LINTER_CONTRADICTION_CANDIDATE_TYPES/.test(
    listContradictionCandidatePairs,
  ),
  "pair discovery must not depend on a post-read candidate-type filter window",
);

console.log("Linter contradiction candidate indexing proof passed: candidate type filtering happens in indexed storage reads before the result cap.");
NODE
