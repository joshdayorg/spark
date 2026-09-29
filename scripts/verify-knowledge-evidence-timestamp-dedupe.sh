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

function fail(message) {
  console.error(`Knowledge evidence timestamp dedupe proof failed: ${message}`);
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
  const nextExport = text.indexOf("\nexport ", start + marker.length);
  const candidates = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

const knowledgePageEvidenceSchema = schema.slice(
  schema.indexOf("knowledgePageEvidence: defineTable"),
  schema.indexOf("sourceAttributions: defineTable"),
);
const buildKnowledgePageEvidenceKey = extractFunction(
  knowledge,
  "buildKnowledgePageEvidenceKey",
);
const recordKnowledgePageEvidence = extractFunction(
  knowledge,
  "recordKnowledgePageEvidence",
);

assert(
  /timestamp:\s*v\.number\(\)/.test(knowledgePageEvidenceSchema) &&
    /evidenceKey:\s*v\.string\(\)/.test(knowledgePageEvidenceSchema) &&
    /\.index\("by_page_key", \["pageId", "evidenceKey"\]\)/.test(
      knowledgePageEvidenceSchema,
    ),
  "evidence child rows must store timestamp and dedupe through page/evidenceKey",
);
// The key must carry a time component so a genuine repeat observation on a
// later day is retained — but a coarse (day-bucket) component, so byte-identical
// keystroke-burst stories seconds apart still collapse to one row.
assert(
  /const dayBucket = Math\.floor\(entry\.timestamp \/ 86_400_000\);/.test(
    buildKnowledgePageEvidenceKey,
  ) &&
    /return `\$\{entry\.source\}\\n\$\{entry\.channel\}\\n\$\{dayBucket\}\\n\$\{entry\.content\}`;/.test(
      buildKnowledgePageEvidenceKey,
    ),
  "evidence keys must include a day-bucketed time component (collapse bursts, retain later repeats)",
);
assert(
  !/return `\$\{entry\.source\}\\n\$\{entry\.channel\}\\n\$\{entry\.content\}`;/.test(
    buildKnowledgePageEvidenceKey,
  ),
  "evidence keys must not collapse all same-source/channel/content observations",
);
assert(
  !/return `\$\{entry\.source\}\\n\$\{entry\.channel\}\\n\$\{entry\.timestamp\}\\n\$\{entry\.content\}`;/.test(
    buildKnowledgePageEvidenceKey,
  ),
  "evidence keys must not use the raw timestamp (keystroke bursts would duplicate rows)",
);
assert(
  /const evidenceKey = buildKnowledgePageEvidenceKey\(entry\);[\s\S]*\.withIndex\("by_page_key", \(q\) =>[\s\S]*\.eq\("pageId", args\.pageId\)\.eq\("evidenceKey", evidenceKey\)[\s\S]*\.first\(\);[\s\S]*if \(existing\) \{[\s\S]*continue;[\s\S]*\}/.test(
    recordKnowledgePageEvidence,
  ),
  "evidence recorder must remain idempotent for exact same timestamped observations",
);
assert(
  /timestamp: entry\.timestamp,[\s\S]*content: entry\.content,[\s\S]*evidenceKey,/.test(
    recordKnowledgePageEvidence,
  ),
  "inserted evidence rows must persist the timestamp that participates in the key",
);

console.log(
  "Knowledge evidence timestamp dedupe proof passed: repeat content at different times keeps distinct evidence rows.",
);
NODE
