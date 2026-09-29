import { hybridRank, type SearchEntry, type SearchResult } from "@convex-dev/rag";
import { CohereClient } from "cohere-ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";
import { rag } from "./knowledge";

type KnowledgePageDoc = Doc<"knowledgePages">;
type SourceChunkDoc = Doc<"sourceChunks">;

type RetryClassifier = (error: unknown) => readonly number[] | null;
type ChunkSourceKey = { sourceId: Id<"sources">; chunkIndex: number };
type ChunkAttributionMatch = {
  chunkId: Id<"sourceChunks">;
  pageId: Id<"knowledgePages">;
  excerpt: string;
};
type PageTextSearchMatch = {
  pageId: Id<"knowledgePages">;
  title: string;
  type: KnowledgePageDoc["type"];
  slug: string;
  compiledTruth: string;
};
type LiveSearchResult = {
  _id: Id<"knowledgePages">;
  title: string;
  type: KnowledgePageDoc["type"];
  snippet: string;
  score: number;
};
type Bm25ChunkSearchResult = {
  chunkId: Id<"sourceChunks">;
  score: number;
};
type ChunkSourceLookup = ChunkSourceKey & {
  chunkId: Id<"sourceChunks"> | null;
};
type RagSearchResult = {
  results: SearchResult[];
  text: string;
  entries: SearchEntry<{
    sourceType: string;
  }, Record<string, never>>[];
  usage: unknown;
};
type DeepSearchResponse = {
  results: DeepSearchResult[];
  meta: {
    bm25Count: number;
    vectorCount: number;
    fusedCount: number;
    rerankedCount: number;
    cohereSearchUnits: number;
  };
};
type DeepSearchResult = {
  pageId: Id<"knowledgePages">;
  title: string;
  type: KnowledgePageDoc["type"];
  slug: string;
  compiledTruth: string;
  relevanceScore: number;
  sourceChunkIds: Id<"sourceChunks">[];
  highlights: string[];
};
type DeepSearchCandidate =
  | {
      kind: "chunk";
      chunk: SourceChunkDoc;
      document: string;
    }
  | {
      kind: "page";
      page: PageTextSearchMatch;
      document: string;
    };

const BM25_CANDIDATE_LIMIT = 30;
const FUSED_CANDIDATE_LIMIT = 50;
const PAGE_TEXT_CANDIDATE_LIMIT = 50;
const DEEP_SEARCH_RERANK_CANDIDATE_LIMIT = FUSED_CANDIDATE_LIMIT;
const RATE_LIMIT_BACKOFF_MS = [1000, 4000, 16000] as const;
const cohere = process.env.COHERE_API_KEY
  ? new CohereClient({ token: process.env.COHERE_API_KEY })
  : null;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function getNumber(value: unknown, key: string): number | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }
  const candidate = record[key];
  return typeof candidate === "number" ? candidate : null;
}

function getString(value: unknown, key: string): string | null {
  const record = getRecord(value);
  if (!record) {
    return null;
  }
  const candidate = record[key];
  return typeof candidate === "string" ? candidate : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetriableSearchCall<T>(
  classifyRetry: RetryClassifier,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const backoff = classifyRetry(error);
      if (!backoff || attempt >= backoff.length) {
        throw error;
      }
      await sleep(backoff[attempt]);
    }
  }
}

function classifyCohereRetry(error: unknown): readonly number[] | null {
  const statusCode =
    getNumber(error, "statusCode") ??
    getNumber(error, "status") ??
    getNumber(getRecord(error)?.body, "statusCode");
  if (statusCode === 429 || (statusCode !== null && statusCode >= 500 && statusCode < 600)) {
    return RATE_LIMIT_BACKOFF_MS;
  }
  return null;
}

function isInvalidModelError(error: unknown): boolean {
  const message = [
    getString(error, "message"),
    JSON.stringify(getRecord(error)?.body ?? null),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
  return message.includes("model") && (message.includes("invalid") || message.includes("not found"));
}

function parseChunkSourceKey(key: string | undefined): ChunkSourceKey | null {
  if (!key) {
    return null;
  }
  const separatorIndex = key.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const sourceId = key.slice(0, separatorIndex) as Id<"sources">;
  const chunkIndex = Number(key.slice(separatorIndex + 1));
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return null;
  }
  return { sourceId, chunkIndex };
}

