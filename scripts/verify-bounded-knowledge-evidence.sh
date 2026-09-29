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
const knowledge = fs.readFileSync(path.join(repoRoot, "convex", "knowledge.ts"), "utf8");
const spark = fs.readFileSync(path.join(repoRoot, "convex", "spark.ts"), "utf8");
const versions = fs.readFileSync(
  path.join(repoRoot, "convex", "knowledgePageVersions.ts"),
  "utf8",
);

function fail(message) {
  console.error(`Bounded knowledge evidence proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

assert(
  /knowledgePageEvidence:\s*defineTable\(\{[\s\S]*pageId:\s*v\.id\("knowledgePages"\)[\s\S]*evidenceKey:\s*v\.string\(\)[\s\S]*\}\)[\s\S]*\.index\("by_page", \["pageId", "createdAt"\]\)[\s\S]*\.index\("by_page_key", \["pageId", "evidenceKey"\]\)/.test(schema),
  "schema must define indexed knowledgePageEvidence child rows",
);
assert(
  /sessionEvents:\s*defineTable\(\{[\s\S]*sessionId:\s*v\.id\("sessions"\)[\s\S]*eventId:\s*v\.id\("events"\)[\s\S]*\}\)[\s\S]*\.index\("by_session", \["sessionId", "createdAt"\]\)[\s\S]*\.index\("by_session_event", \["sessionId", "eventId"\]\)/.test(schema),
  "schema must define indexed sessionEvents child rows",
);

assert(
  /KNOWLEDGE_PAGE_EVIDENCE_SUMMARY_LIMIT = 25/.test(versions),
  "page evidence summaries must have a fixed limit",
);
assert(
  /SESSION_EVENT_ID_SUMMARY_LIMIT = 100/.test(versions),
  "session event-id summaries must have a fixed limit",
);
assert(
  /evidenceTimeline: boundKnowledgePageEvidenceTimeline\(page\.evidenceTimeline\)/.test(versions),
  "page version snapshots must bound evidenceTimeline",
);
assert(
  /key === "eventIds"[\s\S]*boundSessionEventIds/.test(versions),
  "page version snapshots must bound session eventIds",
);
assert(
  /key === "knowledgePageIds"[\s\S]*boundSessionRelationIds/.test(versions),
  "page version snapshots must bound session knowledgePageIds",
);

assert(
  /export async function recordKnowledgePageEvidence/.test(knowledge),
  "knowledge writes must expose the evidence child-row recorder",
);
assert(
  /\.query\("knowledgePageEvidence"\)[\s\S]*\.withIndex\("by_page_key"/.test(knowledge),
  "evidence recorder must dedupe through the page/key index",
);
assert(
  /ctx\.db\.insert\("knowledgePageEvidence"/.test(knowledge),
  "evidence recorder must insert child evidence rows",
);
assert(
  /evidenceTimeline: boundKnowledgePageEvidenceTimeline\(\[\s*\.\.\.existingPage\.evidenceTimeline,\s*\.\.\.newEvidence,\s*\]\)/.test(knowledge),
  "knowledge extraction updates must cap parent evidence summaries",
);
assert(
  /await recordKnowledgePageEvidence\(ctx, \{[\s\S]*entries: newEvidence/.test(knowledge),
  "knowledge extraction updates must write new evidence to child rows",
);
assert(
  /evidenceTimeline: boundKnowledgePageEvidenceTimeline\(evidenceEntries\)/.test(knowledge),
  "new knowledge pages must cap parent evidence summaries",
);
assert(
  /await recordKnowledgePageEvidence\(ctx, \{[\s\S]*entries: evidenceEntries/.test(knowledge),
  "new knowledge pages must write evidence to child rows",
);
assert(
  !knowledge.includes("evidenceTimeline: [...existingPage.evidenceTimeline, ...newEvidence]"),
  "knowledge extraction must not append unbounded evidence to the parent page",
);

assert(
  /async function recordSessionEventMemberships/.test(spark),
  "session writes must define the session event child-row recorder",
);
assert(
  /\.query\("sessionEvents"\)[\s\S]*\.withIndex\("by_session_event"/.test(spark),
  "session event recorder must dedupe through the session/event index",
);
assert(
  /ctx\.db\.insert\("sessionEvents"/.test(spark),
  "session event recorder must insert child event membership rows",
);
assert(
  /const eventIdSummary = boundSessionEventIds\(mergedEventIds\)/.test(spark),
  "session continuations must cap parent event-id summaries",
);
assert(
  /const eventIdSummary = boundSessionEventIds\(args\.eventIds\)/.test(spark),
  "new sessions must cap parent event-id summaries",
);
assert(
  /evidenceTimeline: boundKnowledgePageEvidenceTimeline\(\s*mergeEvidenceTimeline/.test(spark),
  "session continuations must cap parent evidence summaries",
);
assert(
  /evidenceTimeline: boundKnowledgePageEvidenceTimeline\(args\.evidenceTimeline\)/.test(spark),
  "new session pages must cap parent evidence summaries",
);
assert(
  /await recordKnowledgePageEvidence\(ctx, \{[\s\S]*entries: args\.evidenceTimeline/.test(spark),
  "session pages must write evidence to child rows",
);
assert(
  !/eventIds:\s*mergedEventIds/.test(spark),
  "session continuations must not write merged full eventIds to parent docs",
);
assert(
  /ctx\.db\.insert\("sessions", \{[\s\S]*eventIds: eventIdSummary/.test(spark),
  "new session docs must store the bounded eventIdSummary",
);
assert(
  !/evidenceTimeline:\s*args\.evidenceTimeline/.test(spark),
  "new session pages must not write full evidenceTimeline to parent docs",
);

console.log("Bounded knowledge evidence proof passed: parent docs keep summaries while child tables keep append-only provenance.");
NODE
