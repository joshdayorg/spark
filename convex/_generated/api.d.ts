/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as classifyEvent from "../classifyEvent.js";
import type * as composio from "../composio.js";
import type * as composioConfig from "../composioConfig.js";
import type * as crons from "../crons.js";
import type * as debug from "../debug.js";
import type * as dreamCycle from "../dreamCycle.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as ingestTimestamps from "../ingestTimestamps.js";
import type * as knowledge from "../knowledge.js";
import type * as knowledgePageVersions from "../knowledgePageVersions.js";
import type * as knowledgePublic from "../knowledgePublic.js";
import type * as mcpPushContract from "../mcpPushContract.js";
import type * as playground from "../playground.js";
import type * as search from "../search.js";
import type * as spark from "../spark.js";
import type * as sparkTools from "../sparkTools.js";
import type * as usage from "../usage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  classifyEvent: typeof classifyEvent;
  composio: typeof composio;
  composioConfig: typeof composioConfig;
  crons: typeof crons;
  debug: typeof debug;
  dreamCycle: typeof dreamCycle;
  http: typeof http;
  ingest: typeof ingest;
  ingestTimestamps: typeof ingestTimestamps;
  knowledge: typeof knowledge;
  knowledgePageVersions: typeof knowledgePageVersions;
  knowledgePublic: typeof knowledgePublic;
  mcpPushContract: typeof mcpPushContract;
  playground: typeof playground;
  search: typeof search;
  spark: typeof spark;
  sparkTools: typeof sparkTools;
  usage: typeof usage;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agent: import("@convex-dev/agent/_generated/component.js").ComponentApi<"agent">;
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
};
