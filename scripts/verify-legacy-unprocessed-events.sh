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
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const debug = fs.readFileSync(path.join(repoRoot, "convex", "debug.ts"), "utf8");

function fail(message) {
  console.error(`Legacy unprocessed events proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractObjectBlocks(text, callText) {
  const blocks = [];
  let cursor = 0;
  while (true) {
    const callIndex = text.indexOf(callText, cursor);
    if (callIndex === -1) {
      break;
    }
    const start = text.indexOf("{", callIndex);
    if (start === -1) {
      fail(`could not find object literal for ${callText}`);
    }

    let depth = 0;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    if (end === -1) {
      fail(`could not parse object literal for ${callText}`);
    }
    blocks.push(text.slice(start, end));
    cursor = end;
  }
  return blocks;
}

assert(
  /processed:\s*v\.optional\(v\.boolean\(\)\).*undefined is unprocessed/.test(schema),
  "events.processed must stay optional during the legacy migration window and document undefined as unprocessed",
);
assert(
  /\.index\("by_org_unprocessed", \["orgId", "processed", "timestamp"\]\)/.test(schema),
  "events must keep the processed index used by the extractor",
);

assert(
  /const explicitUnprocessedCandidates = await ctx\.db[\s\S]*q\.eq\("orgId", args\.orgId\)\.eq\("processed", false\)[\s\S]*\.take\(args\.limit\)/.test(spark),
  "listUnprocessedEventCandidates must check explicit processed=false rows",
);
assert(
  /const legacyUnprocessedCandidates = await ctx\.db[\s\S]*q\.eq\("orgId", args\.orgId\)\.eq\("processed", undefined\)[\s\S]*\.take\(args\.limit\)/.test(spark),
  "listUnprocessedEventCandidates must check legacy rows missing processed",
);
assert(
  /export const hasClaimableUnprocessedEvents = internalQuery/.test(spark) &&
    /hasClaimableUnprocessedEvents[\s\S]*listUnprocessedEventCandidates\(ctx/.test(spark),
  "hasClaimableUnprocessedEvents must use the shared unprocessed candidate loader",
);
assert(
  /export const claimUnprocessedEvents = internalMutation/.test(spark) &&
    /claimUnprocessedEvents[\s\S]*listUnprocessedEventCandidates\(ctx/.test(spark),
  "claimUnprocessedEvents must use the shared unprocessed candidate loader",
);
assert(
  /\.sort\(\(left, right\) => left\.timestamp - right\.timestamp\)[\s\S]*\.slice\(0, args\.limit\)/.test(spark),
  "claimUnprocessedEvents must merge both candidate sets into a bounded timestamp-ordered batch",
);
assert(
  /ctx\.db\.patch\(event\._id, \{ processed: false, claimedAt: now \}\)/.test(spark),
  "claimUnprocessedEvents must backfill processed=false when claiming a legacy row",
);
assert(
  !/ctx\.db\.patch\(event\._id, \{ claimedAt: now \}\)/.test(spark),
  "claimUnprocessedEvents must not claim rows without backfilling processed",
);

for (const [fileName, text] of [
  ["convex/spark.ts", spark],
  ["convex/debug.ts", debug],
]) {
  const eventInserts = extractObjectBlocks(text, 'insert("events"');
  for (const [index, block] of eventInserts.entries()) {
    assert(
      block.includes("processed:"),
      `${fileName} event insert #${index + 1} must explicitly write processed`,
    );
  }
}

console.log("Legacy unprocessed events proof passed: missing processed rows are discovered, claimed, and backfilled.");
NODE
