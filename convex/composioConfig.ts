// Composio declarative config — toolkit version pins, slug→internal-type map,
// default trigger sets, trigger-config tweaks, resource-fetcher specs.
//
// Pure data: no env reads, no framework imports. Safe to import from any
// Convex runtime (V8 or "use node"). Add new toolkit constants here so the
// "where do toolkit settings live?" question has one answer.

// =====================
// Infrastructure
// =====================

// Used by `composio.ts` for raw fetch() calls to Composio's REST API
// (webhook-subscription CRUD that the TS SDK doesn't expose).
export const COMPOSIO_BACKEND_BASE_URL = "https://backend.composio.dev";

// Passed to every `new Composio({ apiKey, toolkitVersions })` construction.
// With a toolkit pinned here, both `tools.execute` and `triggers.create` for
// that toolkit inherit the version — no per-call `version` argument needed.
//
// Bumping: change the pinned string. Find the current version at
// docs.composio.dev/toolkits/<slug>. Toolkit revisions can silently rename
// argument keys (Asana's `user_gid` quirk in ASANA_RESOURCE_FETCHERS below
// is one such case), so treat a bump as a code change and re-run the eval
// harness.
//
// Slackbot is deliberately excluded — see SLACKBOT_TOOLS_VERSION.
export const TOOLKIT_VERSIONS = {
  asana: "20260508_00",
} as const;

// Trigger slug → internal `events.type` value. Toolkit-prefixed slugs give a
// collision-free namespace. Unknown slugs fall back to the raw slug at the
// lookup site so debugging stays possible. The four `SLACKBOT_*` message
// slugs (channel, direct, plus two `RECEIVE_*` variants) all collapse to
// `"message"` so downstream code sees one type regardless of which trigger
// fired.
export const COMPOSIO_TRIGGER_TYPE_MAP: Record<string, string> = {
  ASANA_TASK_CREATED: "task_created",
  ASANA_TASK_UPDATED: "task_updated",
  ASANA_TASK_MOVED_TO_SECTION: "ticket_moved",
  SLACKBOT_CHANNEL_MESSAGE_RECEIVED: "message",
  SLACKBOT_DIRECT_MESSAGE_RECEIVED: "message",
  SLACKBOT_RECEIVE_MESSAGE: "message",
  SLACKBOT_RECEIVE_BOT_MESSAGE: "message",
};

// A Composio tool that resolves an opaque id (Asana gid, Slack user id, ...)
// to a human-readable name. `namePaths` are key-paths walked from the tool
// result's `data` envelope; the first path yielding a non-empty string wins.
// `version` is passed per-call to tools.execute for toolkits not pinned in
// TOOLKIT_VERSIONS (Slackbot — see SLACKBOT_TOOLS_VERSION).
export type ComposioFetcher = {
  slug: string;
  argKey: string;
  version?: string;
  namePaths: string[][];
  // Same semantics as namePaths but first non-empty string is an email.
  emailPaths?: string[][];
  // Same semantics as namePaths but first non-empty string is a photo URL.
  photoPaths?: string[][];
};

// =====================
// Asana
// =====================

// Default Asana triggers Spark subscribes to per watched project. All three
// require `project_gid`; ASANA_TASK_UPDATED also accepts the `fields[]`
// filter below to narrow noisy field-change events to a high-signal subset.
export const ASANA_DEFAULT_TRIGGER_SLUGS = [
  "ASANA_TASK_CREATED",
  "ASANA_TASK_UPDATED",
  "ASANA_TASK_MOVED_TO_SECTION",
] as const;

export const ASANA_TASK_UPDATED_FIELDS = [
  "assignee",
  "name",
  "completed",
] as const;

// Resource-fetcher specs used by `ingest.ts` to resolve Asana GIDs to human
// names. Composio's argument names don't always match Asana's REST conventions
// — ASANA_GET_USER expects `user_gid`, not the `user` parameter Asana's REST
// API accepts. Verified via deliberate-error responses. Bumping
// TOOLKIT_VERSIONS.asana without re-verifying these arg keys risks silent
// breakage.
export const ASANA_RESOURCE_FETCHERS: Record<
  "user" | "task" | "project" | "section",
  ComposioFetcher
> = {
  user: {
    slug: "ASANA_GET_USER",
    argKey: "user_gid",
    namePaths: [["name"], ["data", "name"]],
    emailPaths: [["email"], ["data", "email"]],
    photoPaths: [
      ["data", "photo", "image_128x128"],
      ["data", "photo", "image_60x60"],
      ["photo", "image_128x128"],
      ["photo", "image_60x60"],
    ],
  },
  task: {
    slug: "ASANA_GET_A_TASK",
    argKey: "task_gid",
    namePaths: [["name"], ["data", "name"]],
  },
  project: {
    slug: "ASANA_GET_A_PROJECT",
    argKey: "project_gid",
    namePaths: [["name"], ["data", "name"]],
  },
  section: {
    slug: "ASANA_GET_SECTION",
    argKey: "section_gid",
    namePaths: [["name"], ["data", "name"]],
  },
};

