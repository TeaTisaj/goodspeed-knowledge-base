# Scaling

How this grows from hundreds to millions of users: what breaks first, and what I'd change.

## Today

One NestJS process serving HTTP and running the ingestion worker, against one Supabase Postgres.
Comfortable to roughly 1,000 users / 100k chunks. The worker already has its own entrypoint:
`WORKER_MODE=standalone` plus `node dist/main.worker.js` moves ingestion off the API boxes with no
code change (a unit test pins that exactly one process consumes jobs in each mode).

## 1. HNSW index build — first wall, around 1M chunks

pgvector builds HNSW graphs in memory; once the graph exceeds `maintenance_work_mem`, builds slow
sharply. In order:

1. Raise `maintenance_work_mem` and parallel maintenance workers.
2. Build the index after bulk loads, not before.
3. Move to `halfvec`: half the index size for a typical sub-point recall cost, and HNSW up to 4,000
   dimensions.
4. Truncate vectors (Matryoshka, 1536 → 768), measured against the eval first.
5. Partition `chunks` by `owner_id` hash. Every query filters by owner already, so pruning is free.

At query time, tune `hnsw.ef_search` before touching `m` / `ef_construction`, which need a rebuild.

## 2. Embedding throughput — around 10k documents/day

Provider rate limits bite before Postgres does.

- More workers: pg-boss uses `SKIP LOCKED`, so it's a replica count.
- Batch across documents; the interface is already `embed(texts[])`.
- Batch APIs for backfills (OpenAI's is 50% cheaper).
- The embedding cache dedupes by content hash across all users, which matters more with shared
  boilerplate at scale.

Cost: `text-embedding-3-small` is $0.02 / 1M tokens, about $26 to embed 100k ten-thousand-word
documents. Chat generation dominates by two orders of magnitude, which is why usage is tracked per
provider and model.

## 3. The queue — around 500 jobs/second

pg-boss is bounded by Postgres writes. The trigger for Redis/BullMQ is sustained >500 jobs/s, or
queue polling in the top of `pg_stat_statements`. Before Redis, I'd give the queue its own Postgres
instance to keep transactional enqueue-with-write.

## 4. Read throughput — around 10k concurrent users

- Read replicas for retrieval: vector search is read-only and RLS applies on replicas unchanged.
- Transaction-mode pooling for the API. The worker must stay on a direct or session connection,
  because pg-boss uses `LISTEN/NOTIFY` and jobs silently stall behind a transaction pooler.
- A query-embedding cache for repeated questions, measured first.
- Per-user rate limits already exist (chat has its own tighter bucket); at scale they move to a
  shared store so they hold across API instances.

## What I would not do

**Move vectors to a dedicated vector DB.** Permissions live in Postgres; RLS is what guarantees a
user can't retrieve another user's chunks. Moving vectors out means rebuilding that guarantee in a
system without row-level security. pgvector with `halfvec`, partitioning and replicas covers tens of
millions of vectors. If a dedicated store were ever needed, Postgres would stay the source of truth
and filter its candidate ids.

**Add an agent loop to retrieval.** Several times the tokens for no measured gain on this workload.

## Cost by tier

Infrastructure and embeddings only; chat cost scales with usage, not corpus size.

| tier                  | chunks | infrastructure                                     | embedding backfill |
| --------------------- | ------ | -------------------------------------------------- | ------------------ |
| hundreds of users     | ~100k  | Supabase small, one API box                        | ~$5                |
| thousands             | ~1M    | Supabase medium, 2 API + 1 worker                  | ~$50               |
| hundreds of thousands | ~50M   | dedicated Postgres + replica, partitioned, halfvec | ~$2,500            |

## Team workspaces

Out of scope (the task says users see only their own documents), but a contained migration:
`workspaces` and `workspace_members` tables, a nullable `workspace_id` on documents and chunks, and
policies changing from `owner_id = auth.uid()` to a membership check. Permissions stay in RLS, so
retrieval code doesn't change.
