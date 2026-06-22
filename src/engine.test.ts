// engine.test.ts — deterministic unit tests for the N-player engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, join, startMatch, setConnected, bet, reveal, discussDone, setLiar,
  nextRound, rematch, viewFor, START_CHIPS, type Room,
} from './engine.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}

function lobby(n: number, seed = 1): Room {
  const room = createRoom('T', lcg(seed));
  for (let i = 0; i < n; i++) join(room, undefined, `P${i}`);
  return room;
}
function game(n: number, seed = 1): Room {
  const room = lobby(n, seed);
  startMatch(room, room.host);
  return room;
}

const P = (room: Room) => room.players;
const inHandSeats = (room: Room): number[] =>
  room.round ? room.round.participants.filter((s) => !P(room)[s]!.folded) : [];
// Conservation: every in-match player's chips + the pot + the carry == n*35.
function total(room: Room): number {
  let t = room.carry + (room.round?.pot ?? 0);
  for (const p of room.players) if (p && p.inMatch) t += p.chips;
  return t;
}
function inMatchCount(room: Room): number {
  return room.players.filter((p) => p && p.inMatch).length;
}
function assertNoLeak(room: Room) {
  for (const s of room.players.map((_, i) => i)) {
    if (!room.players[s]) continue;
    const v = viewFor(room, s) as any;
    for (const o of v.others ?? []) assert.ok(!('hole' in o), 'opponent hole cards must never leak');
  }
}

// Passive driver: checks/calls, reveals first non-liar, auto-resolves liar, readies up.
function step(room: Room, foldSeat = -1) {
  const r = room.round as any;
  switch (room.phase) {
    case 'bet1':
    case 'bet2': {
      const s = r.toAct;
      if (s === -1) return;
      const v = viewFor(room, s) as any;
      if (s === foldSeat && inHandSeats(room).length > 1) bet(room, s, 'fold');
      else if (v.betting.canCheck) bet(room, s, 'check');
      else bet(room, s, 'call');
      break;
    }
    case 'reveal':
      for (const s of inHandSeats(room)) {
        const p = P(room)[s]!;
        if (p.revealIndex === null) reveal(room, s, p.hole.findIndex((c) => c.suit !== 'liar'));
      }
      break;
    case 'discuss':
      for (const s of inHandSeats(room)) if (!P(room)[s]!.discussReady) discussDone(room, s);
      break;
    case 'showdown':
      for (const s of inHandSeats(room)) {
        const p = P(room)[s]!;
        if (p.liar?.pending) setLiar(room, s, { values: p.liar.suggestion });
      }
      if (r.result) nextRound(room, r.participants[0]);
      break;
  }
}

// ---------------------------------------------------------------------------
// Lobby & start
// ---------------------------------------------------------------------------

test('lobby gathers players; only the host starts; needs 2+', () => {
  const room = lobby(3);
  assert.equal(room.phase, 'lobby');
  assert.equal((viewFor(room, room.host) as any).lobby.canStart, true);
  assert.match(startMatch(room, (room.host + 1) % 3).error!, /host/i);
  const solo = lobby(1);
  assert.match(startMatch(solo, solo.host).error!, /at least 2/i);

  assert.equal(startMatch(room, room.host).error, undefined);
  assert.equal(room.phase, 'bet1');
  assert.equal(room.round!.participants.length, 3);
  assert.equal(room.round!.pot, 3); // three antes
  for (const p of room.players) if (p) assert.equal(p.chips, START_CHIPS - 1);
  assert.equal(total(room), 3 * START_CHIPS);
});

test('a player cannot join a match in progress (token reconnect still works)', () => {
  const room = game(2);
  const r = join(room, undefined, 'late');
  assert.equal(r.ok, false);
  const tok = room.players[0]!.token;
  const rj = join(room, tok, 'P0');
  assert.equal(rj.ok, true);
});

test('the deck scales with the table but always holds exactly one liar', () => {
  // deck = 48·ceil(n/2)+1, minus the 2n+1 cards dealt at round start.
  for (const [n, expected] of [[2, 44], [4, 88], [8, 176]] as const) {
    const room = game(n, 50 + n);
    assert.equal(room.deck.length, expected, `${n}-player deck size`);
    let liars = room.deck.filter((c) => c.suit === 'liar').length;
    if (room.round!.shared!.suit === 'liar') liars++;
    for (const s of room.round!.participants) liars += P(room)[s]!.hole.filter((c) => c.suit === 'liar').length;
    assert.equal(liars, 1, `${n}-player liar count`);
  }
});

test('every round rolls dice and the highest roll acts first', () => {
  const room = game(4, 7);
  const r = room.round as any;
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
  const room = game(3, 5);
  // fold the two non-first actors as they come up
  let guard = 0;
  while (room.phase === 'bet1' && guard++ < 20) {
    const s = room.round!.toAct;
    if (inHandSeats(room).length === 1) break;
    bet(room, s, 'fold');
  }
  assert.equal(room.phase, 'showdown');
  assert.equal(room.round!.result!.kind, 'fold');
  assert.equal(room.round!.result!.awards.length, 1);
  assert.equal(total(room), 3 * START_CHIPS);
});

