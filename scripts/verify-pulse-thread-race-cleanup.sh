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
  console.error(`Pulse thread race cleanup proof failed: ${message}`);
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

const createThreadForUser = sliceBetween(
  spark,
  "export const createThreadForUser = action({",
  "\n});\n\nexport const createComposioConnectLink",
  "createThreadForUser",
);
const insertThreadOrg = sliceBetween(
  spark,
  "export const insertThreadOrg = internalMutation({",
  "\n});\n\nexport const getPulseThread",
  "insertThreadOrg",
);

assert(
  insertThreadOrg.includes('args.purpose === "pulse"') &&
    insertThreadOrg.includes("existingPulseThread") &&
    insertThreadOrg.includes("reused: true"),
  "pulse mapping mutation must still reuse an existing org/user/purpose mapping",
);
assert(
  createThreadForUser.includes("const existingThread = await ctx.runQuery(internal.spark.getPulseThread") &&
    createThreadForUser.includes("return { threadId: existingThread.threadId, reused: true };"),
  "pulse requests must keep the fast path that returns an existing mapping before creating a thread",
);
assert(
  createThreadForUser.includes("const { thread } = await sparkChat.createThread(ctx, { userId });") &&
    createThreadForUser.includes("const createdThreadId = thread.threadId") &&
    createThreadForUser.includes("threadId: createdThreadId"),
  "created component thread id must be captured and used for the mapping insertion attempt",
);
assert(
  createThreadForUser.includes("if (mapping.reused && mapping.threadId !== createdThreadId)") &&
    createThreadForUser.includes("await sparkChat.deleteThreadAsync(ctx, { threadId: createdThreadId });"),
  "losing pulse creation must delete the discarded component thread when the mapping was reused",
);
assertBefore(
  createThreadForUser,
  "await sparkChat.deleteThreadAsync(ctx, { threadId: createdThreadId });",
  "return { threadId: mapping.threadId, reused: mapping.reused };",
  "discarded thread cleanup must run before returning the reused mapping",
);
assertBefore(
  createThreadForUser,
  "const createdThreadId = thread.threadId",
  "await sparkChat.deleteThreadAsync(ctx, { threadId: createdThreadId });",
  "cleanup must target the newly created component thread, not the reused mapping thread",
);

console.log("Pulse thread race cleanup proof passed: losing pulse thread creations delete discarded component threads.");
NODE
