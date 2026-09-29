import { verifyWebhook } from "@clerk/backend/webhooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { httpRouter } from "convex/server";
import { z as z4 } from "zod/v4";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";
import { validateMcpPushPayload } from "./mcpPushContract";
import { verifyGithubInstallState } from "./spark";

const http = httpRouter();

// Self-hosted default: local development origins only. Production browser
// clients must be listed explicitly in MCP_ALLOWED_ORIGINS.
const DEFAULT_MCP_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const MCP_CORS_ALLOWED_METHODS = "POST, OPTIONS";
const MCP_CORS_MAX_AGE_SECONDS = "600";
const MCP_CORS_ALLOWED_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Mcp-Session-Id",
  "MCP-Protocol-Version",
];

type McpCorsContext = {
  hasOrigin: boolean;
  allowedOrigin: string | null;
  errorResponse: Response | null;
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getBearerTokenFromAuthorization(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function getAllowedMcpOrigins(): Set<string> {
  const configured = process.env.MCP_ALLOWED_ORIGINS;
  const origins =
    configured === undefined
      ? DEFAULT_MCP_ALLOWED_ORIGINS
      : configured
          .split(",")
          .map((origin) => origin.trim())
          // Wildcards are intentionally unsupported; ignore "*" so config fails closed.
          .filter((origin) => origin.length > 0 && origin !== "*");
  return new Set(origins);
}

function addVaryOrigin(headers: Headers): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", "Origin");
    return;
  }

  const values = existing.split(",").map((value) => value.trim().toLowerCase());
  if (values.includes("*") || values.includes("origin")) {
    return;
  }
  headers.set("Vary", `${existing}, Origin`);
}

function withMcpCors(response: Response, cors: McpCorsContext): Response {
  if (!cors.hasOrigin) {
    return response;
  }

  const headers = new Headers(response.headers);
  addVaryOrigin(headers);
  if (cors.allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", cors.allowedOrigin);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function forbiddenOriginResponse(): Response {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Forbidden Origin",
      },
      id: null,
    },
    403,
  );
}

function validateMcpCors(request: Request): McpCorsContext {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return { hasOrigin: false, allowedOrigin: null, errorResponse: null };
  }

  if (getAllowedMcpOrigins().has(origin)) {
    return { hasOrigin: true, allowedOrigin: origin, errorResponse: null };
  }

  const cors = { hasOrigin: true, allowedOrigin: null, errorResponse: null };
  return {
    ...cors,
    errorResponse: withMcpCors(forbiddenOriginResponse(), cors),
  };
}

function mcpPreflightResponse(cors: McpCorsContext): Response {
  const response = new Response(null, { status: 204 });
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Methods", MCP_CORS_ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", MCP_CORS_ALLOWED_HEADERS.join(", "));
  headers.set("Access-Control-Max-Age", MCP_CORS_MAX_AGE_SECONDS);

  return withMcpCors(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    cors,
  );
}

type McpAuth = {
  orgId: Id<"orgs">;
  kind: "managed_bearer" | "api_key";
  apiKeyId?: Id<"apiKeys">;
  authInfo: {
    token: string;
    clientId: string;
    scopes: string[];
    extra: {
      orgId: string;
      strategy: "managed_bearer" | "api_key";
      apiKeyId?: string;
    };
  };
};

type McpToolClass = "read" | "write" | "ask";
type McpRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
  bucket: string;
  count: number;
  toolClass: McpToolClass;
};

