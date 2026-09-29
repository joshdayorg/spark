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
  console.error(`Playground identity backfill org guard proof failed: ${message}`);
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

const backfillIdentitiesBatch = extractExportedFunction(
  playground,
  "backfillIdentitiesBatch",
);

const getIndex = backfillIdentitiesBatch.indexOf("const page = await ctx.db.get(pageId);");
const orgGuardIndex = backfillIdentitiesBatch.indexOf("if (page.orgId !== args.orgId)");
const typeGuardIndex = backfillIdentitiesBatch.indexOf('page.type !== "entity"');
const deriveIndex = backfillIdentitiesBatch.indexOf(
  "const identity = await deriveKnowledgePageIdentity(ctx, args.orgId",
);
const patchIndex = backfillIdentitiesBatch.indexOf("await ctx.db.patch(page._id, { identity });");

assert(getIndex !== -1, "backfillIdentitiesBatch must load each requested page id");
assert(
  orgGuardIndex !== -1 &&
    getIndex < orgGuardIndex &&
    orgGuardIndex < typeGuardIndex &&
    orgGuardIndex < deriveIndex &&
    orgGuardIndex < patchIndex,
  "backfillIdentitiesBatch must verify page.orgId before deriveKnowledgePageIdentity or patch",
);
assert(
  /if \(page\.orgId !== args\.orgId\) \{[\s\S]*skipped \+= 1;[\s\S]*continue;[\s\S]*\}/.test(
    backfillIdentitiesBatch,
  ),
  "cross-org page ids must be skipped and counted without attempting repair",
);
assert(
  /deriveKnowledgePageIdentity\(ctx, args\.orgId, \{[\s\S]*type: page\.type,[\s\S]*title: page\.title,[\s\S]*entity: page\.entity/.test(
    backfillIdentitiesBatch,
  ),
  "identity derivation must remain scoped to the requested org after the ownership guard",
);
assert(
  /return \{ scanned, patched, skipped \};/.test(backfillIdentitiesBatch),
  "batch result must continue surfacing skipped rows for operator visibility",
);

console.log(
  "Playground identity backfill org guard proof passed: cross-org page ids cannot be derived or patched.",
);
NODE
