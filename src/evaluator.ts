// evaluator.ts — pure hand evaluation for "Love & Liar". No I/O.
//
// A hand is exactly 4 concrete suits. The liar card is resolved into a concrete
// suit BEFORE evaluation (the server picks the assignment), so the evaluator
// never sees a liar.
//
// Rank scale: 1 = strongest ... 9 = weakest.
//   1. 4 loves
//   2. 3 loves + 1 any
//   3. Quad (non-love)
//   4. 1 love + rock + paper + scissor   (the "one of each" exception)
//   5. 2 loves + 2 any non-love
//   6. Two pair (non-love)
//   7. Triple (non-love)
//   8. One pair (non-love)
//   9. 1 love + 3 non-love (anything EXCEPT rock+paper+scissor one-of-each)
//
// RPS is a CYCLE: rock>scissor, scissor>paper, paper>rock. There is no global
// strongest suit, so tiebreaks never use a linear suit order — only cyclic
// pairwise comparison of the cards that survive cancellation.

export type Suit = 'rock' | 'paper' | 'scissor' | 'love';

export interface Evaluation {
  rank: number; // 1 (strongest) .. 9 (weakest)
  name: string;
}

const RPS_BEATS: Record<string, string> = {
  rock: 'scissor',
  scissor: 'paper',
  paper: 'rock',
};

/** Cyclic RPS comparison of two single suits. 1 = a beats b, -1 = b beats a, 0 = same. */
function rpsCompare(a: string, b: string): 1 | -1 | 0 {
  if (a === b) return 0;
  return RPS_BEATS[a] === b ? 1 : -1;
}

/** Count occurrences of each suit. */
function counts(cards: Suit[]): Map<Suit, number> {
  const m = new Map<Suit, number>();
  for (const c of cards) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
}

function nonLoves(cards: Suit[]): Suit[] {
  return cards.filter((c) => c !== 'love');
}

// Official names from the physical "THE RISK TAKER" game.
const RANK_NAMES: Record<number, string> = {
  1: 'Love Wins All',
  2: 'Three Love',
  3: 'Four Card',
  4: 'Mix',
  5: 'Two Love',
  6: 'Two Pair',
  7: 'Triple',
  8: 'One Pair',
  9: 'One Love',
};

/**
 * Classify the 4 non-love cards (used only when there are 0 loves) into a base
 * rank by pure structure. With 4 cards drawn from 3 suits there is always at
 * least a pair, so "high card" never occurs here.
 */
function zeroLoveRank(nl: Suit[]): number {
  const cs = [...counts(nl).values()].sort((a, b) => b - a);
  if (cs[0] === 4) return 3; // quad
  if (cs[0] === 3) return 7; // triple
  if (cs[0] === 2 && cs[1] === 2) return 6; // two pair
  return 8; // one pair (2,1,1)
}

/** Evaluate a 4-card hand into a rank + human name. Pure. */
export function evaluate(cards: Suit[]): Evaluation {
  if (cards.length !== 4) {
    throw new Error(`a hand must be exactly 4 cards, got ${cards.length}`);
  }
  const loveCount = cards.filter((c) => c === 'love').length;
  const nl = nonLoves(cards);

  let rank: number;
  if (loveCount === 4) {
    rank = 1;
  } else if (loveCount === 3) {
    rank = 2;
  } else if (loveCount === 2) {
    rank = 5;
  } else if (loveCount === 1) {
    // Love presence dominates structure: only the literal one-of-each escapes
    // to rank 4. A love + a pair or a love + a triple is STILL rank 9.
    const c = counts(nl); // nl has exactly 3 cards
    const oneOfEach =
      c.get('rock') === 1 && c.get('paper') === 1 && c.get('scissor') === 1;
    rank = oneOfEach ? 4 : 9;
  } else {
    rank = zeroLoveRank(nl);
  }

  return { rank, name: RANK_NAMES[rank] };
}

// ---------------------------------------------------------------------------
// Tiebreak
// ---------------------------------------------------------------------------

