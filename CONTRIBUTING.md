# Contributing to Spark

Thanks for helping. Spark is a headless Convex backend with a strict proof
gate, so the rules below are short but firm.

## Before you start

- **Bugs and small fixes:** open a pull request. Link an issue if one exists.
- **Features, new integrations and schema changes:** open an issue at
  <https://github.com/joshdayorg/spark/issues> first. Describe the problem,
  the change you propose and the contract it touches. Wait for a maintainer
  to agree before you write the PR.
- **Security problems:** do not open an issue. Follow [SECURITY.md](./SECURITY.md).

## Set up (no accounts needed)

```bash
git clone https://github.com/joshdayorg/spark.git
cd spark
npm install
npm test                    # 72 verification scripts + behavioral tests
npm run typecheck:offline   # tsc -p convex/tsconfig.json --noEmit
```

Both gates run offline. You only need vendor accounts (see
[SETUP.md](./SETUP.md)) to run the live smoke test.

## Ground rules

- **Proof gates are the contract.** Every change must pass `npm test` and
  `npm run typecheck:offline`. CI runs both on every pull request.
  If your change legitimately alters a gated contract, update the proof
  script in a SEPARATE commit that explains why the contract moved.
- **New behavior gets a proof.** Add or extend a `scripts/verify-*.sh`
  script, or a behavioral test in `convex/behavior.test.ts`.
- **One concern per commit.** No multi-front "Updates" commits.
- **Org isolation is non-negotiable.** orgId is never a client argument.
  Public functions derive it from the Clerk JWT (orgQuery/orgMutation);
  internal functions take it explicitly. Every query on an org-scoped table
  goes through an org-prefixed index.
- **Bounded reads only.** No `.collect()` on unbounded tables, no
  `.filter()` scans on hot paths — use `.withIndex()` + `.take()`/pagination.
- **Schema changes** require a written justification in the PR description:
  what, why now, migration/rollback story.
- **Docs follow code.** If you add a table, cron or HTTP route, update
  `docs/convex-flow-audit.md`. If you read a new env var, add it to
  `.env.example`. Proof scripts check both.
- **Never commit secrets.** `.env.local` is gitignored; keep it that way.
  Run gitleaks before pushing if you touched anything config-shaped. Test
  fixtures must not look like real credentials.
- **New Composio toolkits and new external services need maintainer approval
  before the PR.**

## Where things are

- `convex/` — the entire backend (Convex functions). Start with `schema.ts`,
  `spark.ts` (auth, agents, extraction, MCP), `knowledge.ts` (ingestion →
  pages), `ingest.ts` (signal normalizer), `http.ts` (routes), `crons.ts`.
- `scripts/verify-*.sh` — the proof gates. `scripts/verify-all.sh` runs all.
- `docs/DEEP-DIVE.md` — how the knowledge model, extraction and search work.
- `docs/diagrams/` — Mermaid sources for the README diagrams.
- `docs/convex-flow-audit.md` — source-derived inventory (tables/crons/routes).
- `docs/tool-agnostic-pipeline.md` — the event taxonomy design and its
  planned next steps.
- `docs/convex-context/` — Convex platform guidance. Give it to your AI
  coding assistant when it works in `convex/`.

This repository is the source of truth for Spark's design. There is no
separate public spec: if the code, the docs and the proof scripts disagree,
open an issue.

## Workflow

1. Fork, then branch from `main`. Never force-push shared branches.
2. Make the change + its proof.
3. `npm test` + `npm run typecheck:offline` green locally.
4. PR with: what/why, the contract it touches, gate output, and a schema
   justification if any.

By contributing, you agree that your contribution is licensed under the
[MIT License](./LICENSE).
