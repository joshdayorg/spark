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
  console.error(`P7 AI fixture page-version cleanup proof failed: ${message}`);
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

function extractBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    fail(`could not find start marker ${startMarker}`);
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    fail(`could not find end marker ${endMarker}`);
  }
  return text.slice(start, end);
}

const aiFixture = extractExportedFunction(debug, "p7SeedAiContradictionFixture");
const cleanupLoop = extractBetween(
  aiFixture,
  "for (const page of existingPages) {",
  "const sourceStatuses",
);
const pageDeleteLoop = extractBetween(
  aiFixture,
  "for (const page of existingPages) {\n      await ctx.db.delete(page._id);",
  "const pageIdBySlug",
);

assert(
  /\.query\("pageVersions"\)[\s\S]*\.withIndex\("by_page", \(q\) => q\.eq\("pageId", page\._id\)\)[\s\S]*\.collect\(\)/.test(
    cleanupLoop,
  ),
  "AI fixture cleanup must collect pageVersions by page before deleting old pages",
);
assert(
  /for \(const version of versions\) \{[\s\S]*await ctx\.db\.delete\(version\._id\);[\s\S]*\}/.test(
    cleanupLoop,
  ),
  "AI fixture cleanup must delete each pageVersion for the old page",
);
assert(
  aiFixture.indexOf('.query("pageVersions")') < aiFixture.indexOf(pageDeleteLoop),
  "pageVersions must be deleted before existing knowledge pages are deleted",
);

console.log(
  "P7 AI fixture page-version cleanup proof passed: reseeding deletes pageVersions before deleting old pages.",
);
NODE
