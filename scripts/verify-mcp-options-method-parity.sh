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
  console.error(`MCP OPTIONS method parity proof failed: ${message}`);
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

const allowedMethodsMatch = http.match(
  /const MCP_CORS_ALLOWED_METHODS = "([^"]+)";/,
);
assert(allowedMethodsMatch, "could not find MCP_CORS_ALLOWED_METHODS");

const advertisedMethods = allowedMethodsMatch[1]
  .split(",")
  .map((method) => method.trim())
  .filter(Boolean);
const expectedMethods = ["POST", "OPTIONS"];

assert(
  advertisedMethods.length === expectedMethods.length &&
    advertisedMethods.every((method, index) => method === expectedMethods[index]),
  `preflight must advertise exactly ${expectedMethods.join(", ")}; got ${advertisedMethods.join(", ")}`,
);
assert(!advertisedMethods.includes("GET"), "preflight must not advertise unsupported GET");
assert(!advertisedMethods.includes("DELETE"), "preflight must not advertise unsupported DELETE");

const preflightBlock = extractBlock(
  http,
  "function mcpPreflightResponse",
  "type McpAuth",
);
const methodNotAllowedBlock = extractBlock(
  http,
  "function mcpMethodNotAllowedResponse",
  "function errorResponse",
);
const getRoute = extractBlock(
  http,
  'path: "/mcp",\n  method: "GET"',
  'path: "/mcp",\n  method: "DELETE"',
);
const deleteRoute = extractBlock(
  http,
  'path: "/mcp",\n  method: "DELETE"',
  "export default http",
);

assert(
  /headers\.set\("Access-Control-Allow-Methods", MCP_CORS_ALLOWED_METHODS\)/.test(preflightBlock),
  "OPTIONS preflight must use MCP_CORS_ALLOWED_METHODS",
);
assert(
  /Allow: "POST, OPTIONS"/.test(methodNotAllowedBlock),
  "405 response must advertise the same supported methods",
);
assert(
  /return withMcpCors\(mcpMethodNotAllowedResponse\(\), cors\)/.test(getRoute),
  "GET /mcp must return the shared 405 response",
);
assert(
  /return withMcpCors\(mcpMethodNotAllowedResponse\(\), cors\)/.test(deleteRoute),
  "DELETE /mcp must return the shared 405 response",
);

console.log("MCP OPTIONS method parity proof passed: preflight methods match the implemented /mcp contract.");
NODE
