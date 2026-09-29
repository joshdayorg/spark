#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const ingest = fs.readFileSync(path.join(repoRoot, "convex", "ingest.ts"), "utf8");
const composio = fs.readFileSync(path.join(repoRoot, "convex", "composio.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");
const playground = fs.readFileSync(path.join(repoRoot, "convex", "playground.ts"), "utf8");

function fail(message) {
  console.error(`Asana attribution semantics proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function extractBlock(text, startMarker, endMarker = null) {
  const start = text.indexOf(startMarker);
  if (start === -1) fail(`could not find ${startMarker}`);
  if (endMarker === null) return text.slice(start);
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? text.length : end);
}

const asanaSummary = extractBlock(
  ingest,
  "function asanaSummary",
  "const ASANA_TASK_DETAIL_OPT_FIELDS",
);
const asanaAdapter = extractBlock(
  ingest,
  "const asanaAdapter: ComposioAdapter",
  "// Slack `ts` looks like",
);
const normalizeAndInsert = extractBlock(
  ingest,
  "export const normalizeAndInsert = internalAction",
  "// Resolve a batch of opaque source ids",
);
assert(
  /const ASANA_TASK_DETAIL_OPT_FIELDS = \[[\s\S]*"created_by\.gid"[\s\S]*"created_by\.name"[\s\S]*"assignee\.gid"[\s\S]*"assignee\.name"[\s\S]*\]/.test(ingest),
  "live Asana task fetch must request created_by and assignee metadata",
);
assert(
  /function resolveAsanaTaskDetails/.test(ingest) &&
    /fetchComposioResource\([\s\S]*\{ opt_fields: ASANA_TASK_DETAIL_OPT_FIELDS \}/.test(ingest),
  "live Asana task details must be fetched through Composio with opt_fields",
);
assert(
  /case "ASANA_TASK_CREATED":[\s\S]*ctx\.createdByName[\s\S]*Task \$\{task\}[\s\S]*was created/.test(asanaSummary),
  "task-created summaries must prefer task.created_by and fall back to neutral wording",
);
assert(
  !/case "ASANA_TASK_CREATED":[\s\S]*return `\$\{who\} created/.test(asanaSummary),
  "task-created summaries must not blindly say user_gid created the task",
);
assert(
  /actorSource = "task_created_by"/.test(asanaAdapter) &&
    /actorSource = "neutral_missing_task_created_by"/.test(asanaAdapter),
  "live Asana created events must record whether attribution came from task.created_by or neutral fallback",
);
assert(
  /case "ASANA_TASK_UPDATED":[\s\S]*\$\{field\} changed on \$\{task\}/.test(asanaSummary) &&
    !/case "ASANA_TASK_UPDATED":[\s\S]*\$\{who\} updated/.test(asanaSummary),
  "live Asana update summaries must be neutral when trigger user is not a verified updater",
);
assert(
  /case "ASANA_TASK_MOVED_TO_SECTION":[\s\S]*moved to a section/.test(asanaSummary) &&
    !/case "ASANA_TASK_MOVED_TO_SECTION":[\s\S]*\$\{who\} moved/.test(asanaSummary),
  "live Asana move summaries must be neutral when trigger user is not a verified mover",
);
assert(
  /slug === "ASANA_TASK_UPDATED"[\s\S]*slug === "ASANA_TASK_MOVED_TO_SECTION"[\s\S]*actorSource = "neutral_unverified_trigger_user"/.test(asanaAdapter),
  "live Asana updated/moved events must not store trigger user as the event actor",
);
assert(
  /spark:asana-task-created-user-mismatch/.test(asanaAdapter),
  "live Asana created events must log trigger user versus task creator mismatches",
);
assert(
  /actorRef: actorGid \? \{ source: "asana", gid: actorGid \} : undefined/.test(asanaAdapter),
  "live Asana actorRef must come from the chosen actor gid, not always trigger user_gid",
);
assert(
  /rawExtras: \{[\s\S]*taskCreator:[\s\S]*taskAssignee:[\s\S]*project:/.test(asanaAdapter) &&
    /withSparkResolvedRaw\(body, rawExtras\)/.test(normalizeAndInsert),
  "live Asana raw payloads must preserve fetched attribution details under sparkResolved",
);

// In-Convex backfills were removed 2026-08-30 (S-10 one-normalizer rule; see
// scripts/backfill/README.md). The proof now guards against their return.
assert(
  !/backfillAsanaForOrg/.test(composio) &&
    !/backfillSlackForOrg/.test(composio) &&
    !/backfillGithubForOrg/.test(composio),
  "in-Convex backfills must stay removed — backfills are standalone scripts through POST /ingest",
);
assert(
  /For Asana events, preserve actor roles exactly as written/.test(spark),
  "session extraction prompt must preserve Asana actor roles",
);
assert(
  /For Asana evidence, do not infer who created, updated, assigned, or moved/.test(knowledge),
  "knowledge extraction prompt must forbid Asana role inference",
);
assert(
  /const ASANA_REPAIR_TASK_DETAIL_OPT_FIELDS = \[[\s\S]*"created_by\.gid"[\s\S]*"completed_by\.gid"[\s\S]*"assignee\.gid"[\s\S]*\]/.test(playground),
  "Asana repair must fetch explicit created_by/completed_by metadata",
);
assert(
  /const ASANA_REPAIR_DEFAULT_MAX_PAGES = 1;/.test(playground) &&
    /fetchMissingTaskDetails = args\.fetchMissingTaskDetails \?\? false/.test(playground),
  "Asana repair must default to a fast single-page scan without slow per-event task fetches",
);
assert(
  /export const pageAsanaEventsForRepair = internalQuery/.test(playground) &&
    /\.withIndex\("by_org_source", \(q\) =>[\s\S]*\.eq\("orgId", args\.orgId\)\.eq\("source", "asana"\)/.test(playground),
  "Asana repair must page only org-scoped Asana events",
);
assert(
  /export const applyAsanaEventRepairs = internalMutation/.test(playground) &&
    /processed: false,[\s\S]*claimedAt: undefined,[\s\S]*actorEntityId: undefined,[\s\S]*actorIdentityResolvedAt: undefined/.test(playground),
  "Asana repair must reset repaired events and clear stale actor identity when attribution changes",
);
assert(
  /export const repairAsanaEventsAndRebuildKnowledgeForOrg = internalAction/.test(playground) &&
    /internal\.playground\.repairAsanaEventsForOrg[\s\S]*ctx\.scheduler\.runAfter\([\s\S]*internal\.playground\.repairAsanaEventsAndRebuildKnowledgeForOrg[\s\S]*asana-repair-continuation-scheduled[\s\S]*internal\.playground\.wipeKnowledgeForOrg[\s\S]*internal\.playground\.rebuildKnowledgeForOrg/.test(playground),
  "Asana repair/rebuild wrapper must repair events, schedule continuation when needed, then wipe and rebuild derived knowledge",
);

console.log("Asana attribution semantics proof passed: explicit roles only, neutral Asana task changes, repair/rebuild path present, in-Convex backfills stay removed.");
NODE
