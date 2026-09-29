/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// Behavioral tests (convex-test) for the security-critical paths the regex
// proofs only pin textually: ingest idempotency, API-key auth, GitHub
// installation linking, usage/budget math, and scheduler claim semantics.
// "use node" modules (composio, ingest, classifyEvent) are excluded from the
// module glob — the functions under test live in spark/usage/agents/knowledge.

const modules = import.meta.glob([
  "./**/*.ts",
  "!./composio.ts",
  "!./composioConfig.ts",
  "!./ingest.ts",
  "!./classifyEvent.ts",
  "!./**/*.test.ts",
]);

function freshTest() {
  return convexTest(schema, modules);
}

async function makeOrg(t: ReturnType<typeof convexTest>, name: string) {
  return t.run(async (ctx) => {
    return ctx.db.insert("orgs", {
      clerkOrgId: `clerk:${name}`,
      name,
    });
  });
}

describe("event delivery idempotency", () => {
  test("same delivery id inserts once; distinct ids insert separately", async () => {
    const t = freshTest();
    const orgId = await makeOrg(t, "idempotency-org");
    const base = {
      orgId,
      source: "github",
      via: "webhook" as const,
      type: "push",
      actor: "maya",
      summary: "pushed a commit",
      timestamp: Date.now(),
      raw: { deliver: 1 },
    };

    await t.mutation(internal.spark.insertEvent, {
      ...base,
      sourceDeliveryId: "delivery-1",
    });
    await t.mutation(internal.spark.insertEvent, {
      ...base,
      sourceDeliveryId: "delivery-1",
    });
    await t.mutation(internal.spark.insertEvent, {
      ...base,
      sourceDeliveryId: "delivery-2",
    });

    const events = await t.run(async (ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect(),
    );
    expect(events).toHaveLength(2);
  });
});

describe("api key auth", () => {
  test("revoked keys stop resolving to an org", async () => {
    const t = freshTest();
    const orgId = await makeOrg(t, "apikey-org");
    const keyHash = "a".repeat(64);
    const apiKeyId = await t.run(async (ctx) =>
      ctx.db.insert("apiKeys", {
        orgId,
        keyHash,
        keyPrefix: "sk_test_",
        label: "behavior-test",
        createdAt: Date.now(),
        createdBy: "user_test",
      }),
    );

    const resolved = await t.mutation(internal.spark.lookupOrgByApiKeyHash, {
      keyHash,
    });
    expect(resolved).toEqual(orgId);

    await t.run(async (ctx) =>
      ctx.db.patch(apiKeyId, { revokedAt: Date.now() }),
    );
    await expect(
      t.mutation(internal.spark.lookupOrgByApiKeyHash, { keyHash }),
    ).rejects.toThrow(/AUTH/);
  });
});

describe("github installation linking", () => {
  test("callback linking rejects an installation already linked to another org", async () => {
    const t = freshTest();
    const orgA = await makeOrg(t, "org-a");
    const orgB = await makeOrg(t, "org-b");

    await t.mutation(internal.spark.linkGithubInstallationFromCallback, {
      orgId: orgA,
      installationId: 4242,
    });
    await expect(
      t.mutation(internal.spark.linkGithubInstallationFromCallback, {
        orgId: orgB,
        installationId: 4242,
      }),
    ).rejects.toThrow(/already linked/);

    // Relinking the same org is fine (idempotent for the owner).
    await t.mutation(internal.spark.linkGithubInstallationFromCallback, {
      orgId: orgA,
      installationId: 4242,
    });
  });
});

describe("usage + budget math (A-11 / U-51)", () => {
  test("sums are org- and agent-scoped and respect the window", async () => {
    const t = freshTest();
    const orgA = await makeOrg(t, "usage-a");
    const orgB = await makeOrg(t, "usage-b");

    const record = (orgId: typeof orgA, costCents: number) =>
      t.mutation(internal.usage.recordUsage, {
        orgId,
        source: "chat" as const,
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costCents,
      });

    await record(orgA, 10);
    await record(orgA, 15);
    await record(orgB, 99);

    const sumA = await t.query(internal.usage.sumUsageForOrgSince, {
      orgId: orgA,
      sinceMs: Date.now() - 60_000,
    });
    expect(sumA.costCents).toBe(25);
    expect(sumA.rows).toBe(2);
    expect(sumA.truncated).toBe(false);

    const sumFuture = await t.query(internal.usage.sumUsageForOrgSince, {
      orgId: orgA,
      sinceMs: Date.now() + 60_000,
    });
    expect(sumFuture.costCents).toBe(0);
  });
});

describe("agent scheduler claim semantics", () => {
  test("a due definition is claimed exactly once across overlapping ticks", async () => {
    const t = freshTest();
    const orgId = await makeOrg(t, "sched-org");
    await t.mutation(internal.agents.createAgentDefinition, {
      orgId,
      name: "Digest",
      description: "test digest",
      instructions: "do the digest",
      modelTier: "fast" as const,
      schedule: "hourly",
      activate: true,
    });
    // Force it due now.
    await t.run(async (ctx) => {
      const defs = await ctx.db
        .query("agentDefinitions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      await ctx.db.patch(defs[0]._id, { nextRunAt: Date.now() - 1000 });
    });

    const now = Date.now();
    const first = await t.mutation(internal.agents.claimDueAgentDefinitions, {
      now,
    });
    const second = await t.mutation(internal.agents.claimDueAgentDefinitions, {
      now,
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);

    // Claiming advanced the schedule (hourly → ~now + 1h).
    const def = await t.run(async (ctx) => ctx.db.get(first[0].agentDefinitionId));
    expect(def?.nextRunAt).toBeGreaterThan(now + 30 * 60 * 1000);
  });

  test("paused definitions are never claimed", async () => {
    const t = freshTest();
    const orgId = await makeOrg(t, "sched-paused");
    const defId = await t.mutation(internal.agents.createAgentDefinition, {
      orgId,
      name: "Paused",
      description: "paused agent",
      instructions: "noop",
      modelTier: "fast" as const,
      schedule: "hourly",
      activate: true,
    });
    await t.run(async (ctx) =>
      ctx.db.patch(defId, { nextRunAt: Date.now() - 1000 }),
    );
    await t.mutation(internal.agents.setAgentStatus, {
      orgId,
      agentDefinitionId: defId,
      status: "paused" as const,
    });
    const claimed = await t.mutation(internal.agents.claimDueAgentDefinitions, {
      now: Date.now(),
    });
    expect(claimed).toHaveLength(0);
  });
});

describe("dream finding upsert ownership", () => {
  test("dream findings need the finding-dream- namespace and re-upsert idempotently", async () => {
    const t = freshTest();
    const orgId = await makeOrg(t, "dream-org");
    const { kbId, pageId } = await t.run(async (ctx) => {
      const kbId = await ctx.db.insert("knowledgeBases", {
        orgId,
        name: "KB",
        pageCount: 1,
        sourceCount: 0,
        createdAt: Date.now(),
      });
      const pageId = await ctx.db.insert("knowledgePages", {
        orgId,
        knowledgeBaseId: kbId,
        type: "decision" as const,
        title: "REST decision",
        slug: "rest-decision",
        compiledTruth: "We chose REST.",
        evidenceTimeline: [],
        tags: [],
        confidence: "high" as const,
        lastConfirmed: Date.now(),
        sourceCount: 1,
        status: "active" as const,
        createdBy: "system",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { kbId, pageId };
    });

    const args = {
      orgId,
      slug: "finding-dream-contradiction-rest-vs-graphql",
      title: "REST decision contradicted by GraphQL work",
      compiledTruth: "Q1 says REST, Q2 builds GraphQL.",
      evidenceTimeline: [
        {
          source: "Spark Mind",
          channel: "dream-cycle",
          timestamp: Date.now(),
          content: "REST decision page vs GraphQL sessions",
        },
      ],
      tags: ["dream-cycle"],
      confidence: "high" as const,
      severity: "high" as const,
      findingType: "contradiction" as const,
      implication: "Strategy incoherence risk",
      relatedPageIds: [pageId],
      sourceAgent: "dream-cycle" as const,
    };

    const first = await t.mutation(internal.knowledge.upsertLinterFinding, args);
    expect(first.inserted).toBe(true);
    const second = await t.mutation(internal.knowledge.upsertLinterFinding, args);
    expect(second.inserted).toBe(false);

    // Wrong namespace for the owner is rejected.
    await expect(
      t.mutation(internal.knowledge.upsertLinterFinding, {
        ...args,
        slug: "finding-linter-contradiction-wrong-owner",
      }),
    ).rejects.toThrow(/finding-dream-/);
  });
});

describe("public write surface auth (orgQuery/orgMutation wrappers)", () => {
  const identityFor = (clerkOrgId: string, subject: string) => ({
    subject,
    org_id: clerkOrgId,
  });

  test("editCompiledTruth: versions as the human; rejects cross-org pages", async () => {
    const t = freshTest();
    const orgA = await makeOrg(t, "pub-edit-a");
    const orgB = await makeOrg(t, "pub-edit-b");
    const pageId = await t.run(async (ctx) => {
      const kbId = await ctx.db.insert("knowledgeBases", {
        orgId: orgA,
        name: "KB",
        pageCount: 1,
        sourceCount: 0,
        createdAt: Date.now(),
      });
      return ctx.db.insert("knowledgePages", {
        orgId: orgA,
        knowledgeBaseId: kbId,
        type: "fact" as const,
        title: "Fact",
        slug: "fact-1",
        compiledTruth: "AI wrote this.",
        evidenceTimeline: [],
        tags: [],
        confidence: "high" as const,
        lastConfirmed: Date.now(),
        sourceCount: 1,
        status: "active" as const,
        createdBy: "system",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const asA = t.withIdentity(identityFor("clerk:pub-edit-a", "user_a"));
    const result = await asA.mutation(api.knowledgePublic.editCompiledTruth, {
      pageId,
      compiledTruth: "Human refined this.",
    });
    expect(result.version).toBe(1);

    const { page, version } = await t.run(async (ctx) => {
      const page = await ctx.db.get(pageId);
      const version = await ctx.db
        .query("pageVersions")
        .withIndex("by_page", (q) => q.eq("pageId", pageId))
        .order("desc")
        .first();
      return { page, version };
    });
    expect(page?.compiledTruth).toBe("Human refined this.");
    expect(version?.changedBy).toBe("user_a");

    // A member of org B cannot edit org A's page.
    const asB = t.withIdentity(identityFor("clerk:pub-edit-b", "user_b"));
    await expect(
      asB.mutation(api.knowledgePublic.editCompiledTruth, {
        pageId,
        compiledTruth: "cross-org vandalism",
      }),
    ).rejects.toThrow(/not found for org/);
    void orgB;
  });

  test("setFindingStatus: finding-only, org-checked", async () => {
    const t = freshTest();
    const orgA = await makeOrg(t, "pub-finding-a");
    const { factId, findingId } = await t.run(async (ctx) => {
      const kbId = await ctx.db.insert("knowledgeBases", {
        orgId: orgA,
        name: "KB",
        pageCount: 2,
        sourceCount: 0,
        createdAt: Date.now(),
      });
      const base = {
        orgId: orgA,
        knowledgeBaseId: kbId,
        evidenceTimeline: [],
        tags: [],
        confidence: "high" as const,
        lastConfirmed: Date.now(),
        sourceCount: 1,
        status: "active" as const,
        createdBy: "system",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const factId = await ctx.db.insert("knowledgePages", {
        ...base,
        type: "fact" as const,
        title: "Fact",
        slug: "fact-2",
        compiledTruth: "A fact.",
      });
      const findingId = await ctx.db.insert("knowledgePages", {
        ...base,
        type: "finding" as const,
        title: "Finding",
        slug: "finding-dream-blind_spot-test",
        compiledTruth: "A finding.",
        severity: "high" as const,
        findingType: "blind_spot" as const,
        findingStatus: "new" as const,
        implication: "Look here.",
        sourceAgent: "dream-cycle",
      });
      return { factId, findingId };
    });

    const asA = t.withIdentity(identityFor("clerk:pub-finding-a", "user_a"));
    await asA.mutation(api.knowledgePublic.setFindingStatus, {
      pageId: findingId,
      findingStatus: "acknowledged" as const,
    });
    const finding = await t.run(async (ctx) => ctx.db.get(findingId));
    expect(finding?.findingStatus).toBe("acknowledged");

    await expect(
      asA.mutation(api.knowledgePublic.setFindingStatus, {
        pageId: factId,
        findingStatus: "resolved" as const,
      }),
    ).rejects.toThrow(/finding not found/);
  });

  test("listAgents: only the caller org's agents, archived hidden", async () => {
    const t = freshTest();
    const orgA = await makeOrg(t, "pub-agents-a");
    const orgB = await makeOrg(t, "pub-agents-b");
    await t.mutation(internal.agents.createAgentDefinition, {
      orgId: orgA,
      name: "A1",
      description: "a1",
      instructions: "x",
      modelTier: "fast" as const,
    });
    await t.mutation(internal.agents.createAgentDefinition, {
      orgId: orgB,
      name: "B1",
      description: "b1",
      instructions: "x",
      modelTier: "fast" as const,
    });

    const asA = t.withIdentity(identityFor("clerk:pub-agents-a", "user_a"));
    const agents = await asA.query(api.agents.listAgents, {});
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("A1");
  });
});
