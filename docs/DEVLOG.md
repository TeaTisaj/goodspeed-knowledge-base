# Dev log

Running record of how this was built, kept for the required walkthrough on **how AI was used to
accelerate development**. Written as I go, not reconstructed afterwards.

**Format.** One entry per working session. The section that matters is _"Where AI was wrong"_ — a log
that only records AI writing code quickly says nothing useful. The interesting claim is that AI
accelerated the work _and_ was wrong often enough that verification had to be part of the loop.

---

## 2026-09-23 — Planning. No implementation code.

**Shipped:** `task.md` (assignment), `description.md` (build brief), `PLAN.md` (architecture, pinned
versions, milestones, risks, evidence). Toolchain installed, repo initialised.

**Where AI accelerated things**

- Version research. Every pinned version was checked against the npm registry and primary docs rather
  than recalled. That surfaced three collisions I would not have found until they broke the build:
  TypeScript 7 ships no compiler API so `nest build` cannot run on it; `@nestjs/schematics@12`
  requires Node `^22.22.3 || ^24.15.0 || >=26` and this machine was on 22.13.0; Next 16 removed
  `next lint`, so a copied turbo config would silently lint nothing.
- Constraint-finding across docs. pgvector caps HNSW at 2,000 dimensions for the `vector` type, which
  quietly rules out `text-embedding-3-large` at full width — a constraint most people hit by accident.
- Two deployment landmines found before writing code: Supabase CLI ≥2.71.1 defaults local projects to
  ES256, and pg-boss uses LISTEN/NOTIFY so it silently never picks up jobs behind a transaction-mode
  pooler.

**Where AI was wrong**

- **It asserted "tool calling on OpenAI requires the Responses API."** False. Chat Completions still
  supports function calling; what is Responses-only is the newest model's tool calling and the hosted
  tools. This came from an unverified search summary and had been promoted into the plan's headline
  decisions. Caught only on a second, deliberately sceptical pass. This is the single best argument
  for treating model output as a draft.
- **Overclaimed the incremental re-ingestion win** — "editing a typo re-embeds one chunk, not forty."
  Overlap means an edit usually touches two, and a large insertion can shift downstream boundaries
  and cascade. Corrected to a measured ratio rather than a best case.
- **Garbled a benchmark.** "Supabase benchmarks put the naive RLS form at 20x–10,000x slower" conflated
  two separate findings. The real documented numbers are better and more specific: 179ms → 9ms.
- **Cited one source while ignoring a contradicting one it had already found.** Semantic chunking was
  written up as "15–25% better" when a second source in the same research put the gap at 2–6 points.
  The plan now records the disagreement and makes it the reason the eval harness exists.
- **Proposed a FakeProvider with hash-based embeddings** — effectively random vectors, which would
  have made both the zero-key demo and the CI eval meaningless. Changed to a hashing vectorizer so
  cosine similarity tracks real lexical overlap.

**Judgment calls made by me, not the model**

- `task.md` is authoritative; the build brief is subordinate to it. Applying that removed workspaces
  entirely — the assignment scopes visibility to a user's _own_ documents, so building team tenancy
  would diverge from the spec rather than exceed it. That cut 1.5 days and improved alignment.
- No Vercel AI SDK. Its provider registry _is_ the abstraction the assignment asks me to design;
  using it would outsource the most heavily weighted requirement.
- Chat Completions over the Responses API, accepting that OpenAI recommends otherwise, because
  cross-provider portability is the stated key requirement.

**Environment**
fnm 1.39.0 → Node 24.21.0 (was 22.13.0, which fails `@nestjs/schematics@12`); pnpm 12.5.1 via
corepack; Docker 29.1.3 up with 8 CPUs / 7.7 GB. Found and fixed a shadowing bug: a standalone Node
22 at `/usr/local/bin/node` won in non-interactive and login shells because macOS `path_helper`
rebuilds PATH after `~/.zshenv`. Resolved by initialising fnm in `~/.zshenv` _and_ `~/.zprofile`.

