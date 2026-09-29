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

function fail(message) {
  console.error(`MCP placeholder log redaction proof failed: ${message}`);
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

// mcpAsk/mcpEntity graduated from placeholders to real implementations. The
// redaction contract survives them: network-facing input values (the question
// text, the entity id) must never be logged raw.
const mcpAsk = extractExportedFunction(spark, "mcpAsk");
const mcpEntity = extractExportedFunction(spark, "mcpEntity");

for (const [name, body, rawPatterns] of [
  ["mcpAsk", mcpAsk, [/console\.(log|warn|error)\([\s\S]{0,200}question: args\.question/]],
  ["mcpEntity", mcpEntity, [/console\.(log|warn|error)\([\s\S]{0,200}entityId: args\.entityId/]],
]) {
  for (const pattern of rawPatterns) {
    assert(!pattern.test(body), `${name} must not log raw network-facing input values`);
  }
}

// And they must be real now, not placeholders.
assert(
  !/Knowledge layer not yet built/.test(mcpAsk) &&
    /internal\.search\.deepSearch/.test(mcpAsk),
  "mcpAsk must synthesize from deep search, not return the placeholder",
);
assert(
  /mcpEntityLookup/.test(spark) && /Promise<McpEntityProfile>/.test(mcpEntity),
  "mcpEntity must return a real entity profile",
);

console.log(
  "MCP log redaction proof passed: ask/entity are real implementations and never log raw inputs.",
);
NODE
