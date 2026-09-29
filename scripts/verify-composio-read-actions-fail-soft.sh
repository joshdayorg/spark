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
  console.error(`Composio read action fail-soft proof failed: ${message}`);
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

function extractFunction(text, functionName) {
  const marker = `function ${functionName}`;
  const start = text.indexOf(marker);
  if (start === -1) {
    fail(`could not find function ${functionName}`);
  }
  const nextFunction = text.indexOf("\nfunction ", start + marker.length);
  const nextAsyncFunction = text.indexOf("\nasync function ", start + marker.length);
  const nextExport = text.indexOf("\nexport const ", start + marker.length);
  const candidates = [nextFunction, nextAsyncFunction, nextExport].filter(
    (index) => index !== -1,
  );
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

const warnHelper = extractFunction(composio, "warnComposioReadFailure");
const resolveActiveAccount = extractFunction(composio, "resolveActiveAccount");
const listWatchedTriggerTargets = extractFunction(
  composio,
  "listWatchedTriggerTargets",
);
const listConnectedToolkits = extractExportedFunction(
  composio,
  "listConnectedToolkitsForOrg",
);
const listAvailableAsanaProjects = extractExportedFunction(
  composio,
  "listAvailableAsanaProjectsForOrg",
);
const listWatchedAsanaProjects = extractExportedFunction(
  composio,
  "listWatchedAsanaProjectsForOrg",
);
const listAvailableSlackChannels = extractExportedFunction(
  composio,
  "listAvailableSlackChannelsForOrg",
);
const listWatchedSlackChannels = extractExportedFunction(
  composio,
  "listWatchedSlackChannelsForOrg",
);
const syncWatchedAsanaProjects = extractExportedFunction(
  composio,
  "syncWatchedAsanaProjectsForOrg",
);
const syncWatchedSlackChannels = extractExportedFunction(
  composio,
  "syncWatchedSlackChannelsForOrg",
);

assert(
  /console\.warn\("spark:composio-read-failed"/.test(warnHelper) &&
    /error: getErrorMessage\(args\.error\)/.test(warnHelper),
  "read failures must be logged with bounded error text",
);
assert(
  /operation\?: string/.test(resolveActiveAccount) &&
    /!isMissingActiveConnection\(error\)/.test(resolveActiveAccount) &&
    /return null;/.test(resolveActiveAccount),
  "active-account resolution for read paths must return null and avoid warning for normal disconnected state",
);
assert(
  /try \{[\s\S]*listActiveTriggers\(composio, active\.id, tk\.triggerSlugs\)[\s\S]*\} catch \(error\) \{[\s\S]*warnComposioReadFailure[\s\S]*return \{ connectedAccountId: active\.id, watched: \[\], triggerCount: 0 \};[\s\S]*\}/.test(
    listWatchedTriggerTargets,
  ),
  "watched-trigger read path must fail soft after a connected account is found",
);
assert(
  /try \{[\s\S]*getComposioClient\(\)[\s\S]*connectedAccounts\.list[\s\S]*\} catch \(error\) \{[\s\S]*warnComposioReadFailure[\s\S]*return \[\];[\s\S]*\}/.test(
    listConnectedToolkits,
  ),
  "connected toolkit listing must return an empty list on Composio read failure",
);
assert(
  /catch \(error\) \{[\s\S]*operation: "asana\.composioClient"[\s\S]*return \{ connectedAccountId: null, projects: \[\] \};[\s\S]*\}/.test(
    listAvailableAsanaProjects,
  ) &&
    /catch \(error\) \{[\s\S]*operation: "asana\.tools\.listProjects"[\s\S]*return \{ connectedAccountId: active\.id, projects: \[\] \};[\s\S]*\}/.test(
      listAvailableAsanaProjects,
    ),
  "Asana available-project reads must fail soft for client and tool-list failures",
);
assert(
  /catch \(error\) \{[\s\S]*operation: "slack\.composioClient"[\s\S]*return \{ connectedAccountId: null, channels: \[\] \};[\s\S]*\}/.test(
    listAvailableSlackChannels,
  ) &&
    /catch \(error\) \{[\s\S]*operation: "slack\.tools\.listChannels"[\s\S]*return \{ connectedAccountId: active\.id, channels: \[\] \};[\s\S]*\}/.test(
      listAvailableSlackChannels,
    ),
  "Slack available-channel reads must fail soft for client and tool-list failures",
);
assert(
  /catch \(error\) \{[\s\S]*operation: "asana\.composioClient"[\s\S]*return \{ connectedAccountId: null, watchedProjects: \[\], triggerCount: 0 \};[\s\S]*\}/.test(
    listWatchedAsanaProjects,
  ),
  "Asana watched-project reads must fail soft for client creation failures",
);
assert(
  /catch \(error\) \{[\s\S]*operation: "slack\.composioClient"[\s\S]*return \{ connectedAccountId: null, watchedChannels: \[\], triggerCount: 0 \};[\s\S]*\}/.test(
    listWatchedSlackChannels,
  ),
  "Slack watched-channel reads must fail soft for client creation failures",
);
assert(
  /reconcileTriggers\([\s\S]*getComposioClient\(\)/.test(
    syncWatchedAsanaProjects,
  ) &&
    /const composio = getComposioClient\(\);[\s\S]*reconcileTriggers\([\s\S]*composio/.test(
      syncWatchedSlackChannels,
    ) &&
    !/catch \(error\) \{[\s\S]*return \{/.test(
      `${syncWatchedAsanaProjects}\n${syncWatchedSlackChannels}`,
    ),
  "mutating trigger sync actions must remain strict and continue surfacing Composio failures",
);

console.log(
  "Composio read action fail-soft proof passed: startup integration reads return empty shapes on upstream read failures while sync stays strict.",
);
NODE