function buildHighlight(
  chunk: Pick<SourceChunkDoc, "contextPrefix" | "content">,
  excerpt: string,
): string {
  const context = chunk.contextPrefix?.trim();
  const evidence = excerpt.trim() || chunk.content.slice(0, 280).trim();
  return context ? `${context}\n\n${evidence}` : evidence;
}

function buildPageTextHighlight(page: Pick<PageTextSearchMatch, "compiledTruth">): string {
  return page.compiledTruth.slice(0, 300).trim();
}

function getFallbackPageTextScore(rank: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (total - rank) / total;
}

function getSearchScore(value: unknown, fallback: number): number {
  const score = getNumber(value, "_score");
  return score ?? fallback;
}

function buildBoundedDeepSearchRerankCandidates(args: {
  chunks: SourceChunkDoc[];
  pages: PageTextSearchMatch[];
}): DeepSearchCandidate[] {
  const chunkCandidates: DeepSearchCandidate[] = args.chunks.map((chunk) => ({
    kind: "chunk" as const,
    chunk,
    document: chunk.contextPrefix ? `${chunk.contextPrefix}\n\n${chunk.content}` : chunk.content,
  }));
  const pageCandidates: DeepSearchCandidate[] = args.pages.map((page) => ({
    kind: "page" as const,
    page,
    document: `${page.title}\n\n${page.compiledTruth}`,
  }));

  if (
    chunkCandidates.length + pageCandidates.length <=
    DEEP_SEARCH_RERANK_CANDIDATE_LIMIT
  ) {
    return [...chunkCandidates, ...pageCandidates];
  }

  const candidates: DeepSearchCandidate[] = [];
  let chunkIndex = 0;
  let pageIndex = 0;
  while (
    candidates.length < DEEP_SEARCH_RERANK_CANDIDATE_LIMIT &&
    (chunkIndex < chunkCandidates.length || pageIndex < pageCandidates.length)
  ) {
    if (chunkIndex < chunkCandidates.length) {
      candidates.push(chunkCandidates[chunkIndex]);
      chunkIndex += 1;
    }
    if (
      candidates.length < DEEP_SEARCH_RERANK_CANDIDATE_LIMIT &&
      pageIndex < pageCandidates.length
    ) {
      candidates.push(pageCandidates[pageIndex]);
      pageIndex += 1;
    }
  }
  return candidates;
}

