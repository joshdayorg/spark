# Convex context docs

This folder holds reference material about the Convex platform and the Convex
components that Spark uses. It is here for two reasons:

- Contributors can read the rules that Spark's backend follows (bounded reads,
  indexes, function visibility, auth) without leaving the repository.
- If you use an AI coding assistant, you can give it these files as context
  when it works on the `convex/` folder.

These files describe Convex in general. They do not describe Spark. For Spark
itself, read the code in `convex/`, the [deep dive](../DEEP-DIVE.md) and the
[flow inventory](../convex-flow-audit.md).

## Files

| File | Topic | Source |
|------|-------|--------|
| `convex-guidelines.md` | Convex function, schema and query rules | Convex AI files (`npx convex ai-files install`); identical to `convex/_generated/ai/guidelines.md` |
| `convex-agent.md`, `convex-agent-migration.md` | `@convex-dev/agent` component | Package docs from [get-convex/agent](https://github.com/get-convex/agent) |
| `convex-rag.md` | `@convex-dev/rag` component | Package docs from [get-convex/rag](https://github.com/get-convex/rag) |
| `convex-performance-audit.md`, `convex-performance-references.md` | Convex performance review | Convex agent skill guidance from Convex AI files |
| `convex-clerk-auth.md` | Convex + Clerk auth | Convex auth skill reference from Convex AI files |

The upstream projects own this material and its license terms. Spark's MIT
license covers Spark's own code, not these copies.

## Which file to use

| You are working on | Read |
|--------------------|------|
| HTTP routes, MCP, public functions | `convex-guidelines.md` |
| Schema, indexes, search | `convex-guidelines.md`, `convex-rag.md` |
| Chat agent and tools | `convex-agent.md`, `convex-agent-migration.md` |
| Performance or write conflicts | `convex-performance-audit.md`, `convex-performance-references.md` |
| Auth | `convex-clerk-auth.md`, `convex-guidelines.md` |

`scripts/verify-daily-synthesis-cron-and-bounded-reads.sh` reads
`convex-guidelines.md`. Do not move or delete that file without updating the
script.
