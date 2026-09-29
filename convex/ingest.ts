"use node";

import { Composio } from "@composio/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { githubTimestamp, parseTimestamp } from "./ingestTimestamps";
import { classifyEvent, templateSummary } from "./classifyEvent";
import {
  ASANA_RESOURCE_FETCHERS,
  COMPOSIO_BACKEND_BASE_URL,
  type ComposioFetcher,
  COMPOSIO_TRIGGER_TYPE_MAP,
  SLACK_USER_FETCHER,
  TOOLKIT_VERSIONS,
} from "./composioConfig";

type OrgId = Id<"orgs">;

type HeaderEntry = {
  name: string;
  value: string;
};

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function getString(value: unknown, key: string): string | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }
  const candidate = record[key];
  return typeof candidate === "string" ? candidate : null;
}

function getNumber(value: unknown, key: string): number | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }
  const candidate = record[key];
  return typeof candidate === "number" ? candidate : null;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function getHeadersMap(headers: HeaderEntry[]): Map<string, string> {
  const headerMap = new Map<string, string>();
  for (const header of headers) {
    headerMap.set(header.name.toLowerCase(), header.value);
  }
  return headerMap;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encodedSecret = new TextEncoder().encode(secret);
  const encodedPayload = new TextEncoder().encode(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    encodedSecret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encodedPayload);
  return Array.from(new Uint8Array(signature))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function verifyHmacSha256(args: {
  rawBody: string;
  providedSignature: string | null;
  secret: string | undefined;
  prefix?: string;
}) {
  if (!args.secret) {
    throw new Error("CONFIG: webhook secret is not configured");
  }
  if (!args.providedSignature) {
    throw new Error("AUTH: missing webhook signature");
  }

  const expectedSignature = await hmacSha256Hex(args.secret, args.rawBody);
  const normalizedProvidedSignature =
    args.prefix && args.providedSignature.startsWith(args.prefix)
      ? args.providedSignature.slice(args.prefix.length)
      : args.providedSignature;

  if (!constantTimeEquals(normalizedProvidedSignature, expectedSignature)) {
    throw new Error("AUTH: invalid webhook signature");
  }
}

async function verifyComposioWebhookSignature(args: {
  rawBody: string;
  webhookId: string | null;
  webhookTimestamp: string | null;
  webhookSignature: string | null;
}) {
  const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("CONFIG: COMPOSIO_WEBHOOK_SECRET is not configured");
  }

  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error("CONFIG: COMPOSIO_API_KEY is not configured");
  }

  try {
    const composio = new Composio({ apiKey, toolkitVersions: TOOLKIT_VERSIONS });
    await composio.triggers.verifyWebhook({
      payload: args.rawBody,
      signature: args.webhookSignature ?? "",
      secret,
      id: args.webhookId ?? "",
      timestamp: args.webhookTimestamp ?? "",
    });
  } catch {
    throw new Error("AUTH: Composio webhook signature verification failed");
  }
}

function githubSummary(body: unknown, eventType: string): string {
  const headCommit = getRecord(getRecord(body)?.head_commit);
  const commitMessage = headCommit?.message;
  if (typeof commitMessage === "string" && commitMessage.length > 0) {
    return commitMessage;
  }

  const action = getString(body, "action");
  if (action) {
    return `GitHub ${eventType}: ${action}`;
  }

  return `GitHub ${eventType}`;
}

function composioSource(body: unknown): string {
  const metadata = getRecord(getRecord(body)?.metadata);
  return (
    getString(metadata, "source") ??
    getString(metadata, "app") ??
    getString(metadata, "trigger_slug") ??
    "composio"
  );
}

function composioActor(body: unknown): string {
  const data = getRecord(getRecord(body)?.data);
  if (!data) {
    return composioSource(body);
  }

  const direct = [
    getString(data, "author"),
    getString(data, "actor"),
    getString(data, "user_name"),
    getString(data, "username"),
    getString(data, "creator"),
  ];
  for (const candidate of direct) {
    if (candidate && candidate.length > 0) {
      return candidate;
    }
  }

  const nested = [
    getString(getRecord(data.sender), "name"),
    getString(getRecord(data.sender), "login"),
    getString(getRecord(data.sender), "id"),
    getString(getRecord(data.user), "name"),
    getString(getRecord(data.user), "real_name"),
    getString(getRecord(data.last_edited_by), "name"),
  ];
  for (const candidate of nested) {
    if (candidate && candidate.length > 0) {
      return candidate;
    }
  }

  return composioSource(body);
}

