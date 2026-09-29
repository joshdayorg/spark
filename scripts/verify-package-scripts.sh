#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const packagePath = path.join(repoRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

function fail(message) {
  console.error(`Package scripts proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

const expectedScripts = {
  test: "bash scripts/verify-all.sh",
  typecheck: "convex codegen --typecheck enable",
  codegen: "convex codegen --typecheck disable",
};

assert(pkg.scripts && typeof pkg.scripts === "object", "package.json must define a scripts object");

for (const [name, command] of Object.entries(expectedScripts)) {
  assert(
    pkg.scripts[name] === command,
    `script ${JSON.stringify(name)} must be ${JSON.stringify(command)}`,
  );
}

assert(
  Boolean(pkg.devDependencies?.typescript),
  "typescript must remain declared while the typecheck script is exposed",
);
assert(
  fs.existsSync(path.join(repoRoot, "convex", "tsconfig.json")),
  "convex/tsconfig.json must exist so the typecheck script runs a real Convex TypeScript gate",
);

console.log("Package scripts proof passed: npm exposes test, typecheck, and codegen validation commands.");
NODE
