#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const dream = fs.readFileSync(path.join(repoRoot, "convex", "dreamCycle.ts"), "utf8");
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");
const crons = fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`Dream cycle findings proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// 1) No new tables: findings are knowledgePages written through the shared
//    idempotent upsert (D-8), in the finding-dream- namespace with dream-cycle
//    ownership enforced.
assert(
  !/defineTable/.test(dream),
  "dream cycle must not define tables — findings are knowledgePages (D-8)",
);
assert(
  /internal\.knowledge\.upsertLinterFinding/.test(dream) &&
    /sourceAgent: "dream-cycle"/.test(dream) &&
    /finding-dream-\$\{candidate\.findingType\}/.test(dream),
  "dream findings must flow through the shared upsert in the finding-dream- namespace",
);
assert(
  /requiredSlugPrefix =\s*\n?\s*sourceAgent === "dream-cycle" \? "finding-dream-" : "finding-linter-"/.test(
    knowledge,
  ) && /existing\.sourceAgent !== sourceAgent/.test(knowledge),
  "the shared upsert must enforce per-owner slug namespaces and ownership",
);

// 2) All seven finding types (U-58), severity model, and the 3-7 cap.
for (const type of [
  "contradiction",
  "strategic_gap",
  "resource_drift",
  "emerging_capability",
  "stale_decision",
  "unanswered_question",
  "blind_spot",
]) {
  assert(dream.includes(`"${type}"`), `finding type ${type} must be supported`);
}
assert(/DREAM_MAX_FINDINGS = 7/.test(dream), "findings per run must cap at 7");

// 3) Candidate validation: type, severity, title, summary, implication, and at
//    least one related slug are required; unresolvable slugs skip the finding
//    rather than fabricating provenance.
assert(
  /relatedSlugs\.length === 0/.test(dream) &&
    /spark:dreamFindingSkipped/.test(dream) &&
    /spark:dreamFindingUnresolvedSlugs/.test(dream),
  "invalid or unattributable candidates must be skipped, not written",
);

// 4) Bounded reads: context is take()-bounded, slug resolution capped, org
//    fan-out paged; no collect() anywhere in the module.
assert(!/\.collect\(\)/.test(dream), "dreamCycle must not use collect()");
assert(
  /take\(DREAM_CONTEXT_PAGE_LIMIT\)/.test(dream) &&
    /slugs\.slice\(0, 10\)/.test(dream),
  "context and slug resolution must be bounded",
);

// 5) Overnight cron registered; per-org runs isolated via scheduler.
assert(
  /crons\.cron\(\n  "dream-cycle",\n  "30 3 \* \* \*",\n  internal\.dreamCycle\.dreamCycleFanOut,/.test(
    crons,
  ),
  "overnight dream-cycle cron must be registered",
);
assert(
  /scheduler\.runAfter\(0, internal\.dreamCycle\.runDreamCycleForOrg/.test(dream),
  "fan-out must isolate orgs via scheduled actions",
);

// 6) The managed-agent runner uses the real Spark Mind prompt, not the stub.
assert(
  /system: DREAM_SYSTEM_PROMPT/.test(spark) &&
    !/knowledge retrieval is a later phase/.test(spark),
  "runDreamCycle must use the Spark Mind system prompt",
);

console.log(
  "Dream cycle findings proof passed: D-8 no-new-tables, namespaced idempotent upsert, seven types, validation + skip semantics, bounded reads, overnight fan-out.",
);
NODE
