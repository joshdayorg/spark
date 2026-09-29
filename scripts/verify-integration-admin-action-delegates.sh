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

function fail(message) {
  console.error(`Integration-admin action delegate proof failed: ${message}`);
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
  const nextConst = text.indexOf("\nconst ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const candidates = [nextFunction, nextConst, nextExport].filter(
    (index) => index !== -1,
  );
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

function extractExportLine(text, exportName) {
  const marker = `export const ${exportName} =`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find export ${exportName}`);
  }
  const end = text.indexOf("\n", start);
  return text.slice(start, end === -1 ? text.length : end);
}

const adminDelegate = extractFunction(spark, "delegateForIntegrationAdminOrg");
const orgDelegate = extractFunction(spark, "delegateForOrg");
const roleClaimReader = extractFunction(spark, "getClearOrgRoleClaim");

assert(
  /const orgId = await requireIntegrationAdminOrgIdFromAuth\(ctx\);/.test(
    adminDelegate,
  ),
  "integration-admin delegate must derive org id through the admin gate",
);
assert(
  /return runDelegate\(delegate, \{ orgId, \.\.\.a \}/.test(adminDelegate),
  "integration-admin delegate must only forward orgId plus validated args",
);
assert(
  /const orgId = await getOrgIdFromAuth\(ctx\);/.test(orgDelegate),
  "regular org delegate must remain available for read-only org-scoped actions",
);
assert(
  /\["o", "rol"\]/.test(roleClaimReader),
  "integration-admin auth must accept Clerk's compact active-org role claim",
);
assert(
  /compact Clerk organization role claim allows/.test(spark) &&
    /identity\(\{ o: \{ id: clerkOrgId, rol: "admin" \} \}\)/.test(spark) &&
    /compact Clerk non-admin role claim denies/.test(spark) &&
    /identity\(\{ o: \{ id: clerkOrgId, rol: "member" \} \}\)/.test(spark),
  "debug auth proof must cover compact Clerk organization role claims",
);

// After the loose* burn-down, delegates use typed makeFunctionReference refs
// (composio:<name>) with the typed delegate factories.
const integrationMutatingDelegates = {
  disconnectToolkit: "disconnectToolkitForOrgRef",
  syncWatchedSlackChannels: "syncWatchedSlackChannelsForOrgRef",
  syncWatchedAsanaProjects: "syncWatchedAsanaProjectsForOrgRef",
};

for (const [exportName, refName] of Object.entries(
  integrationMutatingDelegates,
)) {
  const line = extractExportLine(spark, exportName);
  assert(
    /= delegateForIntegrationAdminOrg\(/.test(line),
    `${exportName} must use the integration-admin delegate`,
  );
  assert(
    line.includes(refName),
    `${exportName} must delegate to ${refName}`,
  );
  assert(
    !/= delegateForOrg\(/.test(line),
    `${exportName} must not use the org-member delegate`,
  );
}

for (const exportName of [
  "listConnectedToolkits",
  "listWatchedAsanaProjects",
  "listAvailableAsanaProjects",
  "listAvailableSlackChannels",
  "listWatchedSlackChannels",
]) {
  const line = extractExportLine(spark, exportName);
  assert(
    /= delegateForOrg\(/.test(line),
    `${exportName} should remain read-only org-scoped unless policy changes`,
  );
}

assert(
  /createComposioConnectLink[\s\S]*requireIntegrationAdminOrgIdFromAuth\(ctx\)/.test(
    spark,
  ),
  "createComposioConnectLink must keep its integration-admin gate",
);
assert(
  /export const linkGithubInstallation = integrationAdminMutation/.test(spark) &&
    /export const unlinkGithubInstallation = integrationAdminMutation/.test(spark),
  "GitHub installation mutators must keep integration-admin mutations",
);

console.log(
  "Integration-admin action delegate proof passed: mutating integration actions require admin auth before delegating.",
);
NODE
