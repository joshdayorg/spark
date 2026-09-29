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
const crons = fs.readFileSync(path.join(repoRoot, "convex", "crons.ts"), "utf8");
const http = fs.readFileSync(path.join(repoRoot, "convex", "http.ts"), "utf8");
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
const audit = fs.readFileSync(path.join(repoRoot, "docs", "convex-flow-audit.md"), "utf8");

function fail(message) {
  console.error(`Convex flow inventory proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// Counts are derived from source, not hardcoded, so this proof survives
// legitimate schema/cron/route growth as long as the audit doc is regenerated.
const tables = [...schema.matchAll(/^  ([A-Za-z0-9_]+): defineTable/gm)].map((m) => m[1]);
const cronNames = [...crons.matchAll(/crons\.(?:interval|cron)\(\n  "([^"]+)"/g)].map((m) => m[1]);
const routes = [...http.matchAll(/http\.route\(\{[\s\S]*?path: "([^"]+)"[\s\S]*?method: "([^"]+)"/g)]
  .map((m) => `${m[2]} ${m[1]}`);

assert(tables.length > 0, "expected schema tables, found none (regex drift?)");
assert(cronNames.length > 0, "expected cron schedules, found none (regex drift?)");
assert(routes.length > 0, "expected HTTP route registrations, found none (regex drift?)");

for (const table of tables) {
  assert(audit.includes(`\`${table}\``), `audit inventory must mention table ${table}`);
}
for (const cron of cronNames) {
  assert(audit.includes(`\`${cron}\``), `audit inventory must mention cron ${cron}`);
}
for (const route of routes) {
  assert(audit.includes(`\`${route}\``), `audit inventory must mention route ${route}`);
}

assert(new RegExp(`Tables: ${tables.length}\\b`).test(audit), `audit document must state the current table count (${tables.length})`);
assert(new RegExp(`HTTP route registrations: ${routes.length}\\b`).test(audit), `audit document must state the current HTTP route count (${routes.length})`);
assert(new RegExp(`Cron schedules: ${cronNames.length}\\b`).test(audit), `audit document must state the current cron count (${cronNames.length})`);

// README deliberately de-counts brittle tallies (Card B resync). Keep only the
// negative guard: no stale inventory claims may return.
assert(
  !readme.includes("Nine files. This is the entire backend.") &&
    !readme.includes("15 tables") &&
    !readme.includes("7 registered operational schedules") &&
    !readme.includes("Zero `as any`"),
  "README must not contain stale backend inventory claims",
);

assert(
  /GitHub, Composio, and API push share `POST \/ingest`/.test(audit) &&
    /not by a separate `\/ingest\/webhook\/<orgId>` route/.test(audit),
  "audit document must record the actual shared ingest route",
);

console.log("Convex flow inventory proof passed: audit inventory matches schema, cron, and HTTP source; README has no stale tallies.");
NODE
