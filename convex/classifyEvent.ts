// Tool-agnostic event classification.
//
// Pure module — NO Convex/env/framework imports — so it is unit-testable and
// importable from any runtime (V8 or "use node"); same constraint
// composioConfig.ts follows.
//
// WHY: as Spark ingests hundreds of Composio toolkits, branching core logic on
// `source === "asana"` does not scale. classifyEvent maps ANY event (any
// source, any tool) into one canonical vocabulary so the noise-gate, clustering
// and (later) coalescing never name a specific tool. Three layers, in order:
//   (1) a declarative REGISTRY for the handful of known high-value
//       (source,rawType) pairs that deserve precise verb/tier/object;
//   (2) a slug HEURISTIC that covers the open world — unmapped Composio
//       toolkits, free-form api/mcp types, unknown github events — with zero
//       config (a new tool's `*_UPDATED` slug auto-classifies to updated:routine
//       and is auto-caught by the noise gate);
//   (3) a future cached LLM classifier (not built; see classifyEventContract).
// Adding a tool is normally ZERO code: the slug parses via the heuristic. You
// add a registry row only to OVERRIDE the heuristic for precision.
//
// classifyEvent makes no network/identity calls — object.name is resolved
// downstream by the existing identity machinery; this only reads what the
// payload already carries.

export type Verb =
  | "created"
  | "updated"
  | "commented"
  | "assigned"
  | "moved"
  | "status_changed"
  | "closed"
  | "merged"
  | "mentioned"
  | "reacted"
  | "attached"
  | "renamed"
  | "deleted"
  | "linked"
  | "other";

export type Tier = "substantive" | "routine" | "trivial";

export type ClassifiedObject = {
  source: string;
  kind: string;
  gid?: string;
  name?: string;
};

export type Classification = {
  verb: Verb;
  tier: Tier;
  object: ClassifiedObject;
  field?: string;
  container?: { source: string; kind: string; gid?: string };
};

// --- payload walking -------------------------------------------------------

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

// Walk candidate key-paths and return the first non-empty scalar (string, or a
// finite number coerced to string). Tries the payload as-is AND nested under
// `data` / `data.data`: live Composio webhooks nest the resource under
// body.data, the REST resolver double-nests, while backfill/gorgias/github-app
// payloads are flat. One walker covers every shape. (Generalizes
// ingest.ts extractByPaths; copied rather than imported to keep this module
// dependency-free.)
function firstByPaths(payload: unknown, paths: string[][]): string | undefined {
  const outer = getRecord(payload);
  if (!outer) {
    return undefined;
  }
  const bases = [
    outer,
    getRecord(outer.data),
    getRecord(getRecord(outer.data)?.data),
  ].filter((b): b is Record<string, unknown> => b !== null);
  for (const base of bases) {
    for (const path of paths) {
      let cursor: unknown = base;
      for (const key of path) {
        cursor = getRecord(cursor)?.[key];
      }
      if (typeof cursor === "string" && cursor.length > 0) {
        return cursor;
      }
      if (typeof cursor === "number" && Number.isFinite(cursor)) {
        return String(cursor);
      }
    }
  }
  return undefined;
}

// --- the registry (overrides, not exhaustive) ------------------------------

// verb may be a literal Verb, or a marker that the verb is derived from the
// payload (github action, asana change_field, gorgias status token).
type VerbRule = Verb | "@github_action" | "@asana_field" | "@gorgias_status";
type RegistryRow = { verb: VerbRule; tier: Tier; objectKind: string };