async function insertGithubWebhookEvent(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    orgId: OrgId;
    githubEvent: string;
    sourceDeliveryId?: string;
    body: unknown;
  },
): Promise<unknown> {
  const sender = getRecord(getRecord(args.body)?.sender);
  const actor = getString(sender, "login") ?? "github";

  return ctx.runMutation(internal.spark.insertEvent, {
    orgId: args.orgId,
    source: "github",
    via: "webhook",
    type: args.githubEvent,
    actor,
    actorRef: actor !== "github" ? { source: "github", gid: actor } : undefined,
    summary: githubSummary(args.body, args.githubEvent),
    timestamp: githubTimestamp(args.body, args.githubEvent),
    ...(args.sourceDeliveryId ? { sourceDeliveryId: args.sourceDeliveryId } : {}),
    raw: args.body,
  });
}

// =====================
// Composio toolkit ingest
// =====================
// Composio delivers every toolkit's events on one webhook. Toolkits whose
// payloads carry opaque ids (Asana gids, Slack user ids) need an adapter that
// resolves human names via Composio's tool proxy; the fetcher specs (slug +
// arg-key + envelope name-paths) live in composioConfig.ts. Toolkits whose
// payloads already carry names need no adapter — the generic builder handles
// them. Adding an id-carrying toolkit = one COMPOSIO_ADAPTERS entry.

// A normalized event minus the transport-level fields (orgId / via / type /
// raw) that normalizeAndInsert fills in uniformly.
type ComposioEvent = {
  source: string;
  actor: string;
  summary: string;
  timestamp: number;
  actorRef?: { source: string; gid: string };
  rawExtras?: Record<string, unknown>;
};

// Per-toolkit ingest adapter. `slugPrefix` claims a trigger-slug namespace
// (e.g. "ASANA_"); `build` turns the payload into a normalized event.
type ComposioAdapter = {
  slugPrefix: string;
  build: (input: {
    orgId: OrgId;
    body: unknown;
    data: Record<string, unknown> | null;
    slug: string;
    composio: Composio;
  }) => Promise<ComposioEvent>;
};

// Walk a Composio tool result's `data` envelope along each key-path; the
// first path yielding a non-empty string wins. A `successful: false`
// envelope holds an error object, not the resource — bail to avoid garbage.
function extractByPaths(result: unknown, paths: string[][]): string | null {
  const outer = getRecord(result);
  if (outer && outer.successful === false) return null;
  // The REST execute endpoint double-nests the resource under `data.data`,
  // while the SDK shape single-nests under `data`. Try both bases so existing
  // fetcher paths keep working regardless of which envelope we get.
  const bases = [
    getRecord(outer?.data),
    getRecord(getRecord(outer?.data)?.data),
  ].filter((b): b is Record<string, unknown> => b !== null);
  for (const base of bases) {
    for (const path of paths) {
      let cursor: unknown = base;
      for (const key of path) {
        cursor = getRecord(cursor)?.[key];
      }
      if (typeof cursor === "string" && cursor.length > 0) return cursor;
    }
  }
  return null;
}

type ComposioIdentityResolution = {
  name: string | null;
  photoUrl: string | null;
  email: string | null;
};

type ResolveComposioIdentityOptions = {
  quiet?: boolean;
};

