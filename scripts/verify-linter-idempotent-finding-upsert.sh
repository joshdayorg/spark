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
  console.error(`Linter idempotent finding upsert proof failed: ${message}`);
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
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const boundaries = [nextFunction, nextExport].filter((index) => index !== -1);
  const end = boundaries.length === 0 ? text.length : Math.min(...boundaries);
  return text.slice(start, end);
}

const materialComparator = extractFunction(
  knowledge,
  "isSameLinterFindingPageMaterial",
);
const upsertLinterFinding = extractExportedFunction(
  knowledge,
  "upsertLinterFinding",
);

assert(
  /function evidenceTimelinesEqual\([\s\S]*entry\.source === other\.source[\s\S]*entry\.channel === other\.channel[\s\S]*entry\.timestamp === other\.timestamp[\s\S]*entry\.content === other\.content/.test(
    knowledge,
  ),
  "proof requires exact evidence timeline comparison",
);
assert(
  /function getUniqueRelatedReferencePageIds\([\s\S]*sortIds\(dedupeIds\(references\.map\(\(reference\) => reference\.toPageId\)\)\)/.test(
    knowledge,
  ) &&
    /function hasDuplicateRelatedReferences\([\s\S]*references\.length !== getUniqueRelatedReferencePageIds\(references\)\.length/.test(
      knowledge,
    ),
  "proof requires deterministic related-page set and duplicate-reference checks",
);
assert(
  /existing\.title === patch\.title[\s\S]*existing\.compiledTruth === patch\.compiledTruth[\s\S]*evidenceTimelinesEqual\(existing\.evidenceTimeline, patch\.evidenceTimeline\)[\s\S]*arraysEqual\(existing\.tags, patch\.tags\)[\s\S]*existing\.severity === patch\.severity[\s\S]*existing\.findingType === patch\.findingType[\s\S]*existing\.findingStatus === patch\.findingStatus[\s\S]*existing\.sourceAgent === patch\.sourceAgent[\s\S]*existing\.status === patch\.status/.test(
    materialComparator,
  ),
  "material comparator must include finding content, metadata, and status fields",
);
assert(
  !/lastConfirmed|updatedAt/.test(materialComparator),
  "material comparator must ignore timestamp-only confirmation churn",
);

const relatedReadIndex = upsertLinterFinding.indexOf("const existingRelatedReferences");
const earlyReturnIndex = upsertLinterFinding.indexOf("!pageMaterialChanged");
const patchIndex = upsertLinterFinding.indexOf("await ctx.db.patch");
const versionIndex = upsertLinterFinding.indexOf("await insertPageVersion");
assert(
  relatedReadIndex !== -1 &&
    earlyReturnIndex !== -1 &&
    patchIndex !== -1 &&
    versionIndex !== -1 &&
    relatedReadIndex < earlyReturnIndex &&
    earlyReturnIndex < patchIndex &&
    earlyReturnIndex < versionIndex,
  "unchanged linter findings must return before page patching or version insertion",
);
assert(
  /const relatedPageSetChanged =[\s\S]*!arraysEqual\(existingRelatedPageIds, relatedPageIds\)/.test(
    upsertLinterFinding,
  ) &&
    /const pageMaterialChanged =[\s\S]*!isSameLinterFindingPageMaterial\(existing, findingPatch\)/.test(
      upsertLinterFinding,
    ),
  "upsert must separately detect page material and related-page set changes",
);
assert(
  /existing &&[\s\S]*!pageMaterialChanged &&[\s\S]*!relatedPageSetChanged &&[\s\S]*!duplicateRelatedReferences[\s\S]*return \{[\s\S]*inserted: false/.test(
    upsertLinterFinding,
  ),
  "exact idempotent reruns must return without writes",
);
assert(
  /const shouldVersionFinding =[\s\S]*!existing \|\| pageMaterialChanged \|\| relatedPageSetChanged/.test(
    upsertLinterFinding,
  ) &&
    /if \(existing && shouldVersionFinding\) \{[\s\S]*await ctx\.db\.patch/.test(
      upsertLinterFinding,
    ) &&
    /if \(shouldVersionFinding\) \{[\s\S]*await insertPageVersion/.test(
      upsertLinterFinding,
    ),
  "page patch and pageVersions growth must be gated to material finding or related-page changes",
);
assert(
  !/const shouldVersionFinding =[\s\S]*duplicateRelatedReferences/.test(
    upsertLinterFinding,
  ),
  "duplicate reference cleanup alone must not create a pageVersion",
);

console.log("Linter idempotent finding upsert proof passed: unchanged reruns do not patch or insert pageVersions.");
NODE
