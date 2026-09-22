# Dev log

Running record of how this was built, kept for the required walkthrough on **how AI was used to
accelerate development**. Written as I go, not reconstructed afterwards.

**Format.** One entry per working session. The section that matters is *"Where AI was wrong"* — a log
that only records AI writing code quickly says nothing useful. The interesting claim is that AI
accelerated the work *and* was wrong often enough that verification had to be part of the loop.

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
  entirely — the assignment scopes visibility to a user's *own* documents, so building team tenancy
  would diverge from the spec rather than exceed it. That cut 1.5 days and improved alignment.
- No Vercel AI SDK. Its provider registry *is* the abstraction the assignment asks me to design;
  using it would outsource the most heavily weighted requirement.
- Chat Completions over the Responses API, accepting that OpenAI recommends otherwise, because
  cross-provider portability is the stated key requirement.

**Environment**
fnm 1.39.0 → Node 24.21.0 (was 22.13.0, which fails `@nestjs/schematics@12`); pnpm 12.5.1 via
corepack; Docker 29.1.3 up with 8 CPUs / 7.7 GB. Found and fixed a shadowing bug: a standalone Node
22 at `/usr/local/bin/node` won in non-interactive and login shells because macOS `path_helper`
rebuilds PATH after `~/.zshenv`. Resolved by initialising fnm in `~/.zshenv` *and* `~/.zprofile`.

**Next:** M0 foundations, opening with the environment verification gate — pgvector version, local
JWT algorithm, and Auth Admin API user creation. All three are assumptions the plan refuses to make
without checking.
