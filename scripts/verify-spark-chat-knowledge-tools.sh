#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const tools = fs.readFileSync(path.join(repoRoot, "convex", "sparkTools.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`Spark chat knowledge tools proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// 1) Org scoping: the shared resolver derives orgId from the agent thread and
//    every tool execute goes through it. The model never supplies orgId.
assert(
  /async function requireOrgIdForThread\(toolCtx: ToolCtx\): Promise<Id<"orgs">>/.test(tools) &&
    /internal\.search\.getOrgIdForThread/.test(tools),
  "tools must resolve orgId from the thread via getOrgIdForThread",
);
const executeCount = (tools.match(/execute: async \(toolCtx, input\)/g) ?? []).length;
const resolverCallCount = (tools.match(/await requireOrgIdForThread\(toolCtx\)/g) ?? []).length;
assert(
  executeCount >= 4 && resolverCallCount >= executeCount,
  `every tool execute must call requireOrgIdForThread (executes=${executeCount}, resolver calls=${resolverCallCount})`,
);
const inputSchemas = [...tools.matchAll(/inputSchema: z\.object\(\{[\s\S]*?\}\),/g)].map((m) => m[0]);
assert(inputSchemas.length >= 4, "expected tool input schemas");
for (const schemaBlock of inputSchemas) {
  assert(!/orgId/i.test(schemaBlock), "no tool input schema may accept orgId from the model");
}

// 2) Cross-org reads are impossible: page fetch by ID must org-check before use,
//    and slug lookups must go through the org-prefixed index.
assert(
  /byId && byId\.orgId === args\.orgId \? byId : null/.test(tools),
  "getPageDetailForOrg must org-check pages fetched by ID",
);
assert(
  /withIndex\("by_org_slug", \(q\) =>[\s\S]{0,80}q\.eq\("orgId", args\.orgId\)\.eq\("slug", args\.slug!\)/.test(tools),
  "slug lookups must use the org-prefixed by_org_slug index",
);

// 3) Bounded reads everywhere: no collect(), only indexed take() with clamped limits.
assert(!/\.collect\(\)/.test(tools), "sparkTools must not use unbounded collect()");
const takeCount = (tools.match(/\.take\(/g) ?? []).length;
assert(takeCount >= 4, "sparkTools reads must be bounded with take()");
assert(
  /function clampLimit\(/.test(tools) && /MAX_TOOL_LIMIT = 50/.test(tools),
  "tool limits must be clamped to an explicit maximum",
);
assert(
  /withIndex\("by_page_key", \(q\) => q\.eq\("pageId", page!\._id\)\)[\s\S]{0,80}\.take\(MAX_EVIDENCE_ENTRIES\)/.test(tools),
  "evidence reads must be indexed and capped",
);

// 4) Human gate on the write tool (U-29) and the write goes through the real
//    ingestion pipeline (createSource), not a direct page insert.
assert(
  /needsApproval: true,[\s\S]{0,600}addKnowledgeFromChat/.test(tools),
  "addKnowledgeItem must set needsApproval before writing",
);
assert(
  /internal\.knowledge\.ensureKnowledgeBase/.test(tools) &&
    /internal\.knowledge\.createSource/.test(tools) &&
    /sourceType: "paste"/.test(tools),
  "chat knowledge writes must flow through ensureKnowledgeBase + createSource as a paste source",
);
assert(
  !/ctx\.db\.insert\("knowledgePages"/.test(tools),
  "sparkTools must never insert knowledge pages directly",
);

// 5) The agent registers the full knowledge tool surface.
assert(
  /tools: \{[\s\S]{0,400}searchKnowledge,[\s\S]{0,400}getKnowledgeItem,[\s\S]{0,400}listKnowledgeSources,[\s\S]{0,400}summarizeKnowledge,[\s\S]{0,400}addKnowledgeItem,/.test(spark),
  "sparkChat agent must register the knowledge tool surface",
);

console.log(
  "Spark chat knowledge tools proof passed: thread-derived org scoping, bounded indexed reads, approval-gated pipeline writes, tools registered.",
);
NODE
