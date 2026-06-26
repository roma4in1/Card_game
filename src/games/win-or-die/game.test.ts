// game.test.ts — deterministic unit tests for the Win-or-Die game plugin.
// These drive the GameDef directly (create/act/view/result) on its own Match
// state; the lobby/room is tested separately in platform/room.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winOrDie, START_CHIPS, type Match } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}

// Each match keeps its own context so rng advances consistently across actions.
const ctxOf = new WeakMap<Match, GameContext>();

function game(n: number, seed = 1): Match {
  const c: GameContext = { rng: lcg(seed), now: 0 };
  const seats = Array.from({ length: n }, (_, i) => i);
  const players = seats.map((s) => ({ seat: s, name: `P${s}` }));
  const m = winOrDie.create({ seats, players }, c);
  ctxOf.set(m, c);
  return m;
}

function act(m: Match, seat: number, msg: Record<string, unknown>) {
  return winOrDie.act(m, seat, msg, ctxOf.get(m)!) ?? {};
}
const bet = (m: Match, seat: number, action: string, amount = 0) =>
  act(m, seat, { type: 'action', action, amount });
const reveal = (m: Match, seat: number, cardIndex: number) =>
  act(m, seat, { type: 'reveal', cardIndex });
const discussDone = (m: Match, seat: number) => act(m, seat, { type: 'discussDone' });
const setLiar = (m: Match, seat: number, payload: { values?: string[] }) =>
  act(m, seat, { type: 'liar', ...payload });
const nextRound = (m: Match) => act(m, 0, { type: 'nextRound' });
const view = (m: Match, seat: number) => winOrDie.view(m, seat) as any;

const P = (m: Match) => m.players;
const inHandSeats = (m: Match): number[] =>
  m.round ? m.round.participants.filter((s) => !P(m)[s]!.folded) : [];
// Conservation: every in-match player's chips + the pot + the carry == n*35.
function total(m: Match): number {
  let t = m.carry + (m.round?.pot ?? 0);
  for (const p of m.players) if (p && !p.eliminated) t += p.chips;
  return t;
}
function assertNoLeak(m: Match) {
  for (let s = 0; s < m.players.length; s++) {
    if (!m.players[s]) continue;
    const v = view(m, s);
    for (const o of v.others ?? []) assert.ok(!('hole' in o), 'opponent hole cards must never leak');
  }
}

// Passive driver: checks/calls, reveals first non-liar, auto-resolves liar, readies up.
function step(m: Match, foldSeat = -1) {
  const r = m.round as any;
  switch (m.phase) {
    case 'bet1':
    case 'bet2': {
      const s = r.toAct;
      if (s === -1) return;
      const v = view(m, s);
      if (s === foldSeat && inHandSeats(m).length > 1) bet(m, s, 'fold');
      else if (v.betting.canCheck) bet(m, s, 'check');
      else bet(m, s, 'call');
      break;
    }
    case 'reveal':
      for (const s of inHandSeats(m)) {
        const p = P(m)[s]!;
        if (p.revealIndex === null) reveal(m, s, p.hole.findIndex((c) => c.suit !== 'liar'));
      }
      break;
    case 'discuss':
      for (const s of inHandSeats(m)) if (!P(m)[s]!.discussReady) discussDone(m, s);
      break;
    case 'showdown':
      for (const s of inHandSeats(m)) {
        const p = P(m)[s]!;
        if (p.liar?.pending) setLiar(m, s, { values: p.liar.suggestion });
      }
      if (r.result) nextRound(m);
      break;
  }
}

// ---------------------------------------------------------------------------
// Setup, deck & dice
// ---------------------------------------------------------------------------

test('create antes everyone in and opens betting', () => {
  const m = game(3);
  assert.equal(m.phase, 'bet1');
  assert.equal(m.round!.participants.length, 3);
  assert.equal(m.round!.pot, 3); // three antes
  for (const p of m.players) if (p) assert.equal(p.chips, START_CHIPS - 1);
  assert.equal(total(m), 3 * START_CHIPS);
});

test('the deck scales with the table but always holds exactly one liar', () => {
  // deck = 48·ceil(n/2)+1, minus the 2n+1 cards dealt at round start.
  for (const [n, expected] of [[2, 44], [4, 88], [8, 176]] as const) {
    const m = game(n, 50 + n);
    assert.equal(m.deck.length, expected, `${n}-player deck size`);
    let liars = m.deck.filter((c) => c.suit === 'liar').length;
    if (m.round!.shared!.suit === 'liar') liars++;
    for (const s of m.round!.participants) liars += P(m)[s]!.hole.filter((c) => c.suit === 'liar').length;
    assert.equal(liars, 1, `${n}-player liar count`);
  }
});

