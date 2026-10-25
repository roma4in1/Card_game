// games/texas-holdem/bot.ts — the Texas Hold'em bots, at three strengths.
//
// A bot decides from its seat's `view` and nothing else: its own two cards, the board,
// the stacks, the bets, and the hand's history of actions — exactly what a player in its
// chair can see. It never touches the deck or anyone else's cards, so it cannot cheat
// even by mistake.
//
//   Casual — a loose, passive beginner: plays most hands, calls with any pair, rarely
//            raises, and pays little attention to the price.
//   Steady — plays by the book: a starting-hand score adjusted for position, hand
//            categories after the flop (overpair, top pair, draws counted as outs), pot
//            odds, value bets, and a continuation bet now and then.
//   Sharp  — works out its real chance of winning by playing out hundreds of random
//            boards against the hands its opponents could hold, given how they have
//            bet, and acts on the expected value: calls when the price is right, bets
//            and raises for value, bluffs in measured doses, and pushes or folds
//            correctly once the blinds have made the stacks short. It keeps count of how
//            often each opponent folds to a bet, and stops bluffing a calling station.
//
// HOW THEY WERE MEASURED, heads-up, every deal played twice with the seats swapped so the
// cards cancel out. Tournaments (1,000 chips, blinds up every 10 hands, 400 each): Steady
// beats Casual 66.5%, Sharp beats Steady 84.8% and Casual 77% — Casual shoves so often
// that its matches are short and swingy. In chips, with stacks reset every hand: Steady
// +65 big blinds per 100 hands against Casual (16,000 hands), and — over sessions of 600
// hands, long enough for its counts to fill in — Sharp +29 against Steady and +186
// against Casual. Sharp takes about a third of a millisecond a decision.
//
// TRIED AND DROPPED for Sharp: reading every street's bet as narrowly as players bluff
// them, and widening loose players' ranges. Both looked right and both lost to the plain
// version (by 18 and 12 big blinds per 100) — they made it fold too much against anyone
// who bets. Only the calling-station adjustment survived: +31 against Casual, level
// against everyone else.

import type { Rng } from '../../platform/types.ts';
import { parse, score, categoryOf, rankOf, suitOf, PAIR, TWO_PAIR, TRIPS, STRAIGHT } from '../shared/poker.ts';
import { CASUAL, STEADY } from '../../platform/skill.ts';

export interface Decision {
  type: 'action';
  action: 'fold' | 'check' | 'call' | 'raise' | 'allin';
  to?: number;
}

interface SeatView {
  seat: number;
  chips: number;
  inHand: boolean;
  allIn: boolean;
  committed: number;
  dealer: boolean;
  stats?: { hands: number; vpip: number; pfr: number; faced: number; folded: number; aggressive: number; passive: number };
}
interface Move {
  seat: number;
  street: string;
  act: string;
  to: number;
}
/** The parts of a Hold'em view the bots read. */
export interface BotView {
  you: { seat: number; hole: string[] };
  board: string[];
  blinds: [number, number];
  players: SeatView[];
  history: Move[];
  dealer: number;
  betting?: { toCall: number; canCheck: boolean; canRaise: boolean; minTo: number; maxTo: number; committed: number; currentBet: number; pot: number };
}

// ---------------------------------------------------------------------------
// Starting hands
// ---------------------------------------------------------------------------

/** 0..168: pairs, then suited, then offsuit hands, by their two ranks. */
function handClass(a: number, b: number): number {
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  if (hi === lo) return hi;
  const idx = (hi * (hi - 1)) / 2 + lo; // 0..77 over hi > lo
  return 13 + (suitOf(a) === suitOf(b) ? 0 : 78) + idx;
}

let percentile: Float64Array | null = null;
/** Each starting hand's place among all 169, by its chance against one random hand:
 *  0 is aces, 1 is the worst. Worked out once, on first use, with a fixed seed so every
 *  process ranks them the same. */
