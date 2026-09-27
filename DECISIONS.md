# Decisions

What I chose, what I rejected, and why.

## 1. Chat Completions, not the Responses API

OpenAI recommends Responses for new projects, but Groq, Together, OpenRouter and Ollama only
implement Chat Completions. Following the recommendation would have broken the portability
requirement. What's Responses-only (hosted tools, some newest-model tool calling) is proprietary
anyway, and this workflow calls no tools.

## 2. The provider abstraction is capabilities, not a base URL

The OpenAI SDK already takes a `baseURL`, so that part is a config field, not a design. What breaks
on a swap is what the provider can do: Groq has no embeddings, Ollama emits 768-dim vectors,
`text-embedding-3-large` exceeds pgvector's 2,000-dim HNSW limit, and streamed token usage varies.

- **One adapter plus a preset table**, not a class per provider. Every target speaks the same
  protocol; what differs is endpoint and capabilities, which is data.
- **Capabilities are validated at boot.** `AI_EMBEDDING_PROVIDER=groq` fails on startup with a
  message naming the fix. The API also checks `AI_EMBEDDING_DIMENSIONS` against the actual
  `vector(N)` column and refuses to start on a mismatch.
- **Capabilities drive behaviour.** The prompt budget is `min(MAX_CONTEXT_TOKENS, provider window)`,
  so moving to a smaller model shrinks it without a config change.
- **Provider names are open.** Any name with a base URL is valid; presets only save typing. The env
  schema derives its known list from the presets, so the two can't drift.

## 3. Resilience as decorators

`usage-tracking( fallback( retry( provider ) ) )`, with the embedding cache outside retry. Retry
innermost keeps a retried call as one request; fallback only runs after retries are exhausted; usage
records what the caller actually got.

Streams are never retried or failed over after the first token (the user would see duplicated
text). `bad_request`, `context_length` and `cancelled` never fall back, since a second provider
would fail the same way.

## 4. "Swappable" is tested, not claimed

One contract suite (`packages/ai/src/testing/contract.ts`) runs against every provider twice:
stubbed in CI, and live with `pnpm test:live`. Live runs found things stubs couldn't: two retired
default models, Groq's reasoning models returning empty text under small token budgets, and Gemini
and Ollama reporting streamed usage that their presets said they didn't. I also pointed the app at
an OpenAI-spec server it had never seen, using env vars only, and ran ingest → chat → citation
through it.

## 5. RLS is the permission boundary

The API queries with a client built from the caller's JWT, so Postgres enforces isolation on every
query, vector search included. There is no `owner_id` filter in application code to forget.

- Search functions are `SECURITY INVOKER`. A `SECURITY DEFINER` match function with no user filter
  is the classic RAG cross-user leak.
- Users can read but not write `chunks`. Only the worker writes them, so a user token can't plant
  retrievable text.
- `embedding_cache` is shared across users (keyed by content hash) and has no user policy at all;
  exposing it would let one user test whether another had ingested some text.
- Policies use `(select auth.uid())` so it runs once per statement, and every policy column is
  indexed.

Integration tests run against real Postgres, and I checked they fail when RLS on `chunks` is
disabled.

## 6. Schema

- `chunks.owner_id` and `chunks.tags` are copied from the document, so the RLS check and tag filter
  on the hottest query are plain indexed columns, not joins. The worker is the only writer.
- `fts` is a generated `tsvector` column, so it can't drift from `content`. It's English-only
  because a generated column needs an immutable config; another language is a migration.
- `chunks.embedding_model` is stored, and retrieval refuses to compare vectors from different models.
- Citations keep a quote snapshot and `on delete set null`, so old answers stay readable after a
  document changes.
- Changing embedding model re-embeds on the next start: the worker requeues every document with
  chunks from another model. A change of vector size is a schema change instead, so the API refuses
  to boot and `pnpm reembed` generates the migration.

## 7. Chunking: recursive, structure-aware, 512 tokens / 64 overlap

Splits on the strongest boundary available (headings, paragraphs, lines, sentences, words), so a
chunk stays self-contained. 512/64 is the common default and needs no model calls. Semantic
chunking's published advantage is small and contested, for several times the cost. `maxTokens`
includes the overlap, so the configured number is what reaches the prompt. The sizes were measured
in [eval/README.md](eval/README.md).

## 8. Ingestion: background, incremental, idempotent

