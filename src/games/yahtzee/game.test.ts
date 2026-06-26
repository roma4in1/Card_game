// game.test.ts — deterministic unit tests for Yahtzee. Dice are set white-box for
// scoring cases; the Joker / bonus-Yahtzee branch is covered heavily.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yahtzee, CATEGORIES, UPPER, LOWER, type YState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
function newGame(n: number, seed = 1): { s: YState; c: GameContext } {
  const c: GameContext = { rng: lcg(seed), now: 0 };
  const seats = Array.from({ length: n }, (_, i) => i);
  const players = seats.map((seat) => ({ seat, name: `P${seat}` }));
  return { s: yahtzee.create({ seats, players }, c), c };
}
const act = (s: YState, c: GameContext, seat: number, msg: Record<string, unknown>) =>
  yahtzee.act(s, seat, msg, c) ?? {};
const setDice = (s: YState, dice: number[]) => (s.turn.dice = [...dice]);
// current player's scorecard (n=1 games keep seat 0 acting every round)
const card = (s: YState) => s.players[0]!;
const score = (s: YState, c: GameContext, cat: string) => act(s, c, 0, { type: 'score', category: cat });

// ---------------------------------------------------------------------------
// Setup & plain scoring
// ---------------------------------------------------------------------------

test('create opens with five dice rolled and an empty card', () => {
  const { s } = newGame(2);
  assert.equal(s.turn.dice.length, 5);
  assert.equal(s.turn.rollsUsed, 1);
  for (const seat of s.order) {
    const p = s.players[seat]!;
    assert.equal(p.yahtzeeBonus, 0);
    for (const cat of CATEGORIES) assert.equal(p.scores[cat], null);
  }
});

test('upper categories score face × count', () => {
  const { s, c } = newGame(1);
  setDice(s, [3, 3, 3, 1, 2]);
  score(s, c, 'threes');
  assert.equal(card(s).scores.threes, 9);
});

test('three/four of a kind score the sum of all dice, else 0', () => {
  let g = newGame(1);
  setDice(g.s, [3, 3, 3, 1, 2]);
  score(g.s, g.c, 'threeOfAKind');
  assert.equal(card(g.s).scores.threeOfAKind, 12);

  g = newGame(1);
  setDice(g.s, [3, 3, 1, 2, 4]);
  score(g.s, g.c, 'threeOfAKind');
  assert.equal(card(g.s).scores.threeOfAKind, 0);

  g = newGame(1);
  setDice(g.s, [5, 5, 5, 5, 1]);
  score(g.s, g.c, 'fourOfAKind');
  assert.equal(card(g.s).scores.fourOfAKind, 21);
});

test('full house / straights / chance score fixed values', () => {
  const cases: [number[], string, number][] = [
    [[2, 2, 3, 3, 3], 'fullHouse', 25],
    [[2, 2, 2, 3, 4], 'fullHouse', 0],
    [[1, 2, 3, 4, 6], 'smallStraight', 30],
    [[1, 2, 4, 5, 6], 'smallStraight', 0],
    [[2, 3, 4, 5, 6], 'largeStraight', 40],
    [[1, 2, 3, 4, 6], 'largeStraight', 0],
    [[6, 4, 5, 1, 2], 'chance', 18],
  ];
  for (const [dice, cat, want] of cases) {
    const { s, c } = newGame(1);
    setDice(s, dice);
    score(s, c, cat);
    assert.equal(card(s).scores[cat as keyof typeof card], want, `${dice} → ${cat}`);
  }
});

test('plain yahtzee scores 50 when the category is open', () => {
  const { s, c } = newGame(1);
  setDice(s, [4, 4, 4, 4, 4]);
  score(s, c, 'yahtzee');
  assert.equal(card(s).scores.yahtzee, 50);
  assert.equal(card(s).yahtzeeBonus, 0);
});

// ---------------------------------------------------------------------------
// Turn mechanics
// ---------------------------------------------------------------------------

test('up to three rolls; keep-mask preserves dice; no roll after the third', () => {
  const { s, c } = newGame(2, 7);
  assert.equal(s.turn.rollsUsed, 1);
  const keep = [0, 1];
  const before = [s.turn.dice[0], s.turn.dice[1]];
  act(s, c, 0, { type: 'roll', keep });
  assert.equal(s.turn.rollsUsed, 2);
  assert.deepEqual([s.turn.dice[0], s.turn.dice[1]], before, 'kept dice are preserved');
  act(s, c, 0, { type: 'roll', keep });
  assert.equal(s.turn.rollsUsed, 3);
  assert.match(act(s, c, 0, { type: 'roll' }).error!, /no rolls left/i);
});

test('scoring ends the turn and passes to the next player', () => {
  const { s, c } = newGame(2);
  setDice(s, [1, 1, 2, 3, 4]);
  score(s, c, 'ones');
  assert.equal(s.players[0]!.scores.ones, 2);
  assert.equal(s.turn.seat, 1, 'advanced to the next player');
});

test('a category cannot be scored twice', () => {
  const { s, c } = newGame(1);
  setDice(s, [1, 1, 1, 1, 2]);
  score(s, c, 'ones'); // round 1
  setDice(s, [1, 1, 2, 3, 4]);
  assert.match(score(s, c, 'ones').error!, /already filled/i);
});

test('a player may dump a 0 into any open category', () => {
  const { s, c } = newGame(1);
  setDice(s, [2, 3, 4, 5, 6]); // no ones
  score(s, c, 'ones');
  assert.equal(card(s).scores.ones, 0);
});

