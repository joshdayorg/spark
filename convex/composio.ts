"use node";

import { Composio } from "@composio/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import {
  COMPOSIO_BACKEND_BASE_URL,
  GORGIAS_FIRST_POLL_LOOKBACK_MS,
  GORGIAS_LIST_TICKETS_SLUG,
  GORGIAS_MAX_PAGES_PER_POLL,
  GORGIAS_POLL_PAGE_SIZE,
  GORGIAS_TOOLKIT_SLUG,
  GORGIAS_TOOLS_VERSION,
  SLACK_USER_FETCHER,
  SLACKBOT_TOOLS_VERSION,
  TOOLKIT_VERSIONS,
  TRIGGER_TOOLKITS,
  type TriggerToolkitKey,
} from "./composioConfig";
import { parseTimestamp } from "./ingestTimestamps";
import { resolveComposioIdentity } from "./ingest";

type ComposioSessionMcp = {
  mcpUrl: string;
  mcpHeaders: Record<string, string>;
};

const COMPOSIO_WEBHOOK_ENABLED_EVENTS = ["composio.trigger.message"];
const COMPOSIO_WEBHOOK_VERSION = "V3";
const ASANA_PROJECT_LIST_PAGE_SIZE = 100;
const ASANA_PROJECT_LIST_MAX_PAGES_PER_WORKSPACE = 20;
const COMPOSIO_TRIGGER_LIST_PAGE_SIZE = 100;
const COMPOSIO_TRIGGER_LIST_MAX_PAGES = 20;

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

function getComposioApiKey(): string | null {
  return process.env.COMPOSIO_API_KEY ?? null;
}

function getAuthConfigForToolkit(toolkit: string): string | null {
  // Per-toolkit Composio auth config overrides (custom OAuth apps).
  // Falsy → fall back to Composio's managed OAuth for that toolkit.
  const map: Record<string, string | undefined> = {
    asana: process.env.ASANA_AUTH_CONFIG_ID,
    slackbot: process.env.SLACK_AUTH_CONFIG_ID,
  };
  return map[toolkit.toLowerCase()] ?? null;
}

function getComposioClient(): Composio {
  const apiKey = getComposioApiKey();
  if (!apiKey) {
    throw new Error("CONFIG: COMPOSIO_API_KEY is not configured");
  }
  return new Composio({ apiKey, toolkitVersions: TOOLKIT_VERSIONS });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error).slice(0, 200);
  } catch {
    return String(error);
  }
}

function warnComposioReadFailure(args: {
  operation: string;
  orgId: string;
  error: unknown;
}) {
  console.warn("spark:composio-read-failed", {
    operation: args.operation,
    orgId: args.orgId,
    error: getErrorMessage(args.error),
  });
}

function isMissingActiveConnection(error: unknown): boolean {
  return getErrorMessage(error).startsWith("BAD_REQUEST: no ACTIVE ");
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      message: text,
    };
  }
}

function getArray(value: unknown, key: string): unknown[] | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }
  const candidate = record[key];
  return Array.isArray(candidate) ? candidate : null;
}

function getStringArray(value: unknown, key: string): string[] {
  return (getArray(value, key) ?? []).filter(
    (item): item is string => typeof item === "string",
  );
}

function hasSameStringSet(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((item) => right.includes(item))
  );
}

function isDesiredComposioWebhookSubscription(
  subscription: Record<string, unknown>,
  webhookUrl: string,
): boolean {
  return (
    getString(subscription, "webhook_url") === webhookUrl &&
    getString(subscription, "version") === COMPOSIO_WEBHOOK_VERSION &&
    hasSameStringSet(
      getStringArray(subscription, "enabled_events"),
      COMPOSIO_WEBHOOK_ENABLED_EVENTS,
    )
  );
}

function findComposioWebhookSubscription(
  subscriptions: unknown[],
  webhookUrl: string,
): Record<string, unknown> | null {
  const records = subscriptions
    .map((subscription) => getRecord(subscription))
    .filter((subscription): subscription is Record<string, unknown> =>
      subscription !== null,
    );
  return (
    records.find((subscription) =>
      isDesiredComposioWebhookSubscription(subscription, webhookUrl),
    ) ??
    records.find(
      (subscription) => getString(subscription, "webhook_url") === webhookUrl,
    ) ??
    // Composio v3 currently allows only one webhook subscription per project.
    // If exactly one exists with an old local/deployed URL, it is still the
    // project singleton Spark must update; avoid arbitrary selection only when
    // the list contains multiple legacy rows.
    (records.length === 1 ? records[0] : null) ??
    null
  );
}

async function listComposioWebhookSubscriptions(
  apiKey: string,
): Promise<unknown[]> {
  const listResponse = await fetch(
    `${COMPOSIO_BACKEND_BASE_URL}/api/v3/webhook_subscriptions`,
    {
      headers: { "x-api-key": apiKey },
    },
  );
  if (!listResponse.ok) {
    throw new Error(
      `BAD_REQUEST: Composio list subscriptions failed (${listResponse.status})`,
    );
  }

  const existingPayload = await parseJsonResponse(listResponse);
  return getArray(existingPayload, "items") ?? [];
}

