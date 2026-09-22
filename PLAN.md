# PLAN.md — AI-Powered Knowledge Base

Build spec for the Goodspeed Founding AI Engineer take-home.
Status: **planning complete, reviewed and corrected, awaiting sign-off.** No implementation code
written yet. Scope is governed by [task.md](task.md); see [description.md](description.md) for the
tiering. Load-bearing claims and their sources are in §8.

---

## 1. Overview and chosen architecture

### What we're building

A multi-user knowledge base with per-user isolation. Users sign in, create/edit/delete documents, and the system
automatically chunks and embeds them into pgvector. They then chat against their own corpus:
hybrid retrieval pulls relevant chunks, an LLM answers grounded in them, and the answer streams
back with clickable citations pointing at the exact chunk.

### The three decisions that define this build

**1. Chat Completions, not the Responses API.**
OpenAI recommends the Responses API for new projects. We deliberately target `/v1/chat/completions`
anyway, because the assignment's key requirement is that *any OpenAI-spec-compatible provider* swaps
in via config — and Groq, Together, OpenRouter and Ollama implement Chat Completions, not Responses.
Choosing the "recommended" API would silently break the single most-weighted requirement.

What this actually costs, stated precisely: Chat Completions **still supports custom function
calling** — it is not deprecated. What is Responses-only is OpenAI's newest model's tool calling
(GPT-6 Astra) and OpenAI's hosted tools (web search, code interpreter, MCP). Those are proprietary
by definition, so depending on them would break portability regardless. Our v1 is a deterministic
workflow that calls no tools, so the cost today is zero, and the ceiling is documented rather than
discovered later. Opening entry in DECISIONS.md.

**2. One adapter plus declarative presets, not five provider classes.**
Every target provider speaks the same wire protocol. The naive reading of "provider-agnostic" is
five classes implementing an interface; the correct reading is one `OpenAICompatibleProvider`
configured by a preset registry, because the variation between providers is *capability and
endpoint*, not protocol. What the interface must actually model is the differences that bite:
Groq has no embeddings endpoint, Ollama's dimensions differ from OpenAI's, not everyone streams
tool calls. Those become a declared `capabilities` descriptor validated at boot, so a bad combo
fails on startup with an actionable message rather than at 2am.

**3. RLS is the permission boundary, not application code.**
The API builds a *request-scoped* Supabase client from the caller's JWT, so Postgres itself
enforces isolation on every query including vector search. Supabase's own RAG-with-permissions
guide confirms RLS applies to similarity search with no `SECURITY DEFINER` wrapper needed. The
service-role key is used in exactly one place: the ingestion worker. A `SECURITY DEFINER`
`match_chunks` function with no user filter is the classic way this app leaks data between
users, and we avoid it structurally rather than by remembering to add a `WHERE`.

### Architecture options considered

**Option A — Modular monolith: NestJS API with a dual-mode worker, Postgres-only infra. ← CHOSEN**

```
Browser ──JWT──> NestJS API ──user JWT──> Supabase Postgres (RLS enforced)
   ^                  │                        │ pgvector + FTS + pg-boss queue
   └──SSE stream──────┘                        │
                      └─ enqueue ─> Worker ──service role──> writes chunks
                                    (same process by default,
                                     separate process via WORKER_MODE=standalone)
```

**Two database access paths, deliberately.** Reviewers will ask how RLS actually gets enforced
from NestJS, so it is worth stating rather than leaving as an arrow in a diagram:

- **User-facing reads/writes** go through `supabase-js` carrying the caller's access token — i.e.
  over PostgREST — so Postgres applies RLS. This includes the `hybrid_search` RPC.
- **pg-boss needs a direct Postgres connection** (it owns its own schema and uses LISTEN/NOTIFY),
  so the worker holds a `node-postgres` pool. RLS does not apply on that path, which is exactly why
  the worker is the only component holding service-role credentials and why its writes are confined
  to ingestion.

Ingestion is a pg-boss job in Postgres. The worker is a separate NestJS module with its own
bootstrap entrypoint, so the *same code* runs embedded (one command locally) or as a separate
deployable process (production) by flipping one env var. That is the scaling story demonstrated in
code rather than asserted in a document.

- Pros: genuinely one command to run, no Redis, jobs are transactional with the document write,
  job status is a plain SQL query so the UI gets it for free.
- Cons: by default the worker shares a process with the API. Mitigated by the standalone mode above.

