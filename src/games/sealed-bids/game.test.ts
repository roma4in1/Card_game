// game.test.ts — Sealed Bids. Simultaneous, so the load-bearing property is that a bid
// in flight leaks nothing; the rest is pot arithmetic (ties carry) and hand bookkeeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealedBids, type SBState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const def = sealedBids;
const setup = { seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] };
// A context whose clock we can push forward to run out the reveal.
const mkCtx = (rng: () => number = () => 0.5): GameContext & { now: number } => ({ rng, now: 1000 });
const start = (ctx: GameContext) => def.create(setup, ctx) as SBState;
const act = (s: SBState, seat: number, msg: Record<string, unknown>, ctx: GameContext) => def.act(s, seat, msg, ctx) ?? {};
const view = (s: SBState, seat: number | null) => def.view(s, seat) as any;

/** Both players bid, then let the reveal expire so the next prize turns over. */
function playRound(s: SBState, ctx: GameContext & { now: number }, a: number, b: number) {
  assert.equal(act(s, 0, { type: 'bid', card: a }, ctx).error, undefined);
  assert.equal(act(s, 1, { type: 'bid', card: b }, ctx).error, undefined);
  ctx.now += 5000;
  def.tick!(s, ctx);
}

// ---------------------------------------------------------------------------
// Privacy — the one secret in the game
// ---------------------------------------------------------------------------

test('a sealed bid is invisible to the opponent until both are in', () => {
  // The strong form: whatever A bids, B's view has to come out byte-identical — a
  // substring check would only prove the number isn't printed somewhere obvious.
  const worlds = [11, 2].map((card) => {
    const ctx = mkCtx();
    const s = start(ctx);
    act(s, 0, { type: 'bid', card }, ctx);
    return { s, ctx, theirs: view(s, 1), spectator: view(s, null) };
  });
  assert.deepEqual(worlds[0].theirs, worlds[1].theirs, 'B cannot tell 11 from 2');
  assert.deepEqual(worlds[0].spectator, worlds[1].spectator, 'nor can a spectator');
  assert.equal(worlds[0].theirs.players[0].committed, true, 'they can see A has committed, just not to what');
  assert.equal(worlds[0].theirs.last, null, 'nothing is revealed yet');
  assert.equal(view(worlds[0].s, 0).you.bid, 11, 'but you can see your own sealed bid');

  // once B answers, both bids are public
  const { s, ctx } = worlds[0];
  act(s, 1, { type: 'bid', card: 2 }, ctx);
  assert.deepEqual(view(s, 1).last.bids, [11, 2]);
});

test('the prize deck beyond the current prize stays secret', () => {
  const ctx = mkCtx();
  const s = start(ctx);
  const shown = view(s, 0);
  assert.deepEqual(shown.pot, [s.prizes[0]], 'only the prize on the table is shown');
  assert.equal(JSON.stringify(shown).includes('"prizes"'), false, 'the deck order is never sent');
});

// ---------------------------------------------------------------------------
// Bidding rules
// ---------------------------------------------------------------------------

test('the higher bid takes the pot and both cards are spent either way', () => {
  const ctx = mkCtx();
  const s = start(ctx);
  const prize = s.prizes[0];
  playRound(s, ctx, 4, 9);
  assert.deepEqual(s.scores, [0, prize], 'B outbid A and banks the prize');
  assert.equal(s.hands[0].includes(4), false, 'A’s losing bid is spent too');
  assert.equal(s.hands[1].includes(9), false);
  assert.equal(s.hands[0].length, 12);
  assert.equal(s.hands[1].length, 12);
});

test('a tie takes nobody: the prize rides on top of the next one', () => {
  const ctx = mkCtx();
  const s = start(ctx);
  const first = s.prizes[0];
  playRound(s, ctx, 7, 7);
  assert.deepEqual(s.scores, [0, 0], 'a tie scores for neither side');
  assert.deepEqual(s.pot, [first, s.prizes[1]], 'the tied prize rides on the next');
  assert.equal(view(s, 0).potTotal, first + s.prizes[1]);

  playRound(s, ctx, 13, 1);
  assert.deepEqual(s.scores, [first + s.prizes[1], 0], 'the next winner sweeps both');
  assert.deepEqual(s.pot, [s.prizes[2]], 'and the pot resets to the fresh prize');
});

test('you cannot bid a card you do not hold, bid twice, or bid during the reveal', () => {
  const ctx = mkCtx();
  const s = start(ctx);
  assert.match(act(s, 0, { type: 'bid', card: 14 }, ctx).error!, /do not hold/);
  assert.match(act(s, 0, { type: 'bid', card: 0 }, ctx).error!, /do not hold/);
  assert.equal(act(s, 0, { type: 'bid', card: 5 }, ctx).error, undefined);
  assert.match(act(s, 0, { type: 'bid', card: 6 }, ctx).error!, /already sealed/);
  act(s, 1, { type: 'bid', card: 3 }, ctx); // resolves → reveal
  assert.match(act(s, 0, { type: 'bid', card: 7 }, ctx).error!, /Wait/);
  assert.match(act(s, 5, { type: 'bid', card: 7 }, ctx).error!, /not in this match/);
  // a spent card cannot come back
  ctx.now += 5000;
  def.tick!(s, ctx);
  assert.match(act(s, 0, { type: 'bid', card: 5 }, ctx).error!, /do not hold/);
});

