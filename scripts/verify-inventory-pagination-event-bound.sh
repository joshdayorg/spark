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
  console.error(`Inventory pagination event bound proof failed: ${message}`);
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

const seedBatch = extractExportedFunction(debug, "inventoryProbeSeedEventsBatch");
const probe = extractExportedFunction(debug, "probeInventoryPagination");

assert(
  /const INVENTORY_PROBE_EVENT_COUNT = 10001;/.test(debug),
  "inventory pagination proof must use the fixed 10001-event boundary size",
);
assert(
  /const INVENTORY_PROBE_BATCH_SIZE = 100;/.test(debug),
  "inventory pagination seed batches must remain bounded to 100 writes",
);
assert(
  /args\.eventCount !== INVENTORY_PROBE_EVENT_COUNT/.test(probe),
  "probeInventoryPagination must reject any eventCount except the fixed proof size",
);
assert(
  probe.indexOf("args.eventCount !== INVENTORY_PROBE_EVENT_COUNT") <
    probe.indexOf("await cleanupInventoryProbeCase(ctx, args.caseName)") &&
    probe.indexOf("args.eventCount !== INVENTORY_PROBE_EVENT_COUNT") <
      probe.indexOf("const before = await ctx.runAction(inventoryRef, {})") &&
    probe.indexOf("args.eventCount !== INVENTORY_PROBE_EVENT_COUNT") <
      probe.indexOf("const org = await ctx.runMutation(inventoryProbeEnsureOrgRef"),
  "oversized eventCount must fail before cleanup, inventory scans, or fixture writes",
);
assert(
  /const validCount = args\.eventCount - 1;/.test(probe),
  "probe must keep one event past the 10000 boundary as the orphan row",
);
assert(
  /startIndex < validCount; startIndex \+= INVENTORY_PROBE_BATCH_SIZE/.test(probe) &&
    /Math\.min\(INVENTORY_PROBE_BATCH_SIZE, validCount - startIndex\)/.test(probe),
  "probe must seed fixture events through the bounded batch size",
);
assert(
  /!Number\.isInteger\(args\.count\)[\s\S]*args\.count < 1[\s\S]*args\.count > INVENTORY_PROBE_BATCH_SIZE/.test(
    seedBatch,
  ),
  "inventoryProbeSeedEventsBatch must reject non-integer, empty, or oversized batches",
);
assert(
  seedBatch.indexOf("!Number.isInteger(args.count)") <
    seedBatch.indexOf("for (let offset = 0; offset < args.count; offset++)") &&
    seedBatch.indexOf("!Number.isInteger(args.count)") <
      seedBatch.indexOf('await ctx.db.insert("events"'),
  "batch count validation must run before any event inserts",
);

console.log(
  "Inventory pagination event bound proof passed: oversized probes fail before writes and batches stay bounded.",
);
NODE