async function tryLookupManagedMcpOrgId(
  ctx: ActionCtx,
  bearerToken: string,
): Promise<{ orgId: Id<"orgs"> } | { error: string }> {
  try {
    const orgId = (await ctx.runAction(internal.spark.lookupOrgByManagedMcpToken, {
      bearerToken,
    })) as Id<"orgs">;
    return { orgId };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

async function tryLookupMcpApiKeyAuth(
  ctx: ActionCtx,
  bearerToken: string,
): Promise<{ orgId: Id<"orgs">; apiKeyId: Id<"apiKeys"> } | { error: string }> {
  try {
    return (await ctx.runAction(internal.spark.lookupMcpApiKeyAuth, {
      bearerToken,
    })) as { orgId: Id<"orgs">; apiKeyId: Id<"apiKeys"> };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
}

async function resolveMcpOrgId(
  ctx: ActionCtx,
  request: Request,
): Promise<McpAuth> {
  const authHeader = request.headers.get("authorization");
  const bearerToken = getBearerTokenFromAuthorization(authHeader);

  if (!bearerToken) {
    throw new Error("AUTH: missing bearer token");
  }

  const managedResult = await tryLookupManagedMcpOrgId(ctx, bearerToken);
  if ("orgId" in managedResult) {
    return buildMcpAuth({ orgId: managedResult.orgId, kind: "managed_bearer" });
  }

  const apiKeyResult = await tryLookupMcpApiKeyAuth(ctx, bearerToken);
  if ("orgId" in apiKeyResult) {
    return buildMcpAuth({
      orgId: apiKeyResult.orgId,
      kind: "api_key",
      apiKeyId: apiKeyResult.apiKeyId,
    });
  }

  console.warn("spark:mcpAuth", {
    strategy: "bearer_managed_then_api_key",
    managedError: managedResult.error,
    apiKeyError: apiKeyResult.error,
  });
  throw new Error("AUTH: invalid bearer token");
}

function buildMcpAuth(args: {
  orgId: Id<"orgs">;
  kind: McpAuth["kind"];
  apiKeyId?: Id<"apiKeys">;
}): McpAuth {
  const extra: McpAuth["authInfo"]["extra"] = {
    orgId: args.orgId,
    strategy: args.kind,
  };
  if (args.apiKeyId) {
    extra.apiKeyId = args.apiKeyId;
  }

  return {
    orgId: args.orgId,
    kind: args.kind,
    apiKeyId: args.apiKeyId,
    authInfo: {
      token: "spark-mcp-authenticated",
      clientId: args.orgId,
      scopes: ["spark_search", "spark_ask", "spark_entity", "spark_push"],
      extra,
    },
  };
}

function getMcpInput(payload: Record<string, unknown>): Record<string, unknown> {
  const input = getRecord(payload.input);
  if (input) {
    return input;
  }

  const fallback = { ...payload };
  delete fallback.tool;
  delete fallback.input;
  return fallback;
}

function buildDisplayName(args: {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  fallback: string;
}): string {
  const fullName = [args.firstName, args.lastName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .trim();
  return fullName || args.fallback;
}

function getPrimaryClerkEmail(args: {
  primaryEmailAddressId: string | null | undefined;
  emailAddresses:
    | ReadonlyArray<{
        id?: string | null;
        email_address?: string | null;
      }>
    | null
    | undefined;
}): string | undefined {
  if (!args.primaryEmailAddressId || !args.emailAddresses) {
    return undefined;
  }

  const primaryEmail = args.emailAddresses.find(
    (emailAddress) => emailAddress.id === args.primaryEmailAddressId,
  )?.email_address;
  const trimmed = primaryEmail?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function mapClerkRole(clerkRole: string): "admin" | "member" | "viewer" {
  if (clerkRole === "org:admin") {
    return "admin";
  }
  if (clerkRole === "org:viewer") {
    return "viewer";
  }
  return "member";
}

async function parseJsonRequest(request: Request): Promise<{
  rawBody: string;
  body: unknown;
  headers: Array<{ name: string; value: string }>;
}> {
  const rawBody = await request.text();
  let body: unknown = {};

  if (rawBody.trim().length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new Error("BAD_REQUEST: request body must be valid JSON");
    }
  }

  const headers: Array<{ name: string; value: string }> = [];
  request.headers.forEach((value, name) => {
    headers.push({ name, value });
  });

  return { rawBody, body, headers };
}

function getNonEmptyHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value && value.length > 0 ? value : null;
}

function assertAuthorizedIngestRequest(request: Request) {
  const headers = request.headers;
  const bearerToken = getBearerTokenFromAuthorization(headers.get("authorization"));
  if (bearerToken) {
    return;
  }

  if (
    getNonEmptyHeader(headers, "x-github-event") &&
    getNonEmptyHeader(headers, "x-hub-signature-256")
  ) {
    return;
  }

  if (
    getNonEmptyHeader(headers, "webhook-id") &&
    getNonEmptyHeader(headers, "webhook-timestamp") &&
    getNonEmptyHeader(headers, "webhook-signature")
  ) {
    return;
  }

  throw new Error(
    "AUTH: ingest requires a GitHub or Composio webhook signature, or an API bearer token",
  );
}

function isMcpProtocolMessage(value: unknown): boolean {
  const payload = getRecord(value);
  return (
    payload?.jsonrpc === "2.0" &&
    typeof payload.method === "string" &&
    payload.method.length > 0
  );
}

function isMcpProtocolBody(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length > 0 && body.every(isMcpProtocolMessage);
  }
  return isMcpProtocolMessage(body);
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function summarizeSearchResult(result: unknown): unknown {
  const payload = getRecord(result);
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return {
    meta: payload?.meta ?? {},
    results: results.slice(0, 5).map((entry) => {
      const record = getRecord(entry) ?? {};
      return {
        pageId: typeof record.pageId === "string" ? record.pageId : undefined,
        title: typeof record.title === "string" ? record.title : undefined,
        type: typeof record.type === "string" ? record.type : undefined,
        compiledTruth:
          typeof record.compiledTruth === "string" ? record.compiledTruth : undefined,
        relevanceScore:
          typeof record.relevanceScore === "number" ? record.relevanceScore : undefined,
        highlights: Array.isArray(record.highlights) ? record.highlights.slice(0, 3) : [],
      };
    }),
  };
}

function classifyMcpTool(tool: string): McpToolClass | null {
  switch (tool) {
    case "spark_search":
    case "spark_entity":
      return "read";
    case "spark_push":
      return "write";
    case "spark_ask":
      return "ask";
    default:
      return null;
  }
}

async function checkMcpRateLimit(
  ctx: ActionCtx,
  auth: McpAuth,
  tool: string,
): Promise<McpRateLimitResult | null> {
  if (auth.kind !== "api_key") {
    return null;
  }
  if (!auth.apiKeyId) {
    throw new Error("AUTH: invalid API key auth state");
  }

  const toolClass = classifyMcpTool(tool);
  if (!toolClass) {
    return null;
  }

  const result = (await ctx.runMutation(internal.spark.checkMcpApiKeyRateLimit, {
    orgId: auth.orgId,
    apiKeyId: auth.apiKeyId,
    toolClass,
  })) as Omit<McpRateLimitResult, "toolClass">;
  if (result.allowed) {
    return null;
  }
  return { ...result, toolClass };
}

function getRetryAfterSeconds(rateLimit: McpRateLimitResult): number {
  return Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000));
}

function mcpRateLimitPayload(tool: string, rateLimit: McpRateLimitResult) {
  return {
    code: "rate_limited",
    message: `Rate limit exceeded for ${tool}`,
    tool,
    toolClass: rateLimit.toolClass,
    limit: rateLimit.limit,
    remaining: rateLimit.remaining,
    resetAt: rateLimit.resetAt,
    retryAfterMs: rateLimit.retryAfterMs,
  };
}

function mcpRateLimitedToolResult(tool: string, rateLimit: McpRateLimitResult) {
  const error = mcpRateLimitPayload(tool, rateLimit);
  return {
    content: [
      {
        type: "text" as const,
        text: compactJson({ error }),
      },
    ],
    structuredContent: { error },
    isError: true,
  };
}

function mcpBadRequestToolResult(tool: string, error: unknown) {
  const payload = {
    error: {
      code: "bad_request",
      message: getErrorMessage(error),
      tool,
    },
  };
  return {
    content: [{ type: "text" as const, text: compactJson(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

const mcpRequiredString = z4
  .string()
  .refine((value) => value.trim().length > 0, "Required");

function mcpRateLimitHttpResponse(
  tool: string,
  rateLimit: McpRateLimitResult,
): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: mcpRateLimitPayload(tool, rateLimit),
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(getRetryAfterSeconds(rateLimit)),
      },
    },
  );
}

async function maybeMcpRateLimitHttpResponse(
  ctx: ActionCtx,
  auth: McpAuth,
  tool: string,
): Promise<Response | null> {
  const rateLimit = await checkMcpRateLimit(ctx, auth, tool);
  return rateLimit ? mcpRateLimitHttpResponse(tool, rateLimit) : null;
}

function buildSparkMcpServer(ctx: ActionCtx, auth: McpAuth): McpServer {
  const server = new McpServer({
    name: "spark-convex",
    version: "0.2.0",
  });

  server.registerTool(
    "spark_search",
    {
      title: "Spark search",
      description: "Search this Spark org's knowledge base.",
      inputSchema: z4.object({
        query: z4.string().min(1),
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ query }) => {
      const rateLimit = await checkMcpRateLimit(ctx, auth, "spark_search");
      if (rateLimit) {
        return mcpRateLimitedToolResult("spark_search", rateLimit);
      }

      const result = await ctx.runAction(internal.spark.mcpSearch, {
        orgId: auth.orgId,
        query,
      });
      const summary = summarizeSearchResult(result);
      return {
        content: [
          {
            type: "text",
            text: compactJson(summary),
          },
        ],
      };
    },
  );

  server.registerTool(
    "spark_push",
    {
      title: "Spark push",
      description: "Push a signal into this Spark org.",
      inputSchema: z4
        .object({
          source: mcpRequiredString,
          type: mcpRequiredString,
          actor: mcpRequiredString,
          summary: mcpRequiredString,
          timestamp: z4.number().refine(Number.isFinite, "Required").optional(),
          sourceDeliveryId: z4.string().min(1).optional(),
        })
        .passthrough(),
      annotations: {
        readOnlyHint: false,
      },
    },
    async (payload) => {
      try {
        validateMcpPushPayload(payload);
      } catch (error) {
        return mcpBadRequestToolResult("spark_push", error);
      }

      const rateLimit = await checkMcpRateLimit(ctx, auth, "spark_push");
      if (rateLimit) {
        return mcpRateLimitedToolResult("spark_push", rateLimit);
      }

      const eventId = await ctx.runAction(internal.spark.mcpPush, {
        orgId: auth.orgId,
        payload,
      });
      return {
        content: [
          {
            type: "text",
            text: compactJson({ eventId }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "spark_ask",
    {
      title: "Spark ask",
      description: "Ask a question against this Spark org's knowledge base.",
      inputSchema: z4.object({
        question: mcpRequiredString,
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ question }) => {
      const rateLimit = await checkMcpRateLimit(ctx, auth, "spark_ask");
      if (rateLimit) {
        return mcpRateLimitedToolResult("spark_ask", rateLimit);
      }

      const result = await ctx.runAction(internal.spark.mcpAsk, {
        orgId: auth.orgId,
        question,
      });
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : compactJson(result),
          },
        ],
      };
    },
  );

  server.registerTool(
    "spark_entity",
    {
      title: "Spark entity",
      description: "Fetch an entity from this Spark org's knowledge base.",
      inputSchema: z4.object({
        entityId: mcpRequiredString,
      }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ entityId }) => {
      const rateLimit = await checkMcpRateLimit(ctx, auth, "spark_entity");
      if (rateLimit) {
        return mcpRateLimitedToolResult("spark_entity", rateLimit);
      }

      const result = await ctx.runAction(internal.spark.mcpEntity, {
        orgId: auth.orgId,
        entityId,
      });
      return {
        content: [
          {
            type: "text",
            text: compactJson(result),
          },
        ],
      };
    },
  );

  return server;
}

async function handleMcpProtocolRequest(
  ctx: ActionCtx,
  request: Request,
  body: unknown,
  auth: McpAuth,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = buildSparkMcpServer(ctx, auth);
  await server.connect(transport);
  return transport.handleRequest(request, {
    parsedBody: body,
    authInfo: auth.authInfo,
  });
}

function mcpMethodNotAllowedResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }),
    {
      status: 405,
      headers: {
        Allow: "POST, OPTIONS",
        "Content-Type": "application/json",
      },
    },
  );
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Internal server error";

  if (message.startsWith("AUTH:")) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "unauthorized",
          message: message.slice("AUTH:".length).trim(),
        },
      },
      401,
    );
  }

  if (message.startsWith("BAD_REQUEST:")) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: message.slice("BAD_REQUEST:".length).trim(),
        },
      },
      400,
    );
  }

  console.error("spark:http", error);
  return jsonResponse(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: "Internal server error",
      },
    },
    500,
  );
}

