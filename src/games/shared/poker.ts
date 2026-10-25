// games/shared/poker.ts — a standard 52-card deck and Texas Hold'em hand ranking, shared
// by the games that deal real playing cards (Texas Hold'em, Half a Game).
//
// A card is a number 0..51: rank = card % 13 (0 is a two, 12 an ace), suit = card / 13
// (clubs, diamonds, hearts, spades). It travels to clients as a two-letter code such as
// "Ah" or "Td", so the client never needs this numbering.
//
// A hand's strength is one integer — higher is better — so comparing hands is comparing
// numbers: the category in the top bits, then up to five ranks as tie-breakers, most
// significant first. The bots score thousands of random boards a decision with it, which
// is why it counts ranks into bitmasks rather than sorting card objects.

import type { Rng } from '../../platform/types.ts';

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export const rankOf = (card: number) => card % 13;
export const suitOf = (card: number) => (card / 13) | 0;
export const code = (card: number) => RANKS[rankOf(card)] + SUITS[suitOf(card)];
export function parse(text: string): number {
  const r = RANKS.indexOf(text[0]);
  const s = SUITS.indexOf(text[1]);
  if (r < 0 || s < 0 || text.length !== 2) throw new Error(`not a card: ${text}`);
  return s * 13 + r;
}

/** A freshly shuffled deck (Fisher–Yates on the injected rng). Draw from the end. */
export function shuffledDeck(rng: Rng): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export const HIGH_CARD = 0;
export const PAIR = 1;
export const TWO_PAIR = 2;
export const TRIPS = 3;
export const STRAIGHT = 4;
export const FLUSH = 5;
export const FULL_HOUSE = 6;
export const QUADS = 7;
export const STRAIGHT_FLUSH = 8;

export const CATEGORY_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush',
];

const pack = (category: number, ranks: number[]) => {
  let v = category;
  for (let i = 0; i < 5; i++) v = v * 16 + (ranks[i] ?? 0);
  return v;
};
export const categoryOf = (score: number) => Math.floor(score / 16 ** 5);

/** The highest straight in a 13-bit rank mask, as its top rank (3 for the five-high
 *  wheel, A-2-3-4-5), or -1 for none. */
function straightTop(mask: number): number {
  const m = (mask << 1) | ((mask >> 12) & 1); // the ace also plays low, as bit 0
  for (let top = 13; top >= 4; top--) if (((m >> (top - 4)) & 0x1f) === 0x1f) return top - 1;
  return -1;
}

/** The highest `n` ranks set in a mask, best first. */
function topRanks(mask: number, n: number, skip = -1): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < n; r--) if (r !== skip && mask & (1 << r)) out.push(r);
  return out;
}

const counts = new Int8Array(13);
const suitMask = new Int32Array(4);
const suitCount = new Int8Array(4);

/** The strength of the best five-card hand among `n` cards (5 to 7) — higher is better. */
export function score(cards: ArrayLike<number>, n = cards.length): number {
  counts.fill(0);
  suitMask.fill(0);
  suitCount.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = c % 13;
    const s = (c / 13) | 0;
    counts[r]++;
    suitMask[s] |= 1 << r;
    suitCount[s]++;
    rankMask |= 1 << r;
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCount[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    const top = straightTop(suitMask[flushSuit]);
    if (top >= 0) return pack(STRAIGHT_FLUSH, [top]);
  }

  let quad = -1;
  let trips = -1;
  let trips2 = -1;
  let pair = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const k = counts[r];
    if (k === 4) quad = r;
    else if (k === 3) {
      if (trips < 0) trips = r;
      else if (trips2 < 0) trips2 = r;
    } else if (k === 2) {
      if (pair < 0) pair = r;
      else if (pair2 < 0) pair2 = r;
    }
  }

  if (quad >= 0) return pack(QUADS, [quad, ...topRanks(rankMask, 1, quad)]);
  if (trips >= 0 && (trips2 >= 0 || pair >= 0)) {
    // A second set of trips plays as the pair, when it outranks the best pair.
    const with2 = Math.max(trips2, pair);
    return pack(FULL_HOUSE, [trips, with2]);
  }
  if (flushSuit >= 0) return pack(FLUSH, topRanks(suitMask[flushSuit], 5));
  const top = straightTop(rankMask);
  if (top >= 0) return pack(STRAIGHT, [top]);
  if (trips >= 0) return pack(TRIPS, [trips, ...topRanks(rankMask & ~(1 << trips), 2)]);
  if (pair >= 0 && pair2 >= 0) {
    const kicker = topRanks(rankMask & ~(1 << pair) & ~(1 << pair2), 1);
    return pack(TWO_PAIR, [pair, pair2, ...kicker]);
  }
  if (pair >= 0) return pack(PAIR, [pair, ...topRanks(rankMask & ~(1 << pair), 3)]);
  return pack(HIGH_CARD, topRanks(rankMask, 5));
}

const RANK_WORDS = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

/** "Pair of Kings", "Queens full of Fives", "Ace-high flush" — what a player calls it. */
export function describe(s: number): string {
  const cat = categoryOf(s);
  const r = (i: number) => Math.floor(s / 16 ** (4 - i)) % 16;
  switch (cat) {
    case STRAIGHT_FLUSH: return r(0) === 12 ? 'Royal flush' : `${RANK_WORDS[r(0)]}-high straight flush`;
    case QUADS: return `Four ${PLURAL[r(0)]}`;
    case FULL_HOUSE: return `${PLURAL[r(0)]} full of ${PLURAL[r(1)]}`;
    case FLUSH: return `${RANK_WORDS[r(0)]}-high flush`;
    case STRAIGHT: return `${RANK_WORDS[r(0)]}-high straight`;
    case TRIPS: return `Three ${PLURAL[r(0)]}`;
    case TWO_PAIR: return `Two pair, ${PLURAL[r(0)]} and ${PLURAL[r(1)]}`;
    case PAIR: return `Pair of ${PLURAL[r(0)]}`;
    default: return `${RANK_WORDS[r(0)]} high`;
  }
}

/** The five cards that make the best hand, for highlighting at a showdown. */
export function bestFive(cards: number[]): number[] {
  const target = score(cards);
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
      if (score(five) === target) return five;
    }
  return cards.slice(0, 5);
}

/** Seats sharing the best score among those given. */
export function winnersOf(scores: Map<number, number>): number[] {
  let best = -1;
  for (const v of scores.values()) if (v > best) best = v;
  return [...scores].filter(([, v]) => v === best).map(([seat]) => seat);
}