**Option B — Separate worker app + BullMQ/Redis.**
The textbook NestJS answer, with `@nestjs/bullmq` and a nice dashboard. Rejected: Redis buys
throughput we provably don't need (pg-boss does hundreds-to-low-thousands jobs/sec; this workload
is single-digit jobs/minute), and it adds a container to the setup a reviewer has to get working.
Adding infra you can't justify with a number is the definition of overengineering, and a sharp
reviewer reads it that way. SCALING.md names the specific threshold at which we'd switch.

**Option C — Next.js BFF: browser → Next route handlers → NestJS.**
Same-origin cookies, no CORS, auth in Next middleware. Rejected: it adds a proxy hop on the hot
streaming path, duplicates types at the boundary, and visually demotes NestJS to a backend-of-a-
backend when NestJS *is* what's being evaluated. We go browser → NestJS directly with CORS, and
Next.js stays a pure frontend.

Also considered and rejected: an external vector store (Qdrant/Pinecone). The assignment mandates
pgvector, and more substantively, moving vectors out of Postgres means reimplementing the entire
permission model in a system that has no RLS. Covered in SCALING.md as the thing we would *not* do
first.

### Retrieval pipeline — a deterministic workflow, with one LLM call that earns its place

```
query
 └─> [if multi-turn] condense history + question into a standalone query   (1 small LLM call)
 └─> embed query (cache: content hash → vector)
 └─> parallel: vector top-30  ||  Postgres FTS top-30     (both RLS-scoped)
 └─> Reciprocal Rank Fusion  ──> top-12
 └─> [optional, flagged] LLM rerank ──> top-5
 └─> build prompt with numbered citation markers
 └─> stream answer + citation events + usage event
```

This is a **workflow**, not an agent: fixed steps, no model-chosen control flow, bounded cost and
latency. The only LLM call besides the answer itself is query condensation, and it runs **only on
multi-turn requests** — first-turn questions skip it entirely. It earns its place because without
it "what about the second one?" retrieves nothing, a real failure the deterministic path cannot fix.

Agentic retrieval (model decides when and whether to search, loops until satisfied) needs iteration
budgets and stop conditions to avoid running away on cost; practitioner write-ups put multi-step
reflection loops at roughly 3–10x the tokens of classic RAG. On a single-corpus Q&A workload it does
not pay for itself. DECISIONS.md states this with the caveat that the multiplier is a reported
range, not something we measured.

Reranking is **off by default and measured**: RRF fusion is the always-on baseline because it is
free, deterministic and adds no dependency, and the eval harness reports hit-rate/MRR with and
without the LLM reranker. That turns the eval from decoration into the thing that justifies the flag.

### Ingestion pipeline — incremental, not destructive

On document update we do *not* delete-and-re-embed everything. We chunk the new content, hash each
chunk, and diff against existing chunks by hash:

- unchanged hash → keep the row, update its position
- new hash → check the embedding cache, embed only on miss
- absent hash → delete the row

Editing a typo in one paragraph of a 40-chunk document re-embeds the one or two chunks containing
it — usually two, because the overlap window straddles the edit — rather than all forty.

The honest caveat, which belongs in DECISIONS.md rather than being quietly omitted: a large
insertion can shift downstream chunk boundaries and cascade, changing hashes for chunks whose text
did not meaningfully change. Structure-aware splitting makes cascades uncommon, because splits land
on heading and paragraph boundaries that an edit elsewhere does not move, but it does not eliminate
them. So the eval reports the **actual re-embed ratio** measured on a real edit, rather than
advertising the best case.

---

## 2. Tech stack with pinned versions and reasoning

Verified against the npm registry on 2026-09-23.

