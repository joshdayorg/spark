#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const composio = fs.readFileSync(path.join(repoRoot, "convex", "composio.ts"), "utf8");

function fail(message) {
  console.error(`Asana project pagination proof failed: ${message}`);
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

const listAvailableAsanaProjects = extractExportedFunction(
  composio,
  "listAvailableAsanaProjectsForOrg",
);

assert(
  /const ASANA_PROJECT_LIST_PAGE_SIZE = 100;/.test(composio),
  "project list page size must stay at Asana's maximum page size",
);
assert(
  /const ASANA_PROJECT_LIST_MAX_PAGES_PER_WORKSPACE = 20;/.test(composio),
  "project list must have a bounded per-workspace page cap",
);
assert(
  /let offset: string \| undefined;/.test(listAvailableAsanaProjects),
  "project listing must track Asana pagination offsets per workspace",
);
assert(
  /page < ASANA_PROJECT_LIST_MAX_PAGES_PER_WORKSPACE/.test(
    listAvailableAsanaProjects,
  ),
  "project listing must loop until the page cap instead of reading one page",
);
assert(
  /ASANA_GET_MULTIPLE_PROJECTS[\s\S]*limit: ASANA_PROJECT_LIST_PAGE_SIZE[\s\S]*\.\.\.\(offset \? \{ offset \} : \{\}\)/.test(
    listAvailableAsanaProjects,
  ),
  "each follow-up ASANA_GET_MULTIPLE_PROJECTS call must pass the prior offset",
);
assert(
  /const innerData = getRecord\(nestedData\?\.data\);[\s\S]*getArray\(innerData, "data"\)[\s\S]*getArray\(nestedData, "data"\)[\s\S]*getArray\(outer, "data"\)/.test(
    listAvailableAsanaProjects,
  ),
  "project listing must tolerate Composio's nested Asana data envelopes",
);
assert(
  /getString\(getRecord\(nestedData\?\.next_page\), "offset"\)[\s\S]*getString\(getRecord\(innerData\?\.next_page\), "offset"\)[\s\S]*getString\(getRecord\(outer\.next_page\), "offset"\)/.test(
    listAvailableAsanaProjects,
  ),
  "project listing must read next_page.offset from supported response envelopes",
);
assert(
  /if \(!nextOffset\) break;[\s\S]*page \+ 1 >= ASANA_PROJECT_LIST_MAX_PAGES_PER_WORKSPACE[\s\S]*console\.warn\("spark:asana-list-projects-truncated"/.test(
    listAvailableAsanaProjects,
  ),
  "project listing must stop only when no next offset remains or warn on truncation",
);
assert(
  /projects\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\);[\s\S]*return \{ connectedAccountId: active\.id, projects \};/.test(
    listAvailableAsanaProjects,
  ),
  "project listing must preserve its existing response shape",
);

console.log(
  "Asana project pagination proof passed: available project listing follows offset pages with a bounded cap.",
);
NODE