http.route({
  path: "/ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      assertAuthorizedIngestRequest(request);
      const parsed = await parseJsonRequest(request);
      const eventId = await ctx.runAction(internal.ingest.normalizeAndInsert, parsed);

      return jsonResponse({ ok: true, eventId }, 200);
    } catch (error) {
      return errorResponse(error);
    }
  }),
});

http.route({
  path: "/clerk/webhooks",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const signingSecret = process.env.CLERK_WEBHOOK_SECRET;
      if (!signingSecret) {
        throw new Error("CONFIG: CLERK_WEBHOOK_SECRET is not configured");
      }

      let event: Awaited<ReturnType<typeof verifyWebhook>>;
      try {
        event = await verifyWebhook(request, { signingSecret });
      } catch {
        throw new Error("AUTH: invalid Clerk webhook");
      }

      switch (event.type) {
        case "organizationMembership.created":
        case "organizationMembership.updated":
          await ctx.runMutation(internal.spark.upsertTeamMember, {
            clerkOrgId: event.data.organization.id,
            clerkUserId: event.data.public_user_data.user_id,
            clerkMembershipId: event.data.id,
            clerkEventTimestamp: event.data.updated_at,
            name: buildDisplayName({
              firstName: event.data.public_user_data.first_name,
              lastName: event.data.public_user_data.last_name,
              fallback: event.data.public_user_data.identifier || "Unknown",
            }),
            email: event.data.public_user_data.identifier,
            role: mapClerkRole(event.data.role),
          });
          break;
        case "organizationMembership.deleted":
          await ctx.runMutation(internal.spark.deleteTeamMember, {
            clerkOrgId: event.data.organization.id,
            clerkUserId: event.data.public_user_data.user_id,
            clerkMembershipId: event.data.id,
            clerkEventTimestamp: event.data.updated_at,
          });
          break;
        case "user.updated": {
          const primaryEmail = getPrimaryClerkEmail({
            primaryEmailAddressId: event.data.primary_email_address_id,
            emailAddresses: event.data.email_addresses,
          });
          await ctx.runMutation(internal.spark.syncTeamMemberProfile, {
            clerkUserId: event.data.id,
            name: buildDisplayName({
              firstName: event.data.first_name,
              lastName: event.data.last_name,
              fallback: "Unknown",
            }),
            ...(primaryEmail ? { email: primaryEmail } : {}),
          });
          break;
        }
        default:
          break;
      }

      return new Response("ok", { status: 200 });
    } catch (error) {
      return errorResponse(error);
    }
  }),
});