| Package | Version | Why this, and why pinned |
|---|---|---|
| Node.js | **24.21.0** (`.nvmrc`, `engines`) | Forced: `@nestjs/schematics@12` requires `^22.22.3 \|\| ^24.15.0 \|\| >=26`. Node 24 is Active LTS (since 2025-10-28, EOL 2028-04-30) and satisfies every package below. **Installed 2026-09-23 via fnm — was 22.13.0, which would have failed.** Node 26 becomes LTS 2026-10-28; staying on 24 avoids a week-old runtime and keeps corepack bundled. |
| pnpm | **12.5.1** via `packageManager` | Turborepo's default. Pinned in the `packageManager` field so every machine and CI resolves the identical version. Note corepack is bundled in Node 24 but **removed from Node 25+**, so the README documents `npm i -g corepack` as the fallback for anyone on a newer runtime. |
| turbo | 2.11.3 | `tasks` schema (not legacy `pipeline`). |
| TypeScript | **6.0.3 — deliberately not 7** | TS 7.0.2 is latest, but ships no compiler API, so `nest build` cannot run on it, and `typescript-eslint@8` declares `typescript: <6.1.0`. TS7 is a fast typecheck-only option we note in DECISIONS.md and don't adopt. |
| Next.js | 16.3.6 | Turbopack default. Note: `next lint` was **removed** in 16 — the turbo `lint` task calls eslint directly. `params`/`searchParams` are Promises. |
| React | 19.3.0 | Required by Next 16 App Router. |
| NestJS | 12.0.4 | ESM-ready packages via `require(esm)`; brings native Standard Schema validation (below). |
| Zod | 4.6.5 | The contracts layer. See next row. |
| Validation | `StandardSchemaValidationPipe` (built into `@nestjs/common` 12) | **The reason `packages/contracts` is real.** One Zod schema validates in NestJS *and* infers the TypeScript type the web app consumes. class-validator would force a duplicated class per DTO and give the frontend nothing. This is what makes "typed contracts shared across the monorepo" more than a slogan. |
| openai | 7.22.0 | v7's only breaking change is Node >=22. Used against `/v1/chat/completions` for portability. |
| @supabase/supabase-js | 2.117.0 | |
| @supabase/ssr | 0.12.7 | Cookie-based session in Next 16. |
| supabase (CLI) | 2.117.0 **as a devDependency** | Reviewers need no global install — this is what makes one-command setup honest. |
| pgvector | 0.8.x (verify, see Risks) | HNSW. 0.8.0+ adds iterative scan, which matters under RLS filtering. |
| pg-boss | 12.33.6 | Postgres-backed queue; no Redis. |
| Vitest | 5.0.1 | One runner across the monorepo, ESM-native, no ts-jest transform step. Jest+SWC is the fallback if NestJS DI friction appears. |
| Playwright | 1.63.0 | Exactly one E2E smoke test. |
| Tailwind | 4.3.3 | |
| ESLint | 10.11.0 + typescript-eslint 8.70.1 | Peer ranges verified compatible with ESLint 10 and TS 6. |
| gpt-tokenizer | 4.0.0 | Token counts for chunk sizing and cost tracking. Exact for OpenAI (cl100k/o200k); **approximate for Llama-family models on Groq/Together/Ollama**, which use different tokenizers — the usage view labels non-OpenAI counts as estimates rather than quietly implying precision. |
| unpdf | 1.8.1 | PDF extraction (optional milestone). Serverless-safe, no native deps, maintained successor to pdf-parse. |

**Embedding model: `text-embedding-3-small`, 1536 dims, $0.02/M tokens.**
Not `-3-large`: it is 6.5x the price for a marginal gain here, and at 3072 dims it **exceeds
pgvector's 2000-dimension ceiling for HNSW indexes on the `vector` type** — it would silently force
`halfvec` or no index. The dimension ceiling is a real constraint most people meet by accident;
we meet it on purpose.

**Chunking: recursive, structure-aware splitting, ~512 tokens, ~64 token (12.5%) overlap.**
This is the most commonly recommended 2026 default and needs zero model calls. But the published
evidence is **not consistent**, and pretending otherwise would be the wrong move in an interview:
some write-ups claim semantic chunking gains 15–25% over recursive, while Chroma's benchmark puts
recursive at 85–90% recall against semantic's 91–92% — a 2–6 point gap for 3–5x the compute. One
January 2026 analysis found chunk overlap gave *no* measurable benefit and only raised indexing cost.

That disagreement is precisely the argument for the eval harness. We start at the consensus default
and measure 256/512/1024 and overlap on/off against our own corpus, then publish the table. The
defensible claim is "here is what it did on this data," not "a blog said 512."
Splitter respects markdown structure (headings → paragraphs → sentences → characters).

---

## 3. Milestones

Each milestone is independently testable and ends in a working state. Ordered by dependency.

