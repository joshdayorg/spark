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
  console.error(`GitHub installation admin guard proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractExportedFunction(text, exportName) {
  const marker = `export const ${exportName} =`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find export ${exportName}`);
  }
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  return text.slice(start, nextExport === -1 ? text.length : nextExport);
}

function extractFunction(text, functionName) {
  const marker = `function ${functionName}`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const boundaries = [nextFunction, nextExport].filter((index) => index !== -1);
  const end = boundaries.length === 0 ? text.length : Math.min(...boundaries);
  return text.slice(start, end);
}

const linkGithubInstallation = extractExportedFunction(
  spark,
  "linkGithubInstallation",
);
const unlinkGithubInstallation = extractExportedFunction(
  spark,
  "unlinkGithubInstallation",
);
const resolver = extractExportedFunction(
  spark,
  "resolveOrgIdByGithubInstallationId",
);
const validator = extractFunction(spark, "validateGithubInstallationId");

assert(
  linkGithubInstallation.startsWith("export const linkGithubInstallation = integrationAdminMutation"),
  "linkGithubInstallation must require integration-admin authorization",
);
assert(
  unlinkGithubInstallation.startsWith("export const unlinkGithubInstallation = integrationAdminMutation"),
  "unlinkGithubInstallation must require integration-admin authorization",
);
assert(
  /Number\.isSafeInteger\(installationId\)[\s\S]*installationId <= 0/.test(
    validator,
  ) &&
    /BAD_REQUEST: GitHub installationId must be a positive integer/.test(
      validator,
    ),
  "installation id validator must reject non-positive or unsafe ids",
);
assert(
  /const installationId = validateGithubInstallationId\(args\.installationId\)/.test(
    linkGithubInstallation,
  ),
  "linkGithubInstallation must validate installation ids before linking",
);
assert(
  /\.query\("orgs"\)[\s\S]*\.withIndex\("by_githubInstallationId", \(q\) =>[\s\S]*\.eq\("githubInstallationId", installationId\)[\s\S]*\.take\(2\)/.test(
    linkGithubInstallation,
  ),
  "linkGithubInstallation must inspect existing installation links through the index",
);
assert(
  /linkedOrgs\.find\(\(org\) => org\._id !== ctx\.orgId\)/.test(
    linkGithubInstallation,
  ) &&
    /BAD_REQUEST: GitHub installation is already linked to another org/.test(
      linkGithubInstallation,
    ),
  "linkGithubInstallation must reject installation ids linked to another org",
);
assert(
  /githubInstallationId: installationId/.test(linkGithubInstallation),
  "linkGithubInstallation must patch the validated installation id",
);
assert(
  !linkGithubInstallation.startsWith("export const linkGithubInstallation = orgMutation") &&
    !unlinkGithubInstallation.startsWith("export const unlinkGithubInstallation = orgMutation"),
  "GitHub installation mutations must not use orgMutation",
);
assert(
  /\.withIndex\("by_githubInstallationId", \(q\) =>[\s\S]*\.eq\("githubInstallationId", args\.installationId\)[\s\S]*\.take\(2\)/.test(
    resolver,
  ) &&
    !/\.unique\(\)/.test(resolver) &&
    /orgs\.length > 1[\s\S]*spark:github-installation-duplicate[\s\S]*return null/.test(
      resolver,
    ),
  "resolver must not throw on duplicate legacy installation rows",
);

console.log("GitHub installation admin guard proof passed: link/unlink require admin and reject conflicting installation ids.");
NODE
