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
runtime, but TypeScript _statically_ rejects it (TS1479), and the only way to silence that is
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
so _and_ suggests pairing it with OpenAI or Ollama, rather than producing a 404 mid-ingestion. The
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
are exercised with no key. Its sentence filter is token-based, not character-based: _"A deploy takes
eight minutes."_ is 29 characters and is exactly the kind of short factual sentence users ask about.

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
parameters are configurable, and the eval harness measures them against _our_ corpus." Semantic
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

Duplicate text within one document maps to a _queue_ of rows, not a single row, so a repeated
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
satisfied the "at least one field" guard _and then wrote an empty array_, silently clearing the
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
queue and worker as a typed one. Upload adds a _source of text_, not a parallel pipeline. `unpdf` is
imported lazily, because it bundles a sizeable PDF.js build and a deployment that never receives a PDF
should not pay for it at boot.

**PDF cleaning is not cosmetic.** Extracted text arrives hyphenated across line breaks, hard-wrapped
mid-sentence, and carrying a header on every page. Each breaks something specific: `deploy-\nment` is
two useless tokens to a keyword index, hard wrapping defeats the sentence splitter, and a header
repeated on every page drags every chunk toward the same embedding. Running furniture is detected by
frequency — a _short_ line repeated across many lines is furniture, a repeated paragraph is content.

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

---

## D23. Two false claims found by running the documentation

SCALING.md described `WORKER_MODE=standalone` as the scaling story "demonstrated in code rather than
asserted". Running it showed the assertion was the only part that existed.

**The mode did nothing.** `IngestionWorker` only skipped when the mode was `off`, so setting
`standalone` gave you a second consumer rather than moving the first. Fixed with an explicit
`shouldConsume` gate: `inline` means the API consumes, `standalone` means only the dedicated worker
process does, `off` means nothing does. A unit test pins the invariant that **exactly one** consumer
exists in each topology — never zero, never two.

**The worker started an HTTP server.** `main.worker.ts` imported `loadDotEnv` from `main.ts`, and
importing `main.ts` executes its top-level `bootstrap()`. The "worker with no HTTP listener" crashed
on `EADDRINUSE` against the API it was supposed to run beside. The loader moved to its own module,
and a test asserts that module exports nothing but the loader.

The general rule this produced: **a module with a top-level side effect must never also be a utility
module.** Anything importable for one export will eventually be imported for it.

Both bugs were invisible to every existing test, because nothing had ever run the second entrypoint.
A claim in a document a reviewer will read is a claim that needs a test.

## D24. The swappability claim was false, and only a live swap found it

**Decision:** provider names are an open string validated against the preset table, not a closed
enum. Any name is accepted when it supplies a base URL.

The assignment calls the provider-agnostic layer a key requirement, so it got the most design
attention: capability modelling, a preset table, a contract suite running shared expectations
against every implementation. All of it passed. The README documented the escape hatch for
"any other OpenAI-compatible service" as `AI_CHAT_PROVIDER=custom` plus a base URL.

That configuration did not boot:

```
ERROR [ExceptionHandler] Error: Invalid environment configuration:
  - AI_CHAT_PROVIDER: Invalid option: expected one of "openai"|"groq"|"together"|"openrouter"|"ollama"|"fake"
```

`packages/ai` was never the problem. `validateChatConfig` and `buildBareChat` both fall through to
an explicit `baseUrl` when no preset matches, and the error text already said _"For any other
OpenAI-compatible service, set AI_CHAT_BASE_URL explicitly."_ The layer was genuinely open. Then
`apps/api/src/config/env.schema.ts` restated the provider list as a `z.enum` and closed it again —
so the config supported five providers while the layer beneath it supported any. The requirement
was "any provider following the OpenAI API specification", and what actually shipped was a
hard-coded list of five.

**Why the tests missed it.** Every test of the provider layer instantiates the provider layer. Not
one of them goes through `parseEnv`, because the layer is deliberately framework-free and knows
nothing about environment variables. The bug lived precisely in the seam between two well-tested
components, which is where this class of bug always lives. A stub inside the test suite cannot
prove that an unknown provider works, because the stub is application code and the test author
already knows about it.

