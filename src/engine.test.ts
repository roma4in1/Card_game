// engine.test.ts — deterministic unit tests for the game engine.
//
// The engine is pure and takes an injectable RNG, so the whole phase machine,
// betting, all-in refunds, draw-carry, elimination and the reveal buffer can be
// driven and asserted without any sockets. White-box pokes (`as any`) are used
// to force specific hands where a fair shuffle could not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom,
  join,
  bet,
  reveal,
  discussDone,
  setLiar,
  nextRound,
  rematch,
  viewFor,
  type Room,
  type Seat,
} from './engine.ts';

// Tiny seeded LCG so games are reproducible.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function newGame(seed = 1): Room {
  const room = createRoom('TEST', lcg(seed));
  join(room, undefined, 'Alice'); // seat 0
  join(room, undefined, 'Bob'); //   seat 1 → startRound()
  return room;
}

const round = (room: Room) => (room as any).round;
const toAct = (room: Room): Seat => round(room).toAct;
// Invariant: chips never appear or vanish. Stacks + live pot + carry == 70.
const total = (room: Room) =>
  room.players[0]!.chips + room.players[1]!.chips + (round(room)?.pot ?? 0) + room.carry;

function assertNoLeak(room: Room) {
  for (const seat of [0, 1] as const) {
    const v = viewFor(room, seat) as any;
    if (v.opp) assert.ok(!('hole' in v.opp), 'opponent hole cards must never be sent');
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('a fresh game posts blinds and starts betting round 1', () => {
  const room = newGame();
  assert.equal(room.phase, 'bet1');
  assert.equal(round(room).pot, 2); // two 1-chip blinds
  assert.equal(room.players[0]!.chips, 34);
  assert.equal(room.players[1]!.chips, 34);
  assert.equal(total(room), 70);
});

test('a third player is rejected as full', () => {
  const room = newGame();
  const r = join(room, undefined, 'Carol');
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Betting
// ---------------------------------------------------------------------------

test('check-check ends a betting round and deals the 3rd card', () => {
  const room = newGame();
  assert.equal(bet(room, toAct(room), 'check').error, undefined);
  assert.equal(room.phase, 'bet1'); // first check, action passes
  assert.equal(bet(room, toAct(room), 'check').error, undefined);
  assert.equal(room.phase, 'reveal'); // second check closes the round
  assert.equal(round(room).holes[0].length, 3);
  assert.equal(total(room), 70);
});

test('raise then call matches bets and advances', () => {
  const room = newGame();
  const a = toAct(room);
  assert.equal(bet(room, a, 'raise', 4).error, undefined); // puts 4 in
  const b = toAct(room);
  assert.equal(b, 1 - a);
  assert.equal(bet(room, b, 'call').error, undefined);
  assert.equal(room.phase, 'reveal');
  assert.equal(round(room).pot, 10); // 2 blinds + 4 + 4
  assert.equal(room.players[a]!.chips, 30);
  assert.equal(room.players[b]!.chips, 30);
  assert.equal(total(room), 70);
});

test('folding awards the whole pot to the other player', () => {
  const room = newGame();
  const a = toAct(room);
  bet(room, a, 'raise', 5);
  const b = toAct(room);
  assert.equal(bet(room, b, 'fold').error, undefined);
  assert.equal(room.phase, 'showdown');
  const res = round(room).result;
  assert.equal(res.kind, 'fold');
  assert.equal(res.winner, a);
  assert.equal(room.players[a]!.chips, 36); // 34 − 5 + 7 pot
  assert.equal(room.players[b]!.chips, 34);
  assert.equal(round(room).pot, 0);
  assert.equal(total(room), 70);
});

test('checking is illegal when facing a bet; calling is required', () => {
  const room = newGame();
  const a = toAct(room);
  bet(room, a, 'raise', 3);
  const b = toAct(room);
  assert.match(bet(room, b, 'check').error!, /cannot check/i);
});

test('an all-in call for less refunds the uncalled chips', () => {
  const room = newGame();
  const a = toAct(room);
  const b = (1 - a) as Seat;
  // Force a short stack on the caller so the raise cannot be fully matched.
  room.players[a]!.chips = 10;
  room.players[b]!.chips = 3;
  bet(room, a, 'raise', 8); // a commits 8 (chips 10→2), pot 2+8=10
  assert.equal(bet(room, b, 'call').error, undefined); // b all-in for 3 of the 8
  assert.equal(room.players[b]!.chips, 0);
  assert.equal(room.players[a]!.chips, 7); // 2 + 5 refunded
  assert.equal(round(room).pot, 8); // 2 blinds + 3 + 3
  assert.equal(room.phase, 'reveal');
});

// ---------------------------------------------------------------------------
// Step 6 — simultaneous reveal buffering
// ---------------------------------------------------------------------------

test('a revealed card is withheld until BOTH players have locked in', () => {
  const room = newGame();
  bet(room, toAct(room), 'check');
  bet(room, toAct(room), 'check'); // → reveal phase
  const idx0 = (viewFor(room, 0) as any).you.hole.findIndex((c: any) => c.suit !== 'liar');
  assert.equal(reveal(room, 0, idx0).error, undefined);

  // Only seat 0 has revealed: nobody sees a card yet, but seat 1 sees it's locked.
  assert.equal((viewFor(room, 1) as any).opp.revealedCard, null);
  assert.equal((viewFor(room, 1) as any).reveal.oppLocked, true);
  assert.equal((viewFor(room, 0) as any).reveal.youLocked, true);

  const idx1 = (viewFor(room, 1) as any).you.hole.findIndex((c: any) => c.suit !== 'liar');
  reveal(room, 1, idx1);
  // Now both cards are exposed and we move to discussion.
  assert.notEqual((viewFor(room, 0) as any).opp.revealedCard, null);
  assert.notEqual((viewFor(room, 1) as any).opp.revealedCard, null);
  assert.equal(room.phase, 'discuss');
});

test('the liar can never be revealed at step 6', () => {
  const room = newGame();
  bet(room, toAct(room), 'check');
  bet(room, toAct(room), 'check');
  const c = (suit: string, id: number) => ({ suit, id });
  round(room).holes[0] = [c('liar', 1), c('rock', 2), c('paper', 3)];
  assert.match(reveal(room, 0, 0).error!, /cannot reveal the liar/i);
  assert.equal(reveal(room, 0, 1).error, undefined); // a non-liar card is fine
});

test('a malformed reveal index is rejected, not crashing', () => {
  const room = newGame();
  bet(room, toAct(room), 'check');
  bet(room, toAct(room), 'check');
  assert.match(reveal(room, 0, NaN).error!, /bad card/i);
  assert.match(reveal(room, 0, 99).error!, /bad card/i);
});

// ---------------------------------------------------------------------------
// Showdown, draw carry, next round
// ---------------------------------------------------------------------------

test('a draw carries the pot into the next round', () => {
  const room = newGame();
  bet(room, toAct(room), 'check');
  bet(room, toAct(room), 'check'); // → reveal, 3 cards each

  // Force identical, liar-free hands so the showdown is a guaranteed draw.
  const c = (suit: string, id: number) => ({ suit, id });
  round(room).holes[0] = [c('rock', 1), c('paper', 2), c('scissor', 3)];
  round(room).holes[1] = [c('rock', 4), c('paper', 5), c('scissor', 6)];
  round(room).shared = c('rock', 7);

  reveal(room, 0, 0);
  reveal(room, 1, 0); // → discuss
  discussDone(room, 0);
  discussDone(room, 1); // → bet2
  bet(room, toAct(room), 'check');
  bet(room, toAct(room), 'check'); // → showdown

  const res = round(room).result;
  assert.equal(res.kind, 'draw');
  assert.equal(res.winner, null);
  assert.equal(room.carry, 2); // the pot carries
  assert.equal(round(room).pot, 0);
  assert.equal(total(room), 70);

  nextRound(room, 0);
  assert.equal(room.phase, 'bet1');
  assert.equal(room.carry, 0);
  assert.equal(round(room).pot, 4); // 2 carried + 2 new blinds
  assert.equal(total(room), 70);
});

// ---------------------------------------------------------------------------
// Finite persistent deck
// ---------------------------------------------------------------------------

// Drive a round to its showdown result without advancing to the next round.
function toShowdown(room: Room) {
  let guard = 0;
  while (room.phase !== 'showdown' && room.phase !== 'matchover' && guard++ < 1000) {
    if (room.phase === 'bet1' || room.phase === 'bet2') bet(room, toAct(room), 'check');
    else if (room.phase === 'reveal') {
      for (const s of [0, 1] as const) {
        const v = viewFor(room, s) as any;
        if (v.reveal && !v.reveal.youLocked) reveal(room, s, v.you.hole.findIndex((c: any) => c.suit !== 'liar'));
      }
    } else if (room.phase === 'discuss') {
      discussDone(room, 0);
      discussDone(room, 1);
    }
  }
  for (const s of [0, 1] as const) if ((viewFor(room, s) as any).liar?.needsYou) setLiar(room, s, { auto: true });
}

test('the deck persists across rounds — cards already played are not returned', () => {
  const room = newGame(5);
  assert.equal((viewFor(room, 0) as any).deckCount, 44); // 49 − 5 dealt at round start
  toShowdown(room); // step-5 deals 2 more → 42 remain
  assert.equal(room.deck.length, 42);
  nextRound(room, 0); // plenty left, so NOT reshuffled; deals 5 more
  assert.equal(room.deck.length, 37);
});

test('the deck reshuffles to a full 49 when it cannot deal a round', () => {
  const room = newGame(5);
  toShowdown(room);
  (room as any).deck = (room as any).deck.slice(0, 3); // starve it below 7
  nextRound(room, 0);
  assert.equal(room.phase, 'bet1');
  assert.equal(room.deck.length, 44); // reshuffled to 49, then dealt 5
});

// ---------------------------------------------------------------------------
// Whole-game autoplay invariants
// ---------------------------------------------------------------------------

// Generic bot: passive betting, reveal first non-liar, auto liar, ready up.
function step(room: Room, foldSeat: number | null) {
  switch (room.phase) {
    case 'bet1':
    case 'bet2': {
      const s = toAct(room);
      const v = viewFor(room, s) as any;
      if (s === foldSeat) bet(room, s, 'fold');
      else if (v.betting.canCheck) bet(room, s, 'check');
      else bet(room, s, 'call');
      break;
    }
    case 'reveal':
      for (const s of [0, 1] as const) {
        const v = viewFor(room, s) as any;
        if (v.reveal && !v.reveal.youLocked) {
          reveal(room, s, v.you.hole.findIndex((c: any) => c.suit !== 'liar'));
        }
      }
      break;
    case 'discuss':
      discussDone(room, 0);
      discussDone(room, 1);
      break;
    case 'showdown':
      for (const s of [0, 1] as const) {
        if ((viewFor(room, s) as any).liar?.needsYou) setLiar(room, s, { auto: true });
      }
      if (round(room).result) nextRound(room, 0);
      break;
  }
}

test('fold-bot game terminates with the non-folder winning, chips conserved', () => {
  const room = newGame(7);
  let guard = 0;
  while (room.phase !== 'matchover' && guard++ < 100000) {
    step(room, 1); // seat 1 always folds → loses a blind per round
    assert.equal(total(room), 70);
    assertNoLeak(room);
  }
  assert.equal(room.phase, 'matchover');
  assert.equal(room.matchWinner, 0);
  assert.ok(room.players[0]!.chips >= 1);
});

test('rematch requires both players and resets the match', () => {
  const room = newGame(7);
  let guard = 0;
  while (room.phase !== 'matchover' && guard++ < 100000) step(room, 1);
  assert.equal(room.phase, 'matchover');

  rematch(room, 0);
  assert.equal(room.phase, 'matchover', 'one opt-in is not enough');
  assert.equal((viewFor(room, 0) as any).rematch.youReady, true);

  rematch(room, 1);
  assert.equal(room.phase, 'bet1', 'both opted in → fresh match begins');
  assert.equal(room.matchWinner, null);
  assert.equal(room.players[0]!.chips + room.players[1]!.chips, 68); // 70 − 2 blinds
  assert.equal(total(room), 70);
});

test('passive showdown game terminates with a valid winner, chips conserved', () => {
  const room = newGame(42);
  let guard = 0;
  while (room.phase !== 'matchover' && guard++ < 500000) {
    step(room, null); // both play to showdown every round
    assert.equal(total(room), 70);
    assertNoLeak(room);
  }
  assert.equal(room.phase, 'matchover');
  assert.ok(room.matchWinner === 0 || room.matchWinner === 1);
  assert.ok(room.players[room.matchWinner!]!.chips >= 1);
});