### M0 — Foundations (0.5d)
- [ ] Turborepo skeleton, pnpm workspaces, `tasks` for `build`/`dev`/`lint`/`test`/`typecheck`
- [ ] Shared `packages/tsconfig` + `packages/eslint-config`; `.nvmrc` → Node 24; `engines` field
- [ ] `.env.example` with every var documented; Zod env schema
- [ ] CI skeleton: install → lint → typecheck → unit tests
- [ ] **Spike (timeboxed 2h): Vitest + NestJS 12 DI + decorators.** Fall back to Jest+SWC if it fights back.
- [ ] **Environment verification gate — run `supabase start` once and record the answers.** Three
      assumptions in this plan are unverified until the CLI is actually installed, and each changes
      a downstream decision. Do not defer these; they are cheap now and expensive in M4.
      - Postgres and **pgvector version** → gates iterative scan (risk 3)
      - **JWT algorithm** the local project issues, ES256 or HS256 → gates the auth guard (risk 11)
      - **Creating a user via the Auth Admin API succeeds** → gates seeding, which is on the
        critical path for the one-command setup (risk 11)
- Test: `pnpm lint && pnpm typecheck` green on an empty repo; CI passes; the three answers above
  written into DECISIONS.md so the reasoning is dated and sourced.

### M1 — Data layer (1d)
- [ ] Supabase local via devDependency CLI; `supabase/migrations/` as real, ordered SQL files
- [ ] Schema: `documents`, `chunks`, `ingestion_jobs`, `conversations`, `messages`,
      `message_citations`, `embedding_cache`, `usage_events`
- [ ] `documents.tags text[]` (task.md §3) with a GIN index — tags are copied onto `chunks` at
      ingestion so they can filter retrieval without a join
- [ ] **Ownership is `owner_id` on every row — no tenancy `workspace_id`, no membership table.**
      task.md §2 scopes visibility to "their own documents and conversations" and never mentions
      workspaces. A nullable column we never read is speculative generality and harder to defend in
      an interview than a clean user-owned model with a documented upgrade path in SCALING.md.
- [ ] RLS on every table, with `(select auth.uid())` wrapping so Postgres runs an initPlan and
      evaluates identity once per statement instead of once per row. Supabase's published benchmark:
      **179ms → 9ms** on the simple `auth.uid() = user_id` case, and **178,000ms → 12ms** on a
      role-function policy. Indexing the policy column is the other half — **171ms → <0.1ms**.
- [ ] `owner_id` denormalized onto `chunks` + btree index, so the chunk policy is an indexed
      comparison rather than a join back through `documents`. Worker is the sole writer, keeping it
      in sync.
- [ ] HNSW index (`m=16, ef_construction=64`), GIN index on a generated `fts` tsvector column
- [ ] `hybrid_search` SQL function: vector + FTS CTEs fused by RRF, `SECURITY INVOKER` so RLS applies
- [ ] Seeding: **demo users created from a Node script via the Auth Admin API**, not raw
      `auth.users` inserts — direct inserts depend on Supabase's internal auth schema and password
      hashing, which shift between versions and are the usual reason a "one-command setup" breaks on
      someone else's machine. Document rows and their corpus come from `seed.sql`, which is stable.
- [ ] Confirm `supabase/config.toml` disables email confirmation locally, so signup works offline
      and the E2E test doesn't need a mail server (risk 13)
- Test: **the milestone's real deliverable** — integration tests proving user B's hybrid search
  returns zero of user A's chunks, executed with B's actual JWT.

### M2 — `packages/ai`, the provider layer (1d)
Framework-free on purpose: a reviewer can read the interface without NestJS in the way.
- [ ] `LlmProvider` / `EmbeddingProvider` interfaces + `capabilities` descriptor
- [ ] **Batch-first embeddings** (`embed(texts[])`, not `embed(text)`) — one-at-a-time embedding is
      the classic ingestion performance bug, and the interface should make the fast path the easy one
- [ ] `OpenAICompatibleProvider` + preset registry (openai, groq, together, openrouter, ollama)
- [ ] `FakeProvider`: deterministic, offline, zero-key. Embeddings are a **hashing vectorizer**
      (stable token → bucket hash, L2-normalized), **not** random hashes — so cosine similarity
      tracks real lexical overlap and retrieval returns sensible results. A random-vector fake would
      make both the zero-key demo and the CI eval meaningless, which is the trap here. Answers are
      extractive from retrieved context. Three jobs: reviewer demo without credentials, test double,
      CI without secrets.
- [ ] Composable decorators, each separately testable: `Retrying` (backoff + jitter, honors
      `Retry-After`, retries only 429/5xx/network), `Caching`, `Fallback`, `UsageTracking`
- [ ] Boot-time config validation: configuring Groq for embeddings fails immediately, with a message
      saying why