test('multi-way raise then calls keeps chips conserved and advances', () => {
  const room = game(3, 9);
  const first = room.round!.toAct;
  bet(room, first, 'raise', 4);
  let guard = 0;
  while ((room.phase === 'bet1') && guard++ < 20) {
    const s = room.round!.toAct;
    if (s === -1) break;
    bet(room, s, 'call');
  }
  assert.equal(room.phase, 'reveal'); // bet1 closed, third card dealt
  assert.equal(total(room), 3 * START_CHIPS);
});

// ---------------------------------------------------------------------------
// Side pots
// ---------------------------------------------------------------------------

test('side pots: a short all-in can only win the main pot', () => {
  const room = game(3, 3);
  // Control order and stacks (white-box, so global conservation is intentionally
  // perturbed here — we assert the pot is distributed exactly instead).
  room.round!.toAct = 0; // force seat 0 to act first
  room.round!.firstActor = 0;
  P(room)[0]!.chips = 4; // short stack (already anted 1 → contributes 5 total)
  P(room)[1]!.chips = 25;
  P(room)[2]!.chips = 25;
  bet(room, 0, 'raise', 4); // p0 all-in: contributes 1+4 = 5
  assert.equal(P(room)[0]!.allIn, true);
  bet(room, 1, 'raise', 15); // p1 to 19 this round → contributes 20
  bet(room, 2, 'call'); // p2 matches 19 → contributes 20
  assert.equal(room.phase, 'reveal');
  // Force final hands: p0 quad(3) > p1 triple(7) > p2 one-love(9).
  const c = (suit: string, id: number) => ({ suit, id } as any);
  P(room)[0]!.hole = [c('rock', 1), c('rock', 2), c('rock', 3)];
  P(room)[1]!.hole = [c('scissor', 4), c('scissor', 5), c('scissor', 6)];
  P(room)[2]!.hole = [c('paper', 7), c('paper', 8), c('love', 9)];
  room.round!.shared = c('rock', 10);
  reveal(room, 0, 0); reveal(room, 1, 0); reveal(room, 2, 0);
  discussDone(room, 0); discussDone(room, 1); discussDone(room, 2);
  let g = 0;
  while (room.phase === 'bet2' && g++ < 10) { const s = room.round!.toAct; if (s === -1) break; bet(room, s, 'check'); }
  assert.equal(room.phase, 'showdown');
  const res = room.round!.result!;
  const won = (s: number) => res.awards.find((a) => a.seat === s)?.amount ?? 0;
  // Main pot = 5×3 = 15 (p0 eligible, best) → p0. Side pot = 15×2 = 30 (p1,p2) → p1 beats p2.
  assert.equal(won(0), 15, 'short all-in wins only the main pot');
  assert.equal(won(1), 30, 'deep stacks contest the side pot; triple beats one-love');
  assert.equal(won(2), 0, 'worst hand wins nothing');
  // The whole contested pot (45) is distributed, nothing lost.
  assert.equal(won(0) + won(1) + won(2) + res.carried, 45);
});

test('a 0-chip player still wins a carried pot they are owed', () => {
  const room = game(2, 21);
  let g = 0;
  while (room.phase !== 'showdown' && g++ < 60) step(room); // reach a showdown
  // Simulate a drawn all-in: both broke, the whole pot (70) carried.
  P(room)[0]!.chips = 0;
  P(room)[1]!.chips = 0;
  room.carry = 70;
  nextRound(room, 0);
  assert.notEqual(room.phase, 'matchover', 'a carried pot keeps the match alive');
  assert.equal(room.round!.pot, 70); // no antes; the carry is the prize
  assert.ok(P(room)[0]!.allIn && P(room)[1]!.allIn);

  // Force hands so the broke player p1 (quad) beats p0 (one pair).
  const c = (suit: string, id: number) => ({ suit, id } as any);
  P(room)[0]!.hole = [c('rock', 1), c('rock', 2), c('paper', 3)];
  P(room)[1]!.hole = [c('scissor', 4), c('scissor', 5), c('scissor', 6)];
  room.round!.shared = c('scissor', 7); // p0 one-pair(8); p1 scissor quad(3)
  for (const s of [0, 1]) reveal(room, s, P(room)[s]!.hole.findIndex((x) => x.suit !== 'liar'));
  for (const s of [0, 1]) discussDone(room, s);
  const res = room.round!.result!;
  const won = (s: number) => res.awards.find((a) => a.seat === s)?.amount ?? 0;
  assert.equal(won(1), 70, 'the 0-chip player with the best hand wins the carry');
  assert.equal(won(0), 0);
});