http.route({
  path: "/mcp",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const cors = validateMcpCors(request);
    if (cors.errorResponse) {
      return cors.errorResponse;
    }
    return mcpPreflightResponse(cors);
  }),
});

http.route({
  path: "/mcp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const cors = validateMcpCors(request);
    try {
      if (cors.errorResponse) {
        return cors.errorResponse;
      }

      const auth = await resolveMcpOrgId(ctx, request);
      const { body } = await parseJsonRequest(request);

      if (isMcpProtocolBody(body)) {
        return withMcpCors(
          await handleMcpProtocolRequest(ctx, request, body, auth),
          cors,
        );
      }

      const payload = getRecord(body);
      if (!payload) {
        throw new Error("BAD_REQUEST: MCP request body must be an object");
      }

      const tool = getString(payload, "tool");
      if (!tool) {
        throw new Error("BAD_REQUEST: MCP request must include a tool");
      }

      const input = getMcpInput(payload);
      let result: unknown;

      switch (tool) {
        case "spark_search": {
          const query = getString(input, "query");
          if (!query) {
            throw new Error("BAD_REQUEST: spark_search requires input.query");
          }
          const limited = await maybeMcpRateLimitHttpResponse(ctx, auth, tool);
          if (limited) {
            return withMcpCors(limited, cors);
          }
          result = await ctx.runAction(internal.spark.mcpSearch, {
            orgId: auth.orgId,
            query,
          });
          break;
        }
        case "spark_ask": {
          const question = getString(input, "question");
          if (!question) {
            throw new Error("BAD_REQUEST: spark_ask requires input.question");
          }
          const limited = await maybeMcpRateLimitHttpResponse(ctx, auth, tool);
          if (limited) {
            return withMcpCors(limited, cors);
          }
          result = await ctx.runAction(internal.spark.mcpAsk, {
            orgId: auth.orgId,
            question,
          });
          break;
        }
        case "spark_entity": {
          const entityId = getString(input, "entityId");
          if (!entityId) {
            throw new Error("BAD_REQUEST: spark_entity requires input.entityId");
          }
          const limited = await maybeMcpRateLimitHttpResponse(ctx, auth, tool);
          if (limited) {
            return withMcpCors(limited, cors);
          }
          result = await ctx.runAction(internal.spark.mcpEntity, {
            orgId: auth.orgId,
            entityId,
          });
          break;
        }
        case "spark_push": {
          validateMcpPushPayload(input);
          const limited = await maybeMcpRateLimitHttpResponse(ctx, auth, tool);
          if (limited) {
            return withMcpCors(limited, cors);
          }
          result = await ctx.runAction(internal.spark.mcpPush, {
            orgId: auth.orgId,
            payload: input,
          });
          break;
        }
        default:
          throw new Error(`BAD_REQUEST: unsupported MCP tool ${tool}`);
      }

      return withMcpCors(jsonResponse({ ok: true, result }, 200), cors);
    } catch (error) {
      return withMcpCors(errorResponse(error), cors);
    }
  }),
});