- Test: **one shared contract-test suite run against every implementation**, so "genuinely
  swappable" is a tested claim rather than a README claim. HTTP mocked with msw.

### M3 — `packages/rag`, pure logic (0.75d)
- [ ] Recursive markdown-aware chunker with overlap and token counting
- [ ] Content-hash chunk diffing (the incremental re-ingestion core)
- [ ] RRF fusion + metadata filtering
- [ ] Prompt builder with numbered citation markers + citation parser
- Test: the highest-value unit tests in the repo. Chunk boundaries, overlap correctness, unicode and
  code-fence edge cases, empty/huge documents, fusion ranking math, diff correctness.

### M4 — API: documents + ingestion (1d)
- [ ] `SupabaseModule`: request-scoped user client (RLS) + admin client (worker only)
- [ ] Auth guard verifying Supabase JWTs locally with `jose` — no shared secret, survives key
      rotation. Must handle **both** algorithms: Supabase CLI ≥2.71.1 defaults local projects to
      **ES256 (asymmetric, JWKS)**, while older local projects and some self-hosted setups use the
      legacy **HS256** shared secret. `config.toml` can pin `auth.jwt_algorithm`. Verify which the
      pinned CLI produces in M0 rather than assuming.
- [ ] Document CRUD with Zod DTOs from `packages/contracts` — title, content, optional tags,
      timestamps (task.md §3)
- [ ] pg-boss producer; worker module with dual-mode bootstrap (`main.ts` / `main.worker.ts`)
- [ ] Ingestion job: parse → clean → chunk → diff → embed (cache-aware) → upsert; status transitions
- [ ] Global exception filter → RFC 9457 problem+json, typed error codes in contracts
- Test: integration — create a document, drain the queue, assert chunk count, then edit one
  paragraph and assert the re-embed count is bounded (1–2 chunks) rather than the whole document.
  Assert on a bound, not an exact number, because overlap legitimately makes it two.

### M5 — API: retrieval + chat (1d)
- [ ] Hybrid retrieval service with optional LLM reranker behind a flag
- [ ] Optional tag filter on retrieval — the concrete payoff for tags, and the reason the metadata
      filtering in M3 exists rather than being decorative
- [ ] Query condensation for multi-turn
- [ ] Typed SSE protocol defined in `packages/contracts`: `token`, `citation`, `usage`, `done`, `error`
- [ ] Conversation + message + citation persistence
- [ ] Per-user rate limiting (`@nestjs/throttler`), stricter on chat than CRUD. Note the default
      tracker keys on **IP**, not user — a custom tracker keyed on the authenticated user id is
      required, or everyone behind one NAT shares a bucket.
- [ ] **Streaming correctness:** compression disabled on the stream route, `X-Accel-Buffering: no`,
      flush per event. Buffering middleware silently converts a stream into one blob at the end —
      the most common way streaming "works" in dev and dies behind a proxy.
- [ ] Mid-stream failures emit an SSE `error` event; you cannot change a status code after headers flush
- Test: integration with FakeProvider — assert event ordering, citations reference real chunk IDs,
  and an aborted client request cancels the upstream call.

### M6 — Web (1.5d)
- [ ] Supabase Auth (email/password) with `@supabase/ssr`; protected routes
- [ ] Document list/create/edit/delete with tag editing; live ingestion status
      (queued → processing → ready → failed)
- [ ] Filter the knowledge base by tag, and scope a chat to a tag subset
- [ ] Chat with streaming tokens, clickable citations opening the exact chunk in context
- [ ] Empty, loading, error and failed-ingestion states treated as first-class, not afterthoughts
- Test: component tests for the stream reducer; the full loop is covered by M7's E2E.

### M7 — Quality gate (0.75d) — **v1 ships here**
- [ ] Eval harness: ~25 question/expected-source pairs over the seed corpus; reports hit@k, MRR,
      faithfulness (LLM-judge). `pnpm eval`. Results table committed to the repo.
- [ ] Run the ablations that justify the design: chunk size 256/512/1024, vector-only vs hybrid,
      rerank on/off. **These numbers are the strongest artifact in the submission** — they convert
      every "I chose X" into "I measured X."
- [ ] One Playwright smoke test: sign up → create doc → ingest → ask → streamed answer with citation
- [ ] README (2-minute readable), DECISIONS.md, SCALING.md, architecture diagram
- [ ] **"Verified against" provider table** stating exactly which providers were actually tested.
      Claiming five and testing one is the kind of thing reviewers check.

