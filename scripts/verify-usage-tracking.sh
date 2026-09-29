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
const usage = fs.readFileSync(path.join(repoRoot, "convex", "usage.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`Usage tracking proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// 1) Table shape per A-11: org-scoped, decomposed token fields, indexed for
//    time-window sums.
const usageTable = schema.slice(
  schema.indexOf("usage: defineTable"),
  schema.indexOf("// syntheses"),
);
assert(usageTable.includes('orgId: v.id("orgs")'), "usage rows must be org-scoped");
for (const field of [
  "inputTokens: v.number()",
  "outputTokens: v.number()",
  "cacheReadInputTokens: v.number()",
  "cacheCreationInputTokens: v.number()",
  "costCents: v.number()",
  "timestamp: v.number()",
]) {
  assert(usageTable.includes(field), `usage table must define ${field}`);
}
assert(
  usageTable.includes('.index("by_org", ["orgId", "timestamp"])') &&
    usageTable.includes('.index("by_org_source", ["orgId", "source", "timestamp"])'),
  "usage table must keep by_org and by_org_source time-ordered indexes",
);

// 2) Budget sum is bounded: indexed pagination with a hard page budget, and
//    truncation fails safe (reported to callers, no unbounded collect).
assert(!/\.collect\(\)/.test(usage), "usage module must not use collect()");
assert(
  /SUM_MAX_PAGES/.test(usage) && /truncated: true/.test(usage),
  "sumUsageForOrgSince must have a hard page budget and report truncation",
);
assert(
  /withIndex\("by_org", \(q\) =>[\s\S]{0,120}gte\("timestamp", args\.sinceMs\)/.test(usage),
  "usage sums must read through the org-prefixed time index",
);

// 3) All five call-site families persist usage and are fail-soft.
const recordCalls = (spark.match(/internal\.usage\.recordUsage/g) ?? []).length;
assert(
  recordCalls >= 5,
  `expected recordUsage wiring at chat, extractor, synthesizer, linter, and managed-session sites (found ${recordCalls})`,
);
for (const source of ['source: "extractor"', 'source: "synthesizer"', 'source: "linter"']) {
  assert(spark.includes(source), `spark.ts must record ${source}`);
}
assert(
  /args\.purpose === "dream-cycle" \? "dream-cycle" : "customer-agent"/.test(spark),
  "managed sessions must attribute usage by purpose",
);
const failSoftCount = (spark.match(/spark:usageRecordFailed/g) ?? []).length;
assert(
  failSoftCount >= recordCalls,
  "every recordUsage call must be wrapped fail-soft (a usage write may never fail the pipeline that produced it)",
);

// 4) The chat handler resolves org from the thread and never trusts a client
//    orgId; ai v6/v5 usage field names are both handled.
assert(
  /AGENT_USAGE_SOURCES/.test(spark) &&
    /getOrgIdForThread/.test(spark.slice(spark.indexOf("const usageHandler"), spark.indexOf("const sparkChat"))),
  "usageHandler must resolve orgId from the thread mapping",
);
assert(
  /args\.usage\.inputTokens \?\? args\.usage\.promptTokens \?\? 0/.test(spark),
  "usageHandler must read both ai v6 and legacy usage field names",
);

console.log(
  "Usage tracking proof passed: A-11 table + bounded budget sums + fail-soft recording across chat, extractor, synthesizer, linter, and managed sessions.",
);
NODE
