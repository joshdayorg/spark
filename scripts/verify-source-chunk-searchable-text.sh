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
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");
const search = fs.readFileSync(path.join(repoRoot, "convex", "search.ts"), "utf8");
const debug = fs.readFileSync(path.join(repoRoot, "convex", "debug.ts"), "utf8");
const playground = fs.readFileSync(path.join(repoRoot, "convex", "playground.ts"), "utf8");

function fail(message) {
  console.error(`Source chunk searchable text proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractObjectBlocks(text, callText) {
  const blocks = [];
  let cursor = 0;
  while (true) {
    const callIndex = text.indexOf(callText, cursor);
    if (callIndex === -1) {
      break;
    }
    const start = text.indexOf("{", callIndex);
    if (start === -1) {
      fail(`could not find object literal for ${callText}`);
    }

    let depth = 0;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    if (end === -1) {
      fail(`could not parse object literal for ${callText}`);
    }
    blocks.push(text.slice(start, end));
    cursor = end;
  }
  return blocks;
}

assert(
  /sourceChunks:\s*defineTable\(\{[\s\S]*searchableText:\s*v\.optional\(v\.string\(\)\)/.test(schema),
  "sourceChunks schema must keep searchableText optional during the legacy backfill rollout",
);
assert(
  /\.searchIndex\("search_content",\s*\{[\s\S]*searchField:\s*"searchableText"/.test(schema),
  "search_content must index searchableText",
);
assert(
  !/searchField:\s*"content"/.test(schema),
  "sourceChunks search_content must no longer index raw content only",
);

assert(
  /function buildSourceChunkSearchableText\(content: string, contextPrefix\?: string\): string/.test(knowledge),
  "knowledge.ts must define the source chunk searchable text builder",
);
assert(
  /return contextPrefix \? `\$\{contextPrefix\}\\n\\n\$\{content\}` : content;/.test(knowledge),
  "searchableText builder must combine contextPrefix, a blank line, and content",
);
assert(
  /const searchableText = buildSourceChunkSearchableText\(\s*args\.content,\s*args\.contextPrefix,\s*\);/.test(knowledge),
  "upsertSourceChunk must compute searchableText from content and contextPrefix",
);
assert(
  /existing\.searchableText !== searchableText/.test(knowledge),
  "upsertSourceChunk must repair stale searchableText on existing chunks",
);
assert(
  /ctx\.db\.patch\(existing\._id,\s*\{[\s\S]*searchableText,[\s\S]*\}\);/.test(knowledge),
  "upsertSourceChunk patch must write searchableText",
);
assert(
  /ctx\.db\.insert\("sourceChunks",\s*\{[\s\S]*searchableText,[\s\S]*\}\);/.test(knowledge),
  "upsertSourceChunk insert must write searchableText",
);
assert(
  /export const backfillSourceChunkSearchableText = internalMutation\(\{[\s\S]*cursor:\s*v\.optional\(v\.string\(\)\)[\s\S]*\.paginate\(\{[\s\S]*cursor: args\.cursor \?\? null,[\s\S]*numItems: limit,[\s\S]*\}\)/.test(playground),
  "searchableText backfill must paginate with a cursor so legacy rows beyond the first page can be repaired",
);
assert(
  /continueCursor: page\.isDone \? null : page\.continueCursor/.test(playground) &&
    /isDone: page\.isDone/.test(playground),
  "searchableText backfill must return continuation state for repeated migration batches",
);

assert(
  /q\.search\("searchableText", queryText\)\.eq\("orgId", args\.orgId\)/.test(search),
  "bm25ChunkSearch must query searchableText",
);
assert(
  /s\.search\("searchableText", q\)\.eq\("orgId", orgId\)/.test(debug),
  "debugSearchKeyword must query searchableText",
);
assert(
  !/\.search\("content"/.test(search + knowledge),
  "keyword searches must not target raw content only",
);
assert(
  knowledge.includes("const ragText = `${storedChunk.contextPrefix}\\n\\n${storedChunk.content}`;"),
  "RAG ingestion must still use contextPrefix plus raw content",
);

const debugSourceChunkInserts = extractObjectBlocks(debug, 'insert("sourceChunks"');
assert(debugSourceChunkInserts.length > 0, "debug fixtures must still insert source chunks");
for (const [index, block] of debugSourceChunkInserts.entries()) {
  assert(
    block.includes("searchableText:") || block.includes("...chunkPatch"),
    `debug source chunk insert #${index + 1} must include searchableText or a chunkPatch spread`,
  );
}

const debugChunkPatchBlocks = extractObjectBlocks(debug, "const chunkPatch =");
for (const [index, block] of debugChunkPatchBlocks.entries()) {
  assert(
    block.includes("searchableText:"),
    `debug chunkPatch #${index + 1} must include searchableText`,
  );
}

console.log("Source chunk searchable text proof passed: BM25 indexes context prefixes plus raw content.");
NODE
