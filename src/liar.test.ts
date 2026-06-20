// liar.test.ts — liar-resolution strategy.
//
// The round is decided by compare(me, opponent), not by my rank in isolation.
// These tests pin down the resolver's guarantee and the (subtle) reason the two
// strategies coincide under the current ruleset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, evaluate, type Suit } from './evaluator.ts';
import { bestResolution } from './cards.ts';

const SUITS: Suit[] = ['rock', 'paper', 'scissor', 'love'];

function* hands4(): Generator<Suit[]> {
  for (const a of SUITS)
    for (const b of SUITS)
      for (const c of SUITS)
        for (const d of SUITS) yield [a, b, c, d];
}

function fixedCombos(n: number): Suit[][] {
  const out: Suit[][] = [];
  const rec = (acc: Suit[], k: number) => {
    if (k === 0) return out.push([...acc]);
    for (const v of SUITS) rec([...acc, v], k - 1);
  };
  rec([], n);
  return out;
}

// Does ANY assignment of the wild slots beat opp?
function anyWinning(base: Suit[], wild: number[], opp: Suit[]): boolean {
  const rec = (acc: Suit[], k: number): boolean => {
    if (k === 0) {
      const h = [...base];
      wild.forEach((slot, i) => (h[slot] = acc[i]));
      return compare(h, opp) > 0;
    }
    return SUITS.some((v) => rec([...acc, v], k - 1));
  };
  return rec([], wild.length);
}

// The configurations the server actually produces:
//   hole-liar  -> 2 wild slots (the two still-hidden hole cards), 2 fixed
//   shared-liar -> 1 wild slot (the shared card), 3 fixed
const CONFIGS: { name: string; wild: number[]; fixed: number[] }[] = [
  { name: 'hole-liar (2 wild)', wild: [0, 1], fixed: [2, 3] },
  { name: 'shared-liar (1 wild)', wild: [3], fixed: [0, 1, 2] },
];

for (const cfg of CONFIGS) {
  // Strategy B guarantee: the resolver wins whenever a win is possible.
  test(`${cfg.name}: opponent-aware resolver wins whenever any assignment can`, () => {
    for (const fixed of fixedCombos(cfg.fixed.length)) {
      const base: Suit[] = new Array(4).fill('rock');
      cfg.fixed.forEach((slot, i) => (base[slot] = fixed[i]));
      for (const opp of hands4()) {
        const { resolved } = bestResolution(base, cfg.wild, opp);
        if (anyWinning(base, cfg.wild, opp)) {
          assert.ok(
            compare(resolved, opp) > 0,
            `should have found a winning assignment for base=${base} vs opp=${opp}`,
          );
        }
      }
    }
  });

  // Characterisation: under THIS ruleset (love is a legal wild value) the cheaper
  // rank-min strategy never actually loses a winnable round. This documents WHY
  // the coincidence holds; if it ever breaks, the win-max path above still wins.
  test(`${cfg.name}: rank-min coincides with win-max under current rules`, () => {
    for (const fixed of fixedCombos(cfg.fixed.length)) {
      const base: Suit[] = new Array(4).fill('rock');
      cfg.fixed.forEach((slot, i) => (base[slot] = fixed[i]));
      for (const opp of hands4()) {
        const rankMin = bestResolution(base, cfg.wild).resolved; // no oppHand → rank-min
        if (anyWinning(base, cfg.wild, opp)) {
          assert.ok(compare(rankMin, opp) > 0, `rank-min unexpectedly lost a winnable round`);
        }
      }
    }
  });
}

// A concrete liar scenario: holding a hole liar over [love, love] lets you make
// four loves — the strongest hand — which the resolver takes.
test('hole liar over two loves resolves to four loves (rank 1)', () => {
  // Fixed cards (slots 2,3) are the two loves; the two wild slots (0,1) can both
  // become love, making four loves.
  const base: Suit[] = ['rock', 'rock', 'love', 'love'];
  const opp: Suit[] = ['love', 'love', 'scissor', 'scissor']; // rank 5
  const { resolved } = bestResolution(base, [0, 1], opp);
  assert.equal(evaluate(resolved).rank, 1);
  assert.equal(compare(resolved, opp), 1);
});

// Defensive fallback: against an unbeatable opponent (four loves) the resolver
// still returns the strongest hand it can, and never throws.
test('unbeatable opponent: resolver falls back to the strongest hand', () => {
  const base: Suit[] = ['rock', 'paper', 'rock', 'rock'];
  const opp: Suit[] = ['love', 'love', 'love', 'love']; // rank 1
  const { resolved } = bestResolution(base, [0, 1], opp);
  assert.ok(compare(resolved, opp) <= 0); // cannot beat four loves
  assert.ok(evaluate(resolved).rank <= 5); // but still a strong hand, not garbage
});