test('every round rolls dice and the highest roll acts first', () => {
  const m = game(4, 7);
  const r = m.round as any;
  const max = Math.max(...r.participants.map((s: number) => r.dice[s]));
  const leaders = r.participants.filter((s: number) => r.dice[s] === max);
  assert.equal(leaders.length, 1, 'ties are re-rolled to a unique winner');
  assert.equal(r.firstActor, leaders[0]);
  assert.equal(r.toAct, leaders[0], 'action opens on the dice winner');
});

// ---------------------------------------------------------------------------
// Multi-way betting
// ---------------------------------------------------------------------------

test('everyone folding to one player wins the pot immediately', () => {
  const m = game(3, 5);
  let guard = 0;
  while (m.phase === 'bet1' && guard++ < 20) {
    const s = m.round!.toAct;
    if (inHandSeats(m).length === 1) break;
    bet(m, s, 'fold');
  }
  assert.equal(m.phase, 'showdown');
  assert.equal(m.round!.result!.kind, 'fold');
  assert.equal(m.round!.result!.awards.length, 1);
  assert.equal(total(m), 3 * START_CHIPS);
});

test('multi-way raise then calls keeps chips conserved and advances', () => {
  const m = game(3, 9);
  const first = m.round!.toAct;
  bet(m, first, 'raise', 4);
  let guard = 0;
  while (m.phase === 'bet1' && guard++ < 20) {
    const s = m.round!.toAct;
    if (s === -1) break;
    bet(m, s, 'call');
  }
  assert.equal(m.phase, 'reveal'); // bet1 closed, third card dealt
  assert.equal(total(m), 3 * START_CHIPS);
});

// ---------------------------------------------------------------------------
// Side pots
// ---------------------------------------------------------------------------

test('side pots: a short all-in can only win the main pot', () => {
  const m = game(3, 3);
  // Control order and stacks (white-box, so global conservation is intentionally
  // perturbed here — we assert the pot is distributed exactly instead).
  m.round!.toAct = 0; // force seat 0 to act first
  m.round!.firstActor = 0;
  P(m)[0]!.chips = 4; // short stack (already anted 1 → contributes 5 total)
  P(m)[1]!.chips = 25;
  P(m)[2]!.chips = 25;
  bet(m, 0, 'raise', 4); // p0 all-in: contributes 1+4 = 5
  assert.equal(P(m)[0]!.allIn, true);
  bet(m, 1, 'raise', 15); // p1 to 19 this round → contributes 20
  bet(m, 2, 'call'); // p2 matches 19 → contributes 20
  assert.equal(m.phase, 'reveal');
  // Force final hands: p0 quad(3) > p1 triple(7) > p2 one-love(9).
  const c = (suit: string, id: number) => ({ suit, id } as any);
  P(m)[0]!.hole = [c('rock', 1), c('rock', 2), c('rock', 3)];
  P(m)[1]!.hole = [c('scissor', 4), c('scissor', 5), c('scissor', 6)];
  P(m)[2]!.hole = [c('paper', 7), c('paper', 8), c('love', 9)];
  m.round!.shared = c('rock', 10);
  reveal(m, 0, 0); reveal(m, 1, 0); reveal(m, 2, 0);
  discussDone(m, 0); discussDone(m, 1); discussDone(m, 2);
  let g = 0;
  while (m.phase === 'bet2' && g++ < 10) { const s = m.round!.toAct; if (s === -1) break; bet(m, s, 'check'); }
  assert.equal(m.phase, 'showdown');
  const res = m.round!.result!;
  const won = (s: number) => res.awards.find((a) => a.seat === s)?.amount ?? 0;
  // Main pot = 5×3 = 15 (p0 eligible, best) → p0. Side pot = 15×2 = 30 (p1,p2) → p1 beats p2.
  assert.equal(won(0), 15, 'short all-in wins only the main pot');
  assert.equal(won(1), 30, 'deep stacks contest the side pot; triple beats one-love');
  assert.equal(won(2), 0, 'worst hand wins nothing');
  // The whole contested pot (45) is distributed, nothing lost.
  assert.equal(won(0) + won(1) + won(2) + res.carried, 45);
});

test('a 0-chip player still wins a carried pot they are owed', () => {
  const m = game(2, 21);
  let g = 0;
  while (m.phase !== 'showdown' && g++ < 60) step(m); // reach a showdown
  // Simulate a drawn all-in: both broke, the whole pot (70) carried.
  P(m)[0]!.chips = 0;
  P(m)[1]!.chips = 0;
  m.carry = 70;
  nextRound(m);
  assert.notEqual(m.phase, 'matchover', 'a carried pot keeps the match alive');
  assert.equal(m.round!.pot, 70); // no antes; the carry is the prize
  assert.ok(P(m)[0]!.allIn && P(m)[1]!.allIn);

  // Force hands so the broke player p1 (quad) beats p0 (one pair).
  const c = (suit: string, id: number) => ({ suit, id } as any);
  P(m)[0]!.hole = [c('rock', 1), c('rock', 2), c('paper', 3)];
  P(m)[1]!.hole = [c('scissor', 4), c('scissor', 5), c('scissor', 6)];
  m.round!.shared = c('scissor', 7); // p0 one-pair(8); p1 scissor quad(3)
  for (const s of [0, 1]) reveal(m, s, P(m)[s]!.hole.findIndex((x) => x.suit !== 'liar'));
  for (const s of [0, 1]) discussDone(m, s);
  const res = m.round!.result!;
  const won = (s: number) => res.awards.find((a) => a.seat === s)?.amount ?? 0;
  assert.equal(won(1), 70, 'the 0-chip player with the best hand wins the carry');
  assert.equal(won(0), 0);
});

