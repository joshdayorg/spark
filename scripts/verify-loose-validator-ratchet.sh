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
  console.error(`Loose validator ratchet proof failed: ${message}`);
  process.exit(1);
}

// Ratchet: the loose* validator family (typecheck-blind casts introduced in
// 344ea85) is being burned down to real v.* validators. These ceilings only
// go DOWN. If you add a new loose usage, replace an old one first.
const LOOSE_CEILING = 1; // one historical comment mention
const AS_ANY_CEILING = 14;

const looseCount = (spark.match(/loose/g) ?? []).length;
const asAnyCount = (spark.match(/ as any/g) ?? []).length;

if (looseCount > LOOSE_CEILING) {
  fail(`loose* usages grew: ${looseCount} > ceiling ${LOOSE_CEILING}`);
}
if (asAnyCount > AS_ANY_CEILING) {
  fail(`as-any casts grew: ${asAnyCount} > ceiling ${AS_ANY_CEILING}`);
}

// The loose helper family must stay deleted.
for (const helper of [
  "const looseId =",
  "const looseString =",
  "const looseInternalAction =",
  "const looseInternalMutation =",
  "const looseAction =",
  "const looseIntegrationAdminQuery =",
  "const looseDelegateForOrg =",
]) {
  if (spark.includes(helper)) {
    fail(`loose helper family must stay deleted: ${helper}`);
  }
}

// The surfaces converted so far must stay on real validators.
for (const converted of [
  'export const mcpSearch = internalAction',
  'export const mcpAsk = internalAction',
  'export const mcpEntity = internalAction',
  'export const runCustomerAgent = internalAction',
  'export const runDreamCycle = internalAction',
  'export const issueManagedMcpToken = internalAction',
  'export const lookupOrgByManagedMcpToken = internalAction',
  'export const lookupOrgByApiKey = internalAction',
  'export const lookupMcpApiKeyAuth = internalAction',
  'export const lookupOrgByApiKeyHash = internalMutation',
  'export const lookupMcpApiKeyAuthByHash = internalMutation',
  'export const checkMcpApiKeyRateLimit = internalMutation',
  'export const createComposioConnectLink = action',
  'export const listApiKeys = integrationAdminQuery',
  'export const createApiKey = integrationAdminMutation',
  'export const revokeApiKey = integrationAdminMutation',
  'export const listConnectedToolkits = delegateForOrg',
  'export const disconnectToolkit = delegateForIntegrationAdminOrg',
]) {
  if (!spark.includes(converted)) {
    fail(`converted surface regressed to a loose wrapper: ${converted}`);
  }
}

console.log(
  `Loose validator ratchet proof passed: loose=${looseCount}/${LOOSE_CEILING}, as-any=${asAnyCount}/${AS_ANY_CEILING}, converted surfaces intact.`,
);
NODE
