#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const sparkPath = path.join(repoRoot, "convex", "spark.ts");
const spark = fs.readFileSync(sparkPath, "utf8");

function fail(message) {
  console.error(`Managed agent archive cleanup proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `missing ${label} start`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing ${label} end`);
  return source.slice(start, end);
}

function assertBefore(source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert(firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex, message);
}

const cleanupManagedAgent = sliceBetween(
  spark,
  "async function cleanupManagedAgent(",
  "\n}\n\nasync function buildManagedToolsets",
  "cleanupManagedAgent",
);
const runManagedAgentSession = sliceBetween(
  spark,
  "async function runManagedAgentSession(",
  "\n}\n\nexport const runCustomerAgent",
  "runManagedAgentSession",
);

assert(
  cleanupManagedAgent.includes("client.beta.agents.archive(agentId)") &&
    cleanupManagedAgent.includes('console.warn("spark:managedAgentCleanup"') &&
    cleanupManagedAgent.includes("getErrorMessage(error)"),
  "managed agent cleanup helper must archive created agents without masking cleanup failures",
);
assert(
  runManagedAgentSession.includes("let managedAgentId: string | null = null") &&
    runManagedAgentSession.includes("let managedMcpVault: ManagedMcpVaultAttachment | null = null"),
  "managed agent and vault cleanup state must be declared before the guarded lifecycle",
);
assertBefore(
  runManagedAgentSession,
  "let managedAgentId: string | null = null",
  "try {",
  "managed agent id must be initialized before the lifecycle try/finally",
);
assertBefore(
  runManagedAgentSession,
  "try {",
  "const agent = await client.beta.agents.create({",
  "managed agent creation must happen inside the cleanup try/finally",
);
assertBefore(
  runManagedAgentSession,
  "const agent = await client.beta.agents.create({",
  "managedAgentId = agent.id;",
  "created managed agent id must be captured immediately after creation",
);
assertBefore(
  runManagedAgentSession,
  "managedAgentId = agent.id;",
  "let environmentId = org.anthropicEnvironmentId;",
  "agent cleanup tracking must cover later environment setup failures",
);
assert(
  runManagedAgentSession.includes("id: agent.id") &&
    runManagedAgentSession.includes("version: agent.version") &&
    runManagedAgentSession.includes("collectManagedSessionResult(client, session.id)") &&
    runManagedAgentSession.includes("client.beta.sessions.events.send(session.id"),
  "managed session must continue to run with the created agent",
);
assertBefore(
  runManagedAgentSession,
  "} finally {",
  "await cleanupManagedAgent(client, managedAgentId);",
  "managed agent archive cleanup must run in finally",
);
assertBefore(
  runManagedAgentSession,
  "await cleanupManagedMcpVaultAttachment(client, managedMcpVault);",
  "await cleanupManagedAgent(client, managedAgentId);",
  "temporary vault cleanup should still run before archiving the temporary agent",
);
assert(
  runManagedAgentSession.includes("if (managedAgentId)") &&
    runManagedAgentSession.includes("await cleanupManagedAgent(client, managedAgentId);"),
  "managed agent cleanup must be guarded so pre-create failures are not archived",
);

console.log("Managed agent archive cleanup proof passed: created managed agents are archived across success and post-create failure paths.");
NODE
