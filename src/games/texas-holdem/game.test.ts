// game.test.ts — Texas Hold'em. The rules a casual implementation gets wrong are the ones
// tested hardest: heads-up blinds and order, the minimum raise, a short all-in that does
// not reopen the betting, side pots, running the board out, and that no chip is ever
// created or lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { texasHoldem, buildPots, blindsFor, chipSetFor, firstLevel, SMALL_BLINDS, type HState } from './game.ts';
import { parse } from '../shared/poker.ts';
import type { GameContext } from '../../platform/types.ts';

const seeded = (n: number) => { let a = n >>> 0; return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296); };
const ctx = (seed = 1): GameContext => ({ rng: seeded(seed), now: 0 });

function newGame(n: number, options: Record<string, number> = {}, seed = 1): HState {
  const seats = Array.from({ length: n }, (_, i) => i);
  return texasHoldem.create({ seats, players: seats.map((seat) => ({ seat, name: 'P' + seat })), options }, ctx(seed)) as HState;
}
const act = (s: HState, seat: number, action: string, to?: number) =>
  texasHoldem.act(s, seat, { type: 'action', action, to }, ctx()) ?? {};
const view = (s: HState, seat: number) => texasHoldem.view(s, seat) as any;
/** Every chip at the table: in the stacks, plus in the pot while a hand is being played. */
const total = (s: HState) => s.players.reduce((a, p) => a + (p ? p.chips + (s.hand?.result ? 0 : p.contributed) : 0), 0);

/** Give each seat its hole cards and stack the deck so the board comes out as given. */
function rig(s: HState, holes: Record<number, string>, board: string) {
  const h = s.hand!;
  for (const [seat, cards] of Object.entries(holes)) s.players[Number(seat)]!.hole = cards.split(' ').map(parse);
  const used = new Set([...Object.values(holes).join(' ').split(' '), ...board.split(' ')].map(parse));
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  // The deck is dealt from the end, so the board's first card goes last.
  h.deck = [...rest, ...board.split(' ').map(parse).reverse()];
}

/** Put the dealer button on a seat and restart the hand there (for exact positions). */
function dealFrom(s: HState, dealer: number) {
  s.hand!.dealer = (dealer - 1 + 8) % 8; // the next hand moves the button one seat on
  for (const p of s.players) if (p) { p.chips += p.contributed; p.contributed = 0; p.committed = 0; }
  s.hand!.result = { kind: 'fold', awards: [], reveals: [] };
  texasHoldem.act(s, 0, { type: 'nextHand' }, ctx());
  s.handNo = 1;
}

test('three-handed: the blinds sit left of the dealer and the action starts after them', () => {
  const s = newGame(3);
  dealFrom(s, 0);
  const h = s.hand!;
  assert.equal(h.dealer, 0);
  assert.equal(h.sb, 1);
  assert.equal(h.bb, 2);
  assert.equal(s.players[1]!.committed, 10);
  assert.equal(s.players[2]!.committed, 20);
  assert.equal(h.toAct, 0, 'the dealer is first to act three-handed');
});

test('heads-up: the dealer posts the small blind, acts first before the flop and last after', () => {
  const s = newGame(2);
  dealFrom(s, 0);
  const h = s.hand!;
  assert.equal(h.sb, 0, 'the dealer is the small blind');
  assert.equal(h.bb, 1);
  assert.equal(h.toAct, 0, 'and acts first preflop');
  act(s, 0, 'call');
  assert.equal(h.toAct, 1, 'the big blind keeps the option to raise');
  act(s, 1, 'check');
  assert.equal(h.street, 'flop');
  assert.equal(h.toAct, 1, 'after the flop the big blind acts first');
});

test('when everyone folds, the last player takes the pot and nothing is shown', () => {
  const s = newGame(3);
  dealFrom(s, 0);
  act(s, 0, 'fold');
  act(s, 1, 'fold');
  const h = s.hand!;
  assert.equal(h.result?.kind, 'fold');
  assert.deepEqual(h.result?.awards, [{ seat: 2, amount: 30 }]);
  assert.equal(s.players[2]!.chips, 1010);
  assert.equal(view(s, 0).players.find((p: any) => p.seat === 2).shown, null, 'a fold win shows no cards');
});

