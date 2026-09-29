#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const crons = fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8");
const schema = fs.readFileSync(path.join(repoRoot, "convex", "schema.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");
const guidelines = fs.readFileSync(
  path.join(repoRoot, "docs", "convex-context", "convex-guidelines.md"),
  "utf8",
);

function fail(message) {
  console.error(`Daily synthesis cron/bounded-read proof failed: ${message}`);
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

function extractFunction(text, functionName) {
  const marker = `function ${functionName}`;
  const asyncMarker = `async function ${functionName}`;
  const markerStart = text.indexOf(marker);
  const asyncMarkerStart = text.indexOf(asyncMarker);
  const start = markerStart === -1 ? asyncMarkerStart : markerStart;
  if (start === -1) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + marker.length);
  const nextAsyncFunction = text.indexOf(
    "\nasync function ",
    start + marker.length,
  );
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const boundaries = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = boundaries.length === 0 ? text.length : Math.min(...boundaries);
  return text.slice(start, end);
}

const dailySynthesis = extractExportedFunction(spark, "dailySynthesis");
const debugDailySynthesisForOrg = extractExportedFunction(
  spark,
  "debugDailySynthesisForOrg",
);
const fanOutSynthesesForPeriod = extractFunction(
  spark,
  "fanOutSynthesesForPeriod",
);
const getSynthesisFanOutState = extractExportedFunction(
  knowledge,
  "getSynthesisFanOutState",
);
const getSynthesisInputs = extractExportedFunction(
  knowledge,
  "getSynthesisInputs",
);
const listSynthesisSessionCandidates = extractFunction(
  knowledge,
  "listSynthesisSessionCandidates",
);
const listUpdatedSynthesisCandidates = extractFunction(
  knowledge,
  "listUpdatedSynthesisCandidates",
);

assert(
  /Only use the `crons\.interval` or `crons\.cron` methods/.test(guidelines),
  "local Convex guidelines must require interval or cron scheduling",
);
assert(
  !/crons\.(hourly|daily|weekly|monthly)\(/.test(crons),
  "convex/crons.ts must not use disallowed calendar helper methods",
);
assert(
  /crons\.cron\(\s*"daily-synthesis",\s*"0 8 \* \* \*",[\s\S]*internal\.spark\.dailySynthesis/.test(crons),
  "daily-synthesis must keep the 08:00 UTC schedule with crons.cron",
);
assert(
  /crons\.cron\(\s*"weekly-synthesis",\s*"0 9 \* \* 1",[\s\S]*internal\.spark\.weeklySynthesis/.test(crons) &&
    /crons\.cron\(\s*"monthly-synthesis",\s*"0 10 1 \* \*",[\s\S]*internal\.spark\.monthlySynthesis/.test(crons),
  "sibling synthesis crons must preserve their UTC schedules with crons.cron",
);

assert(
  /handler:\s*async \(ctx\) => fanOutSynthesesForPeriod\(ctx, "daily"\)/.test(dailySynthesis),
  "dailySynthesis must use the shared daily fan-out path",
);
assert(
  /handler:\s*async \(ctx, args\) =>[\s\S]*fanOutSynthesesForPeriod\(ctx, "daily", \{[\s\S]*includeOrgIds/.test(debugDailySynthesisForOrg),
  "debugDailySynthesisForOrg must exercise the daily fan-out path for focused probes",
);
assert(
  /getSynthesisFanOutStateRef/.test(fanOutSynthesesForPeriod) &&
    /period === "daily"\s*\?\s*null/.test(fanOutSynthesesForPeriod),
  "daily fan-out must inspect bounded relevance state without dependency readiness work",
);

for (const [indexName, fields] of [
  ["by_org_type_status_sessionEndTime", '["orgId", "type", "status", "sessionEndTime"]'],
  ["by_org_type_status_updatedAt", '["orgId", "type", "status", "updatedAt"]'],
  ["by_org_status", '["orgId", "status", "updatedAt"]'],
]) {
  assert(
    schema.includes(`.index("${indexName}", ${fields})`),
    `schema must define ${indexName}`,
  );
}

for (const [name, text] of [
  ["getSynthesisFanOutState", getSynthesisFanOutState],
  ["getSynthesisInputs", getSynthesisInputs],
  ["listSynthesisSessionCandidates", listSynthesisSessionCandidates],
  ["listUpdatedSynthesisCandidates", listUpdatedSynthesisCandidates],
]) {
  assert(!/\.collect\(\)/.test(text), `${name} must not collect unbounded rows`);
  assert(!/\.filter\(\(q\)/.test(text), `${name} must not use Convex filters after scans`);
}

assert(
  /listSynthesisSessionCandidates\(ctx/.test(getSynthesisFanOutState) &&
    /listUpdatedSynthesisCandidates\(ctx/.test(getSynthesisFanOutState) &&
    /const readLimit = SYNTHESIS_FAN_OUT_RELEVANCE_LIMIT;/.test(getSynthesisFanOutState),
  "daily fan-out state must use bounded synthesis candidate helpers",
);
assert(
  /const pageReadLimit = clampSynthesisCandidateReadLimit\(pageLimit\);/.test(getSynthesisInputs) &&
    /listSynthesisSessionCandidates\(ctx/.test(getSynthesisInputs) &&
    /listUpdatedSynthesisCandidates\(ctx/.test(getSynthesisInputs),
  "daily synthesis inputs must use bounded synthesis candidate helpers",
);
assert(
  /\.withIndex\("by_org_type_status_sessionEndTime", \(q\) =>[\s\S]*\.eq\("type", "session"\)[\s\S]*\.eq\("status", "active"\)[\s\S]*\.gte\("sessionEndTime", args\.timestamp\)[\s\S]*\.take\(args\.readLimit\)/.test(listSynthesisSessionCandidates) &&
    /\.withIndex\("by_org_type_status_updatedAt", \(q\) =>[\s\S]*\.eq\("type", "session"\)[\s\S]*\.eq\("status", "active"\)[\s\S]*\.gte\("updatedAt", args\.timestamp\)[\s\S]*\.lt\("updatedAt", args\.windowEnd\)[\s\S]*\.take\(args\.readLimit\)/.test(listSynthesisSessionCandidates),
  "session candidates must push daily window predicates into bounded indexes",
);
assert(
  /\.withIndex\("by_org_status", \(q\) =>[\s\S]*\.eq\("status", "active"\)[\s\S]*\.gte\("updatedAt", args\.timestamp\)[\s\S]*\.lt\("updatedAt", args\.windowEnd\)[\s\S]*\.take\(args\.readLimit\)/.test(listUpdatedSynthesisCandidates),
  "updated page candidates must push daily window predicates into a bounded index",
);

console.log("Daily synthesis cron/bounded-read proof passed: daily schedule uses cron syntax and daily synthesis reads are indexed and bounded.");
NODE
