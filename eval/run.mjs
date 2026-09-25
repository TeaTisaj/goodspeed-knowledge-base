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
import { CORPUS } from './fixtures/build-corpus.mjs';
import { CASES, OUT_OF_SCOPE_PROBES } from './fixtures/generation-cases.mjs';
import { QUESTIONS } from './fixtures/questions.mjs';
import { loadEvalEnv, resolveTarget } from './lib/providers.mjs';
import { buildIndex, search } from './lib/retrieval.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

loadEvalEnv();
const KS = [1, 3, 5];

async function evaluate(embedder, index, mode) {
  const hits = Object.fromEntries(KS.map((k) => [k, 0]));
  let reciprocalSum = 0;
  const misses = [];

  for (const { q, span } of QUESTIONS) {
    const ranked = await search(embedder, index, q, mode);

    // Chunk-level: the first returned chunk that actually contains the answer.
    const rank = ranked.findIndex((r) => r.content.includes(span));

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

// `--provider=openai` keeps working; `--embed=openrouter:openai/text-embedding-3-small`
// names the model too. Keys come from AI_EMBEDDING_API_KEY or LIVE_<ID>_API_KEY.
const embedTarget = resolveTarget(arg('embed', arg('provider', 'fake')), 'embedding');
const embedder = buildEmbeddingProvider({ ...embedTarget, dimensions: 1536 });

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

const base = await buildIndex(embedder, CORPUS, { maxTokens: 512, overlapTokens: 64 });

console.log(`Retrieval mode (512-token chunks, 64 overlap, ${base.chunks.length} chunks)`);
console.log(header);
const modes = {};
for (const mode of ['semantic', 'keyword', 'hybrid']) {
  modes[mode] = await evaluate(embedder, base, mode);
  console.log(row(mode, modes[mode]));
}

console.log(`\nChunk size (hybrid)`);
console.log(headerWithShare);
/** Chunk counts per size, so the commentary below quotes the run, not a memory. */
const sizeChunkCounts = {};
for (const maxTokens of [256, 512, 1024]) {
  const idx = await buildIndex(embedder, CORPUS, {
    maxTokens,
    overlapTokens: Math.round(maxTokens / 8),
  });
  const r = await evaluate(embedder, idx, 'hybrid');
  // Larger chunks mean fewer of them, so a fixed top-5 covers a bigger share of
  // the corpus. Without this column the chunk-size table reads as "bigger is
  // better" when part of the effect is simply an easier retrieval problem.
  sizeChunkCounts[maxTokens] = idx.chunks.length;
  console.log(row(`${maxTokens} tok`, r, `${idx.chunks.length} chunks`, 5 / idx.chunks.length));
}
console.log(
  `  \n  Read the last column before the others: at 1024 tokens a top-5 result set is` +
    `\n  ${pct(5 / sizeChunkCounts[1024])} of the whole corpus, against ` +
    `${pct(5 / sizeChunkCounts[256])} at 256. Some of the apparent` +
    `\n  advantage of larger chunks is that there is simply less to discriminate between.`,
);

console.log(`\nOverlap (512-token chunks, hybrid)`);
console.log(header);
for (const overlapTokens of [0, 64, 128]) {
  const idx = await buildIndex(embedder, CORPUS, { maxTokens: 512, overlapTokens });
  const r = await evaluate(embedder, idx, 'hybrid');
  console.log(row(`${overlapTokens} tok`, r, `${idx.chunks.length} chunks`));
}

if (modes.hybrid.misses.length > 0) {
  console.log(`\nStill missed by hybrid (${modes.hybrid.misses.length}/${QUESTIONS.length}):`);
  for (const m of modes.hybrid.misses.slice(0, 6)) {
    console.log(`  "${m.q}"`);
    console.log(
      `     wanted a chunk containing "${m.span}"; top was ${m.got.join(', ') || '(nothing)'}`,
    );
  }
}

// --- relevance floor calibration --------------------------------------------
// RETRIEVAL_MIN_SIMILARITY is only meaningful relative to one embedding model's
// cosine scale, so it is chosen from this table rather than guessed.
//
// The two sides are measured differently, because the floor is applied *per
// chunk*:
//   - in scope: the similarity of the chunk that CONTAINS THE ANSWER. That is
//     the chunk the floor must never cut. (The first version of this table used
//     each question's best chunk instead, and the floor it recommended silently
//     dropped the answer to a paraphrased question whose best chunk was a
//     different, merely related one.)
//   - out of scope: the best similarity any chunk reaches, since one surviving
//     chunk is enough to send the question to the model.
const semanticAll = (q) => search(embedder, base, q, 'semantic', base.chunks.length);
const answerSimilarity = async (q, span) =>
  Math.max(
    ...(await semanticAll(q)).filter((r) => r.content.includes(span)).map((r) => r.similarity),
  );
const bestSimilarity = async (q) => (await semanticAll(q))[0].similarity;

// The retrieval questions plus the generation eval's paraphrases, which share
// deliberately few words with the text that answers them.
const inScopeItems = [
  ...QUESTIONS.map((x) => [x.q, x.span]),
  ...CASES.filter((c) => c.span && c.category === 'paraphrase' && (c.split ?? 'dev') === 'dev').map(
    (c) => [c.q, c.span],
  ),
];
const inScope = [];
for (const [q, span] of inScopeItems) inScope.push(await answerSimilarity(q, span));
const outScope = [];
for (const q of OUT_OF_SCOPE_PROBES) outScope.push(await bestSimilarity(q));

const quantile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};
const f3 = (n) => n.toFixed(3);
const inMin = Math.min(...inScope);
const outMax = Math.max(...outScope);

console.log(`\nRelevance floor calibration (${embedder.id}/${embedder.model})`);
console.log(
  `  ${'set'.padEnd(26)} ${'n'.padStart(3)}  ${'min'.padStart(6)}  ${'p10'.padStart(6)}  ${'median'.padStart(6)}  ${'max'.padStart(6)}`,
);
for (const [label, xs] of [
  ['answer chunk, in scope', inScope],
  ['best chunk, out of scope', outScope],
]) {
  console.log(
    `  ${label.padEnd(26)} ${String(xs.length).padStart(3)}  ${f3(Math.min(...xs)).padStart(6)}  ${f3(quantile(xs, 0.1)).padStart(6)}  ${f3(quantile(xs, 0.5)).padStart(6)}  ${f3(Math.max(...xs)).padStart(6)}`,
  );
}
if (inMin > outMax) {
  console.log(
    `  Separable: every in-scope question beats every probe. Any floor in (${f3(outMax)}, ${f3(inMin)}) refuses all probes`,
  );
  console.log(
    `  without losing an answer; the midpoint ${f3((inMin + outMax) / 2)} leaves the most margin on both sides.`,
  );
} else {
  // The highest floor that still keeps every answer chunk, less a margin for
  // questions vaguer than these.
  const floor = Math.floor((inMin - 0.03) * 100) / 100;
  const through = OUT_OF_SCOPE_PROBES.map((q, i) => [q, outScope[i]]).filter(([, x]) => x >= floor);
  console.log(
    `  Overlapping. A floor of ${floor.toFixed(2)} (answer-chunk minimum less 0.03) keeps every answer chunk and refuses`,
  );
  console.log(
    `  ${outScope.length - through.length}/${outScope.length} probes with no model call. These still reach the model, whose rules are the second line:`,
  );
  for (const [q, x] of through)
    console.log(`    ${f3(x)}  "${q.length > 70 ? `${q.slice(0, 67)}...` : q}"`);
}

console.log('');

// CI gate: a retrieval regression should fail the build, not be discovered by a
// user whose question stopped working.
const threshold = Number(arg('min-hit-rate', '0'));
if (modes.hybrid.hit[5] < threshold) {
  console.error(
    `FAIL: hybrid hit@5 ${pct(modes.hybrid.hit[5])} is below the ${pct(threshold)} threshold.`,
  );
  process.exit(1);
}
