import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from './fusion.js';

const ids = (xs: string[]) => xs.map((id) => ({ id }));

describe('reciprocalRankFusion', () => {
  it('ranks an item appearing high in both lists first', () => {
    const fused = reciprocalRankFusion([ids(['a', 'b', 'c']), ids(['a', 'c', 'b'])]);
    expect(fused[0]?.id).toBe('a');
  });

  it('beats a single-list top hit with agreement across lists', () => {
    // The core property: consensus outranks a lone strong opinion.
    const fused = reciprocalRankFusion([ids(['x', 'a']), ids(['y', 'a'])]);
    expect(fused[0]?.id).toBe('a');
  });

  it('keeps items that appear in only one list', () => {
    const fused = reciprocalRankFusion([ids(['a']), ids(['b'])]);
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('records the rank each list gave, null when absent', () => {
    const fused = reciprocalRankFusion([ids(['a', 'b']), ids(['b'])]);
    const a = fused.find((f) => f.id === 'a');
    const b = fused.find((f) => f.id === 'b');
    expect(a?.ranks).toEqual([1, null]);
    expect(b?.ranks).toEqual([2, 1]);
  });

  it('honours per-list weights', () => {
    const balanced = reciprocalRankFusion([ids(['a', 'b']), ids(['b', 'a'])]);
    expect(balanced[0]?.id).toBe('a'); // tie broken by id

    const weighted = reciprocalRankFusion([ids(['a', 'b']), ids(['b', 'a'])], { weights: [0, 1] });
    expect(weighted[0]?.id).toBe('b');
  });

  it('uses k to flatten the advantage of top ranks', () => {
    const sharp = reciprocalRankFusion([ids(['a', 'b'])], { k: 1 });
    const flat = reciprocalRankFusion([ids(['a', 'b'])], { k: 1000 });

    const gap = (r: { score: number }[]) => r[0]!.score - r[1]!.score;
    expect(gap(sharp)).toBeGreaterThan(gap(flat));
  });

  it('handles empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('is deterministic for tied scores', () => {
    const a = reciprocalRankFusion([ids(['x', 'y'])]);
    const b = reciprocalRankFusion([ids(['x', 'y'])]);
    expect(a).toEqual(b);
  });

  it('matches the RRF formula exactly', () => {
    const fused = reciprocalRankFusion([ids(['a'])], { k: 50 });
    expect(fused[0]?.score).toBeCloseTo(1 / 51, 10);
  });
});
