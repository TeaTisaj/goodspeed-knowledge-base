# Scaling

How this design grows from hundreds of users to millions: what breaks first, what I would change,
and what it costs. Ordered by when each becomes a problem, not by how interesting it is.

The honest framing up front: **nothing here is needed yet.** Every choice in the current build is
deliberately the simplest thing that works, and this document exists to show the threshold at which
each becomes wrong — not to justify building it now.

---

## Where it stands today

One NestJS process serving HTTP and running the ingestion worker in-process, against one Supabase
Postgres. Comfortable to roughly **1,000 users / 100k chunks** on a single small instance.

The ingestion worker already has its own entrypoint (`main.worker.ts`). Moving it off the API boxes
is `WORKER_MODE=standalone` and a second deployment — a topology change, not a rewrite. That is the
first thing I would do and it requires no code.

**Verified, not assumed.** With `WORKER_MODE=standalone` the API enqueues and a document stays
`queued`; starting `node dist/main.worker.js` drains it while the API keeps serving HTTP. Worth
saying because the first version of this claim was false — the worker only skipped when the mode was
`off`, so setting `standalone` produced a _second_ consumer rather than moving the first. A unit test
now pins the invariant that exactly one consumer exists in each topology.

---

## 1. HNSW index build time and memory — breaks first, around 1M chunks

**Symptom:** index builds take minutes and then hours; recall quietly degrades as the graph spills
out of `maintenance_work_mem` during a rebuild.

pgvector builds HNSW graphs in memory. Once the graph exceeds `maintenance_work_mem` the build falls
back to a much slower on-disk path. This is the first wall, and it arrives before query latency
becomes a problem.

**What I would change, in order:**

1. Raise `maintenance_work_mem` and `max_parallel_maintenance_workers`. Cheapest possible fix.
2. Build the index **after** bulk loading, not before — an order-of-magnitude difference on
   backfills.
3. Move to `halfvec` (2-byte floats): **half the index size** for a recall cost that is typically
   under a point at 1536 dimensions. pgvector supports HNSW on `halfvec` up to 4,000 dimensions, so
   this also unblocks larger embedding models. The schema already has `halfvec` available — verified
   present in this Postgres build.
4. Shorten the vectors themselves. `text-embedding-3-small` supports Matryoshka truncation, so 1536
   → 768 dimensions halves storage again and is measurable against the eval set before committing.
5. Partition `chunks` by `owner_id` hash. Per-partition indexes build independently and in parallel,
   and every query already filters by owner, so partition pruning is free.

**Tuning knobs, in the order I would reach for them:** `hnsw.ef_search` first — it trades recall for
latency at query time with no rebuild. Only then `m` and `ef_construction`, which require one.

---

## 2. Embedding throughput — breaks around 10k documents/day

**Symptom:** the ingestion queue grows faster than it drains; documents sit in `queued` for minutes.

The current worker embeds one document's chunks at a time. Provider rate limits bite well before
Postgres does.

**What I would change:**

- Run several workers. pg-boss uses `SKIP LOCKED`, so this is a replica count, not a code change.
- Batch across documents rather than within one. The interface is already batch-first
  (`embed(texts[])`), so this is a change in the worker's fetch loop, not in the provider.
- Use the provider's batch API where one exists. OpenAI's is **50% cheaper** with a 24-hour SLA,
  which suits backfills and initial imports exactly.
- The embedding cache already deduplicates by content hash across all users and documents. At scale
  this matters more, not less — shared boilerplate (templates, policies, contracts) is embedded once
  across the entire corpus.

**Cost, concretely:** `text-embedding-3-small` is $0.02 per million tokens. A 10,000-word document
is roughly 13k tokens, so **$0.00026 per document** — about **$26 to embed 100,000 documents**.
Embedding is not the expensive part of this system. Chat generation is, by two orders of magnitude,
which is why usage tracking is per-provider and per-model from the start.