function startingPercentile(a: number, b: number): number {
  if (!percentile) {
    let x = 0x2545f491;
    const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
    const equity = new Float64Array(169);
    const weight = new Float64Array(169); // how many of the 1,326 deals each class covers
    const deal = new Int32Array(9);
    for (let c1 = 0; c1 < 52; c1++) {
      for (let c2 = c1 + 1; c2 < 52; c2++) {
        const k = handClass(c1, c2);
        weight[k]++;
        if (weight[k] > 1) continue; // one representative per class is enough
        let won = 0;
        const trials = 600;
        for (let t = 0; t < trials; t++) {
          const used = new Set([c1, c2]);
          const draw = () => { let c; do c = Math.floor(rnd() * 52); while (used.has(c)); used.add(c); return c; };
          const o1 = draw(), o2 = draw();
          for (let i = 0; i < 5; i++) deal[i] = draw();
          deal[5] = c1; deal[6] = c2;
          const mine = score(deal, 7);
          deal[5] = o1; deal[6] = o2;
          const theirs = score(deal, 7);
          won += mine > theirs ? 1 : mine === theirs ? 0.5 : 0;
        }
        equity[k] = won / trials;
      }
    }
    const order = Array.from({ length: 169 }, (_, i) => i).sort((p, q) => equity[q] - equity[p]);
    percentile = new Float64Array(169);
    let covered = 0;
    for (const k of order) {
      percentile[k] = (covered + weight[k] / 2) / 1326;
      covered += weight[k];
    }
  }
  return percentile[handClass(a, b)];
}

/** Bill Chen's starting-hand score: the high card, doubled for a pair, plus a little for
 *  suits and connection. About 12 for the best hands, under 5 for the worst. */
export function chen(a: number, b: number): number {
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  const points = (r: number) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
  let v = points(hi);
  if (hi === lo) return Math.max(5, v * 2);
  if (suitOf(a) === suitOf(b)) v += 2;
  const gap = hi - lo - 1;
  v -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 10) v += 1;
  return Math.ceil(v);
}

// ---------------------------------------------------------------------------
// After the flop: what you have, and what you could have
// ---------------------------------------------------------------------------

/** How many more ranks would complete a straight with these cards (8 open-ended, 4 a
 *  gutshot, roughly — counted as cards, four of each rank). */
function straightOuts(cards: number[]): number {
  let mask = 0;
  for (const c of cards) mask |= 1 << rankOf(c);
  const has = (m: number) => {
    const w = (m << 1) | ((m >> 12) & 1);
    for (let top = 13; top >= 4; top--) if (((w >> (top - 4)) & 0x1f) === 0x1f) return true;
    return false;
  };
  if (has(mask)) return 0;
  let ranks = 0;
  for (let r = 0; r < 13; r++) if (!(mask & (1 << r)) && has(mask | (1 << r))) ranks++;
  return ranks * 4;
}

/** A flush draw that uses at least one of your own cards. */
function flushDraw(hole: number[], board: number[]): boolean {
  for (let s = 0; s < 4; s++) {
    const n = [...hole, ...board].filter((c) => suitOf(c) === s).length;
    if (n === 4 && hole.some((c) => suitOf(c) === s)) return true;
  }
  return false;
}

export type Made = 'monster' | 'strong' | 'medium' | 'weak' | 'none';

/** What your two cards have made with the board, the way a careful player sizes it up.
 *  A pair that is all board is no pair of yours. */
