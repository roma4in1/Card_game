// game.test.ts — Memory Match. Covers the WORD↔IMAGE match rule, the secrecy + language
// dual redaction, deck build, the timed flip-back, and win/tie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMatch, type MMConcept, type MMState } from './game.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
const bank = (n = 15): MMConcept[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, emoji: 'E' + i, en: 'en' + i, fr: 'fr' + i, ko: 'ko' + i }));
function newMM(np: number, pairs = 12, seed = 1, b = bank()) {
  const def = createMemoryMatch(b, { pairs });
  const s = def.create({ seats: Array.from({ length: np }, (_, i) => i), players: Array.from({ length: np }, (_, i) => ({ seat: i, name: 'P' + i })) }, { rng: lcg(seed), now: 0 }) as MMState;
  return { def, s };
}
const act = (def: any, s: MMState, seat: number, msg: Record<string, unknown>, now = 0) => def.act(s, seat, msg, { rng: lcg(1), now }) ?? {};
const view = (def: any, s: MMState, seat: number) => def.view(s, seat) as any;
// Lay out a deterministic board: each conceptId becomes word,image at consecutive positions.
function setBoard(s: MMState, conceptIds: number[]) {
  s.cards = [];
  for (const id of conceptIds) {
    s.cards.push({ conceptId: id, side: 'word', faceUp: false, matchedBy: null });
    s.cards.push({ conceptId: id, side: 'image', faceUp: false, matchedBy: null });
  }
  s.pairsTotal = conceptIds.length;
  s.pairsLeft = conceptIds.length;
}

// ---------------------------------------------------------------------------
// Deck build
// ---------------------------------------------------------------------------

test('deck has `pairs` concepts × 2 cards (one word + one image each), shuffled, clamped 10–20', () => {
  const { s } = newMM(2, 12);
  assert.equal(s.cards.length, 24);
  assert.equal(s.pairsTotal, 12);
  const sides: Record<number, { word: number; image: number }> = {};
  for (const c of s.cards) (sides[c.conceptId] ??= { word: 0, image: 0 })[c.side]++;
  const ids = Object.keys(sides);
  assert.equal(ids.length, 12, '12 distinct concepts');
  for (const id of ids) assert.deepEqual(sides[+id], { word: 1, image: 1 }, 'exactly one word + one image');
  // clamp: below 10 → 10; above 20 (and bank size) → min
  assert.equal((newMM(2, 4).s.pairsTotal), 10);
  assert.equal((newMM(2, 30).s.pairsTotal), 15, 'capped by the 15-concept bank');
});

// ---------------------------------------------------------------------------
// Match rule
// ---------------------------------------------------------------------------

test('word+image of the same concept matches: stays up, scores, same player goes again', () => {
  const { def, s } = newMM(2);
  setBoard(s, [1, 2, 3]); // 0:w1 1:i1 2:w2 3:i2 4:w3 5:i3
  s.turn = 0;
  act(def, s, 0, { type: 'flipCard', cardId: 0 });
  act(def, s, 0, { type: 'flipCard', cardId: 1 });
  assert.equal(s.scores[0], 1);
  assert.equal(s.cards[0].matchedBy, 0);
  assert.equal(s.cards[1].matchedBy, 0);
  assert.ok(s.cards[0].faceUp && s.cards[1].faceUp, 'matched cards stay up');
  assert.equal(s.turn, 0, 'matcher goes again');
  assert.equal(s.phase, 'play');
});

test('a miss flips both back and passes the turn — after the reveal delay (tick)', () => {
  const { def, s } = newMM(2);
  setBoard(s, [1, 2]); // 0:w1 1:i1 2:w2 3:i2
  s.turn = 0;
  act(def, s, 0, { type: 'flipCard', cardId: 0 }, 0); // w1
  act(def, s, 0, { type: 'flipCard', cardId: 2 }, 0); // w2 — different concept → miss
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(s.peek.sort(), [0, 2]);
  assert.ok(s.cards[0].faceUp && s.cards[2].faceUp, 'both shown during the reveal');
  assert.match(act(def, s, 1, { type: 'flipCard', cardId: 1 }).error!, /flip back/i, 'no flips during the reveal');
  // a tick before the deadline does nothing
  assert.equal(def.tick(s, { rng: lcg(1), now: 100 }), false);
  // after the deadline, both flip down and play passes
  assert.equal(def.tick(s, { rng: lcg(1), now: 9999 }), true);
  assert.equal(s.cards[0].faceUp, false);
  assert.equal(s.cards[2].faceUp, false);
  assert.equal(s.turn, 1, 'turn passed to the next player');
  assert.equal(s.phase, 'play');
});

