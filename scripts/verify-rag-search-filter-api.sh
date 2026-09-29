#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const files = ["convex/search.ts", "convex/knowledge.ts", "convex/debug.ts"];
const sources = Object.fromEntries(
  files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), "utf8")]),
);

function fail(message) {
  console.error(`RAG search filter API proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractCall(text, marker) {
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find ${marker}`);
  }
  const end = text.indexOf(")", start + marker.length);
  return text.slice(start, end === -1 ? text.length : end + 1);
}

function extractRagSearchCalls(text) {
  const calls = [];
  const marker = "rag.search(";
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf(marker, searchFrom);
    if (start === -1) {
      return calls;
    }

    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push(text.slice(start, index + 1));
          searchFrom = index + 1;
          break;
        }
      }
    }
    if (searchFrom <= start) {
      fail("could not parse rag.search call");
    }
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

for (const [file, source] of Object.entries(sources)) {
  const calls = extractRagSearchCalls(source);
  const badSearchCall = calls.find((call) => /filterValues\s*:/.test(call));
  assert(
    !badSearchCall,
    `${file} must use search-time filters, not add-time filterValues, in rag.search calls`,
  );
}

const runSearchBaseline = extractExportedFunction(
  sources["convex/debug.ts"],
  "runSearchBaseline",
);
const deepSearchCall = extractCall(sources["convex/search.ts"], "rag.search(ctx, {");
const debugSearchCall = extractCall(
  sources["convex/debug.ts"],
  "rag.search(ctx, { namespace: orgId",
);
const baselineSearchCalls = extractRagSearchCalls(runSearchBaseline);

assert(
  baselineSearchCalls.length === 1,
  `runSearchBaseline must keep exactly one RAG preflight search, found ${baselineSearchCalls.length}`,
);

for (const [name, call] of [
  ["deepSearch", deepSearchCall],
  ["debugSearchVector", debugSearchCall],
  ["search baseline vector probe", baselineSearchCalls[0]],
]) {
  assert(
    /filters:\s*\[\]/.test(call),
    `${name} rag.search call must pass filters: [] for an unfiltered search`,
  );
  assert(
    !/filterValues\s*:/.test(call),
    `${name} rag.search call must not pass filterValues`,
  );
}

assert(
  /rag\.add\(ctx, \{[\s\S]*filterValues:\s*\[\{ name: "sourceType", value: seed\.sourceType \}\]/.test(
    runSearchBaseline,
  ),
  "runSearchBaseline must keep sourceType filterValues on rag.add only",
);
assert(
  runSearchBaseline.indexOf("filterValues: [{ name: \"sourceType\", value: seed.sourceType }]") <
    runSearchBaseline.indexOf("const vectorProbe = await rag.search(ctx, {"),
  "runSearchBaseline must add filterValues before using search-time filters",
);
assert(
  /`filters: \[\]` is intentional/.test(sources["convex/debug.ts"]),
  "debugSearchVector comment must document the search-time filters option",
);

console.log(
  "RAG search filter API proof passed: all rag.search calls use search-time filters, not add-time filterValues.",
);
NODE
