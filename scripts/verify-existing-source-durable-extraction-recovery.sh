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
  console.error(`Existing-source durable extraction recovery proof failed: ${message}`);
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

const createSource = extractExportedFunction(knowledge, "createSource");
const extractKnowledgeFromSource = extractExportedFunction(
  knowledge,
  "extractKnowledgeFromSource",
);

const durableRecoveryStart = createSource.indexOf(
  "const durableAttribution = await ctx.db",
);
const replacementJobStart = createSource.indexOf(
  'const jobId = await ctx.db.insert("ingestJobs"',
  durableRecoveryStart,
);
assert(
  durableRecoveryStart !== -1,
  "createSource must check for durable source attributions on existing sources",
);
assert(
  replacementJobStart !== -1,
  "createSource existing-source replacement job insert not found",
);
const durableRecoveryBlock = createSource.slice(
  durableRecoveryStart,
  replacementJobStart,
);

assert(
  /\.query\("sourceAttributions"\)[\s\S]*\.withIndex\("by_source", \(q\) => q\.eq\("sourceId", existing\._id\)\)[\s\S]*\.first\(\)/.test(
    durableRecoveryBlock,
  ),
  "existing-source recovery must use a bounded by_source attribution probe",
);
assert(
  /const failedJobWithDurableOutput =[\s\S]*durableAttribution \? jobs\.find\(\(job\) => job\.status === "failed"\) : null;/.test(
    durableRecoveryBlock,
  ),
  "existing-source recovery must reuse a failed job that already has durable output",
);
assert(
  /ctx\.db\.patch\(failedJobWithDurableOutput\._id, \{[\s\S]*status: "cross_referencing"[\s\S]*currentStep: "Recovering existing source from durable attributions"[\s\S]*error: ""[\s\S]*startedAt: now/.test(
    durableRecoveryBlock,
  ),
  "failed durable-output job must be moved to cross_referencing instead of replaced",
);
assert(
  /ctx\.scheduler\.runAfter\(0, extractKnowledgeFromSourceRef, \{[\s\S]*sourceId: existing\._id,[\s\S]*jobId: failedJobWithDurableOutput\._id/.test(
    durableRecoveryBlock,
  ),
  "recovered durable-output job must schedule extractKnowledgeFromSource",
);
assert(
  /return \{[\s\S]*sourceId: existing\._id,[\s\S]*jobId: failedJobWithDurableOutput\._id,[\s\S]*duplicate: false,[\s\S]*resumed: true/.test(
    durableRecoveryBlock,
  ),
  "createSource must return the recovered failed job instead of inserting a replacement",
);

const afterExtractingTransition = extractKnowledgeFromSource.slice(
  extractKnowledgeFromSource.indexOf('if (job.status === "extracting")'),
  extractKnowledgeFromSource.indexOf("const referenceResult"),
);
assert(
  /await ctx\.runMutation\(transitionJobStatusRef,[\s\S]*expectedFrom: "extracting"[\s\S]*to: "synthesizing"/.test(
    afterExtractingTransition,
  ),
  "extractKnowledgeFromSource must still transition extracting jobs to synthesizing",
);
assert(
  /const durablePages = await ctx\.runQuery\(getExtractedPagesForSourceRef,[\s\S]*sourceId: source\._id/.test(
    afterExtractingTransition,
  ),
  "extractKnowledgeFromSource must re-check durable output after extraction-state repair",
);
assert(
  /if \(durablePages\.length > 0\) \{[\s\S]*extractedPages = durablePages;[\s\S]*\} else \{[\s\S]*claimKnowledgeExtractionLeaseRef/.test(
    afterExtractingTransition,
  ),
  "durable output must bypass a fresh write lease even after transitioning from extracting",
);
assert(
  !/if \(job\.status === "synthesizing" && durablePages\.length > 0\)/.test(
    extractKnowledgeFromSource,
  ),
  "durable output recovery must not depend on the stale pre-transition job status",
);

console.log(
  "Existing-source durable extraction recovery proof passed: durable output resumes failed jobs and bypasses replacement extraction leases.",
);
NODE