- **pg-boss, not Redis.** The queue lives in the Postgres I already run, so setup has no extra
  service. [SCALING.md](SCALING.md) gives the threshold where that changes.
- **Incremental.** Chunks are matched by content hash, so an edit re-embeds only changed chunks.
  Prepending a section to an 18-chunk document reused 12. Renumbering the survivors is one atomic
  SQL call.
- **Idempotent instead of debounced.** Every save enqueues a job and unchanged content is skipped
  before any work. I tried pg-boss `singletonKey` first; it dedupes against completed jobs too, which
  silently blocked every re-ingest.
- On boot the worker enqueues anything still `queued` (seeded documents, or a crash between write
  and enqueue).
- **Upload extracts in the request.** An unreadable or scanned PDF fails the upload with a clear
  message instead of becoming a document that fails later. PDF text is de-hyphenated, unwrapped, and
  stripped of repeated headers.

## 9. Hybrid retrieval with Reciprocal Rank Fusion

Vector search plus Postgres full-text, fused by rank. Cosine distance and `ts_rank` are on
incomparable scales, so any weighted blend needs constants that drift with the corpus; RRF only uses
ranks. With a real embedding model the two arms miss different questions and hybrid beats both.

Each arm queries `chunks` directly so it can use its index (HNSW and GIN), with pgvector's iterative
scan on so RLS and filters can't cut results short. An earlier version shared a filtered CTE between
the arms; Postgres materializes a CTE referenced twice, so neither index was used. An integration
test now checks that both indexes are hit.

A reranker exists but is off by default: it costs a model call and the eval hasn't shown it pays.

## 10. A workflow, not an agent

Fixed steps: `[follow-ups] condense → retrieve → relevance floor → build prompt → stream → persist`.
The model never picks the control flow, so cost and latency are bounded. Agentic retrieval needs
iteration budgets and stop conditions, and costs several times the tokens, for no clear gain on
single-corpus Q&A. The one extra call, condensing a follow-up into a standalone question, is there
because "what about the second one?" retrieves nothing useful.

## 11. Retrieved text is data, and off-topic questions never reach the model

- **Channel separation.** The system message holds only rules. Sources go in the user turn inside
  tags a document can't forge; structural tags in document text are escaped and invisible Unicode
  (tag characters, zero-width, bidi) is stripped.
- **Output.** No links or images in answers or in the renderer, since an image is fetched on render
  (a classic exfiltration channel). Citations resolve server-side; out-of-range numbers are dropped,
  not clamped.
- **Relevance floor.** When nothing clears a similarity floor measured for the embedding model, the
  API streams a fixed refusal with no model call.
- **Not built:** a classifier that blocks "injection-looking" text. It's easy to evade and would
  refuse a runbook that discusses injection. Heuristic hits are logged instead.

Tested against eleven poisoned documents, including a white-on-white instruction in a real PDF: 0%
attack success, 100% utility.

## 12. Streaming that survives production

Raw SSE rather than Nest's `@Sse()`: `X-Accel-Buffering: no` so nginx doesn't buffer the stream, no
compression on the route, and headers flushed immediately. Errors after the first byte are stream
events, since the status code is already sent. A client disconnect aborts the provider call.

## 13. Usage numbers are request-scoped

Token usage is billing-adjacent, so each request gets its own bucket via `AsyncLocalStorage` (a
shared buffer mixes concurrent users' tokens). Unknown prices show as `n/a`, never `$0.00`. Usage
rows are written by the service role only, and recording never fails the request it measures.

## 14. Runs with zero API keys

The default `fake` provider embeds with a hashing vectorizer, so similarity tracks word overlap: not
semantic, but enough for the demo, the tests and the CI eval to behave sensibly. Random vectors would
make retrieval arbitrary. Its extractive answers cite real `[n]` markers, so the citation UI works
without keys.

## Smaller calls

- **ESM API.** NestJS 12 is ESM-only, and CommonJS would need `moduleResolution: Node10`, which
  TypeScript 7 removes.
- **`process.loadEnvFile()` plus a Zod schema** instead of `@nestjs/config`: typed values and boot-time
  validation, two fewer dependencies.
- **`consistent-type-imports` off for Nest code.** Nest DI needs value imports; the autofix would
  inject `undefined` at runtime.
- **Pinned, settled dependency versions** rather than whatever was published yesterday.
