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

function fail(message) {
  console.error(`MCP protocol tool parity proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    fail(`could not find ${startMarker}`);
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? text.length : end);
}

function sorted(values) {
  return [...values].sort();
}

function sameMembers(left, right) {
  const leftSorted = sorted(left);
  const rightSorted = sorted(right);
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

const serverBlock = extractBlock(
  http,
  "function buildSparkMcpServer",
  "async function handleMcpProtocolRequest",
);
const directPostBlock = extractBlock(
  http,
  'path: "/mcp",\n  method: "POST"',
  'path: "/mcp",\n  method: "GET"',
);
const authBlock = extractBlock(http, "function buildMcpAuth", "function getMcpInput");
const classifierBlock = extractBlock(http, "function classifyMcpTool", "async function checkMcpRateLimit");

const protocolTools = [
  ...serverBlock.matchAll(/server\.registerTool\(\s*"([^"]+)"/g),
].map((match) => match[1]);
const directTools = [
  ...directPostBlock.matchAll(/case "([^"]+)":/g),
].map((match) => match[1]);
const expectedTools = ["spark_search", "spark_ask", "spark_entity", "spark_push"];

assert(
  sameMembers(protocolTools, expectedTools),
  `protocol tools must be ${expectedTools.join(", ")}; got ${protocolTools.join(", ")}`,
);
assert(
  sameMembers(protocolTools, directTools),
  `protocol tools must match direct POST switch; protocol=${protocolTools.join(", ")} direct=${directTools.join(", ")}`,
);

for (const tool of expectedTools) {
  assert(
    authBlock.includes(`"${tool}"`),
    `MCP auth scopes must include ${tool}`,
  );
  assert(
    classifierBlock.includes(`case "${tool}":`),
    `rate-limit classifier must include ${tool}`,
  );
}

assert(
  /server\.registerTool\(\s*"spark_ask"[\s\S]*inputSchema: z4\.object\(\{[\s\S]*question: mcpRequiredString[\s\S]*checkMcpRateLimit\(ctx, auth, "spark_ask"\)[\s\S]*internal\.spark\.mcpAsk[\s\S]*question,/.test(serverBlock),
  "spark_ask must be registered with question schema, ask rate limit, and mcpAsk handler",
);
assert(
  /server\.registerTool\(\s*"spark_entity"[\s\S]*inputSchema: z4\.object\(\{[\s\S]*entityId: mcpRequiredString[\s\S]*checkMcpRateLimit\(ctx, auth, "spark_entity"\)[\s\S]*internal\.spark\.mcpEntity[\s\S]*entityId,/.test(serverBlock),
  "spark_entity must be registered with entityId schema, read rate limit, and mcpEntity handler",
);
assert(
  /case "spark_entity":\s*return "read";/.test(classifierBlock) &&
    /case "spark_ask":\s*return "ask";/.test(classifierBlock),
  "spark_ask and spark_entity must keep their intended rate-limit classes",
);
assert(
  /case "spark_ask":[\s\S]*getString\(input, "question"\)[\s\S]*maybeMcpRateLimitHttpResponse\(ctx, auth, tool\)[\s\S]*internal\.spark\.mcpAsk[\s\S]*question,/.test(
    directPostBlock,
  ),
  "direct spark_ask route must keep the same validation, rate limit, and handler as the protocol tool",
);
assert(
  /case "spark_entity":[\s\S]*getString\(input, "entityId"\)[\s\S]*maybeMcpRateLimitHttpResponse\(ctx, auth, tool\)[\s\S]*internal\.spark\.mcpEntity[\s\S]*entityId,/.test(
    directPostBlock,
  ),
  "direct spark_entity route must keep the same validation, rate limit, and handler as the protocol tool",
);

console.log("MCP protocol tool parity proof passed: protocol tools match the direct POST /mcp contract.");
NODE