http.route({
  path: "/mcp",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const cors = validateMcpCors(request);
    try {
      if (cors.errorResponse) {
        return cors.errorResponse;
      }

      await resolveMcpOrgId(ctx, request);
      return withMcpCors(mcpMethodNotAllowedResponse(), cors);
    } catch (error) {
      return withMcpCors(errorResponse(error), cors);
    }
  }),
});

http.route({
  path: "/mcp",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    const cors = validateMcpCors(request);
    try {
      if (cors.errorResponse) {
        return cors.errorResponse;
      }

      await resolveMcpOrgId(ctx, request);
      return withMcpCors(mcpMethodNotAllowedResponse(), cors);
    } catch (error) {
      return withMcpCors(errorResponse(error), cors);
    }
  }),
});


// GitHub App post-install callback (Setup URL). GitHub redirects here with
// ?installation_id=...&setup_action=install&state=<signed org token minted by
// createGithubInstallLink>. The signed state authorizes the link — no session
// exists on this redirect. Responds with a tiny HTML page either way.
http.route({
  path: "/github/setup",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const installationIdRaw = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");

    const html = (title: string, body: string, status: number) =>
      new Response(
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
          `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto">` +
          `<h1>${title}</h1><p>${body}</p></body>`,
        { status, headers: { "content-type": "text/html; charset=utf-8" } },
      );

    if (setupAction === "request") {
      return html(
        "Installation requested",
        "A GitHub org admin must approve the installation. Once approved, open the install link from Spark Settings again to finish linking.",
        202,
      );
    }
    if (!state || !installationIdRaw) {
      return html(
        "Missing parameters",
        "This page must be reached through GitHub's post-install redirect, starting from the install link generated in Spark Settings.",
        400,
      );
    }
    const installationId = Number(installationIdRaw);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return html("Invalid installation", "installation_id is not valid.", 400);
    }

    try {
      const orgId = await verifyGithubInstallState(state);
      await ctx.runMutation(internal.spark.linkGithubInstallationFromCallback, {
        orgId,
        installationId,
      });
      return html(
        "GitHub connected",
        "This GitHub installation is now linked to your Spark org. Events will start flowing within minutes. You can close this tab.",
        200,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("spark:githubSetupCallbackFailed", { message });
      const friendly = message.includes("expired")
        ? "The install link expired (30 minutes). Generate a fresh link in Spark Settings and try again."
        : message.includes("already linked")
          ? "This GitHub installation is already linked to a different Spark org."
          : "The install link could not be verified. Generate a fresh link in Spark Settings and try again.";
      return html("Could not link installation", friendly, 400);
    }
  }),
});

export default http;
