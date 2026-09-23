#!/usr/bin/env node
/**
 * Retrieval evaluation.
 *
 * Exists so the retrieval choices in this project -- chunk size, hybrid vs
 * vector-only, overlap -- stop being arguments and become measurements on this
 * corpus. Published guidance on all three genuinely conflicts, so the only
 * defensible claim is "here is what it did on our data".
 *
 * Scoring is **chunk-level**: a hit requires a returned chunk to actually
 * contain the answer span. Document-level scoring is far more forgiving and
 * does not reflect what the model sees, because retrieving the right document
 * but the wrong chunk still produces a prompt that cannot answer the question.
 *
 * Runs offline against the fake embedding provider by default, so CI needs no
 * API key. `--provider=openai` measures a real embedding model.
 *
 *   hit@k  fraction of questions where the answer span is in the top k chunks
 *   MRR    mean reciprocal rank of the first chunk containing the span
 *
 * MRR is reported alongside hit rate because hit@5 scores "first result" and
 * "fifth result" identically, and they are not equivalent: the context budget
 * means a lower-ranked chunk is likelier to be dropped before the model sees it.
 */
import { buildEmbeddingProvider } from '@kb/ai';
import { chunkText, reciprocalRankFusion } from '@kb/rag';
import { CORPUS } from './fixtures/build-corpus.mjs';
import { QUESTIONS } from './fixtures/questions.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const providerId = arg('provider', 'fake');
const KS = [1, 3, 5];

const tokenize = (t) =>
  t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((x) => x.length > 1);

