// Standalone unit test for convex/classifyEvent.ts.
// Not part of `npm test`. Run it via transpile (see docs/tool-agnostic-pipeline.md):
//   npx tsc convex/classifyEvent.ts scripts/test-classify-event.ts --outDir /tmp/cetest \
//     --module commonjs --target es2022 --moduleResolution node --esModuleInterop \
//     --skipLibCheck --noCheck && node /tmp/cetest/scripts/test-classify-event.js
// Lives under scripts/ (not convex/) so Convex codegen/typecheck ignores it.

import assert from "node:assert";
import {
  classifyEvent,
  coalesceKeyFor,
  templateSummary,
  COALESCE_WINDOW_MS,
  TIER_RANK,
  type Classification,
} from "../convex/classifyEvent";

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

// Mirror of spark.ts isNoiseCluster so we can assert the end-to-end gate
// behavior (the only consumer of tier/verb in steps 1-4) stays a SUPERSET of
// the old asana-only gate.
function isNoiseCluster(
  events: Array<{ source: string; type: string; raw: unknown; summary: string }>,
): boolean {
  if (events.length === 0) return true;
  const cs: Classification[] = events.map((e) => classifyEvent(e.source, e.type, e.raw));
  if (cs.some((c) => TIER_RANK[c.tier] >= TIER_RANK.substantive)) return false;
  const distinct = new Set(
    cs.map((c, i) => `${c.verb}|${c.field ?? ""}|${c.object.gid ?? events[i].summary}`),
  );
  return distinct.size < 2;
}

const ev = (source: string, type: string, raw: unknown, summary = "") => ({
  source,
  type,
  raw,
  summary,
});

// --- classification ---------------------------------------------------------

check("asana task_updated/notes -> updated, routine, field+gid", () => {
  const c = classifyEvent("asana", "task_updated", {
    data: { task_gid: "T1", change_field: "notes", project_gid: "P9" },
  });
  assert.equal(c.verb, "updated");
  assert.equal(c.tier, "routine");
  assert.equal(c.field, "notes");
  assert.equal(c.object.gid, "T1");
  assert.equal(c.container?.gid, "P9");
});

check("asana task_updated/completed -> closed, substantive (bumped)", () => {
  const c = classifyEvent("asana", "task_updated", {
    data: { task_gid: "T1", change_field: "completed" },
  });
  assert.equal(c.verb, "closed");
  assert.equal(c.tier, "substantive");
});

check("asana task_created -> created, substantive", () => {
  const c = classifyEvent("asana", "task_created", { data: { task_gid: "T2" } });
  assert.equal(c.verb, "created");
  assert.equal(c.tier, "substantive");
  assert.equal(c.object.kind, "task");
});

check("asana ticket_moved -> moved, routine", () => {
  const c = classifyEvent("asana", "ticket_moved", { data: { task_gid: "T3" } });
  assert.equal(c.verb, "moved");
  assert.equal(c.tier, "routine");
});

check("slack message -> commented, substantive, gid=ts", () => {
  const c = classifyEvent("slack", "message", {
    data: { ts: "1778.99", channel: "C1", user: "U1" },
  });
  assert.equal(c.verb, "commented");
  assert.equal(c.tier, "substantive");
  assert.equal(c.object.gid, "1778.99");
  assert.equal(c.container?.gid, "C1");
});

check("github push -> created, substantive, container=repo", () => {
  const c = classifyEvent("github", "push", {
    head_commit: { id: "abc123", message: "fix things" },
    repository: { full_name: "org/repo" },
  });
  assert.equal(c.verb, "created");
  assert.equal(c.tier, "substantive");
  assert.equal(c.object.gid, "abc123");
  assert.equal(c.container?.gid, "org/repo");
});

check("github pull_request closed+merged -> merged", () => {
  const c = classifyEvent("github", "pull_request", {
    action: "closed",
    pull_request: { number: 42, merged_at: "2026-01-01", title: "feat" },
  });
  assert.equal(c.verb, "merged");
  assert.equal(c.tier, "substantive");
  assert.equal(c.object.gid, "42");
});

check("github pull_request backfill (no action) merged -> merged", () => {
  const c = classifyEvent("github", "pull_request", {
    pull_request: { number: 7, state: "closed", merged_at: "x" },
  });
  assert.equal(c.verb, "merged");
});

check("github workflow_run -> status_changed, trivial", () => {
  const c = classifyEvent("github", "workflow_run", { action: "completed" });
  assert.equal(c.tier, "trivial");
});

check("gorgias ticket_closed -> closed, substantive, ticket gid", () => {
  const c = classifyEvent("gorgias", "ticket_closed", {
    ticket_id: "G5",
    subject: "Refund",
    status: "closed",
  });
  assert.equal(c.verb, "closed");
  assert.equal(c.tier, "substantive");
  assert.equal(c.object.gid, "G5");
});

check("UNKNOWN tool NOTION_PAGE_UPDATED -> updated, routine, page (heuristic)", () => {
  const c = classifyEvent("notion", "NOTION_PAGE_UPDATED", { data: { id: "pg1" } });
  assert.equal(c.verb, "updated");
  assert.equal(c.tier, "routine");
  assert.equal(c.object.kind, "page");
  assert.equal(c.object.gid, "pg1");
});