### Optional, ranked by value-per-day

M8 and M9 are **task.md stretch goals** — offered by the client, so they land squarely on target.
M10 is pure insurance and the only item here the client never mentioned.

| # | Item | Est. | Notes |
|---|---|---|---|
| M8 | PDF/TXT upload + extraction | 0.5d | task.md stretch goal. unpdf; Supabase Storage; reuses the whole ingestion path. Highest demo value per hour. |
| M9 | Usage/token tracking view | 0.5d | task.md stretch goal. `usage_events` is already populated by the `UsageTracking` decorator — mostly a query and a page. Pairs naturally with the provider abstraction since pricing is per-provider config. |
| M10 | Live demo URL | 0.5d | Not requested. Vercel + hosted Supabase + Fly/Render for the API. Do last: it needs stable env contracts. |

**Honest total: ~7.5d core + ~1.5d optional ≈ 9 days.** M0–M7 is the week you asked for. Dropping
workspaces removed 1.5d and, more importantly, removed the only milestone where more work made the
submission match the brief *less*. If it still gets tight, cut M10 — it's the one item with no
line in task.md.

---

## 4. Testing strategy

Tests go where bugs are expensive or correctness is invisible — not for a coverage number.

| Layer | What | Mocked | Why it's worth writing |
|---|---|---|---|
| Unit | Chunker, RRF fusion, hash diffing, prompt/citation builder | nothing (pure) | Silent correctness. A chunker that drops the last 20 tokens produces a working app with quietly worse answers. |
| Unit | Retry/backoff, fallback, cache decorators | HTTP via msw | Failure paths that never run in dev and always run in production. |
| Contract | One suite × every provider implementation | HTTP | Makes "genuinely swappable" falsifiable. The single highest-signal test file in the repo. |
| Integration | RLS isolation, executed as two real users | nothing — real local Postgres | The security claim. Mocking here would test nothing. |
| Integration | Ingestion job end-to-end, incremental re-ingest | FakeProvider | Proves the diffing actually saves calls. |
| Integration | SSE event ordering, cancellation | FakeProvider | Streaming breaks in ways unit tests can't see. |
| E2E | One Playwright happy path | nothing | Proves the whole loop for real. |
| Eval | Retrieval + faithfulness over a fixture set | FakeProvider in CI, real provider locally | Quality measured, not assumed. |

**Mocking rule:** mock the network boundary, never our own logic. RLS and migrations always run
against real Postgres, because a mocked RLS test proves nothing about RLS.

CI: lint → typecheck → unit → (Supabase in Docker) migrations + integration → deterministic eval subset.

---

## 5. Risks and mitigations

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | ~~Node too old for `@nestjs/schematics@12`~~ | **RESOLVED 2026-09-23** | fnm 1.39.0 installed; Node **24.21.0** is now the default, pnpm **12.5.1** via corepack. Still ship `.nvmrc` + `engines` + a setup preflight so *reviewers* hit a clear message rather than a stack trace. |
| 2 | TypeScript 7 is `latest` on npm; installing it breaks `nest build` and typescript-eslint | High | Pin `typescript@6.0.3` explicitly at the root. Document why in DECISIONS.md — knowing the bleeding edge exists and declining it is the point. |
| 3 | Local Supabase may ship pgvector < 0.8 → no iterative scan, so RLS-filtered vector search can under-return rows | Medium | **Verify in M0.** If old: over-fetch 3x before filtering and note the constraint. Do not assume the version. |
| 4 | Vitest + NestJS 12 ESM + decorator metadata friction | Medium | Timeboxed 2h spike in M0. Fall back to Jest+SWC. Don't discover this in M4. |
| 5 | SSE buffering — streaming works in dev, arrives as one blob in prod | Medium | Disable compression on the stream route, `X-Accel-Buffering: no`, flush per event, verify in a real browser not just curl. |
| 6 | Scope overrun from optional milestones | Medium | Hard gate: M0–M7 must be shippable and committed before M8 starts. Each optional item is its own branch and commit series. Dropping workspaces cut this risk from high to medium. |
| 7 | Reviewer has no OpenAI key and sees a dead app | Medium | FakeProvider means the app boots and works with zero keys, and its hashing-vectorizer embeddings make retrieval genuinely demonstrable. Plus the live demo URL (M10). |
| 8 | Ollama's OpenAI compatibility is officially experimental and subject to breaking changes | Medium | Ship the preset, and state plainly in the README which providers were actually tested. Honesty here reads as senior; an untested five-provider claim reads as careless. |
| 9 | Next 16 removed `next lint`; a copied turbo config silently lints nothing | Low | Call eslint directly in the lint task; assert it fails on a deliberate violation once. |
| 10 | Docker image pull is slow on the reviewer's machine | Low | Document the one-time cost in the README; the demo URL is the escape hatch. |
| 11 | **Seeding demo users locally.** Creating auth users is on the critical path for one-command setup, and Supabase's local ES256 switch produced a known class of `signing method HS256 is invalid` failures when creating users (CLI issue #4820, filed Feb 2026 against 2.76.3; fix status unconfirmed on 2.117.0). | Medium | Seed users from a Node script via the **Auth Admin API with the service-role key**, not Studio and not raw `auth.users` inserts (which are brittle across Supabase versions). Verify on the pinned CLI in M0; fall back to pinning `auth.jwt_algorithm = "HS256"` in `config.toml` if needed. |
| 12 | **pg-boss over a transaction-mode pooler silently fails to pick up jobs.** pg-boss uses LISTEN/NOTIFY, which is session-scoped. Bites on deploy (M10), not locally. | Medium (M10 only) | Worker connects on a **session-mode or direct DSN** (Supabase port 5432), never the transaction pooler (6543). Keep it a separate env var from the app's connection string so the distinction is explicit rather than accidental. |
| 13 | E2E signup blocks on email confirmation | Low | `supabase/config.toml` disables confirmations locally; the Playwright test asserts the flow rather than reading mail. Verify the flag is actually set in M1. |