// Keyed `${source}:${rawType}`. Each known pair is registered under BOTH the
// raw Composio trigger slug AND the persisted events.type (which
// COMPOSIO_TRIGGER_TYPE_MAP collapses the slug into), because step-2/3/4
// callers read Doc<events>.type while a future insert-boundary caller has the
// raw slug. Lookup falls through to the heuristic when absent.
const REGISTRY: Record<string, RegistryRow> = {
  // Asana
  "asana:ASANA_TASK_CREATED": { verb: "created", tier: "substantive", objectKind: "task" },
  "asana:task_created": { verb: "created", tier: "substantive", objectKind: "task" },
  "asana:ASANA_TASK_UPDATED": { verb: "@asana_field", tier: "routine", objectKind: "task" },
  "asana:task_updated": { verb: "@asana_field", tier: "routine", objectKind: "task" },
  "asana:ASANA_TASK_MOVED_TO_SECTION": { verb: "moved", tier: "routine", objectKind: "task" },
  "asana:ticket_moved": { verb: "moved", tier: "routine", objectKind: "task" },
  "asana:ASANA_TASK_COMMENT_ADDED": { verb: "commented", tier: "substantive", objectKind: "task" },
  "asana:ASANA_TASK_ATTACHMENT_ADDED": { verb: "attached", tier: "routine", objectKind: "task" },
  "asana:ASANA_TASK_TAG_ADDED": { verb: "linked", tier: "trivial", objectKind: "task" },
  "asana:ASANA_TASK_COMPLETED": { verb: "closed", tier: "substantive", objectKind: "task" },
  "asana:task_completed": { verb: "closed", tier: "substantive", objectKind: "task" },

  // Slack — the four trigger slugs all collapse to events.type "message" before
  // persist, so a Doc<events> reader cannot tell a bot post from a human one;
  // bot-tiering only works once the raw slug is plumbed to the insert boundary.
  "slack:message": { verb: "commented", tier: "substantive", objectKind: "message" },
  "slack:SLACKBOT_CHANNEL_MESSAGE_RECEIVED": { verb: "commented", tier: "substantive", objectKind: "message" },
  "slack:SLACKBOT_DIRECT_MESSAGE_RECEIVED": { verb: "commented", tier: "substantive", objectKind: "message" },
  "slack:SLACKBOT_RECEIVE_MESSAGE": { verb: "commented", tier: "substantive", objectKind: "message" },
  "slack:SLACKBOT_RECEIVE_BOT_MESSAGE": { verb: "commented", tier: "trivial", objectKind: "message" },

  // GitHub — events.type is the raw x-github-event header (live) or a coarse
  // type (backfill). push is substantive (code landed) so a lone push still
  // forms a session; CI/automation events are trivial so lone runs gate out.
  "github:push": { verb: "created", tier: "substantive", objectKind: "commit" },
  "github:pull_request": { verb: "@github_action", tier: "substantive", objectKind: "pr" },
  "github:issues": { verb: "@github_action", tier: "substantive", objectKind: "issue" },
  "github:issue_comment": { verb: "commented", tier: "substantive", objectKind: "issue" },
  "github:pull_request_review": { verb: "commented", tier: "substantive", objectKind: "pr" },
  "github:pull_request_review_comment": { verb: "commented", tier: "substantive", objectKind: "pr" },
  "github:commit_comment": { verb: "commented", tier: "substantive", objectKind: "commit" },
  "github:release": { verb: "created", tier: "substantive", objectKind: "release" },
  "github:repository": { verb: "@github_action", tier: "routine", objectKind: "repo" },
  "github:workflow_run": { verb: "status_changed", tier: "trivial", objectKind: "ci_run" },
  "github:check_run": { verb: "status_changed", tier: "trivial", objectKind: "ci_run" },
  "github:check_suite": { verb: "status_changed", tier: "trivial", objectKind: "ci_run" },
  "github:status": { verb: "status_changed", tier: "trivial", objectKind: "ci_run" },
  "github:deployment": { verb: "status_changed", tier: "routine", objectKind: "deployment" },
  "github:deployment_status": { verb: "status_changed", tier: "routine", objectKind: "deployment" },

  // Gorgias — events.type is dynamic `ticket_${status}`; verb derived from it.
  "gorgias:ticket": { verb: "@gorgias_status", tier: "substantive", objectKind: "ticket" },
};