---

## 3. The queue — breaks around 1,000 jobs/second

**Symptom:** queue polling contends with application queries on the same Postgres.

pg-boss is bounded by Postgres write throughput: hundreds to low thousands of jobs per second. This
build does single-digit jobs per _minute_, so the headroom is roughly four orders of magnitude.

**The threshold for Redis is a number, not a feeling:** sustained **>500 jobs/second**, or queue
polling showing up in `pg_stat_statements` as a top-10 query. Below that, BullMQ buys throughput
nobody is using in exchange for a service that can fail independently of the database.

Before Redis I would move the queue to its own Postgres instance — it keeps the transactional
enqueue-with-write property that makes pg-boss correct here, and removes the contention.

---

## 4. Read throughput — breaks around 10k concurrent users

**Symptom:** retrieval latency rises under concurrency while CPU sits idle; connections saturate.

**What I would change:**

- Read replicas for retrieval. Vector search is read-only, and RLS applies on replicas identically,
  so the permission model carries over unchanged.
- Connection pooling in transaction mode for the API. **Important caveat already handled in the
  code:** the ingestion worker must stay on a session-mode or direct connection, because pg-boss
  uses `LISTEN/NOTIFY`. Behind a transaction pooler jobs are enqueued successfully and then silently
  never picked up — a failure mode with no error anywhere.
- Cache query embeddings for repeated questions. Support corpora are extremely repetitive; a small
  cache on the query side would be measured before being built.

---

## 5. What I would _not_ do

**Move vectors to a dedicated store (Pinecone, Qdrant, Weaviate).** This is the obvious suggestion
and I think it is wrong here, for a reason that is about correctness rather than performance:
**permissions live in Postgres.** RLS is what guarantees a user cannot retrieve another user's
chunks, and it is enforced by the database on every query including vector search. Moving vectors
out means reimplementing that guarantee in a system that has no row-level security — and getting it
wrong there is a cross-tenant data leak, not a slow query.

pgvector with `halfvec`, partitioning and replicas covers tens of millions of vectors. I would reach
that ceiling, with measurements, before trading away the security model. If a dedicated store ever
became necessary, I would keep Postgres as the source of truth and the permission oracle, and treat
the vector store as a cache that returns candidate ids to be filtered through Postgres.

**Add an agent loop to retrieval.** Multi-step reflection costs several times the tokens for a gain
that single-corpus Q&A does not show. The eval harness is how that decision should be made.

---

## Cost at each tier

Rough monthly figures, embeddings and infrastructure only — chat generation dominates and varies
entirely with usage.

| Tier                  | Chunks | Infrastructure                                       | Embedding backfill |
| --------------------- | ------ | ---------------------------------------------------- | ------------------ |
| Hundreds of users     | ~100k  | Supabase small, single API box                       | ~$5 one-off        |
| Thousands             | ~1M    | Supabase medium, 2 API + 1 worker                    | ~$50 one-off       |
| Hundreds of thousands | ~50M   | Dedicated Postgres + replica, partitioned, `halfvec` | ~$2,500 one-off    |

The shape worth noting: **infrastructure cost grows with corpus size, while LLM cost grows with
usage.** They scale on different axes, which is why usage is tracked per provider and per model from
day one rather than added when the bill arrives.

---

## Multi-tenant workspaces

The assignment scopes visibility to a user's own documents, so this build is deliberately
user-owned: `owner_id` on every row, no speculative `workspace_id` column.

Adding team workspaces later is a contained migration rather than a redesign: a `workspaces` table, a
`workspace_members` join table, a nullable `workspace_id` on `documents` and `chunks`, and a policy
change from `owner_id = auth.uid()` to a membership check. The important detail is that **the shape
of the permission model does not change** — it stays in RLS, enforced by the database, and the
retrieval path needs no modification at all. That is the payoff for not filtering by owner in
application code.