// ---------------------------------------------------------------------------
// Multi-way showdown: cyclic tie splits among the cycle
// ---------------------------------------------------------------------------

test('a rock-paper-scissor cycle at the top splits the pot among the cycle', () => {
  const room = game(3, 2);
  // reach reveal with 3 cards each
  bet(room, room.round!.toAct, 'check'); // p? ...
  let g = 0;
  while (room.phase === 'bet1' && g++ < 10) { const s = room.round!.toAct; if (s === -1) break; bet(room, s, 'check'); }
  assert.equal(room.phase, 'reveal');
  const c = (suit: string, id: number) => ({ suit, id } as any);
  // Shared = liar so each player independently sets the 4th card → build a cycle.
  P(room)[0]!.hole = [c('rock', 1), c('rock', 2), c('rock', 3)];
  P(room)[1]!.hole = [c('scissor', 4), c('scissor', 5), c('scissor', 6)];
  P(room)[2]!.hole = [c('paper', 7), c('paper', 8), c('paper', 9)];
  room.round!.shared = c('liar', 10);
  reveal(room, 0, 0); reveal(room, 1, 0); reveal(room, 2, 0);
  discussDone(room, 0); discussDone(room, 1); discussDone(room, 2);
  while (room.phase === 'bet2' && g++ < 20) { const s = room.round!.toAct; if (s === -1) break; bet(room, s, 'check'); }
  assert.equal(room.phase, 'showdown');
  // Each sets the shared liar to make rank-7 triples that cycle: rock>scissor>paper>rock.
  setLiar(room, 0, { values: ['paper'] }); // rock,rock,rock,paper
  setLiar(room, 1, { values: ['rock'] }); // scissor³ + rock
  setLiar(room, 2, { values: ['scissor'] }); // paper³ + scissor
  const res = room.round!.result!;
  assert.equal(res.awards.length, 3, 'all three cycle members share');
  assert.equal(total(room), 3 * START_CHIPS);
});

// ---------------------------------------------------------------------------
// Reveal buffering
// ---------------------------------------------------------------------------

test('reveals are withheld until everyone still in has locked in', () => {
  const room = game(3, 4);
  let g = 0;
  while (room.phase === 'bet1' && g++ < 10) { const s = room.round!.toAct; if (s === -1) break; bet(room, s, 'check'); }
  assert.equal(room.phase, 'reveal');
  const live = inHandSeats(room);
  reveal(room, live[0], P(room)[live[0]]!.hole.findIndex((c) => c.suit !== 'liar'));
  // another player should NOT see live[0]'s card yet
  const other = live[1];
  assert.equal((viewFor(room, other) as any).others.find((o: any) => o.seat === live[0]).revealedCard, null);
  for (const s of live.slice(1)) reveal(room, s, P(room)[s]!.hole.findIndex((c) => c.suit !== 'liar'));
  assert.equal(room.phase, 'discuss');
  assert.notEqual((viewFor(room, other) as any).others.find((o: any) => o.seat === live[0]).revealedCard, null);
});

test('nextRound is idempotent — a second click after advancing is a harmless no-op', () => {
  const room = game(2, 13);
  let g = 0;
  while (room.phase !== 'showdown' && g++ < 80) step(room); // reach a result
  const before = room.roundNo;
  assert.equal(nextRound(room, 0).error, undefined);
  assert.ok(room.roundNo > before, 'first click advances');
  const advanced = room.roundNo;
  const second = nextRound(room, 1); // stale click (round already advanced)
  assert.equal(second.error, undefined, 'no spurious error');
  assert.equal(room.roundNo, advanced, 'does not double-advance');
});

// ---------------------------------------------------------------------------
// Whole-match autoplay: conservation + last player standing
// ---------------------------------------------------------------------------

for (const n of [2, 3, 5, 8]) {
  test(`a ${n}-player match plays to a single winner with chips conserved`, () => {
    const room = game(n, 100 + n);
    let guard = 0;
    while (room.phase !== 'matchover' && guard++ < 2_000_000) {
      step(room);
      assert.equal(total(room), n * START_CHIPS);
      assertNoLeak(room);
    }
    assert.equal(room.phase, 'matchover');
    assert.ok(room.matchWinner !== null);
    assert.equal(P(room)[room.matchWinner!]!.chips, n * START_CHIPS); // winner holds every chip
  });
}

// ---------------------------------------------------------------------------
// Rematch
// ---------------------------------------------------------------------------

test('rematch returns everyone to the lobby with full stacks', () => {
  const room = game(3, 11);
  let guard = 0;
  while (room.phase !== 'matchover' && guard++ < 2_000_000) step(room);
  for (const s of [0, 1, 2]) rematch(room, s);
  assert.equal(room.phase, 'lobby');
  for (const p of room.players) if (p) assert.equal(p.chips, START_CHIPS);
});
