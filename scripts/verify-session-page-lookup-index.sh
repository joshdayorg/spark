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
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");

function fail(message) {
  console.error(`Session page lookup index proof failed: ${message}`);
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

const insertSessionAndMarkEvents = extractExportedFunction(
  spark,
  "insertSessionAndMarkEvents",
);
const getSessionPageForBridge = extractExportedFunction(
  knowledge,
  "getSessionPageForBridge",
);
const bridgeSessionToKnowledge = extractExportedFunction(
  knowledge,
  "bridgeSessionToKnowledge",
);
const createSource = extractExportedFunction(knowledge, "createSource");
const finalizeSessionExtraction = extractExportedFunction(
  knowledge,
  "finalizeSessionExtraction",
);

const sessionLookupFunctions = [
  ["insertSessionAndMarkEvents", insertSessionAndMarkEvents],
  ["getSessionPageForBridge", getSessionPageForBridge],
  ["createSource", createSource],
  ["finalizeSessionExtraction", finalizeSessionExtraction],
];

assert(
  /\.index\("by_org_sessionId", \["orgId", "sessionId"\]\)/.test(schema),
  "knowledgePages must expose a direct org/sessionId index",
);

for (const [name, body] of sessionLookupFunctions) {
  assert(
    /\.withIndex\("by_org_sessionId", \(q\) =>[\s\S]*\.eq\("orgId", [^)]+?\)[\s\S]*\.eq\("sessionId",/.test(
      body,
    ),
    `${name} must resolve session pages through by_org_sessionId`,
  );
  assert(
    /\.first\(\)/.test(body),
    `${name} must keep session page lookups bounded to one row`,
  );
  assert(
    !/\.filter\(\(q\) => q\.eq\(q\.field\("sessionId"\)/.test(body),
    `${name} must not filter sessionId after scanning candidate pages`,
  );
  assert(
    !/\.withIndex\("by_org_type"[\s\S]*\.filter\(\(q\) => q\.eq\(q\.field\("sessionId"\)/.test(
      body,
    ),
    `${name} must not scan org/type session pages and filter by sessionId`,
  );
}

assert(
  /ctx\.runQuery\(getSessionPageForBridgeRef, \{[\s\S]*orgId: args\.orgId,[\s\S]*sessionId: args\.sessionId/.test(
    bridgeSessionToKnowledge,
  ),
  "bridgeSessionToKnowledge must use the indexed getSessionPageForBridge helper",
);
assert(
  !/ctx\.db\s*\.query\("knowledgePages"\)/.test(bridgeSessionToKnowledge),
  "bridgeSessionToKnowledge must not perform its own knowledgePages scan",
);

assert(
  !/\.withIndex\("by_org_type"[\s\S]{0,260}\.filter\(\(q\) => q\.eq\(q\.field\("sessionId"\)/.test(
    `${spark}\n${knowledge}`,
  ),
  "no session page lookup may use by_org_type plus a sessionId filter",
);

console.log("Session page lookup index proof passed: session page lookups use by_org_sessionId instead of org/type scans.");
NODE
