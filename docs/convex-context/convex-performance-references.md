# Function Budget

Use these rules when functions are hitting execution limits, transaction size
errors, or returning excessively large payloads to the client.

## Core Principle

Convex functions run inside transactions with budgets for time, reads, and
writes. Staying well within these limits is not just about avoiding errors, it
reduces latency and contention.

## Limits to Know

These are the current values from the
[Convex limits docs](https://docs.convex.dev/production/state/limits). Check
that page for the latest numbers.

| Resource                          | Limit                                                 |
| --------------------------------- | ----------------------------------------------------- |
| Query/mutation execution time     | 1 second (user code only, excludes DB operations)     |
| Action execution time             | 10 minutes                                            |
| Data read per transaction         | 16 MiB                                                |
| Data written per transaction      | 16 MiB                                                |
| Documents scanned per transaction | 32,000 (includes documents filtered out by `.filter`) |
| Index ranges read per transaction | 4,096 (each `db.get` and `db.query` call)             |
| Documents written per transaction | 16,000                                                |
| Individual document size          | 1 MiB                                                 |
| Function return value size        | 16 MiB                                                |

## Symptoms

- "Function execution took too long" errors
- "Transaction too large" or read/write set size errors
- Slow queries that read many documents
- Client receiving large payloads that slow down page load
- `npx convex insights --details` showing high bytes read

## Common Causes

### Unbounded collection

A query that calls `.collect()` on a table without a reasonable limit. As the
table grows, the query reads more and more documents.

### Large document reads on hot paths

Reading documents with large fields (rich text, embedded media references, long
arrays) when only a small subset of the data is needed for the current view.

### Mutation doing too much work

A single mutation that updates hundreds of documents, backfills data, or
rebuilds derived state in one transaction.

### Returning too much data to the client

A query returning full documents when the client only needs a few fields.

## Fix Order

### 1. Bound your reads

Never `.collect()` without a limit on a table that can grow unbounded.

```ts
// Bad: unbounded read, breaks as the table grows
const messages = await ctx.db.query("messages").collect();
```

```ts
// Good: paginate or limit
const messages = await ctx.db
  .query("messages")
  .withIndex("by_channel", (q) => q.eq("channelId", channelId))
  .order("desc")
  .take(50);
```

### 2. Read smaller shapes

If the list page only needs title, author, and date, do not read full documents
with rich content fields.

Use digest or summary tables for hot list pages. See `hot-path-rules.md` for the
digest table pattern.

### 3. Break large mutations into batches

If a mutation needs to update hundreds of documents, split it into a
self-scheduling chain.

```ts
// Bad: one mutation updating every row
export const backfillAll = internalMutation({
  handler: async (ctx) => {
    const docs = await ctx.db.query("items").collect();
    for (const doc of docs) {
      await ctx.db.patch(doc._id, { newField: computeValue(doc) });
    }
  },
});
```

```ts
// Good: cursor-based batch processing
export const backfillBatch = internalMutation({
  args: { cursor: v.optional(v.string()), batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;
    const result = await ctx.db
      .query("items")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    for (const doc of result.page) {
      if (doc.newField === undefined) {
        await ctx.db.patch(doc._id, { newField: computeValue(doc) });
      }
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, internal.items.backfillBatch, {
        cursor: result.continueCursor,
        batchSize,
      });
    }
  },
});
```

### 4. Move heavy work to actions

Queries and mutations run inside Convex's transactional runtime with strict
budgets. If you need to do CPU-intensive computation, call external APIs, or
process large files, use an action instead.

Actions run outside the transaction and can call mutations to write results
back.

```ts
// Bad: heavy computation inside a mutation
export const processUpload = mutation({
  handler: async (ctx, args) => {
    const result = expensiveComputation(args.data);
    await ctx.db.insert("results", result);
  },
});
```

```ts
// Good: action for heavy work, mutation for the write
export const processUpload = action({
  handler: async (ctx, args) => {
    const result = expensiveComputation(args.data);
    await ctx.runMutation(internal.results.store, { result });
  },
});
```

### 5. Trim return values

Only return what the client needs. If a query fetches full documents but the
component only renders a few fields, map the results before returning.

```ts
// Bad: returns full documents including large content fields
export const list = query({
  handler: async (ctx) => {
    return await ctx.db.query("articles").take(20);
  },
});
```

```ts
// Good: project to only the fields the client needs
export const list = query({
  handler: async (ctx) => {
    const articles = await ctx.db.query("articles").take(20);
    return articles.map((a) => ({
      _id: a._id,
      title: a.title,
      author: a.author,
      createdAt: a._creationTime,
    }));
  },
});
```

### 6. Replace `ctx.runQuery` and `ctx.runMutation` with helper functions

Inside queries and mutations, `ctx.runQuery` and `ctx.runMutation` have overhead
compared to calling a plain TypeScript helper function. They run in the same
transaction but pay extra per-call cost.

```ts
// Bad: unnecessary overhead from ctx.runQuery inside a mutation
export const createProject = mutation({
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(api.users.getCurrentUser);
    await ctx.db.insert("projects", { ...args, ownerId: user._id });
  },
});
```

```ts
// Good: plain helper function, no extra overhead
export const createProject = mutation({
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    await ctx.db.insert("projects", { ...args, ownerId: user._id });
  },
});
```

Exception: components require `ctx.runQuery`/`ctx.runMutation`. Use them there,
but prefer helpers everywhere else.

### 7. Avoid unnecessary `runAction` calls

`runAction` from within an action creates a separate function invocation with
its own memory and CPU budget. The parent action just sits idle waiting. Replace
with a plain TypeScript function call unless you need a different runtime (e.g.
calling Node.js code from the Convex runtime).

```ts
// Bad: runAction overhead for no reason
export const processItems = action({
  handler: async (ctx, args) => {
    for (const item of args.items) {
      await ctx.runAction(internal.items.processOne, { item });
    }
  },
});
```

```ts
// Good: plain function call
export const processItems = action({
  handler: async (ctx, args) => {
    for (const item of args.items) {
      await processOneItem(ctx, { item });
    }
  },
});
```

## Verification

1. No function execution or transaction size errors
2. `npx convex insights --details` shows reduced bytes read
3. Large mutations are batched and self-scheduling
4. Client payloads are reasonably sized for the UI they serve
5. `ctx.runQuery`/`ctx.runMutation` in queries and mutations replaced with
   helpers where possible
6. Sibling functions with similar patterns were checked
# Hot Path Rules

Use these rules when the top-level workflow points to read amplification,
denormalization, index rollout, reactive query cost, or invalidation-heavy
writes.

## Contents

- Core Principle
- Consistency Rule
- 1. Push Filters To Storage (indexes, migration rule, redundant indexes)
- 2. Minimize Data Sources (denormalization, fallback rule)
- 3. Minimize Row Size (digest tables)
- 4. Skip No-Op Writes
- 5. Match Consistency To Read Patterns (high-read/low-write,
     high-read/high-write)
- Convex-Specific Notes (reactive queries, point-in-time reads, triggers,
  aggregates, backfills)
- Verification

## Core Principle

Every byte read or written multiplies with concurrency.

Think:

`cost x calls_per_second x 86400`

In Convex, every write can also fan out into reactive invalidation, replication
work, and downstream sync.

## Consistency Rule

If you fix a hot-path pattern for one function, audit sibling functions touching
the same tables for the same pattern.

Do this especially for:

- multiple list queries over the same table
- multiple writers to the same table
- public browse and search queries over the same records
- helper functions reused by more than one endpoint

## 1. Push Filters To Storage

Both JavaScript `.filter()` and the Convex query `.filter()` method after a DB
scan mean you already paid for the read. The Convex `.filter()` method has the
same performance as filtering in JS, it does not push the predicate to the
storage layer. Only `.withIndex()` and `.withSearchIndex()` actually reduce the
documents scanned.

Prefer:

- `withIndex(...)`
- `.withSearchIndex(...)` for text search
- narrower tables
- summary tables

before accepting a scan-plus-filter pattern.

```ts
// Bad: scans then filters in JavaScript
export const listOpen = query({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db.query("tasks").collect();
    return tasks.filter((task) => task.status === "open");
  },
});
```

```ts
// Also bad: Convex .filter() does not push to storage either
export const listOpen = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("status"), "open"))
      .collect();
  },
});
```

```ts
// Good: use an index so storage does the filtering
export const listOpen = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .collect();
  },
});
```

### Migration rule for indexes

New indexes on partially backfilled fields can create correctness bugs during
rollout.

Important Convex detail:

`undefined !== false`

If an older document is missing a field entirely, it will not match a compound
index entry that expects `false`.

Do not trust old comments saying a field is "not backfilled" or "already
backfilled". Verify.

If correctness depends on handling old and new states during rollout, do not
improvise a partial-backfill workaround in the hot path. Use a migration-safe
rollout and consult `skills/convex-migration-helper/SKILL.md`.

```ts
// Bad: optional booleans can miss older rows where the field is undefined
const projects = await ctx.db
  .query("projects")
  .withIndex("by_archived_and_updated", (q) => q.eq("isArchived", false))
  .order("desc")
  .take(20);
```

```ts
// Good: switch hot-path reads only after the rollout is migration-safe
// See the migration helper skill for dual-read / backfill / cutover patterns.
```

### Check for redundant indexes

Indexes like `by_foo` and `by_foo_and_bar` are usually redundant. You only need
`by_foo_and_bar`, since you can query it with just the `foo` condition and omit
`bar`. Extra indexes add storage cost and write overhead on every insert, patch,
and delete.

```ts
// Bad: two indexes where one would do
defineTable({ team: v.id("teams"), user: v.id("users") })
  .index("by_team", ["team"])
  .index("by_team_and_user", ["team", "user"]);
```

```ts
// Good: single compound index serves both query patterns
defineTable({ team: v.id("teams"), user: v.id("users") }).index(
  "by_team_and_user",
  ["team", "user"],
);
```

Exception: `.index("by_foo", ["foo"])` is really an index on `foo` +
`_creationTime`, while `.index("by_foo_and_bar", ["foo", "bar"])` is on `foo` +
`bar` + `_creationTime`. If you need results sorted by `foo` then
`_creationTime`, you need the single-field index because the compound one would
sort by `bar` first.

## 2. Minimize Data Sources

Trace every read.

If a function resolves a foreign key for a tiny display field and a denormalized
copy already exists, prefer the denormalized field on the hot path.

### When to denormalize

Denormalize when all of these are true:

- the path is hot
- the joined document is much larger than the field you need
- many readers are paying that join cost repeatedly

Useful mental model:

`join_cost = rows_per_page x foreign_doc_size x pages_per_second`

Small-table joins are often fine. Large-document joins for tiny fields on hot
list pages are usually not.

### Fallback rule

Denormalized data is an optimization. Live data is the correctness path.

Rules:

- If the denormalized field is missing or null, fall back to the live read
- Do not show placeholders instead of falling back
- In lookup maps, only include fully populated entries

```ts
// Bad: missing denormalized data becomes a placeholder and blocks correctness
const ownerName = project.ownerName ?? "Unknown owner";
```

```ts
// Good: denormalized data is an optimization, not the only source of truth
const ownerName =
  project.ownerName ?? (await ctx.db.get(project.ownerId))?.name ?? null;
```

Bad lookup map pattern:

```ts
const ownersById = {
  [project.ownerId]: { ownerName: null },
};
```

That blocks fallback because the map says "I have data" when it does not.

Good lookup map pattern:

```ts
const ownersById =
  project.ownerName !== undefined && project.ownerName !== null
    ? { [project.ownerId]: { ownerName: project.ownerName } }
    : {};
```

### No denormalized copy yet

Prefer adding fields to an existing summary, companion, or digest table instead
of bloating the primary hot-path table.

If introducing the new field or table requires a staged rollout, backfill, or
old/new-shape handling, use the migration helper skill for the rollout plan.

Rollout order:

1. Update schema
2. Update write path
3. Backfill
4. Switch read path

## 3. Minimize Row Size

Hot list pages should read the smallest document shape that still answers the
UI.

Prefer summary or digest tables over full source tables when:

- the list page only needs a subset of fields
- source documents are large
- the query is high volume

An 800 byte summary row is materially cheaper than a 3 KB full document on a hot
page.

Digest tables are a tradeoff, not a default:

- Worth it when the path is clearly hot, the source rows are much larger than
  the UI needs, or many readers are repeatedly paying the same join and payload
  cost
- Probably not worth it when an indexed read on the source table is already
  cheap enough, the table is still small, or the extra write and migration
  complexity would dominate the benefit

```ts
// Bad: list page reads source docs, then joins owner data per row
const projects = await ctx.db
  .query("projects")
  .withIndex("by_public", (q) => q.eq("isPublic", true))
  .collect();
```

```ts
// Good: list page reads the smaller digest shape first
const projects = await ctx.db
  .query("projectDigests")
  .withIndex("by_public_and_updated", (q) => q.eq("isPublic", true))
  .order("desc")
  .take(20);
```

## 4. Isolate Frequently-Updated Fields

Convex already no-ops unchanged writes. The invalidation problem here is real
writes hitting documents that many queries subscribe to.

Move high-churn fields like `lastSeen`, counters, presence, or ephemeral status
off widely-read documents when most readers do not need them.

Apply this across sibling writers too. Splitting one write path does not help
much if three other mutations still update the same widely-read document.

```ts
// Bad: every presence heartbeat invalidates subscribers to the whole profile
await ctx.db.patch(user._id, {
  name: args.name,
  avatarUrl: args.avatarUrl,
  lastSeen: Date.now(),
});
```

```ts
// Good: keep profile reads stable, move heartbeat updates to a separate document
await ctx.db.patch(user._id, {
  name: args.name,
  avatarUrl: args.avatarUrl,
});

await ctx.db.patch(presence._id, {
  lastSeen: Date.now(),
});
```

## 5. Match Consistency To Read Patterns

Choose read strategy based on traffic shape.

### High-read, low-write

Examples:

- public browse pages
- search results
- landing pages
- directory listings

Prefer:

- point-in-time reads where appropriate
- explicit refresh
- local state for pagination
- caching where appropriate

Do not treat subscriptions as automatically wrong here. Prefer point-in-time
reads only when the product does not need live freshness and the reactive cost
is material. See `subscription-cost.md` for detailed patterns.

### High-read, high-write

Examples:

- collaborative editors
- live dashboards
- presence-heavy views

Reactive queries may be worth the ongoing cost.

## Convex-Specific Notes

### Reactive queries

Every `ctx.db.get()` and `ctx.db.query()` contributes to the invalidation set
for the query.

On the client:

- `useQuery` creates a live subscription
- `usePaginatedQuery` creates a live subscription per page

For low-freshness flows, consider a point-in-time read instead of a live
subscription only when the product does not need updates pushed automatically.

### Point-in-time reads

Framework helpers, server-rendered fetches, or one-shot client reads can avoid
ongoing subscription cost when live updates are not useful.

Use them for:

- aggregate snapshots
- reports
- low-churn listings
- pages where explicit refresh is fine

### Triggers and fan-out

Triggers fire on every write, including writes that did not materially change
the document.

When a write exists only to keep derived state in sync:

- diff before patching
- move expensive non-blocking work to `ctx.scheduler.runAfter` when appropriate

### Aggregates

Reactive global counts invalidate frequently on busy tables.

Prefer:

- one-shot aggregate fetches
- periodic recomputation
- precomputed summary rows

for global stats that do not need live updates every second.

### Backfills

For larger backfills, use cursor-based, self-scheduling `internalMutation` jobs
or the migrations component.

Deploy code that can handle both states before running the backfill.

During the gap:

- writes should populate the new shape
- reads should fall back safely

## Verification

Before closing the audit, confirm:

1. Same results as before, no dropped records
2. The removed table or lookup is no longer in the hot-path read set
3. Tests or validation cover fallback behavior
4. Migration safety is preserved while fields or indexes are unbackfilled
5. Sibling functions were fixed consistently
# OCC Conflict Resolution

Use these rules when insights, logs, or dashboard health show OCC (Optimistic
Concurrency Control) conflicts, mutation retries, or write contention on hot
tables.

## Core Principle

Convex uses optimistic concurrency control. When two transactions read or write
overlapping data, one succeeds and the other retries automatically. High
contention means wasted work and increased latency.

## Symptoms

- OCC conflict errors in deployment logs or health page
- Mutations retrying multiple times before succeeding
- User-visible latency spikes on write-heavy pages
- `npx convex insights --details` showing high conflict rates

## Common Causes

### Hot documents

Multiple mutations writing to the same document concurrently. Classic examples:
a global counter, a shared settings row, or a "last updated" timestamp on a
parent record.

### Broad read sets causing false conflicts

A query that scans a large table range creates a broad read set. If any write
touches that range, the query's transaction conflicts even if the specific
document the query cared about was not modified.

### Fan-out from triggers or cascading writes

A single user action triggers multiple mutations that all touch related
documents. Each mutation competes with the others.

Database triggers (e.g. from `convex-helpers`) run inside the same transaction
as the mutation that caused them. If a trigger does heavy work, reads extra
tables, or writes to many documents, it extends the transaction's read/write set
and increases the window for conflicts. Keep trigger logic minimal, or move
expensive derived work to a scheduled function.

### Write-then-read chains

A mutation writes a document, then a reactive query re-reads it, then another
mutation writes it again. Under load, these chains stack up.

## Fix Order

### 1. Reduce read set size

Narrower reads mean fewer false conflicts.

```ts
// Bad: broad scan creates a wide conflict surface
const allTasks = await ctx.db.query("tasks").collect();
const mine = allTasks.filter((t) => t.ownerId === userId);
```

```ts
// Good: indexed query touches only relevant documents
const mine = await ctx.db
  .query("tasks")
  .withIndex("by_owner", (q) => q.eq("ownerId", userId))
  .collect();
```

### 2. Split hot documents

When many writers target the same document, split the contention point.

```ts
// Bad: every vote increments the same counter document
const counter = await ctx.db.get(pollCounterId);
await ctx.db.patch(pollCounterId, { count: counter!.count + 1 });
```

```ts
// Good: shard the counter across multiple documents, aggregate on read
const shardIndex = Math.floor(Math.random() * SHARD_COUNT);
const shardId = shardIds[shardIndex];
const shard = await ctx.db.get(shardId);
await ctx.db.patch(shardId, { count: shard!.count + 1 });
```

Aggregate the shards in a query or scheduled job when you need the total.

### 3. Move non-critical work to scheduled functions

If a mutation does primary work plus secondary bookkeeping (analytics,
non-critical notifications, cache warming), the bookkeeping extends the
transaction's lifetime and read/write set.

```ts
// Bad: canonical write and derived work happen in the same transaction
await ctx.db.patch(userId, { name: args.name });
await ctx.db.insert("userUpdateAnalytics", {
  userId,
  kind: "name_changed",
  name: args.name,
});
```

```ts
// Good: keep the primary write small, defer the analytics work
await ctx.db.patch(userId, { name: args.name });
await ctx.scheduler.runAfter(0, internal.users.recordNameChangeAnalytics, {
  userId,
  name: args.name,
});
```

### 4. Combine competing writes

If two mutations must update the same document atomically, consider whether they
can be combined into a single mutation call from the client, reducing round
trips and conflict windows.

Do not introduce artificial locks or queues unless the above steps have been
tried first.

## Related: Invalidation Scope

Splitting hot documents also reduces subscription invalidation, not just OCC
contention. If a document is written frequently and read by many queries, those
queries re-run on every write even when the fields they care about have not
changed. See `subscription-cost.md` section 4 ("Isolate frequently-updated
fields") for that pattern.

## Verification

1. OCC conflict rate has dropped in insights or dashboard
2. Mutation latency is lower and more consistent
3. No data correctness regressions from splitting or scheduling changes
4. Sibling writers to the same hot documents were fixed consistently
# Subscription Cost

Use these rules when the problem is too many reactive subscriptions, queries
invalidating too frequently, or React components re-rendering excessively due to
Convex state changes.

## Core Principle

Every `useQuery` and `usePaginatedQuery` call creates a live subscription. The
server tracks the query's read set and re-executes the query whenever any
document in that read set changes. Subscription cost scales with:

`subscriptions x invalidation_frequency x query_cost`

Subscriptions are not inherently bad. Convex reactivity is often the right
default. The goal is to reduce unnecessary invalidation work, not to eliminate
subscriptions on principle.

## Symptoms

- Dashboard shows high active subscription count
- UI feels sluggish or laggy despite fast individual queries
- React profiling shows frequent re-renders from Convex state
- Pages with many components each running their own `useQuery`
- Paginated lists where every loaded page stays subscribed

## Common Causes

### Reactive queries on low-freshness flows

Some user flows are read-heavy and do not need live updates every time the
underlying data changes. In those cases, ongoing subscriptions may cost more
than they are worth.

### Overly broad queries

A query that returns a large result set invalidates whenever any document in
that set changes. The broader the query, the more frequent the invalidation.

### Too many subscriptions per page

A page with 20 list items, each running its own `useQuery` to fetch related
data, creates 20+ subscriptions per visitor.

### Paginated queries keeping all pages live

`usePaginatedQuery` with `loadMore` keeps every loaded page subscribed. On a
page where a user has scrolled through 10 pages, all 10 stay reactive.

### Frequently-updated fields on widely-read documents

A document that many queries touch gets a frequently-updated field (like
`lastSeen`, `lastActiveAt`, or a counter). Every write to that field invalidates
every subscription that reads the document, even if those subscriptions never
use the field. This is different from OCC conflicts (see `occ-conflicts.md`),
which are write-vs-write contention. This is write-vs-subscription: the write
succeeds fine, but it forces hundreds of queries to re-run for no reason.

## Fix Order

### 1. Use point-in-time reads when live updates are not valuable

Keep `useQuery` and `usePaginatedQuery` by default when the product benefits
from fresh live data.

Consider a point-in-time read instead when all of these are true:

- the flow is high-read
- the underlying data changes less often than users need to see
- explicit refresh, periodic refresh, or a fresh read on navigation is
  acceptable

Possible implementations depend on environment:

- a server-rendered fetch
- a framework helper like `fetchQuery`
- a point-in-time client read such as `ConvexHttpClient.query()`

```ts
// Reactive by default when fresh live data matters
function TeamPresence() {
  const presence = useQuery(api.teams.livePresence, { teamId });
  return <PresenceList users={presence} />;
}
```

```ts
// Point-in-time read when explicit refresh is acceptable
import { ConvexHttpClient } from "convex/browser";

const client = new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL);

function SnapshotView() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    client.query(api.items.snapshot).then(setItems);
  }, []);

  return <ItemGrid items={items} />;
}
```

Good candidates for point-in-time reads:

- aggregate snapshots
- reports
- low-churn listings
- flows where explicit refresh is already acceptable

Keep reactive for:

- collaborative editing
- live dashboards
- presence-heavy views
- any surface where users expect fresh changes to appear automatically

### 2. Batch related data into fewer queries

Instead of N components each fetching their own related data, fetch it in a
single query.

```ts
// Bad: each card fetches its own author
function ProjectCard({ project }: { project: Project }) {
  const author = useQuery(api.users.get, { id: project.authorId });
  return <Card title={project.name} author={author?.name} />;
}
```

```ts
// Good: parent query returns projects with author names included
function ProjectList() {
  const projects = useQuery(api.projects.listWithAuthors);
  return projects?.map((p) => (
    <Card key={p._id} title={p.name} author={p.authorName} />
  ));
}
```

This can use denormalized fields or server-side joins in the query handler.
Either way, it is one subscription instead of N.

This is not automatically better. If the combined query becomes much broader and
invalidates much more often, several narrower subscriptions may be the better
tradeoff. Optimize for total invalidation cost, not raw subscription count.

### 3. Use skip to avoid unnecessary subscriptions

The `"skip"` value prevents a subscription from being created when the arguments
are not ready.

```ts
// Bad: subscribes with undefined args, wastes a subscription slot
const profile = useQuery(api.users.getProfile, { userId: selectedId! });
```

```ts
// Good: skip when there is nothing to fetch
const profile = useQuery(
  api.users.getProfile,
  selectedId ? { userId: selectedId } : "skip",
);
```

### 4. Isolate frequently-updated fields into separate documents

If a document is widely read but has a field that changes often, move that field
to a separate document. Queries that do not need the field will no longer be
invalidated by its writes.

```ts
// Bad: lastSeen lives on the user doc, every heartbeat invalidates
// every query that reads this user
const users = defineTable({
  name: v.string(),
  email: v.string(),
  lastSeen: v.number(),
});
```

```ts
// Good: lastSeen lives in a separate heartbeat doc
const users = defineTable({
  name: v.string(),
  email: v.string(),
  heartbeatId: v.id("heartbeats"),
});

const heartbeats = defineTable({
  lastSeen: v.number(),
});
```

Queries that only need `name` and `email` no longer re-run on every heartbeat.
Queries that actually need online status fetch the heartbeat document
explicitly.

For an even further optimization, if you only need a coarse online/offline
boolean rather than the exact `lastSeen` timestamp, add a separate presence
document with an `isOnline` flag. Update it immediately when a user comes
online, and use a cron to batch-mark users offline when their heartbeat goes
stale. This way the presence query only invalidates when online status actually
changes, not on every heartbeat.

### 5. Use the aggregate component for counts and sums

Reactive global counts (`SELECT COUNT(*)` equivalent) invalidate on every insert
or delete to the table. The
[`@convex-dev/aggregate`](https://www.npmjs.com/package/@convex-dev/aggregate)
component maintains denormalized COUNT, SUM, and MAX values efficiently so you
do not need a reactive query scanning the full table.

Use it for leaderboards, totals, "X items" badges, or any stat that would
otherwise require scanning many rows reactively.

If the aggregate component is not appropriate, prefer point-in-time reads for
global stats, or precomputed summary rows updated by a cron or trigger, over
reactive queries that scan large tables.

### 6. Narrow query read sets

Queries that return less data and touch fewer documents invalidate less often.

```ts
// Bad: returns all fields, invalidates on any field change
export const list = query({
  handler: async (ctx) => {
    return await ctx.db.query("projects").collect();
  },
});
```

```ts
// Good: use a digest table with only the fields the list needs
export const listDigests = query({
  handler: async (ctx) => {
    return await ctx.db.query("projectDigests").collect();
  },
});
```

Writes to fields not in the digest table do not invalidate the digest query.

### 7. Remove `Date.now()` from queries

Using `Date.now()` inside a query defeats Convex's query cache. The cache is
invalidated frequently to avoid showing stale time-dependent results, which
increases database work even when the underlying data has not changed.

```ts
// Bad: Date.now() defeats query caching and causes frequent re-evaluation
const releasedPosts = await ctx.db
  .query("posts")
  .withIndex("by_released_at", (q) => q.lte("releasedAt", Date.now()))
  .take(100);
```

```ts
// Good: use a boolean field updated by a scheduled function
const releasedPosts = await ctx.db
  .query("posts")
  .withIndex("by_is_released", (q) => q.eq("isReleased", true))
  .take(100);
```

If the query must compare against a time value, pass it as an explicit argument
from the client and round it to a coarse interval (e.g. the most recent minute)
so requests within that window share the same cache entry.

### 8. Consider pagination strategy

For long lists where users scroll through many pages:

- If the data does not need live updates, use point-in-time fetching with manual
  "load more"
- If it does need live updates, accept the subscription cost but limit the
  number of loaded pages
- Consider whether older pages can be unloaded as the user scrolls forward

### 9. Separate backend cost from UI churn

If the main problem is loading flash or UI churn when query arguments change,
stabilizing the reactive UI behavior may be better than replacing reactivity
altogether.

Treat this as a UX problem first when:

- the underlying query is already reasonably cheap
- the complaint is flicker, loading flashes, or re-render churn
- live updates are still desirable once fresh data arrives

## Verification

1. Subscription count in dashboard is lower for the affected pages
2. UI responsiveness has improved
3. React profiling shows fewer unnecessary re-renders
4. Surfaces that do not need live updates are not paying for persistent
   subscriptions unnecessarily
5. Sibling pages with similar patterns were updated consistently
