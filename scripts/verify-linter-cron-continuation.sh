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
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`Linter cron continuation proof failed: ${message}`);
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
const decodeCursor = extractFunction(knowledge, "decodeLinterCandidateCursor");
const nextCursor = extractFunction(knowledge, "getNextLinterCandidateCursor");
const listLinterCandidates = extractExportedFunction(knowledge, "listLinterCandidates");
const runLinterForOrg = extractExportedFunction(spark, "runLinterForOrg");

assert(
  /type LinterCandidateCursorState =[\s\S]*phase: "staleDecision"[\s\S]*phase: "maintenance"[\s\S]*typeIndex: number/.test(
    knowledge,
  ),
  "knowledge query must model stale-decision and maintenance continuation phases",
);
assert(
  /JSON\.parse\(cursor\)/.test(decodeCursor) &&
    /value\.phase === "staleDecision"/.test(decodeCursor) &&
    /value\.phase === "maintenance"/.test(decodeCursor) &&
    /typeIndex >= LINTER_MAINTENANCE_CANDIDATE_TYPES\.length/.test(decodeCursor),
  "candidate cursor decoder must validate phase and maintenance type index",
);
assert(
  /!page\.isDone[\s\S]*cursor: page\.continueCursor/.test(nextCursor) &&
    /state\.phase === "staleDecision"[\s\S]*phase: "maintenance", typeIndex: 0/.test(
      nextCursor,
    ) &&
    /nextTypeIndex < LINTER_MAINTENANCE_CANDIDATE_TYPES\.length/.test(
      nextCursor,
    ),
  "candidate cursor advancement must continue within a page and then advance candidate classes",
);
assert(
  /const state = decodeLinterCandidateCursor\(args\.cursor\)/.test(
    listBasePages,
  ) &&
    !/while\s*\(/.test(listBasePages) &&
    /\.paginate\(\{[\s\S]*cursor: state\.cursor,[\s\S]*numItems: args\.limit/.test(
      listBasePages,
    ) &&
    !/\.collect\(\)/.test(listBasePages) &&
    /const nextState = getNextLinterCandidateCursor\(state, page\)/.test(
      listBasePages,
    ) &&
    /nextCursor:[\s\S]*encodeLinterCandidateCursor\(nextState\)/.test(
      listBasePages,
    ) &&
    /scannedCount: page\.page\.length/.test(listBasePages),
  "candidate base loader must execute one paginated query and return cursor accounting",
);
assert(
  /cursor: v\.optional\(v\.string\(\)\)/.test(listLinterCandidates) &&
    /nextCursor: boundedPageResult\.nextCursor/.test(listLinterCandidates) &&
    /isDone: boundedPageResult\.isDone/.test(listLinterCandidates) &&
    /scannedCount: boundedPageResult\.scannedCount/.test(listLinterCandidates),
  "listLinterCandidates must expose continuation metadata to the cron action",
);
assert(
  /candidateCursor: v\.optional\(v\.string\(\)\)/.test(runLinterForOrg) &&
    /activeSlugs: v\.optional\(v\.array\(v\.string\(\)\)\)/.test(
      runLinterForOrg,
    ) &&
    /cursor: args\.candidateCursor/.test(runLinterForOrg),
  "runLinterForOrg must accept and pass the candidate cursor",
);
assert(
  /const accumulatedActiveSlugs = dedupeSortedStrings\(\[[\s\S]*\.\.\.\(args\.activeSlugs \?\? \[\]\),[\s\S]*\.\.\.activeSlugs/.test(
    runLinterForOrg,
  ),
  "continuations must carry active deterministic slugs forward",
);
assert(
  /if \(candidateResult\.nextCursor !== null\) \{[\s\S]*ctx\.scheduler\.runAfter\(0, runLinterForOrgRef, \{[\s\S]*candidateCursor: candidateResult\.nextCursor,[\s\S]*activeSlugs: accumulatedActiveSlugs/.test(
    runLinterForOrg,
  ),
  "non-final candidate batches must schedule a linter continuation",
);
assert(
  /if \(candidateResult\.isDone\) \{[\s\S]*resolveObsoleteLinterFindingsRef/.test(
    runLinterForOrg,
  ) &&
    /let contradictionStatus: AiContradictionStatus = candidateResult\.isDone[\s\S]*"skipped_continuation"/.test(
      runLinterForOrg,
    ) &&
    /if \(candidateResult\.isDone\) \{[\s\S]*listContradictionCandidatePairsRef/.test(
      runLinterForOrg,
    ),
  "obsolete cleanup and AI contradiction work must wait for the final candidate batch",
);

console.log("Linter cron continuation proof passed: cron-triggered linter work is paginated and self-schedules bounded continuations.");
NODE
