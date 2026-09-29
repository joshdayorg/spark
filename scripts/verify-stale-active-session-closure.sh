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
const crons = fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8");

function fail(message) {
  console.error(`Stale active session closure proof failed: ${message}`);
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

const closeStaleActiveSessions = extractExportedFunction(
  spark,
  "closeStaleActiveSessions",
);

assert(
  /\.index\("by_status_startTime", \["status", "startTime"\]\)/.test(schema),
  "sessions must expose a global status/startTime index for stale active scans",
);
assert(
  /const SESSION_GAP_MS = 30 \* 60 \* 1000;/.test(spark) &&
    /const STALE_ACTIVE_SESSION_CLOSE_BATCH_SIZE = 20;/.test(spark),
  "stale session closure must use the same session gap and an explicit batch limit",
);
assert(
  /export const closeStaleActiveSessions = internalMutation/.test(closeStaleActiveSessions),
  "stale session closure must be an internal mutation",
);
assert(
  /cursor:\s*v\.optional\(v\.string\(\)\)/.test(closeStaleActiveSessions) &&
    /now:\s*v\.optional\(v\.number\(\)\)/.test(closeStaleActiveSessions),
  "stale session closure must accept continuation cursor and deterministic now",
);
assert(
  /const staleBefore = now - SESSION_GAP_MS;/.test(closeStaleActiveSessions),
  "stale cutoff must be derived from SESSION_GAP_MS",
);
assert(
  /\.query\("sessions"\)[\s\S]*\.withIndex\("by_status_startTime", \(q\) =>[\s\S]*\.eq\("status", "active"\)\.lt\("startTime", staleBefore\)[\s\S]*\.paginate\(\{[\s\S]*cursor: args\.cursor \?\? null,[\s\S]*numItems: STALE_ACTIVE_SESSION_CLOSE_BATCH_SIZE/.test(closeStaleActiveSessions),
  "stale session closure must page active sessions through the status/startTime index",
);
assert(
  /const latestTimestamp = await getLatestEventTimestamp\(ctx, session\);[\s\S]*if \(latestTimestamp >= staleBefore\) \{[\s\S]*stillActiveCount \+= 1;[\s\S]*continue;[\s\S]*\}/.test(closeStaleActiveSessions),
  "stale session closure must recheck the latest event timestamp before closing",
);
assert(
  /ctx\.db\.patch\(session\._id, \{[\s\S]*status: "complete",[\s\S]*endTime: latestTimestamp,[\s\S]*\}\)/.test(closeStaleActiveSessions),
  "stale session closure must mark stale sessions complete with the latest event timestamp",
);
assert(
  /\.query\("knowledgePages"\)[\s\S]*\.withIndex\("by_org_sessionId", \(q\) =>[\s\S]*\.eq\("orgId", session\.orgId\)\.eq\("sessionId", session\._id\)/.test(closeStaleActiveSessions),
  "stale session closure must update the matching session page through the direct session index",
);
assert(
  /sessionEndTime: latestTimestamp,[\s\S]*lastConfirmed: latestTimestamp,[\s\S]*updatedAt: now/.test(closeStaleActiveSessions) &&
    /changeReason: "Closed stale active session"/.test(closeStaleActiveSessions) &&
    /insertPageVersion\(ctx/.test(closeStaleActiveSessions),
  "stale session closure must update session page metadata and write a page version",
);
assert(
  /const scheduledContinuation =[\s\S]*!sessionPage\.isDone[\s\S]*sessionPage\.continueCursor !== null/.test(closeStaleActiveSessions) &&
    /ctx\.scheduler\.runAfter\(0, internal\.spark\.closeStaleActiveSessions, \{[\s\S]*cursor: sessionPage\.continueCursor,[\s\S]*now,[\s\S]*\}\)/.test(closeStaleActiveSessions),
  "stale session closure must self-schedule continuation work",
);
assert(
  /crons\.interval\(\s*"close-stale-active-sessions",\s*\{ minutes: 5 \},\s*internal\.spark\.closeStaleActiveSessions,\s*\{\},\s*\);/.test(crons),
  "close-stale-active-sessions cron must run every 5 minutes with explicit empty args",
);

console.log("Stale active session closure proof passed: active sessions age out without waiting for a later event.");
NODE
