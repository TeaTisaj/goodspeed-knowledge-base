# AI-Powered Knowledge Base

Write or upload documents, then ask questions about them. Answers come only from your own
documents and cite the exact passage behind each claim.

**Loom:** [App walkthrough](#) · [How AI was used to build it](#)

## At a glance

- **Swap AI providers by config.** Any OpenAI-spec provider works: OpenAI, Groq, Together,
  OpenRouter, Ollama, or one with no preset. Impossible setups (Groq for embeddings, wrong vector
  size) fail at boot with a message naming the fix.
- **Permissions live in Postgres.** RLS scopes every query, including vector search. No `owner_id`
  filter in app code, and integration tests prove isolation against a real database.
- **Hybrid retrieval, measured.** pgvector (HNSW) plus full-text search, fused with RRF: 91% hit@1,
  100% hit@5 on the eval set.
- **Safe with untrusted documents.** 0% prompt-injection success across eleven poisoned documents;
  off-topic questions are refused without a model call.
- **All stretch goals.** Streaming, persistent history, chunk-level citations, PDF/TXT upload, and a
  usage and cost view.

## Run it

Needs **Docker** and **Node 22.22+, 24.15+ or 26+** (`.nvmrc` pins 24). No API keys needed.

```bash
pnpm install
pnpm bootstrap   # starts Supabase, applies migrations, writes .env files, seeds demo data
pnpm dev         # web on :3000, API on :3001
```

Open <http://localhost:3000> and sign in as `demo@example.com` / `demo-password-123`. A second user,
`second@example.com` (same password), has a private document you can use to check that nothing
crosses accounts.

Without keys the app uses a built-in offline `fake` provider, so everything works end to end.
Add a real provider (below) for real answers. It's `bootstrap`, not `setup`, because `pnpm setup` is
a pnpm built-in.

## Architecture

```
Browser ──JWT──▶ NestJS API ──user's JWT (RLS)──▶ Supabase Postgres 17
   ▲              documents · ingestion             pgvector HNSW · full-text
   └──SSE stream── retrieval · chat · usage ──service role (worker only)──▶ pg-boss queue
```

| path                  | what it is                                                           |
| --------------------- | -------------------------------------------------------------------- |
| `apps/web`            | Next.js 16 client: documents, chat, usage                            |
| `apps/api`            | NestJS: documents, ingestion worker, retrieval, streaming chat       |
| `packages/ai`         | Provider-agnostic AI layer. Framework-free, readable on its own      |
| `packages/rag`        | Chunking, hash diffing, rank fusion, prompt building. Pure functions |
| `packages/contracts`  | Zod schemas shared by API validation and client types                |
| `supabase/migrations` | Schema, RLS policies, search functions                               |

**Ingestion.** Saving a document enqueues a background job: clean → chunk (512 tokens, 64
overlap, split on headings and paragraphs first) → embed only the chunks whose content hash changed
→ store in pgvector. The UI shows job status.

**Chat.** A fixed workflow, not an agent: the model never chooses control flow, so cost and latency
stay bounded.

```
[follow-ups only] condense into a standalone question
  → embed → vector top-N ‖ full-text top-N (both RLS-scoped) → Reciprocal Rank Fusion
  → relevance floor (nothing relevant? refuse, no model call)
  → prompt with numbered sources → stream answer → resolve citations → persist
```

## Swapping AI providers

Chat and embeddings are configured separately, so you can mix providers:

```bash
# OpenAI for both
AI_CHAT_PROVIDER=openai
AI_CHAT_API_KEY=sk-...
AI_EMBEDDING_PROVIDER=openai
AI_EMBEDDING_API_KEY=sk-...

# Groq for chat (it has no embeddings endpoint), OpenAI for embeddings
AI_CHAT_PROVIDER=groq
AI_CHAT_API_KEY=gsk_...

# Fully local
AI_CHAT_PROVIDER=ollama
AI_EMBEDDING_PROVIDER=ollama
AI_EMBEDDING_MODEL=nomic-embed-text
AI_EMBEDDING_DIMENSIONS=768

# Any other OpenAI-spec service: any name, plus its endpoint
AI_CHAT_PROVIDER=acme-llm
AI_CHAT_BASE_URL=https://api.acme.example/v1
AI_CHAT_MODEL=acme-large
AI_CHAT_API_KEY=...
```

Models default to each preset's; override with `AI_CHAT_MODEL` / `AI_EMBEDDING_MODEL`. Also
available: a fallback provider (`AI_CHAT_FALLBACK_*`), timeouts and retries.
Every variable is documented in [`.env.example`](.env.example).

**How the interface is modelled.** The OpenAI SDK already takes a `baseURL`, so the design isn't
about that. It's about what each provider _can do_. Each provider declares capabilities
(embeddings or not, vector size, context window, streamed usage), and config is validated against
them at startup. The prompt budget follows the chat model's context window, and the API refuses to
boot if the embedding size doesn't match the database column. One adapter plus a preset table covers
every provider; retry, fallback, caching and usage tracking are decorators around it
([`packages/ai`](packages/ai/src)).

**Changing chat is a restart. Changing embeddings is a data migration**, because vectors from
different models aren't comparable. `pnpm reembed` generates and applies that migration, and the
worker re-embeds every document.

**Verified** by one shared contract suite, run stubbed in CI and live with `pnpm test:live`:

| provider                 | level                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| OpenRouter, Groq, Ollama | full contract against the live service                                   |
| unknown provider         | live: ingest, chat and citations through a server the app had never seen |
| OpenAI, Together         | stubbed contract + live endpoint and auth check (no key available)       |
| Gemini, Mistral          | partial live run, stopped by free-tier rate limits                       |

The live runs found four wrong preset values that stubs couldn't catch; they're fixed.

## Testing and evaluation

```bash
pnpm test               # unit: no network, no keys
pnpm test:integration   # RLS isolation, re-ingestion, retrieval against local Supabase
pnpm test:e2e           # browser: sign up → create → ingest → ask → cited answer; upload → usage
pnpm test:live          # provider contract against real endpoints (opt-in by credential)
pnpm eval               # retrieval quality, offline
pnpm eval:generation    # answer quality, refusals, prompt-injection resistance
```

CI runs unit, integration (real Postgres) and E2E on every push. The E2E job starts from
`pnpm bootstrap`, so the documented setup is tested on a clean machine.

Headline results (details and caveats in [eval/README.md](eval/README.md)):

| retrieval (`text-embedding-3-small`) | hit@1 | hit@5 | MRR   |
| ------------------------------------ | ----- | ----- | ----- |
| semantic only                        | 83%   | 100%  | 0.889 |
| keyword only                         | 91%   | 94%   | 0.929 |
| **hybrid (RRF)**                     | 91%   | 100%  | 0.945 |

| generation (73 cases, gpt-oss-120b on Groq) |       |
| ------------------------------------------- | ----- |
| overall                                     | 97%   |
| prompt-injection success                    | 0%    |
| correct refusals                            | 95%   |
| claims supported by sources (LLM judge)     | 94.9% |

## Security

Retrieval is RLS-scoped, so a prompt only ever holds the asking user's own documents. What's left is
**indirect prompt injection** (an uploaded document trying to steer the answer) and **scope escape**
(using the assistant as a general chatbot):

- The system message holds only rules. Document text goes in the user turn inside tags it can't
  forge; invisible Unicode is stripped.
- No links or images in answers or the renderer, since images are fetched on render. Citations
  resolve server-side.
- Off-topic questions are refused before any model call, using a similarity floor measured per
  embedding model.
- Per-user rate limits, a token cap on every answer, and bounded request bodies.
- Each answer records whether it was grounded, refused, or used sources that looked like injections;
  the usage page shows the rates.

I didn't build a classifier that blocks "injection-looking" text. It's easy to evade and would
refuse legitimate documents that discuss the topic, so suspicious sources are logged instead.

## Key decisions

Full reasoning, with alternatives, in [DECISIONS.md](DECISIONS.md); growth plan in
[SCALING.md](SCALING.md).

- **Chat Completions, not the Responses API.** Only Chat Completions is implemented by Groq,
  Together, OpenRouter and Ollama.
- **RLS as the permission boundary**, with `SECURITY INVOKER` search functions.
- **Hybrid search with RRF**, because cosine and `ts_rank` scores aren't comparable and rank fusion
  needs no tuning constants.
- **pg-boss, not Redis.** The queue lives in the database already running; SCALING.md says when to
  switch.
- **Incremental, idempotent ingestion** keyed on content hashes.
- **A workflow, not an agent**, for bounded cost and predictable behaviour.

## Left out on purpose

- **Team workspaces.** The task scopes visibility to a user's own documents. SCALING.md has the
  migration path.
- **Agent loops for retrieval.** Several times the tokens and no gain on single-corpus Q&A.
- **Semantic chunking.** Reported gains are contested; the eval harness is how I'd decide.
- **Redis.** Nothing needs it yet; SCALING.md names the load where it would.

## What I'd do next

- **A bigger, messier eval set.** Real user questions with typos, ambiguity and multiple documents.
  The current sets are small enough that one case is noise.
- **Better paraphrase recall.** HyDE helps one paraphrase in four and ships off by default
  (`RETRIEVAL_HYDE`); a larger set would show whether it earns its extra model call.
- **Reranking on by default**, if the eval shows it's worth a model call per question.
- **OCR for scanned PDFs.** Upload currently detects them and says so.
- **Production metrics** for hit rate, refusal rate and grounding, not just logs.
- **Fully transactional re-ingestion**: delete, renumber and insert as a single RPC.
- **Full-text search in more languages** (a per-document language column).