async function updateComposioWebhookSubscription(
  apiKey: string,
  subscription: Record<string, unknown>,
  webhookUrl: string,
) {
  if (isDesiredComposioWebhookSubscription(subscription, webhookUrl)) {
    return {
      operation: "noop" as const,
      subscription,
      secret: null,
    };
  }

  const subscriptionId = getString(subscription, "id");
  if (!subscriptionId) {
    throw new Error("BAD_REQUEST: Composio subscription is missing an id");
  }

  const updateResponse = await fetch(
    `${COMPOSIO_BACKEND_BASE_URL}/api/v3/webhook_subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "PATCH",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhook_url: webhookUrl,
        enabled_events: COMPOSIO_WEBHOOK_ENABLED_EVENTS,
        version: COMPOSIO_WEBHOOK_VERSION,
      }),
    },
  );
  if (!updateResponse.ok) {
    throw new Error(
      `BAD_REQUEST: Composio update subscription failed (${updateResponse.status})`,
    );
  }

  const updatedSubscription = await parseJsonResponse(updateResponse);
  return {
    operation: "updated" as const,
    subscription: updatedSubscription,
    secret: null,
  };
}

export const createConnectLinkForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    toolkit: v.string(),
    callbackUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const org = (await ctx.runQuery(internal.spark.getOrgById, {
      orgId: args.orgId,
    })) as Doc<"orgs">;

    const composio = getComposioClient();
    const authConfigId = getAuthConfigForToolkit(args.toolkit);
    const session = authConfigId
      ? await composio.create(String(org._id), {
          authConfigs: { [args.toolkit.toLowerCase()]: authConfigId },
        })
      : await composio.create(String(org._id));
    const connectionRequest = args.callbackUrl
      ? await session.authorize(args.toolkit, { callbackUrl: args.callbackUrl })
      : await session.authorize(args.toolkit);

    return {
      redirectUrl: connectionRequest.redirectUrl,
    };
  },
});

export const createSessionForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
  },
  handler: async (ctx, args): Promise<ComposioSessionMcp | null> => {
    const composioApiKey = getComposioApiKey();
    if (!composioApiKey) {
      console.warn("spark:composioSession", {
        orgId: args.orgId,
        message: "COMPOSIO_API_KEY is not configured",
      });
      return null;
    }

    const org = (await ctx.runQuery(internal.spark.getOrgById, {
      orgId: args.orgId,
    })) as Doc<"orgs">;
    const composio = new Composio({ apiKey: composioApiKey, toolkitVersions: TOOLKIT_VERSIONS });
    const session = await composio.create(String(org._id));

    return {
      mcpUrl: session.mcp.url,
      mcpHeaders: session.mcp.headers ?? {},
    };
  },
});

export const ensureComposioWebhookSubscription = internalAction({
  args: {
    webhookUrl: v.string(),
  },
  handler: async (_ctx, args) => {
    const apiKey = getComposioApiKey();
    if (!apiKey) {
      throw new Error("CONFIG: COMPOSIO_API_KEY is not configured");
    }

    const subscriptions = await listComposioWebhookSubscriptions(apiKey);
    const existingSubscription = findComposioWebhookSubscription(
      subscriptions,
      args.webhookUrl,
    );

    if (existingSubscription) {
      return updateComposioWebhookSubscription(
        apiKey,
        existingSubscription,
        args.webhookUrl,
      );
    }

    const refreshedSubscriptions = await listComposioWebhookSubscriptions(apiKey);
    const racedSubscription = findComposioWebhookSubscription(
      refreshedSubscriptions,
      args.webhookUrl,
    );
    if (racedSubscription) {
      return updateComposioWebhookSubscription(
        apiKey,
        racedSubscription,
        args.webhookUrl,
      );
    }

    const createResponse = await fetch(
      `${COMPOSIO_BACKEND_BASE_URL}/api/v3/webhook_subscriptions`,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          webhook_url: args.webhookUrl,
          enabled_events: COMPOSIO_WEBHOOK_ENABLED_EVENTS,
          version: COMPOSIO_WEBHOOK_VERSION,
        }),
      },
    );
    if (createResponse.status === 409) {
      const conflictSubscriptions = await listComposioWebhookSubscriptions(apiKey);
      const conflictSubscription = findComposioWebhookSubscription(
        conflictSubscriptions,
        args.webhookUrl,
      );
      if (conflictSubscription) {
        return updateComposioWebhookSubscription(
          apiKey,
          conflictSubscription,
          args.webhookUrl,
        );
      }
    }
    if (!createResponse.ok) {
      throw new Error(
        `BAD_REQUEST: Composio create subscription failed (${createResponse.status})`,
      );
    }

    const createdSubscription = await parseJsonResponse(createResponse);
    const secret = getString(createdSubscription, "secret");

    return {
      operation: "created" as const,
      subscription: createdSubscription,
      secret: secret ?? null,
    };
  },
});

export const listConnectedToolkitsForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      toolkit: string;
      status: string;
      connectedAccountId: string;
      createdAt: string | null;
    }>
  > => {
    let accounts: { items?: unknown[] };
    try {
      const composio = getComposioClient();
      accounts = (await composio.connectedAccounts.list({
        userIds: [String(args.orgId)],
      })) as { items?: unknown[] };
    } catch (error) {
      warnComposioReadFailure({
        operation: "connectedToolkits.connectedAccounts.list",
        orgId: String(args.orgId),
        error,
      });
      return [];
    }

    const items = accounts.items ?? [];
    return items.map((raw) => {
      const r = raw as {
        id: string;
        status: string;
        toolkit?: { slug?: string };
        createdAt?: string;
      };
      return {
        toolkit: r.toolkit?.slug ?? "unknown",
        status: r.status,
        connectedAccountId: r.id,
        createdAt: r.createdAt ?? null,
      };
    });
  },
});

export const disconnectToolkitForOrg = internalAction({
  args: { orgId: v.id("orgs"), toolkit: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ disconnected: number; triggersDeleted: number }> => {
    const composio = getComposioClient();
    const accounts = await composio.connectedAccounts.list({
      userIds: [String(args.orgId)],
      toolkitSlugs: [args.toolkit.toUpperCase()],
    });

    const items = (accounts as { items?: Array<{ id: string }> }).items ?? [];
    let triggersDeleted = 0;
    for (const acc of items) {
      // Delete triggers tied to this connected account FIRST so they don't
      // linger as orphaned "unknown" entries in Composio after the account
      // is deleted.
      try {
        const triggers = await composio.triggers.listActive({
          connectedAccountIds: [acc.id],
        });
        const triggerItems =
          (triggers as { items?: Array<{ id: string }> }).items ?? [];
        for (const t of triggerItems) {
          try {
            await composio.triggers.delete(t.id);
            triggersDeleted += 1;
          } catch (err) {
            console.warn("spark:disconnect-trigger-delete-failed", {
              orgId: args.orgId,
              connectedAccountId: acc.id,
              triggerId: t.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        console.warn("spark:disconnect-trigger-list-failed", {
          orgId: args.orgId,
          connectedAccountId: acc.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await composio.connectedAccounts.delete(acc.id);
    }
    return { disconnected: items.length, triggersDeleted };
  },
});

// Helper: resolve a single ACTIVE connected account for (orgId, toolkit).
// Throws if missing — callers should ensure OAuth completed first.
async function getActiveConnectedAccount(
  composio: Composio,
  orgId: string,
  toolkitSlug: string,
): Promise<{ id: string }> {
  const accounts = await composio.connectedAccounts.list({
    userIds: [orgId],
    toolkitSlugs: [toolkitSlug.toUpperCase()],
  });
  const items =
    (accounts as { items?: Array<{ id: string; status: string }> }).items ?? [];
  const active = items.find((a) => a.status === "ACTIVE");
  if (!active) {
    throw new Error(
      `BAD_REQUEST: no ACTIVE ${toolkitSlug} connection for orgId=${orgId}`,
    );
  }
  return { id: active.id };
}

// Null-returning variant of getActiveConnectedAccount for list endpoints
// that degrade to an empty result when the toolkit isn't connected.
async function resolveActiveAccount(
  composio: Composio,
  orgId: string,
  toolkitSlug: string,
  operation?: string,
): Promise<{ id: string } | null> {
  try {
    return await getActiveConnectedAccount(composio, orgId, toolkitSlug);
  } catch (error) {
    if (operation && !isMissingActiveConnection(error)) {
      warnComposioReadFailure({ operation, orgId, error });
    }
    return null;
  }
}

type ActiveTrigger = {
  id: string;
  triggerName?: string;
  triggerConfig?: Record<string, string | undefined>;
};

async function listActiveTriggers(
  composio: Composio,
  connectedAccountId: string,
  triggerNames: readonly string[],
): Promise<ActiveTrigger[]> {
  const items: ActiveTrigger[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < COMPOSIO_TRIGGER_LIST_MAX_PAGES; page += 1) {
    const res = await composio.triggers.listActive({
      connectedAccountIds: [connectedAccountId],
      triggerNames: [...triggerNames],
      limit: COMPOSIO_TRIGGER_LIST_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...((res as { items?: ActiveTrigger[] }).items ?? []));

    const nextCursor =
      getString(res, "nextCursor") ?? getString(res, "next_cursor");
    if (!nextCursor) {
      return items;
    }
    cursor = nextCursor;
  }
  console.warn("spark:composio-trigger-list-truncated", {
    connectedAccountId,
    triggerNames,
    pageCount: COMPOSIO_TRIGGER_LIST_MAX_PAGES,
  });
  return items;
}

// Distinct target ids (project gids / channel ids) currently watched via
// active triggers for the toolkit.
async function listWatchedTriggerTargets(
  composio: Composio,
  orgId: string,
  toolkitKey: TriggerToolkitKey,
): Promise<{
  connectedAccountId: string | null;
  watched: string[];
  triggerCount: number;
}> {
  const tk = TRIGGER_TOOLKITS[toolkitKey];
  const active = await resolveActiveAccount(
    composio,
    orgId,
    tk.toolkitSlug,
    `${toolkitKey}.connectedAccounts.list`,
  );
  if (!active) {
    return { connectedAccountId: null, watched: [], triggerCount: 0 };
  }

  let triggers: ActiveTrigger[];
  try {
    triggers = await listActiveTriggers(composio, active.id, tk.triggerSlugs);
  } catch (error) {
    warnComposioReadFailure({
      operation: `${toolkitKey}.triggers.listActive`,
      orgId,
      error,
    });
    return { connectedAccountId: active.id, watched: [], triggerCount: 0 };
  }
  const targets = new Set<string>();
  for (const t of triggers) {
    const id = t.triggerConfig?.[tk.configKey];
    if (id) targets.add(id);
  }

  return {
    connectedAccountId: active.id,
    watched: Array.from(targets).sort(),
    triggerCount: triggers.length,
  };
}

type ReconcileEntry = { slug: string; targetId: string; triggerId: string };
type ReconcileFailure = {
  slug: string;
  targetId: string;
  op: "create" | "delete";
  error: string;
};

// Reconcile the active trigger set to the cartesian product
// (default slugs x desired target ids): create missing, delete no-longer-desired.
async function reconcileTriggers(
  composio: Composio,
  orgId: string,
  toolkitKey: TriggerToolkitKey,
  desiredIds: string[],
): Promise<{
  connectedAccountId: string;
  desired: string[];
  created: ReconcileEntry[];
  deleted: ReconcileEntry[];
  kept: number;
  failed: ReconcileFailure[];
}> {
  const tk = TRIGGER_TOOLKITS[toolkitKey];
  const desired = Array.from(new Set(desiredIds));
  const active = await getActiveConnectedAccount(composio, orgId, tk.toolkitSlug);

  const existing = await listActiveTriggers(composio, active.id, tk.triggerSlugs);

  const triggerKey = (slug: string, targetId: string) => `${slug}::${targetId}`;
  const parseTriggerKey = (key: string): [string, string] => {
    const separator = key.indexOf("::");
    return [key.slice(0, separator), key.slice(separator + 2)];
  };
  const triggersByKey = (triggers: ActiveTrigger[]) => {
    const byKey = new Map<string, string[]>();
    for (const t of triggers) {
      const slug = t.triggerName;
      const id = t.triggerConfig?.[tk.configKey];
      if (!slug || !id) continue;
      const key = triggerKey(slug, id);
      byKey.set(key, [...(byKey.get(key) ?? []), t.id]);
    }
    return byKey;
  };

  // "<slug>::<targetId>" -> every active trigger id. Tracking every id lets
  // reconciliation collapse duplicates instead of preserving one by accident.
  const existingByKey = triggersByKey(existing);
  const created: ReconcileEntry[] = [];
  const deleted: ReconcileEntry[] = [];
  const failed: ReconcileFailure[] = [];
  let kept = 0;

  async function deleteTrigger(
    slug: string,
    targetId: string,
    triggerId: string,
  ): Promise<boolean> {
    try {
      await composio.triggers.delete(triggerId);
      deleted.push({ slug, targetId, triggerId });
      return true;
    } catch (err) {
      failed.push({
        slug,
        targetId,
        op: "delete",
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async function deleteDuplicateTriggers(
    key: string,
    triggerIds: string[],
  ): Promise<void> {
    if (triggerIds.length <= 1) {
      existingByKey.set(key, triggerIds);
      return;
    }
    const [slug, targetId] = parseTriggerKey(key);
    const [keepId, ...duplicateIds] = [...triggerIds].sort();
    for (const triggerId of duplicateIds) {
      await deleteTrigger(slug, targetId, triggerId);
    }
    existingByKey.set(key, [keepId]);
  }

  const desiredKeys = new Set<string>();
  for (const slug of tk.triggerSlugs) {
    for (const id of desired) desiredKeys.add(triggerKey(slug, id));
  }

  // CREATE missing
  for (const key of desiredKeys) {
    const existingTriggerIds = existingByKey.get(key) ?? [];
    if (existingTriggerIds.length > 0) {
      kept += 1;
      await deleteDuplicateTriggers(key, existingTriggerIds);
      continue;
    }
    const [slug, targetId] = parseTriggerKey(key);
    try {
      const refreshedTriggerIds =
        triggersByKey(
          await listActiveTriggers(composio, active.id, [slug]),
        ).get(key) ?? [];
      if (refreshedTriggerIds.length > 0) {
        kept += 1;
        await deleteDuplicateTriggers(key, refreshedTriggerIds);
        continue;
      }

      const result = await composio.triggers.create(orgId, slug, {
        connectedAccountId: active.id,
        triggerConfig: tk.buildTriggerConfig(targetId, slug),
      });
      created.push({ slug, targetId, triggerId: result.triggerId });

      const postCreateTriggerIds =
        triggersByKey(
          await listActiveTriggers(composio, active.id, [slug]),
        ).get(key) ?? [result.triggerId];
      await deleteDuplicateTriggers(key, postCreateTriggerIds);
    } catch (err) {
      failed.push({
        slug,
        targetId,
        op: "create",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // DELETE no-longer-desired
  for (const [key, triggerIds] of existingByKey) {
    if (desiredKeys.has(key)) continue;
    const [slug, targetId] = parseTriggerKey(key);
    for (const triggerId of triggerIds) {
      await deleteTrigger(slug, targetId, triggerId);
    }
  }

  return { connectedAccountId: active.id, desired, created, deleted, kept, failed };
}

export const listAvailableAsanaProjectsForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    connectedAccountId: string | null;
    projects: Array<{
      gid: string;
      name: string;
      workspaceGid: string | null;
      workspaceName: string | null;
    }>;
  }> => {
    let composio: Composio;
    try {
      composio = getComposioClient();
    } catch (error) {
      warnComposioReadFailure({
        operation: "asana.composioClient",
        orgId: String(args.orgId),
        error,
      });
      return { connectedAccountId: null, projects: [] };
    }

    const active = await resolveActiveAccount(
      composio,
      String(args.orgId),
      "asana",
      "asana.connectedAccounts.list",
    );
    if (!active) {
      return { connectedAccountId: null, projects: [] };
    }

    try {
      // ASANA_GET_MULTIPLE_PROJECTS requires either `workspace` or `team`.
      // Pull the user's workspaces from ASANA_GET_CURRENT_USER (known-good
      // slug per docs/composio/asana/LEARNINGS.md), then fan out per workspace.
      const userResult = await composio.tools.execute("ASANA_GET_CURRENT_USER", {
        userId: String(args.orgId),
        arguments: {},
      });

      const userOuter = getRecord(userResult);
      if (!userOuter || userOuter.successful === false) {
        const errStr =
          getString(userOuter, "error") ??
          JSON.stringify(userOuter ?? null).slice(0, 200);
        throw new Error(`BAD_REQUEST: Asana current user failed: ${errStr}`);
      }
      // Tolerate { data: { workspaces } } and { data: { data: { workspaces } } }.
      const userDataOuter = getRecord(userOuter.data);
      const userInner = getRecord(userDataOuter?.data) ?? userDataOuter;
      const workspaceItems = getArray(userInner, "workspaces") ?? [];

      type Project = {
        gid: string;
        name: string;
        workspaceGid: string | null;
        workspaceName: string | null;
      };
      const projects: Project[] = [];

      for (const wsRaw of workspaceItems) {
        const ws = getRecord(wsRaw);
        if (!ws) continue;
        const wsGid = getString(ws, "gid");
        const wsName = getString(ws, "name");
        if (!wsGid) continue;

        let offset: string | undefined;
        for (
          let page = 0;
          page < ASANA_PROJECT_LIST_MAX_PAGES_PER_WORKSPACE;
          page += 1
        ) {
          const result = await composio.tools.execute(
            "ASANA_GET_MULTIPLE_PROJECTS",
            {
              userId: String(args.orgId),
              arguments: {
                workspace: wsGid,
                archived: false,
                limit: ASANA_PROJECT_LIST_PAGE_SIZE,
                ...(offset ? { offset } : {}),
              },
            },
          );

          const outer = getRecord(result);
          if (!outer || outer.successful === false) {
            // Skip this workspace but keep going — one workspace failing
            // (e.g. permissions) shouldn't block the others.
            console.warn("spark:asana-list-projects-workspace-failed", {
              orgId: args.orgId,
              workspaceGid: wsGid,
              error:
                getString(outer, "error") ??
                JSON.stringify(outer ?? null).slice(0, 200),
            });
            break;
          }

          const nestedData = getRecord(outer.data);
          const innerData = getRecord(nestedData?.data);
          const items =
            getArray(innerData, "data") ??
            getArray(nestedData, "data") ??
            getArray(outer, "data") ??
            [];

          for (const raw of items) {
            const r = getRecord(raw);
            if (!r) continue;
            const gid = getString(r, "gid");
            const name = getString(r, "name");
            if (!gid || !name) continue;
            const projectWs = getRecord(r.workspace);
            projects.push({
              gid,
              name,
              workspaceGid: projectWs
                ? (getString(projectWs, "gid") ?? wsGid)
                : wsGid,
              workspaceName: projectWs
                ? (getString(projectWs, "name") ?? wsName)
                : wsName,
            });
          }

          const nextOffset =
            getString(getRecord(nestedData?.next_page), "offset") ??
            getString(getRecord(innerData?.next_page), "offset") ??
            getString(getRecord(outer.next_page), "offset");
          if (!nextOffset) break;
          if (page + 1 >= ASANA_PROJECT_LIST_MAX_PAGES_PER_WORKSPACE) {
            console.warn("spark:asana-list-projects-truncated", {
              orgId: args.orgId,
              workspaceGid: wsGid,
              pageCount: ASANA_PROJECT_LIST_MAX_PAGES_PER_WORKSPACE,
            });
            break;
          }
          offset = nextOffset;
        }
      }

      projects.sort((a, b) => a.name.localeCompare(b.name));
      return { connectedAccountId: active.id, projects };
    } catch (error) {
      warnComposioReadFailure({
        operation: "asana.tools.listProjects",
        orgId: String(args.orgId),
        error,
      });
      return { connectedAccountId: active.id, projects: [] };
    }
  },
});

export const listWatchedAsanaProjectsForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    _ctx,
    args,
  ): Promise<{
    connectedAccountId: string | null;
    watchedProjects: string[];
    triggerCount: number;
  }> => {
    let composio: Composio;
    try {
      composio = getComposioClient();
    } catch (error) {
      warnComposioReadFailure({
        operation: "asana.composioClient",
        orgId: String(args.orgId),
        error,
      });
      return { connectedAccountId: null, watchedProjects: [], triggerCount: 0 };
    }

    const { connectedAccountId, watched, triggerCount } =
      await listWatchedTriggerTargets(composio, String(args.orgId), "asana");
    return { connectedAccountId, watchedProjects: watched, triggerCount };
  },
});

export const syncWatchedAsanaProjectsForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    projectGids: v.array(v.string()),
  },
  handler: async (
    _ctx,
    args,
  ): Promise<{
    connectedAccountId: string;
    desiredProjects: string[];
    created: Array<{ slug: string; projectGid: string; triggerId: string }>;
    deleted: Array<{ slug: string; projectGid: string; triggerId: string }>;
    kept: number;
    failed: Array<{
      slug: string;
      projectGid: string;
      op: "create" | "delete";
      error: string;
    }>;
  }> => {
    const result = await reconcileTriggers(
      getComposioClient(),
      String(args.orgId),
      "asana",
      args.projectGids,
    );
    const failed = result.failed.map((f) => ({
      slug: f.slug,
      projectGid: f.targetId,
      op: f.op,
      error: f.error,
    }));
    if (failed.length > 0) {
      console.warn("spark:asana-trigger-sync-partial-failure", {
        orgId: args.orgId,
        connectedAccountId: result.connectedAccountId,
        failures: failed,
      });
    }
    return {
      connectedAccountId: result.connectedAccountId,
      desiredProjects: result.desired,
      created: result.created.map((c) => ({
        slug: c.slug,
        projectGid: c.targetId,
        triggerId: c.triggerId,
      })),
      deleted: result.deleted.map((d) => ({
        slug: d.slug,
        projectGid: d.targetId,
        triggerId: d.triggerId,
      })),
      kept: result.kept,
      failed,
    };
  },
});

// ─── Slack channel triggers ──────────────────────────────────────────────────
// SLACK_LIST_ALL_CHANNELS; SLACK_RECEIVE_MESSAGE triggers get reconciled
// 1-per-channel using triggerConfig.channel = <channel_id>.

export const listAvailableSlackChannelsForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    connectedAccountId: string | null;
    channels: Array<{
      id: string;
      name: string;
      isPrivate: boolean;
    }>;
  }> => {
    let composio: Composio;
    try {
      composio = getComposioClient();
    } catch (error) {
      warnComposioReadFailure({
        operation: "slack.composioClient",
        orgId: String(args.orgId),
        error,
      });
      return { connectedAccountId: null, channels: [] };
    }

    const active = await resolveActiveAccount(
      composio,
      String(args.orgId),
      "slackbot",
      "slack.connectedAccounts.list",
    );
    if (!active) {
      return { connectedAccountId: null, channels: [] };
    }

    type SlackChannel = { id: string; name: string; isPrivate: boolean };
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;

    try {
      // Paginate through up to 5 pages (1000 channels) to stay bounded.
      for (let page = 0; page < 5; page++) {
        const result = await composio.tools.execute("SLACKBOT_LIST_ALL_CHANNELS", {
          userId: String(args.orgId),
          arguments: {
            limit: 200,
            exclude_archived: true,
            types: "public_channel,private_channel",
            ...(cursor ? { cursor } : {}),
          },
          version: SLACKBOT_TOOLS_VERSION,
        });

        const outer = getRecord(result);
        if (!outer || outer.successful === false) {
          const errStr =
            getString(outer, "error") ??
            JSON.stringify(outer ?? null).slice(0, 200);
          throw new Error(`BAD_REQUEST: Slack list channels failed: ${errStr}`);
        }

        // Envelope: { data: { data: { channels: [...], response_metadata: { next_cursor } } } }
        // Tolerate flattening at either nesting level.
        const dataOuter = getRecord(outer.data);
        const dataInner = getRecord(dataOuter?.data) ?? dataOuter;
        const items = getArray(dataInner, "channels") ?? [];

        for (const raw of items) {
          const r = getRecord(raw);
          if (!r) continue;
          const id = getString(r, "id");
          const name = getString(r, "name");
          if (!id || !name) continue;
          const isPrivate = r.is_private === true;
          channels.push({ id, name, isPrivate });
        }

        const meta = getRecord(dataInner?.response_metadata);
        const nextCursor = getString(meta, "next_cursor");
        if (!nextCursor) break;
        cursor = nextCursor;
      }

      channels.sort((a, b) => a.name.localeCompare(b.name));
      return { connectedAccountId: active.id, channels };
    } catch (error) {
      warnComposioReadFailure({
        operation: "slack.tools.listChannels",
        orgId: String(args.orgId),
        error,
      });
      return { connectedAccountId: active.id, channels: [] };
    }
  },
});

export const listWatchedSlackChannelsForOrg = internalAction({
  args: { orgId: v.id("orgs") },
  handler: async (
    _ctx,
    args,
  ): Promise<{
    connectedAccountId: string | null;
    watchedChannels: string[];
    triggerCount: number;
  }> => {
    let composio: Composio;
    try {
      composio = getComposioClient();
    } catch (error) {
      warnComposioReadFailure({
        operation: "slack.composioClient",
        orgId: String(args.orgId),
        error,
      });
      return { connectedAccountId: null, watchedChannels: [], triggerCount: 0 };
    }

    const { connectedAccountId, watched, triggerCount } =
      await listWatchedTriggerTargets(composio, String(args.orgId), "slack");
    return { connectedAccountId, watchedChannels: watched, triggerCount };
  },
});

export const syncWatchedSlackChannelsForOrg = internalAction({
  args: {
    orgId: v.id("orgs"),
    channelIds: v.array(v.string()),
  },
  handler: async (
    _ctx,
    args,
  ): Promise<{
    connectedAccountId: string;
    desiredChannels: string[];
    created: Array<{ slug: string; channelId: string; triggerId: string }>;
    deleted: Array<{ slug: string; channelId: string; triggerId: string }>;
    kept: number;
    failed: Array<{
      slug: string;
      channelId: string;
      op: "create" | "delete";
      error: string;
    }>;
    joined: string[];
    joinFailed: Array<{ channelId: string; error: string }>;
  }> => {
    const composio = getComposioClient();
    const result = await reconcileTriggers(
      composio,
      String(args.orgId),
      "slack",
      args.channelIds,
    );
    const failed = result.failed.map((f) => ({
      slug: f.slug,
      channelId: f.targetId,
      op: f.op,
      error: f.error,
    }));
    if (failed.length > 0) {
      console.warn("spark:slack-trigger-sync-partial-failure", {
        orgId: args.orgId,
        connectedAccountId: result.connectedAccountId,
        failures: failed,
      });
    }

    // Auto-join the bot to every desired channel. Slack only fires
    // `message.channels` for channels the bot is a member of; without this,
    // the trigger exists but no events flow. Idempotent — joining an
    // already-joined channel returns OK. Requires `channels:join`
    // (public) and/or `groups:write` (private) bot scopes.
    const joined: string[] = [];
    const joinFailed: Array<{ channelId: string; error: string }> = [];
    for (const channelId of result.desired) {
      try {
        const joinResult = await composio.tools.execute(
          "SLACKBOT_JOIN_AN_EXISTING_CONVERSATION",
          {
            userId: String(args.orgId),
            arguments: { channel: channelId },
            version: SLACKBOT_TOOLS_VERSION,
          },
        );
        const outer = getRecord(joinResult);
        if (outer && outer.successful === false) {
          const errStr =
            getString(outer, "error") ??
            JSON.stringify(outer ?? null).slice(0, 200);
          joinFailed.push({ channelId, error: errStr });
        } else {
          joined.push(channelId);
        }
      } catch (err) {
        joinFailed.push({
          channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (joinFailed.length > 0) {
      console.warn("spark:slack-channel-join-partial-failure", {
        orgId: args.orgId,
        connectedAccountId: result.connectedAccountId,
        failures: joinFailed,
      });
    }

    return {
      connectedAccountId: result.connectedAccountId,
      desiredChannels: result.desired,
      created: result.created.map((c) => ({
        slug: c.slug,
        channelId: c.targetId,
        triggerId: c.triggerId,
      })),
      deleted: result.deleted.map((d) => ({
        slug: d.slug,
        channelId: d.targetId,
        triggerId: d.triggerId,
      })),
      kept: result.kept,
      failed,
      joined,
      joinFailed,
    };
  },
});

// =====================
// Gorgias agent-activity poller
// =====================
// Gorgias is a tools-only Composio toolkit (no triggers), so we pull
// GORGIAS_LIST_TICKETS on a cron (newest-first) and emit one event per ticket
// changed since the watermark — the timestamp of the newest "gorgias" event
// already written (see internal.spark.getLastGorgiasUpdatedMs; no state table).
// Each event is attributed to the assigned/acting TEAM MEMBER and seeds that
// person as an entity; the customer is never read into the actor, the entity,
// or the stored payload. Re-polling is idempotent via insertEvent dedup.

function gorgiasIdString(value: unknown, key: string): string | null {
  const str = getString(value, key);
  if (str && str.trim().length > 0) return str;
  const num = getNumber(value, key);
  return num !== null ? String(num) : null;
}

function humanizeDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

// Composio's execute wraps the tool result under data.response_data (the Gorgias
// resource). For LIST it's { data: [...tickets], meta }; for GET_TICKET it's the
// ticket object itself (with an embedded `messages` array).
function gorgiasResponseData(result: unknown): Record<string, unknown> | null {
  return getRecord(getRecord(getRecord(result)?.data)?.response_data);
}

// Gorgias users carry name + firstname/lastname; prefer the display name.
function gorgiasPersonName(rec: Record<string, unknown>): string | null {
  const name = getString(rec, "name");
  if (name && name.trim().length > 0) return name.trim();
  const full = [getString(rec, "firstname"), getString(rec, "lastname")]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(" ")
    .trim();
  return full.length > 0 ? full : null;
}

// Email body_text carries the whole reply chain (quoted prior messages,
// "On <date> … wrote:" attributions, forwarded dividers, signatures). Strip
// those so only the new content is kept. Operates on the raw, line-broken body.
function cleanEmailBody(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n");
  // "On <date>, <who> wrote:" attribution (may wrap) and everything after it.
  text = text.replace(/(?:^|\n)[ \t]*On\s[\s\S]{0,300}?\bwrote:[\s\S]*$/i, "");
  // Forwarded / original-message dividers and everything after.
  text = text.replace(
    /(?:^|\n)[ \t]*-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i,
    "",
  );
  text = text.replace(/(?:^|\n)[ \t]*_{5,}[\s\S]*$/i, "");
  // Standard signature delimiter line ("-- ") and everything after.
  text = text.replace(/\n--[ \t]*\n[\s\S]*$/, "");
  // Drop any remaining quoted lines.
  text = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  // Drop a trailing "Sent from my …" footer.
  text = text.replace(/(?:^|\n)[ \t]*Sent from my [^\n]*$/i, "");
  return text.trim();
}

// Bound the per-poll GET_TICKET fan-out (each ingested ticket costs one detail
// fetch). The watermark advances to the last ingested ticket, so any overflow
// is picked up on the next run.
const GORGIAS_MAX_INGEST_PER_POLL = 40;
// Per-event conversation caps (keeps stored payloads + summaries bounded).
const GORGIAS_MSG_TEXT_MAX = 500; // chars per message body kept
const GORGIAS_MAX_MESSAGES = 30; // most-recent messages kept per ticket
const GORGIAS_SUMMARY_MAX = 4000; // total summary length (transcript included)

// Build + insert one agent-attributed activity event from a ticket. Returns
// false when there's no team-member action to attribute (customer-only ticket),
// so those are skipped entirely — no event, no entity, no customer data stored.
async function ingestGorgiasTicketActivity(
  ctx: ActionCtx,
  composio: Composio,
  orgId: Id<"orgs">,
  listTicket: Record<string, unknown>,
): Promise<boolean> {
  const ticketId = gorgiasIdString(listTicket, "id");
  if (!ticketId) return false;

  // Attribute to the assigned team member, and skip unassigned/customer-only
  // tickets here — BEFORE any detail fetch — which bounds GET_TICKET to tickets
  // an agent owns. The customer is never read.
  const assignee = getRecord(listTicket.assignee_user);
  const agentId = assignee ? gorgiasIdString(assignee, "id") : null;
  if (!agentId) return false;
  const agentName = assignee ? gorgiasPersonName(assignee) : null;
  const agentEmail = assignee ? getString(assignee, "email") : null;
  const actorName = agentName ?? agentEmail ?? `gorgias-user:${agentId}`;

  const subject = getString(listTicket, "subject") ?? "(no subject)";
  const status = getString(listTicket, "status") ?? "unknown";
  const createdMs = parseTimestamp(getString(listTicket, "created_datetime"));
  const updatedRaw = getString(listTicket, "updated_datetime");
  const updatedMs = parseTimestamp(updatedRaw) ?? Date.now();

  // The list omits `messages`, so fetch the full ticket for first-response time,
  // agent reply count, AND the body of each message (so the conversation feeds
  // knowledge). Failure degrades gracefully (no messages, response time null).
  let agentReplyCount = 0;
  let firstResponseMs: number | null = null;
  let conversation: Array<{
    from_agent: boolean;
    author: string;
    at: string | null;
    text: string;
  }> = [];
  try {
    const detail = await composio.tools.execute("GORGIAS_GET_TICKET", {
      userId: String(orgId),
      arguments: { ticket_id: Number(ticketId) },
      version: GORGIAS_TOOLS_VERSION,
    });
    const messages = (getArray(gorgiasResponseData(detail), "messages") ?? [])
      .map(getRecord)
      .filter((m): m is Record<string, unknown> => m !== null);
    const agentMessages = messages.filter((m) => m.from_agent === true);
    agentReplyCount = agentMessages.length;
    if (createdMs !== null && agentMessages.length > 0) {
      const firstAgentReplyMs = agentMessages
        .map((m) => parseTimestamp(getString(m, "created_datetime")))
        .filter((t): t is number => t !== null && t >= createdMs)
        .sort((a, b) => a - b)[0];
      if (firstAgentReplyMs !== undefined) {
        firstResponseMs = firstAgentReplyMs - createdMs;
      }
    }
    // Body of each email. Agents are named (team members); the customer is
    // labelled generically — their name/email are never stored as fields.
    for (const m of messages.slice(-GORGIAS_MAX_MESSAGES)) {
      const fromAgent = m.from_agent === true;
      const text = cleanEmailBody(getString(m, "body_text") ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, GORGIAS_MSG_TEXT_MAX);
      if (!text) continue;
      conversation.push({
        from_agent: fromAgent,
        author: fromAgent
          ? (gorgiasPersonName(getRecord(m.sender) ?? {}) ?? "Agent")
          : "Customer",
        at: getString(m, "created_datetime"),
        text,
      });
    }
  } catch {
    // keep response time null + empty conversation
  }

  // Seed the team member as a person entity (groupable cross-source by email).
  // Never the customer.
  await ctx.runMutation(internal.spark.linkEntityAlias, {
    orgId,
    source: "gorgias",
    gid: agentId,
    kind: "person",
    ...(agentName ? { name: agentName } : {}),
    ...(agentEmail ? { email: agentEmail } : {}),
    fetchedAt: Date.now(),
  });

  const parts = [`ticket #${ticketId} "${subject}" → ${status}`];
  if (firstResponseMs !== null) {
    parts.push(`first response ${humanizeDurationMs(firstResponseMs)}`);
  }
  if (agentReplyCount > 0) {
    parts.push(`${agentReplyCount} agent repl${agentReplyCount === 1 ? "y" : "ies"}`);
  }

  // Put the conversation in the summary too — the extractor reads summaries
  // untruncated (raw is capped), so this is what carries the email content into
  // knowledge. Bounded by GORGIAS_SUMMARY_MAX.
  const headline = `${actorName} — ${parts.join(", ")}`;
  const transcript = conversation.map((m) => `${m.author}: ${m.text}`).join("\n");
  const summary = (
    transcript.length > 0 ? `${headline}\n\n${transcript}` : headline
  ).slice(0, GORGIAS_SUMMARY_MAX);

  await ctx.runMutation(internal.spark.insertEvent, {
    orgId,
    source: "gorgias",
    via: "composio",
    type: `ticket_${status}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
    actor: actorName,
    actorRef: { source: "gorgias", gid: agentId },
    summary,
    timestamp: updatedMs,
    sourceDeliveryId: `gorgias:ticket:${ticketId}:${updatedRaw ?? updatedMs}`,
    raw: {
      event: "gorgias_ticket_activity",
      ticket_id: ticketId,
      subject,
      status,
      assignee: { id: agentId, name: agentName, email: agentEmail },
      created_datetime: getString(listTicket, "created_datetime"),
      updated_datetime: updatedRaw,
      first_response_ms: firstResponseMs,
      agent_reply_count: agentReplyCount,
      messages: conversation,
    },
  });
  return true;
}

export const pollGorgiasForOrg = internalAction({
  args: { orgId: v.id("orgs"), sinceDays: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ ingested: number; scanned: number; skipped?: string }> => {
    const orgId = args.orgId;
    if (!getComposioApiKey()) {
      return { ingested: 0, scanned: 0, skipped: "no-api-key" };
    }
    const composio = getComposioClient();
    const active = await resolveActiveAccount(
      composio,
      String(orgId),
      GORGIAS_TOOLKIT_SLUG,
      "gorgias.connectedAccounts.list",
    );
    if (!active) {
      return { ingested: 0, scanned: 0, skipped: "no-connection" };
    }

    // sinceDays turns this into a one-shot backfill — e.g. run
    // `pollGorgiasForOrg {orgId, sinceDays: 30}` — overriding the watermark and
    // raising the page/ingest caps. Dedup (sourceDeliveryId) keeps it idempotent.
    const isBackfill = typeof args.sinceDays === "number" && args.sinceDays > 0;
    const watermark = await ctx.runQuery(
      internal.spark.getLastGorgiasUpdatedMs,
      { orgId },
    );
    const cutoffMs = isBackfill
      ? Date.now() - (args.sinceDays ?? 0) * 86_400_000
      : (watermark ?? Date.now() - GORGIAS_FIRST_POLL_LOOKBACK_MS);
    const maxPages = isBackfill ? 40 : GORGIAS_MAX_PAGES_PER_POLL;
    const maxIngest = isBackfill ? 500 : GORGIAS_MAX_INGEST_PER_POLL;

    const toIngest: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < maxPages; page += 1) {
        const result = await composio.tools.execute(GORGIAS_LIST_TICKETS_SLUG, {
          userId: String(orgId),
          arguments: {
            order_by: "updated_datetime:desc",
            limit: GORGIAS_POLL_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          },
          version: GORGIAS_TOOLS_VERSION,
        });
        const outer = getRecord(result);
        if (outer?.successful === false) break;
        const rd = gorgiasResponseData(result); // { data: [...tickets], meta }
        const rows = getArray(rd, "data") ?? [];
        const tickets = rows
          .map(getRecord)
          .filter((t): t is Record<string, unknown> => t !== null);
        if (tickets.length === 0) break;
        const nextCursor = getString(getRecord(rd?.meta), "next_cursor");

        let reachedOld = false;
        for (const ticket of tickets) {
          const ticketUpdatedMs =
            parseTimestamp(getString(ticket, "updated_datetime")) ?? 0;
          if (ticketUpdatedMs < cutoffMs) {
            reachedOld = true; // desc order ⇒ everything after is older too
            continue;
          }
          // `>=` (not `>`) so tickets sharing the exact watermark timestamp
          // aren't skipped; the watermark ticket re-checks but dedups.
          toIngest.push(ticket);
        }
        if (reachedOld || !nextCursor) break;
        cursor = nextCursor;
      }
    } catch (error) {
      console.warn("spark:gorgias-poll-failed", {
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ingested: 0, scanned: 0, skipped: "error" };
    }

    // Oldest-first so the events-derived watermark advances monotonically.
    toIngest.sort(
      (a, b) =>
        (parseTimestamp(getString(a, "updated_datetime")) ?? 0) -
        (parseTimestamp(getString(b, "updated_datetime")) ?? 0),
    );
    // Each ingested (assigned) ticket costs one GET_TICKET; cap the fan-out and
    // let the watermark resume the rest next poll. Unassigned tickets are skipped
    // cheaply (no fetch) and don't count toward the cap.
    let ingested = 0;
    for (const ticket of toIngest) {
      if (ingested >= maxIngest) break;
      if (await ingestGorgiasTicketActivity(ctx, composio, orgId, ticket)) {
        ingested += 1;
      }
    }
    return { ingested, scanned: toIngest.length };
  },
});

export const pollGorgiasForAllOrgs = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    let cursor: string | null = null;
    let scheduled = 0;
    do {
      const page = (await ctx.runQuery(internal.spark.listOrgIdsPage, {
        paginationOpts: { numItems: 100, cursor },
      })) as { page: Id<"orgs">[]; isDone: boolean; continueCursor: string };
      for (const orgId of page.page) {
        await ctx.scheduler.runAfter(0, internal.composio.pollGorgiasForOrg, {
          orgId,
        });
        scheduled += 1;
      }
      cursor = page.isDone ? null : page.continueCursor;
    } while (cursor !== null);
    return { scheduled };
  },
});

