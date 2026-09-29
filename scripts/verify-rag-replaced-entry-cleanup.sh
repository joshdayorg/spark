#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const knowledge = fs.readFileSync(
  path.join(repoRoot, "convex", "knowledge.ts"),
  "utf8",
);

function fail(message) {
  console.error(`RAG replaced-entry cleanup proof failed: ${message}`);
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

const processSource = extractExportedFunction(knowledge, "processSource");
const ragAddBlockMatch = processSource.match(
  /const ragResult = await withRetriableCall\(classifyRagRetry, \(\) =>[\s\S]*?rag\.add\(ctx, \{[\s\S]*?contentHash,[\s\S]*?filterValues: \[[\s\S]*?\}\),[\s\S]*?\);/,
);

assert(
  ragAddBlockMatch,
  "processSource must add RAG entries with stable keys, contentHash, and sourceType filterValues",
);
assert(
  /const replacedEntry = ragResult\.replacedEntry;[\s\S]*if \(replacedEntry\) \{[\s\S]*await withRetriableCall\(classifyRagRetry, \(\) =>[\s\S]*rag\.delete\(ctx, \{ entryId: replacedEntry\.entryId \}\),[\s\S]*\);[\s\S]*\}/.test(
    processSource,
  ),
  "processSource must delete replaced RAG entries after successful rag.add",
);
assert(
  /if \(ragResult\.created\) \{[\s\S]*ragEntriesAdded \+= 1;[\s\S]*\}[\s\S]*const replacedEntry = ragResult\.replacedEntry/.test(
    processSource,
  ),
  "created-entry accounting must remain separate from replaced-entry cleanup",
);

console.log(
  "RAG replaced-entry cleanup proof passed: processSource deletes old replaced RAG entries after add.",
);
NODE
