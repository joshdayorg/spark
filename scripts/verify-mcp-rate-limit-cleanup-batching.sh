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
const schema = fs.readFileSync(path.join(repoRoot, "convex", "schema.ts"), "utf8");
const crons = fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8");

function fail(message) {
  console.error(`MCP rate-limit cleanup batching proof failed: ${message}`);
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

const revokeApiKey = extractExportedFunction(spark, "revokeApiKey");
const deleteForApiKey = extractExportedFunction(
  spark,
  "deleteMcpRateLimitRowsForApiKey",
);
const deleteOldForOrg = extractExportedFunction(
  spark,
  "deleteOldMcpRateLimitRowsForOrg",
);
const cleanupAction = extractExportedFunction(spark, "cleanupMcpRateLimitRows");
const mcpRateLimitsSchema = schema.slice(
  schema.indexOf("mcpRateLimits: defineTable"),
  schema.indexOf("threadOrgs: defineTable"),
);

assert(
  /const MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE = 100;/.test(spark),
  "cleanup batch size must be explicit and bounded",
);
assert(
  /const MCP_RATE_LIMIT_RETENTION_MS = 24 \* 60 \* 60 \* 1000;/.test(spark),
  "retention window must be explicit",
);
assert(
  /\.index\("by_apiKey", \["apiKeyId"\]\)/.test(mcpRateLimitsSchema) &&
    /\.index\("by_org_updated", \["orgId", "updatedAt"\]\)/.test(
      mcpRateLimitsSchema,
    ),
  "mcpRateLimits must expose cleanup indexes for key and org retention paths",
);
assert(
  /ctx\.scheduler\.runAfter\([\s\S]*internal\.spark\.deleteMcpRateLimitRowsForApiKey[\s\S]*apiKeyId: args\.apiKeyId/.test(
    revokeApiKey,
  ),
  "revokeApiKey must schedule bounded cleanup for the revoked key",
);
assert(
  /\.query\("mcpRateLimits"\)[\s\S]*\.withIndex\("by_apiKey", \(q: any\) => q\.eq\("apiKeyId", args\.apiKeyId\)\)[\s\S]*\.take\(MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE\)/.test(
    deleteForApiKey,
  ),
  "API-key cleanup must use by_apiKey with a bounded take",
);
assert(
  !/\.collect\(\)/.test(deleteForApiKey),
  "API-key cleanup must not collect all rate-limit rows",
);
assert(
  /rows\.length === MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE[\s\S]*ctx\.scheduler\.runAfter\([\s\S]*internal\.spark\.deleteMcpRateLimitRowsForApiKey/.test(
    deleteForApiKey,
  ),
  "API-key cleanup must self-schedule continuation when a full batch is deleted",
);
assert(
  /\.query\("mcpRateLimits"\)[\s\S]*\.withIndex\("by_org_updated", \(q: any\) =>[\s\S]*\.eq\("orgId", args\.orgId\)\.lt\("updatedAt", args\.olderThan\)[\s\S]*\.take\(MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE\)/.test(
    deleteOldForOrg,
  ),
  "retention cleanup must use by_org_updated with an older-than bound and a fixed take",
);
assert(
  !/\.collect\(\)/.test(deleteOldForOrg),
  "retention cleanup must not collect all old rate-limit rows for an org",
);
assert(
  /rows\.length === MCP_RATE_LIMIT_CLEANUP_BATCH_SIZE[\s\S]*ctx\.scheduler\.runAfter\([\s\S]*internal\.spark\.deleteOldMcpRateLimitRowsForOrg/.test(
    deleteOldForOrg,
  ),
  "retention cleanup must self-schedule continuation when a full batch is deleted",
);
assert(
  /const olderThan = now - MCP_RATE_LIMIT_RETENTION_MS/.test(cleanupAction) &&
    /forEachOrgIdPage\(ctx, async \(orgId\) =>/.test(cleanupAction) &&
    /internal\.spark\.deleteOldMcpRateLimitRowsForOrg/.test(cleanupAction),
  "retention action must fan out bounded old-bucket cleanup across orgs",
);
assert(
  /"mcp-rate-limit-retention"[\s\S]*\{ minutes: 60 \}[\s\S]*internal\.spark\.cleanupMcpRateLimitRows/.test(
    crons,
  ),
  "cron registry must schedule MCP rate-limit retention cleanup",
);

console.log(
  "MCP rate-limit cleanup batching proof passed: revocation and retention cleanup use bounded self-scheduling batches.",
);
NODE
