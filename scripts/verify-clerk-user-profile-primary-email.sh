#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-node}"

cd "$REPO_ROOT"

"$NODE_BIN" --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const http = fs.readFileSync(path.join(repoRoot, "convex", "http.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");

function fail(message) {
  console.error(`Clerk user profile primary email proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function extractBlock(text, startMarker, endMarker = null) {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    fail(`could not find ${startMarker}`);
  }
  if (endMarker === null) {
    return text.slice(start);
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? text.length : end);
}

const primaryEmailHelper = extractBlock(
  http,
  "function getPrimaryClerkEmail",
  "function mapClerkRole",
);
const userUpdatedCase = extractBlock(
  http,
  'case "user.updated":',
  "default:",
);
const syncTeamMemberProfile = extractBlock(
  spark,
  "export const syncTeamMemberProfile = internalMutation",
  "export const saveAnthropicEnvironmentId = internalMutation",
);

assert(
  /primaryEmailAddressId: string \| null \| undefined/.test(primaryEmailHelper),
  "primary email helper must accept Clerk primary_email_address_id",
);
assert(
  /emailAddresses:[\s\S]*email_address\?: string \| null/.test(primaryEmailHelper),
  "primary email helper must inspect Clerk email_addresses entries",
);
assert(
  /\.find\([\s\S]*emailAddress\.id === args\.primaryEmailAddressId[\s\S]*\)\?\.email_address/.test(primaryEmailHelper),
  "primary email helper must select by matching email address id",
);
assert(
  /primaryEmail\?\.trim\(\)/.test(primaryEmailHelper),
  "primary email helper must trim selected email",
);
assert(
  !/email_addresses\[0\]/.test(userUpdatedCase),
  "user.updated must not treat the first email address as authoritative",
);
assert(
  !/email:\s*event\.data\.email_addresses\[0\]\?\.email_address\s*\?\?\s*""/.test(userUpdatedCase),
  "user.updated must not fall back to blank email",
);
assert(
  /primaryEmailAddressId: event\.data\.primary_email_address_id/.test(userUpdatedCase),
  "user.updated must pass Clerk primary_email_address_id to the helper",
);
assert(
  /emailAddresses: event\.data\.email_addresses/.test(userUpdatedCase),
  "user.updated must pass Clerk email_addresses to the helper",
);
assert(
  /\.\.\.\(primaryEmail \? \{ email: primaryEmail \} : \{\}\)/.test(userUpdatedCase),
  "user.updated must omit email when no authoritative primary email exists",
);
assert(
  /email: v\.optional\(v\.string\(\)\)/.test(syncTeamMemberProfile),
  "syncTeamMemberProfile email arg must be optional",
);
assert(
  /\.\.\.\(args\.email \? \{ email: args\.email \} : \{\}\)/.test(syncTeamMemberProfile),
  "syncTeamMemberProfile must preserve existing email when email is absent",
);

console.log("Clerk user profile primary email proof passed: user.updated uses primary email and preserves stored email when no primary email is present.");
NODE
