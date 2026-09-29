#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const debug = fs.readFileSync(path.join(repoRoot, "convex", "debug.ts"), "utf8");

function fail(message) {
  console.error(`P7 synthesis pagination cleanup safety proof failed: ${message}`);
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
  const nextAsyncFunction = text.indexOf("\nasync function ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const candidates = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

const cleanupRef = debug.slice(
  debug.indexOf("const p7CleanupSynthesisPaginationFixtureBatchRef"),
  debug.indexOf("const p7SeedSynthesisPaginationOrgsBatchRef"),
);
const fixtureValidator = extractFunction(
  debug,
  "assertP7SynthesisPaginationFixture",
);
const prefixHelper = extractFunction(debug, "getP7SynthesisPaginationPrefix");
const ordinalHelper = extractFunction(debug, "getP7SynthesisPaginationOrdinal");
const cleanup = extractExportedFunction(
  debug,
  "p7CleanupSynthesisPaginationFixtureBatch",
);
const paginationProbe = extractExportedFunction(
  debug,
  "p7ProbeSynthesisOrgPagination",
);

assert(
  /\{ fixture: string; batchSize: number \}/.test(cleanupRef),
  "cleanup function reference must accept fixture, not raw prefix",
);
assert(
  /fixture: v\.string\(\)/.test(cleanup) && !/prefix: v\.string\(\)/.test(cleanup),
  "cleanup mutation args must accept fixture and not a raw prefix",
);
assert(
  /const prefix = getP7SynthesisPaginationPrefix\(args\.fixture\);/.test(cleanup),
  "cleanup mutation must derive the prefix from the fixture",
);
assert(
  !/args\.prefix/.test(cleanup),
  "cleanup mutation must not read a caller-supplied prefix",
);
assert(
  /\^\[a-z0-9\]\[a-z0-9-\]\{0,80\}\$/.test(fixtureValidator),
  "fixture token validator must reject empty and non-fixture-like tokens",
);
assert(
  /assertP7SynthesisPaginationFixture\(fixture\);/.test(prefixHelper) &&
    /P7_SYNTHESIS_PAGINATION_CLERK_PREFIX/.test(prefixHelper),
  "prefix helper must validate the fixture and use the fixed Part 7 prefix",
);
assert(
  /clerkOrgId\.startsWith\(prefix\)/.test(ordinalHelper) &&
    /\^\[0-9\]\{4\}\$/.test(ordinalHelper) &&
    /P7_SYNTHESIS_PAGINATION_ORG_COUNT/.test(ordinalHelper),
  "ordinal helper must accept only generated four-digit fixture org ids",
);
assert(
  /const unsafeOrg = orgs\.find\([\s\S]*getP7SynthesisPaginationOrdinal\(prefix, org\.clerkOrgId\) === null[\s\S]*\);[\s\S]*if \(unsafeOrg\) \{[\s\S]*throw new Error/.test(
    cleanup,
  ),
  "cleanup mutation must throw before deleting a matched non-fixture org",
);
assert(
  cleanup.indexOf("const unsafeOrg = orgs.find") <
    cleanup.indexOf("await ctx.db.delete(org._id)"),
  "unsafe org assertion must run before deleting org rows",
);
assert(
  /p7CleanupSynthesisPaginationFixtureBatchRef,[\s\S]*fixture: args\.fixture,[\s\S]*batchSize: P7_SYNTHESIS_PAGINATION_BATCH_SIZE/.test(
    paginationProbe,
  ),
  "pagination probe must call cleanup with fixture instead of raw prefix",
);

console.log(
  "P7 synthesis pagination cleanup safety proof passed: destructive cleanup derives and validates fixture prefixes.",
);
NODE