// --- verb derivation for the @-marker rows ---------------------------------

function deriveAsanaFieldVerb(field: string | undefined): { verb: Verb; tier?: Tier } {
  switch (field) {
    case "completed":
      return { verb: "closed", tier: "substantive" }; // a completion is real signal
    case "assignee":
      return { verb: "assigned" };
    case "name":
      return { verb: "renamed" };
    default:
      return { verb: "updated" };
  }
}

function deriveGithubActionVerb(
  payload: unknown,
  objectKind: string,
): { verb: Verb } {
  const action = firstByPaths(payload, [["action"], ["data", "action"]]);
  const merged = firstByPaths(payload, [
    ["pull_request", "merged_at"],
    ["merged_at"],
  ]);
  const state = firstByPaths(payload, [
    ["pull_request", "state"],
    ["issue", "state"],
    ["state"],
  ]);

  if (objectKind === "pr") {
    if (action === "opened") return { verb: "created" };
    if (action === "closed") return merged ? { verb: "merged" } : { verb: "closed" };
    if (action === "edited") return { verb: "updated" };
    if (action === "review_requested" || action === "assigned") return { verb: "assigned" };
    if (action === "reopened") return { verb: "other" };
    if (action) return { verb: "updated" };
    // Backfill payloads carry no `action`; derive from state + merged_at.
    if (merged) return { verb: "merged" };
    if (state === "closed") return { verb: "closed" };
    return { verb: "created" };
  }

  if (objectKind === "issue") {
    if (action === "opened") return { verb: "created" };
    if (action === "closed") return { verb: "closed" };
    if (action === "assigned") return { verb: "assigned" };
    if (action === "labeled") return { verb: "linked" };
    if (action === "edited") return { verb: "updated" };
    if (action === "reopened") return { verb: "other" };
    if (action) return { verb: "updated" };
    if (state === "closed") return { verb: "closed" };
    return { verb: "created" };
  }

  // repository
  if (action === "created") return { verb: "created" };
  if (action === "deleted") return { verb: "deleted" };
  if (action === "renamed") return { verb: "renamed" };
  return { verb: "updated" };
}

function deriveGorgiasStatusVerb(
  rawType: string,
  payload: unknown,
): { verb: Verb; tier?: Tier } {
  const status = rawType.startsWith("ticket_")
    ? rawType.slice("ticket_".length)
    : (firstByPaths(payload, [["status"], ["data", "status"]]) ?? "");
  if (status === "closed") return { verb: "closed", tier: "substantive" };
  if (status === "snoozed") return { verb: "status_changed", tier: "routine" };
  if (status === "open" || status === "new") return { verb: "other", tier: "routine" };
  return { verb: "status_changed" };
}

// --- heuristic fallback (the scaling core) ---------------------------------

function defaultTierByVerb(verb: Verb): Tier {
  switch (verb) {
    case "created":
    case "commented":
    case "merged":
    case "closed":
    case "mentioned":
      return "substantive";
    case "reacted":
      return "trivial";
    default:
      // updated, assigned, moved, renamed, status_changed, attached, linked,
      // deleted, other
      return "routine";
  }
}

