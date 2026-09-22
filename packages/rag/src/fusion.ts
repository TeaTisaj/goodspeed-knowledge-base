/**
 * Reciprocal Rank Fusion.
 *
 * Mirrors the SQL implementation so it can be unit tested and reused by the
 * eval harness without a database.
 *
 * RRF consumes ranks, not scores, and that is the whole reason to prefer it:
 * cosine distance and ts_rank are on incomparable scales, so any weighted sum
 * of raw scores needs normalisation constants that drift as the corpus grows.
 * Rank is scale-free, leaving `k` as the only knob.
 */

export interface RankedItem {
  id: string;
}

export interface FusionOptions {
  /** Smoothing constant. Higher flattens the advantage of top ranks. */
  k?: number;
  weights?: number[];
}

export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank in each input list, or null if absent. */
  ranks: (number | null)[];
}

export function reciprocalRankFusion(
  lists: RankedItem[][],
  options: FusionOptions = {},
): FusedItem[] {
  const k = options.k ?? 50;
  const weights = options.weights ?? lists.map(() => 1);

  const scores = new Map<string, { score: number; ranks: (number | null)[] }>();

  lists.forEach((list, listIndex) => {
    const weight = weights[listIndex] ?? 1;
    list.forEach((item, position) => {
      const rank = position + 1;
      let entry = scores.get(item.id);
      if (!entry) {
        entry = { score: 0, ranks: lists.map(() => null) };
        scores.set(item.id, entry);
      }
      entry.score += weight * (1 / (k + rank));
      entry.ranks[listIndex] = rank;
    });
  });

  return [...scores.entries()]
    .map(([id, v]) => ({ id, score: v.score, ranks: v.ranks }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
