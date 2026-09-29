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
const crons = fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8");

function fail(message) {
  console.error(`Stuck session bridge batching proof failed: ${message}`);
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

const listStuckSessionPages = extractExportedFunction(
  knowledge,
  "listStuckSessionPages",
);
const getSessionBridgeState = extractExportedFunction(
  knowledge,
  "getSessionBridgeState",
);
const sweepStuckSessionBridges = extractExportedFunction(
  knowledge,
  "sweepStuckSessionBridges",
);

assert(
  /\.index\("by_type_status_updatedAt", \["type", "status", "updatedAt"\]\)/.test(schema),
  "knowledgePages must expose a global type/status/updatedAt index for stale session scans",
);
assert(
  /const STUCK_SESSION_BRIDGE_SWEEP_BATCH_SIZE = 25;/.test(knowledge),
  "sweep must define a fixed batch size",
);
assert(
  /const SESSION_BRIDGE_STATE_SOURCE_LIMIT = 5;/.test(knowledge) &&
    /const SESSION_BRIDGE_STATE_JOB_LIMIT = 5;/.test(knowledge) &&
    /const SESSION_BRIDGE_STATE_ATTRIBUTION_LIMIT = 100;/.test(knowledge),
  "per-session bridge state reads must define fixed bounds",
);
assert(
  /\.index\("by_session_created", \["sessionId", "createdAt"\]\)/.test(schema),
  "sources must expose a session/createdAt index for bounded bridge state reads",
);
assert(
  /\.index\("by_source_created", \["sourceId", "createdAt"\]\)/.test(schema),
  "ingestJobs and sourceAttributions must expose source/createdAt indexes for bounded bridge state reads",
);

assert(
  /cursor:\s*v\.optional\(v\.string\(\)\)/.test(listStuckSessionPages),
  "candidate query must accept a pagination cursor",
);
assert(
  /\.withIndex\("by_type_status_updatedAt", \(q\) =>[\s\S]*\.eq\("type", "session"\)[\s\S]*\.eq\("status", "active"\)[\s\S]*\.lt\("updatedAt", args\.cutoff\)/.test(listStuckSessionPages),
  "candidate query must use indexed type/status/updatedAt predicates",
);
assert(
  /\.paginate\(\{\s*cursor: args\.cursor \?\? null,\s*numItems: STUCK_SESSION_BRIDGE_SWEEP_BATCH_SIZE,\s*\}\)/.test(listStuckSessionPages),
  "candidate query must paginate by the fixed batch size",
);
assert(
  !/ctx\.db\.query\("orgs"\)\.collect\(\)/.test(listStuckSessionPages),
  "candidate query must not collect every org",
);
assert(
  !/\.withIndex\("by_org_type"[\s\S]*\.collect\(\)/.test(listStuckSessionPages),
  "candidate query must not collect all session pages per org",
);
assert(
  !/\.filter\(\(q\)/.test(listStuckSessionPages),
  "candidate query must not use Convex query filters after scanning",
);
assert(
  /return \{\s*candidates,[\s\S]*continueCursor: page\.isDone \? null : page\.continueCursor,[\s\S]*isDone: page\.isDone,[\s\S]*scannedCount: page\.page\.length,[\s\S]*\};/.test(listStuckSessionPages),
  "candidate query must return cursor and scan accounting",
);

assert(
  /\.query\("sources"\)[\s\S]*\.withIndex\("by_session_created", \(q\) =>[\s\S]*\.eq\("sessionId", args\.sessionId\)[\s\S]*\.order\("desc"\)[\s\S]*\.take\(SESSION_BRIDGE_STATE_SOURCE_LIMIT\)/.test(getSessionBridgeState),
  "bridge state must read a bounded newest-first source set",
);
assert(
  /\.query\("ingestJobs"\)[\s\S]*\.withIndex\("by_source_created", \(q\) =>[\s\S]*\.eq\("sourceId", source\._id\)[\s\S]*\.order\("desc"\)[\s\S]*\.take\(SESSION_BRIDGE_STATE_JOB_LIMIT\)/.test(getSessionBridgeState),
  "bridge state must read bounded newest-first jobs per source",
);
assert(
  /\.query\("sourceAttributions"\)[\s\S]*\.withIndex\("by_source_created", \(q\) =>[\s\S]*\.eq\("sourceId", source\._id\)[\s\S]*\.order\("desc"\)[\s\S]*\.take\(SESSION_BRIDGE_STATE_ATTRIBUTION_LIMIT\)/.test(getSessionBridgeState),
  "bridge state must read bounded newest-first attributions per source",
);
assert(
  !/\.collect\(\)/.test(getSessionBridgeState),
  "bridge state must not collect unbounded source, job, or attribution histories",
);

assert(
  /cursor:\s*v\.optional\(v\.string\(\)\)/.test(sweepStuckSessionBridges),
  "sweep action must accept a continuation cursor",
);
assert(
  /cutoff:\s*v\.optional\(v\.number\(\)\)/.test(sweepStuckSessionBridges),
  "sweep action must accept the original cutoff for cursor continuations",
);
assert(
  /const cutoff = args\.cutoff \?\? now - SESSION_BRIDGE_STUCK_MS;/.test(
    sweepStuckSessionBridges,
  ),
  "sweep action must reuse the original cutoff for continuation pages",
);
assert(
  /const cursor = args\.cutoff === undefined \? undefined : args\.cursor;/.test(
    sweepStuckSessionBridges,
  ),
  "legacy cursor-only continuations must restart instead of reusing a cursor against a new query range",
);
assert(
  /const stuckSessionPageResult = await ctx\.runQuery\(listStuckSessionPagesRef, \{[\s\S]*cutoff,[\s\S]*cursor,[\s\S]*\}\);/.test(sweepStuckSessionBridges),
  "sweep action must pass the stable cutoff and matching cursor into the candidate query",
);
assert(
  /for \(const sessionPage of stuckSessionPageResult\.candidates\)/.test(sweepStuckSessionBridges),
  "sweep action must only process the bounded candidate batch",
);
assert(
  /const scheduledContinuation =[\s\S]*!stuckSessionPageResult\.isDone[\s\S]*stuckSessionPageResult\.continueCursor !== null/.test(sweepStuckSessionBridges),
  "sweep action must detect continuation from the paginated result",
);
assert(
  /ctx\.scheduler\.runAfter\(0, sweepStuckSessionBridgesRef, \{[\s\S]*cursor: stuckSessionPageResult\.continueCursor,[\s\S]*\}\)/.test(sweepStuckSessionBridges),
  "sweep action must self-schedule continuation work",
);
assert(
  /ctx\.scheduler\.runAfter\(0, sweepStuckSessionBridgesRef, \{[\s\S]*cursor: stuckSessionPageResult\.continueCursor,[\s\S]*cutoff,[\s\S]*\}\)/.test(sweepStuckSessionBridges),
  "sweep action must carry the original cutoff with every continuation cursor",
);
assert(
  /return \{[\s\S]*scannedCount: stuckSessionPageResult\.scannedCount,[\s\S]*candidateCount: stuckSessionPageResult\.candidates\.length,[\s\S]*processedCount,[\s\S]*scheduledContinuation,[\s\S]*continueCursor: stuckSessionPageResult\.continueCursor,[\s\S]*cutoff,[\s\S]*\};/.test(sweepStuckSessionBridges),
  "sweep action must return bounded-run accounting",
);
assert(
  /crons\.interval\(\s*"bridge-stuck-sessions",\s*\{ minutes: 10 \},\s*internal\.knowledge\.sweepStuckSessionBridges,\s*\{\},\s*\);/.test(crons),
  "bridge-stuck-sessions cron must pass an explicit empty args object",
);

console.log("Stuck session bridge batching proof passed: sweep uses indexed pagination and self-scheduled continuation.");
NODE
