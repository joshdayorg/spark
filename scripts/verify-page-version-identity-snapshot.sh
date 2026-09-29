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
const versions = fs.readFileSync(
  path.join(repoRoot, "convex", "knowledgePageVersions.ts"),
  "utf8",
);

function fail(message) {
  console.error(`Page version identity snapshot proof failed: ${message}`);
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
  const nextExportedFunction = text.indexOf("\nexport function ", start + marker.length);
  const nextExportedAsyncFunction = text.indexOf(
    "\nexport async function ",
    start + marker.length,
  );
  const candidates = [
    nextFunction,
    nextExportedFunction,
    nextExportedAsyncFunction,
  ].filter((index) => index !== -1);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

const snapshotValidator = schema.slice(
  schema.indexOf("const knowledgePageSnapshotValidator = v.object"),
  schema.indexOf("export default defineSchema"),
);
const knowledgePagesTable = schema.slice(
  schema.indexOf("knowledgePages: defineTable"),
  schema.indexOf("pageVersions: defineTable"),
);
const optionalKeysStart = versions.indexOf("const optionalSnapshotKeys = [");
const optionalKeysEnd = versions.indexOf("] as const satisfies", optionalKeysStart);
const optionalSnapshotKeys = versions.slice(optionalKeysStart, optionalKeysEnd);
const buildKnowledgePageSnapshot = extractFunction(
  versions,
  "buildKnowledgePageSnapshot",
);

assert(
  /identity:\s*v\.optional\(v\.object\(\{\s*source:\s*v\.string\(\),\s*gid:\s*v\.string\(\)\s*\}\)\)/.test(
    knowledgePagesTable,
  ) &&
    /entityId:\s*v\.optional\(v\.id\("entities"\)\)/.test(knowledgePagesTable),
  "live knowledgePages schema must continue exposing identity and entityId",
);
assert(
  /identity:\s*v\.optional\(v\.object\(\{\s*source:\s*v\.string\(\),\s*gid:\s*v\.string\(\)\s*\}\)\)/.test(
    snapshotValidator,
  ),
  "page version snapshot validator must allow identity",
);
assert(
  /entityId:\s*v\.optional\(v\.id\("entities"\)\)/.test(snapshotValidator),
  "page version snapshot validator must allow entityId",
);
assert(
  /"identity"/.test(optionalSnapshotKeys) &&
    /"entityId"/.test(optionalSnapshotKeys) &&
    optionalSnapshotKeys.indexOf('"identity"') <
      optionalSnapshotKeys.indexOf('"severity"') &&
    optionalSnapshotKeys.indexOf('"entityId"') <
      optionalSnapshotKeys.indexOf('"severity"'),
  "optionalSnapshotKeys must copy identity and entityId from live pages",
);
assert(
  /for \(const key of optionalSnapshotKeys\) \{[\s\S]*const value = page\[key\];[\s\S]*\(snapshot as Record<string, unknown>\)\[key\] = value;/.test(
    buildKnowledgePageSnapshot,
  ),
  "buildKnowledgePageSnapshot must copy optional identity fields through the shared key loop",
);
assert(
  /const snapshot = buildKnowledgePageSnapshot\(args\.page\);[\s\S]*snapshot,/.test(
    versions,
  ),
  "insertPageVersion must persist the complete built snapshot",
);

console.log(
  "Page version identity snapshot proof passed: version snapshots preserve identity and entityId.",
);
NODE
