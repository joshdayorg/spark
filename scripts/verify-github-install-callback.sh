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
const http = fs.readFileSync(path.join(repoRoot, "convex", "http.ts"), "utf8");
const example = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");

function fail(message) {
  console.error(`GitHub install callback proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// 1) Install links are minted only for integration admins, carry a signed
//    short-TTL state, and never a raw orgId.
const createLink = spark.slice(
  spark.indexOf("export const createGithubInstallLink"),
  spark.indexOf("export const linkGithubInstallationFromCallback"),
);
assert(
  /requireIntegrationAdminOrgIdFromAuth\(ctx\)/.test(createLink),
  "install links must require integration admin auth",
);
assert(
  /GITHUB_INSTALL_STATE_TTL_MS = 30 \* 60 \* 1000/.test(spark) &&
    /buildGithubInstallState/.test(createLink),
  "install state must be a signed 30-minute token",
);

// 2) State verification: constant-time signature check, kind + expiry
//    enforced.
const verify = spark.slice(
  spark.indexOf("export async function verifyGithubInstallState"),
  spark.indexOf("export const createGithubInstallLink"),
);
assert(
  /constantTimeEquals\(expectedSignature, providedSignature\)/.test(verify) &&
    /payload\.kind !== "github-install"/.test(verify) &&
    /payload\.exp < Date\.now\(\)/.test(verify),
  "state verification must constant-time-compare and enforce kind + expiry",
);

// 3) Callback linking keeps the manual path's validation + cross-org
//    conflict rules.
const cbLink = spark.slice(
  spark.indexOf("export const linkGithubInstallationFromCallback"),
  spark.indexOf("export const linkGithubInstallation ="),
);
assert(
  /validateGithubInstallationId\(args\.installationId\)/.test(cbLink) &&
    /by_githubInstallationId/.test(cbLink) &&
    /already linked to another org/.test(cbLink),
  "callback linking must validate the id and reject cross-org conflicts",
);

// 4) The route verifies state BEFORE mutating, validates installation_id, and
//    handles setup_action=request without linking.
const route = http.slice(http.indexOf('path: "/github/setup"'));
assert(
  route.indexOf("verifyGithubInstallState") <
    route.indexOf("linkGithubInstallationFromCallback"),
  "the route must verify the state token before any mutation",
);
assert(
  /Number\.isInteger\(installationId\) \|\| installationId <= 0/.test(route) &&
    /setup_action/.test(route),
  "the route must validate installation_id and handle setup_action=request",
);

// 5) The env inventory documents the app slug the link builder requires.
assert(
  /GITHUB_APP_SLUG=/.test(example) && /GITHUB_APP_SLUG/.test(createLink),
  "GITHUB_APP_SLUG must be read by the link builder and documented",
);

console.log(
  "GitHub install callback proof passed: admin-minted signed state, constant-time verification, conflict-checked linking, validated callback route.",
);
NODE