// =====================
// Slackbot
// =====================

// Slackbot's tool catalog and trigger registry don't share version values:
// the dashboard shows a dated toolkit-level version (e.g. v20260514_00) but
// individual tools advertise `available_versions: ["00000000_00"]`. Putting
// `slackbot: "v20260514_00"` in TOOLKIT_VERSIONS makes `triggers.create`
// fail with "Trigger type SLACK_CHANNEL_MESSAGE_RECEIVED not found" — the
// trigger registry doesn't accept that string. Workaround: keep slackbot
// out of TOOLKIT_VERSIONS so `triggers.create` defaults to "latest" at the
// trigger registry, and pass `version: SLACKBOT_TOOLS_VERSION` per-call on
// every `SLACKBOT_*` `tools.execute`. This asymmetry is Composio's.
export const SLACKBOT_TOOLS_VERSION = "00000000_00";

// Default Slackbot triggers Spark subscribes to per watched channel.
// SLACKBOT_CHANNEL_MESSAGE_RECEIVED accepts a `channel_id` config field;
// SLACKBOT_RECEIVE_MESSAGE (no config) is workspace-wide and would fire for
// every message in every channel.
export const SLACKBOT_DEFAULT_TRIGGER_SLUGS = [
  "SLACKBOT_CHANNEL_MESSAGE_RECEIVED",
] as const;

// Slack message payloads carry `user: "U..."` (an ID, not a name). Ingest
// resolves the ID via Composio's users.info wrapper to produce a human actor.
// If Composio renames the slug or the arg key, update here and the resolver
// in ingest.ts adopts it without other changes.
export const SLACK_USER_FETCHER: ComposioFetcher = {
  slug: "SLACKBOT_RETRIEVE_DETAILED_USER_INFORMATION",
  argKey: "user",
  version: SLACKBOT_TOOLS_VERSION,
  namePaths: [
    ["user", "profile", "display_name"],
    ["user", "profile", "real_name"],
    ["user", "real_name"],
    ["user", "name"],
    ["profile", "display_name"],
    ["profile", "real_name"],
    ["real_name"],
    ["name"],
  ],
  emailPaths: [
    ["user", "profile", "email"],
    ["profile", "email"],
  ],
  photoPaths: [
    ["user", "profile", "image_192"],
    ["user", "profile", "image_512"],
    ["user", "profile", "image_72"],
  ],
};

// =====================
// Trigger reconciliation
// =====================

// Per-toolkit descriptor consumed by the generic watched-target and trigger
// reconcile helpers in composio.ts. The watched + sync logic is identical
// across toolkits; only these four data points differ.
export type TriggerToolkitKey = "asana" | "slack";

export const TRIGGER_TOOLKITS: Record<
  TriggerToolkitKey,
  {
    toolkitSlug: string; // Composio SDK slug: "asana" | "slackbot"
    triggerSlugs: readonly string[];
    configKey: string; // triggerConfig field holding the target id
    buildTriggerConfig: (id: string, slug: string) => Record<string, unknown>;
  }
> = {
  asana: {
    toolkitSlug: "asana",
    triggerSlugs: ASANA_DEFAULT_TRIGGER_SLUGS,
    configKey: "project_gid",
    buildTriggerConfig: (id, slug) =>
      slug === "ASANA_TASK_UPDATED"
        ? { project_gid: id, fields: ASANA_TASK_UPDATED_FIELDS }
        : { project_gid: id },
  },
  slack: {
    toolkitSlug: "slackbot",
    triggerSlugs: SLACKBOT_DEFAULT_TRIGGER_SLUGS,
    configKey: "channel_id",
    buildTriggerConfig: (id) => ({ channel_id: id }),
  },
};

// =====================
// Gorgias
// =====================

// Gorgias is a tools-only Composio toolkit (no triggers), so it can't fire
// webhook events like Slack/Asana. Instead the poller in composio.ts pulls
// GORGIAS_LIST_TICKETS on a cron and emits one event per changed ticket,
// attributed to the assigned/acting TEAM MEMBER (never the customer). The
// watermark is derived from the events already written (no state table).
export const GORGIAS_TOOLKIT_SLUG = "gorgias";
export const GORGIAS_LIST_TICKETS_SLUG = "GORGIAS_LIST_TICKETS";
// Composio requires a SPECIFIC dated toolkit version for manual tool execution
// (the literal "latest" is rejected for this toolkit — only the values in the
// tool's available_versions work). Gorgias has no triggers, so it's NOT pinned
// in TOOLKIT_VERSIONS; the poller passes this per-call (like SLACKBOT_TOOLS_VERSION).
// 20260523_00 is the current toolkit version (per Composio's tool registry).
export const GORGIAS_TOOLS_VERSION = "20260523_00";
export const GORGIAS_POLL_PAGE_SIZE = 30;
export const GORGIAS_MAX_PAGES_PER_POLL = 5; // ≤150 tickets scanned per org/run
export const GORGIAS_FIRST_POLL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // bootstrap