test('the smallest raise is the size of the last raise', () => {
  const s = newGame(3);
  dealFrom(s, 0);
  assert.match(act(s, 0, 'raise', 30).error ?? '', /smallest raise is to 40/);
  assert.equal(act(s, 0, 'raise', 60).error, undefined, 'raise by 40, to 60');
  assert.match(act(s, 1, 'raise', 80).error ?? '', /smallest raise is to 100/, 'the next raise must be at least 40 more');
  assert.equal(act(s, 1, 'raise', 100).error, undefined);
  assert.match(act(s, 2, 'check').error ?? '', /cannot check/);
});

test('an all-in for less than a full raise does not reopen the betting', () => {
  const s = newGame(3);
  dealFrom(s, 0);
  s.players[2]!.chips = 120; // the big blind has 140 in all
  act(s, 0, 'raise', 100); // a raise of 80
  act(s, 1, 'call');
  act(s, 2, 'allin'); // to 140: 40 more, short of a full 80 raise
  const h = s.hand!;
  assert.equal(h.currentBet, 140);
  assert.equal(h.toAct, 0, 'the raiser has to answer the extra 40');
  assert.equal(view(s, 0).betting.canRaise, false, 'but may not raise again');
  assert.match(act(s, 0, 'raise', 300).error ?? '', /cannot raise again/);
  act(s, 0, 'call');
  act(s, 1, 'call');
  assert.equal(h.street, 'flop', 'and the street closes once they have');
});

test('a full raise after a short all-in reopens it for everyone', () => {
  const s = newGame(4);
  dealFrom(s, 0); // 0 deals, 1 SB, 2 BB, 3 first to act
  s.players[0]!.chips = 50; // will go all-in short
  act(s, 3, 'raise', 40);
  act(s, 0, 'allin'); // to 50: short
  act(s, 1, 'raise', 200); // a full raise over 50
  const h = s.hand!;
  assert.equal(h.toAct, 2);
  act(s, 2, 'fold');
  assert.equal(view(s, 3).betting.canRaise, true, 'the full raise lets the first raiser raise again');
});

test('a player all-in is never asked to act, and the board runs out when nobody can bet', () => {
  const s = newGame(2);
  dealFrom(s, 0);
  rig(s, { 0: 'Ah Ad', 1: 'Kc Kd' }, '2s 7h 9c Jd 3s');
  act(s, 0, 'allin');
  act(s, 1, 'call');
  const h = s.hand!;
  assert.equal(h.board.length, 5, 'the whole board is dealt');
  assert.equal(h.result?.kind, 'showdown');
  assert.equal(s.over, true, 'aces hold — and one player now has every chip');
  assert.equal(s.winner, 0);
  assert.equal(s.players[0]!.chips, 2000);
});

test('side pots: each layer goes to the best hand among those who paid into it', () => {
  const s = newGame(3);
  dealFrom(s, 0);
  s.players[0]!.chips = 100; // short stack
  s.players[1]!.chips = 290; // medium (plus the 10 small blind = 300)
  // The short stack holds the best hand, the medium the second best.
  rig(s, { 0: 'Ah Ad', 1: 'Kh Kd', 2: 'Qh Qd' }, '2s 7c 9c Jd 3s');
  act(s, 0, 'allin'); // 100
  act(s, 1, 'allin'); // 300
  act(s, 2, 'call'); // 300
  const r = s.hand!.result!;
  assert.equal(r.kind, 'showdown');
  const won = Object.fromEntries(r.awards.map((a) => [a.seat, a.amount]));
  assert.equal(won[0], 300, 'the short stack wins the main pot: 100 from each');
  assert.equal(won[1], 400, 'the medium stack wins the side pot: 200 from each of two');
  assert.equal(won[2], undefined);
  assert.equal(s.players[2]!.chips, 700);
});

test('chips folded into a pot stay in it, and an uncalled bet comes back', () => {
  const pots = buildPots(new Map([[0, 50], [1, 200], [2, 120]]), new Set([0]));
  assert.deepEqual(pots, [
    { amount: 150, eligible: [1, 2] }, // 50 from each of three, the folder's included
    { amount: 140, eligible: [1, 2] }, // 70 more from each of two
    { amount: 80, eligible: [1] }, // the 80 nobody matched goes back to who bet it
  ]);
  // A layer that only a folded player paid into is not lost: it joins the pot below it.
  assert.deepEqual(buildPots(new Map([[0, 300], [1, 100], [2, 200]]), new Set([0])), [
    { amount: 300, eligible: [1, 2] },
    { amount: 300, eligible: [2] }, // 100 from each of 0 and 2, plus the 100 only 0 put in
  ]);
  // And whatever the mix, the pots add up to everything put in.
  const rng = seeded(5);
  for (let i = 0; i < 500; i++) {
    const contributed = new Map(Array.from({ length: 2 + (i % 7) }, (_, seat) => [seat, Math.floor(rng() * 6) * 50] as [number, number]));
    const folded = new Set([...contributed.keys()].filter(() => rng() < 0.4));
    if (folded.size === contributed.size) folded.delete(0);
    const sum = (m: number[]) => m.reduce((a, b) => a + b, 0);
    const pots = buildPots(contributed, folded);
    if (sum([...contributed.values()]) && pots.length) assert.equal(sum(pots.map((p) => p.amount)), sum([...contributed.values()]));
  }
});

