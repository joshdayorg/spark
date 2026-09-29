#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");
const playground = fs.readFileSync(path.join(repoRoot, "convex", "playground.ts"), "utf8");

function fail(message) {
  console.error(`Entity merge identity policy proof failed: ${message}`);
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

const findTeamMemberForAlias = extractBlock(
  spark,
  "async function findTeamMemberForAlias",
  "async function resolveEntityForAlias",
);
const resolveEntityForAlias = extractBlock(
  spark,
  "async function resolveEntityForAlias",
  "function buildAliasFields",
);
const resolveProjectForAlias = extractBlock(
  spark,
  "async function resolveProjectForAlias",
  "export const linkEntityAlias",
);
const resolveEntityForActor = extractBlock(
  spark,
  "export const resolveEntityForActor = internalAction",
  "export const markEventActorIdentityResolved",
);
const sessionActorLink = extractBlock(
  knowledge,
  "async function resolveSessionActorEntityForExtraction",
  "export const applyKnowledgeExtractions",
);
const dryRunMerges = extractBlock(
  playground,
  "export const dryRunEntityMergesForOrg = internalQuery",
  "export const dryRunEntityMergesForAllOrgs",
);
const mergeEntities = extractBlock(
  playground,
  "async function mergeEntitiesImpl",
  "// Internal (CLI / scripted admin)",
);

assert(
  /\.withIndex\("by_org_email", \(q\) =>[\s\S]*\.eq\("orgId", orgId\)\.eq\("email", email\)/.test(findTeamMemberForAlias),
  "team member alias resolution must merge exact emails",
);
assert(
  /if \(source !== "github"\) return null;/.test(findTeamMemberForAlias) &&
    /\.withIndex\("by_org_github", \(q\) =>[\s\S]*\.eq\("githubLogin", gid\)/.test(findTeamMemberForAlias),
  "no-email source-specific team member merge must be GitHub login only",
);
assert(
  /\.query\("identityCache"\)[\s\S]*\.withIndex\("by_org_email"/.test(resolveEntityForAlias),
  "alias resolution must reuse existing linked email aliases before creating entities",
);
assert(
  !/by_org_kind_displayName/.test(resolveEntityForAlias),
  "person alias resolution must not automatically merge by display name",
);
assert(
  /displayName: fields\.name \?\? `\$\{source\}:\$\{gid\}`/.test(resolveEntityForAlias),
  "unmatched aliases must create a distinct entity instead of weak-name merging",
);
assert(
  /\.withIndex\("by_org_kind_displayName"/.test(resolveProjectForAlias),
  "display-name auto-merge should remain limited to project aliases",
);
assert(
  /if \(args\.source === "github" && !known\.name\)[\s\S]*known\.name = args\.gid/.test(resolveEntityForActor),
  "GitHub actors without email must fall back to login display, then rely on alias/team-member mapping",
);
assert(
  /if \(!session\?\.actorEntityId\)/.test(sessionActorLink) &&
    /\.withIndex\("by_entity", \(q\) => q\.eq\("entityId", session\.actorEntityId\)\)/.test(sessionActorLink),
  "knowledge extraction must prefer the canonical session actor entity when linking actor pages",
);
assert(
  /same_kind_and_normalized_name/.test(dryRunMerges) &&
    /similar_person_or_bot_name/.test(dryRunMerges) &&
    /"review"/.test(dryRunMerges),
  "name-based duplicate detection must surface review candidates instead of auto-merging",
);
for (const [table, field] of [
  ["identityCache", "entityId"],
  ["knowledgePages", "entityId"],
  ["knowledgePages", "actorEntityId"],
  ["events", "actorEntityId"],
  ["sessions", "actorEntityId"],
]) {
  assert(
    new RegExp(`\\.query\\("${table}"\\)[\\s\\S]*\\{ ${field}: survivorId \\}`).test(mergeEntities),
    `mergeEntities must repoint ${table}.${field} to the survivor`,
  );
}
assert(
  /if \(!truncated\) \{[\s\S]*await ctx\.db\.delete\(loserId\)/.test(mergeEntities),
  "mergeEntities must delete the loser only after all references are drained",
);

console.log("Entity merge identity policy proof passed: automatic merges stay high-confidence and repair merges repoint all canonical references.");
NODE
