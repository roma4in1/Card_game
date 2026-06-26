import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compare, type Suit } from './evaluator.ts';

// Shorthand suit constructors for readable hands.
const R: Suit = 'rock';
const P: Suit = 'paper';
const S: Suit = 'scissor';
const L: Suit = 'love';

// ---------------------------------------------------------------------------
// Rank classification — every rank 1..9
// ---------------------------------------------------------------------------

test('rank 1: four loves', () => {
  assert.equal(evaluate([L, L, L, L]).rank, 1);
});

test('rank 2: three loves + one any', () => {
  assert.equal(evaluate([L, L, L, R]).rank, 2);
  assert.equal(evaluate([L, L, L, S]).rank, 2);
});

test('rank 3: quad (non-love)', () => {
  assert.equal(evaluate([R, R, R, R]).rank, 3);
  assert.equal(evaluate([P, P, P, P]).rank, 3);
});

test('rank 4: one love + one of each (rock+paper+scissor)', () => {
  assert.equal(evaluate([L, R, P, S]).rank, 4);
});

test('rank 5: two loves + two any non-love (regardless of structure)', () => {
  assert.equal(evaluate([L, L, R, R]).rank, 5); // even when the two form a pair
  assert.equal(evaluate([L, L, R, S]).rank, 5);
});

test('rank 6: two pair (non-love)', () => {
  assert.equal(evaluate([R, R, P, P]).rank, 6);
  assert.equal(evaluate([R, R, S, S]).rank, 6);
});

test('rank 7: triple (non-love)', () => {
  assert.equal(evaluate([R, R, R, P]).rank, 7);
});

test('rank 8: one pair (non-love)', () => {
  assert.equal(evaluate([R, R, P, S]).rank, 8);
});

test('rank 9: one love + three non-love, NOT one-of-each', () => {
  assert.equal(evaluate([L, R, R, S]).rank, 9); // love + pair stays rank 9
  assert.equal(evaluate([L, R, R, R]).rank, 9); // love + triple stays rank 9
  assert.equal(evaluate([L, S, S, P]).rank, 9);
});

// ---------------------------------------------------------------------------
// Love-routing edge cases (the crux of the spec)
// ---------------------------------------------------------------------------

test('love + pair routes to 9, not 8 (love overpowers the pair)', () => {
  const lovePair = evaluate([L, R, R, S]);
  assert.equal(lovePair.rank, 9);
  // and a real pair (rank 8) BEATS the love+pair (rank 9)
  assert.equal(compare([R, R, P, S], [L, R, R, S]), 1);
});

test('love + triple routes to 9, not 7', () => {
  assert.equal(evaluate([L, R, R, R]).rank, 9);
});

test('one-of-each with a love is the ONLY 1-love escape to rank 4', () => {
  assert.equal(evaluate([L, R, P, S]).rank, 4);
  assert.equal(evaluate([L, R, R, P]).rank, 9); // not one-of-each
});

// ---------------------------------------------------------------------------
// Full rank ordering 1 > 2 > 3 > ... > 9 (each strictly beats the next)
// ---------------------------------------------------------------------------

test('strict ordering across every adjacent rank transition', () => {
  const ladder: Suit[][] = [
    [L, L, L, L], // 1
    [L, L, L, R], // 2
    [R, R, R, R], // 3
    [L, R, P, S], // 4
    [L, L, R, S], // 5
    [R, R, P, P], // 6
    [R, R, R, P], // 7
    [R, R, P, S], // 8
    [L, R, R, S], // 9
  ];
  for (let i = 0; i < ladder.length - 1; i++) {
    assert.equal(
      compare(ladder[i], ladder[i + 1]),
      1,
      `rank ${i + 1} hand should beat rank ${i + 2} hand`,
    );
    assert.equal(compare(ladder[i + 1], ladder[i]), -1);
  }
});

// ---------------------------------------------------------------------------
// Tiebreaks — sub-hierarchy (structure beats no-structure within a rank)
// ---------------------------------------------------------------------------