test('word+word and image+image never match (even forced to the same concept)', () => {
  const { def, s } = newMM(2);
  s.cards = [
    { conceptId: 1, side: 'word', faceUp: false, matchedBy: null },
    { conceptId: 1, side: 'word', faceUp: false, matchedBy: null }, // same concept, same side
  ];
  s.pairsTotal = 1;
  s.pairsLeft = 1;
  s.turn = 0;
  act(def, s, 0, { type: 'flipCard', cardId: 0 });
  act(def, s, 0, { type: 'flipCard', cardId: 1 });
  assert.equal(s.scores[0], 0, 'same side → no match');
  assert.equal(s.phase, 'reveal');
});

test('cannot reflip a face-up or matched card', () => {
  const { def, s } = newMM(2);
  setBoard(s, [1, 2]);
  s.turn = 0;
  act(def, s, 0, { type: 'flipCard', cardId: 0 });
  assert.match(act(def, s, 0, { type: 'flipCard', cardId: 0 }).error!, /already face-up/i);
});

// ---------------------------------------------------------------------------
// Redaction: secrecy + language
// ---------------------------------------------------------------------------

test('face-down cards never leak their concept; only flipped/matched cards reveal it', () => {
  const { def, s } = newMM(2);
  setBoard(s, [1, 2, 3]);
  s.turn = 0;
  let v = view(def, s, 0);
  for (const c of v.cards) {
    assert.ok(c.side === 'word' || c.side === 'image', 'side is public');
    assert.ok(!('conceptId' in c) && !('text' in c) && !('emoji' in c), 'face-down concept hidden');
  }
  // flip one → only that one reveals
  act(def, s, 0, { type: 'flipCard', cardId: 0 });
  v = view(def, s, 0);
  assert.equal(v.cards[0].conceptId, 1, 'flipped card reveals its concept');
  for (let i = 1; i < v.cards.length; i++) assert.ok(!('conceptId' in v.cards[i]), `card ${i} stays hidden`);
});

test('the same word card localizes per viewer; images are identical across languages', () => {
  const { def, s } = newMM(2);
  setBoard(s, [1]); // 0:w1 1:i1
  s.turn = 0;
  act(def, s, 1, { type: 'setLanguage', lang: 'fr' }); // P1 → French (allowed off-turn)
  act(def, s, 0, { type: 'flipCard', cardId: 0 });
  act(def, s, 0, { type: 'flipCard', cardId: 1 }); // match → both stay up & revealed
  const vEn = view(def, s, 0); // P0 default English
  const vFr = view(def, s, 1);
  assert.equal(vEn.cards[0].text, 'en0');
  assert.equal(vFr.cards[0].text, 'fr0', 'same word card, different language');
  assert.equal(vEn.cards[1].emoji, 'E0');
  assert.equal(vFr.cards[1].emoji, 'E0', 'image identical across languages');
  assert.equal(vEn.cards[0].faceUp, vFr.cards[0].faceUp, 'face-up state identical');
});

// ---------------------------------------------------------------------------
// Win / tie
// ---------------------------------------------------------------------------

test('clearing the board ends the game; most pairs wins, equal pairs share', () => {
  // single winner
  let g = newMM(2);
  setBoard(g.s, [1, 2]);
  g.s.turn = 0;
  act(g.def, g.s, 0, { type: 'flipCard', cardId: 0 });
  act(g.def, g.s, 0, { type: 'flipCard', cardId: 1 }); // match c1, go again
  act(g.def, g.s, 0, { type: 'flipCard', cardId: 2 });
  act(g.def, g.s, 0, { type: 'flipCard', cardId: 3 }); // match c2 → board clear
  assert.equal(g.s.over, true);
  assert.deepEqual(g.def.result(g.s).winners, [0]);

  // tie → shared
  g = newMM(2);
  setBoard(g.s, [1]);
  g.s.scores = [1, 2];
  g.s.turn = 0;
  act(g.def, g.s, 0, { type: 'flipCard', cardId: 0 });
  act(g.def, g.s, 0, { type: 'flipCard', cardId: 1 }); // P0 → 2, ties P1
  assert.equal(g.s.over, true);
  assert.deepEqual(g.def.result(g.s).winners.sort(), [0, 1], 'shared victory');
});

// ---------------------------------------------------------------------------
// Full autoplay via the bot (+ ticks for the reveal)
// ---------------------------------------------------------------------------

test('a full match plays to completion via the bot', () => {
  const { def, s } = newMM(3, 10, 42);
  const rng = lcg(99); // one continuous stream, like the real bot driver
  let now = 0;
  let guard = 0;
  while (!s.over && guard++ < 100000) {
    if (s.phase === 'reveal') {
      now = s.flipBackAt + 1;
      def.tick(s, { rng, now });
      continue;
    }
    const seat = s.order[s.turn];
    const mv = def.bot(s, seat, { rng, now });
    if (!mv) break;
    def.act(s, seat, mv, { rng, now });
  }
  assert.equal(s.over, true);
  assert.ok(def.result(s).winners.length >= 1);
  assert.ok(s.cards.every((c) => c.matchedBy !== null), 'every card matched');
});