// ---------------------------------------------------------------------------
// Bonus Yahtzee + Joker rule (the high-risk branch)
// ---------------------------------------------------------------------------

test('bonus Yahtzee, matching upper OPEN → forced into that upper box, +100 awarded', () => {
  const { s, c } = newGame(1);
  card(s).scores.yahtzee = 50; // already have a real Yahtzee
  setDice(s, [4, 4, 4, 4, 4]);
  // forced to Fours; anything else is rejected and must not award the bonus
  assert.match(score(s, c, 'fives').error!, /must score in Fours/i);
  assert.equal(card(s).yahtzeeBonus, 0, 'no bonus on a rejected move');
  score(s, c, 'fours');
  assert.equal(card(s).scores.fours, 20);
  assert.equal(card(s).yahtzeeBonus, 1, '+100 bonus tallied');
});

test('bonus Yahtzee, matching upper USED → Joker into a lower box at full value', () => {
  for (const [cat, want] of [['fullHouse', 25], ['smallStraight', 30], ['largeStraight', 40], ['chance', 20], ['threeOfAKind', 20]] as const) {
    const { s, c } = newGame(1);
    card(s).scores.yahtzee = 50;
    card(s).scores.fours = 20; // U used
    setDice(s, [4, 4, 4, 4, 4]);
    score(s, c, cat);
    assert.equal(card(s).scores[cat], want, `Joker ${cat}`);
    assert.equal(card(s).yahtzeeBonus, 1, `bonus with ${cat}`);
  }
});

test('bonus Yahtzee with a lower box open → an upper box is rejected as the Joker target', () => {
  const { s, c } = newGame(1);
  card(s).scores.yahtzee = 50;
  card(s).scores.fours = 20;
  setDice(s, [4, 4, 4, 4, 4]);
  assert.match(score(s, c, 'fives').error!, /open lower box/i);
});

test('prior Yahtzee of 0 → Joker placement allowed but NO bonus', () => {
  const { s, c } = newGame(1);
  card(s).scores.yahtzee = 0; // a Yahtzee box wasted on 0
  card(s).scores.fours = 20;
  setDice(s, [4, 4, 4, 4, 4]);
  score(s, c, 'fullHouse');
  assert.equal(card(s).scores.fullHouse, 25, 'Joker still grants full value');
  assert.equal(card(s).yahtzeeBonus, 0, 'no bonus because the prior Yahtzee was 0');
});

test('bonus Yahtzee, upper used and no lower open → forced 0 into an open upper, bonus still given', () => {
  const { s, c } = newGame(1);
  const p = card(s);
  p.scores.fours = 20; // U used
  for (const cat of LOWER) p.scores[cat] = 0; // every lower box filled...
  p.scores.yahtzee = 50; // ...but the Yahtzee box itself holds a real 50
  // only upper boxes remain open
  setDice(s, [4, 4, 4, 4, 4]);
  score(s, c, 'ones'); // five 4s into ones = 0
  assert.equal(p.scores.ones, 0, 'forced 0 into an open upper');
  assert.equal(p.yahtzeeBonus, 1, 'bonus still tallied');
});

test('ordinary five-of-a-kind with Yahtzee OPEN → no Joker, no forced placement', () => {
  // can take it as 50 in yahtzee...
  let g = newGame(1);
  setDice(g.s, [3, 3, 3, 3, 3]);
  score(g.s, g.c, 'fours'); // freely dump into another category (no force)
  assert.equal(g.s.players[0]!.scores.fours, 0);

  // ...or as a plain 0 in full house (no Joker, since Yahtzee is still open)
  g = newGame(1);
  setDice(g.s, [3, 3, 3, 3, 3]);
  const pv = (yahtzee.view(g.s, 0) as any).turn.previews;
  assert.equal(pv.fullHouse.value, 0, 'no Joker while Yahtzee is open');
  assert.equal(pv.fullHouse.allowed, true);
  assert.equal(pv.yahtzee.value, 50);
});

// ---------------------------------------------------------------------------
// End of game
// ---------------------------------------------------------------------------

test('upper bonus (+35) lands when the upper section reaches 63', () => {
  const { s } = newGame(1);
  const p = s.players[0]!;
  // three of each 1..6 = 3*(1+2+3+4+5+6)=63
  (['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'] as const).forEach((cat, i) => (p.scores[cat] = 3 * (i + 1)));
  const v = yahtzee.view(s, 0) as any;
  const me = v.players.find((x: any) => x.seat === 0);
  assert.equal(me.upper, 63);
  assert.equal(me.upperBonus, 35);
});

test('a full match plays out via the bot to a winner with every box filled', () => {
  const { s, c } = newGame(2, 99);
  let guard = 0;
  while (!s.over && guard++ < 100000) {
    const seat = s.turn.seat;
    const mv = yahtzee.bot(s, seat, c);
    assert.ok(mv, 'bot always has a move on its turn');
    assert.equal(act(s, c, seat, mv!).error, undefined, JSON.stringify(mv));
  }
  assert.equal(s.over, true);
  const out = yahtzee.result(s);
  assert.equal(out.over, true);
  assert.ok(out.winners.length >= 1);
  for (const seat of s.order) {
    for (const cat of CATEGORIES) assert.notEqual(s.players[seat]!.scores[cat], null, `${seat} ${cat} filled`);
  }
  assert.equal(s.round, 14, 'ended after 13 rounds');
});