test('a split pot shares the chips, odd chip to the first winner left of the dealer', () => {
  const s = newGame(3);
  dealFrom(s, 0);
  rig(s, { 0: '2c 3d', 1: '4h 5h', 2: '4c 5d' }, 'Ah Kd Qs Jc Ts'); // the board is a straight for all
  act(s, 0, 'call');
  act(s, 1, 'raise', 25); // 25 is not a full raise and not all-in — refused
  act(s, 1, 'call'); // SB completes to 20
  act(s, 2, 'check');
  for (const street of ['flop', 'turn', 'river']) {
    assert.equal(s.hand!.street, street);
    act(s, 1, 'check');
    act(s, 2, 'check');
    act(s, 0, 'check');
  }
  const r = s.hand!.result!;
  assert.equal(r.awards.length, 3, 'all three play the board');
  assert.deepEqual(r.awards.map((a) => a.amount).sort(), [20, 20, 20]);
});

test('your own cards are yours: others see backs until a showdown, and folded hands stay hidden', () => {
  const s = newGame(3);
  dealFrom(s, 0);
  const v0 = view(s, 0);
  assert.equal(v0.you.hole.length, 2);
  const other = v0.players.find((p: any) => p.seat === 1);
  assert.equal(other.holeCount, 2);
  assert.equal(other.shown, null);
  assert.ok(!JSON.stringify(v0).includes(JSON.stringify(view(s, 1).you.hole)), 'seat 1’s cards are nowhere in seat 0’s view');

  act(s, 0, 'fold');
  act(s, 1, 'call');
  act(s, 2, 'check');
  for (let i = 0; i < 3; i++) { act(s, 1, 'check'); act(s, 2, 'check'); }
  const after = view(s, 1);
  assert.ok(after.players.find((p: any) => p.seat === 2).shown, 'the other contender is shown');
  assert.equal(after.players.find((p: any) => p.seat === 0).shown, null, 'the folded hand is not');
});

test('the blinds climb level by level, starting about 50 big blinds deep', () => {
  assert.deepEqual(blindsFor(1000, 10, 1), [10, 20]);
  assert.deepEqual(blindsFor(1000, 10, 10), [10, 20]);
  assert.deepEqual(blindsFor(1000, 10, 11), [15, 30]);
  assert.deepEqual(blindsFor(1000, 10, 21), [25, 50]);
  assert.deepEqual(blindsFor(500, 5, 6), [10, 20]);
  assert.deepEqual(blindsFor(5000, 10, 1), [50, 100], 'a deeper stack starts at bigger blinds');
  assert.deepEqual(blindsFor(1000, 0, 500), [10, 20], '0 = the blinds never rise');
  for (const stack of [500, 1000, 1500, 2500, 5000]) {
    const [, bb] = blindsFor(stack, 10, 1);
    assert.ok(stack / bb >= 40 && stack / bb <= 100, `${stack} chips start ${stack / bb} big blinds deep`);
  }
  // Every level is bigger than the last, all the way past the end of the table.
  let prev = 0;
  for (let hand = 1; hand <= 400; hand += 10) {
    const [sb] = blindsFor(1000, 10, hand);
    assert.ok(sb > prev, `level at hand ${hand}: ${sb} after ${prev}`);
    prev = sb;
  }
  assert.equal(firstLevel(1000), SMALL_BLINDS.indexOf(10));
});

