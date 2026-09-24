# AI-Powered Knowledge Base

Create documents, and ask questions about them. Answers are grounded in your own documents and cite
the exact chunk that supported each claim.

Built for the Goodspeed technical assessment. **[Loom walkthrough](#)** · **[How AI was used](#)**
*(links added on submission)*

---

## Run it

Needs **Docker** running and **Node 24**. Nothing else — the Supabase CLI ships as a dev dependency,
and the app boots with **no API keys at all**.

```bash
pnpm install
pnpm setup      # starts Supabase, applies migrations, seeds demo data, writes .env
pnpm dev        # API on :3001, web on :3000
```

Open <http://localhost:3000> and sign in as **`demo@example.com`** / **`demo-password-123`**.

A second account, `second@example.com`, exists with its own private document — sign in as it to
confirm that retrieval never crosses account boundaries.

<details>
<summary>What <code>pnpm setup</code> does</summary>

Checks Docker and the Node version, runs `supabase start`, applies the migrations in
`supabase/migrations/`, writes `.env` from `.env.example` with the local Supabase keys, and seeds two
users and four documents. Re-runnable at any time.
</details>

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
  Browser ──JWT──▶  │  NestJS API (:3001)                      │
     ▲              │                                          │
     │              │  documents · retrieval · chat · ingestion │
     └──SSE stream──┤                                          │
                    └───────┬─────────────────────┬────────────┘
                            │ user's JWT          │ service role
                            │ (RLS enforced)      │ (worker only)
                            ▼                     ▼
                    ┌──────────────────────────────────────────┐
                    │  Supabase Postgres 17                    │
                    │  pgvector (HNSW) · full-text · pg-boss    │
                    └──────────────────────────────────────────┘
```

**Retrieval is a deterministic workflow, not an agent:**

```
question
  └─▶ [multi-turn only] condense into a standalone query   (1 small LLM call)
  └─▶ embed  (cache: content hash → vector)
  └─▶ parallel: vector top-N  ‖  Postgres full-text top-N   (both RLS-scoped)
  └─▶ Reciprocal Rank Fusion
  └─▶ [optional, off by default] LLM rerank
  └─▶ prompt with numbered sources
  └─▶ stream answer + citations + usage
```

### Workspace

| Path | What it is |
|---|---|
| `apps/api` | NestJS: documents, ingestion worker, retrieval, chat streaming |
| `apps/web` | Next.js 16 App Router client: documents, chat, usage |
| `packages/ai` | **Provider-agnostic AI layer.** Framework-free, so it reads on its own |
| `packages/rag` | Chunking, hash diffing, rank fusion, prompt building. Pure functions |
| `packages/contracts` | Zod schemas shared by server validation and client types |
| `supabase/migrations` | Schema, RLS policies, retrieval functions |

---

## Swapping AI providers

Configuration only. No application code changes.

```bash
# OpenAI
AI_CHAT_PROVIDER=openai
AI_CHAT_MODEL=gpt-5.6
AI_CHAT_API_KEY=sk-...

# Groq for chat, OpenAI for embeddings (Groq has no embeddings endpoint)
AI_CHAT_PROVIDER=groq
AI_CHAT_API_KEY=gsk_...
AI_EMBEDDING_PROVIDER=openai
AI_EMBEDDING_API_KEY=sk-...

# Fully local
AI_CHAT_PROVIDER=ollama
AI_EMBEDDING_PROVIDER=ollama
AI_EMBEDDING_MODEL=nomic-embed-text
AI_EMBEDDING_DIMENSIONS=768     # must match the vector column

# Any other OpenAI-compatible service
AI_CHAT_PROVIDER=custom
AI_CHAT_BASE_URL=https://your-endpoint/v1
AI_CHAT_API_KEY=...
```

**The abstraction is capability modelling, not the base URL.** The OpenAI SDK already accepts a
`baseURL`; that is a config field, not a design. What actually breaks on a swap is what each provider
*can do*:

- Groq has no embeddings endpoint at all
- Ollama emits 768-dimension vectors where OpenAI emits 1536, and rejects `stream_options`
- `text-embedding-3-large` emits 3072 dimensions, above pgvector's 2000-dimension HNSW ceiling

So providers declare their capabilities, and configuration is validated against them **at boot**.
Setting `AI_EMBEDDING_PROVIDER=groq` fails on startup with a message that names the fix, rather than
producing a 404 midway through ingestion.

Adding a new OpenAI-spec provider is a row in `packages/ai/src/presets.ts`.

### Verified against

Honest accounting of what was actually exercised, rather than a list of five logos:

| Provider | Chat | Embeddings | How |
|---|---|---|---|
| `fake` | ✅ | ✅ | Default. Deterministic, offline, zero keys |
| OpenAI | ✅ | ✅ | Stubbed transport in the contract suite |
| Groq | ✅ | — | Stubbed. No embeddings endpoint, rejected at boot by design |
| Together | ✅ | ✅ | Stubbed |
| OpenRouter | ✅ | ✅ | Stubbed |
| Ollama | ✅ | ✅ | Stubbed. Its OpenAI compatibility is documented as experimental |

The contract suite runs one shared set of expectations against **every** implementation, so
"swappable" is a tested claim rather than a README claim.

---

## Testing

```bash
pnpm test              # unit — no network, no keys
pnpm test:integration  # against local Supabase
pnpm test:e2e          # one Playwright happy path
pnpm eval              # retrieval quality, offline
```

| Layer | What it covers |
|---|---|
| Unit | Chunking, rank fusion, hash diffing, citation resolution, retry/backoff, provider contract |
| Integration | **RLS isolation**, incremental re-ingestion, hybrid retrieval behaviour |
| E2E | Sign up → create → ingest → ask → cited answer, in a real browser |

The RLS suite is verified **non-vacuous by mutation**: disabling RLS on `chunks` fails exactly the
four chunk-related tests, including both retrieval paths. The E2E was verified the same way —
breaking CORS fails it.

### Retrieval quality

`pnpm eval` measures retrieval on a fixture corpus, scored **chunk-level**: a hit requires the
returned chunk to actually contain the answer span, because retrieving the right document but the
wrong chunk still produces an unanswerable prompt.

| config | hit@1 | hit@5 | MRR |
|---|---|---|---|
| semantic only | 86% | 94% | 0.900 |
| keyword only | 91% | 94% | 0.933 |
| **hybrid (RRF)** | 89% | 94% | 0.921 |

Full numbers, ablations and **the caveats that matter** are in
**[eval/RESULTS.md](eval/RESULTS.md)** — including where the measurements contradict the defaults,
and why hybrid is kept despite not winning on this corpus (the default embedder is lexical, so the
comparison does not yet test what its name suggests).

---

## Decisions

Full reasoning in **[DECISIONS.md](DECISIONS.md)**. The ones worth knowing up front:

- **Chat Completions, not the Responses API.** OpenAI recommends Responses for new projects, but
  Groq, Together, OpenRouter and Ollama implement Chat Completions. Following the recommendation
  would have silently broken the portability requirement.
- **RLS is the permission boundary**, not application code. The API queries as the caller, so
  Postgres enforces isolation on every query including vector search. There is no `owner_id` filter
  in application code anywhere.
- **Hybrid search fused with RRF**, because cosine distance and `ts_rank` are on incomparable scales
  and any weighted blend needs constants that drift with the corpus.
- **pg-boss, not Redis.** The queue lives in the database already running. SCALING.md names the
  threshold where that changes.
- **Incremental re-ingestion.** Editing one section of a 28-section document re-embedded 1 chunk and
  reused 2, measured end to end.

---

## What I would do next

- **Re-run the eval against a real embedding model and a larger corpus.** The current fixture is
  8 documents; differences of one or two questions are noise, and the semantic-vs-keyword comparison
  is meaningless while the default embedder is lexical. This is the single most valuable next step,
  because it is what would justify changing the chunk size or turning the reranker on.
- **Reranking on by default**, if the eval justifies the extra call. The harness already measures
  with and without it.
- **OCR for scanned PDFs.** Upload currently detects them and says so rather than creating an empty
  document, which is the right failure but not a solution.
- **Observability**: retrieval hit rate and answer latency as real metrics, not logs.
