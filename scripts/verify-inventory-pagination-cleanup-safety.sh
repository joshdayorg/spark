#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const debug = fs.readFileSync(path.join(repoRoot, "convex", "debug.ts"), "utf8");

function fail(message) {
  console.error(`Inventory pagination cleanup safety proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractFunction(text, functionName) {
  const markers = [`async function ${functionName}`, `function ${functionName}`];
  const start = markers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];
  if (start === undefined) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + functionName.length);
  const nextAsyncFunction = text.indexOf("\nasync function ", start + functionName.length);
  const nextExport = text.indexOf("\nexport const ", start + functionName.length);
  const candidates = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
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

const predicate = extractFunction(debug, "isInventoryPaginationFixtureEvent");
const cleanup = extractFunction(debug, "cleanupInventoryProbeCase");
const deleteEvents = extractExportedFunction(debug, "inventoryProbeDeleteEvents");
const seedBatch = extractExportedFunction(debug, "inventoryProbeSeedEventsBatch");
const seedOrphan = extractExportedFunction(debug, "inventoryProbeSeedOrphanEvent");

assert(
  /const INVENTORY_PROBE_FIXTURE = "debug:probeInventoryPagination";/.test(debug) &&
    /const INVENTORY_PROBE_SOURCE = "debug";/.test(debug) &&
    /const INVENTORY_PROBE_ACTOR = "debug:probeInventoryPagination";/.test(debug),
  "inventory cleanup must use shared fixture identity constants",
);
assert(
  /raw\?\.fixture !== INVENTORY_PROBE_FIXTURE/.test(predicate) &&
    /raw\.caseName !== caseName/.test(predicate) &&
    /!isInventoryProbeRole\(raw\.role\)/.test(predicate),
  "fixture predicate must require fixture marker, exact caseName, and valid role",
);
assert(
  /event\.source === INVENTORY_PROBE_SOURCE/.test(predicate) &&
    /event\.via === "api"/.test(predicate) &&
    /event\.actor === INVENTORY_PROBE_ACTOR/.test(predicate) &&
    /event\.type === `inventory\.pagination\.\$\{raw\.role\}`/.test(predicate),
  "fixture predicate must require expected source/via/actor/type",
);
assert(
  /\.filter\(\(event\) => isInventoryPaginationFixtureEvent\(event, caseName\)\)/.test(
    cleanup,
  ),
  "cleanupInventoryProbeCase must select events with the shared fixture predicate",
);
assert(
  !/getInventoryProbeRecord\(event\.raw\)\?\.caseName === caseName/.test(cleanup),
  "cleanupInventoryProbeCase must not select rows by raw.caseName alone",
);
assert(
  /if \(!isInventoryPaginationFixtureEvent\(event, args\.caseName\)\) \{[\s\S]*continue;[\s\S]*await ctx\.db\.delete\(eventId\);/.test(
    deleteEvents,
  ),
  "inventoryProbeDeleteEvents must re-check the shared fixture predicate before deleting",
);
assert(
  !/getInventoryProbeRecord\(event\?\.raw\)\?\.caseName !== args\.caseName/.test(
    deleteEvents,
  ),
  "inventoryProbeDeleteEvents must not delete by raw.caseName alone",
);
assert(
  /source: INVENTORY_PROBE_SOURCE/.test(seedBatch) &&
    /actor: INVENTORY_PROBE_ACTOR/.test(seedBatch) &&
    /fixture: INVENTORY_PROBE_FIXTURE/.test(seedBatch) &&
    /type: "inventory\.pagination\.valid"/.test(seedBatch),
  "valid event seeding must write rows matching the fixture predicate",
);
assert(
  /source: INVENTORY_PROBE_SOURCE/.test(seedOrphan) &&
    /actor: INVENTORY_PROBE_ACTOR/.test(seedOrphan) &&
    /fixture: INVENTORY_PROBE_FIXTURE/.test(seedOrphan) &&
    /type: "inventory\.pagination\.orphan"/.test(seedOrphan),
  "orphan event seeding must write rows matching the fixture predicate",
);

console.log(
  "Inventory pagination cleanup safety proof passed: cleanup deletes only marked fixture events.",
);
NODE