**Next:** M0 foundations, opening with the environment verification gate — pgvector version, local
JWT algorithm, and Auth Admin API user creation. All three are assumptions the plan refuses to make
without checking.

---

## 2026-09-23 (later) — M0 through M6. Backend and frontend complete.

**Shipped:** monorepo and toolchain (M0), schema + RLS + hybrid search (M1), the provider-agnostic
AI layer (M2), chunking and fusion (M3), documents and background ingestion (M4), retrieval and
streaming chat (M5), the Next.js UI (M6). 195 unit tests, 28 integration, 2 E2E.

**Where AI accelerated things**
- Version research paid off repeatedly. TypeScript 7 ships no compiler API so `nest build` cannot
  run on it; NestJS 12 is ESM-only so CommonJS consumption needs a resolution mode TypeScript 6
  already deprecates; Next 16 removed `next lint`. All three would have been discovered painfully.
- Reading the actual `.d.ts` files rather than guessing APIs. `StandardSchemaValidationPipe` takes
  the schema on the *parameter decorator*, not the pipe constructor — I had guessed wrong, and the
  type definitions settled it in one look.
- Writing tests that encode intent rather than implementation. Several caught real bugs immediately.

**Where AI was wrong, and what it cost**
- **Guessed API shapes instead of checking.** pg-boss v12 has no default export, `createQueue` does
  not take a `name` in its options, and `@eslint/js` does not track ESLint's version number. Each
  was a build failure that a thirty-second look at the types would have prevented.
- **Optimised before measuring, and broke correctness.** Added a pg-boss `singletonKey` to debounce
  rapid saves. It enforces uniqueness across *all* job states including `completed`, so after a
  document's first ingestion every later enqueue returned null and the document could never be
  re-ingested — silently, with nothing logged. The debounce protected against a problem that does
  not exist at single-digit jobs per minute.
- **Wrote a schema whose default silently destroyed data.** `updateDocumentSchema` reused a `tags`
  field carrying `.default([])`, so `PATCH {}` parsed to `{ tags: [] }`, passed the "no fields"
  guard, and cleared the document's tags. Caught only because a test asserted the schema's stated
  intent rather than its behaviour.
- **Built a fake provider that quoted its own instructions back.** The zero-key demo answered
  questions with the prompt's rules. Fixed to extract only from source blocks and to emit real
  citation markers.
- **Three silent successes in a row.** The singleton, the citation INSERT blocked by a missing RLS
  policy, and seeded documents never being enqueued all failed with no error anywhere. The pattern
  is the lesson: an unchecked return value is how a feature appears to work while doing nothing.

**Verification that actually proved something**
Mutation testing twice. Disabling RLS on `chunks` failed exactly the four chunk-related tests,
including both retrieval paths. Breaking CORS failed the E2E. Both confirmed the tests fail for the
right reason, which a passing test never demonstrates on its own.

**Cost of a careless command**
My setup script shelled out to `pnpm` from a process pnpm had launched. Corepack responded by
installing pnpm globally and appending a `PNPM_HOME` block to `~/.zshrc`, after which pnpm took
30+ seconds of CPU to print its own version. Reverted the shell change and switched the script to
call local binaries directly, which is both faster and free of side effects. Verification for the
rest of the session ran through `node_modules/.bin` rather than the package manager.

**Judgment calls**
- `"ui": "tui"` in turbo.json hangs when stdout is redirected, which breaks CI and any script.
  Changed to `stream`.
- CORS now allows both `localhost` and `127.0.0.1`. They are different origins to a browser, and a
  reviewer may open either — the API tested fine with curl while the browser saw a blank page.
- Stepped four dependencies back to settled releases after pnpm's supply-chain check flagged them as
  published the same day.

**Next:** eval harness with committed numbers, then PDF upload and the usage view.