async function rerankDocuments(args: {
  query: string;
  documents: string[];
  topN: number;
}) {
  if (!cohere) {
    throw new Error("CONFIG: COHERE_API_KEY is not configured");
  }

  for (const model of ["rerank-v4.0-pro", "rerank-v3.5"] as const) {
    try {
      return await withRetriableSearchCall(classifyCohereRetry, () =>
        cohere.v2.rerank({
          model,
          query: args.query,
          documents: args.documents,
          topN: args.topN,
        }),
      );
    } catch (error) {
      if (model === "rerank-v4.0-pro" && isInvalidModelError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("CONFIG: no supported Cohere rerank model available");
}

export const getOrgIdForThread = internalQuery({
  args: {
    threadId: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"orgs"> | null> => {
    const threadOrg = await ctx.db
      .query("threadOrgs")
      .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
      .first();
    return threadOrg?.orgId ?? null;
  },
});

export const liveSearch = internalQuery({
  args: {
    orgId: v.id("orgs"),
    query: v.string(),
    type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<LiveSearchResult[]> => {
    const queryText = args.query.trim();
    if (!queryText) {
      return [];
    }

    const limit = clamp(args.limit ?? 20, 1, 50);
    const results = await ctx.db
      .query("knowledgePages")
      .withSearchIndex("search_pages", (q) => {
        let search = q
          .search("compiledTruth", queryText)
          .eq("orgId", args.orgId)
          .eq("status", "active");
        if (args.type) {
          search = search.eq("type", args.type as KnowledgePageDoc["type"]);
        }
        return search;
      })
      .take(limit);

    return results.map((page, index) => ({
      _id: page._id,
      title: page.title,
      type: page.type,
      snippet: page.compiledTruth.slice(0, 300),
      score: getSearchScore(page, limit - index),
    }));
  },
});

export const bm25ChunkSearch = internalQuery({
  args: {
    orgId: v.id("orgs"),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Bm25ChunkSearchResult[]> => {
    const queryText = args.query.trim();
    if (!queryText) {
      return [];
    }

    const limit = clamp(args.limit ?? BM25_CANDIDATE_LIMIT, 1, BM25_CANDIDATE_LIMIT);
    const results = await ctx.db
      .query("sourceChunks")
      .withSearchIndex("search_content", (q) =>
        q.search("searchableText", queryText).eq("orgId", args.orgId),
      )
      .take(limit);

    return results.map((chunk, index) => ({
      chunkId: chunk._id,
      score: getSearchScore(chunk, limit - index),
    }));
  },
});

export const searchActiveKnowledgePages = internalQuery({
  args: {
    orgId: v.id("orgs"),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PageTextSearchMatch[]> => {
    const queryText = args.query.trim();
    if (!queryText) {
      return [];
    }

    const limit = clamp(args.limit ?? PAGE_TEXT_CANDIDATE_LIMIT, 1, PAGE_TEXT_CANDIDATE_LIMIT);
    const pages = await ctx.db
      .query("knowledgePages")
      .withSearchIndex("search_pages", (q) =>
        q
          .search("compiledTruth", queryText)
          .eq("orgId", args.orgId)
          .eq("status", "active"),
      )
      .take(limit);

    return pages.map((page) => ({
      pageId: page._id,
      title: page.title,
      type: page.type,
      slug: page.slug,
      compiledTruth: page.compiledTruth,
    }));
  },
});

export const getChunksByIds = internalQuery({
  args: {
    chunkIds: v.array(v.id("sourceChunks")),
  },
  handler: async (ctx, args): Promise<Array<SourceChunkDoc | null>> =>
    Promise.all(args.chunkIds.map((chunkId) => ctx.db.get(chunkId))),
});

export const getChunksBySourceKeys = internalQuery({
  args: {
    keys: v.array(
      v.object({
        sourceId: v.id("sources"),
        chunkIndex: v.number(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<ChunkSourceLookup[]> =>
    Promise.all(
      args.keys.map(async ({ sourceId, chunkIndex }) => {
        const chunk = await ctx.db
          .query("sourceChunks")
          .withIndex("by_source", (q) =>
            q.eq("sourceId", sourceId).eq("chunkIndex", chunkIndex),
          )
          .first();
        return { sourceId, chunkIndex, chunkId: chunk?._id ?? null };
      }),
    ),
});

export const getChunkAttributions = internalQuery({
  args: {
    chunkIds: v.array(v.id("sourceChunks")),
  },
  handler: async (ctx, args): Promise<ChunkAttributionMatch[]> => {
    const matches = await Promise.all(
      args.chunkIds.map(async (chunkId) => {
        const attributions = await ctx.db
          .query("sourceAttributions")
          .withIndex("by_chunk", (q) => q.eq("chunkId", chunkId))
          .collect();
        return attributions.map((attribution) => ({
          chunkId,
          pageId: attribution.pageId,
          excerpt: attribution.excerpt,
        }));
      }),
    );
    return matches.flat();
  },
});

export const getPagesByIds = internalQuery({
  args: {
    pageIds: v.array(v.id("knowledgePages")),
  },
  handler: async (ctx, args): Promise<Array<KnowledgePageDoc | null>> =>
    Promise.all(args.pageIds.map((pageId) => ctx.db.get(pageId))),
});

export const deepSearch = internalAction({
  args: {
    orgId: v.id("orgs"),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DeepSearchResponse> => {
    const queryText = args.query.trim();
    const limit = clamp(args.limit ?? 10, 1, 25);
    if (!queryText) {
      return {
        results: [] as DeepSearchResult[],
        meta: {
          bm25Count: 0,
          vectorCount: 0,
          fusedCount: 0,
          rerankedCount: 0,
          cohereSearchUnits: 0,
        },
      };
    }

    const [bm25Results, vectorResults, pageTextResults] = await Promise.all([
      ctx.runQuery(internal.search.bm25ChunkSearch, {
        orgId: args.orgId,
        query: queryText,
        limit: BM25_CANDIDATE_LIMIT,
      }) as Promise<Bm25ChunkSearchResult[]>,
      rag.search(ctx, {
        namespace: args.orgId,
        query: queryText,
        limit: BM25_CANDIDATE_LIMIT,
        filters: [],
      }) as Promise<RagSearchResult>,
      ctx.runQuery(internal.search.searchActiveKnowledgePages, {
        orgId: args.orgId,
        query: queryText,
        limit: PAGE_TEXT_CANDIDATE_LIMIT,
      }) as Promise<PageTextSearchMatch[]>,
    ]);

    const vectorKeyLookups = vectorResults.entries
      .map((entry) => parseChunkSourceKey(entry.key))
      .filter((value): value is ChunkSourceKey => value !== null);
    const vectorChunkMatches =
      vectorKeyLookups.length === 0
        ? []
        : ((await ctx.runQuery(internal.search.getChunksBySourceKeys, {
            keys: vectorKeyLookups,
          })) as ChunkSourceLookup[]);
    const chunkIdBySourceKey = new Map(
      vectorChunkMatches.map((match) => [
        `${match.sourceId}:${match.chunkIndex}`,
        match.chunkId,
      ]),
    );
    const entryKeyByEntryId = new Map(
      vectorResults.entries.map((entry) => [entry.entryId, entry.key]),
    );
    const vectorChunkIds = vectorResults.results
      .map((result) => {
        const key = entryKeyByEntryId.get(result.entryId);
        return key ? chunkIdBySourceKey.get(key) ?? null : null;
      })
      .filter((chunkId): chunkId is Id<"sourceChunks"> => chunkId !== null);
    const bm25ChunkIds = bm25Results.map((result) => result.chunkId);
    const fusedChunkIds = hybridRank([vectorChunkIds, bm25ChunkIds], {
      weights: [2, 1],
      k: 60,
    })
      .slice(0, FUSED_CANDIDATE_LIMIT)
      .filter((chunkId): chunkId is Id<"sourceChunks"> => typeof chunkId === "string");

    if (fusedChunkIds.length === 0 && pageTextResults.length === 0) {
      return {
        results: [] as DeepSearchResult[],
        meta: {
          bm25Count: bm25ChunkIds.length,
          vectorCount: vectorChunkIds.length,
          fusedCount: 0,
          rerankedCount: 0,
          cohereSearchUnits: 0,
        },
      };
    }

    const [chunks, chunkAttributions] =
      fusedChunkIds.length === 0
        ? [[], []]
        : await Promise.all([
            ctx.runQuery(internal.search.getChunksByIds, {
              chunkIds: fusedChunkIds,
            }) as Promise<Array<SourceChunkDoc | null>>,
            ctx.runQuery(internal.search.getChunkAttributions, {
              chunkIds: fusedChunkIds,
            }) as Promise<ChunkAttributionMatch[]>,
          ]);
    const chunkById = new Map(
      chunks
        .filter((chunk): chunk is SourceChunkDoc => chunk !== null)
        .map((chunk) => [chunk._id, chunk]),
    );
    const chunkRerankCandidates = fusedChunkIds
      .map((chunkId) => chunkById.get(chunkId))
      .filter((chunk): chunk is SourceChunkDoc => chunk !== undefined);
    const rerankCandidates = buildBoundedDeepSearchRerankCandidates({
      chunks: chunkRerankCandidates,
      pages: pageTextResults,
    });

    if (rerankCandidates.length === 0) {
      return {
        results: [] as DeepSearchResult[],
        meta: {
          bm25Count: bm25ChunkIds.length,
          vectorCount: vectorChunkIds.length,
          fusedCount: fusedChunkIds.length,
          rerankedCount: 0,
          cohereSearchUnits: 0,
        },
      };
    }

    const hasChunkRerankCandidates = rerankCandidates.some(
      (candidate) => candidate.kind === "chunk",
    );
    const reranked =
      !cohere && !hasChunkRerankCandidates
        ? {
            results: rerankCandidates.map((_candidate, index) => ({
              index,
              relevanceScore: getFallbackPageTextScore(index, rerankCandidates.length),
            })),
            meta: { billedUnits: { searchUnits: 0 } },
          }
        : await rerankDocuments({
            query: queryText,
            documents: rerankCandidates.map((candidate) => candidate.document),
            topN: rerankCandidates.length,
          });

    const rerankedChunkIds = new Set(
      rerankCandidates
        .filter((candidate): candidate is Extract<DeepSearchCandidate, { kind: "chunk" }> =>
          candidate.kind === "chunk",
        )
        .map((candidate) => candidate.chunk._id),
    );
    const rerankedChunkAttributions = chunkAttributions.filter((attribution) =>
      rerankedChunkIds.has(attribution.chunkId),
    );
    const pageIds = Array.from(
      new Set(rerankedChunkAttributions.map((attribution) => attribution.pageId)),
    );
    const pages = (await ctx.runQuery(internal.search.getPagesByIds, {
      pageIds,
    })) as Array<KnowledgePageDoc | null>;
    const pageById = new Map<Id<"knowledgePages">, KnowledgePageDoc>(
      pages
        .filter((page): page is KnowledgePageDoc => page !== null)
        .map((page): [Id<"knowledgePages">, KnowledgePageDoc] => [page._id, page]),
    );
    const attributionsByChunkId = new Map<Id<"sourceChunks">, ChunkAttributionMatch[]>();
    for (const attribution of rerankedChunkAttributions) {
      const matches = attributionsByChunkId.get(attribution.chunkId) ?? [];
      matches.push(attribution);
      attributionsByChunkId.set(attribution.chunkId, matches);
    }

    const resultsByPageId = new Map<Id<"knowledgePages">, DeepSearchResult>();
    for (const rerankedResult of reranked.results) {
      const candidate = rerankCandidates[rerankedResult.index];
      if (!candidate) {
        continue;
      }

      const relevanceScore = rerankedResult.relevanceScore;
      if (candidate.kind === "page") {
        const page = candidate.page;
        const highlight = buildPageTextHighlight(page);
        const existing = resultsByPageId.get(page.pageId);
        if (!existing) {
          resultsByPageId.set(page.pageId, {
            pageId: page.pageId,
            title: page.title,
            type: page.type,
            slug: page.slug,
            compiledTruth: page.compiledTruth,
            relevanceScore,
            sourceChunkIds: [],
            highlights: highlight ? [highlight] : [],
          });
          continue;
        }

        existing.relevanceScore = Math.max(existing.relevanceScore, relevanceScore);
        if (highlight && !existing.highlights.includes(highlight) && existing.highlights.length < 3) {
          existing.highlights.push(highlight);
        }
        continue;
      }

      const attributions = (
        attributionsByChunkId.get(candidate.chunk._id) ?? []
      ).filter((attribution) => {
        const page = pageById.get(attribution.pageId);
        return page && page.orgId === args.orgId && page.status === "active";
      });
      // A chunk attributed to many pages (e.g. one commit that touches a fact,
      // the repo, an entity, and a task) is weak per-page evidence: it matched
      // the QUERY, not "page X is the answer". Damp its contribution by the
      // fan-out so a single shared chunk can't lift every page it merely
      // mentions to the top. Page-text matches (handled above) keep their full,
      // page-specific score, so the genuinely relevant page still ranks first.
      const fanout = Math.max(1, attributions.length);
      const chunkScore = relevanceScore / Math.sqrt(fanout);
      for (const attribution of attributions) {
        const page = pageById.get(attribution.pageId);
        if (!page) {
          continue;
        }

        const highlight = buildHighlight(candidate.chunk, attribution.excerpt);
        const existing = resultsByPageId.get(page._id);
        if (!existing) {
          resultsByPageId.set(page._id, {
            pageId: page._id,
            title: page.title,
            type: page.type,
            slug: page.slug,
            compiledTruth: page.compiledTruth,
            relevanceScore: chunkScore,
            sourceChunkIds: [candidate.chunk._id],
            highlights: [highlight],
          });
          continue;
        }

        existing.relevanceScore = Math.max(existing.relevanceScore, chunkScore);
        if (!existing.sourceChunkIds.includes(candidate.chunk._id)) {
          existing.sourceChunkIds.push(candidate.chunk._id);
        }
        if (!existing.highlights.includes(highlight) && existing.highlights.length < 3) {
          existing.highlights.push(highlight);
        }
      }
    }

    const cohereSearchUnits = reranked.meta?.billedUnits?.searchUnits ?? 0;

    const results = Array.from(resultsByPageId.values())
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .slice(0, limit);

    return {
      results,
      meta: {
        bm25Count: bm25ChunkIds.length,
        vectorCount: vectorChunkIds.length,
        fusedCount: fusedChunkIds.length,
        rerankedCount: rerankCandidates.length,
        cohereSearchUnits,
      },
    };
  },
});