async function fetchComposioResource(
  orgId: OrgId,
  fetcher: ComposioFetcher,
  id: string,
  options: ResolveComposioIdentityOptions = {},
  extraArguments: Record<string, unknown> = {},
): Promise<unknown | null> {
  const logWarnings = options.quiet !== true;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    if (logWarnings) {
      console.warn("spark:composio-resolve-failed", {
        orgId,
        slug: fetcher.slug,
        id,
        error: "CONFIG: COMPOSIO_API_KEY is not configured",
      });
    }
    return null;
  }

  try {
    const resp = await fetch(
      `${COMPOSIO_BACKEND_BASE_URL}/api/v3/tools/execute/${fetcher.slug}`,
      {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: String(orgId),
          arguments: { [fetcher.argKey]: id, ...extraArguments },
          ...(fetcher.version ? { version: fetcher.version } : {}),
        }),
      },
    );
    if (!resp.ok) {
      if (logWarnings) {
        console.warn("spark:composio-resolve-failed", {
          orgId,
          slug: fetcher.slug,
          id,
          error: `REST execute returned ${resp.status}`,
        });
      }
      return null;
    }
    return resp.json();
  } catch (err) {
    if (logWarnings) {
      console.warn("spark:composio-resolve-failed", {
        orgId,
        slug: fetcher.slug,
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

// Resolve an opaque Composio id to a human name + photo URL via the
// toolkit's fetcher tool. ONE tool call; both fields extracted from the
// same result. Failures degrade to nulls so the event still inserts.
// Resolution goes through Composio's REST execute endpoint, not the SDK: the
// SDK `tools.execute` can't retrieve ASANA_GET_USER ("Unable to retrieve
// tool") regardless of toolkit-version pin, while the REST endpoint works.
// `composio` is kept in the signature for call-site compatibility but unused.
export async function resolveComposioIdentity(
  composio: Composio,
  orgId: OrgId,
  fetcher: ComposioFetcher,
  id: string,
  options: ResolveComposioIdentityOptions = {},
): Promise<ComposioIdentityResolution> {
  const empty = { name: null, photoUrl: null, email: null };
  const logWarnings = options.quiet !== true;
  const result = await fetchComposioResource(orgId, fetcher, id, options);
  if (!result) {
    return empty;
  }
  const name = extractByPaths(result, fetcher.namePaths);
  const photoUrl = extractByPaths(result, fetcher.photoPaths ?? []);
  const email = extractByPaths(result, fetcher.emailPaths ?? []);
  if (!name && logWarnings) {
    console.warn("spark:composio-resolve-no-name", {
      orgId,
      slug: fetcher.slug,
      id,
      resultKeys:
        result && typeof result === "object"
          ? Object.keys(result as Record<string, unknown>)
          : typeof result,
      resultSample: JSON.stringify(result).slice(0, 400),
    });
  }
  return { name, photoUrl, email };
}

// Resolve an opaque Composio id to a human name via the toolkit's fetcher
// tool. Failures degrade to null so the event still inserts with an id-based
// actor fallback.
async function resolveComposioName(
  composio: Composio,
  orgId: OrgId,
  fetcher: ComposioFetcher,
  id: string,
): Promise<string | null> {
  const { name } = await resolveComposioIdentity(composio, orgId, fetcher, id);
  return name;
}

// actor = resolved name, else "<source>:<id>", else bare source.
function actorOrFallback(
  name: string | null,
  source: string,
  id: string | null,
): string {
  return name ?? (id ? `${source}:${id}` : source);
}

function asanaSummary(
  slug: string,
  ctx: {
    userName: string | null;
    taskName: string | null;
    projectName: string | null;
    createdByName?: string | null;
    data: Record<string, unknown> | null;
  },
): string {
  const who = ctx.userName ?? "Someone";
  const task = ctx.taskName ? `"${ctx.taskName}"` : "a task";
  const inProject = ctx.projectName ? ` in ${ctx.projectName}` : "";

  switch (slug) {
    case "ASANA_TASK_CREATED":
      return ctx.createdByName
        ? `${ctx.createdByName} created ${task}${inProject}`
        : `${ctx.taskName ? `Task ${task}` : "A task"} was created${inProject}`;
    case "ASANA_TASK_UPDATED": {
      const field = getString(ctx.data, "change_field");
      return field
        ? `${field} changed on ${task}${inProject}`
        : `${ctx.taskName ? `Task ${task}` : "A task"} was updated${inProject}`;
    }
    case "ASANA_TASK_COMMENT_ADDED":
      return `${who} commented on ${task}${inProject}`;
    case "ASANA_TASK_ATTACHMENT_ADDED":
      return `${who} added an attachment to ${task}${inProject}`;
    case "ASANA_TASK_MOVED_TO_SECTION":
      return `${ctx.taskName ? `Task ${task}` : "A task"} moved to a section${inProject}`;
    case "ASANA_TASK_TAG_ADDED":
      return `${who} added a tag to ${task}${inProject}`;
    default:
      return slug;
  }
}

const ASANA_TASK_DETAIL_OPT_FIELDS = [
  "name",
  "created_by.gid",
  "created_by.name",
  "assignee.gid",
  "assignee.name",
] as const;

const ASANA_TASK_CREATED_BY_GID_PATHS = [
  ["created_by", "gid"],
  ["created_by", "id"],
  ["data", "created_by", "gid"],
  ["data", "created_by", "id"],
];

const ASANA_TASK_CREATED_BY_NAME_PATHS = [
  ["created_by", "name"],
  ["data", "created_by", "name"],
];

const ASANA_TASK_ASSIGNEE_GID_PATHS = [
  ["assignee", "gid"],
  ["assignee", "id"],
  ["data", "assignee", "gid"],
  ["data", "assignee", "id"],
];

const ASANA_TASK_ASSIGNEE_NAME_PATHS = [
  ["assignee", "name"],
  ["data", "assignee", "name"],
];

type AsanaTaskDetails = {
  taskName: string | null;
  createdByGid: string | null;
  createdByName: string | null;
  assigneeGid: string | null;
  assigneeName: string | null;
};

function emptyAsanaTaskDetails(): AsanaTaskDetails {
  return {
    taskName: null,
    createdByGid: null,
    createdByName: null,
    assigneeGid: null,
    assigneeName: null,
  };
}

function extractAsanaTaskDetails(result: unknown): AsanaTaskDetails {
  return {
    taskName: extractByPaths(result, ASANA_RESOURCE_FETCHERS.task.namePaths),
    createdByGid: extractByPaths(result, ASANA_TASK_CREATED_BY_GID_PATHS),
    createdByName: extractByPaths(result, ASANA_TASK_CREATED_BY_NAME_PATHS),
    assigneeGid: extractByPaths(result, ASANA_TASK_ASSIGNEE_GID_PATHS),
    assigneeName: extractByPaths(result, ASANA_TASK_ASSIGNEE_NAME_PATHS),
  };
}

async function resolveAsanaTaskDetails(
  orgId: OrgId,
  taskGid: string,
): Promise<AsanaTaskDetails> {
  const fetcher = ASANA_RESOURCE_FETCHERS.task;
  const withFields = await fetchComposioResource(
    orgId,
    fetcher,
    taskGid,
    { quiet: true },
    { opt_fields: ASANA_TASK_DETAIL_OPT_FIELDS },
  );
  let details = emptyAsanaTaskDetails();
  if (withFields) {
    details = extractAsanaTaskDetails(withFields);
    if (
      details.createdByGid ||
      details.createdByName ||
      details.assigneeGid ||
      details.assigneeName
    ) {
      return details;
    }
  }

  const fallback = await fetchComposioResource(orgId, fetcher, taskGid, {
    quiet: true,
  });
  if (!fallback) {
    return details;
  }
  const fallbackDetails = extractAsanaTaskDetails(fallback);
  return {
    taskName: details.taskName ?? fallbackDetails.taskName,
    createdByGid: details.createdByGid ?? fallbackDetails.createdByGid,
    createdByName: details.createdByName ?? fallbackDetails.createdByName,
    assigneeGid: details.assigneeGid ?? fallbackDetails.assigneeGid,
    assigneeName: details.assigneeName ?? fallbackDetails.assigneeName,
  };
}

function withSparkResolvedRaw(
  body: unknown,
  rawExtras: Record<string, unknown> | undefined,
): unknown {
  if (!rawExtras) {
    return body;
  }
  const record = getRecord(body);
  if (!record) {
    return body;
  }
  return { ...record, sparkResolved: rawExtras };
}

// Asana payloads carry user_gid / task_gid / project_gid — resolve all three
// concurrently. project_gid only appears in TASK_CREATED payloads; the other
// triggers skip that lookup. Per-field failures degrade to null.
const asanaAdapter: ComposioAdapter = {
  slugPrefix: "ASANA_",
  build: async ({ orgId, body, data, slug, composio }) => {
    const userGid = getString(data, "user_gid");
    const taskGid = getString(data, "task_gid");
    const projectGid = getString(data, "project_gid");

    const [userIdentity, taskDetails, projectName] = await Promise.all([
      userGid
        ? resolveComposioIdentity(
            composio,
            orgId,
            ASANA_RESOURCE_FETCHERS.user,
            userGid,
          )
        : Promise.resolve({ name: null, photoUrl: null, email: null }),
      taskGid
        ? resolveAsanaTaskDetails(orgId, taskGid)
        : Promise.resolve(emptyAsanaTaskDetails()),
      projectGid
        ? resolveComposioName(composio, orgId, ASANA_RESOURCE_FETCHERS.project, projectGid)
        : null,
    ]);

    const userName = userIdentity.name;
    const taskName = taskDetails.taskName;
    let actorName = userName;
    let actorGid = userGid;
    let actorSource = "trigger_user";
    if (slug === "ASANA_TASK_CREATED") {
      if (taskDetails.createdByGid || taskDetails.createdByName) {
        actorName = taskDetails.createdByName;
        actorGid = taskDetails.createdByGid;
        actorSource = "task_created_by";
        if (
          userGid &&
          taskDetails.createdByGid &&
          userGid !== taskDetails.createdByGid
        ) {
          console.warn("spark:asana-task-created-user-mismatch", {
            orgId,
            taskGid,
            triggerUserGid: userGid,
            createdByGid: taskDetails.createdByGid,
          });
        }
      } else {
        actorName = null;
        actorGid = null;
        actorSource = "neutral_missing_task_created_by";
      }
    } else if (
      slug === "ASANA_TASK_UPDATED" ||
      slug === "ASANA_TASK_MOVED_TO_SECTION"
    ) {
      actorName = null;
      actorGid = null;
      actorSource = "neutral_unverified_trigger_user";
    }

    return {
      source: "asana",
      actor: actorOrFallback(actorName, "asana", actorGid),
      actorRef: actorGid ? { source: "asana", gid: actorGid } : undefined,
      summary: asanaSummary(slug, {
        userName,
        taskName,
        projectName,
        createdByName: taskDetails.createdByName,
        data,
      }),
      timestamp:
        parseTimestamp(getString(body, "timestamp")) ??
        parseTimestamp(getString(data, "created_at")) ??
        Date.now(),
      rawExtras: {
        asana: {
          triggerSlug: slug,
          actorSource,
          triggerUser: userGid
            ? { gid: userGid, name: userName, email: userIdentity.email }
            : null,
          task: taskGid ? { gid: taskGid, name: taskName } : null,
          taskCreator:
            taskDetails.createdByGid || taskDetails.createdByName
              ? {
                  gid: taskDetails.createdByGid,
                  name: taskDetails.createdByName,
                }
              : null,
          taskAssignee:
            taskDetails.assigneeGid || taskDetails.assigneeName
              ? {
                  gid: taskDetails.assigneeGid,
                  name: taskDetails.assigneeName,
                }
              : null,
          project: projectGid ? { gid: projectGid, name: projectName } : null,
        },
      },
    };
  },
};

// Slack `ts` looks like "1778803953.453719" — seconds with µs precision.
// parseTimestamp() treats it as ISO/numeric ms and fails, so we parse here.
function parseSlackTs(ts: string | null): number | null {
  if (!ts) return null;
  const seconds = parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return Math.floor(seconds * 1000);
}

// Slack message payloads carry `user: "U..."` (an id, not a name) — resolve
// it to a human actor; the summary is just the message text.
const slackAdapter: ComposioAdapter = {
  slugPrefix: "SLACKBOT_",
  build: async ({ orgId, body, data, slug, composio }) => {
    const userId = getString(data, "user");
    const text = getString(data, "text") ?? "";
    const userName = userId
      ? await resolveComposioName(composio, orgId, SLACK_USER_FETCHER, userId)
      : null;

    return {
      source: "slack",
      actor: actorOrFallback(userName, "slack", userId),
      actorRef: userId ? { source: "slack", gid: userId } : undefined,
      summary: text.length > 0 ? text : slug,
      timestamp:
        parseTimestamp(getString(body, "timestamp")) ??
        parseSlackTs(getString(data, "ts")) ??
        Date.now(),
    };
  },
};

const COMPOSIO_ADAPTERS: ComposioAdapter[] = [asanaAdapter, slackAdapter];

// Fallback for Composio toolkits without a dedicated adapter — the path every
// new toolkit flows through with zero per-tool code. When the payload carries no
// ready-made text, classifyEvent derives a canonical {verb, object} and
// templateSummary renders a readable "{actor} {verb} {object}" line instead of a
// raw trigger slug.
function buildGenericComposioEvent(
  body: unknown,
  data: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null,
): ComposioEvent {
  const source = composioSource(body);
  const actor = composioActor(body);
  return {
    source,
    actor,
    summary:
      getString(data, "message") ??
      getString(data, "description") ??
      getString(data, "title") ??
      getString(data, "text") ??
      getString(body, "summary") ??
      templateSummary(
        classifyEvent(source, getString(metadata, "trigger_slug") ?? "", body),
        actor,
      ),
    timestamp:
      parseTimestamp(getString(body, "timestamp")) ??
      parseTimestamp(getString(data, "timestamp")) ??
      parseTimestamp(getString(body, "created_at")) ??
      parseTimestamp(getString(metadata, "created_at")) ??
      Date.now(),
  };
}

export const normalizeAndInsert = internalAction({
  args: {
    body: v.any(),
    rawBody: v.string(),
    headers: v.array(
      v.object({
        name: v.string(),
        value: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<unknown> => {
    const headers = getHeadersMap(args.headers);
    const githubEvent = headers.get("x-github-event");
    const authHeader = headers.get("authorization");
    const body = args.body;

    if (githubEvent) {
      await verifyHmacSha256({
        rawBody: args.rawBody,
        providedSignature: headers.get("x-hub-signature-256") ?? null,
        secret: process.env.GITHUB_APP_WEBHOOK_SECRET,
        prefix: "sha256=",
      });

      const installationId = getNumber(
        getRecord(getRecord(body)?.installation),
        "id",
      );
      if (installationId === null) {
        throw new Error(
          `BAD_REQUEST: GitHub App event '${githubEvent}' missing installation.id in body`,
        );
      }

      const orgId = (await ctx.runQuery(
        internal.spark.resolveOrgIdByGithubInstallationId,
        { installationId },
      )) as OrgId | null;

      if (orgId === null) {
        // Race window or stale install: GitHub fired this webhook before the
        // post-install callback linked the installation to a Spark org, or
        // the org has since unlinked. Acknowledge 200 so GitHub doesn't
        // retry-storm; the event is dropped on the floor.
        console.warn("spark:github-webhook-no-org", {
          installationId,
          githubEvent,
        });
        return null;
      }

      const sourceDeliveryId = normalizeOptionalString(
        headers.get("x-github-delivery"),
      );

      return insertGithubWebhookEvent(ctx, {
        orgId,
        githubEvent,
        sourceDeliveryId,
        body,
      });
    }

    if (getString(body, "type") === "composio.trigger.message") {
      const sourceDeliveryId = normalizeOptionalString(headers.get("webhook-id"));
      await verifyComposioWebhookSignature({
        rawBody: args.rawBody,
        webhookId: sourceDeliveryId ?? null,
        webhookTimestamp: headers.get("webhook-timestamp") ?? null,
        webhookSignature: headers.get("webhook-signature") ?? null,
      });

      const metadata = getRecord(getRecord(body)?.metadata);
      const data = getRecord(getRecord(body)?.data);
      const clerkOrgId = getString(metadata, "user_id");
      if (!clerkOrgId) {
        throw new Error("BAD_REQUEST: Composio metadata.user_id is required");
      }
      const triggerSlug = getString(metadata, "trigger_slug");

      const orgId = (await ctx.runQuery(
        internal.spark.resolveOrgIdByComposioUserId,
        {
          userId: clerkOrgId,
        },
      )) as OrgId | null;

      if (orgId === null) {
        // Race window or stale connection: Composio delivered a valid signed
        // webhook for a user/org that is no longer linked locally. Acknowledge
        // 200 so Composio doesn't retry a mapping issue it cannot repair.
        console.warn("spark:composio-webhook-no-org", {
          userId: clerkOrgId,
          triggerSlug,
          sourceDeliveryId,
        });
        return null;
      }

      // `verifyComposioWebhookSignature` above already required
      // COMPOSIO_API_KEY, so this check just narrows `string | undefined`
      // to `string`.
      const composioApiKey = process.env.COMPOSIO_API_KEY;
      if (!composioApiKey) {
        throw new Error("CONFIG: COMPOSIO_API_KEY is not configured");
      }

      // Toolkits whose payloads carry opaque ids (Asana gids, Slack user
      // ids) get a dedicated adapter that resolves human names. Everything
      // else falls through to the generic builder. Adding a toolkit = one
      // COMPOSIO_ADAPTERS entry — this dispatch never changes.
      const adapter = COMPOSIO_ADAPTERS.find((a) =>
        triggerSlug?.startsWith(a.slugPrefix),
      );
      let composioEvent: ComposioEvent;
      if (adapter) {
        // Pinning asana breaks tools.execute ("Unable to retrieve tool"); resource
        // GETs are version-stable so resolve unpinned (latest); Slack still passes
        // its per-call version via the fetcher.
        const composio = new Composio({ apiKey: composioApiKey });
        composioEvent = await adapter.build({
          orgId,
          body,
          data,
          slug: triggerSlug ?? "",
          composio,
        });
      } else {
        composioEvent = buildGenericComposioEvent(body, data, metadata);
      }
      const { rawExtras, ...eventFields } = composioEvent;

      return ctx.runMutation(internal.spark.insertEvent, {
        orgId,
        via: "composio",
        type:
          (triggerSlug && COMPOSIO_TRIGGER_TYPE_MAP[triggerSlug]) ??
          triggerSlug ??
          "trigger",
        raw: withSparkResolvedRaw(body, rawExtras),
        ...eventFields,
        ...(sourceDeliveryId ? { sourceDeliveryId } : {}),
      });
    }

    if (authHeader?.startsWith("Bearer ")) {
      const orgId = (await ctx.runAction(internal.spark.lookupOrgByApiKey, {
        bearerToken: authHeader.slice("Bearer ".length),
      })) as OrgId;

      const payload = getRecord(body);
      if (!payload) {
        throw new Error("BAD_REQUEST: API push payload must be an object");
      }

      const source = getString(payload, "source");
      const type = getString(payload, "type");
      const actor = getString(payload, "actor");
      const summary = getString(payload, "summary");
      const sourceDeliveryId = normalizeOptionalString(
        getString(payload, "sourceDeliveryId"),
      );

      if (!source || !type || !actor || !summary) {
        throw new Error(
          "BAD_REQUEST: API push requires source, type, actor, and summary",
        );
      }

      return ctx.runMutation(internal.spark.insertEvent, {
        orgId,
        source,
        via: "api",
        type,
        actor,
        summary,
        timestamp: getNumber(payload, "timestamp") ?? Date.now(),
        ...(sourceDeliveryId ? { sourceDeliveryId } : {}),
        raw: payload,
      });
    }

    throw new Error("BAD_REQUEST: unsupported ingest source");
  },
});

// Resolve a batch of opaque source ids (Asana gid / Slack user id) to
// name+photo, org-scoped. Cache-first (identityCache, TTL); Composio only
// on miss/stale. Node runtime — the public `spark.resolveIdentities` action
// delegates here so the V8 runtime never imports @composio/core.
const IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type AsanaIdentityKind = "user" | "project" | "section" | "task";

const ASANA_IDENTITY_FETCHERS: Array<{
  kind: AsanaIdentityKind;
  fetcher: ComposioFetcher;
}> = [
  { kind: "user", fetcher: ASANA_RESOURCE_FETCHERS.user },
  { kind: "project", fetcher: ASANA_RESOURCE_FETCHERS.project },
  { kind: "section", fetcher: ASANA_RESOURCE_FETCHERS.section },
  { kind: "task", fetcher: ASANA_RESOURCE_FETCHERS.task },
];

async function resolveAsanaIdentity(
  composio: Composio,
  orgId: OrgId,
  gid: string,
): Promise<ComposioIdentityResolution & { kind: AsanaIdentityKind | null }> {
  for (const candidate of ASANA_IDENTITY_FETCHERS) {
    const identity = await resolveComposioIdentity(
      composio,
      orgId,
      candidate.fetcher,
      gid,
      { quiet: true },
    );
    if (identity.name) {
      return { ...identity, kind: candidate.kind };
    }
  }

  console.warn("spark:composio-resolve-no-name", {
    orgId,
    source: "asana",
    id: gid,
    attemptedKinds: ASANA_IDENTITY_FETCHERS.map((candidate) => candidate.kind),
    attemptedSlugs: ASANA_IDENTITY_FETCHERS.map(
      (candidate) => candidate.fetcher.slug,
    ),
  });
  return { name: null, photoUrl: null, email: null, kind: null };
}

export const resolveIdentitiesForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    refs: v.array(v.object({ source: v.string(), gid: v.string() })),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      source: string;
      gid: string;
      name: string | null;
      photoUrl: string | null;
    }>
  > => {
    const uniqueKeys = new Map<string, { source: string; gid: string }>();
    for (const ref of args.refs) {
      uniqueKeys.set(`${ref.source}:${ref.gid}`, ref);
    }
    const uniqueRefs = Array.from(uniqueKeys.values());

    const cached = (await ctx.runQuery(internal.spark.getCachedIdentities, {
      orgId: args.orgId,
      refs: uniqueRefs,
    })) as Array<{
      source: string;
      gid: string;
      name?: string;
      email?: string;
      photoUrl?: string;
      fetchedAt?: number;
    }>;
    const cacheByKey = new Map(
      cached.map((c) => [`${c.source}:${c.gid}`, c]),
    );

    const now = Date.now();
    const resolved = new Map<
      string,
      { name: string | null; email: string | null; photoUrl: string | null }
    >();
    const toFetch: Array<{ source: string; gid: string }> = [];
    for (const ref of uniqueRefs) {
      const key = `${ref.source}:${ref.gid}`;
      const hit = cacheByKey.get(key);
      if (
        hit &&
        hit.fetchedAt !== undefined &&
        now - hit.fetchedAt < IDENTITY_TTL_MS
      ) {
        resolved.set(key, {
          name: hit.name ?? null,
          email: hit.email ?? null,
          photoUrl: hit.photoUrl ?? null,
        });
      } else {
        toFetch.push(ref);
      }
    }

    if (toFetch.length > 0) {
      const composioApiKey = process.env.COMPOSIO_API_KEY;
      if (!composioApiKey) {
        throw new Error("CONFIG: COMPOSIO_API_KEY is not configured");
      }
      // Pinning asana breaks tools.execute ("Unable to retrieve tool"); resource
      // GETs are version-stable so resolve unpinned (latest); Slack still passes
      // its per-call version via the fetcher.
      const composio = new Composio({ apiKey: composioApiKey });

      for (const ref of toFetch) {
        const key = `${ref.source}:${ref.gid}`;
        let identity:
          | (ComposioIdentityResolution & {
              kind: AsanaIdentityKind | "user" | null;
            })
          | null = null;
        if (ref.source === "asana") {
          identity = await resolveAsanaIdentity(composio, args.orgId, ref.gid);
        } else if (ref.source === "slack") {
          const slackIdentity = await resolveComposioIdentity(
            composio,
            args.orgId,
            SLACK_USER_FETCHER,
            ref.gid,
          );
          // Only treat it as a resolvable user when a name actually came back.
          // On a transient Composio failure (name === null) leave kind null so
          // the else-branch caches with clearEntityId instead of minting a junk
          // `slack:<id>` entity that poisons the cache for the TTL window — the
          // same way resolveAsanaIdentity returns kind: null on failure.
          identity = {
            ...slackIdentity,
            kind: slackIdentity.name ? "user" : null,
          };
        }
        if (!identity) {
          resolved.set(key, { name: null, email: null, photoUrl: null });
          continue;
        }
        const { name, email, photoUrl, kind } = identity;
        resolved.set(key, { name, email, photoUrl });
        const cacheArgs = {
          orgId: args.orgId,
          source: ref.source,
          gid: ref.gid,
          name: name ?? undefined,
          email: email ?? undefined,
          photoUrl: photoUrl ?? undefined,
          fetchedAt: Date.now(),
        };
        if (kind === "user" || kind === "project") {
          await ctx.runMutation(internal.spark.linkEntityAlias, {
            ...cacheArgs,
            kind: kind === "project" ? "project" : "person",
          });
        } else {
          await ctx.runMutation(internal.spark.upsertCachedIdentity, {
            ...cacheArgs,
            clearEntityId: true,
          });
        }
      }
    }

    return args.refs.map((ref) => {
      const key = `${ref.source}:${ref.gid}`;
      const r = resolved.get(key) ?? { name: null, email: null, photoUrl: null };
      return {
        source: ref.source,
        gid: ref.gid,
        name: r.name,
        photoUrl: r.photoUrl,
      };
    });
  },
});
