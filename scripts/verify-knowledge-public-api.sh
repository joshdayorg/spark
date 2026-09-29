#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const mod = fs.readFileSync(path.join(repoRoot, "convex", "knowledgePublic.ts"), "utf8");

function fail(message) {
  console.error(`Knowledge public API proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// 1) All public functions org-wrapped; no client orgId.
const fns = [...mod.matchAll(/export const (\w+) = (\w+)\(/g)];
assert(fns.length >= 3, "expected setFindingStatus, editCompiledTruth, createPasteSource");
for (const [, name, wrapper] of fns) {
  assert(wrapper === "orgMutation", `${name} must use orgMutation (got ${wrapper})`);
}
const argBlocks = [...mod.matchAll(/args: \{[\s\S]*?\},\n  handler/g)].map((m) => m[0]);
assert(argBlocks.length >= 3, "expected args blocks");
for (const block of argBlocks) {
  assert(!/orgId/.test(block), "no public arg may accept orgId");
}

// 2) Every target row is org-checked before writing.
const orgChecks = (mod.match(/page\.orgId !== ctx\.orgId/g) ?? []).length;
assert(orgChecks >= 2, "page mutations must org-check the fetched row");

// 3) Finding lifecycle: only user-facing transitions exposed (no reopen-to-new),
//    only finding-typed pages accepted, edit versioned with the human identity.
assert(
  /v\.literal\("acknowledged"\)/.test(mod) &&
    /v\.literal\("resolved"\)/.test(mod) &&
    /v\.literal\("dismissed"\)/.test(mod) &&
    !/findingStatus: v\.union\([\s\S]{0,200}v\.literal\("new"\)/.test(mod),
  "finding transitions must exclude reopening to new",
);
assert(
  /page\.type !== "finding"/.test(mod),
  "setFindingStatus must reject non-finding pages",
);

// 4) Human edits are versioned with the user identity and bounded; the
//    Evidence Timeline is never touched by the editor.
assert(
  /changedBy: await getUserIdFromAuth\(ctx\)/.test(mod) &&
    /COMPILED_TRUTH_MAX_CHARS/.test(mod),
  "edits must be versioned as the human and size-bounded",
);
assert(
  !/evidenceTimeline:/.test(mod.slice(mod.indexOf("editCompiledTruth"))),
  "the editor must not modify the evidence timeline",
);

// 5) Paste intake flows through the real pipeline (dedup + jobs), not a
//    direct page insert.
assert(
  /internal\.knowledge\.ensureKnowledgeBase/.test(mod) &&
    /internal\.knowledge\.createSource/.test(mod) &&
    !/ctx\.db\.insert\("knowledgePages"/.test(mod),
  "paste intake must go through createSource, never direct page inserts",
);

console.log(
  "Knowledge public API proof passed: org-wrapped writes, checked rows, gated finding transitions, versioned human edits, pipeline-only intake.",
);
NODE
