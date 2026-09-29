#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const debug = fs.readFileSync(path.join(repoRoot, "convex", "debug.ts"), "utf8");

function fail(message) {
  console.error(`Search baseline query failure proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractFunction(text, functionName) {
  const marker = `function ${functionName}`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + marker.length);
  const nextAsyncFunction = text.indexOf("\nasync function ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const candidates = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
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

const failureCollector = extractFunction(debug, "collectBaselineSearchFailures");
const runSearchBaseline = extractExportedFunction(debug, "runSearchBaseline");

assert(
  /type BaselineSearchFailure = \{[\s\S]*surface: "liveSearch" \| "deepSearch";[\s\S]*error: string;[\s\S]*\};/.test(
    debug,
  ),
  "baseline failure diagnostics must preserve id/category/query/surface/error",
);
assert(
  /if \(result\.liveSearch\.error\) \{[\s\S]*surface: "liveSearch"[\s\S]*error: result\.liveSearch\.error/.test(
    failureCollector,
  ),
  "failure collector must preserve liveSearch per-query errors",
);
assert(
  /if \(result\.deepSearch\.error\) \{[\s\S]*surface: "deepSearch"[\s\S]*error: result\.deepSearch\.error/.test(
    failureCollector,
  ),
  "failure collector must preserve deepSearch per-query errors",
);
assert(
  /const failedQueries = collectBaselineSearchFailures\(baselineResults\);/.test(
    runSearchBaseline,
  ),
  "runSearchBaseline must aggregate per-query failures after the query loop",
);
assert(
  /console\.warn\("spark:search-baseline-query-failures", \{[\s\S]*fixture: args\.fixture,[\s\S]*failedQueries,[\s\S]*\}\);/.test(
    runSearchBaseline,
  ),
  "runSearchBaseline must log failed query details before throwing",
);
assert(
  /throw new Error\([\s\S]*Search baseline failed query execution/.test(
    runSearchBaseline,
  ),
  "runSearchBaseline must fail the top-level action when any query execution fails",
);
assert(
  runSearchBaseline.indexOf("const failedQueries = collectBaselineSearchFailures") >
    runSearchBaseline.indexOf("for (const query of args.queries)") &&
    runSearchBaseline.indexOf("throw new Error(") <
      runSearchBaseline.indexOf("return {"),
  "query failure aggregation must happen after all queries are attempted and before successful return",
);

console.log(
  "Search baseline query failure proof passed: per-query search errors now fail runSearchBaseline at the top level.",
);
NODE