---

## 6. What a reviewer will actually look at

Ordered by how fast they'll reach for it, and what each has to prove in the first two minutes.

1. **README** — what it is, an architecture diagram, run it in one command, how to swap providers,
   what's next. Must be skimmable in 2 minutes.
2. **Does it run?** `pnpm setup && pnpm dev`. Preflight-checks Docker and Node, starts Supabase,
   applies migrations, seeds demo data, prints login credentials. This is the highest-leverage
   requirement in the whole assignment and the most common place take-homes die.
3. **`packages/ai`** — the key requirement. They will read the interface before they read anything
   else. It has to look designed, not accumulated.
4. **The RLS policies and the `hybrid_search` function** — they will look specifically for whether
   retrieval can leak across users.
5. **DECISIONS.md** — chunking, embedding model, retrieval, schema, queue, caching, workflow-vs-agent.
   Each: what we chose, what we rejected, why. Short entries, no essays.
6. **The eval results table** — the thing most submissions won't have.
7. **SCALING.md** — hundreds → millions. What breaks first (HNSW build time and `maintenance_work_mem`,
   then embedding API throughput, then the queue), what changes (standalone workers → BullMQ at a
   stated threshold, partitioning, read replicas, halfvec/quantization), and costs at each tier.
   Also where multi-tenant workspaces would slot in, since task.md scopes v1 to user-owned documents.
8. **Commit history** — a build story, milestone by milestone.
9. **Two Looms** — the app, and how AI accelerated development. The second is easy to forget and is
   explicitly required; keep a running dev log from day one so it isn't reconstructed from memory.

---

## 7. Scope

### Must have (v1, M0–M7)
Turborepo with real shared packages · Supabase Auth · document CRUD · chunk/embed/store on create
**and update** · hybrid retrieval · grounded answers with citations · streaming · provider-agnostic
AI layer with 2+ implementations and boot-time validation · RLS-enforced isolation · background
ingestion with visible status · one-command setup · tests where they matter · CI · README +
DECISIONS.md + SCALING.md · eval harness with committed results.

Documents are **user-owned** throughout, per task.md §2.

### Extras, in build order
PDF/TXT upload (M8) → usage/token tracking view (M9) → live demo URL (M10).
M8 and M9 are task.md stretch goals; M10 is not requested.

### Explicitly out of scope — and why, so it reads as judgment rather than omission
- **Workspaces / shared documents.** task.md scopes visibility to a user's *own* documents and
  conversations. Building team tenancy would diverge from the spec, not exceed it. Noted in
  SCALING.md as a migration path.
- **Agentic retrieval loops.** 3–10x tokens, needs stop conditions, no payoff on single-corpus Q&A.
- **Semantic chunking.** Reported gains range from 2–6 points (Chroma) to 15–25% (vendor blogs) for
  3–5x the compute. We don't adopt it on contested evidence; the eval harness is how we'd decide.
