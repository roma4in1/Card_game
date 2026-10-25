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

export const MAX_SEATS = 8;

export const STACK_OPTION: GameOption = { key: 'stack', label: 'Starting chips', min: 500, max: 5000, step: 500, default: 1000 };
export const BLINDS_OPTION: GameOption = { key: 'blindsEvery', label: 'Blinds up every (hands, 0=never)', min: 0, max: 30, step: 5, default: 10 };

// The blind schedule for a 500-chip stack; bigger stacks scale it up in proportion, so a
// game lasts about as many levels whatever the stack. Past the last level, keep doubling.
const LEVELS: [number, number][] = [
  [5, 10], [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [500, 1000],
];

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
}

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
  result: HandResult | null; // set once the hand is over
}

export interface HState {
  players: (HPlayer | null)[]; // by seat
  hand: Hand | null;
  handNo: number;
  stack: number;
  blindsEvery: number;
  over: boolean;
  winner: number | null;
  timer: Timer;
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

export function blindsFor(stack: number, blindsEvery: number, handNo: number): [number, number] {
  const level = blindsEvery > 0 ? Math.floor((handNo - 1) / blindsEvery) : 0;
  const scale = Math.max(1, Math.round(stack / 500));
  const last = LEVELS[LEVELS.length - 1];
  const [sb, bb] = level < LEVELS.length ? LEVELS[level] : [last[0] * 2 ** (level - LEVELS.length + 1), last[1] * 2 ** (level - LEVELS.length + 1)];
  return [sb * scale, bb * scale];
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
  const blinds = blindsFor(s.stack, s.blindsEvery, s.handNo);
  const prev = s.hand;
  if (prev && blinds[1] !== prev.blinds[1]) log(s, `⬆️ Blinds up: ${blinds[0]}/${blinds[1]}.`);

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
  const hand: Hand = {
    no: s.handNo, dealer, sb, bb, blinds,
    deck: shuffledDeck(rng), board: [], street: 'preflop',
    toAct: -1, currentBet: blinds[1], minRaise: blinds[1],
    participants: live, result: null,
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
  const blinds = h ? h.blinds : blindsFor(s.stack, s.blindsEvery, 1);
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
    };
  });

  const v: Record<string, unknown> = {
    game: 'texas-holdem',
    over: s.over,
    phase: s.over ? 'over' : h?.result ? 'handover' : h?.street ?? 'preflop',
    handNo: s.handNo,
    blinds,
    nextBlinds: s.blindsEvery > 0 ? blindsFor(s.stack, s.blindsEvery, s.handNo + s.blindsEvery - ((s.handNo - 1) % s.blindsEvery)) : null,
    blindsIn: s.blindsEvery > 0 ? s.blindsEvery - ((s.handNo - 1) % s.blindsEvery) : null,
    pot,
    board: h ? h.board.map(code) : [],
    players,
    activeSeat: h && !h.result && h.toAct >= 0 ? h.toAct : null,
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
// Bot — a placeholder that keeps a seat moving: checks when it can, calls small bets,
// folds to big ones. It never starts the next hand; a person does that.
// ---------------------------------------------------------------------------

function botMove(s: HState, seat: number): Record<string, unknown> | null {
  const h = s.hand;
  if (s.over || !h || h.result || h.toAct !== seat) return null;
  const p = s.players[seat]!;
  const toCall = h.currentBet - p.committed;
  if (toCall <= 0) return { type: 'action', action: 'check' };
  if (toCall <= Math.max(h.blinds[1] * 2, p.chips * 0.1)) return { type: 'action', action: 'call' };
  return { type: 'action', action: 'fold' };
}

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
  options: [STACK_OPTION, BLINDS_OPTION, TIMER_OPTION],

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): HState {
    const stack = Math.max(STACK_OPTION.min, Math.min(STACK_OPTION.max, Math.round(Number(setup.options?.stack) || STACK_OPTION.default)));
    const every = Math.max(0, Math.min(BLINDS_OPTION.max, Math.round(Number(setup.options?.blindsEvery ?? BLINDS_OPTION.default))));
    const players: (HPlayer | null)[] = new Array(MAX_SEATS).fill(null);
    const nameBySeat = new Map(setup.players.map((p) => [p.seat, p.name]));
    for (const seat of setup.seats) {
      players[seat] = {
        name: nameBySeat.get(seat) ?? `Seat ${seat + 1}`, connected: true, chips: stack, out: false,
        hole: [], folded: false, allIn: false, committed: 0, contributed: 0, acted: false, canRaise: true, said: null,
      };
    }
    const s: HState = {
      players, hand: null, handNo: 0, stack, blindsEvery: Number.isFinite(every) ? every : BLINDS_OPTION.default,
      over: false, winner: null, timer: initTimer(setup.options?.timer), log: [],
    };
    log(s, `Texas Hold'em — ${setup.seats.length} players, ${stack} chips each.`);
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

  bot(s, seat) {
    return botMove(s, seat);
  },
};
