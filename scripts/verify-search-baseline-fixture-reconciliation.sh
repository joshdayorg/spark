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
  console.error(`Search baseline fixture reconciliation proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractFunction(text, functionName) {
  const markers = [`async function ${functionName}`, `function ${functionName}`];
  const start = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];
  if (start === undefined) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + functionName.length);
  const nextAsyncFunction = text.indexOf("\nasync function ", start + functionName.length);
  const nextExport = text.indexOf("\nexport const ", start + functionName.length);
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

const chunkCleanup = extractFunction(debug, "deleteSearchBaselineChunkGraph");
const pageCleanup = extractFunction(debug, "deleteSearchBaselinePageGraph");
const sourceCleanup = extractFunction(debug, "deleteSearchBaselineSourceGraph");
const reconciliation = extractFunction(debug, "reconcileSearchBaselineFixtureRows");
const seeder = extractExportedFunction(debug, "seedSearchBaselineFixture");

assert(
  /query\("sourceAttributions"\)[\s\S]*withIndex\("by_chunk"[\s\S]*ctx\.db\.delete\(chunk\._id\)/.test(
    chunkCleanup,
  ),
  "chunk cleanup must delete chunk-level source attributions before deleting stale chunks",
);
assert(
  /query\("references"\)[\s\S]*withIndex\("by_from"[\s\S]*query\("references"\)[\s\S]*withIndex\("by_to"[\s\S]*query\("sourceAttributions"\)[\s\S]*withIndex\("by_page"[\s\S]*query\("pageVersions"\)[\s\S]*withIndex\("by_page"[\s\S]*ctx\.db\.delete\(page\._id\)/.test(
    pageCleanup,
  ),
  "page cleanup must remove references, source attributions, and page versions before deleting stale pages",
);
assert(
  /query\("sourceAttributions"\)[\s\S]*withIndex\("by_source"[\s\S]*query\("sourceChunks"\)[\s\S]*withIndex\("by_source"[\s\S]*deleteSearchBaselineChunkGraph\(ctx, chunk, deletedAttributionIds\)[\s\S]*ctx\.db\.delete\(source\._id\)/.test(
    sourceCleanup,
  ),
  "source cleanup must remove source attributions and chunks before deleting stale sources",
);
assert(
  /query\("knowledgePages"\)[\s\S]*withIndex\("by_kb"[\s\S]*expectedPageSlugs\.has\(page\.slug\)[\s\S]*seenPageSlugs\.has\(page\.slug\)[\s\S]*deleteSearchBaselinePageGraph/.test(
    reconciliation,
  ),
  "reconciliation must scan baseline pages by knowledge base and delete unexpected or duplicate slugs",
);
assert(
  /query\("sources"\)[\s\S]*withIndex\("by_kb"[\s\S]*expectedSourceHashes\.has\(source\.contentHash\)[\s\S]*seenSourceHashes\.has\(source\.contentHash\)[\s\S]*deleteSearchBaselineSourceGraph/.test(
    reconciliation,
  ),
  "reconciliation must scan baseline sources by knowledge base and delete unexpected or duplicate hashes",
);
assert(
  seeder.indexOf("await reconcileSearchBaselineFixtureRows(ctx, {") !== -1 &&
    seeder.indexOf("await reconcileSearchBaselineFixtureRows(ctx, {") <
      seeder.indexOf("for (const spec of fixturePages)"),
  "seedSearchBaselineFixture must reconcile stale fixture rows before upserting current fixture rows",
);
assert(
  /const sourceChunks = await ctx\.db[\s\S]*query\("sourceChunks"\)[\s\S]*deleteSearchBaselineChunkGraph\([\s\S]*const attributions = await ctx\.db[\s\S]*query\("sourceAttributions"\)/.test(
    seeder,
  ),
  "seeder must prune stale or duplicate chunks before reconciling source attributions",
);
assert(
  /let matchingAttribution: Doc<"sourceAttributions"> \| null = null;[\s\S]*await ctx\.db\.delete\(attribution\._id\);/.test(
    seeder,
  ),
  "seeder must delete stale or duplicate source attributions instead of throwing before validation",
);
assert(
  !/duplicate source attributions/.test(seeder),
  "seeder must not abort on duplicate baseline source attributions",
);
assert(
  /const expectedReferenceKeys = new Set\([\s\S]*const keptReferenceKeys = new Set<string>\(\);[\s\S]*await ctx\.db\.delete\(reference\._id\);[\s\S]*for \(const reference of spec\.references \?\? \[\]\)/.test(
    seeder,
  ),
  "seeder must delete stale or duplicate references before upserting expected references",
);
assert(
  seeder.indexOf("const unexpectedPages = pages.filter") >
    seeder.indexOf("await reconcileSearchBaselineFixtureRows(ctx, {") &&
    seeder.indexOf("const unexpectedSources = sources.filter") >
      seeder.indexOf("await reconcileSearchBaselineFixtureRows(ctx, {") &&
    seeder.indexOf("const unexpectedReferences = references.filter") >
      seeder.indexOf("await reconcileSearchBaselineFixtureRows(ctx, {"),
  "final corpus validation must remain after deterministic reconciliation",
);

console.log(
  "Search baseline fixture reconciliation proof passed: stale baseline rows are reconciled before validation.",
);
NODE