check("UNKNOWN tool LINEAR_ISSUE_CREATED -> created, substantive, issue (heuristic)", () => {
  const c = classifyEvent("linear", "LINEAR_ISSUE_CREATED", { data: { id: "L1" } });
  assert.equal(c.verb, "created");
  assert.equal(c.tier, "substantive");
  assert.equal(c.object.kind, "issue");
});

check("UNKNOWN CI tool slug -> trivial via CI override", () => {
  const c = classifyEvent("circleci", "WORKFLOW_COMPLETED", {});
  assert.equal(c.tier, "trivial");
});

// --- noise gate (superset of old asana-only gate) --------------------------

check("13x identical notes-changed burst -> NOISE (drops)", () => {
  const burst = Array.from({ length: 13 }, () =>
    ev("asana", "task_updated", { data: { task_gid: "T1", change_field: "notes" } }, 'notes changed on "X"'),
  );
  assert.equal(isNoiseCluster(burst), true);
});

check("two distinct field changes on a task -> NOT noise (survives)", () => {
  const cluster = [
    ev("asana", "task_updated", { data: { task_gid: "T1", change_field: "assignee" } }, "assignee changed"),
    ev("asana", "task_updated", { data: { task_gid: "T1", change_field: "name" } }, "name changed"),
  ];
  assert.equal(isNoiseCluster(cluster), false);
});

check("task_created cluster -> NOT noise (substantive survives)", () => {
  assert.equal(isNoiseCluster([ev("asana", "task_created", { data: { task_gid: "T9" } })]), false);
});

check("lone github push -> NOT noise (substantive survives, no coverage regression)", () => {
  assert.equal(
    isNoiseCluster([ev("github", "push", { head_commit: { id: "z" }, repository: { full_name: "o/r" } })]),
    false,
  );
});

check("lone CI run -> NOISE (drops, intended new behavior)", () => {
  assert.equal(isNoiseCluster([ev("github", "workflow_run", { action: "completed" })]), true);
});

// --- templateSummary (generic summary for unadaptered tools) ----------------

check("templateSummary: named object", () => {
  const c = classifyEvent("notion", "NOTION_PAGE_UPDATED", { data: { id: "p1", title: "Roadmap" } });
  assert.equal(templateSummary(c, "Jane"), 'Jane updated "Roadmap"');
});

check("templateSummary: unnamed object falls back to kind", () => {
  const c = classifyEvent("linear", "LINEAR_ISSUE_CREATED", { data: { id: "L1" } });
  assert.equal(templateSummary(c, "Sam"), "Sam created a issue");
});

check("templateSummary: no actor -> Someone", () => {
  const c = classifyEvent("foo", "FOO_THING_COMMENTED", {});
  assert.equal(templateSummary(c, null), "Someone commented on a other");
});

// --- coalesceKeyFor (generic burst suppression) -----------------------------

const t0 = 1_000_000_000_000;

check("coalesce: same-field edit burst in one window shares a key", () => {
  const c = classifyEvent("notion", "NOTION_PAGE_UPDATED", { data: { id: "p1" } });
  const k1 = coalesceKeyFor(c, t0);
  const k2 = coalesceKeyFor(c, t0 + 60_000); // 1 min later, same window
  assert.ok(k1 !== null);
  assert.equal(k1, k2);
});

check("coalesce: next window gets a different key (not dropped)", () => {
  const c = classifyEvent("notion", "NOTION_PAGE_UPDATED", { data: { id: "p1" } });
  assert.notEqual(coalesceKeyFor(c, t0), coalesceKeyFor(c, t0 + COALESCE_WINDOW_MS));
});

check("coalesce: different field on same object -> different key", () => {
  const notes = classifyEvent("asana", "task_updated", { data: { task_gid: "T1", change_field: "due_on" } });
  const desc = classifyEvent("asana", "task_updated", { data: { task_gid: "T1", change_field: "html_notes" } });
  assert.notEqual(coalesceKeyFor(notes, t0), coalesceKeyFor(desc, t0));
});

check("coalesce: NOT applied to discrete transitions or substantive events", () => {
  assert.equal(coalesceKeyFor(classifyEvent("asana", "ticket_moved", { data: { task_gid: "T1" } }), t0), null); // moved
  assert.equal(coalesceKeyFor(classifyEvent("asana", "task_updated", { data: { task_gid: "T1", change_field: "assignee" } }), t0), null); // assigned
  assert.equal(coalesceKeyFor(classifyEvent("asana", "task_created", { data: { task_gid: "T1" } }), t0), null); // substantive
  assert.equal(coalesceKeyFor(classifyEvent("github", "push", { head_commit: { id: "x" } }), t0), null); // substantive
});

check("coalesce: NOT applied without an object gid", () => {
  assert.equal(coalesceKeyFor(classifyEvent("foo", "FOO_THING_UPDATED", {}), t0), null);
});

console.log(`\n${passed} checks passed`);