export function madeHand(hole: number[], board: number[]): Made {
  const mine = score([...hole, ...board]);
  const cat = categoryOf(mine);
  const boardCat = board.length >= 5 ? categoryOf(score(board)) : -1;
  if (cat >= STRAIGHT && cat > boardCat) return 'monster';
  if (cat === TRIPS || cat === TWO_PAIR) {
    // Sets and two pair that use your cards are monsters; one paired on the board is not.
    const boardPairs = board.length - new Set(board.map(rankOf)).size;
    if (cat === TRIPS && hole[0] % 13 === hole[1] % 13) return 'monster';
    if (boardPairs === 0) return 'monster';
    return hole.some((c) => board.some((d) => rankOf(d) === rankOf(c))) ? 'strong' : 'weak';
  }
  if (cat === PAIR) {
    const top = Math.max(...board.map(rankOf));
    const pocket = rankOf(hole[0]) === rankOf(hole[1]);
    if (pocket) return rankOf(hole[0]) > top ? 'strong' : 'medium';
    const paired = hole.find((c) => board.some((d) => rankOf(d) === rankOf(c)));
    if (paired === undefined) return 'none'; // the pair is on the board
    if (rankOf(paired) === top) {
      const kicker = rankOf(hole[0] === paired ? hole[1] : hole[0]);
      return kicker >= 9 ? 'strong' : 'medium';
    }
    return 'weak';
  }
  return 'none';
}

/** Rough chance a draw comes in: about 2% an out per card still to come. */
function drawEquity(hole: number[], board: number[]): number {
  if (board.length >= 5) return 0;
  const outs = Math.min(15, (flushDraw(hole, board) ? 9 : 0) + Math.min(8, straightOuts([...hole, ...board])));
  return Math.min(0.6, outs * (board.length === 3 ? 0.04 : 0.02));
}

// ---------------------------------------------------------------------------
// Sharp: equity against the hands opponents could hold
// ---------------------------------------------------------------------------

interface Range {
  preRaises: number; // their raises before the flop
  preCalled: boolean; // put chips in before the flop without raising
  aggressive: number; // bets and raises after the flop
  called: number; // calls after the flop
}

function rangesOf(v: BotView, opponents: number[]): Map<number, Range> {
  const out = new Map<number, Range>();
  for (const seat of opponents) out.set(seat, { preRaises: 0, preCalled: false, aggressive: 0, called: 0 });
  for (const m of v.history) {
    const r = out.get(m.seat);
    if (!r) continue;
    const aggressive = m.act === 'bet' || m.act === 'raise' || m.act === 'allin';
    if (m.street === 'preflop') {
      if (aggressive) r.preRaises++;
      else if (m.act === 'call') r.preCalled = true;
    } else if (aggressive) r.aggressive++;
    else if (m.act === 'call') r.called++;
  }
  return out;
}

/** How likely an opponent who played this way is to hold this hand, from 0 to 1. Folded
 *  hands are out; a raise narrows a range far more than a call does. Never zero: people
 *  bluff, and people make mistakes. */
function plausibility(r: Range, a: number, b: number, board: number[]): number {
  const p = startingPercentile(a, b);
  let w = 1;
  if (r.preRaises >= 3) w *= p <= 0.04 ? 1 : 0.04;
  else if (r.preRaises === 2) w *= p <= 0.1 ? 1 : 0.06;
  else if (r.preRaises === 1) w *= p <= 0.3 ? 1 : 0.12;
  else if (r.preCalled) w *= p <= 0.6 ? 1 : 0.25;
  if (board.length >= 3 && (r.aggressive || r.called)) {
    const made = madeHand([a, b], board);
    const drawing = drawEquity([a, b], board) >= 0.16;
    const connected = made !== 'none' || drawing;
    if (r.aggressive) w *= made === 'monster' || made === 'strong' ? 1 : connected ? 0.6 : 0.2 ** Math.min(2, r.aggressive);
    if (r.called) w *= connected ? 1 : 0.35 ** Math.min(2, r.called);
  }
  return w;
}

/** Your share of the pot over `trials` random completions, each opponent's hand drawn in
 *  proportion to how plausible it is. */
