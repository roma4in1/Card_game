// bot.test.ts — the Texas Hold'em bots: they see only what their seat sees, play only
// legal moves, make the basic decisions right, adapt to a calling station, and each level
// beats the one below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { texasHoldem, type HState } from './game.ts';
import { chen, madeHand } from './bot.ts';
import { parse } from '../shared/poker.ts';

const seeded = (n: number) => { let a = n >>> 0; return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296); };
function newGame(n: number, seed = 1, options: Record<string, number> = {}): HState {
  const seats = Array.from({ length: n }, (_, i) => i);
  return texasHoldem.create({ seats, players: seats.map((seat) => ({ seat, name: 'P' + seat })), options: { blindsEvery: 0, ...options } }, { rng: seeded(seed), now: 0 }) as HState;
}
const cards = (text: string) => text.split(' ').map(parse);
const decide = (s: HState, skill: number, seed = 7) => {
  s.skill = skill;
  return texasHoldem.bot!(s, s.hand!.toAct, { rng: seeded(seed), now: 0 }) as { action: string; to?: number };
};
const play = (s: HState, seat: number, action: string, to?: number) => {
  const res = texasHoldem.act(s, seat, { type: 'action', action, to }, { rng: seeded(1), now: 0 }) ?? {};
  assert.equal(res.error, undefined);
};

test('a bot decides from what its seat can see — nobody else’s cards, not the deck', () => {
  for (const skill of [1, 2, 3]) {
    for (let seed = 1; seed <= 6; seed++) {
      const s = newGame(4, seed);
      const seat = s.hand!.toAct;
      const before = JSON.stringify(decide(s, skill, seed));
      // Shuffle every card the bot cannot see — other hands and the deck — and ask again.
      const hidden = [...s.hand!.deck, ...s.hand!.participants.filter((x) => x !== seat).flatMap((x) => s.players[x]!.hole)];
      const rng = seeded(seed * 99);
      for (let i = hidden.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [hidden[i], hidden[j]] = [hidden[j], hidden[i]]; }
      for (const x of s.hand!.participants) if (x !== seat) s.players[x]!.hole = hidden.splice(0, 2);
      s.hand!.deck = hidden;
      assert.equal(JSON.stringify(decide(s, skill, seed)), before, `skill ${skill}, seed ${seed}`);
    }
  }
});

test('every level plays only legal moves, at every table size, mixed together', () => {
  for (const n of [2, 3, 6, 8]) {
    const s = newGame(n, n * 13, { stack: 500, blindsEvery: 5 });
    const rng = seeded(n);
    for (let step = 0; step < 4000 && !s.over; step++) {
      const h = s.hand!;
      if (h.result) { texasHoldem.act(s, 0, { type: 'nextHand' }, { rng, now: 0 }); continue; }
      const seat = h.toAct;
      s.skill = 1 + (seat % 3);
      const mv = texasHoldem.bot!(s, seat, { rng, now: 0 });
      assert.ok(mv, `${n} players: the seat to act always has a move`);
      assert.equal((texasHoldem.act(s, seat, mv!, { rng, now: 0 }) ?? {}).error, undefined, `${n} players: ${JSON.stringify(mv)}`);
    }
  }
});

test('Sharp never folds aces before the flop, and folds seven-deuce to a big raise', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const s = newGame(3, seed);
    const first = s.hand!.toAct;
    s.players[first]!.hole = cards('Ah Ad');
    assert.notEqual(decide(s, 3, seed).action, 'fold', 'aces open');

    const t = newGame(3, seed);
    const raiser = t.hand!.toAct;
    play(t, raiser, 'raise', 200); // a raise to ten big blinds
    t.players[t.hand!.toAct]!.hole = cards('7c 2d');
    assert.equal(decide(t, 3, seed).action, 'fold', 'seven-deuce folds');
  }
});

test('short-stacked, Sharp goes all-in with a good hand and folds a bad one', () => {
  const short = (hole: string) => {
    const s = newGame(2, 3);
    const seat = s.hand!.toAct;
    s.players[seat]!.chips = 180 - s.players[seat]!.committed; // nine big blinds in all
    s.players[seat]!.hole = cards(hole);
    return decide(s, 3).action;
  };
  assert.equal(short('Ks Qs'), 'allin');
  assert.equal(short('8c 3d'), 'fold');
});

test('Sharp spots a calling station and all but stops bluffing it', () => {
  // Heads-up on the flop, Sharp raised before it and has missed completely: a spot where it
  // normally fires a continuation bet about half the time.
  const bluffs = (station: boolean) => {
    let bets = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = newGame(2, 5);
      const sharp = s.hand!.toAct; // the dealer, first to act heads-up
      const other = 1 - sharp;
      play(s, sharp, 'raise', 60);
      play(s, other, 'call');
      s.players[sharp]!.hole = cards('Kc Qd');
      s.hand!.board = cards('2s 7h 9h');
      s.players[other]!.stats = station
        ? { hands: 40, vpip: 34, pfr: 1, faced: 30, folded: 3, aggressive: 2, passive: 25 }
        : { hands: 40, vpip: 12, pfr: 8, faced: 30, folded: 18, aggressive: 10, passive: 6 };
      if (s.hand!.toAct !== sharp) play(s, other, 'check');
      const mv = decide(s, 3, seed);
      if (mv.action === 'raise' || mv.action === 'allin') bets++;
    }
    return bets;
  };
  const normal = bluffs(false);
  const station = bluffs(true);
  assert.ok(normal >= 20, `bluffs an ordinary player (${normal} of 60)`);
  assert.ok(station <= normal / 2, `but a calling station far less (${station} against ${normal})`);
});

test('each level beats the one below over the same deals, seats swapped', () => {
  // Heads-up, stacks reset every hand; every deal played twice so the cards cancel out.
  const edge = (a: number, b: number, pairs: number) => {
    let net = 0;
    for (let i = 0; i < pairs; i++) {
      for (const flip of [0, 1]) {
        const deck = seeded(i * 104729 + 3);
        const bots = seeded(i * 7919 + flip * 31 + 1);
        const s = texasHoldem.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }], options: { blindsEvery: 0 } }, { rng: deck, now: 0 }) as HState;
        while (!s.hand!.result) {
          const seat = s.hand!.toAct;
          s.skill = seat === flip ? a : b;
          texasHoldem.act(s, seat, texasHoldem.bot!(s, seat, { rng: bots, now: 0 })!, { rng: deck, now: 0 });
        }
        net += (s.hand!.result.awards.find((x) => x.seat === flip)?.amount ?? 0) - s.players[flip]!.contributed;
      }
    }
    return net;
  };
  assert.ok(edge(2, 1, 400) > 0, 'Steady beats Casual');
  assert.ok(edge(3, 2, 400) > 0, 'Sharp beats Steady');
});

test('the starting-hand score and the hand reader agree with a player’s eye', () => {
  assert.equal(chen(parse('Ah'), parse('Ad')), 20);
  assert.equal(chen(parse('Ah'), parse('Kh')), 12);
  assert.ok(chen(parse('7c'), parse('2d')) <= 0);
  assert.equal(madeHand(cards('Ah Kd'), cards('Ks 7c 2d')), 'strong', 'top pair, ace kicker');
  assert.equal(madeHand(cards('9h 9d'), cards('Ks 7c 2d')), 'medium', 'a pair under the top card');
  assert.equal(madeHand(cards('7h 7d'), cards('Ks 7c 2d')), 'monster', 'a set');
  assert.equal(madeHand(cards('Ah Qd'), cards('Ks Kc 2d')), 'none', 'the pair is all board');
});