test('rank 5: pair beats no-pair (2love+2rock beats 2love+rock+scissor)', () => {
  assert.equal(compare([L, L, R, R], [L, L, R, S]), 1);
  assert.equal(compare([L, L, R, S], [L, L, R, R]), -1);
});

test('rank 9: two One Love hands always draw', () => {
  // Any two rank-9 (One Love) hands draw regardless of their non-love cards.
  assert.equal(compare([L, R, R, R], [L, R, R, S]), 0);
  assert.equal(compare([L, R, R, S], [L, S, S, P]), 0);
  assert.equal(compare([L, S, S, P], [L, R, R, R]), 0);
});

// ---------------------------------------------------------------------------
// Tiebreaks — cancellation then cyclic RPS
// ---------------------------------------------------------------------------

test('two-pair cancellation: {r,r,p,p} vs {r,r,s,s} -> scissor beats paper', () => {
  // rock-pairs cancel; scissor > paper, so the second hand wins.
  assert.equal(compare([R, R, P, P], [R, R, S, S]), -1);
  assert.equal(compare([R, R, S, S], [R, R, P, P]), 1);
});

test('single pair vs pair: rock-pair beats scissor-pair', () => {
  assert.equal(compare([R, R, P, S], [S, S, R, P]), 1);
  assert.equal(compare([S, S, R, P], [R, R, P, S]), -1);
});

test('rank 5 same sub-structure cancels to a cyclic compare', () => {
  // 2love+rock+paper vs 2love+rock+scissor: rock cancels, scissor>paper.
  assert.equal(compare([L, L, R, P], [L, L, R, S]), -1);
});

test('triple tiebreak by triple suit then kicker', () => {
  // rock-triple beats scissor-triple (rock>scissor), kicker irrelevant.
  assert.equal(compare([R, R, R, P], [S, S, S, P]), 1);
  // same triple suit -> compare kicker: scissor > paper.
  assert.equal(compare([R, R, R, S], [R, R, R, P]), 1);
});

test('quad tiebreak is cyclic on the quad suit', () => {
  assert.equal(compare([R, R, R, R], [S, S, S, S]), 1); // rock>scissor
  assert.equal(compare([S, S, S, S], [P, P, P, P]), 1); // scissor>paper
  assert.equal(compare([P, P, P, P], [R, R, R, R]), 1); // paper>rock (cycle!)
});

// ---------------------------------------------------------------------------
// Draws
// ---------------------------------------------------------------------------

test('rank 1 (four loves) is always a draw', () => {
  assert.equal(compare([L, L, L, L], [L, L, L, L]), 0);
});

test('rank 4 (love + one of each) is always a draw', () => {
  assert.equal(compare([L, R, P, S], [L, S, P, R]), 0);
});

test('identical hands draw', () => {
  assert.equal(compare([R, R, P, P], [P, P, R, R]), 0);
  assert.equal(compare([L, L, R, S], [R, S, L, L]), 0);
});

test('three loves: tie on the single kicker draws, otherwise RPS decides', () => {
  assert.equal(compare([L, L, L, R], [L, L, L, R]), 0);
  assert.equal(compare([L, L, L, R], [L, L, L, S]), 1); // rock>scissor
  assert.equal(compare([L, L, L, P], [L, L, L, R]), 1); // paper>rock
});

// ---------------------------------------------------------------------------
// Cyclic non-transitivity sanity (no global strongest suit)
// ---------------------------------------------------------------------------

test('pairs form a cycle: rock>scissor>paper>rock', () => {
  assert.equal(compare([R, R, P, S], [S, S, R, P]), 1); // rock-pair > scissor-pair
  assert.equal(compare([S, S, R, P], [P, P, R, S]), 1); // scissor-pair > paper-pair
  assert.equal(compare([P, P, R, S], [R, R, P, S]), 1); // paper-pair > rock-pair
});

test('evaluate rejects non-4-card hands', () => {
  assert.throws(() => evaluate([R, R, R]));
  assert.throws(() => evaluate([R, R, R, R, R]));
});
