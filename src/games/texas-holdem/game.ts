// games/texas-holdem/game.ts — No-limit Texas Hold'em, 2–8 players, played as a tournament:
// everyone starts with the same stack, the blinds rise on a schedule, players bust out,
// and the last one with chips wins.
//
// The rules that are easy to get wrong, and are tested:
//   • Heads-up, the dealer posts the small blind and acts first before the flop, last after.
//   • The smallest raise is the size of the last full raise (at least the big blind). An
//     all-in for less than that does not reopen the betting: players who had already acted
//     must call it or fold, but may not raise again.
//   • A player who is all-in, or the only one left able to bet, is not asked to act; when
//     nobody can bet any more the rest of the board is dealt and the hand is shown down.
//   • Side pots: each layer of contributions is its own pot, won by the best hand among
//     those who paid into it and did not fold. Folded chips stay in the pot.
//
// Every secret — the deck, the hole cards — lives here. `view` sends a player their own
// cards and only the backs of everyone else's, until they are shown down.

import type { GameContext, GameDef, GameOption, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { initTimer, runTimer, timerView, TIMER_OPTION, type Timer } from '../../platform/turn-timer.ts';
import { shuffledDeck, score, describe, bestFive, code } from '../shared/poker.ts';
import { initSkill, SKILL_OPTION } from '../../platform/skill.ts';
import { holdemBot, type BotView } from './bot.ts';

export const MAX_SEATS = 8;

// What the host sets before the game: how many chips each player starts with, the blinds
// the first hands are played at, and how often they go up. Amounts are typed in.
export const STACK_OPTION: GameOption = { key: 'stack', label: 'Starting chips (each)', min: 20, max: 1000000, step: 100, default: 1000, input: true };
export const SB_OPTION: GameOption = { key: 'sb', label: 'Small blind (to start)', min: 1, max: 100000, step: 5, default: 10, input: true };
export const BB_OPTION: GameOption = { key: 'bb', label: 'Big blind (to start)', min: 2, max: 200000, step: 10, default: 20, input: true };
export const BLINDS_OPTION: GameOption = { key: 'blindsEvery', label: 'Blinds rise every (hands, 0 = never)', min: 0, max: 30, step: 1, default: 10 };

/** The host's settings made consistent: the big blind is at least the small, and no blind
 *  is more than a whole starting stack. `notes` says what had to give. */
export function tableSettings(o: Record<string, number> = {}) {
  const num = (v: unknown, spec: GameOption) => {
    const n = Math.round(Number(v ?? spec.default));
    return Number.isFinite(n) ? Math.max(spec.min, Math.min(spec.max, n)) : spec.default;
  };
  const stack = num(o.stack, STACK_OPTION);
  let sb = num(o.sb, SB_OPTION);
  let bb = num(o.bb, BB_OPTION);
  const blindsEvery = num(o.blindsEvery, BLINDS_OPTION);
  const notes: string[] = [];
  if (bb < sb) {
    bb = sb;
    notes.push(`the big blind can't be smaller than the small, so it will be ${bb}`);
  }
  if (bb > stack) {
    bb = stack;
    sb = Math.min(sb, bb);
    notes.push(`no blind can be more than a whole stack, so they will be ${sb}/${bb}`);
  }
  return { stack, start: [sb, bb] as [number, number], blindsEvery, notes };
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

interface HPlayer {
  name: string;
  connected: boolean;
  chips: number;
  out: boolean; // busted — no longer dealt in
  // this hand:
  hole: number[];
  folded: boolean;
  allIn: boolean;
  committed: number; // chips put in on the current street
  contributed: number; // chips put in over the whole hand (side pots are built from these)
  acted: boolean; // has acted since the last full raise
  canRaise: boolean; // false after a short all-in, for players who had already acted
  said: string | null; // their last action this street, for the table to show
  stats: Stats; // how they have played so far — public: anyone at the table could keep it
}

/** Tallies of a player's play over the match, the kind any player at a real table keeps
 *  in their head. The Sharp bot reads them to adapt to how each opponent plays. */
export interface Stats {
  hands: number; // dealt in
  vpip: number; // hands they put chips in before the flop by choice
  pfr: number; // hands they raised before the flop
  faced: number; // times they faced a bet after the flop
  folded: number; // ...and folded to it
  aggressive: number; // bets and raises after the flop
  passive: number; // calls after the flop
}
const newStats = (): Stats => ({ hands: 0, vpip: 0, pfr: 0, faced: 0, folded: 0, aggressive: 0, passive: 0 });

interface Award {
  seat: number;
  amount: number;
}
interface Reveal {
  seat: number;
  hole: string[];
  hand: string;
  best: string[];
}
export interface HandResult {
  kind: 'fold' | 'showdown';
  awards: Award[];
  reveals: Reveal[];
}

export interface Hand {
  no: number;
  dealer: number;
  sb: number;
  bb: number;
  blinds: [number, number];
  deck: number[];
  board: number[];
  street: Street;
  toAct: number; // seat, or -1 between streets / once the hand is over
  currentBet: number; // the most anyone has committed this street
  minRaise: number; // the size of the last full raise this street
  participants: number[]; // seats dealt in
  history: Move[]; // every action this hand, in order — all of it seen by the table
  result: HandResult | null; // set once the hand is over
}

/** One action, as the whole table saw it. `to` is what the player had in on the street
 *  afterwards. */
export interface Move {
  seat: number;
  street: Street;
  act: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
  to: number;
}

export interface HState {
  players: (HPlayer | null)[]; // by seat
  hand: Hand | null;
  handNo: number;
  stack: number;
  startBlinds: [number, number]; // the blinds the host chose for the first level
  blindsEvery: number;
  over: boolean;
  winner: number | null;
  timer: Timer;
  skill: number; // how the bots play (1 casual … 3 sharp)
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function log(s: HState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}

const nameOf = (s: HState, seat: number) => s.players[seat]!.name;
const seated = (s: HState) => s.players.flatMap((p, seat) => (p ? [seat] : []));
const stillIn = (s: HState) => seated(s).filter((seat) => !s.players[seat]!.out);

/** The first seat after `from`, going round the table, that satisfies `ok`. */
function nextSeat(s: HState, from: number, ok: (seat: number) => boolean): number {
  for (let i = 1; i <= MAX_SEATS; i++) {
    const seat = (from + i) % MAX_SEATS;
    if (s.players[seat] && ok(seat)) return seat;
  }
  return -1;
}

/** The blind level a hand is played at, counting from 0. */
export const levelOf = (blindsEvery: number, handNo: number) => (blindsEvery > 0 ? Math.floor((Math.max(1, handNo) - 1) / blindsEvery) : 0);

// How much bigger each level's blinds are than the first's: the classic tournament climb —
// from 10/20 it runs 15/30, 25/50, 50/100, 75/150, 100/200, 200/400 … — applied to whatever
// blinds the host starts at. Each step is a third to double the last; past the end of the
// table they keep doubling.
const CLIMB = [1, 1.5, 2.5, 5, 7.5, 10, 20, 30, 40, 50, 100, 150, 200, 300, 400, 500, 1000, 1500, 2000, 3000, 4000, 5000];
const climbAt = (level: number) => (level < CLIMB.length ? CLIMB[level] : CLIMB[CLIMB.length - 1] * 2 ** (level - CLIMB.length + 1));

/** A blind rounded to a figure a dealer would ask for: whole chips, and above ten a round
 *  value — 12, 15, 20, 25, 30, 40, 50, 60, 75, 80, 100, 120, 125, 150 … */
export function roundBlind(x: number): number {
  if (x < 10) return Math.max(1, Math.round(x));
  const unit = 10 ** Math.floor(Math.log10(x));
  let best = unit;
  for (const m of [1, 1.2, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]) {
    const v = m * unit;
    if (Number.isInteger(v) && Math.abs(v - x) < Math.abs(best - x)) best = v;
  }
  return best;
}

/** The blinds at a level: the first level is exactly what the host chose; each one after
 *  climbs from there, always bigger than the one before. */
export function levelBlinds(start: [number, number], level: number): [number, number] {
  let [sb, bb] = start;
  for (let l = 1; l <= level; l++) {
    const nsb = Math.max(sb + 1, roundBlind(start[0] * climbAt(l)));
    bb = Math.max(bb + 1, nsb, roundBlind(start[1] * climbAt(l)));
    sb = nsb;
  }
  return [sb, bb];
}

export const blindsFor = (start: [number, number], blindsEvery: number, handNo: number) => levelBlinds(start, levelOf(blindsEvery, handNo));

// The chips on the table, in the usual casino denominations. As the blinds climb, the small
// chips are coloured up and bigger ones brought in — as at a real tournament — and once a
// chip has been coloured up it never comes back. The smallest chip in play is the largest
// that pays this level's blinds and the next two exactly; the biggest is capped by how many
// chips there are at the table, so nobody is handed a chip worth half the game.
export const DENOMINATIONS = [1, 5, 25, 100, 500, 1000, 5000, 25000, 100000, 500000, 1000000];

export function chipSetFor(start: [number, number], blindsEvery: number, handNo: number, inPlay: number): number[] {
  const level = levelOf(blindsEvery, handNo);
  // The smallest chip each level up to this one needs, never going back down.
  let smallest = 1;
  for (let l = 0; l <= level; l++) {
    const coming = [0, 1, 2].flatMap((k) => levelBlinds(start, l + k));
    let d = smallest;
    for (const x of DENOMINATIONS) if (x >= smallest && coming.every((b) => b % x === 0)) d = x;
    smallest = d;
  }
  const set = [smallest];
  for (const d of DENOMINATIONS) if (d > smallest && set.length < 5 && d <= inPlay / 4) set.push(d);
  return set;
}

// ---------------------------------------------------------------------------
// Hand lifecycle
// ---------------------------------------------------------------------------

function put(s: HState, seat: number, amount: number) {
  const p = s.players[seat]!;
  const pay = Math.min(amount, p.chips);
  p.chips -= pay;
  p.committed += pay;
  p.contributed += pay;
  if (p.chips === 0) p.allIn = true;
  return pay;
}

function startHand(s: HState, rng: Rng) {
  for (const seat of stillIn(s)) {
    const p = s.players[seat]!;
    if (p.chips === 0) {
      p.out = true;
      log(s, `${p.name} is out of chips.`);
    }
  }
  const live = stillIn(s);
  if (live.length <= 1) {
    s.over = true;
    s.winner = live[0] ?? null;
    if (s.winner !== null) log(s, `🏆 ${nameOf(s, s.winner)} wins the tournament!`);
    return;
  }

  s.handNo += 1;
  const blinds = blindsFor(s.startBlinds, s.blindsEvery, s.handNo);
  const prev = s.hand;
  if (prev && blinds[1] !== prev.blinds[1]) log(s, `⬆️ Blinds up — level ${levelOf(s.blindsEvery, s.handNo) + 1}: ${blinds[0]}/${blinds[1]}.`);

  const dealer = prev
    ? nextSeat(s, prev.dealer, (seat) => !s.players[seat]!.out)
    : live[Math.floor(rng() * live.length)];
  const headsUp = live.length === 2;
  const sb = headsUp ? dealer : nextSeat(s, dealer, (seat) => !s.players[seat]!.out);
  const bb = nextSeat(s, sb, (seat) => !s.players[seat]!.out);

  for (const seat of seated(s)) {
    Object.assign(s.players[seat]!, {
      hole: [], folded: false, allIn: false, committed: 0, contributed: 0, acted: false, canRaise: true, said: null,
    });
  }
  for (const seat of live) s.players[seat]!.stats.hands++;
  const hand: Hand = {
    no: s.handNo, dealer, sb, bb, blinds,
    deck: shuffledDeck(rng), board: [], street: 'preflop',
    toAct: -1, currentBet: blinds[1], minRaise: blinds[1],
    participants: live, history: [], result: null,
  };
  s.hand = hand;

  put(s, sb, blinds[0]);
  put(s, bb, blinds[1]);
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const seat = (dealer + i) % MAX_SEATS;
      if (live.includes(seat)) s.players[seat]!.hole.push(hand.deck.pop()!);
    }
  }
  log(s, `Hand ${s.handNo}: ${nameOf(s, dealer)} deals. Blinds ${blinds[0]}/${blinds[1]}.`);

  // Before the flop the action starts left of the big blind — heads-up that is the dealer.
  hand.toAct = needsToAct(s, headsUp ? sb : nextSeat(s, bb, () => true), true);
  if (hand.toAct < 0) endStreet(s);
}

/** Can this seat still put chips in on this street? */
const canBet = (s: HState, seat: number) => {
  const p = s.players[seat]!;
  return s.hand!.participants.includes(seat) && !p.folded && !p.allIn;
};

/** Whether `seat` has to act now: it can bet, has not acted since the last full raise
 *  (or faces a bet), and there is someone left to bet against — nobody is asked to act
 *  into a table where everyone else is all-in, once they have matched the bet. */
function mustAct(s: HState, seat: number): boolean {
  const h = s.hand!;
  const p = s.players[seat]!;
  if (!canBet(s, seat) || p.acted) return false;
  if (p.committed < h.currentBet) return true;
  return h.participants.some((o) => o !== seat && canBet(s, o));
}

/** The first seat from `start` (inclusive when `inclusive`) that must act, or -1. */
function needsToAct(s: HState, start: number, inclusive = false): number {
  if (inclusive && start >= 0 && s.players[start] && mustAct(s, start)) return start;
  return nextSeat(s, start, (seat) => mustAct(s, seat));
}

const contenders = (s: HState) => s.hand!.participants.filter((seat) => !s.players[seat]!.folded);

function endStreet(s: HState) {
  const h = s.hand!;
  for (const seat of h.participants) {
    const p = s.players[seat]!;
    p.committed = 0;
    p.said = null;
  }
  const bettors = contenders(s).filter((seat) => !s.players[seat]!.allIn);
  if (h.street === 'river' || bettors.length <= 1) {
    // Nobody left to bet against: deal whatever is left of the board and show down.
    while (h.board.length < 5) h.board.push(h.deck.pop()!);
    return showdown(s);
  }
  if (h.street === 'preflop') {
    h.board.push(h.deck.pop()!, h.deck.pop()!, h.deck.pop()!);
    h.street = 'flop';
  } else if (h.street === 'flop') {
    h.board.push(h.deck.pop()!);
    h.street = 'turn';
  } else {
    h.board.push(h.deck.pop()!);
    h.street = 'river';
  }
  log(s, `${h.street[0].toUpperCase() + h.street.slice(1)}: ${h.board.map(code).join(' ')}.`);
  h.currentBet = 0;
  h.minRaise = h.blinds[1];
  for (const seat of bettors) {
    s.players[seat]!.acted = false;
    s.players[seat]!.canRaise = true;
  }
  // After the flop the first to act is the first player left of the dealer still in.
  h.toAct = needsToAct(s, h.dealer);
  if (h.toAct < 0) endStreet(s);
}

function afterAction(s: HState, seat: number) {
  const h = s.hand!;
  const live = contenders(s);
  if (live.length === 1) return winByFold(s, live[0]);
  h.toAct = needsToAct(s, seat);
  if (h.toAct < 0) endStreet(s);
}

function finishHand(s: HState, result: HandResult) {
  const h = s.hand!;
  h.result = result;
  h.toAct = -1;
  for (const a of result.awards) s.players[a.seat]!.chips += a.amount;
  for (const seat of h.participants) {
    // The bets have gone to the winner: clear them off the felt.
    s.players[seat]!.committed = 0;
    s.players[seat]!.said = null;
  }
  // The tournament is decided the moment one player holds every chip.
  const withChips = stillIn(s).filter((seat) => s.players[seat]!.chips > 0);
  if (withChips.length === 1) {
    for (const seat of stillIn(s)) if (seat !== withChips[0]) s.players[seat]!.out = true;
    s.over = true;
    s.winner = withChips[0];
    log(s, `🏆 ${nameOf(s, s.winner)} wins the tournament!`);
  }
}

function winByFold(s: HState, winner: number) {
  const h = s.hand!;
  const pot = h.participants.reduce((a, seat) => a + s.players[seat]!.contributed, 0);
  log(s, `Everyone else folded — ${nameOf(s, winner)} wins ${pot}.`);
  finishHand(s, { kind: 'fold', awards: [{ seat: winner, amount: pot }], reveals: [] });
}

/** The pots, layer by layer: each distinct contribution level is a pot, shared by the
 *  players who paid into it and did not fold. Chips from players who folded stay in. */
export function buildPots(contributed: Map<number, number>, folded: Set<number>): { amount: number; eligible: number[] }[] {
  const levels = [...new Set([...contributed.values()].filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: { amount: number; eligible: number[] }[] = [];
  let prev = 0;
  for (const level of levels) {
    const payers = [...contributed].filter(([, c]) => c >= level).map(([seat]) => seat);
    const amount = (level - prev) * payers.length;
    const eligible = payers.filter((seat) => !folded.has(seat));
    // A layer only folded players paid into belongs to the pot below it.
    if (eligible.length) pots.push({ amount, eligible });
    else if (pots.length) pots[pots.length - 1].amount += amount;
    prev = level;
  }
  return pots;
}

function showdown(s: HState) {
  const h = s.hand!;
  h.toAct = -1;
  const live = contenders(s);
  const scores = new Map(live.map((seat) => [seat, score([...s.players[seat]!.hole, ...h.board])]));
  const contributed = new Map(h.participants.map((seat) => [seat, s.players[seat]!.contributed]));
  const folded = new Set(h.participants.filter((seat) => s.players[seat]!.folded));
  const won = new Map<number, number>();
  // Odd chips go to the winner nearest the dealer's left, as at a real table.
  const fromDealer = (seat: number) => (seat - h.dealer - 1 + MAX_SEATS) % MAX_SEATS;
  for (const pot of buildPots(contributed, folded)) {
    const best = Math.max(...pot.eligible.map((seat) => scores.get(seat)!));
    const winners = pot.eligible.filter((seat) => scores.get(seat) === best).sort((a, b) => fromDealer(a) - fromDealer(b));
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    for (const seat of winners) won.set(seat, (won.get(seat) ?? 0) + share + (odd-- > 0 ? 1 : 0));
  }
  const reveals: Reveal[] = live.map((seat) => {
    const cards = [...s.players[seat]!.hole, ...h.board];
    return { seat, hole: s.players[seat]!.hole.map(code), hand: describe(scores.get(seat)!), best: bestFive(cards).map(code) };
  });
  const awards = [...won].map(([seat, amount]) => ({ seat, amount }));
  log(s, `Showdown: ${awards.map((a) => `${nameOf(s, a.seat)} wins ${a.amount} with ${describe(scores.get(a.seat)!)}`).join('; ')}.`);
  finishHand(s, { kind: 'showdown', awards, reveals });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function act(s: HState, seat: number, action: string, to: number): ActionResult {
  const h = s.hand;
  if (s.over || !h || h.result) return fail('No hand in progress.');
  if (seat !== h.toAct) return fail('Not your turn.');
  const p = s.players[seat]!;
  const toCall = h.currentBet - p.committed;

  if (action === 'allin') {
    if (p.chips <= toCall) action = 'call';
    else {
      action = 'raise';
      to = p.committed + p.chips;
    }
  }

  switch (action) {
    case 'fold':
      p.folded = true;
      p.acted = true;
      p.said = 'Fold';
      log(s, `${p.name} folds.`);
      break;
    case 'check':
      if (toCall > 0) return fail(`You cannot check — it is ${toCall} to call.`);
      p.acted = true;
      p.said = 'Check';
      log(s, `${p.name} checks.`);
      break;
    case 'call': {
      if (toCall <= 0) return fail('There is nothing to call — check instead.');
      const paid = put(s, seat, toCall);
      p.acted = true;
      p.said = p.allIn ? `All-in ${p.committed}` : `Call ${paid}`;
      log(s, `${p.name} calls ${paid}${p.allIn ? ' and is all-in' : ''}.`);
      break;
    }
    case 'raise': {
      if (!p.canRaise) return fail('You cannot raise again — only call or fold.');
      const most = p.committed + p.chips;
      if (!Number.isFinite(to)) return fail('Say how much to raise to.');
      to = Math.min(Math.floor(to), most);
      if (to <= h.currentBet) return fail(p.chips <= toCall ? 'You can only call.' : `Raise to more than ${h.currentBet}.`);
      const least = h.currentBet + h.minRaise;
      if (to < least && to < most) return fail(`The smallest raise is to ${least}.`);
      const opening = h.currentBet === 0;
      put(s, seat, to - p.committed);
      p.acted = true;
      const raisedBy = to - h.currentBet;
      if (raisedBy >= h.minRaise) {
        // A full raise reopens the betting for everyone.
        h.minRaise = raisedBy;
        for (const o of h.participants) {
          if (o === seat || !canBet(s, o)) continue;
          s.players[o]!.acted = false;
          s.players[o]!.canRaise = true;
        }
      } else {
        // An all-in for less than a full raise: those still to act may raise as usual;
        // those who had acted must answer it, but may not raise again.
        for (const o of h.participants) {
          if (o === seat || !canBet(s, o)) continue;
          if (s.players[o]!.acted) s.players[o]!.canRaise = false;
          s.players[o]!.acted = false;
        }
      }
      h.currentBet = to;
      p.said = p.allIn ? `All-in ${to}` : opening ? `Bet ${to}` : `Raise ${to}`;
      log(s, `${p.name} ${opening ? 'bets' : 'raises to'} ${to}${p.allIn ? ' (all-in)' : ''}.`);
      break;
    }
    default:
      return fail('Unknown action.');
  }
  // The table's tallies: by choice before the flop (once a hand), and how they meet bets after it.
  const mine = h.history.filter((m) => m.seat === seat && m.street === 'preflop');
  if (h.street === 'preflop') {
    if ((action === 'call' || action === 'raise') && !mine.some((m) => m.act !== 'check' && m.act !== 'fold')) p.stats.vpip++;
    if (action === 'raise' && !mine.some((m) => m.act === 'raise' || m.act === 'allin')) p.stats.pfr++;
  } else {
    if (toCall > 0) p.stats.faced++;
    if (toCall > 0 && action === 'fold') p.stats.folded++;
    if (action === 'raise') p.stats.aggressive++;
    if (action === 'call') p.stats.passive++;
  }
  const opened = h.history.every((m) => m.street !== h.street || (m.act !== 'bet' && m.act !== 'raise' && m.act !== 'allin'));
  const kind = action === 'raise' ? (p.allIn ? 'allin' : opened && h.street !== 'preflop' ? 'bet' : 'raise') : p.allIn && action === 'call' ? 'allin' : action;
  h.history.push({ seat, street: h.street, act: kind as Move['act'], to: p.committed });
  afterAction(s, seat);
  return ok;
}

function nextHand(s: HState, rng: Rng): ActionResult {
  // Idempotent: a second click after the next hand has started does nothing.
  if (s.over || !s.hand?.result) return ok;
  startHand(s, rng);
  return ok;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function view(s: HState, seat: number | null): Record<string, unknown> {
  const h = s.hand;
  const me = seat !== null ? s.players[seat] : null;
  const shown = new Map((h?.result?.reveals ?? []).map((r) => [r.seat, r.hole]));
  const pot = h ? h.participants.reduce((a, x) => a + s.players[x]!.contributed, 0) : 0;
  const blinds = h ? h.blinds : blindsFor(s.startBlinds, s.blindsEvery, 1);
  const players = seated(s).map((x) => {
    const p = s.players[x]!;
    const dealt = !!h && h.participants.includes(x);
    return {
      seat: x,
      name: p.name,
      connected: p.connected,
      chips: p.chips,
      out: p.out,
      inHand: dealt && !p.folded,
      folded: dealt && p.folded,
      allIn: p.allIn,
      committed: p.committed,
      said: p.said,
      holeCount: dealt && !p.folded ? p.hole.length : 0, // a folded hand is mucked
      shown: shown.get(x) ?? null,
      isTurn: !!h && !h.result && h.toAct === x,
      dealer: h?.dealer === x,
      blind: h?.sb === x ? 'SB' : h?.bb === x ? 'BB' : null,
      stats: p.stats,
    };
  });

  const v: Record<string, unknown> = {
    game: 'texas-holdem',
    over: s.over,
    phase: s.over ? 'over' : h?.result ? 'handover' : h?.street ?? 'preflop',
    handNo: s.handNo,
    level: levelOf(s.blindsEvery, s.handNo) + 1,
    blinds,
    chipSet: chipSetFor(s.startBlinds, s.blindsEvery, s.handNo, s.stack * seated(s).length),
    nextBlinds: s.blindsEvery > 0 ? blindsFor(s.startBlinds, s.blindsEvery, s.handNo + s.blindsEvery - ((s.handNo - 1) % s.blindsEvery)) : null,
    blindsIn: s.blindsEvery > 0 ? s.blindsEvery - ((s.handNo - 1) % s.blindsEvery) : null,
    pot,
    board: h ? h.board.map(code) : [],
    players,
    activeSeat: h && !h.result && h.toAct >= 0 ? h.toAct : null,
    history: h ? h.history : [],
    dealer: h ? h.dealer : -1,
    result: h?.result ?? null,
    timer: timerView(s.timer),
    log: s.log.slice(-15),
    matchWinner: s.winner,
  };

  if (me && h) {
    const dealt = h.participants.includes(seat!);
    const cards = [...me.hole, ...h.board];
    v.you = {
      seat,
      chips: me.chips,
      out: me.out,
      inHand: dealt && !me.folded,
      folded: me.folded,
      hole: dealt ? me.hole.map(code) : [],
      made: dealt && !me.folded && h.board.length >= 3 ? describe(score(cards)) : null,
    };
    if (!h.result && h.toAct === seat) {
      const toCall = Math.min(h.currentBet - me.committed, me.chips);
      const most = me.committed + me.chips;
      v.betting = {
        yourTurn: true,
        toCall,
        canCheck: h.currentBet - me.committed <= 0,
        canRaise: me.canRaise && me.chips > h.currentBet - me.committed,
        minTo: Math.min(h.currentBet + h.minRaise, most),
        maxTo: most,
        committed: me.committed,
        currentBet: h.currentBet,
        pot,
      };
    }
  } else {
    v.you = { seat: seat ?? -1, spectator: true, hole: [] };
  }
  return v;
}

// ---------------------------------------------------------------------------
// Bot — see bot.ts. It decides from its seat's view, exactly what a person in that chair
// can see. It never starts the next hand; a person does that.
// ---------------------------------------------------------------------------

// --- turn timer: a stalled player checks if they can, and folds if they cannot ---
const turnKey = (s: HState) => {
  const h = s.hand;
  if (s.over || !h) return '';
  if (h.result) return `next:${h.no}`; // the timer also moves a finished hand along
  return `${h.no}:${h.street}:${h.toAct}:${h.currentBet}`;
};
function onTimeout(s: HState, rng: Rng) {
  const h = s.hand!;
  if (h.result) return void startHand(s, rng);
  const p = s.players[h.toAct]!;
  act(s, h.toAct, h.currentBet - p.committed <= 0 ? 'check' : 'fold', 0);
}

// ---------------------------------------------------------------------------
// GameDef
// ---------------------------------------------------------------------------

export const texasHoldem: GameDef<HState> = {
  id: 'texas-holdem',
  name: "Texas Hold'em",
  blurb: 'No-limit poker: two cards each, five on the board, blinds rising. Last player with chips wins.',
  minPlayers: 2,
  maxPlayers: MAX_SEATS,
  options: [STACK_OPTION, SB_OPTION, BB_OPTION, BLINDS_OPTION, SKILL_OPTION, TIMER_OPTION],

  describeOptions(o) {
    const t = tableSettings(o);
    const [sb, bb] = t.start;
    const depth = Math.floor(t.stack / bb);
    const climb = t.blindsEvery > 0
      ? `then ${[1, 2, 3].map((l) => levelBlinds(t.start, l).join('/')).join(', ')} … every ${t.blindsEvery} hand${t.blindsEvery === 1 ? '' : 's'}`
      : 'and they never go up';
    const note = t.notes.length ? ` (${t.notes.join('; ')})` : '';
    return `${t.stack.toLocaleString('en')} chips each — ${depth} big blind${depth === 1 ? '' : 's'}. Blinds ${sb}/${bb}, ${climb}.${note}`;
  },

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): HState {
    const { stack, start, blindsEvery } = tableSettings(setup.options);
    const players: (HPlayer | null)[] = new Array(MAX_SEATS).fill(null);
    const nameBySeat = new Map(setup.players.map((p) => [p.seat, p.name]));
    for (const seat of setup.seats) {
      players[seat] = {
        name: nameBySeat.get(seat) ?? `Seat ${seat + 1}`, connected: true, chips: stack, out: false,
        hole: [], folded: false, allIn: false, committed: 0, contributed: 0, acted: false, canRaise: true, said: null,
        stats: newStats(),
      };
    }
    const s: HState = {
      players, hand: null, handNo: 0, stack, startBlinds: start, blindsEvery,
      over: false, winner: null, timer: initTimer(setup.options?.timer), skill: initSkill(setup.options?.skill), log: [],
    };
    log(s, `Texas Hold'em — ${setup.seats.length} players, ${stack} chips each, blinds ${start[0]}/${start[1]}.`);
    startHand(s, ctx.rng);
    return s;
  },

  act(s, seat, msg, ctx) {
    if (!s.players[seat]) return fail('You are not in this game.');
    if (msg.type === 'action') return act(s, seat, String(msg.action ?? ''), Number(msg.to));
    if (msg.type === 'nextHand') return nextHand(s, ctx.rng);
  },

  tick(s, ctx) {
    return runTimer(s.timer, () => turnKey(s), ctx.now, () => onTimeout(s, ctx.rng));
  },

  onDisconnect(s, seat) {
    const p = s.players[seat];
    if (p) p.connected = false;
  },
  onReconnect(s, seat) {
    const p = s.players[seat];
    if (p) p.connected = true;
  },

  view,

  result(s): GameOutcome {
    return { over: s.over, winners: s.over && s.winner !== null ? [s.winner] : [] };
  },

  bot(s, seat, ctx) {
    const h = s.hand;
    if (s.over || !h || h.result || h.toAct !== seat) return null;
    return holdemBot(view(s, seat) as unknown as BotView, s.skill, ctx.rng);
  },
};
