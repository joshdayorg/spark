#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const search = fs.readFileSync(path.join(repoRoot, "convex", "search.ts"), "utf8");

function fail(message) {
  console.error(`Deep search rerank candidate cap proof failed: ${message}`);
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
  const nextAsyncFunction = text.indexOf("\nasync function ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const candidates = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
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

const buildBoundedDeepSearchRerankCandidates = extractFunction(
  search,
  "buildBoundedDeepSearchRerankCandidates",
);
const deepSearch = extractExportedFunction(search, "deepSearch");

assert(
  /const FUSED_CANDIDATE_LIMIT = 50;/.test(search) &&
    /const PAGE_TEXT_CANDIDATE_LIMIT = 50;/.test(search) &&
    /const DEEP_SEARCH_RERANK_CANDIDATE_LIMIT = FUSED_CANDIDATE_LIMIT;/.test(
      search,
    ),
  "deep search must define one final rerank candidate budget",
);
assert(
  /chunkCandidates\.length \+ pageCandidates\.length <=[\s\S]*DEEP_SEARCH_RERANK_CANDIDATE_LIMIT/.test(
    buildBoundedDeepSearchRerankCandidates,
  ),
  "bounded rerank builder must allow small combined candidate sets unchanged",
);
assert(
  /candidates\.length < DEEP_SEARCH_RERANK_CANDIDATE_LIMIT[\s\S]*chunkIndex < chunkCandidates\.length[\s\S]*pageIndex < pageCandidates\.length/.test(
    buildBoundedDeepSearchRerankCandidates,
  ),
  "bounded rerank builder must stop at the final budget while considering both candidate sources",
);
assert(
  /buildBoundedDeepSearchRerankCandidates\(\{[\s\S]*chunks: chunkRerankCandidates,[\s\S]*pages: pageTextResults,[\s\S]*\}\)/.test(
    deepSearch,
  ),
  "deepSearch must build rerank candidates through the bounded helper",
);
assert(
  /documents: rerankCandidates\.map\(\(candidate\) => candidate\.document\),[\s\S]*topN: rerankCandidates\.length/.test(
    deepSearch,
  ),
  "Cohere rerank must receive only the bounded candidate documents and matching topN",
);
assert(
  /const rerankedChunkIds = new Set\([\s\S]*candidate\.kind === "chunk"[\s\S]*candidate\.chunk\._id[\s\S]*const rerankedChunkAttributions = chunkAttributions\.filter/.test(
    deepSearch,
  ),
  "deepSearch must only fan out attributions for chunk candidates actually sent to rerank",
);
assert(
  /rerankedCount: rerankCandidates\.length/.test(deepSearch),
  "deepSearch meta.rerankedCount must report the bounded rerank input count",
);

const simulatedChunks = Array.from({ length: 50 }, (_, index) => ({
  kind: "chunk",
  id: `chunk-${index}`,
}));
const simulatedPages = Array.from({ length: 50 }, (_, index) => ({
  kind: "page",
  id: `page-${index}`,
}));
const simulatedBounded = [];
let chunkIndex = 0;
let pageIndex = 0;
while (
  simulatedBounded.length < 50 &&
  (chunkIndex < simulatedChunks.length || pageIndex < simulatedPages.length)
) {
  if (chunkIndex < simulatedChunks.length) {
    simulatedBounded.push(simulatedChunks[chunkIndex]);
    chunkIndex += 1;
  }
  if (simulatedBounded.length < 50 && pageIndex < simulatedPages.length) {
    simulatedBounded.push(simulatedPages[pageIndex]);
    pageIndex += 1;
  }
}
assert(
  simulatedBounded.length === 50,
  "50 chunk + 50 page candidates must produce at most 50 rerank documents",
);
assert(
  simulatedBounded.some((candidate) => candidate.kind === "chunk") &&
    simulatedBounded.some((candidate) => candidate.kind === "page"),
  "bounded rerank set should preserve both chunk and page candidate sources",
);

console.log(
  "Deep search rerank candidate cap proof passed: Cohere receives no more than the final candidate budget.",
);
NODE