- **External vector DB.** Mandated against, and it would move data out from behind RLS.
- **Redis.** No throughput number justifies it yet. SCALING.md names the threshold where it does.
- **OAuth / SSO, org billing, soft deletes, document versioning.** Not asked for.
- **Cross-encoder reranking.** Would need a Python service or ONNX runtime for a gain we can get
  most of from RRF.

---

## 8. Evidence — where the load-bearing claims come from

Verified against primary sources on 2026-09-23, not recalled. Anything not listed here is judgment
or estimate, and is labelled as such above.

**Verified directly from the npm registry** (`npm view <pkg> version engines peerDependencies`):
all pinned versions; `@nestjs/schematics@12` engines `^22.22.3 || ^24.15.0 || >=26`;
`typescript-eslint@8.70.1` peer `typescript: >=4.8.4 <6.1.0`; `openai@7` requires Node >=22;
`pg-boss@12` requires Node >=22.12; `vitest@5` engines `^22.12 || ^24 || >=26`; the `supabase` CLI
is installable as a devDependency.

| Claim | Source |
|---|---|
| RLS applies to vector similarity search with no `SECURITY DEFINER` wrapper | [Supabase: RAG with Permissions](https://supabase.com/docs/guides/ai/rag-with-permissions) |
| `(select auth.uid())` 179ms→9ms; role policy 178,000ms→12ms; index 171ms→<0.1ms | [Supabase: RLS Performance and Best Practices](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) |
| Hybrid search SQL: vector + FTS CTEs fused by RRF, `rrf_k` default 50 | [Supabase: Hybrid search](https://supabase.com/docs/guides/ai/hybrid-search) |
| HNSW/IVFFlat cap at 2,000 dims for `vector` (4,000 for `halfvec`); iterative scan added in 0.8.0 | [pgvector README](https://github.com/pgvector/pgvector) |
| `nest build` cannot run on TS 7 (no compiler API); `emitDecoratorMetadata` itself does work | [NestJS and TypeScript 7](https://fernforge.github.io/devnotes/nestjs-typescript-7/) |
| NestJS 12 Node requirements, ESM-only packages, `StandardSchemaValidationPipe` | [NestJS migration guide](https://docs.nestjs.com/migration-guide) |
| Next 16 removed `next lint`; `params`/`searchParams` are Promises; Turbopack default | [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16) |
| Chat Completions still supports function calling; GPT-6 Astra requires Responses for tool calling | [OpenAI: Function calling](https://developers.openai.com/api/docs/guides/function-calling) |
| `text-embedding-3-small`: 1536 dims, 8192 max input, $0.02/M, Matryoshka `dimensions` param | [OpenAI: New embedding models](https://openai.com/index/new-embedding-models-and-api-updates/) |
| Supabase CLI ≥2.71.1 defaults local JWTs to ES256; local create-user failures | [supabase/cli #4726](https://github.com/supabase/cli/issues/4726), [#4820](https://github.com/supabase/cli/issues/4820) |
| RFC 9457 obsoletes RFC 7807 (July 2023) | [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) |
| pg-boss uses LISTEN/NOTIFY → needs session-mode, not transaction-mode pooling | [Supabase: pooling and limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits) |
| Ollama's OpenAI compatibility is experimental and subject to breaking changes | [Ollama: OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) |

**Contested — treated as hypotheses to measure, not facts:**
chunking defaults and the semantic-vs-recursive gap (sources disagree: 2–6 points vs 15–25%);
whether overlap helps at all; the 3–10x token multiplier for agentic RAG; hybrid search precision
figures (one source claims 62%→84%). These come from vendor blogs and practitioner write-ups of
varying rigour. Every one of them is something our own eval harness measures, which is the point.

**Deliberately unverified until M0, because it needs the CLI installed:**
the exact Postgres and pgvector versions `supabase start` ships on 2.117.0, and which JWT algorithm
it produces. Both are gated verification tasks, not assumptions.

---

## Open questions for you

1. **Node 24 LTS** — confirm you're willing to upgrade from 22.13.0. Everything else assumes it.
2. **Time budget** — "about a week" as ~5–7 focused days, or evenings? Changes where the M7 gate lands.
3. **Loom dev log** — I'd keep a running notes file from M0 so the "how AI accelerated development"
   Loom is accurate rather than reconstructed. Worth the small overhead?
