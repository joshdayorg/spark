import type { Doc, Id } from "./_generated/dataModel";

export type KnowledgePageState = Omit<
  Doc<"knowledgePages">,
  "_id" | "_creationTime"
>;
type KnowledgePageSnapshot = NonNullable<Doc<"pageVersions">["snapshot"]>;
type PageVersionState = Omit<Doc<"pageVersions">, "_id" | "_creationTime">;

type PageVersionDb = {
  insert: (
    table: "pageVersions",
    value: PageVersionState,
  ) => Promise<Id<"pageVersions">>;
};

export const KNOWLEDGE_PAGE_EVIDENCE_SUMMARY_LIMIT = 25;
export const SESSION_EVENT_ID_SUMMARY_LIMIT = 100;
export const SESSION_RELATION_ID_SUMMARY_LIMIT = 100;

function takeLast<T>(items: readonly T[], limit: number): T[] {
  return items.length > limit ? items.slice(-limit) : [...items];
}

export function boundKnowledgePageEvidenceTimeline<T extends { timestamp: number }>(
  items: readonly T[],
): T[] {
  // Keep the most-recent N by time. Input may be in insertion order (e.g. a
  // backfill appends old-dated evidence "recently"), so sort before capping to
  // avoid dropping genuinely recent rows. Stored ascending; the UI re-sorts.
  const sorted = [...items].sort((a, b) => a.timestamp - b.timestamp);
  return takeLast(sorted, KNOWLEDGE_PAGE_EVIDENCE_SUMMARY_LIMIT);
}

export function boundSessionEventIds(
  eventIds: readonly Id<"events">[],
): Id<"events">[] {
  return takeLast(eventIds, SESSION_EVENT_ID_SUMMARY_LIMIT);
}

export function boundSessionRelationIds<T extends Id<"sessions"> | Id<"knowledgePages">>(
  ids: readonly T[],
): T[] {
  return takeLast(ids, SESSION_RELATION_ID_SUMMARY_LIMIT);
}

const optionalSnapshotKeys = [
  "starterQuestion",
  "starterPrompt",
  "entity",
  "identity",
  "entityId",
  "severity",
  "findingType",
  "findingStatus",
  "implication",
  "sourceAgent",
  "sourceRun",
  "owner",
  "targetDate",
  "goalStatus",
  "sessionId",
  "actor",
  "actorEntityId",
  "repo",
  "sessionStartTime",
  "sessionEndTime",
  "eventCount",
  "eventIds",
  "workType",
  "complexity",
  "skills",
  "associatedSessionIds",
  "knowledgePageIds",
  "knowledgeBridgeStatus",
  "knowledgeBridgeAttemptedAt",
  "knowledgeBridgeCompletedAt",
  "knowledgeBridgeError",
] as const satisfies readonly (keyof KnowledgePageState)[];

export function buildKnowledgePageSnapshot(
  page: KnowledgePageState | Doc<"knowledgePages">,
): KnowledgePageSnapshot {
  const snapshot: KnowledgePageSnapshot = {
    orgId: page.orgId,
    knowledgeBaseId: page.knowledgeBaseId,
    type: page.type,
    title: page.title,
    slug: page.slug,
    compiledTruth: page.compiledTruth,
    evidenceTimeline: boundKnowledgePageEvidenceTimeline(page.evidenceTimeline),
    tags: page.tags,
    confidence: page.confidence,
    lastConfirmed: page.lastConfirmed,
    sourceCount: page.sourceCount,
    status: page.status,
    createdBy: page.createdBy,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };

  for (const key of optionalSnapshotKeys) {
    const value = page[key];
    if (value !== undefined) {
      if (key === "eventIds") {
        (snapshot as Record<string, unknown>)[key] = boundSessionEventIds(
          value as Id<"events">[],
        );
      } else if (key === "associatedSessionIds") {
        (snapshot as Record<string, unknown>)[key] = boundSessionRelationIds(
          value as Id<"sessions">[],
        );
      } else if (key === "knowledgePageIds") {
        (snapshot as Record<string, unknown>)[key] = boundSessionRelationIds(
          value as Id<"knowledgePages">[],
        );
      } else {
        (snapshot as Record<string, unknown>)[key] = value;
      }
    }
  }

  return snapshot;
}

export function applyKnowledgePagePatch(
  page: KnowledgePageState | Doc<"knowledgePages">,
  patch: Partial<KnowledgePageState>,
): KnowledgePageSnapshot {
  return buildKnowledgePageSnapshot({
    ...buildKnowledgePageSnapshot(page),
    ...patch,
  } as KnowledgePageState);
}

export async function insertPageVersion(
  ctx: { db: PageVersionDb },
  args: {
    pageId: Id<"knowledgePages">;
    page: KnowledgePageState | Doc<"knowledgePages">;
    changeReason?: string;
    changedBy: string;
    sourceIds?: Id<"sources">[];
    version: number;
    createdAt: number;
  },
): Promise<Id<"pageVersions">> {
  const snapshot = buildKnowledgePageSnapshot(args.page);
  return await ctx.db.insert("pageVersions", {
    pageId: args.pageId,
    orgId: snapshot.orgId,
    title: snapshot.title,
    content: snapshot.compiledTruth,
    changeReason: args.changeReason,
    changedBy: args.changedBy,
    sourceIds: args.sourceIds,
    snapshot,
    version: args.version,
    createdAt: args.createdAt,
  });
}
