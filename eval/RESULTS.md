# Retrieval evaluation results

Produced by `pnpm eval`. Re-runnable, deterministic, and offline — it uses the fake embedding
provider so CI needs no API key.

**Corpus:** 8 documents, ~1,240 tokens each, 35 questions.
**Scoring:** chunk-level. A hit requires a *returned chunk* to contain the answer span. Retrieving
the right document but the wrong chunk still produces a prompt that cannot answer the question, so
document-level scoring would flatter the system.

Last run: 2026-09-23, `fake/fake-embed-v1`.

---

## Retrieval mode — 512-token chunks, 64 overlap, 25 chunks

| mode | hit@1 | hit@3 | hit@5 | MRR |
|---|---|---|---|---|
| semantic only | 86% | 94% | 94% | 0.900 |
| keyword only | **91%** | 94% | 94% | **0.933** |
| hybrid (RRF) | 89% | 94% | 94% | 0.921 |

**Hybrid does not beat keyword search here, and that result should not be over-read.** The default
embedding provider is a hashing vectorizer, so its "semantic" similarity *is* lexical overlap —
fusing two lexical signals cannot add a semantic one. This measures that the fusion machinery works
and costs nothing, not that hybrid beats vector search in general.

The honest conclusion: **this ablation needs a real embedding model to be meaningful.**
`pnpm eval --provider=openai` runs exactly the same comparison against `text-embedding-3-small`,
which is where hybrid would be expected to pull ahead on paraphrased questions.

Hybrid stays the default because its failure mode is better: keyword search returns nothing at all
for a paraphrase that shares no terms, and RRF costs one extra index scan.

---

## Chunk size — hybrid retrieval

| chunk size | chunks | hit@1 | hit@3 | hit@5 | MRR | top-5 as share of corpus |
|---|---|---|---|---|---|---|
| 256 tokens | 46 | 77% | 94% | 94% | 0.857 | 11% |
| 512 tokens | 25 | 89% | 94% | 94% | 0.921 | 20% |
| 1024 tokens | 16 | **97%** | **97%** | **100%** | **0.977** | 31% |

**Read the last column first.** At 1024 tokens a top-5 result set is 31% of the entire corpus
against 11% at 256, so part of the apparent advantage is simply that there is less to discriminate
between. On a corpus of 25 chunks, "retrieve 5" is a much weaker test than it would be on 25,000.

What the numbers do support is that **256 is too small for this content** — hit@1 drops 12 points
and MRR drops 0.064, which is a real effect and not explained by corpus share alone, since 256 and
512 both retrieve a modest slice.

**The default stays 512**, for reasons the harness cannot measure: larger chunks consume the context
budget faster, so fewer sources fit in a prompt, and a citation pointing at a 1024-token block is
much less precise for a reader clicking through to check a claim. Retrieval accuracy is not the only
objective.

I would revisit this with a corpus an order of magnitude larger and a real embedding model before
changing it.

---

## Overlap — 512-token chunks, hybrid

| overlap | hit@1 | hit@3 | hit@5 | MRR |
|---|---|---|---|---|
| 0 tokens | 91% | 97% | 97% | 0.945 |
| 64 tokens | 89% | 94% | 94% | 0.921 |
| 128 tokens | 91% | **100%** | **100%** | **0.952** |

Overlap shows **no consistent benefit at 64 tokens** — it is marginally worse than none — which
matches the January 2026 analysis finding that overlap mostly raises indexing cost. 128 tokens does
help, but the differences are 1–2 questions out of 35 and are inside the noise of a corpus this
size.

Overlap is retained at 64 tokens because its purpose is not ranking: it is to stop a fact that
straddles a boundary from being split across two chunks so that *neither* contains it. That failure
is rare and catastrophic when it happens, and a 35-question fixture is unlikely to contain an
instance. This is a deliberate insurance decision, made knowing the measurement does not support it.

---

## What still fails

Hybrid retrieval misses 2 of 35 questions. Both are short questions whose answer span sits in a
section dominated by boilerplate, so the chunk's overall similarity is diluted by filler the question
does not mention. That is the expected weakness of chunk-level embedding and the case a reranker
would target — which is the measurement that should decide whether to enable it by default.

---

## Honest limitations

- **The corpus is small.** 8 documents and 35 questions. Differences of one or two questions are
  noise, and the chunk-size comparison is confounded by corpus share.
- **The default embedder is lexical**, so the semantic-vs-keyword comparison does not currently test
  what it is named after.
- **Generation is not evaluated.** Faithfulness scoring needs an LLM judge and a real provider; only
  retrieval is measured here.
- **The questions were written alongside the corpus**, so they are cleaner than real user questions —
  fewer typos, no ambiguity, no multi-hop.

These are the reasons the numbers are published with their caveats rather than as a scoreboard. The
harness exists to make the next decision measurable, not to claim the current one is optimal.