function equity(hole: number[], board: number[], ranges: Range[], trials: number, rng: Rng): number {
  const known = new Set([...hole, ...board]);
  const deck = Array.from({ length: 52 }, (_, i) => i).filter((c) => !known.has(c));
  const cards = new Int32Array(7);
  let share = 0;
  for (let t = 0; t < trials; t++) {
    const used = new Set<number>();
    const draw = () => {
      let c;
      do c = deck[Math.floor(rng() * deck.length)]; while (used.has(c));
      used.add(c);
      return c;
    };
    const opp: [number, number][] = [];
    for (const r of ranges) {
      let hand: [number, number] = [draw(), draw()];
      for (let tries = 0; tries < 12 && rng() > plausibility(r, hand[0], hand[1], board); tries++) {
        used.delete(hand[0]);
        used.delete(hand[1]);
        hand = [draw(), draw()];
      }
      opp.push(hand);
    }
    const full = [...board];
    while (full.length < 5) full.push(draw());
    for (let i = 0; i < 5; i++) cards[i] = full[i];
    cards[5] = hole[0];
    cards[6] = hole[1];
    const mine = score(cards, 7);
    let best = true;
    let tied = 1;
    for (const [x, y] of opp) {
      cards[5] = x;
      cards[6] = y;
      const theirs = score(cards, 7);
      if (theirs > mine) {
        best = false;
        break;
      }
      if (theirs === mine) tied++;
    }
    if (best) share += 1 / tied;
  }
  return share / trials;
}

// ---------------------------------------------------------------------------
// Shared reckoning
// ---------------------------------------------------------------------------

interface Spot {
  b: NonNullable<BotView['betting']>;
  hole: number[];
  board: number[];
  bb: number;
  opponents: number[]; // seats still in the hand, not you
  stack: number; // chips behind
  preflop: boolean;
  potOdds: number; // the share of the final pot a call costs
  raisedPre: boolean; // did you raise before the flop (for a continuation bet)
  lastToAct: boolean; // in position: nobody acts after you on this street
  facingRaise: boolean; // preflop: has anyone raised beyond the big blind
}

function spotOf(v: BotView): Spot {
  const b = v.betting!;
  const me = v.you.seat;
  const hole = v.you.hole.map(parse);
  const board = v.board.map(parse);
  const opponents = v.players.filter((p) => p.inHand && p.seat !== me).map((p) => p.seat);
  const live = v.players.filter((p) => p.inHand && !p.allIn);
  // Acting order after the flop runs from the dealer's left; the last of the live players
  // in that order has position.
  const fromDealer = (seat: number) => (seat - v.dealer - 1 + 16) % 8;
  const lastToAct = live.length > 0 && live.every((p) => fromDealer(p.seat) <= fromDealer(me));
  const street = board.length === 0 ? 'preflop' : 'post';
  return {
    b, hole, board, bb: v.blinds[1], opponents,
    stack: b.maxTo - b.committed,
    preflop: street === 'preflop',
    potOdds: b.toCall > 0 ? b.toCall / (b.pot + b.toCall) : 0,
    raisedPre: v.history.some((m) => m.seat === me && m.street === 'preflop' && (m.act === 'raise' || m.act === 'allin')),
    lastToAct,
    facingRaise: v.history.some((m) => m.street === 'preflop' && (m.act === 'raise' || m.act === 'allin')),
  };
}

const clampTo = (s: Spot, to: number) => Math.max(s.b.minTo, Math.min(s.b.maxTo, Math.round(to)));
const fold = (s: Spot): Decision => (s.b.canCheck ? { type: 'action', action: 'check' } : { type: 'action', action: 'fold' });
const call = (s: Spot): Decision => (s.b.canCheck ? { type: 'action', action: 'check' } : { type: 'action', action: 'call' });
function raiseTo(s: Spot, to: number): Decision {
  if (!s.b.canRaise) return call(s);
  const t = clampTo(s, to);
  return t >= s.b.maxTo ? { type: 'action', action: 'allin' } : { type: 'action', action: 'raise', to: t };
}
/** A bet or raise of `fraction` of the pot (after calling), the way players size them. */
const potBet = (s: Spot, fraction: number) => raiseTo(s, s.b.currentBet + fraction * (s.b.pot + s.b.toCall));
const shove = (s: Spot): Decision => (s.b.canRaise ? { type: 'action', action: 'allin' } : call(s));

