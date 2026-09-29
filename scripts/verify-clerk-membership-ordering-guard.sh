#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const http = fs.readFileSync(path.join(repoRoot, "convex", "http.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const schema = fs.readFileSync(path.join(repoRoot, "convex", "schema.ts"), "utf8");

function fail(message) {
  console.error(`Clerk membership ordering proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractBlock(text, startMarker, endMarker = null) {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    fail(`could not find ${startMarker}`);
  }
  if (endMarker === null) {
    return text.slice(start);
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? text.length : end);
}

const membershipCases = extractBlock(
  http,
  'case "organizationMembership.created":',
  'case "user.updated":',
);
const teamMembersSchema = extractBlock(
  schema,
  "teamMembers: defineTable",
  "clerkMembershipSyncStates: defineTable",
);
const syncStateSchema = extractBlock(
  schema,
  "clerkMembershipSyncStates: defineTable",
  "// apiKeys",
);
const upsertTeamMember = extractBlock(
  spark,
  "export const upsertTeamMember = internalMutation",
  "export const deleteTeamMember = internalMutation",
);
const deleteTeamMember = extractBlock(
  spark,
  "export const deleteTeamMember = internalMutation",
  "export const debugIntegrationAdminAuthProof",
);

assert(
  /clerkMembershipId: event\.data\.id/.test(membershipCases),
  "membership created/updated and deleted route cases must forward Clerk membership id",
);
assert(
  /clerkEventTimestamp: event\.data\.updated_at/.test(membershipCases),
  "membership route cases must forward Clerk membership updated_at timestamp",
);
assert(
  /clerkMembershipId: v\.optional\(v\.string\(\)\)/.test(teamMembersSchema) &&
    /clerkMembershipUpdatedAt: v\.optional\(v\.number\(\)\)/.test(teamMembersSchema),
  "active team member rows must record Clerk membership sync metadata",
);
assert(
  /clerkMembershipSyncStates: defineTable\(\{[\s\S]*orgId: v\.id\("orgs"\)[\s\S]*clerkOrgId: v\.string\(\)[\s\S]*clerkUserId: v\.string\(\)[\s\S]*clerkMembershipId: v\.string\(\)[\s\S]*status: v\.union\(v\.literal\("active"\), v\.literal\("deleted"\)\)[\s\S]*sourceUpdatedAt: v\.number\(\)/.test(syncStateSchema),
  "schema must define durable Clerk membership sync state with active/deleted status",
);
assert(
  /\.index\("by_clerkOrg_user", \["clerkOrgId", "clerkUserId"\]\)/.test(syncStateSchema),
  "sync state must be indexed by Clerk org and user",
);
for (const [name, block] of [
  ["upsertTeamMember", upsertTeamMember],
  ["deleteTeamMember", deleteTeamMember],
]) {
  assert(
    /clerkMembershipId: v\.string\(\)/.test(block) &&
      /clerkEventTimestamp: v\.number\(\)/.test(block),
    `${name} must accept membership id and source timestamp`,
  );
  assert(
    /\.query\("clerkMembershipSyncStates"\)[\s\S]*\.withIndex\("by_clerkOrg_user", \(q\) =>[\s\S]*\.eq\("clerkOrgId", args\.clerkOrgId\)\.eq\("clerkUserId", args\.clerkUserId\)/.test(block),
    `${name} must load durable sync state by indexed Clerk org/user`,
  );
}
assert(
  /syncState\.sourceUpdatedAt > args\.clerkEventTimestamp/.test(upsertTeamMember) &&
    /syncState\.status === "deleted"[\s\S]*syncState\.sourceUpdatedAt >= args\.clerkEventTimestamp/.test(upsertTeamMember),
  "upsert must ignore stale updates and same-timestamp updates after a delete tombstone",
);
assert(
  /status: "active"/.test(upsertTeamMember) &&
    /sourceUpdatedAt: args\.clerkEventTimestamp/.test(upsertTeamMember) &&
    /clerkMembershipUpdatedAt: args\.clerkEventTimestamp/.test(upsertTeamMember),
  "upsert must persist active sync state and active-row timestamp",
);
assert(
  /syncState && syncState\.sourceUpdatedAt > args\.clerkEventTimestamp/.test(deleteTeamMember),
  "delete must ignore stale delete events",
);
assert(
  /status: "deleted"/.test(deleteTeamMember) &&
    /sourceUpdatedAt: args\.clerkEventTimestamp/.test(deleteTeamMember) &&
    /ctx\.db\.insert\("clerkMembershipSyncStates"/.test(deleteTeamMember),
  "delete must persist a durable deleted tombstone",
);
assert(
  deleteTeamMember.indexOf('status: "deleted"') < deleteTeamMember.indexOf('ctx.db.delete(member._id)'),
  "delete must write tombstone state before deleting the active member row",
);

console.log("Clerk membership ordering proof passed: membership webhooks carry source ordering state and stale events cannot overwrite newer membership state.");
NODE