// ---------------------------------------------------------------------------
// Multi-way showdown: cyclic tie splits among the cycle
// ---------------------------------------------------------------------------

test('a rock-paper-scissor cycle at the top splits the pot among the cycle', () => {
  const m = game(3, 2);
  let g = 0;
  while (m.phase === 'bet1' && g++ < 10) { const s = m.round!.toAct; if (s === -1) break; bet(m, s, 'check'); }
  assert.equal(m.phase, 'reveal');
  const c = (suit: string, id: number) => ({ suit, id } as any);
  // Shared = liar so each player independently sets the 4th card → build a cycle.
  P(m)[0]!.hole = [c('rock', 1), c('rock', 2), c('rock', 3)];
  P(m)[1]!.hole = [c('scissor', 4), c('scissor', 5), c('scissor', 6)];
  P(m)[2]!.hole = [c('paper', 7), c('paper', 8), c('paper', 9)];
  m.round!.shared = c('liar', 10);
  reveal(m, 0, 0); reveal(m, 1, 0); reveal(m, 2, 0);
  discussDone(m, 0); discussDone(m, 1); discussDone(m, 2);
  while (m.phase === 'bet2' && g++ < 20) { const s = m.round!.toAct; if (s === -1) break; bet(m, s, 'check'); }
  assert.equal(m.phase, 'showdown');
  // Each sets the shared liar to make rank-7 triples that cycle: rock>scissor>paper>rock.
  setLiar(m, 0, { values: ['paper'] }); // rock,rock,rock,paper
  setLiar(m, 1, { values: ['rock'] }); // scissor³ + rock
  setLiar(m, 2, { values: ['scissor'] }); // paper³ + scissor
  const res = m.round!.result!;
  assert.equal(res.awards.length, 3, 'all three cycle members share');
  assert.equal(total(m), 3 * START_CHIPS);
});

// ---------------------------------------------------------------------------
// Reveal buffering
// ---------------------------------------------------------------------------

test('reveals are withheld until everyone still in has locked in', () => {
  const m = game(3, 4);
  let g = 0;
  while (m.phase === 'bet1' && g++ < 10) { const s = m.round!.toAct; if (s === -1) break; bet(m, s, 'check'); }
  assert.equal(m.phase, 'reveal');
  const live = inHandSeats(m);
  reveal(m, live[0], P(m)[live[0]]!.hole.findIndex((c) => c.suit !== 'liar'));
  // another player should NOT see live[0]'s card yet
  const other = live[1];
  assert.equal(view(m, other).others.find((o: any) => o.seat === live[0]).revealedCard, null);
  for (const s of live.slice(1)) reveal(m, s, P(m)[s]!.hole.findIndex((c) => c.suit !== 'liar'));
  assert.equal(m.phase, 'discuss');
  assert.notEqual(view(m, other).others.find((o: any) => o.seat === live[0]).revealedCard, null);
});

test('nextRound is idempotent — a second click after advancing is a harmless no-op', () => {
  const m = game(2, 13);
  let g = 0;
  while (m.phase !== 'showdown' && g++ < 80) step(m); // reach a result
  const before = m.roundNo;
  assert.equal((nextRound(m) as any).error, undefined);
  assert.ok(m.roundNo > before, 'first click advances');
  const advanced = m.roundNo;
  const second = nextRound(m) as any; // stale click (round already advanced)
  assert.equal(second.error, undefined, 'no spurious error');
  assert.equal(m.roundNo, advanced, 'does not double-advance');
});

// ---------------------------------------------------------------------------
// Whole-match autoplay: conservation + last player standing
// ---------------------------------------------------------------------------

for (const n of [2, 3, 5, 8]) {
  test(`a ${n}-player match plays to a single winner with chips conserved`, () => {
    const m = game(n, 100 + n);
    let guard = 0;
    while (m.phase !== 'matchover' && guard++ < 2_000_000) {
      step(m);
      assert.equal(total(m), n * START_CHIPS);
      assertNoLeak(m);
    }
    assert.equal(m.phase, 'matchover');
    const out = winOrDie.result(m);
    assert.equal(out.over, true);
    assert.equal(out.winners.length, 1);
    assert.equal(m.winner, out.winners[0]);
    assert.equal(P(m)[m.winner!]!.chips, n * START_CHIPS); // winner holds every chip
  });
}