// ---------------------------------------------------------------------------
// Casual
// ---------------------------------------------------------------------------

function casual(s: Spot, rng: Rng): Decision {
  const { b } = s;
  const price = b.toCall / Math.max(1, s.stack + b.toCall);
  if (s.preflop) {
    const [x, y] = s.hole.map(rankOf);
    const premium = (x === y && x >= 8) || (Math.min(x, y) >= 10 && Math.max(x, y) === 12);
    if (premium && rng() < 0.3) return raiseTo(s, b.minTo);
    if (price <= 0.15) return call(s);
    return premium || (x === y && x >= 6) ? call(s) : fold(s);
  }
  const made = madeHand(s.hole, s.board);
  if (made === 'monster' || made === 'strong') {
    if (rng() < 0.25) return b.toCall ? raiseTo(s, b.minTo) : potBet(s, 0.4);
    return call(s);
  }
  if (made === 'medium' || made === 'weak') return b.toCall <= b.pot ? call(s) : fold(s);
  if (drawEquity(s.hole, s.board) > 0 && b.toCall <= b.pot / 2) return call(s);
  if (!b.toCall) return call(s);
  return b.toCall <= b.pot / 4 && rng() < 0.5 ? call(s) : fold(s);
}

// ---------------------------------------------------------------------------
// Steady
// ---------------------------------------------------------------------------

function steady(s: Spot, rng: Rng): Decision {
  const { b, bb } = s;
  if (s.preflop) {
    const c = chen(s.hole[0], s.hole[1]);
    if (s.stack <= 12 * bb) return c >= 8 ? shove(s) : fold(s); // short: all-in or out
    const late = s.lastToAct || s.opponents.length <= 2;
    if (!s.facingRaise) {
      if (c >= (late ? 6 : 8)) return raiseTo(s, b.currentBet + 2 * bb);
      if (c >= 5 && b.toCall <= bb) return call(s);
      return fold(s);
    }
    if (c >= 11) return raiseTo(s, b.currentBet * 3);
    if (c >= 9 && s.potOdds <= 0.35) return call(s);
    return fold(s);
  }

  const made = madeHand(s.hole, s.board);
  const draw = drawEquity(s.hole, s.board);
  if (!b.toCall) {
    if (made === 'monster' || made === 'strong') return potBet(s, 0.66);
    if (draw >= 0.16 && rng() < 0.3) return potBet(s, 0.5);
    if (made === 'medium' && rng() < 0.3) return potBet(s, 0.5);
    if (s.raisedPre && s.board.length === 3 && s.opponents.length <= 2 && rng() < 0.5) return potBet(s, 0.5);
    return call(s);
  }
  if (made === 'monster') return rng() < 0.5 ? raiseTo(s, b.currentBet * 3) : call(s);
  if (made === 'strong') return call(s);
  if (made === 'medium' && s.potOdds <= 0.3) return call(s);
  if (draw >= s.potOdds) return call(s);
  return fold(s);
}

// ---------------------------------------------------------------------------
// Sharp
// ---------------------------------------------------------------------------

/** A calling station: someone who, over enough bets to go on, folds to fewer than a
 *  third of them. Bluffing them is giving chips away; betting into them is how to win. */
function callsDown(p: SeatView | undefined): boolean {
  const st = p?.stats;
  return !!st && st.faced >= 12 && st.folded / st.faced < 0.35;
}

