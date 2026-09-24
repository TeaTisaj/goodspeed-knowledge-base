# Decisions

Each entry: what we chose, what we rejected, and why. Short by design.
Environment facts are dated and were measured, not assumed.

---

## D0. Environment verification gate (M0)

The plan refused to assume three things that could not be known without running the stack.
Measured **2026-09-23** against Supabase CLI **2.117.0**.

| Question                     | Answer                               | Consequence                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres version             | **17.6**                             | —                                                                                                                                                                                                                                                          |
| pgvector version             | **0.8.2**                            | ≥0.8.0, so **iterative scan is available**; `set hnsw.iterative_scan = strict_order` verified settable. Matters because pgvector applies RLS _after_ scanning the ANN index, so a filtered search can under-return rows without it.                        |
| `halfvec` type               | present                              | Escape hatch if we ever exceed the 2,000-dim HNSW ceiling for `vector`. Not needed at 1536.                                                                                                                                                                |
| JWT algorithm                | **ES256** (asymmetric, P-256)        | JWKS at `/auth/v1/.well-known/jwks.json` serves the public key, and the `kid` in issued access tokens matches it. The auth guard verifies **locally via JWKS** — no shared secret, survives rotation.                                                      |
| Auth Admin API user creation | **works**                            | [supabase/cli#4820](https://github.com/supabase/cli/issues/4820) (`signing method HS256 is invalid` on local user creation) does **not** reproduce on 2.117.0. Seeding demo users via the Admin API is safe, so we avoid brittle raw `auth.users` inserts. |
| Email confirmation           | disabled by default in `config.toml` | Signup works offline; the E2E test needs no mail server.                                                                                                                                                                                                   |

Retained risk: these are facts about **CLI 2.117.0**. The CLI is pinned as a devDependency precisely
so a reviewer gets the same answers rather than whatever is current.

---

## D1. Chat Completions, not the Responses API

**Chosen:** target `/v1/chat/completions`.
**Rejected:** the Responses API, which OpenAI recommends for new projects.

The assignment's key requirement is that any OpenAI-spec-compatible provider swaps in via config.
Groq, Together, OpenRouter and Ollama implement Chat Completions; none implement Responses. Taking
the recommended path would have quietly broken the most heavily weighted requirement.

Cost, stated precisely: Chat Completions **still supports custom function calling** — it is not
deprecated. What is Responses-only is OpenAI's newest model's tool calling and OpenAI's hosted tools
(web search, code interpreter, MCP). Those are proprietary, so depending on them would break
portability regardless. v1 is a deterministic workflow that calls no tools, so today this costs
nothing.

---

## D2. One adapter plus presets, not five provider classes

**Chosen:** a single `OpenAICompatibleProvider` configured by a preset registry.
**Rejected:** one class per provider.

All five targets speak the same wire protocol, so five classes would be five copies of the same
code. The real variation is **capability and endpoint**, and that is what the interface models: a
declared `capabilities` descriptor validated at boot, so configuring Groq — which has no embeddings
endpoint — fails on startup with an actionable message instead of at request time.

---

## D3. RLS is the permission boundary, not application code

**Chosen:** request-scoped Supabase client built from the caller's JWT; Postgres enforces isolation
on every query including vector search.
**Rejected:** service-role key everywhere with `WHERE owner_id = ?` in application code.

Supabase's RAG-with-permissions guide confirms RLS applies to similarity search with no
`SECURITY DEFINER` wrapper. App-level filtering is one forgotten clause away from a cross-user leak,
and a `SECURITY DEFINER` match function with no user filter is the classic version of that bug.
Service-role credentials are held by the ingestion worker only.

---

_(Further entries — chunking, embedding model, retrieval, schema, queue, caching, workflow vs agent
— land as those milestones complete.)_
## D4. The API is a native ESM package

**Chosen:** `"type": "module"` in `apps/api`, `module`/`moduleResolution: NodeNext`.
**Rejected:** CommonJS with `moduleResolution: Node10`.

NestJS 12 ships ESM-only packages. A CommonJS app can consume them through `require(esm)` at
runtime, but TypeScript *statically* rejects it (TS1479), and the only way to silence that is
`moduleResolution: Node10` — which TypeScript 6 already deprecates and TypeScript 7 removes. Going
ESM resolves both at once and keeps the project TS7-ready. `baseUrl` was dropped for the same reason.

Verified end to end: `nest build` emits working ESM, the app boots, DI resolves, `/health` responds.

---

## D5. `consistent-type-imports` is disabled for NestJS code

**Chosen:** turn the rule off in the Nest ESLint preset.
**Rejected:** enabling it repo-wide, which is the usual default.

A correctness fix, not a style preference. With `emitDecoratorMetadata`, Nest resolves constructor
dependencies at runtime by reading `design:paramtypes`. A service appearing only in a type position —
which is every injected dependency — must still be a **value** import. Rewriting it to `import type`
erases the reference and the DI container injects `undefined`: at runtime, with no compile error and
no test failure unless something exercises that path.

`eslint --fix` would have made that change across the whole codebase. The rule stays on everywhere
else. `no-useless-assignment` is off for the same underlying reason: ESLint does not traverse
decorator arguments, so a schema used only in `@Param('id', { schema })` reads as unused.

---

## D6. `process.loadEnvFile()` instead of dotenv or `@nestjs/config`

**Chosen:** Node's built-in env loader plus a hand-rolled Zod-backed `ConfigService`.
**Rejected:** `@nestjs/config` and its `dotenv` dependency.

`process.loadEnvFile` is native from Node 20.12 and this project pins Node 24, so the dependency
buys nothing. The larger win is typing: `@nestjs/config`'s `get()` returns `string | undefined` and
pushes casting to every call site, whereas the Zod schema has already coerced and narrowed —
`config.env.PORT` is a `number`, and `AI_EMBEDDING_DIMENSIONS` is rejected at boot if it exceeds
pgvector's 2,000-dimension HNSW ceiling.

Two fewer dependencies and stronger guarantees.

---

## D7. Dependency freshness policy

**Chosen:** prefer releases with several days of exposure over whatever is newest.

pnpm's supply-chain check flagged `turbo`, `@nestjs/cli`, `next`, `@supabase/supabase-js`, `openai`
and `pg-boss` as published within 24 hours. Each was stepped back to a settled patch — same minor
versions, no feature difference that matters here.

A project whose purpose is demonstrating judgment should not run packages published yesterday. Same
reasoning pins TypeScript 6.0.3 over the newer 7.x.

---

## D8. Capability modelling is the abstraction, not the base URL

**Chosen:** providers declare a `capabilities` descriptor; configuration is validated against it at
boot.
**Rejected:** treating `baseURL` as the abstraction.

The OpenAI SDK already accepts a `baseURL`, so pointing it at Groq is a config field, not a design.
What actually breaks on a provider swap is the capability surface:

- Groq has no embeddings endpoint at all
- Ollama's `nomic-embed-text` emits 768 dims where OpenAI emits 1536
- Ollama rejects `stream_options`, so requesting streamed usage errors
- `text-embedding-3-large` emits 3072 dims, above pgvector's 2,000-dim HNSW ceiling

Each is now a boot-time failure with a message naming the fix. Configuring Groq for embeddings says
so *and* suggests pairing it with OpenAI or Ollama, rather than producing a 404 mid-ingestion. The
embedding provider also verifies returned vector width against the configured dimension, so a model
mismatch is caught at the provider rather than as an opaque pgvector error.

---

## D9. Decorator stack over inheritance

**Chosen:** `usage-tracking( fallback( retry( provider ) ) )`, each a separate class.
**Rejected:** a base class with retry and caching baked in.

Order is load-bearing. Retry is innermost, so a retried call stays one logical request. Fallback
wraps retry, so the secondary is only tried after the primary exhausted its budget. Usage tracking is
outermost, so it records what the caller actually received. Caching sits outside retry, so a cache
hit never consumes retry budget.

Two behaviours worth stating because they are easy to get wrong:

- **Streaming is never retried after the first token.** A retry would replay the response from the
  start and the user would see duplicated text — worse than the error. Same rule for fallback.
- **`bad_request`, `context_length` and `cancelled` never trigger fallback.** They are properties of
  the request, so a second provider fails identically; falling back turns one fast failure into two
  slow ones.

---

## D10. The fake provider uses a hashing vectorizer, not random vectors

**Chosen:** tokens hashed into buckets with signed hashing and sublinear scaling, L2-normalised.
**Rejected:** deterministic random vectors from a content hash.

The fake has three jobs: let a reviewer run the app with no API keys, act as the test double, and let
CI run the retrieval eval without secrets. Random vectors satisfy determinism while destroying the
last two — retrieval would return arbitrary chunks, the demo would look broken, and the eval would
measure noise.

A hashing vectorizer gives cosine similarity that tracks lexical overlap. Not semantic — "car" and
"automobile" stay unrelated — but a real monotonic signal, enough for the demo to behave sensibly and
the eval to have a meaningful floor. A test asserts it ranks a small corpus correctly, because that
property is the entire point.

Two later fixes, after seeing its output in the real pipeline: it extracts only from the **numbered
source blocks**, never the instruction preamble (the "answer" was previously the prompt's rules read
back), and it emits real `[n]` citation markers so citation resolution and the clickable-source UI
are exercised with no key. Its sentence filter is token-based, not character-based: *"A deploy takes
eight minutes."* is 29 characters and is exactly the kind of short factual sentence users ask about.

---

## D11. The contract suite is what makes "swappable" a testable claim

One shared suite runs against every implementation — the fake plus all five OpenAI-spec providers
against a stubbed transport. No keys, no network.

A README cannot test a claim. If a provider violates the interface — wrong vector count, missing
terminal event, non-unit vectors, out-of-order embeddings — it fails here rather than in production.

---

## D12. Chunking: recursive and structure-aware, 512/64, measured not assumed

**Chosen:** recursive splitting on a separator hierarchy (headings, paragraphs, lines, sentences,
words), ~512 tokens, ~64 token overlap.
**Rejected:** semantic chunking, and fixed-size character splitting.

The published evidence genuinely conflicts. Some 2026 write-ups put semantic chunking 15–25% ahead of
recursive; Chroma's benchmark puts it at 85–90% recall versus 91–92% — a 2–6 point gap for 3–5x the
compute. One January 2026 analysis found overlap provided no measurable benefit at all.

So the defensible position is not "512 is correct", it is "512 is the consensus default, the
parameters are configurable, and the eval harness measures them against *our* corpus." Semantic
chunking is not ruled out on principle — it is not adopted on contested evidence.

The separator hierarchy matters more than the number: a boundary should fall where a human would see
a break, so a chunk stays self-contained enough to answer a question alone. See `eval/RESULTS.md` for
what the measurement actually said, including where it disagrees with this default.

---

## D13. Incremental re-ingestion by content hash

Editing a document re-embeds only the chunks whose text actually changed. Chunks are matched by
SHA-256 of their content, so unchanged text is kept, moved text is reused at its new index, and
removed text is deleted.

Stated honestly, because the failure mode is real: a large insertion can shift downstream chunk
boundaries and change hashes for chunks whose meaning did not change. Structure-aware splitting makes
cascades uncommon — boundaries land on headings and paragraph breaks an edit elsewhere does not move —
but does not eliminate them. The pipeline reports the **measured** reuse ratio rather than advertising
a best case, and the test asserts a bound rather than an exact count, because overlap legitimately
makes a one-paragraph edit touch two chunks.

Measured end to end: editing one section of a 28-section document gave +1 new, 2 reused, -1 removed.

Duplicate text within one document maps to a *queue* of rows, not a single row, so a repeated
paragraph keeps one row per occurrence.

---

## D14. Citation numbers resolve server-side, and invalid ones are dropped

The model sees numbered sources and cites numbers. The mapping back to chunk and document ids never
leaves the server.

Out-of-range citations are **dropped, not clamped**. If the model emits `[9]` against 5 sources, that
produces no citation at all. Clamping would attach a confident-looking link to a document that did not
support the claim — a worse failure than a missing citation, because it looks correct.

Sources that do not fit the context budget are dropped whole rather than truncated, and the remainder
renumbered, so a citation can never point at text the model was shown only half of.

---

## D15. No queue-level debounce; idempotent jobs instead

**Chosen:** every save enqueues a job, and `ingest()` short-circuits on an unchanged content hash.
**Rejected:** pg-boss `singletonKey` to collapse rapid successive saves.

The singleton was tried first and silently broke re-ingestion. pg-boss enforces uniqueness on the key
across **all** job states, including `completed`, so once a document's first job finished, every
subsequent `send()` returned `null`. Editing a document left it in `queued` forever with no error
anywhere: the HTTP request succeeded, no job existed, and nothing logged.

Two fixes, because there were two bugs. The debounce is gone — duplicate jobs are cheap, since the
content hash is compared before any chunking work. And `send()` returning `null` is now logged as an
error; ignoring a null return is what turned a queue rejection into a silent stall.

The more useful half of the lesson: this was an optimisation added before it was needed, for a
workload measured in single-digit jobs per minute. It bought nothing and cost correctness.

---

## D16. A defaulted field must not appear in a PATCH schema

`updateDocumentSchema` originally reused the create schema's `tags` field, which carries
`.default([])`. Zod applies the default during parsing, so `PATCH {}` became `{ tags: [] }` — which
satisfied the "at least one field" guard *and then wrote an empty array*, silently clearing the
document's tags.

Update schemas now use the undefaulted array, and the guard checks for a defined value rather than key
presence. The distinction that matters is preserved: an omitted `tags` leaves them alone, an explicit
`tags: []` still clears them.

Found by a test written against the schema's stated intent rather than its implementation.

---

## D17. The RAG pipeline is a workflow, not an agent

**Chosen:** fixed steps — `[multi-turn only] condense → embed → hybrid retrieve → [optional rerank] →
build prompt → stream → persist`.
**Rejected:** agentic retrieval, where the model decides when and whether to search.

The model never chooses control flow, so cost and latency are bounded and the same question takes the
same path every time. Agentic retrieval needs explicit iteration budgets and stop conditions to avoid
running away on cost, and practitioner reports put multi-step reflection loops at roughly 3–10x the
tokens of classic RAG. On single-corpus Q&A that does not pay for itself.

The one place a model call is spent beyond the answer is **query condensation**, and it runs only when
there is history to condense. Without it, "what about the second one?" embeds to nothing useful and
retrieval returns noise — a failure the deterministic path genuinely cannot fix. First-turn questions
skip it. A condense call that fails or returns junk falls back to the raw question.

Reranking is off by default for the same reason: RRF fusion is free and deterministic, the reranker
costs a call, and the eval decides whether it earns its place. A reranker that errors or returns
nothing usable degrades to fusion order rather than emptying the context.

---

## D18. Streaming: what actually makes it work in production

The chat route writes SSE directly rather than using Nest's `@Sse()` decorator, because three details
decide whether streaming works outside localhost:

- `X-Accel-Buffering: no`, or nginx buffers the whole response and the stream arrives as one blob at
  the end — which looks perfect in development.
- No compression on this route: gzip holds small token deltas in its buffer until the response ends.
- `flushHeaders()`, so the client opens the stream instead of waiting for the first token.

**Errors after the first byte are events, not status codes.** Once headers are flushed there is no
status left to set, so a mid-stream failure emits an SSE `error` event; throwing would leave the
client hanging on a half-written response. The global exception filter checks `headersSent` for the
same reason.

Client disconnects abort the upstream provider call, so an abandoned tab stops burning tokens.

---

## D19. Three silent failures found by testing end to end

All three were invisible to unit tests and produced no error anywhere.

**Seeded documents were never ingested.** A document reaches `queued` from the API (which enqueues),
the seed script (which does not), or a crash between the database write and the enqueue. A reviewer
running the seed saw an empty knowledge base with nothing logged. Fixed with a startup reconciler that
enqueues anything still in `queued` — safe on every boot because ingestion short-circuits on an
unchanged content hash.

**Citations were never persisted.** `message_citations` had a SELECT policy but no INSERT policy, so
RLS rejected the write; the result was unchecked, so every answer was stored with zero citations while
appearing to work. Fixed with a scoped INSERT policy and a checked error — logged rather than thrown,
since the answer has already streamed.

**CORS allowed only one host.** `localhost` and `127.0.0.1` are different origins to a browser. The
API tested fine with curl while the browser showed a blank page with a console error. Both are allowed
by default now, because a reviewer may open either.

The pattern is the lesson: unchecked return values are how a feature appears to work while doing
nothing.

---

## D20. Upload extracts in the request, not the worker

**Chosen:** parse the file during the HTTP request; queue only after extraction succeeds.
**Rejected:** storing the raw file and extracting in the worker.

A file that cannot be read should fail the upload with a message the user can act on — "this PDF is
scanned, OCR is not supported", "it may be encrypted" — rather than creating a document that silently
lands in `failed` seconds later. Extraction is fast and bounded by a 10MB limit.

Everything after extraction is the ordinary path: the document is created and ingested by the same
queue and worker as a typed one. Upload adds a *source of text*, not a parallel pipeline. `unpdf` is
imported lazily, because it bundles a sizeable PDF.js build and a deployment that never receives a PDF
should not pay for it at boot.

**PDF cleaning is not cosmetic.** Extracted text arrives hyphenated across line breaks, hard-wrapped
mid-sentence, and carrying a header on every page. Each breaks something specific: `deploy-\nment` is
two useless tokens to a keyword index, hard wrapping defeats the sentence splitter, and a header
repeated on every page drags every chunk toward the same embedding. Running furniture is detected by
frequency — a *short* line repeated across many lines is furniture, a repeated paragraph is content.

---

## D21. Unknown cost is null, not zero

The usage view reports `n/a` for models with no published price, never `$0.00`. "We do not know what
this cost" and "this was free" are different claims, and showing the second when you mean the first is
how a cost dashboard becomes untrustworthy.

The same honesty applies to token counts: they are measured with OpenAI's tokenizer, so counts for
Llama-family models on Groq, Together or Ollama are approximations. The UI says so rather than implying
precision it does not have.

Usage rows are written by the **service role only** — there is no INSERT policy for authenticated
users, because a user able to insert their own rows would make billing-adjacent figures meaningless.
Recording usage never fails the operation it measures: a write error is logged, not thrown, because an
answer should not be lost to an analytics failure.

---

## D22. The eval harness was rebuilt after the first one measured nothing

The first version used five short documents. They produced five chunks, and every configuration scored
100% on hit@5. It looked like a result and measured nothing — **worse than having no harness**, because
a table of 100%s reads as evidence.

Rebuilt with eight documents averaging ~1,240 tokens, 35 questions, and **chunk-level scoring**: a hit
requires the returned chunk to actually contain the answer span, because retrieving the right document
but the wrong chunk still produces an unanswerable prompt.

The rebuilt version immediately contradicted a default — 1024-token chunks score 97% hit@1 against
512's 89%. Rather than ignoring that or changing the default, the results table reports **top-5 as a
share of corpus** beside it: at 1024 there are only 16 chunks, so a top-5 set is 31% of everything
against 11% at 256. Part of the improvement is simply an easier problem. The default stays 512 for
reasons the harness cannot measure — context budget and citation precision.

Full numbers and caveats in [eval/RESULTS.md](eval/RESULTS.md).
