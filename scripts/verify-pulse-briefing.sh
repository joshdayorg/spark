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

function fail(message) {
  console.error(`Pulse briefing proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const refresh = spark.slice(
  spark.indexOf("export const refreshPulse"),
  spark.indexOf("export const sendMessage"),
);
assert(refresh.length > 0, "refreshPulse must exist");

// U-42: Pulse is a pre-prompted chat thread — same saveMessage +
// streamChatResponse path as chat, no custom generation pipeline.
assert(
  /sparkChat\.saveMessage\(ctx, \{\s*threadId: args\.threadId,\s*prompt: buildPulseBriefingPrompt/.test(
    refresh,
  ) && /internal\.spark\.streamChatResponse/.test(refresh),
  "pulse must reuse the chat generation path with a system-generated prompt",
);

// Access control: thread access asserted (org + user from auth), and only
// pulse-purpose threads accepted.
assert(
  /assertThreadAccess\(ctx, args\.threadId\)/.test(refresh) &&
    /threadOrg\.purpose !== "pulse"/.test(refresh),
  "refreshPulse must assert thread access and pulse purpose",
);

// Staleness: 30-min window, force override, lastVisitAt advanced so the next
// briefing has the correct since-boundary (spec/ux/pulse.md caching).
assert(
  /PULSE_STALE_MS = 30 \* 60 \* 1000/.test(spark) &&
    /if \(!stale && !args\.force\)/.test(refresh) &&
    /lastVisitAt: now/.test(refresh),
  "pulse must cache for 30 minutes, honor force, and advance lastVisitAt",
);

// The four-question briefing frame (U-41) is present in the prompt.
for (const q of ["WHAT changed", "WHY are", "SO WHAT", "NOW WHAT"]) {
  assert(spark.includes(q), `briefing prompt must ask: ${q}`);
}

console.log(
  "Pulse briefing proof passed: pre-prompted chat thread, access-checked, 30-min staleness with force, four-question frame.",
);
NODE