function sharp(v: BotView, s: Spot, rng: Rng): Decision {
  const { b, bb } = s;
  const n = s.opponents.length;
  const ranges = rangesOf(v, s.opponents);

  if (s.preflop) {
    const p = startingPercentile(s.hole[0], s.hole[1]);
    // Short-stacked, the only plays are all-in or fold: shove wider the fewer players are
    // left to wake up with a hand, and call a shove with what beats a shoving range.
    if (s.stack <= 12 * bb) {
      if (!s.facingRaise) return p <= (n <= 1 ? 0.65 : n === 2 ? 0.4 : 0.25) ? shove(s) : fold(s);
      const e = equity(s.hole, [], [...ranges.values()], 400, rng);
      return e >= s.potOdds + 0.02 ? shove(s) : fold(s);
    }
    if (!s.facingRaise) {
      // Open with a range that widens as the seats behind thin out.
      const behind = v.players.filter((x) => x.inHand && x.seat !== v.you.seat).length;
      const open = n <= 1 ? 0.7 : s.lastToAct ? 0.42 : behind >= 5 ? 0.16 : behind >= 3 ? 0.22 : 0.32;
      if (p <= open) return raiseTo(s, b.currentBet + (n <= 1 ? 1.5 : 2) * bb);
      return b.canCheck ? call(s) : fold(s);
    }
    const e = equity(s.hole, [], [...ranges.values()], 500, rng);
    const reraises = v.history.filter((m) => m.street === 'preflop' && (m.act === 'raise' || m.act === 'allin')).length;
    if (e >= 0.6 + 0.05 * (n - 1) || (p <= 0.025 && reraises < 3)) {
      return s.stack <= 25 * bb || reraises >= 2 ? shove(s) : raiseTo(s, b.currentBet * 3);
    }
    return e >= s.potOdds + 0.04 ? call(s) : fold(s);
  }

  const e = equity(s.hole, s.board, [...ranges.values()], 500, rng);
  const draw = drawEquity(s.hole, s.board);
  const spr = s.stack / Math.max(1, b.pot);
  const station = s.opponents.every((seat) => callsDown(v.players.find((p) => p.seat === seat)));
  const bluff = station ? 0.25 : 1;
  const valueBar = 0.55 + 0.07 * (n - 1) - (station ? 0.06 : 0);
  if (!b.toCall) {
    if (e >= valueBar) {
      if (e > 0.9 && s.board.length === 3 && !station && rng() < 0.15) return call(s); // slow-play now and then
      if (spr < 1.2) return shove(s);
      return potBet(s, 0.5 + (station ? 0.2 : 0) + 0.35 * Math.min(1, (e - valueBar) / (1 - valueBar)));
    }
    if (draw >= 0.16 && s.board.length < 5 && rng() < (n <= 1 ? 0.45 : 0.2) * bluff) return potBet(s, 0.6);
    // Bluffs, in measured doses: a continuation bet as the raiser, a stab in position.
    if (n <= 1 && s.raisedPre && s.board.length === 3 && rng() < 0.45 * bluff) return potBet(s, 0.45);
    if (n <= 1 && s.lastToAct && rng() < 0.18 * bluff) return potBet(s, 0.55);
    return call(s);
  }
  // Facing a bet. Draws are worth a little more than their raw odds while chips remain
  // behind to win when they come in.
  const implied = draw >= 0.16 && s.board.length < 5 && spr > 2 ? 0.05 : 0;
  if (e + implied < s.potOdds) {
    if (draw >= 0.16 && n <= 1 && s.board.length === 3 && rng() < 0.12) return potBet(s, 0.9); // semi-bluff raise
    return fold(s);
  }
  if (e >= 0.68 + 0.06 * (n - 1)) return spr < 1.5 ? shove(s) : potBet(s, 0.85);
  return call(s);
}

/** What a bot in this seat does now, or null if it is not its turn. */
export function holdemBot(v: BotView, skill: number, rng: Rng): Decision | null {
  if (!v.betting) return null;
  const s = spotOf(v);
  if (skill <= CASUAL) return casual(s, rng);
  if (skill <= STEADY) return steady(s, rng);
  return sharp(v, s, rng);
}
