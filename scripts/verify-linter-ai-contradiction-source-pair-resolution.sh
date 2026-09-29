#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");

function fail(message) {
  console.error(`Linter AI contradiction source-pair resolution proof failed: ${message}`);
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

const listContradictionCandidatePairs = extractExportedFunction(
  knowledge,
  "listContradictionCandidatePairs",
);
const currentSourcePairKey = extractFunction(
  knowledge,
  "getCurrentLinterFindingContradictionSourcePairKey",
);
const resolveObsoleteLinterFindings = extractExportedFunction(
  knowledge,
  "resolveObsoleteLinterFindings",
);
const buildContradictionEvidencePack = extractFunction(
  spark,
  "buildContradictionEvidencePack",
);
const runLinterForOrg = extractExportedFunction(spark, "runLinterForOrg");

assert(
  /type ContradictionCandidatePair = \{[\s\S]*pairKey: string;[\s\S]*sourcePairKey: string;/.test(
    knowledge,
  ) &&
    /type ContradictionCandidatePair = \{[\s\S]*pairKey: string;[\s\S]*sourcePairKey: string;/.test(
      spark,
    ),
  "candidate pair types must expose stable sourcePairKey",
);
assert(
  /function buildContradictionSourcePairKey\([\s\S]*leftPageId[\s\S]*rightPageId[\s\S]*\.sort\([\s\S]*\.join\("--"\)/.test(
    knowledge,
  ),
  "knowledge pipeline must build source-pair keys from stable page ids",
);
assert(
  /candidatePairs\.push\(\{[\s\S]*pairKey,[\s\S]*sourcePairKey: buildContradictionSourcePairKey\(left\._id, right\._id\),[\s\S]*left: toContradictionCandidatePage/.test(
    listContradictionCandidatePairs,
  ),
  "candidate discovery must attach sourcePairKey to each pair",
);
assert(
  /candidateSourcePairKeys: string\[\];/.test(spark) &&
    /candidateSourcePairKeys: dedupeSortedStrings\([\s\S]*selected\.map\(\(pair\) => pair\.sourcePairKey\)/.test(
      buildContradictionEvidencePack,
    ),
  "evidence pack must preserve the evaluated source-pair scope",
);
assert(
  /\.query\("references"\)[\s\S]*\.withIndex\("by_from", \(q\) =>[\s\S]*\.eq\("fromPageId", args\.findingPageId\)\.eq\("referenceType", "related_to"\)[\s\S]*relatedPageIds\.length !== 2[\s\S]*page\.status !== "active"[\s\S]*!LINTER_CONTRADICTION_CANDIDATE_TYPE_SET\.has\(page\.type\)[\s\S]*getContradictionOverlapReason/.test(
    currentSourcePairKey,
  ),
  "obsolete resolution must recompute current candidate support from durable related source pages",
);
assert(
  /managedSourcePairKeys: v\.optional\(v\.array\(v\.string\(\)\)\)/.test(
    resolveObsoleteLinterFindings,
  ) &&
    /currentSourcePairKey === null \|\|[\s\S]*managedSourcePairKeys\.has\(currentSourcePairKey\)/.test(
      resolveObsoleteLinterFindings,
    ),
  "obsolete resolution must resolve findings whose durable source pair is no longer current or is in the evaluated source-pair scope",
);
assert(
  /managedSourcePairKeys: evidencePack\.candidateSourcePairKeys/.test(
    runLinterForOrg,
  ) &&
    /const contradictionResolved = \(await ctx\.runMutation\([\s\S]*resolveObsoleteLinterFindingsRef/.test(
      runLinterForOrg,
    ),
  "runLinterForOrg must pass evaluated source-pair scope into AI contradiction cleanup",
);
assert(
  /\}\n\n      const contradictionResolved = \(await ctx\.runMutation\([\s\S]*resolveObsoleteLinterFindingsRef/.test(
    runLinterForOrg,
  ),
  "AI cleanup must not be trapped only inside the non-empty candidate branch",
);

console.log("Linter AI contradiction source-pair resolution proof passed: stale AI findings are scoped by durable related page pairs, not only current slugs.");
NODE
