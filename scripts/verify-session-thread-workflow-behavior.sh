#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="${NODE_BIN:-node}"

"$NODE_BIN" --input-type=module <<'NODE'
function fail(message) {
  console.error(`Session/thread workflow behavior proof failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    fail(`${message}\nexpected ${expectedJson}\nactual   ${actualJson}`);
  }
}

const THREADS_FOR_USER_DEFAULT_PAGE_SIZE = 25;
const THREADS_FOR_USER_MAX_PAGE_SIZE = 100;
const SESSION_GAP_MS = 30 * 60 * 1000;

function normalizeThreadPageSize(requestedPageSize) {
  const normalizedPageSize = Math.trunc(
    requestedPageSize ?? THREADS_FOR_USER_DEFAULT_PAGE_SIZE,
  );
  return Number.isFinite(normalizedPageSize)
    ? Math.max(1, Math.min(normalizedPageSize, THREADS_FOR_USER_MAX_PAGE_SIZE))
    : THREADS_FOR_USER_DEFAULT_PAGE_SIZE;
}

function listThreadsForUser({ threadOrgs, orgId, userId, paginationOpts }) {
  const numItems = normalizeThreadPageSize(paginationOpts?.numItems);
  const offset = paginationOpts?.cursor ? Number(paginationOpts.cursor) : 0;
  const matching = threadOrgs
    .filter((threadOrg) => threadOrg.orgId === orgId && threadOrg.userId === userId)
    .sort((left, right) => right.createdAt - left.createdAt);
  const pageRows = matching.slice(offset, offset + numItems);
  const nextOffset = offset + pageRows.length;
  const isDone = nextOffset >= matching.length;
  return {
    page: pageRows.map((threadOrg) => ({
      threadOrgId: threadOrg._id,
      threadId: threadOrg.threadId,
      purpose: threadOrg.purpose,
      createdAt: threadOrg.createdAt,
      ...(threadOrg.lastVisitAt !== undefined
        ? { lastVisitAt: threadOrg.lastVisitAt }
        : {}),
    })),
    isDone,
    continueCursor: isDone ? null : String(nextOffset),
  };
}

function insertThreadOrg({ threadOrgs, now, args }) {
  if (args.purpose === "pulse") {
    const existingPulseThread = threadOrgs.find(
      (threadOrg) =>
        threadOrg.orgId === args.orgId &&
        threadOrg.purpose === "pulse" &&
        threadOrg.userId === args.userId,
    );
    if (existingPulseThread) {
      return {
        threadOrgId: existingPulseThread._id,
        threadId: existingPulseThread.threadId,
        purpose: existingPulseThread.purpose,
        reused: true,
      };
    }
  }

  const threadOrg = {
    _id: `threadOrg:${threadOrgs.length + 1}`,
    threadId: args.threadId,
    orgId: args.orgId,
    userId: args.userId,
    purpose: args.purpose,
    createdAt: now,
  };
  threadOrgs.push(threadOrg);
  return {
    threadOrgId: threadOrg._id,
    threadId: threadOrg.threadId,
    purpose: threadOrg.purpose,
    reused: false,
  };
}

function createPulseThread({ threadOrgs, orgId, userId, createdThreadId, racedThread }) {
  const existingThread = threadOrgs.find(
    (threadOrg) =>
      threadOrg.orgId === orgId &&
      threadOrg.purpose === "pulse" &&
      threadOrg.userId === userId,
  );
  if (existingThread) {
    return {
      result: { threadId: existingThread.threadId, reused: true },
      deletedThreadIds: [],
    };
  }

  if (racedThread) {
    threadOrgs.push(racedThread);
  }
  const mapping = insertThreadOrg({
    threadOrgs,
    now: 1000,
    args: {
      threadId: createdThreadId,
      orgId,
      userId,
      purpose: "pulse",
    },
  });
  const deletedThreadIds =
    mapping.reused && mapping.threadId !== createdThreadId ? [createdThreadId] : [];
  return {
    result: { threadId: mapping.threadId, reused: mapping.reused },
    deletedThreadIds,
  };
}

function latestEventTimestamp(session, eventTimestamps) {
  return Math.max(session.startTime, ...(eventTimestamps[session._id] ?? []));
}

function closeStaleActiveSessions({ sessions, knowledgePages, pageVersions, eventTimestamps, now }) {
  const staleBefore = now - SESSION_GAP_MS;
  let closedCount = 0;
  let stillActiveCount = 0;
  let missingPageCount = 0;

  const candidates = sessions.filter(
    (session) => session.status === "active" && session.startTime < staleBefore,
  );
  for (const session of candidates) {
    const latestTimestamp = latestEventTimestamp(session, eventTimestamps);
    if (latestTimestamp >= staleBefore) {
      stillActiveCount += 1;
      continue;
    }

    session.status = "complete";
    session.endTime = latestTimestamp;
    const page = knowledgePages.find(
      (candidate) =>
        candidate.orgId === session.orgId && candidate.sessionId === session._id,
    );
    if (!page) {
      missingPageCount += 1;
      closedCount += 1;
      continue;
    }
    page.sessionEndTime = latestTimestamp;
    page.lastConfirmed = latestTimestamp;
    page.updatedAt = now;
    pageVersions.push({
      pageId: page._id,
      sessionEndTime: latestTimestamp,
      changeReason: "Closed stale active session",
    });
    closedCount += 1;
  }

  return {
    scannedCount: candidates.length,
    closedCount,
    stillActiveCount,
    missingPageCount,
  };
}

function latestJobExtractedPageIds({ latestJob, attributions }) {
  if (!latestJob) return [];
  return Array.from(
    new Set(
      attributions
        .filter((attribution) => attribution.sourceId === latestJob.sourceId)
        .map((attribution) => attribution.pageId),
    ),
  );
}

function failedBridgeRecoveryPlan({ latestJob, attributions }) {
  if (!latestJob || latestJob.status !== "failed") {
    return { action: "none" };
  }
  const pageIds = latestJobExtractedPageIds({ latestJob, attributions });
  return pageIds.length > 0
    ? {
        action: "recoverFailedSessionBridgeJobWithAttributions",
        jobId: latestJob._id,
        sourceId: latestJob.sourceId,
        pageIds,
      }
    : {
        action: "retryFailedSessionBridgeSource",
        jobId: latestJob._id,
        sourceId: latestJob.sourceId,
      };
}

function sweepContinuation({ isDone, continueCursor, cutoff }) {
  if (isDone || continueCursor === null) {
    return { scheduledContinuation: false, scheduled: [] };
  }
  return {
    scheduledContinuation: true,
    scheduled: [
      {
        delay: 0,
        fn: "knowledge:sweepStuckSessionBridges",
        args: { cursor: continueCursor, cutoff },
      },
    ],
  };
}

function verifyGetThreadsForUserBehavior() {
  const threadOrgs = [
    { _id: "a1", orgId: "orgA", userId: "userA", threadId: "t1", purpose: "chat", createdAt: 10 },
    { _id: "a2", orgId: "orgA", userId: "userA", threadId: "t2", purpose: "pulse", createdAt: 20 },
    { _id: "a3", orgId: "orgA", userId: "userA", threadId: "t3", purpose: "chat", createdAt: 30, lastVisitAt: 31 },
    { _id: "a4", orgId: "orgA", userId: "userA", threadId: "t4", purpose: "chat", createdAt: 40 },
    { _id: "otherOrg", orgId: "orgB", userId: "userA", threadId: "foreign-org", purpose: "chat", createdAt: 100 },
    { _id: "otherUser", orgId: "orgA", userId: "userB", threadId: "foreign-user", purpose: "chat", createdAt: 90 },
  ];

  const firstPage = listThreadsForUser({
    threadOrgs,
    orgId: "orgA",
    userId: "userA",
    paginationOpts: { numItems: 2, cursor: null },
  });
  assertDeepEqual(
    firstPage.page.map((thread) => thread.threadId),
    ["t4", "t3"],
    "thread page must be newest-first and org/user scoped",
  );
  assert(firstPage.page.every((thread) => !("orgId" in thread) && !("userId" in thread)), "thread page must not expose orgId/userId");
  assert(firstPage.isDone === false && firstPage.continueCursor === "2", "first thread page must expose a continuation cursor");

  const secondPage = listThreadsForUser({
    threadOrgs,
    orgId: "orgA",
    userId: "userA",
    paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
  });
  assertDeepEqual(
    secondPage.page.map((thread) => thread.threadId),
    ["t2", "t1"],
    "thread continuation must resume without leaking other org/user rows",
  );
  assert(secondPage.isDone === true && secondPage.continueCursor === null, "second thread page must finish pagination");
  assert(normalizeThreadPageSize(0) === 1, "thread page size must clamp low values");
  assert(normalizeThreadPageSize(500) === 100, "thread page size must clamp high values");
  assert(normalizeThreadPageSize(Number.NaN) === 25, "thread page size must fall back for NaN");
}

function verifyPulseRaceCleanupBehavior() {
  const fastPathRows = [
    { _id: "pulse-existing", orgId: "orgA", userId: "userA", threadId: "pulse-1", purpose: "pulse", createdAt: 1 },
  ];
  const fastPath = createPulseThread({
    threadOrgs: fastPathRows,
    orgId: "orgA",
    userId: "userA",
    createdThreadId: "unused-created",
  });
  assertDeepEqual(fastPath, {
    result: { threadId: "pulse-1", reused: true },
    deletedThreadIds: [],
  }, "pulse fast path must reuse an existing mapping before creating");

  const racedRows = [];
  const race = createPulseThread({
    threadOrgs: racedRows,
    orgId: "orgA",
    userId: "userA",
    createdThreadId: "losing-created-thread",
    racedThread: {
      _id: "race-winner",
      orgId: "orgA",
      userId: "userA",
      threadId: "winner-thread",
      purpose: "pulse",
      createdAt: 999,
    },
  });
  assertDeepEqual(race, {
    result: { threadId: "winner-thread", reused: true },
    deletedThreadIds: ["losing-created-thread"],
  }, "losing pulse creation must delete only the discarded created component thread");
}

function verifyStaleActiveSessionBehavior() {
  const now = 10_000_000;
  const staleBefore = now - SESSION_GAP_MS;
  const sessions = [
    { _id: "close-me", orgId: "orgA", status: "active", startTime: staleBefore - 10_000 },
    { _id: "fresh-event", orgId: "orgA", status: "active", startTime: staleBefore - 10_000 },
    { _id: "too-new", orgId: "orgA", status: "active", startTime: staleBefore + 1 },
  ];
  const knowledgePages = [
    { _id: "page-close", orgId: "orgA", sessionId: "close-me", updatedAt: 0, lastConfirmed: 0 },
    { _id: "page-fresh", orgId: "orgA", sessionId: "fresh-event", updatedAt: 0, lastConfirmed: 0 },
  ];
  const pageVersions = [];
  const result = closeStaleActiveSessions({
    sessions,
    knowledgePages,
    pageVersions,
    eventTimestamps: {
      "close-me": [staleBefore - 5000],
      "fresh-event": [staleBefore + 5000],
    },
    now,
  });

  assertDeepEqual(result, {
    scannedCount: 2,
    closedCount: 1,
    stillActiveCount: 1,
    missingPageCount: 0,
  }, "stale close sweep must close only old sessions without fresh events");
  assert(sessions.find((session) => session._id === "close-me").status === "complete", "stale session must be completed");
  assert(sessions.find((session) => session._id === "fresh-event").status === "active", "session with fresh late event must remain active");
  assert(sessions.find((session) => session._id === "too-new").status === "active", "newer active session must not be scanned");
  assertDeepEqual(pageVersions, [
    {
      pageId: "page-close",
      sessionEndTime: staleBefore - 5000,
      changeReason: "Closed stale active session",
    },
  ], "closed session page must get a versioned stale-close patch");
}

function verifyBridgeRecoveryBehavior() {
  const latestJob = { _id: "job-latest", sourceId: "source-latest", status: "failed" };
  const staleAttributions = [
    { sourceId: "source-older", pageId: "page-from-older-source" },
  ];
  assertDeepEqual(
    failedBridgeRecoveryPlan({ latestJob, attributions: staleAttributions }),
    {
      action: "retryFailedSessionBridgeSource",
      jobId: "job-latest",
      sourceId: "source-latest",
    },
    "failed latest bridge job must not recover from older source attributions",
  );

  const latestAttributions = [
    ...staleAttributions,
    { sourceId: "source-latest", pageId: "page-from-latest-source" },
    { sourceId: "source-latest", pageId: "page-from-latest-source" },
  ];
  assertDeepEqual(
    failedBridgeRecoveryPlan({ latestJob, attributions: latestAttributions }),
    {
      action: "recoverFailedSessionBridgeJobWithAttributions",
      jobId: "job-latest",
      sourceId: "source-latest",
      pageIds: ["page-from-latest-source"],
    },
    "failed latest bridge job should recover only from its own durable attributions",
  );
}

function verifyBridgeContinuationBehavior() {
  const scheduled = sweepContinuation({
    isDone: false,
    continueCursor: "cursor-2",
    cutoff: 12345,
  });
  assertDeepEqual(scheduled, {
    scheduledContinuation: true,
    scheduled: [
      {
        delay: 0,
        fn: "knowledge:sweepStuckSessionBridges",
        args: { cursor: "cursor-2", cutoff: 12345 },
      },
    ],
  }, "bridge sweep must schedule continuation with stable cursor and cutoff");

  assertDeepEqual(
    sweepContinuation({ isDone: true, continueCursor: null, cutoff: 12345 }),
    { scheduledContinuation: false, scheduled: [] },
    "bridge sweep must not schedule when pagination is done",
  );
}

verifyGetThreadsForUserBehavior();
verifyPulseRaceCleanupBehavior();
verifyStaleActiveSessionBehavior();
verifyBridgeRecoveryBehavior();
verifyBridgeContinuationBehavior();

console.log(
  "Session/thread workflow behavior proof passed: seeded runtime scenarios cover pagination, auth isolation, race cleanup, stale sessions, bridge recovery, and continuations.",
);
NODE
