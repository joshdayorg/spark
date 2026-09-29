#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const contract = fs.readFileSync(path.join(repoRoot, "convex", "mcpPushContract.ts"), "utf8");
const http = fs.readFileSync(path.join(repoRoot, "convex", "http.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`MCP push raw payload validation proof failed: ${message}`);
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

const rawValidator = extractBlock(
  contract,
  "function assertConvexCompatibleRawPayload",
  "export function validateMcpPushPayload",
);
const validateMcpPushPayload = extractBlock(
  contract,
  "export function validateMcpPushPayload",
);
const buildSparkMcpServer = extractBlock(
  http,
  "function buildSparkMcpServer",
  "async function handleMcpProtocolRequest",
);
const directPost = extractBlock(
  http,
  'path: "/mcp",\n  method: "POST"',
  'path: "/mcp",\n  method: "GET"',
);
const directPushCase = extractBlock(
  directPost,
  'case "spark_push":',
  "default:",
);
const protocolPushTool = extractBlock(
  buildSparkMcpServer,
  'server.registerTool(\n    "spark_push"',
  'server.registerTool(\n    "spark_ask"',
);
const mcpPushAction = extractBlock(
  spark,
  "export const mcpPush = internalAction",
  "async function hashTokenSha256",
);

assert(
  /function assertConvexCompatibleRawPayload\(value: unknown, path = ""\): void/.test(contract),
  "contract must define recursive raw payload validation",
);
assert(
  /Array\.isArray\(value\)[\s\S]*assertConvexCompatibleRawPayload\(item, `\$\{path\}\[\$\{index\}\]`\)/.test(rawValidator),
  "raw payload validation must recurse through arrays",
);
assert(
  /Object\.entries\(value\)[\s\S]*key === "" \|\| key\.startsWith\("\$"\) \|\| key\.startsWith\("_"\)/.test(rawValidator),
  "raw payload validation must reject empty, $-prefixed, and _-prefixed object field names",
);
assert(
  /BAD_REQUEST: spark_push[\s\S]*invalid Convex field name/.test(rawValidator),
  "invalid raw field names must be reported as BAD_REQUEST",
);
assert(
  /const childPath = path\.length > 0 \? `\$\{path\}\.\$\{key\}` : key;[\s\S]*assertConvexCompatibleRawPayload\(child, childPath\)/.test(rawValidator),
  "raw payload validation must recurse into nested object values",
);
assert(
  /assertConvexCompatibleRawPayload\(payload\);[\s\S]*const timestamp = payload\.timestamp/.test(validateMcpPushPayload),
  "validateMcpPushPayload must validate the full raw payload before semantic field reads",
);
assert(
  /validateMcpPushPayload\(input\);[\s\S]*maybeMcpRateLimitHttpResponse\(ctx, auth, tool\)/.test(directPushCase),
  "direct POST spark_push must validate raw payload before rate limiting",
);
assert(
  /try \{[\s\S]*validateMcpPushPayload\(payload\);[\s\S]*\} catch \(error\) \{[\s\S]*mcpBadRequestToolResult\("spark_push", error\)[\s\S]*checkMcpRateLimit\(ctx, auth, "spark_push"\)/.test(protocolPushTool),
  "MCP protocol spark_push must return bad_request before rate limiting invalid payloads",
);
assert(
  /const event = validateMcpPushPayload\(payload\);[\s\S]*raw: payload/.test(mcpPushAction),
  "mcpPush action must validate before storing raw payload",
);

console.log("MCP push raw payload validation proof passed: invalid Convex raw keys are rejected before rate limiting or storage.");
NODE
