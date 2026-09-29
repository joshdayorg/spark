#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const composio = fs.readFileSync(path.join(repoRoot, "convex", "composio.ts"), "utf8");

function fail(message) {
  console.error(`Composio trigger reconciliation proof failed: ${message}`);
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

const listActiveTriggers = extractFunction(composio, "listActiveTriggers");
const reconcileTriggers = extractFunction(composio, "reconcileTriggers");

assert(
  /const COMPOSIO_TRIGGER_LIST_PAGE_SIZE = 100;/.test(composio) &&
    /const COMPOSIO_TRIGGER_LIST_MAX_PAGES = 20;/.test(composio),
  "active trigger listing must define explicit page size and safety cap",
);
assert(
  /for \(let page = 0; page < COMPOSIO_TRIGGER_LIST_MAX_PAGES; page \+= 1\)/.test(
    listActiveTriggers,
  ) &&
    /limit: COMPOSIO_TRIGGER_LIST_PAGE_SIZE/.test(listActiveTriggers) &&
    /\.\.\.\(cursor \? \{ cursor \} : \{\}\)/.test(listActiveTriggers) &&
    /getString\(res, "nextCursor"\) \?\? getString\(res, "next_cursor"\)/.test(
      listActiveTriggers,
    ),
  "listActiveTriggers must follow Composio cursor pagination",
);
assert(
  /const triggersByKey = \(triggers: ActiveTrigger\[\]\) => \{[\s\S]*new Map<string, string\[\]>\(\)[\s\S]*byKey\.set\(key, \[\.\.\.\(byKey\.get\(key\) \?\? \[\]\), t\.id\]\)/.test(
    reconcileTriggers,
  ),
  "reconcileTriggers must retain every trigger id per slug/target key",
);
assert(
  !/const existingByKey = new Map<string, string>\(\)/.test(reconcileTriggers) &&
    !/existingByKey\.set\(`\$\{slug\}::\$\{id\}`, t\.id\)/.test(
      reconcileTriggers,
    ),
  "reconcileTriggers must not collapse duplicate active triggers into one id",
);
assert(
  /async function deleteDuplicateTriggers\([\s\S]*const \[keepId, \.\.\.duplicateIds\] = \[\.\.\.triggerIds\]\.sort\(\);[\s\S]*for \(const triggerId of duplicateIds\) \{[\s\S]*await deleteTrigger\(slug, targetId, triggerId\);[\s\S]*existingByKey\.set\(key, \[keepId\]\);/.test(
    reconcileTriggers,
  ),
  "reconcileTriggers must keep one trigger and delete duplicate ids for a desired key",
);
assert(
  /const existingTriggerIds = existingByKey\.get\(key\) \?\? \[\];[\s\S]*if \(existingTriggerIds\.length > 0\) \{[\s\S]*kept \+= 1;[\s\S]*await deleteDuplicateTriggers\(key, existingTriggerIds\);[\s\S]*continue;/.test(
    reconcileTriggers,
  ),
  "desired keys with existing triggers must be kept once and deduplicated",
);
assert(
  /const refreshedTriggerIds =[\s\S]*await listActiveTriggers\(composio, active\.id, \[slug\]\)[\s\S]*if \(refreshedTriggerIds\.length > 0\) \{[\s\S]*kept \+= 1;[\s\S]*await deleteDuplicateTriggers\(key, refreshedTriggerIds\);[\s\S]*continue;/.test(
    reconcileTriggers,
  ),
  "missing desired keys must re-read before create to avoid raced duplicate creation",
);
assert(
  /const result = await composio\.triggers\.create\(orgId, slug,[\s\S]*const postCreateTriggerIds =[\s\S]*await listActiveTriggers\(composio, active\.id, \[slug\]\)[\s\S]*await deleteDuplicateTriggers\(key, postCreateTriggerIds\);/.test(
    reconcileTriggers,
  ),
  "created trigger keys must be re-read and deduplicated after create",
);
assert(
  /for \(const \[key, triggerIds\] of existingByKey\) \{[\s\S]*if \(desiredKeys\.has\(key\)\) continue;[\s\S]*for \(const triggerId of triggerIds\) \{[\s\S]*await deleteTrigger\(slug, targetId, triggerId\);/.test(
    reconcileTriggers,
  ),
  "undesired keys must delete every active trigger id, not only one",
);

console.log(
  "Composio trigger reconciliation proof passed: duplicate active triggers are collapsed and raced creates are rechecked.",
);
NODE
