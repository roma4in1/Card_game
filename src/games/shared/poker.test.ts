// poker.test.ts — the deck and the hand ranking that Texas Hold'em and Half a Game share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, describe, bestFive, categoryOf, code, parse, shuffledDeck, winnersOf, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE, QUADS, STRAIGHT_FLUSH, HIGH_CARD } from './poker.ts';

const hand = (text: string) => text.split(' ').map(parse);
const s = (text: string) => score(hand(text));

test('cards round-trip through their two-letter codes', () => {
  for (let c = 0; c < 52; c++) assert.equal(parse(code(c)), c);
  assert.equal(code(parse('Ah')), 'Ah');
  assert.throws(() => parse('Xx'));
});

test('a shuffled deck holds each card exactly once', () => {
  let a = 7;
  const deck = shuffledDeck(() => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648));
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
});

test('every category is recognised from seven cards', () => {
  const cases: [string, number][] = [
    ['As Ks Qs Js Ts 2d 3c', STRAIGHT_FLUSH],
    ['9h 9d 9s 9c Kd 2c 3s', QUADS],
    ['Qh Qd Qs 5c 5d 2c 3s', FULL_HOUSE],
    ['Ah 9h 6h 3h 2h Kd Kc', FLUSH],
    ['5c 6d 7h 8s 9c Kd Ks', STRAIGHT],
    ['7c 7d 7h As Kc 2d 3s', TRIPS],
    ['Jc Jd 4h 4s Ac 2d 3s', TWO_PAIR],
    ['Tc Td 4h 8s Ac 2d 3s', PAIR],
    ['Ac Kd 9h 7s 4c 3d 2s', HIGH_CARD],
  ];
  for (const [cards, cat] of cases) assert.equal(categoryOf(s(cards)), cat, cards);
});

test('the ace plays low in the wheel, and the wheel is the lowest straight', () => {
  assert.equal(categoryOf(s('Ac 2d 3h 4s 5c Kd 9s')), STRAIGHT);
  assert.equal(describe(s('Ac 2d 3h 4s 5c Kd 9s')), 'Five-high straight');
  assert.ok(s('2c 3d 4h 5s 6c Kd 9s') > s('Ac 2d 3h 4s 5c Kd 9s'), 'six-high beats the wheel');
  assert.equal(describe(s('Ah 2h 3h 4h 5h Kd 9s')), 'Five-high straight flush');
  assert.equal(describe(s('Ah Kh Qh Jh Th 2d 9s')), 'Royal flush');
});

test('hands of one category are separated by their kickers', () => {
  assert.ok(s('Ac Ad Kh 7s 4c 3d 2s') > s('Ac Ad Qh 7s 4c 3d 2s'), 'pair of aces, king kicker');
  assert.ok(s('Jc Jd 4h 4s Ac 2d 3s') > s('Jc Jd 4h 4s Kc 2d 3s'), 'two pair, ace kicker');
  assert.ok(s('Ah 9h 6h 3h 2h Kd Kc') > s('Ah 9h 5h 3h 2h Kd Kc'), 'flushes compared card by card');
  assert.equal(s('Ac Kd 9h 7s 4c 3d 2s'), s('Ad Kc 9s 7h 4d 2c 3h'), 'same ranks, different suits: a tie');
});

test('only the best five cards count', () => {
  // Three pairs: the lowest pair cannot play, but its rank can still be the kicker.
  assert.equal(describe(s('Kc Kd 8h 8s 5c 5d Qs')), 'Two pair, Kings and Eights');
  assert.ok(s('Kc Kd 8h 8s 5c 5d Qs') > s('Kc Kd 8h 8s 5c 5d 2s'), 'queen kicker beats a five');
  // Two sets of trips make a full house with the higher as the trips.
  assert.equal(describe(s('9c 9d 9h 4s 4c 4d As')), 'Nines full of Fours');
  // A full house beats a flush that is also on the board.
  assert.equal(categoryOf(s('Qh Qd Qs 5h 5d 2h 3h')), FULL_HOUSE);
  // A board straight is shared; a higher card on top of it decides nothing below six.
  assert.equal(categoryOf(s('5c 6d 7h 8s 9c 2d 3s')), STRAIGHT);
});

test('a hand is named the way a player would say it', () => {
  assert.equal(describe(s('Tc Td 4h 8s Ac 2d 3s')), 'Pair of Tens');
  assert.equal(describe(s('Qh Qd Qs 5c 5d 2c 3s')), 'Queens full of Fives');
  assert.equal(describe(s('9h 9d 9s 9c Kd 2c 3s')), 'Four Nines');
  assert.equal(describe(s('Ac Kd 9h 7s 4c 3d 2s')), 'Ace high');
  assert.equal(categoryOf(s('Ac Ad Kh 7s 4c')), PAIR, 'five cards work too');
});

test('the best five are picked out for the showdown', () => {
  const five = bestFive(hand('Kc Kd 8h 8s 5c 5d Qs')).map(code).sort();
  assert.deepEqual(five, ['8h', '8s', 'Kc', 'Kd', 'Qs'].sort());
});

test('a tie for the best hand shares the win', () => {
  const scores = new Map([[0, s('Ac Kd 9h 7s 4c 3d 2s')], [3, s('Ad Kc 9s 7h 4d 2c 3h')], [5, s('Qc Jd 9h 7s 4c 3d 2s')]]);
  assert.deepEqual(winnersOf(scores).sort(), [0, 3]);
});
