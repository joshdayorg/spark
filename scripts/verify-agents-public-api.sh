#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const agents = fs.readFileSync(path.join(repoRoot, "convex", "agents.ts"), "utf8");

function fail(message) {
  console.error(`Agents public API proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const publicSection = agents.slice(agents.indexOf("// Public Agents surface"));
assert(publicSection.length > 100, "public agents section must exist");

// 1) Every public function uses the org-scoped wrappers; none accept orgId.
const publicFns = [...publicSection.matchAll(/export const (\w+) = (\w+)\(/g)];
assert(publicFns.length >= 7, `expected the full public surface (found ${publicFns.length})`);
for (const [, name, wrapper] of publicFns) {
  assert(
    wrapper === "orgQuery" || wrapper === "orgMutation",
    `${name} must use orgQuery/orgMutation (got ${wrapper})`,
  );
}
const argBlocks = [...publicSection.matchAll(/args: \{[\s\S]*?\},\n  handler/g)].map((m) => m[0]);
for (const block of argBlocks) {
  assert(!/orgId/.test(block), "public agent functions must never accept orgId from clients");
}

// 2) Reads are org-prefixed and bounded; detail/run-now org-check fetched rows.
assert(
  /withIndex\("by_org", \(q\) => q\.eq\("orgId", ctx\.orgId\)\)[\s\S]{0,40}\.take\(100\)/.test(publicSection),
  "listAgents must read through by_org with a bounded take",
);
assert(
  /withIndex\("by_agent", \(q\) => q\.eq\("agentDefinitionId", def\._id\)\)[\s\S]{0,60}\.take\(AGENT_RUNS_PAGE\)/.test(publicSection),
  "run history must be bounded",
);
const orgChecks = (publicSection.match(/def\.orgId !== ctx\.orgId/g) ?? []).length;
assert(orgChecks >= 2, "detail and run-now must org-check the fetched definition");

// 3) Mutations delegate to the internal implementations (single source of
//    lifecycle/versioning truth) with ctx.orgId injected.
for (const target of [
  "internal.agents.createAgentDefinition",
  "internal.agents.updateAgentDefinition",
  "internal.agents.setAgentStatus",
  "internal.agents.rollbackAgentDefinition",
]) {
  assert(
    new RegExp(target.replace(/\./g, "\\.") + ",? \{\n      orgId: ctx\.orgId,").test(publicSection) ||
      publicSection.includes(`${target}, {\n      orgId: ctx.orgId,`),
    `public mutations must delegate to ${target} with ctx.orgId`,
  );
}

// 4) Sensitive fields stay server-side: no anthropic ids in public payloads.
assert(
  !/anthropicAgentId|anthropicEnvironmentId/.test(publicSection),
  "public payloads must not expose Anthropic API references",
);

// 5) Run-now only for active definitions, via the scheduler (manual trigger).
assert(
  /def\.status !== "active"[\s\S]{0,120}only active agents/.test(publicSection) &&
    /trigger: "manual"/.test(publicSection),
  "runAgentNow must require active status and schedule with the manual trigger",
);

console.log(
  "Agents public API proof passed: org-wrapped surface, no client orgId, bounded org-prefixed reads, delegated mutations, no secret refs, gated run-now.",
);
NODE
