#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function fail(message) {
  console.error(`OSS setup docs proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// 1) Every env var the backend reads must be documented in .env.example, and
//    .env.example must not document phantom vars. This pins docs to code.
const convexDir = path.join(repoRoot, "convex");
const readVars = new Set();
for (const file of fs.readdirSync(convexDir)) {
  if (!file.endsWith(".ts")) continue;
  const src = fs.readFileSync(path.join(convexDir, file), "utf8");
  for (const match of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
    readVars.add(match[1]);
  }
}
readVars.add("ANTHROPIC_API_KEY"); // consumed implicitly by the Anthropic SDK

const example = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
const documented = new Set(
  [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]),
);

for (const name of readVars) {
  assert(documented.has(name), `.env.example missing ${name} (read by convex/)`);
}
for (const name of documented) {
  assert(readVars.has(name), `.env.example documents ${name} which no code reads`);
}

// 2) SETUP.md exists and covers each provisioning surface + the offline
//    typecheck note (npm run typecheck needs a running backend).
const setup = fs.readFileSync(path.join(repoRoot, "SETUP.md"), "utf8");
for (const section of [
  "Convex",
  "Clerk",
  "Composio",
  "GitHub",
  "MCP server",
  "Smoke test",
  "npx tsc -p convex/tsconfig.json --noEmit",
  "webhook_subscriptions",
]) {
  assert(setup.includes(section), `SETUP.md must cover: ${section}`);
}

// 3) The README no longer carries the known drift claims.
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
assert(!/Notion/.test(readme), "README must not claim Notion is wired");
assert(
  !readme.includes("Per-org HMAC-SHA256 secrets"),
  "README must describe app-level GitHub HMAC, not the old per-org model",
);
assert(readme.includes("GITHUB_APP_WEBHOOK_SECRET"), "README must name the GitHub App secret");

// 4) Contribution + security docs exist.
assert(fs.existsSync(path.join(repoRoot, "CONTRIBUTING.md")), "CONTRIBUTING.md missing");
assert(fs.existsSync(path.join(repoRoot, "SECURITY.md")), "SECURITY.md missing");

console.log(
  "OSS setup docs proof passed: env inventory pinned to code, SETUP covers all surfaces, README drift removed, contribution/security docs present.",
);
NODE
