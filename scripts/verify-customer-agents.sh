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
const agents = fs.readFileSync(path.join(repoRoot, "convex", "agents.ts"), "utf8");
const crons = fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8");
const tools = fs.readFileSync(path.join(repoRoot, "convex", "sparkTools.ts"), "utf8");

function fail(message) {
  console.error(`Customer agents proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// 1) Tables per data-model Phase 3, org-scoped, with the scheduler index.
const defTable = schema.slice(
  schema.indexOf("agentDefinitions: defineTable"),
  schema.indexOf("agentRuns: defineTable"),
);
const runTable = schema.slice(
  schema.indexOf("agentRuns: defineTable"),
  schema.indexOf("// usage"),
);
assert(defTable.includes('orgId: v.id("orgs")'), "agentDefinitions must be org-scoped");
assert(
  /modelTier: v\.union\(v\.literal\("fast"\), v\.literal\("thorough"\)\)/.test(defTable),
  "agentDefinitions must use the two-tier model picker (U-37)",
);
for (const status of ["draft", "active", "paused", "errored", "archived"]) {
  assert(defTable.includes(`v.literal("${status}")`), `lifecycle must include ${status}`);
}
assert(
  defTable.includes('.index("by_status_nextRunAt", ["status", "nextRunAt"])'),
  "scheduler needs the by_status_nextRunAt index",
);
assert(runTable.includes('orgId: v.id("orgs")'), "agentRuns must be org-scoped");
assert(
  runTable.includes('.index("by_agent", ["agentDefinitionId", "startTime"])'),
  "agentRuns must keep the per-agent history index",
);

// 2) Scheduler is claim-before-run: nextRunAt advances inside the claiming
//    mutation, so overlapping ticks cannot double-run (A-12 pattern).
assert(
  /claimDueAgentDefinitions = internalMutation/.test(agents) &&
    /withIndex\("by_status_nextRunAt", \(q\) =>[\s\S]{0,80}q\.eq\("status", "active"\)\.lte\("nextRunAt", args\.now\)/.test(agents) &&
    /nextRunAt: computeNextRunAt\(def\.schedule, args\.now\)/.test(agents),
  "scheduler must claim by advancing nextRunAt atomically in the mutation",
);
assert(
  /crons\.interval\(\n  "agent-scheduler",\n  \{ minutes: 5 \},\n  internal\.agents\.agentScheduler,/.test(crons),
  "agent-scheduler cron must be registered",
);

// 3) Budget cap enforced BEFORE session creation, failing safe on truncation (U-51).
const runFn = agents.slice(agents.indexOf("export const runAgentDefinition"));
assert(
  runFn.indexOf("sumUsageForOrgSince") < runFn.indexOf("insertAgentRun") &&
    /spend\.truncated \|\| spend\.costCents >= def\.monthlyBudgetCents/.test(runFn),
  "budget must be checked before any run is created and truncation must fail safe",
);

// 4) Failure accounting: consecutive failures auto-pause to errored and
//    unschedule (ux/agents.md lifecycle).
assert(
  /CONSECUTIVE_FAILURES_TO_ERROR/.test(agents) &&
    /status: "errored" as const, nextRunAt: undefined/.test(agents),
  "consecutive failures must transition the definition to errored and unschedule it",
);

// 5) Versioned edits with bounded rollback history (U-38).
assert(
  /AGENT_VERSION_HISTORY_LIMIT/.test(agents) &&
    /rollbackAgentDefinition = internalMutation/.test(agents) &&
    /\.slice\(\s*-AGENT_VERSION_HISTORY_LIMIT,?\s*\)/.test(agents),
  "edits must version with a bounded rollback history",
);

// 6) Org checks on every definition mutation.
const orgChecks = (agents.match(/def\.orgId !== args\.orgId/g) ?? []).length;
assert(orgChecks >= 3, "definition mutations must org-check the target row");

// 7) createAgent chat tool is approval-gated (U-47 preview -> activate).
assert(
  /export const createAgent = createTool[\s\S]{0,2500}needsApproval: true,/.test(tools),
  "createAgent tool must require approval before persisting",
);

console.log(
  "Customer agents proof passed: spec tables, claim-before-run scheduler, pre-run budget gate, errored auto-pause, bounded rollback, org checks, approval-gated createAgent.",
);
NODE