**What found it.** An OpenAI-spec HTTP server outside the repository, given a name the codebase
has never contained, pointed at with nothing but environment variables. The app ingested a
document through its `/embeddings`, streamed an answer from its `/chat/completions`, and resolved
a citation from the result. The server recorded the forwarded `Authorization` header and both
model names, so the evidence is on both sides of the wire.

**The fix removes the duplication rather than extending the list.** `CHAT_PROVIDERS` is now derived
from `CHAT_PRESETS`, so adding a preset makes it configurable with no second edit — which is what
the presets docstring already promised. Openness does not cost the typo check: a name with no
preset _and_ no base URL is still rejected at boot, now with a message naming the fix. API keys are
demanded only when the preset says the service requires one, so a self-hosted endpoint needs no
fake key to satisfy a validator.

**Alternative rejected:** adding `'custom'` to the enum. It would have made the README's example
work while leaving the real defect in place — the config would still have owned a copy of the
provider list, and the next preset added to the AI layer would still have been unreachable.

Related: [D8](#d8-capability-modelling-is-the-abstraction-not-the-base-url),
[D11](#d11-the-contract-suite-is-what-makes-swappable-a-testable-claim),
[D23](#d23-two-false-claims-found-by-running-the-documentation).

---

## D25. A clean-machine review found two defects no test could see

Two problems survived every green check in this repo, and both would have stopped a reviewer before
they reached any of the work above.

**The web app had no environment on a fresh clone.** `apps/web/.env.local` existed only on the
development machine. It is gitignored, `scripts/setup.mjs` never created it, and Next.js resolves
env per app directory — it does not read a monorepo root `.env`. So `pnpm install && <setup> &&
pnpm dev` produced a browser client constructed with `undefined` Supabase credentials, and sign-in
failed on the first click with nothing in any log to explain it. Every local run already had the
file, so nothing ever exercised the documented path.

**The documented setup command never ran the setup script.** The README said `pnpm setup`. `setup`
is a _reserved pnpm built-in_ that configures `PNPM_HOME` in the user's shell profile, so it
shadowed the package script entirely: it appended to `~/.zshrc` and left the corepack pnpm shim
broken, while Supabase never started. The irony is recorded in `scripts/setup.mjs` itself, which
already carried a comment explaining that shelling out to pnpm triggers exactly this side effect —
the defence was written into the script and the reviewer was routed around it.

**Neither is a coding mistake; both are the same mistake.** Every verification ran on a machine that
already had the artefacts of a successful setup. The fixes are small — the bootstrap script writes
both env files, and the script is renamed `bootstrap` so nothing shadows it — but the durable change
is that **CI now runs `pnpm bootstrap` and the browser suite**, so the documented path is exercised
by something that has never seen this machine.

**What this says about the test suite.** 257 tests, RLS verified by mutation, a provider contract
suite, a retrieval eval gate — and none of them could see either defect, because all of them start
after setup succeeds. Coverage of the code is not coverage of the first five minutes.

Related: [D0](#d0-environment-verification-gate-m0),
[D23](#d23-two-false-claims-found-by-running-the-documentation),
[D26](#d26-the-e2e-suite-was-green-by-not-running).

---

## D26. The E2E suite was green by not running

The browser test had rotted into three separate failures, and CI never noticed because **CI never
ran it**.

1. **It pointed at a host where the app does not work.** `baseURL` was `http://127.0.0.1:3000`.
   Next's dev client bootstraps over a WebSocket whose handshake fails on the numeric host, so the
   page served HTML that never hydrated. Every click was silently a no-op; the suite timed out
   against an app that looked perfect in a screenshot. `localhost` hydrates; `127.0.0.1` does not.
2. **It waited for a condition that was already true.** Creating a document through the UI makes an
   _empty_ document, which ingests to `ready` with 0 chunks. The test then waited for `Ready` and
   `/chunk(s)? indexed/` — both of which the pre-save state already satisfied, since the page
   renders "0 chunks indexed". It raced ahead and asked its question against an unindexed document,
   failing about one run in five. It now asserts `1 chunk indexed`, which the earlier state cannot
   satisfy.
3. **It started one server and used two.** Playwright waited only on port 3000. Next serves in
   under a second while `nest start` compiles for ten or more, so the first test ran against a web
   app whose API was still booting, and the documents page rendered a fetch error instead of its
   empty state. The config now declares both servers, each with its own readiness URL — the API's
   is `/health`, which is what that endpoint is for.

A fourth flake was real product behaviour, not a test bug: usage is written fire-and-forget so that
measuring work never delays it, and the usage page fetches once on mount. Waiting on the DOM would
wait forever. The test re-fetches until the row appears, which is the honest encoding of an
eventually-consistent read.

**The lesson is the one in the title.** A test that is not run is not a test, and its rot is
invisible and cumulative — three independent defects had piled up in a file that had "passed" since
the day it was written. The suite now runs in CI on every push.

Related: [D19](#d19-three-silent-failures-found-by-testing-end-to-end),
[D25](#d25-a-clean-machine-review-found-two-defects-no-test-could-see).

---

## D27. Capability modelling, made load-bearing

[D8](#d8-capability-modelling-is-the-abstraction-not-the-base-url) argued that the abstraction is
what a provider _can do_, not its base URL. A review of the running system found the argument was
only two-thirds implemented.

**`maxContextTokens` was declared and ignored.** Every provider published a context window, and the
prompt builder used `MAX_CONTEXT_TOKENS` from the environment instead. Swapping OpenAI (400k
declared) for Ollama's llama3.2 (8,192 declared) left the number where it was, and the first
request after the swap would overflow — the exact class of failure the capability model exists to
prevent, in the one place it mattered most. The ceiling is now `min(env, provider)`: the operator
can spend less than the model allows, never more.

**The token budget was not a budget.** Sources were fitted to the ceiling and conversation history
was appended _afterwards_, so a request exceeded the window by however much history it carried.
History is now reserved before sources are fitted, because history cannot be dropped without
changing the question.

**The flagship example was a string comparison.** Rejecting Groq for embeddings — the case used
throughout this document to explain why capabilities are modelled at all — was implemented as
`provider === 'groq'`. It is now `embeddings: false` on the preset, so the next chat-only provider
is a row rather than another branch.

**And one capability was checked against the wrong authority.** `AI_EMBEDDING_DIMENSIONS` was
validated against the provider's declared size but never against the database. Setting 768 for
Ollama passed every check and then failed on the first insert with `expected 1536 dimensions, not
768` — mid-ingestion, far from the cause, which is precisely the outcome the README promised the
design prevented. The column is the authority, so the API now asks it at boot
(`public.embedding_dimensions()`) and refuses to start on a mismatch, naming both fixes.

`toolCalls` and `jsonMode` remain declared and unread. That is deliberate and now documented in the
type: the fallback decorator intersects capabilities across two providers, and a capability absent
from the type cannot be intersected.

Related: [D8](#d8-capability-modelling-is-the-abstraction-not-the-base-url),
[D2](#d2-one-adapter-plus-presets-not-five-provider-classes).

---

## D28. Billing-adjacent numbers need request scope, not a shared buffer

Usage events were pushed into one array on the `AiService` singleton and drained per request. Under
any concurrency that is wrong: two users answering at once interleave their pushes, and whichever
request drains first takes the other's tokens. The failure path made it worse — it never drained,
so a failed turn's events sat in the buffer and were charged to whoever asked next.

Fixed with `AsyncLocalStorage`: each request opens its own bucket, which survives every await and
every `yield` of the streaming generator. `enterWith` rather than `run(cb)`, because `run` would
scope only the call that _creates_ the async generator and every resumption after the first yield
would fall outside it.

Events emitted outside any scope are now counted and dropped rather than parked. A dropped event is
a missing number; a parked one is a wrong number charged to an innocent user, and wrong is worse
than missing when the figure is billing-adjacent.

**Verified under load, not by inspection**: two users asking concurrently, three rounds each, each
finishing with exactly +6 calls attributed. Plus unit tests that interleave two scopes across awaits
and across generator yields.

Related: [D21](#d21-unknown-cost-is-null-not-zero),
[D9](#d9-decorator-stack-over-inheritance).

---

## D29. `maxTokens` now means what it says

`maxTokens` bounded a chunk's _body_; the overlap prefix was added on top. A "512-token chunk" was
therefore up to 576 — the configured number meant something other than what it said, and every
source understated how much of the prompt budget it consumed.

Making it a true ceiling shrank bodies to 448 tokens and took the fixture corpus from 25 chunks to 40. **The eval numbers moved, and one conclusion reversed**: at 25 chunks keyword search beat hybrid
on hit@1 and [eval/RESULTS.md](eval/RESULTS.md) said so; at 40 chunks hybrid leads and ties semantic
exactly.

The right reading is not "hybrid won". It is that a chunking change unrelated to retrieval mode was
enough to flip the ranking, which is direct evidence that **a 35-question corpus cannot separate
these configurations** — and that the earlier conclusion was stated more confidently than the data
supported. The previous finding is recorded in RESULTS.md rather than quietly replaced, because the
overturning is more informative than either number.

Related: [D12](#d12-chunking-recursive-and-structure-aware-51264-measured-not-assumed),
[D22](#d22-the-eval-harness-was-rebuilt-after-the-first-one-measured-nothing).

---

## D30. Re-indexing is one statement, and atomic

Re-ingestion renumbered surviving chunks with up to 2N PostgREST round trips: one pass to park every
moved row at a negative index (dodging the `(document_id, chunk_index)` unique constraint) and a
second to settle it. Editing the first section of a long document shifts every chunk after it, so a
60-chunk document cost 120 sequential HTTP calls.

Slow was the lesser problem. Each call committed independently, so a crash partway through left rows
stranded at negative indexes that no read path expects. Both passes now live in
`public.reindex_chunks(...)` — one round trip, one transaction, and the denormalised tags refresh in
the same statement so a tag edit cannot be half-applied.

`SECURITY INVOKER`, not definer: the only caller is the ingestion worker on the service role, which
already bypasses RLS. A definer function would hand the same power to anyone who could reach it.

Verified on an 18-chunk document with a section prepended: 20 contiguous chunks, none stranded
negative, tags refreshed, and 12 of 18 chunks reused rather than re-embedded.

Related: [D13](#d13-incremental-re-ingestion-by-content-hash),
[D15](#d15-no-queue-level-debounce-idempotent-jobs-instead).

---

## D31. A tags-only edit has to reach the chunks

`chunks.tags` is denormalised from the document so the search functions can filter without a join
([initial schema](supabase/migrations/20260923000100_initial_schema.sql)). Re-ingestion was
triggered only by a content change, on the reasoning that tags do not affect chunking.

They do not — but they affect _retrieval_. A tags-only edit left the chunks carrying the old tags,
and `hybrid_search(filter_tags)` matches on `c.tags`, so the document became invisible to a search
filtered by its own new tag. Silent, and only reachable through a feature (tag filtering) that the
happy path does not exercise.

Two changes, because one was not enough: the controller now enqueues on a tag change as well, and
`ingest()` syncs tags on its content-hash skip path — otherwise the job ran and returned early
without touching a row. The re-ingestion stays cheap exactly as
[D15](#d15-no-queue-level-debounce-idempotent-jobs-instead) argued: the hash matches, so no chunking
or embedding happens.

Related: [D13](#d13-incremental-re-ingestion-by-content-hash),
[D15](#d15-no-queue-level-debounce-idempotent-jobs-instead).

## D32. The presets were claims about vendors, and two of them were wrong

The contract suite ran every preset against a stubbed transport, which is the right way to keep CI
hermetic and is genuinely useful: it pins response parsing, batch chunking, `index` ordering and
finish-reason mapping. What it cannot do is check a claim about somebody else's server, because the
stub returns whatever the preset implies. The preset table and the suite agreed with each other and
neither had spoken to a vendor.

So the same assertions now run twice. `packages/ai/src/testing/contract.ts` holds them once; the
offline suite supplies a stub, and `pnpm test:live` supplies the real endpoints. A contract that
lives only in the offline suite is a test of our own mock; one that lives only in the live suite
cannot run in CI. Sharing it means a provider passing stubbed but failing live is a difference worth
naming rather than a difference in test code.

**Two preset default models were simply dead.** Groq's `llama-3.3-70b-versatile` returns 404 —
Groq has retired its Llama line and now lists only reasoning models. Mistral's
`mistral-large-latest` is absent from `GET /v1/models` entirely. This is the field most likely to
rot, because vendors retire models far faster than they move endpoints, and a dead default is worse
than no default: the provider validates at boot, starts cleanly, and fails on the first question.
It is also the one class of drift the keyless probe **cannot** catch — a 404 for a retired model and
a 401 for a rejected key are indistinguishable without a credential — which is the argument for the
credentialed suite existing alongside the free one.

**And Groq's replacement models changed what "enough tokens" means.** Every Groq chat model is now a
reasoning model, and reasoning tokens are drawn from the completion budget before any visible
content. At `max_tokens: 64` the call returns `content: ""` with `finish_reason: "length"`: a blank
answer, no error, nothing in the logs. The contract's own probe used 64, on the reasoning that a
one-word answer cannot need more — so the test was measuring the budget, not the provider. The probe
now budgets 512 and names the case explicitly when text is empty on a `length` finish, because the
failure is otherwise indistinguishable from a model that simply had nothing to say. The same trap
applies to the application's answer budget, not just the test.

Two capability rows were wrong, and both failed on the first live run.

**Ollama does report streamed usage.** The row said `streamingUsage: false`, with a comment that
Ollama rejects unknown stream options. That was true of older builds. 0.34.4 accepts
`stream_options` — it tolerates even a bogus field inside it — and emits a final chunk carrying
`usage`. The cost of the stale row was invisible and ongoing: streamed answers through Ollama were
recorded as **zero tokens**, so the usage page reported local traffic as free. Nothing errored. The
live capability test now asserts the declared value **both ways**, because both directions are
expensive — understate it and token accounting silently goes to nil, overstate it and older
providers 400 mid-answer.

**Gemini reports streamed usage too**, and its row said `false` for the same reason Ollama's did:
the capability is undocumented, so the preset assumed absence. Two independent rows made the
undocumented-therefore-assume-no call and both were wrong. That is the argument for asserting
capabilities against a running endpoint rather than reasoning carefully about a vendor's
documentation — careful reasoning produced the wrong answer twice.

**Gemini rejects a bad key with HTTP 400.** Its body reads `"Please pass a valid API key"`, and
`toAiError` keyed on status, so the single most likely misconfiguration an operator can make was
classified `bad_request` and reported as a malformed request. The fix matches the message, not the
provider id — for the same reason the preset table is data rather than a class hierarchy, the next
vendor to do this should not need a branch. The pattern is narrow enough that ordinary 400s stay
`bad_request`, which is asserted in both directions in `error-mapping.spec.ts`, where the real
captured bodies are pinned so CI checks them with no network.

A third finding changed no code but did change a test. **Groq authenticates before it routes**:
`/openai/v1/embeddings` returns 401 with a bad key, while a genuinely unknown path returns 404 with
the same bad key. The first version of that test read the 404 it expected as proof that Groq has no
embeddings endpoint — a green tick standing on a false premise. It is now gated on a real key, and
says so when it skips.

The suite itself had the same class of bug it was written to find. Ollama needs no key, so it
counted as configured whether or not it was running: a machine with no keys and no Ollama reported
a green `1 passed` while every real assertion skipped. A run that reaches nothing now fails. And
because `describe.skipIf` is evaluated at collection time, the reachability probe had to move from
`beforeAll` to a top-level `await` — a flag set in a hook is still `false` when the skip decision is
made, so every Ollama suite silently skipped even with the server up while the summary reported it
as covered.

**A rate limit is not a contract violation, and the suite said it was.** Free tiers are the
realistic case here — Gemini allows 20 requests a day on the model in its preset, Mistral throttles
within a couple of calls — and the first version failed on a 429 as though the provider had broken
the contract. That produces a suite which is red for reasons outside the repository, which is how
people learn to ignore a suite. Worse, one assertion actively misread it: the capability probe
treated any non-2xx as "the provider refused `stream_options`", so an exhausted quota argued that
Gemini's row should be reverted to the value live testing had just disproved. Rate limits are now
reported as **skipped, not exercised**, carrying the provider's own message — never as a pass, and
never as a failure.

The last piece is what runs without an account. A keyless probe sends a deliberately invalid key to
every hosted provider, which costs nothing and proves the two things most likely to rot in a preset
row: that the base URL is still right, and that the vendor's way of saying "no" still maps to
`auth`. That is the only coverage OpenAI, Groq, Together and OpenRouter get on a machine with no
credentials, and it is what caught Gemini.

Related: [D27](#d27-capability-modelling-made-load-bearing),
[D24](#d24-the-swappability-claim-was-false-and-only-a-live-swap-found-it),
[D2](#d2-one-adapter-plus-presets-not-five-provider-classes).