/** BM25-lite, standing in for the Postgres full-text arm. */
function keywordRank(query, chunks, df, avgLen) {
  const terms = tokenize(query);
  const N = chunks.length;
  return chunks
    .map((c) => {
      let score = 0;
      for (const term of terms) {
        const f = c.tf.get(term);
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.len / avgLen))));
      }
      return { id: c.id, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

async function buildIndex(embedder, opts) {
  const chunks = [];
  for (const doc of CORPUS) {
    for (const c of chunkText(doc.content, opts)) {
      chunks.push({ id: `${doc.id}:${c.index}`, docId: doc.id, content: c.content });
    }
  }

  const { embeddings } = await embedder.embed({ texts: chunks.map((c) => c.content) });

  const df = new Map();
  let totalLen = 0;
  chunks.forEach((c, i) => {
    c.vector = embeddings[i];
    const tokens = tokenize(c.content);
    c.len = tokens.length;
    totalLen += tokens.length;
    c.tf = new Map();
    for (const t of tokens) c.tf.set(t, (c.tf.get(t) ?? 0) + 1);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  });

  return { chunks, df, avgLen: totalLen / (chunks.length || 1) };
}

async function evaluate(embedder, index, mode) {
  const { chunks, df, avgLen } = index;
  const byId = new Map(chunks.map((c) => [c.id, c]));

  const hits = Object.fromEntries(KS.map((k) => [k, 0]));
  let reciprocalSum = 0;
  const misses = [];

  for (const { q, span } of QUESTIONS) {
    const { embeddings } = await embedder.embed({ texts: [q] });
    const qv = embeddings[0];

    const semantic = chunks
      .map((c) => ({ id: c.id, score: cosine(qv, c.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    const keyword = keywordRank(q, chunks, df, avgLen).slice(0, 20);

    const ranked =
      mode === 'semantic' ? semantic : mode === 'keyword' ? keyword : reciprocalRankFusion([semantic, keyword]);

    // Chunk-level: the first returned chunk that actually contains the answer.
    const rank = ranked.findIndex((r) => byId.get(r.id)?.content.includes(span));

    if (rank === -1) {
      misses.push({ q, span, got: ranked.slice(0, 2).map((r) => r.id) });
      continue;
    }
    reciprocalSum += 1 / (rank + 1);
    for (const k of KS) if (rank < k) hits[k]++;
  }

  return {
    hit: Object.fromEntries(KS.map((k) => [k, hits[k] / QUESTIONS.length])),
    mrr: reciprocalSum / QUESTIONS.length,
    misses,
  };
}

// --- run -------------------------------------------------------------------

const embedder = buildEmbeddingProvider({
  provider: providerId,
  dimensions: 1536,
  apiKey: process.env.AI_EMBEDDING_API_KEY,
});

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const row = (label, r, extra = '', corpusShare = null) =>
  `  ${label.padEnd(12)} ${extra.padEnd(11)} ${pct(r.hit[1]).padStart(5)}  ${pct(r.hit[3]).padStart(5)}  ${pct(r.hit[5]).padStart(5)}  ${r.mrr.toFixed(3)}` +
  (corpusShare === null ? '' : `  ${pct(corpusShare).padStart(6)}`);

console.log(`\nRetrieval evaluation`);
console.log(`  corpus      ${CORPUS.length} documents, ${QUESTIONS.length} questions`);
console.log(`  embeddings  ${embedder.id}/${embedder.model}`);
console.log(`  scoring     chunk-level: the answer span must be in a retrieved chunk\n`);

const header = `  ${'config'.padEnd(12)} ${''.padEnd(11)} ${'hit@1'.padStart(5)}  ${'hit@3'.padStart(5)}  ${'hit@5'.padStart(5)}  MRR`;
const headerWithShare = `${header}   top5/corpus`;

const base = await buildIndex(embedder, { maxTokens: 512, overlapTokens: 64 });

console.log(`Retrieval mode (512-token chunks, 64 overlap, ${base.chunks.length} chunks)`);
console.log(header);
const modes = {};
for (const mode of ['semantic', 'keyword', 'hybrid']) {
  modes[mode] = await evaluate(embedder, base, mode);
  console.log(row(mode, modes[mode]));
}

console.log(`\nChunk size (hybrid)`);
console.log(headerWithShare);
for (const maxTokens of [256, 512, 1024]) {
  const idx = await buildIndex(embedder, { maxTokens, overlapTokens: Math.round(maxTokens / 8) });
  const r = await evaluate(embedder, idx, 'hybrid');
  // Larger chunks mean fewer of them, so a fixed top-5 covers a bigger share of
  // the corpus. Without this column the chunk-size table reads as "bigger is
  // better" when part of the effect is simply an easier retrieval problem.
  console.log(row(`${maxTokens} tok`, r, `${idx.chunks.length} chunks`, 5 / idx.chunks.length));
}
console.log(
  `  \n  Read the last column before the others: at 1024 tokens a top-5 result set is` +
    `\n  ${pct(5 / 16)} of the whole corpus, against ${pct(5 / 46)} at 256. Some of the apparent` +
    `\n  advantage of larger chunks is that there is simply less to discriminate between.`,
);

console.log(`\nOverlap (512-token chunks, hybrid)`);
console.log(header);
for (const overlapTokens of [0, 64, 128]) {
  const idx = await buildIndex(embedder, { maxTokens: 512, overlapTokens });
  const r = await evaluate(embedder, idx, 'hybrid');
  console.log(row(`${overlapTokens} tok`, r, `${idx.chunks.length} chunks`));
}

if (modes.hybrid.misses.length > 0) {
  console.log(`\nStill missed by hybrid (${modes.hybrid.misses.length}/${QUESTIONS.length}):`);
  for (const m of modes.hybrid.misses.slice(0, 6)) {
    console.log(`  "${m.q}"`);
    console.log(`     wanted a chunk containing "${m.span}"; top was ${m.got.join(', ') || '(nothing)'}`);
  }
}

console.log('');

// CI gate: a retrieval regression should fail the build, not be discovered by a
// user whose question stopped working.
const threshold = Number(arg('min-hit-rate', '0'));
if (modes.hybrid.hit[5] < threshold) {
  console.error(`FAIL: hybrid hit@5 ${pct(modes.hybrid.hit[5])} is below the ${pct(threshold)} threshold.`);
  process.exit(1);
}
