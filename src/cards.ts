// cards.ts — deck construction, shuffling, and liar resolution helpers.
import { compare, evaluate, type Suit } from './evaluator.ts';

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

import { randomInt } from 'node:crypto';

/** Default randomness source: unbiased crypto, scaled to [0, 1). */
export function secureRandom(): number {
  return randomInt(0, 2 ** 30) / 2 ** 30;
}

/**
 * In-place Fisher–Yates shuffle. `rng` returns a float in [0, 1); it defaults to
 * crypto-grade randomness but can be injected for deterministic tests.
 */
export function shuffle<T>(arr: T[], rng: () => number = secureRandom): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export const ALL_VALUES: Suit[] = ['rock', 'paper', 'scissor', 'love'];

/**
 * Resolve a player's liar (wild) slots to their best assignment.
 *
 * The round is decided by `compare(me, opponent)`, NOT by my rank in isolation,
 * so when the opponent's resolved hand is known we use the **win-max** strategy:
 * pick any assignment that BEATS the opponent (preferring the strongest such),
 * and only fall back to the strongest-by-rank hand when no assignment can win.
 *
 * Under the current ruleset these two strategies happen to coincide (because
 * `love` is a legal wild value, the strongest-by-rank hand is always uniquely
 * achievable, so the cyclic RPS tiebreak never splits two same-rank options —
 * see liar.test.ts). We still resolve opponent-aware so the logic stays correct
 * if the ruleset ever changes (e.g. if the liar could not become a love).
 *
 * `baseSuits` holds the concrete suit at every slot (wild slots carry a
 * placeholder); `wildSlots` lists the slot indices to assign. When `oppHand` is
 * omitted we return the strongest-by-rank hand.
 */
export function bestResolution(
  baseSuits: Suit[],
  wildSlots: number[],
  oppHand?: Suit[],
): { resolved: Suit[]; chosen: Suit[] } {
  if (wildSlots.length === 0) {
    return { resolved: [...baseSuits], chosen: [] };
  }
  let rankBest: { hand: Suit[]; rank: number } | null = null; // strongest in isolation
  let winBest: { hand: Suit[]; rank: number } | null = null; // strongest that still beats opp
  for (const combo of enumerate(wildSlots.length)) {
    const trial = [...baseSuits];
    wildSlots.forEach((slot, i) => (trial[slot] = combo[i]));
    const rank = evaluate(trial).rank;
    if (rankBest === null || rank < rankBest.rank) rankBest = { hand: trial, rank };
    if (oppHand && compare(trial, oppHand) > 0 && (winBest === null || rank < winBest.rank)) {
      winBest = { hand: trial, rank };
    }
  }
  const resolved = (winBest ?? rankBest!).hand;
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