test('the reveal holds until the clock runs out, then the next prize turns over', () => {
  const ctx = mkCtx();
  const s = start(ctx);
  act(s, 0, { type: 'bid', card: 1 }, ctx);
  act(s, 1, { type: 'bid', card: 2 }, ctx);
  assert.equal(s.phase, 'reveal');
  ctx.now += 100;
  assert.equal(def.tick!(s, ctx), false, 'too early — the reveal is still up');
  assert.equal(s.phase, 'reveal');
  ctx.now += 5000;
  assert.equal(def.tick!(s, ctx), true);
  assert.equal(s.phase, 'bid');
  assert.equal(view(s, 0).round, 2);
});

// ---------------------------------------------------------------------------
// End of the match
// ---------------------------------------------------------------------------

test('thirteen rounds decide it, and the whole 1..13 prize pool is awarded', () => {
  const ctx = mkCtx();
  const s = start(ctx);
  const prizes = [...s.prizes];
  // A always spends their highest, B their lowest (13 v 1, 12 v 2, …): A takes the first
  // six, round seven is 7 v 7 so it carries, and B takes every prize from there.
  for (let r = 0; r < 13; r++) {
    assert.equal(s.over, false, `round ${r + 1} should still be live`);
    playRound(s, ctx, 13 - r, 1 + r);
  }
  assert.equal(s.over, true, 'thirteen rounds and the match is done');
  const take = (from: number, to: number) => prizes.slice(from, to).reduce((a, b) => a + b, 0);
  assert.deepEqual(s.scores, [take(0, 6), take(6, 13)], 'the tied seventh prize carried into B’s run');
  assert.equal(s.scores[0] + s.scores[1], 91, 'nothing leaked: 1+2+…+13 all landed somewhere');
  assert.deepEqual(def.result(s).winners, [s.scores[0] > s.scores[1] ? 0 : 1]);
  assert.equal(view(s, 0).phase, 'done');
});

test('every round tied: the pot rides to the end, then goes unclaimed in a shared win', () => {
  const ctx = mkCtx();
  const s = start(ctx);
  for (let r = 0; r < 13; r++) playRound(s, ctx, s.hands[0][0], s.hands[1][0]); // identical hands ⇒ every round ties
  assert.equal(s.over, true);
  assert.deepEqual(s.scores, [0, 0], 'every prize was tied away');
  assert.match(s.log.join(' '), /91 points go unclaimed/, 'the whole carried pot is discarded, not awarded');
  assert.deepEqual(def.result(s).winners.sort(), [0, 1], 'shared victory');
});

// ---------------------------------------------------------------------------
// Bot + full autoplay
// ---------------------------------------------------------------------------

test('a full match plays out through the bots', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ctx = mkCtx(rng);
  const s = start(ctx);
  for (let guard = 0; guard < 200 && !s.over; guard++) {
    for (const seat of [0, 1]) {
      const mv = def.bot!(s, seat, ctx);
      if (mv) assert.equal(act(s, seat, mv, ctx).error, undefined, JSON.stringify(mv));
    }
    ctx.now += 5000;
    def.tick!(s, ctx);
  }
  assert.equal(s.over, true);
  assert.equal(s.hands[0].length, 0, 'every card was spent');
  assert.equal(s.hands[1].length, 0);
  assert.equal(s.scores[0] + s.scores[1] <= 91, true, 'no more than the 1..13 prize pool was awarded');
  assert.ok(def.result(s).winners.length >= 1);
});

test('the bot never bids a card it has already spent', () => {
  let seed = 42;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ctx = mkCtx(rng);
  const s = start(ctx);
  while (!s.over) {
    for (const seat of [0, 1]) {
      const mv = def.bot!(s, seat, ctx) as any;
      if (!mv) continue;
      const pid = s.order.indexOf(seat);
      assert.ok(s.hands[pid].includes(mv.card), `bot bid ${mv.card} which it no longer holds`);
      act(s, seat, mv, ctx);
    }
    ctx.now += 5000;
    def.tick!(s, ctx);
  }
});

test('bot skill is a real ladder, not a label', () => {
  // Sharp against Casual over many matches: if the setting did nothing, this would sit
  // around half. Both sides are driven from one state, with `skill` swapped per seat.
  let sharpWins = 0;
  let casualWins = 0;
  for (let g = 0; g < 60; g++) {
    let a = g * 7919 + 3;
    const rng = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
    const ctx = { rng, now: 1000 } as GameContext & { now: number };
    const s = start(ctx);
    const sharpSeat = g % 2;
    for (let n = 0; n < 200 && !s.over; n++) {
      for (const seat of [0, 1]) {
        s.skill = seat === sharpSeat ? 3 : 1;
        const mv = def.bot!(s, seat, ctx);
        if (mv) act(s, seat, mv, ctx);
      }
      s.skill = 3;
      ctx.now += 5000;
      def.tick!(s, ctx);
    }
    const hi = s.scores[s.order.indexOf(sharpSeat)];
    const lo = s.scores[s.order.indexOf(1 - sharpSeat)];
    if (hi > lo) sharpWins++; else if (lo > hi) casualWins++;
  }
  assert.ok(sharpWins > casualWins * 3, `Sharp should dominate Casual, got ${sharpWins}-${casualWins}`);
});

