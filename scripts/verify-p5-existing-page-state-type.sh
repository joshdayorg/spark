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
const schema = fs.readFileSync(path.join(repoRoot, "convex", "schema.ts"), "utf8");

function fail(message) {
  console.error(`P5 existing-page state type proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractType(text, typeName) {
  const marker = `type ${typeName} = {`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find type ${typeName}`);
  }
  const nextType = text.indexOf("\ntype ", start + marker.length);
  const nextConst = text.indexOf("\nconst ", start + marker.length);
  const candidates = [nextType, nextConst].filter((index) => index !== -1);
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

const stateType = extractType(debug, "P5ExistingPageUpsertState");
const stateQuery = extractExportedFunction(debug, "p5GetExistingPageUpsertState");
const stateRef = debug.slice(
  debug.indexOf("const p5GetExistingPageUpsertStateRef"),
  debug.indexOf("const probeSessionRelationshipIdSeedRef"),
);

assert(
  /type:\s*Doc<"knowledgePages">\["type"\];/.test(stateType),
  "P5ExistingPageUpsertState.livePage.type must follow the schema-generated knowledgePages type union",
);
assert(
  !/type:\s*"fact"\s*\|\s*"pattern"\s*\|\s*"decision"\s*\|\s*"entity";/.test(
    stateType,
  ),
  "P5ExistingPageUpsertState.livePage.type must not narrow to the old four extraction page types",
);
assert(
  /"project"[\s\S]*"question"[\s\S]*"finding"[\s\S]*"goal"[\s\S]*"session"/.test(
    schema,
  ),
  "knowledgePages schema must include page types beyond the old extraction-only union",
);
assert(
  /Promise<P5ExistingPageUpsertState>/.test(stateQuery),
  "p5GetExistingPageUpsertState must keep the explicit P5ExistingPageUpsertState return contract",
);
assert(
  /livePage:\s*\{[\s\S]*type:\s*page\.type,/.test(stateQuery),
  "p5GetExistingPageUpsertState must be able to return the schema-derived page.type",
);
assert(
  /P5ExistingPageUpsertState/.test(stateRef),
  "function reference must expose the same widened state type to callers",
);

console.log(
  "P5 existing-page state type proof passed: livePage.type follows the knowledgePages schema union.",
);
NODE