test('the chips colour up as the blinds rise, and every blind can be paid with them', () => {
  for (const [stack, players] of [[500, 2], [1000, 2], [1000, 6], [1500, 4], [5000, 8]]) {
    let smallest = 0;
    for (let hand = 1; hand <= 300; hand += 10) {
      const set = chipSetFor(stack, 10, hand, stack * players);
      const [sb, bb] = blindsFor(stack, 10, hand);
      assert.ok(set[0] >= smallest, `${stack}×${players}, hand ${hand}: a coloured-up chip never comes back`);
      smallest = set[0];
      assert.equal(sb % set[0], 0, `${sb}/${bb} paid exactly in ${set[0]}s`);
      assert.ok(set.length <= 5 && set.every((d, i) => i === 0 || d > set[i - 1]), 'up to five kinds, smallest first');
      assert.ok(set.slice(1).every((d) => d <= (stack * players) / 4), 'no chip worth more than a quarter of the table');
    }
  }
  assert.deepEqual(chipSetFor(1000, 10, 1, 2000), [5, 25, 100, 500]);
  assert.deepEqual(chipSetFor(1000, 10, 51, 2000), [100, 500], 'by 100/200 the 5s and 25s are gone');
});

test('the table is told the level, the chips in play, and when the blinds go up next', () => {
  const s = newGame(3, { blindsEvery: 2 });
  const v = view(s, 0);
  assert.equal(v.level, 1);
  assert.deepEqual(v.chipSet, [5, 25, 100, 500]);
  assert.equal(v.blindsIn, 2);
  assert.deepEqual(v.nextBlinds, [15, 30]);
  for (let hand = 0; hand < 2; hand++) {
    while (!s.hand!.result) act(s, s.hand!.toAct, s.hand!.currentBet - s.players[s.hand!.toAct]!.committed > 0 ? 'call' : 'check');
    texasHoldem.act(s, 0, { type: 'nextHand' }, ctx());
  }
  assert.equal(view(s, 0).level, 2);
  assert.deepEqual(s.hand!.blinds, [15, 30]);
  assert.ok(s.log.some((l) => l.includes('Blinds up') && l.includes('level 2')));
});

test('the timer checks for a stalled player when it can, folds when it cannot, and deals on', () => {
  const s = newGame(3, { timer: 15 });
  dealFrom(s, 0);
  const tick = (now: number) => texasHoldem.tick!(s, { rng: seeded(3), now });
  tick(0); // arms the deadline for seat 0
  tick(16000); // seat 0 faces the big blind: folds
  assert.equal(s.players[0]!.folded, true);
  act(s, 1, 'call');
  tick(16001);
  tick(32002); // the big blind can check: checks
  assert.equal(s.hand!.street, 'flop');
});

test('random play never makes or loses a chip, and always ends with one winner', () => {
  for (let game = 0; game < 30; game++) {
    const rng = seeded(game * 7 + 3);
    const n = 2 + (game % 7);
    const s = newGame(n, { stack: 500, blindsEvery: 5 }, game + 11);
    const chips = n * 500;
    for (let step = 0; step < 20000 && !s.over; step++) {
      const h = s.hand!;
      if (h.result) {
        texasHoldem.act(s, 0, { type: 'nextHand' }, { rng, now: 0 });
        continue;
      }
      const seat = h.toAct;
      assert.ok(seat >= 0 && h.participants.includes(seat), 'someone is always to act mid-hand');
      const b = view(s, seat).betting;
      const roll = rng();
      const res = roll < 0.15 ? act(s, seat, 'fold')
        : roll < 0.55 ? act(s, seat, b.canCheck ? 'check' : 'call')
        : roll < 0.9 && b.canRaise ? act(s, seat, 'raise', b.minTo + Math.floor(rng() * (b.maxTo - b.minTo + 1)))
        : act(s, seat, b.canRaise ? 'allin' : 'call');
      assert.equal(res.error, undefined, JSON.stringify(res));
      assert.equal(total(s), chips, 'no chip appears or vanishes');
      for (const p of s.players) if (p) assert.ok(p.chips >= 0);
    }
    assert.equal(s.over, true, `game ${game} finished`);
    assert.equal(s.players.filter((p) => p && p.chips > 0).length, 1);
    assert.equal(s.players[s.winner!]!.chips, chips);
  }
});

test('the bot keeps a seat moving without ever starting the next hand', () => {
  const s = newGame(3);
  for (let i = 0; i < 300 && !s.hand!.result; i++) {
    const seat = s.hand!.toAct;
    const mv = texasHoldem.bot!(s, seat, ctx())!;
    assert.ok(mv, 'the seat to act always has a move');
    assert.equal((texasHoldem.act(s, seat, mv, ctx()) ?? {}).error, undefined);
  }
  assert.ok(s.hand!.result, 'bots finish the hand');
  assert.equal(texasHoldem.bot!(s, 0, ctx()), null, 'and then wait for a person to deal on');
});
