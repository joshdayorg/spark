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

function fail(message) {
  console.error(`getThreadsForUser pagination proof failed: ${message}`);
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

const getThreadsForUser = extractExportedFunction(spark, "getThreadsForUser");
const threadOrgsSchema = schema.slice(
  schema.indexOf("threadOrgs: defineTable"),
  schema.indexOf("knowledgeBases: defineTable"),
);

assert(
  /paginationOptsValidator/.test(spark),
  "spark.ts must import paginationOptsValidator",
);
assert(
  /const THREADS_FOR_USER_DEFAULT_PAGE_SIZE = 25;/.test(spark) &&
    /const THREADS_FOR_USER_MAX_PAGE_SIZE = 100;/.test(spark),
  "thread list page size bounds must be explicit",
);
assert(
  /\.index\("by_org_user", \["orgId", "userId", "createdAt"\]\)/.test(
    threadOrgsSchema,
  ),
  "threadOrgs must keep the org/user/createdAt index",
);
assert(
  /paginationOpts: v\.optional\(paginationOptsValidator\)/.test(
    getThreadsForUser,
  ),
  "getThreadsForUser must accept pagination options",
);
assert(
  /const userId = await getUserIdFromAuth\(ctx\)/.test(getThreadsForUser),
  "getThreadsForUser must derive user id from auth",
);
assert(
  /Math\.trunc\([\s\S]*THREADS_FOR_USER_DEFAULT_PAGE_SIZE[\s\S]*THREADS_FOR_USER_MAX_PAGE_SIZE/.test(
    getThreadsForUser,
  ),
  "getThreadsForUser must clamp requested page size",
);
assert(
  /\.query\("threadOrgs"\)[\s\S]*\.withIndex\("by_org_user", \(q\) =>[\s\S]*\.eq\("orgId", ctx\.orgId\)\.eq\("userId", userId\)[\s\S]*\.order\("desc"\)[\s\S]*\.paginate\(\{[\s\S]*cursor: args\.paginationOpts\?\.cursor \?\? null,[\s\S]*numItems,[\s\S]*\}\)/.test(
    getThreadsForUser,
  ),
  "getThreadsForUser must use bounded descending pagination on by_org_user",
);
assert(
  !/\.collect\(\)/.test(getThreadsForUser),
  "getThreadsForUser must not collect the full thread history",
);
// The list item contract: core thread fields plus the optional display
// fields (lastVisitAt, preview from stored title / first message). The async
// map is deliberate — preview resolution reads the opening message.
assert(
  /page\.page\.map\(async \(threadOrg\) => \{[\s\S]*threadOrgId: threadOrg\._id,[\s\S]*threadId: threadOrg\.threadId,[\s\S]*purpose: threadOrg\.purpose,[\s\S]*createdAt: threadOrg\.createdAt/.test(
    getThreadsForUser,
  ),
  "getThreadsForUser must return the thread list item contract",
);
assert(
  /threadOrg\.title[\s\S]*toThreadPreview/.test(getThreadsForUser),
  "getThreadsForUser preview must prefer the stored title before first-message fallback",
);
assert(
  !/orgId: threadOrg\.orgId/.test(getThreadsForUser) &&
    !/userId: threadOrg\.userId/.test(getThreadsForUser),
  "getThreadsForUser response must not expose orgId/userId fields",
);

console.log("getThreadsForUser pagination proof passed: thread history is returned as a bounded newest-first page.");
NODE