// Sub-hierarchy used when two same-rank hands have differently-shaped non-love
// remainders: quad > two-pair > triple > pair > singles. NOTE this is a custom
// order (two-pair intentionally outranks triple) and is not the max-group-size
// order, so it must be encoded explicitly.
const SUB_QUAD = 5;
const SUB_TWO_PAIR = 4;
const SUB_TRIPLE = 3;
const SUB_PAIR = 2;
const SUB_SINGLES = 1;

function subStructure(nl: Suit[]): number {
  const cs = [...counts(nl).values()].sort((a, b) => b - a);
  if (cs[0] === 4) return SUB_QUAD;
  if (cs[0] === 3) return SUB_TRIPLE;
  if (cs[0] === 2) return cs[1] === 2 ? SUB_TWO_PAIR : SUB_PAIR;
  return SUB_SINGLES;
}

/** Multiset intersection removed from both sides; returns the survivors. */
function cancelCommon(a: Suit[], b: Suit[]): { sa: Suit[]; sb: Suit[] } {
  const ca = counts(a);
  const cb = counts(b);
  const sa: Suit[] = [];
  const sb: Suit[] = [];
  const allTypes = new Set<Suit>([...ca.keys(), ...cb.keys()]);
  for (const t of allTypes) {
    const na = ca.get(t) ?? 0;
    const nb = cb.get(t) ?? 0;
    const common = Math.min(na, nb);
    for (let i = 0; i < na - common; i++) sa.push(t);
    for (let i = 0; i < nb - common; i++) sb.push(t);
  }
  return { sa, sb };
}

function maxCount(c: Map<Suit, number>): number {
  let m = 0;
  for (const v of c.values()) m = Math.max(m, v);
  return m;
}

/**
 * Compare two equal-size non-love multisets by RPS structure.
 *
 * When one suit forms a strictly-dominant group (quad/triple/pair), that group
 * decides first by cyclic RPS; ties recurse on the remaining kickers. When the
 * top count is shared by several groups (two-pair / singles), common cards are
 * cancelled and the disjoint survivors — which are always a single suit each —
 * are compared by RPS.
 */
function cmpGroups(ra: Suit[], rb: Suit[]): 1 | -1 | 0 {
  if (ra.length === 0) return 0;
  const ca = counts(ra);
  const cb = counts(rb);
  const maxc = Math.max(maxCount(ca), maxCount(cb));
  const topA = [...ca.entries()].filter(([, n]) => n === maxc).map(([t]) => t);
  const topB = [...cb.entries()].filter(([, n]) => n === maxc).map(([t]) => t);

  if (topA.length === 1 && topB.length === 1) {
    const t = topA[0];
    const u = topB[0];
    if (t === u) {
      // Same dominant group on both sides: cancel it and recurse on kickers.
      const removeN = (arr: Suit[], suit: Suit, n: number): Suit[] => {
        const out = [...arr];
        for (let i = 0; i < n; i++) out.splice(out.indexOf(suit), 1);
        return out;
      };
      return cmpGroups(removeN(ra, t, maxc), removeN(rb, u, maxc));
    }
    return rpsCompare(t, u);
  }

  // Multiple top groups (two-pair or singles): cancel common, compare survivors.
  const { sa, sb } = cancelCommon(ra, rb);
  if (sa.length === 0) return 0;
  return rpsCompare(sa[0], sb[0]);
}

/**
 * Compare two 4-card hands. Returns 1 if `a` is stronger, -1 if `b` is
 * stronger, 0 for a draw. Lower rank number wins; same-rank hands go to the
 * sub-hierarchy then cyclic cancellation tiebreak.
 */
export function compare(a: Suit[], b: Suit[]): 1 | -1 | 0 {
  const ea = evaluate(a);
  const eb = evaluate(b);
  if (ea.rank !== eb.rank) return ea.rank < eb.rank ? 1 : -1;

  const na = nonLoves(a); // loves are equal in count for same-rank hands; they cancel.
  const nb = nonLoves(b);
  const subA = subStructure(na);
  const subB = subStructure(nb);
  if (subA !== subB) return subA > subB ? 1 : -1;
  return cmpGroups(na, nb);
}
