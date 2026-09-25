# AI-Powered Knowledge Base

Create documents, and ask questions about them. Answers are grounded in your own documents and cite
the exact chunk that supported each claim.

Built for the Goodspeed technical assessment. **[Loom walkthrough](#)** · **[How AI was used](#)**
_(links added on submission)_

---

## Run it

Needs **Docker** running and **Node 22.22+, 24.15+ or 26+** (`.nvmrc` pins 24.21). Nothing else — the Supabase CLI ships as a dev dependency,
and the app boots with **no API keys at all**.

```bash
pnpm install
pnpm bootstrap  # starts Supabase, applies migrations, seeds demo data, writes both .env files
pnpm dev        # API on :3001, web on :3000
```

Open <http://localhost:3000> and sign in as **`demo@example.com`** / **`demo-password-123`**.

A second account, `second@example.com`, exists with its own private document — sign in as it to
confirm that retrieval never crosses account boundaries.

<details>
<summary>What <code>pnpm bootstrap</code> does</summary>

Checks Docker and the Node version, runs `supabase start`, applies the migrations in
`supabase/migrations/`, writes the root `.env` **and** `apps/web/.env.local` from their
`.env.example` files with the local Supabase keys, and seeds two users and four documents.
Re-runnable at any time.

Named `bootstrap` rather than `setup` deliberately: `pnpm setup` is a reserved pnpm built-in that
configures `PNPM_HOME` in your shell profile, so it would never reach this script.
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

| Path                  | What it is                                                             |
| --------------------- | ---------------------------------------------------------------------- |
| `apps/api`            | NestJS: documents, ingestion worker, retrieval, chat streaming         |
| `apps/web`            | Next.js 16 App Router client: documents, chat, usage                   |
| `packages/ai`         | **Provider-agnostic AI layer.** Framework-free, so it reads on its own |
| `packages/rag`        | Chunking, hash diffing, rank fusion, prompt building. Pure functions   |
| `packages/contracts`  | Zod schemas shared by server validation and client types               |
| `supabase/migrations` | Schema, RLS policies, retrieval functions                              |

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

# Any other OpenAI-spec service: name it whatever you like and give it an endpoint
AI_CHAT_PROVIDER=acme-llm
AI_CHAT_BASE_URL=https://api.acme.example/v1
AI_CHAT_API_KEY=...
```

A provider with no preset is valid as long as it brings its own base URL. A name with
neither is a typo, and is rejected at boot with a message naming the fix.

**The abstraction is capability modelling, not the base URL.** The OpenAI SDK already accepts a
`baseURL`; that is a config field, not a design. What actually breaks on a swap is what each provider
_can do_:

- Groq has no embeddings endpoint at all
- Ollama emits 768-dimension vectors where OpenAI emits 1536, and reports no token usage at all on older builds
- `text-embedding-3-large` emits 3072 dimensions, above pgvector's 2000-dimension HNSW ceiling

So providers declare their capabilities, and configuration is validated against them **at boot**.
Setting `AI_EMBEDDING_PROVIDER=groq` fails on startup with a message that names the fix, rather than
producing a 404 midway through ingestion.

**Presets are defaults, not a support list.** `packages/ai/src/presets.ts` stores the endpoint,
default model and capabilities for providers common enough to be worth saving the typing. Adding a
row is convenience; it is not how a provider becomes usable. Anything speaking the spec works from
environment variables alone — including the parts that are easy to get wrong:

```bash
# A truncating embedding model on a provider the registry has never heard of
AI_EMBEDDING_PROVIDER=acme-llm
AI_EMBEDDING_BASE_URL=https://api.acme.example/v1
AI_EMBEDDING_DIMENSIONS=1536   # sent as the spec's `dimensions` parameter
```

That last line was not true until it was tested, and the gap is worth recording rather than quietly
fixing. The fallback capabilities for an unknown provider hardcoded `configurableDimensions: false`,
so any embedding model needing the `dimensions` parameter was reachable **only** by adding a
preset — that is, only by changing application code, which is precisely what this design exists to
avoid. Gemini is the live example: its embeddings are 3072-dimensional by default, above pgvector's
2000-dimension ceiling, and usable only when truncation is requested. Setting the variable is now
read as the operator asserting their provider honours it, and being wrong fails loudly instead of
silently — the returned vector width is checked against what was asked for, and a mismatch names
both sizes. `factory.spec.ts` pins this against a provider with no preset, on the wire.

### Changing the embedding model

Chat and embeddings are not equally free to swap. **Changing the chat provider is a restart.**
Changing the _embedding_ provider is a data migration, and no abstraction can make it otherwise:
vectors from two models are coordinates in unrelated spaces, so every stored embedding becomes
meaningless the moment the model changes — at any width. Re-ingestion is mandatory, not an
optimisation.

What _was_ avoidable is hand-writing SQL for it:

```bash
# edit AI_EMBEDDING_* in .env, then
pnpm reembed
```

It generates a migration (so the change survives `pnpm db:reset` and replays on a teammate's
machine), applies it, resizes both vector columns, rebuilds the HNSW index, and returns every
document to `queued`. The worker enqueues anything left in `queued` on startup, so `pnpm dev`
finishes the job. Documents are never touched — only derived data is rebuilt.

### Verified against

Honest accounting of what was actually exercised, rather than a list of five logos:

Three levels of evidence, and they are not interchangeable:

- **Contract (stubbed)** — the full shared contract against a stubbed transport. Proves the adapter
  parses the spec, batches, orders vectors by `index`, and maps errors. Runs in CI, no keys.
- **Reachability (live, keyless)** — a deliberately invalid key sent to the real endpoint. Proves the
  preset's base URL is correct and that the vendor's way of saying "no" maps to `auth`. Needs
  network, no account.
- **Contract (live)** — the same shared contract against the real service with a real key. The only
  level that proves responses parse, the default model exists, and embeddings are semantically
  usable.

| Provider                | Chat | Embeddings | Level reached                                                                      |
| ----------------------- | ---- | ---------- | ---------------------------------------------------------------------------------- |
| **OpenRouter**          | ✅   | ✅         | **Contract (live)** — `openai/gpt-5.6` + `text-embedding-3-small`, full suite      |
| **Groq**                | ✅   | —          | **Contract (live)** — `openai/gpt-oss-20b`. No embeddings endpoint, confirmed live |
| **Ollama**              | ✅   | ✅         | **Contract (live)** — 0.34.4, `llama3.2` + `nomic-embed-text` (768d)               |
| **Unknown third party** | ✅   | ✅         | **Live.** A server the app has never heard of, reached by env vars only            |
| Gemini                  | ⚠️   | ⚠️         | Contract (live), **partial** — free tier is 20 req/day and quota ran out mid-suite |
| Mistral                 | ⚠️   | ⚠️         | Contract (live), **partial** — free tier throttles within a couple of calls        |
| OpenAI                  | ✅   | ✅         | Contract (stubbed) + reachability (live). No key available                         |
| Together                | ✅   | ✅         | Contract (stubbed) + reachability (live). No key available                         |
| `fake`                  | ✅   | ✅         | Default. Deterministic, offline, zero keys                                         |

⚠️ means the suite ran and reported **skipped, not exercised** rather than passing — a rate limit
says nothing about whether a provider honours the contract, so it is never counted as a pass.

The contract suite runs one shared set of expectations against **every** implementation, so
"swappable" is a tested claim rather than a README claim. The stubbed and live suites import the
same assertions from `packages/ai/src/testing/contract.ts` — a contract that existed only in the
offline suite would be testing our own mock.

### What live testing found that stubs could not

Five findings, all from live suites failing on their first run — none from code review:

- **Two preset default models were dead.** Groq's `llama-3.3-70b-versatile` returns 404: Groq has
  retired its Llama line entirely and now lists only reasoning models. Mistral's
  `mistral-large-latest` is no longer in `GET /v1/models` at all. A dead default is worse than no
  default — the provider looks configured, boots cleanly, and fails on the first question. It is the
  field most likely to rot, because vendors retire models far faster than they move endpoints, and
  **only a credentialed run can see it**: a keyless probe cannot tell a retired model from a
  rejected key.
- **Every Groq model is now a reasoning model**, and reasoning tokens come out of the _completion_
  budget before any visible content. At `max_tokens: 64` the call returns `content: ""` with
  `finish_reason: "length"` — a blank answer, no error, nothing logged. The contract's own probe was
  set to 64, so it was measuring the budget rather than the provider. It now budgets 512 and names
  this case explicitly when text comes back empty on a `length` finish. The application's own
  budgets had the same flaw — the condense step capped at 120 tokens, the reranker at 50, the answer
  not at all — and the generation eval is what surfaced it (DECISIONS.md D36).
- **Gemini reports streamed usage**, and its preset said `false` because the capability was
  undocumented, so the row assumed absence. Streamed Gemini answers were being recorded as zero
  tokens.
- **Ollama does report streamed usage.** Its preset declared `streamingUsage: false` with a comment
  that it rejects unknown stream options. True of older builds; not of 0.34.4, which accepts
  `stream_options` and returns a usage chunk. Every streamed Ollama answer was being recorded as
  **zero tokens** on the usage page. A stub cannot catch this, because the stub returns whatever the
  preset implies. There is now a live test asserting the declared value **both ways**, so the row
  fails if it drifts in either direction. Two rows made the same
  undocumented-therefore-assume-absent call and both were wrong, which is the whole argument for
  asserting capabilities against the endpoint instead of reasoning about a vendor's docs.
- **Gemini rejects a bad key with HTTP 400, not 401.** Its body says `"Please pass a valid API key"`,
  and the status check alone filed that as `bad_request` — so the single most likely
  misconfiguration reported "malformed request" and never named the key. `toAiError` now recognises
  an auth failure carried in a 400 body, matched on the message rather than on a provider id, and
  the real captured bodies are pinned in `error-mapping.spec.ts` so CI checks them offline.

A further finding did not change code but did change a test: **Groq authenticates before it routes.**
`/openai/v1/embeddings` returns 401 with a bad key while a genuinely unknown path returns 404, so
"Groq has no embeddings endpoint" is not something a keyless probe can establish. That test is now
gated on a real key rather than standing on a false premise.

That suite is still application code, though, so it cannot prove the claim on its own. The row
above it was earned differently: an OpenAI-spec server outside the repository, named `acme-llm`,
pointed at by environment variables alone with no rebuild. The app ingested a document through
its embeddings endpoint, streamed an answer from its chat endpoint, and resolved a citation from
it. **The first attempt failed** — see [DECISIONS.md](DECISIONS.md) D24, which is the reason this
row exists at all.

---

## Testing

```bash
pnpm test              # unit — no network, no keys
pnpm test:integration  # against local Supabase
pnpm test:e2e          # browser, starts the stack itself
pnpm test:live         # AI providers, against the real endpoints
pnpm eval              # retrieval quality, offline
pnpm eval:generation   # answers, refusals, prompt-injection resistance (see below)
```

| Layer       | What it covers                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Chunking, rank fusion, hash diffing, citation resolution, retry/backoff, provider contract, vendor error shapes, usage scoping, context budget, history window             |
| Security    | Prompt channel separation, delimiter forgery, invisible-Unicode stripping, the relevance floor, the no-model refusal path, markdown output never rendering links or images |
| Integration | **RLS isolation**, incremental re-ingestion, hybrid retrieval behaviour                                                                                                    |
| E2E         | Sign up → create → ingest → ask → cited answer; upload → usage; signed-out redirect                                                                                        |
| Live AI     | Every preset's base URL and auth-error mapping, keyless; full contract against any provider with a key                                                                     |

### Live provider tests

`pnpm test:live` runs the provider contract against real endpoints. It is **not** part of
`pnpm test`: it needs network, it costs money on metered providers, and a suite that goes red
because someone's free tier reset is a suite nobody keeps green.

It is opt-in **by credential**, not by flag. A provider with a key is tested; one without is skipped
by name, and the run prints exactly what it reached:

```
live providers exercised (2):
  - chat ollama:llama3.2
  - embed ollama:nomic-embed-text
skipped, no credential: openai, groq, together, openrouter, gemini, mistral
```

Two things run with **no credentials at all**: the full contract against a local Ollama, and the
keyless reachability probe against every hosted provider. So a clean checkout with nothing
configured still covers all seven presets at the transport and error-mapping layer.

To add a provider, drop a key in `.env.local`, `.env.live` or `.env` — all three are gitignored and
all three are read. Only `LIVE_`-prefixed names are imported, and that prefix is what separates the
concerns: the app reads `AI_CHAT_API_KEY`, so a `LIVE_` key cannot point the running app at a
metered provider no matter which file it sits in.

```bash
# .env.local
LIVE_GROQ_API_KEY=gsk_...
LIVE_OPENROUTER_API_KEY=sk-or-...
LIVE_OPENAI_CHAT_MODEL=gpt-5.6   # optional, overrides the preset default
```

For a local Ollama:

```bash
brew install ollama && ollama serve
ollama pull llama3.2 && ollama pull nomic-embed-text
pnpm test:live
```

A live run that reaches **nothing** fails rather than passing empty. That was a real bug in this
suite's first version: Ollama needs no key, so it counted as configured whether or not it was
running, and a machine with no keys and no Ollama reported a green "1 passed" while every real
assertion skipped. Relatedly, `describe.skipIf` is evaluated at collection time, so the reachability
probe has to be a top-level `await` — a flag set in `beforeAll` is still `false` when the skip
decision is made.

The RLS suite is verified **non-vacuous by mutation**: disabling RLS on `chunks` fails exactly the
four chunk-related tests, including both retrieval paths. The E2E was verified the same way —
breaking CORS fails it.

**All three layers run in CI**, and the E2E job runs `pnpm bootstrap` first, so the documented
setup path is exercised on a machine that has never seen this one. That is deliberate: the two worst
defects this project has had were both invisible locally and both sat _before_ the first test —
see [DECISIONS.md](DECISIONS.md) D25 and D26.

### Retrieval quality

`pnpm eval` measures retrieval on a fixture corpus, scored **chunk-level**: a hit requires the
returned chunk to actually contain the answer span, because retrieving the right document but the
wrong chunk still produces an unanswerable prompt. With a real embedding model
(`--embed=openrouter:openai/text-embedding-3-small`):

| config           | hit@1   | hit@5    | MRR       |
| ---------------- | ------- | -------- | --------- |
| semantic only    | 83%     | 100%     | 0.889     |
| keyword only     | 91%     | 94%      | 0.929     |
| **hybrid (RRF)** | **91%** | **100%** | **0.945** |

With real semantics the two arms fail on different questions, and fusion takes the better of each.
Full numbers, ablations, the **relevance-floor calibration** and **the caveats that matter** are in
**[eval/RESULTS.md](eval/RESULTS.md)** — including an earlier run where keyword search ranked
_above_ hybrid and a chunking fix flipped it, which is recorded rather than overwritten because it
is the evidence that a 35-question corpus separates these configurations by noise. CI runs the same
harness offline with the fake embedder and gates on it.

### Answer quality and safety

`pnpm eval:generation` runs 54 labelled cases through **the production code path** — the same
relevance floor, condense guard and `buildChatMessages` the API calls — against a real model, in
nine categories: answerable, paraphrase, multi-hop, partial, follow-up, near-miss (the topic is in
the corpus, the fact is not), out-of-scope, direct injection, and indirect injection from seven
**poisoned documents** (instruction override, phishing link, delimiter forgery, invisible-Unicode
smuggling, role reassignment, image exfiltration, prompt extraction).

Scoring is **deterministic first**: each case states what the answer must and must not contain and
whether it must refuse, and that is what the gate uses. An **LLM judge** from a different model
family adds claim-level faithfulness and correctness, and is **calibrated on hand-labelled answers**
— including a changed number and an answer that tries to grade itself — before its scores count.

| model (Groq) | overall | attack success | refusals | utility under attack | judge faithfulness |
| ------------ | ------- | -------------- | -------- | -------------------- | ------------------ |
| gpt-oss-120b | 96%     | **0%**         | 93%      | 100%                 | 93.7% of claims    |
| gpt-oss-20b  | 96%     | **0%**         | 93%      | 100%                 | —                  |

Both remaining failures are instructive rather than embarrassing: one is a retrieval miss (the
answer chunk ranks 30th, and the model correctly refuses what it was not shown), and one is the
near-miss the category exists for — "the most a manager can approve" is not in the documents, and
both models extrapolated it from a threshold.

Per-case answers, the failures and what they taught are in **[eval/GENERATION.md](eval/GENERATION.md)**.

---

## Security

The threat model, in one paragraph: retrieval is RLS-scoped, so a prompt only ever holds the asking
user's own documents — there is no cross-user path. What remains is **indirect prompt injection**:
a user uploads a PDF or pastes a page they did not write, and a sentence in it tries to steer the
answer they trust. And **scope escape**: talking the assistant into being a general-purpose chatbot.

| layer       | what it does                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation   | RLS on every table; search functions are `SECURITY INVOKER`; no `owner_id` filter in application code to forget. Integration-tested against real Postgres.                                                 |
| Structure   | The system message holds only rules. Sources go in the user turn inside tags a document cannot forge; invisible Unicode (tag-character smuggling, zero-width, bidi) is stripped.                           |
| Policy      | Tagged content is data, never instructions; nothing in it can change the rules; links and images are never output; out-of-scope gets one fixed refusal sentence.                                           |
| Relevance   | When nothing retrieved clears a similarity floor measured for the embedding model, the API refuses **without calling the model** — nothing to jailbreak.                                                   |
| Output      | The renderer supports no links or images (an image is fetched on render — the classic exfiltration channel); citations resolve server-side; an answer that neither cites nor refuses is flagged in the UI. |
| Cost        | Per-user rate limits; every answer has a completion-token ceiling; request bodies are bounded to the contract.                                                                                             |
| Visibility  | Every answer records its grounding class, whether it was refused without a model call, and how many sources looked like injections; the usage page shows the rates.                                        |
| Measurement | The poisoned-corpus eval above. A defence that has not been attacked is an assumption.                                                                                                                     |

Deliberately **not** built: a classifier that blocks documents or questions that "look like"
injections. It is easy to evade and would refuse a security runbook that merely discusses the topic.
Heuristic matches are logged instead. Reasoning in [DECISIONS.md](DECISIONS.md) D33–D36.

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
- **Incremental re-ingestion.** Prepending a section to an 18-chunk document reused 12 chunks and
  renumbered the rest in one transactional statement, measured end to end.
- **Capabilities are load-bearing, not decorative.** The prompt budget is `min(env, provider
window)`, so swapping a 400k model for an 8k one moves it without touching config; and the API
  refuses to boot if `AI_EMBEDDING_DIMENSIONS` disagrees with the actual `vector(N)` column.
- **Retrieved text is data, not instructions.** Documents travel in the user turn inside tags they
  cannot forge, never in the system message — an earlier version put them there, which gave every
  sentence of every uploaded PDF operator authority.
- **Out-of-scope questions are refused before the model sees them**, using a similarity floor
  measured per embedding model. The first calibration was wrong — it would have cut real answers —
  and the generation eval is what caught it.
- **Usage is request-scoped** via `AsyncLocalStorage`. A shared buffer drained per request
  misattributes tokens between concurrent users, which is not acceptable for billing-adjacent
  numbers.

---

## What I would do next

- **A larger, messier eval corpus.** Retrieval now runs against a real embedding model, and
  generation is measured end to end, but both fixtures are small and written alongside the corpus:
  54 generation cases and 35 retrieval questions separate configurations by one or two cases. Real
  user questions — typos, ambiguity, multi-document — are the next measurement worth having.
- **Paraphrase recall.** Four levers were measured (eval/retrieval-experiments.mjs); hypothetical-
  document expansion was the only one that helped without costing a plain question, and it ships as
  an opt-in (`RETRIEVAL_HYDE`) because the evidence is one question in four and the cost is a model
  call per question. A larger paraphrase set is what would justify turning it on — and the one
  question no lever rescues (its answer chunk ranks 30th, diluted by filler) needs better chunking.
- **Reranking on by default**, if the eval justifies the extra call. The harness already measures
  with and without it.
- **OCR for scanned PDFs.** Upload currently detects them and says so rather than creating an empty
  document, which is the right failure but not a solution.
- **Observability**: retrieval hit rate, refusal rate, grounding and injection-heuristic hits as
  real metrics, not log lines — the eval measures them offline; production should too.
- **A second opinion on injections**: Groq serves Llama Prompt Guard, a small classifier built for
  this. As a logged signal alongside the heuristics it would be cheap; as a blocker it would inherit
  every false positive a classifier has, which is why it is not one here.
- **Transactional ingestion end to end.** Re-indexing is now atomic, but delete → reindex → insert
  are still three statements; a crash between them can leave a document briefly partial. The fix is
  one RPC for the whole rebuild, and the reason it is not done yet is that it trades readable
  TypeScript for a large PL/pgSQL function — worth it at scale, not obviously worth it here.
- **A second language for full-text search.** `fts` is a generated column, so its text search
  configuration must be an immutable literal and is English-only today. Supporting another language
  means a per-document language column and a reindex, not a setting.