// First-match-wins token rules over the lowercased rawType. Covers any
// Composio toolkit slug (TOOLKIT_OBJECT_VERB) and free-form api/mcp types.
function heuristicClassify(rawType: string): {
  verb: Verb;
  tier: Tier;
  objectKind: string;
} {
  const t = rawType.toLowerCase();

  let verb: Verb = "other";
  if (/comment|repl(y|ied)/.test(t)) verb = "commented";
  else if (/merg/.test(t)) verb = "merged";
  else if (/complet|clos|resolv|done/.test(t)) verb = "closed";
  else if (/creat|add(ed)?|open/.test(t)) verb = "created";
  else if (/assign/.test(t)) verb = "assigned";
  else if (/mov|transition/.test(t)) verb = "moved";
  else if (/renam/.test(t)) verb = "renamed";
  else if (/delet|remov|archiv/.test(t)) verb = "deleted";
  else if (/react|emoji/.test(t)) verb = "reacted";
  else if (/mention/.test(t)) verb = "mentioned";
  else if (/attach|upload|file/.test(t)) verb = "attached";
  else if (/tag|label|link/.test(t)) verb = "linked";
  else if (/chang|updat|edit/.test(t)) verb = "updated";

  let objectKind = "other";
  if (/page/.test(t)) objectKind = "page";
  else if (/issue/.test(t)) objectKind = "issue";
  else if (/task/.test(t)) objectKind = "task";
  else if (/ticket/.test(t)) objectKind = "ticket";
  else if (/pull|pr_|_pr\b/.test(t)) objectKind = "pr";
  else if (/message|msg/.test(t)) objectKind = "message";
  else if (/doc/.test(t)) objectKind = "doc";
  else if (/deal|opportunit/.test(t)) objectKind = "deal";

  let tier = defaultTierByVerb(verb);
  // CI / automation / bot noise is trivial regardless of verb.
  if (/workflow|check_run|check_suite|\bstatus\b|deploy|\bci\b|build|pipeline|\bbot\b|automation/.test(t)) {
    tier = "trivial";
  }

  return { verb, tier, objectKind };
}

// --- object / field / container extraction ---------------------------------

const SOURCE_OBJECT_PATHS: Record<string, string[][]> = {
  asana: [["task_gid"], ["data", "task_gid"]],
  slack: [["ts"], ["data", "ts"]], // the slack ts IS the message id
  gorgias: [["ticket_id"], ["data", "ticket_id"]],
};

const GENERIC_OBJECT_PATHS: string[][] = [
  ["data", "id"],
  ["id"],
  ["gid"],
  ["data", "gid"],
];

function extractObjectGid(
  source: string,
  objectKind: string,
  payload: unknown,
): string | undefined {
  const sourcePaths = SOURCE_OBJECT_PATHS[source];
  if (sourcePaths) {
    const g = firstByPaths(payload, sourcePaths);
    if (g) return g;
  }
  if (source === "github") {
    if (objectKind === "commit") {
      return firstByPaths(payload, [
        ["head_commit", "id"],
        ["head_commit", "sha"],
        ["after"],
        ["sha"],
      ]);
    }
    return firstByPaths(payload, [
      ["pull_request", "number"],
      ["issue", "number"],
      ["number"],
    ]);
  }
  return firstByPaths(payload, GENERIC_OBJECT_PATHS);
}

const OBJECT_NAME_PATHS: string[][] = [
  ["name"],
  ["data", "name"],
  ["title"],
  ["data", "title"],
  ["subject"],
  ["data", "subject"],
  ["pull_request", "title"],
  ["issue", "title"],
  ["head_commit", "message"],
];

function extractContainer(
  source: string,
  payload: unknown,
): { source: string; kind: string; gid?: string } | undefined {
  if (source === "asana") {
    const gid = firstByPaths(payload, [["project_gid"], ["data", "project_gid"]]);
    return gid ? { source, kind: "project", gid } : undefined;
  }
  if (source === "github") {
    const gid = firstByPaths(payload, [["repository", "full_name"], ["repo"]]);
    return gid ? { source, kind: "repo", gid } : undefined;
  }
  if (source === "slack") {
    const gid = firstByPaths(payload, [
      ["channel"],
      ["channel_id"],
      ["data", "channel"],
      ["data", "channel_id"],
    ]);
    return gid ? { source, kind: "channel", gid } : undefined;
  }
  return undefined;
}

// --- the entry point -------------------------------------------------------

