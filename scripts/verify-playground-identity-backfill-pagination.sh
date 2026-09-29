#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const playground = fs.readFileSync(path.join(repoRoot, "convex", "playground.ts"), "utf8");

function fail(message) {
  console.error(`Playground identity backfill pagination proof failed: ${message}`);
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

const listPagesNeedingIdentity = extractExportedFunction(
  playground,
  "listPagesNeedingIdentity",
);
const backfillIdentitiesBatch = extractExportedFunction(
  playground,
  "backfillIdentitiesBatch",
);
const backfillKnowledgePageIdentities = extractExportedFunction(
  playground,
  "backfillKnowledgePageIdentities",
);

assert(
  /cursor: v\.union\(v\.string\(\), v\.null\(\)\)/.test(listPagesNeedingIdentity) &&
    /numItems: v\.number\(\)/.test(listPagesNeedingIdentity),
  "listPagesNeedingIdentity must accept an explicit pagination cursor and page size",
);
assert(
  /\.withIndex\("by_org_status", \(q\) =>[\s\S]*\.eq\("orgId", args\.orgId\)\.eq\("status", "active"\)[\s\S]*\.paginate\(\{ cursor: args\.cursor, numItems: args\.numItems \}\)/.test(
    listPagesNeedingIdentity,
  ),
  "listPagesNeedingIdentity must page through the indexed active-page query",
);
assert(
  !/\.collect\(\)/.test(listPagesNeedingIdentity) &&
    !/result\.length >= args\.limit/.test(listPagesNeedingIdentity),
  "listPagesNeedingIdentity must not collect all rows or stop at the first filtered window",
);
assert(
  /return \{[\s\S]*pages,[\s\S]*scanned: result\.page\.length,[\s\S]*continueCursor: result\.continueCursor,[\s\S]*isDone: result\.isDone,[\s\S]*\};/.test(
    listPagesNeedingIdentity,
  ),
  "listPagesNeedingIdentity must return cursor progress even when no candidates resolve",
);
assert(
  /let skipped = 0;[\s\S]*if \(identity\) \{[\s\S]*patched \+= 1;[\s\S]*\} else \{[\s\S]*skipped \+= 1;[\s\S]*\}[\s\S]*return \{ scanned, patched, skipped \};/.test(
    backfillIdentitiesBatch,
  ),
  "backfillIdentitiesBatch must report unresolvable identity candidates as skipped",
);
assert(
  /cursor: v\.optional\(v\.union\(v\.string\(\), v\.null\(\)\)\)/.test(
    backfillKnowledgePageIdentities,
  ) &&
    /maxPages: v\.optional\(v\.number\(\)\)/.test(backfillKnowledgePageIdentities),
  "backfillKnowledgePageIdentities must expose bounded cursor continuation",
);
assert(
  /const numItems = normalizeBoundedInteger\(args\.numItems, 100, 1, 500\);[\s\S]*const maxPages = normalizeBoundedInteger\(args\.maxPages, 100, 1, 100\);/.test(
    backfillKnowledgePageIdentities,
  ),
  "identity backfill must bound page size and action page count",
);
assert(
  /internal\.playground\.listPagesNeedingIdentity,[\s\S]*\{ orgId: args\.orgId, cursor, numItems \}/.test(
    backfillKnowledgePageIdentities,
  ),
  "identity backfill action must pass the evolving cursor into the paginated query",
);
assert(
  /if \(page\.pages\.length > 0\) \{[\s\S]*backfillIdentitiesBatch[\s\S]*skipped \+= result\.skipped;[\s\S]*\}[\s\S]*isDone = page\.isDone;[\s\S]*cursor = page\.isDone \? null : page\.continueCursor;/.test(
    backfillKnowledgePageIdentities,
  ),
  "identity backfill must advance the cursor regardless of whether a page patched anything",
);
assert(
  /return \{[\s\S]*scanned,[\s\S]*patched,[\s\S]*skipped,[\s\S]*pagesScanned,[\s\S]*nextCursor: cursor,[\s\S]*isDone,[\s\S]*\};/.test(
    backfillKnowledgePageIdentities,
  ),
  "identity backfill must report skipped counts and continuation state",
);

console.log(
  "Playground identity backfill pagination proof passed: unresolved leading pages no longer starve later pages.",
);
NODE
