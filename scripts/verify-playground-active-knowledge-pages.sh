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
const schema = fs.readFileSync(path.join(repoRoot, "convex", "schema.ts"), "utf8");

function fail(message) {
  console.error(`Playground active knowledge pages proof failed: ${message}`);
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

const listKnowledgePages = extractExportedFunction(knowledge, "listKnowledgePages");
const getKnowledgePage = extractExportedFunction(knowledge, "getKnowledgePage");
const knowledgePagesSchema = schema.slice(
  schema.indexOf("knowledgePages: defineTable"),
  schema.indexOf("pageVersions: defineTable"),
);

assert(
  /\.index\("by_org_type_status_updatedAt", \["orgId", "type", "status", "updatedAt"\]\)/.test(
    knowledgePagesSchema,
  ),
  "schema must define the org/type/status/updatedAt index",
);
assert(
  /\.withIndex\("by_org_type_status_updatedAt", \(q\) =>[\s\S]*\.eq\("orgId", ctx\.orgId\)[\s\S]*\.eq\("type", args\.type!\)[\s\S]*\.eq\("status", "active"\)[\s\S]*\.order\("desc"\)[\s\S]*\.take\(limit\)/.test(
    listKnowledgePages,
  ),
  "typed knowledge page browse must read only active pages through the compound index",
);
assert(
  /\.withIndex\("by_org_status", \(q\) =>[\s\S]*\.eq\("orgId", ctx\.orgId\)\.eq\("status", "active"\)[\s\S]*\.order\("desc"\)[\s\S]*\.take\(limit\)/.test(
    listKnowledgePages,
  ),
  "untyped knowledge page browse must continue reading only active pages",
);
assert(
  !/\.withIndex\("by_org_type", \(q\) =>[\s\S]*\.eq\("type", args\.type!\)/.test(
    listKnowledgePages,
  ),
  "typed knowledge page browse must not use by_org_type without status",
);
assert(
  /page\.status !== "active"/.test(getKnowledgePage),
  "knowledge page detail must hide non-active pages",
);

console.log("Playground active knowledge pages proof passed: browse and detail hide draft/archived pages.");
NODE