export function classifyEvent(
  source: string,
  rawType: string,
  payload: unknown,
): Classification {
  // Gorgias persists rawType as `ticket_${status}`; normalize to the registry
  // key "gorgias:ticket" so the status token drives the verb.
  const registryKey =
    source === "gorgias" && rawType.startsWith("ticket")
      ? "gorgias:ticket"
      : `${source}:${rawType}`;
  const row = REGISTRY[registryKey];

  const field = firstByPaths(payload, [["change_field"], ["data", "change_field"]]);

  let verb: Verb;
  let tier: Tier;
  let objectKind: string;

  if (row) {
    objectKind = row.objectKind;
    if (row.verb === "@asana_field") {
      const d = deriveAsanaFieldVerb(field);
      verb = d.verb;
      tier = d.tier ?? row.tier;
    } else if (row.verb === "@github_action") {
      verb = deriveGithubActionVerb(payload, objectKind).verb;
      tier = row.tier;
    } else if (row.verb === "@gorgias_status") {
      const d = deriveGorgiasStatusVerb(rawType, payload);
      verb = d.verb;
      tier = d.tier ?? row.tier;
    } else {
      verb = row.verb;
      tier = row.tier;
    }
  } else {
    const h = heuristicClassify(rawType);
    verb = h.verb;
    tier = h.tier;
    objectKind = h.objectKind;
  }

  return {
    verb,
    tier,
    object: {
      source,
      kind: objectKind,
      gid: extractObjectGid(source, objectKind, payload),
      name: firstByPaths(payload, OBJECT_NAME_PATHS),
    },
    field,
    container: extractContainer(source, payload),
  };
}

// Rank for "how substantive" comparisons (the noise gate keys on this).
export const TIER_RANK: Record<Tier, number> = {
  trivial: 0,
  routine: 1,
  substantive: 2,
};

const VERB_PHRASE: Record<Verb, string> = {
  created: "created",
  updated: "updated",
  commented: "commented on",
  assigned: "assigned",
  moved: "moved",
  status_changed: "changed the status of",
  closed: "closed",
  merged: "merged",
  mentioned: "mentioned",
  reacted: "reacted to",
  attached: "added an attachment to",
  renamed: "renamed",
  deleted: "deleted",
  linked: "linked",
  other: "updated",
};

// Window for collapsing keystroke-burst duplicates at insert.
export const COALESCE_WINDOW_MS = 5 * 60 * 1000;

// Key for collapsing a burst of identical field edits on the SAME object within
// one time window, or null when the event must NOT be coalesced. Tool-agnostic:
// it only ever collapses verb:"updated" (free-text/field edits — the keystroke
// noise), never discrete transitions (assigned/moved/status_changed/closed/
// merged) or substantive work, and only when there is an object to key on. This
// generalizes the per-tool ASANA_TASK_UPDATED_FIELDS whitelist: any tool's edit
// bursts collapse with no per-tool config.
export function coalesceKeyFor(
  c: Classification,
  timestampMs: number,
): string | null {
  if (c.verb !== "updated") return null;
  if (TIER_RANK[c.tier] > TIER_RANK.routine) return null;
  if (!c.object.gid) return null;
  const bucket = Math.floor(timestampMs / COALESCE_WINDOW_MS);
  return `${c.object.kind}:${c.object.gid}:${c.field ?? ""}:${bucket}`;
}

// A generic, source-agnostic one-line summary from a Classification — for tools
// that have NO dedicated adapter (the path every new Composio toolkit flows
// through). Dedicated adapters (Asana/Slack/GitHub) keep their own richer,
// attribution-aware summaries; this just gives the long tail something readable
// instead of a raw trigger slug.
export function templateSummary(c: Classification, actor?: string | null): string {
  const who = actor && actor.trim().length > 0 ? actor : "Someone";
  const obj = c.object.name ? `"${c.object.name}"` : `a ${c.object.kind}`;
  return `${who} ${VERB_PHRASE[c.verb]} ${obj}`;
}
