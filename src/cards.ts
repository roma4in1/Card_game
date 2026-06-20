// cards.ts — deck construction, shuffling, and liar resolution helpers.
import { compare, type Suit } from './evaluator.ts';

export type FullSuit = Suit | 'liar';

export interface Card {
  id: number;
  suit: FullSuit;
}

// Deck of 49: 18 scissor, 12 rock, 12 paper, 6 love, 1 liar.
const DECK_SPEC: [FullSuit, number][] = [
  ['scissor', 18],
  ['rock', 12],
  ['paper', 12],
  ['love', 6],
  ['liar', 1],
];

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  let id = 0;
  for (const [suit, n] of DECK_SPEC) {
    for (let i = 0; i < n; i++) deck.push({ id: id++, suit });
  }
  return deck;
}

/** In-place Fisher–Yates shuffle using crypto-grade randomness. */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(secureRandom() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

import { randomInt } from 'node:crypto';
function secureRandom(): number {
  // randomInt is unbiased; scale to [0,1).
  return randomInt(0, 2 ** 30) / 2 ** 30;
}

export const ALL_VALUES: Suit[] = ['rock', 'paper', 'scissor', 'love'];

/**
 * Given a player's 4 cards (3 hole + 1 shared) where some slots are "wild"
 * (a liar they control), enumerate every assignment of concrete suits to the
 * wild slots and return the one yielding the strongest hand.
 *
 * `cards` is the concrete suit at each slot for non-wild slots; wild slots are
 * marked by index in `wildSlots`. Returns the resolved 4 suits and the suits
 * chosen for the wild slots (in slot order).
 */
export function bestResolution(
  baseSuits: Suit[],
  wildSlots: number[],
): { resolved: Suit[]; chosen: Suit[] } {
  if (wildSlots.length === 0) {
    return { resolved: [...baseSuits], chosen: [] };
  }
  let best: Suit[] | null = null;
  const combos = enumerate(wildSlots.length);
  for (const combo of combos) {
    const trial = [...baseSuits];
    wildSlots.forEach((slot, i) => (trial[slot] = combo[i]));
    if (best === null || compare(trial, best) === 1) {
      best = trial;
    }
  }
  const resolved = best as Suit[];
  return { resolved, chosen: wildSlots.map((s) => resolved[s]) };
}

function enumerate(k: number): Suit[][] {
  if (k === 0) return [[]];
  const rest = enumerate(k - 1);
  const out: Suit[][] = [];
  for (const v of ALL_VALUES) {
    for (const r of rest) out.push([v, ...r]);
  }
  return out;
}
