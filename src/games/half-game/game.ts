// games/half-game/game.ts — "Half a Game": the cards of a Texas Hold'em hand, without the
// chips. The chips are real and on the table in front of everyone; the app only deals.
//
// Each player gets two hole cards on their own phone, the board comes out a step at a
// time — flop, turn, river — and each step waits until every player still in the hand has
// pressed Ready, so the table can bet in its own time. At the showdown the hands still in
// are turned over, named, and the winner is called. Then the deck is shuffled afresh, the
// dealer button moves on, and the next hand is dealt.
//
// Folding matters even without chips: a folded hand is never shown, and if everyone but
// one folds the hand ends there.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { shuffledDeck, score, describe, bestFive, code } from '../shared/poker.ts';

const MAX_SEATS = 8;

export type Stage = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

interface HGPlayer {
  name: string;
  connected: boolean;
  hole: number[];
  folded: boolean;
  ready: boolean;
}

interface Reveal {
  seat: number;
  hole: string[];
  hand: string;
  best: string[];
}
interface HandResult {
  kind: 'fold' | 'showdown';
  winners: number[];
  reveals: Reveal[];
}

export interface HGState {
  players: (HGPlayer | null)[]; // by seat
  seats: number[];
  handNo: number;
  dealer: number;
  sb: number;
  bb: number;
  deck: number[];
  board: number[];
  stage: Stage;
  result: HandResult | null;
  over: boolean;
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function log(s: HGState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}

const nameOf = (s: HGState, seat: number) => s.players[seat]!.name;
const live = (s: HGState) => s.seats.filter((seat) => !s.players[seat]!.folded);
/** Who has to be ready before the hand moves on: everyone still in it, and at the
 *  showdown everyone at the table, so the next hand waits for the whole table. */
const waitingOn = (s: HGState) => (s.stage === 'showdown' ? s.seats : live(s)).filter((seat) => !s.players[seat]!.ready);

function after(s: HGState, seat: number): number {
  const i = s.seats.indexOf(seat);
  return s.seats[(i + 1) % s.seats.length];
}

function startHand(s: HGState, rng: Rng) {
  s.handNo += 1;
  s.dealer = s.handNo === 1 ? s.seats[Math.floor(rng() * s.seats.length)] : after(s, s.dealer);
  // Heads-up the dealer posts the small blind; otherwise the blinds sit left of the dealer.
  s.sb = s.seats.length === 2 ? s.dealer : after(s, s.dealer);
  s.bb = after(s, s.sb);
  s.deck = shuffledDeck(rng); // a fresh shuffle every hand
  s.board = [];
  s.stage = 'preflop';
  s.result = null;
  for (const seat of s.seats) Object.assign(s.players[seat]!, { hole: [], folded: false, ready: false });
  for (let round = 0; round < 2; round++) {
    for (let seat = after(s, s.dealer), n = 0; n < s.seats.length; seat = after(s, seat), n++) {
      s.players[seat]!.hole.push(s.deck.pop()!);
    }
  }
  log(s, `Hand ${s.handNo}: ${nameOf(s, s.dealer)} deals — ${nameOf(s, s.sb)} small blind, ${nameOf(s, s.bb)} big blind.`);
}

function showdown(s: HGState) {
  s.stage = 'showdown';
  const scores = new Map(live(s).map((seat) => [seat, score([...s.players[seat]!.hole, ...s.board])]));
  const best = Math.max(...scores.values());
  const winners = [...scores].filter(([, v]) => v === best).map(([seat]) => seat);
  const reveals = live(s).map((seat) => {
    const cards = [...s.players[seat]!.hole, ...s.board];
    return { seat, hole: s.players[seat]!.hole.map(code), hand: describe(scores.get(seat)!), best: bestFive(cards).map(code) };
  });
  s.result = { kind: 'showdown', winners, reveals };
  log(s, winners.length === 1
    ? `Showdown: ${nameOf(s, winners[0])} wins with ${describe(best)}.`
    : `Showdown: split between ${winners.map((w) => nameOf(s, w)).join(' and ')} (${describe(best)}).`);
}

/** Everyone who had to be is ready: deal the next step. */
function advance(s: HGState, rng: Rng) {
  for (const seat of s.seats) s.players[seat]!.ready = false;
  if (s.stage === 'showdown') return startHand(s, rng);
  if (s.stage === 'preflop') {
    s.board.push(s.deck.pop()!, s.deck.pop()!, s.deck.pop()!);
    s.stage = 'flop';
  } else if (s.stage === 'flop') {
    s.board.push(s.deck.pop()!);
    s.stage = 'turn';
  } else if (s.stage === 'turn') {
    s.board.push(s.deck.pop()!);
    s.stage = 'river';
  } else return showdown(s);
  log(s, `${s.stage[0].toUpperCase() + s.stage.slice(1)}: ${s.board.map(code).join(' ')}.`);
}

function setReady(s: HGState, seat: number, ready: boolean, rng: Rng): ActionResult {
  const p = s.players[seat]!;
  if (p.folded && s.stage !== 'showdown') return fail('You have folded — the others will deal on.');
  p.ready = ready;
  if (!waitingOn(s).length) advance(s, rng);
  return ok;
}

function fold(s: HGState, seat: number, rng: Rng): ActionResult {
  const p = s.players[seat]!;
  if (s.stage === 'showdown') return fail('The hand is over.');
  if (p.folded) return ok;
  p.folded = true;
  p.ready = false;
  log(s, `${p.name} folds.`);
  const left = live(s);
  if (left.length === 1) {
    s.stage = 'showdown';
    s.result = { kind: 'fold', winners: left, reveals: [] };
    for (const x of s.seats) s.players[x]!.ready = false;
    log(s, `Everyone else folded — ${nameOf(s, left[0])} wins the pot.`);
  } else if (!waitingOn(s).length) advance(s, rng);
  return ok;
}

function view(s: HGState, seat: number | null): Record<string, unknown> {
  const me = seat !== null ? s.players[seat] : null;
  const shown = new Map((s.result?.reveals ?? []).map((r) => [r.seat, r.hole]));
  const waiting = waitingOn(s);
  return {
    game: 'half-game',
    over: s.over,
    phase: s.over ? 'over' : s.stage,
    stage: s.stage,
    handNo: s.handNo,
    board: s.board.map(code),
    players: s.seats.map((x) => {
      const p = s.players[x]!;
      return {
        seat: x, name: p.name, connected: p.connected, folded: p.folded, ready: p.ready,
        holeCount: p.folded ? 0 : p.hole.length, shown: shown.get(x) ?? null,
        dealer: s.dealer === x, blind: s.sb === x ? 'SB' : s.bb === x ? 'BB' : null,
      };
    }),
    waiting: waiting.length,
    result: s.result,
    log: s.log.slice(-15),
    matchWinner: null,
    you: me
      ? {
          seat, hole: me.hole.map(code), folded: me.folded, ready: me.ready,
          mustReady: waiting.includes(seat!),
          made: !me.folded && s.board.length >= 3 ? describe(score([...me.hole, ...s.board])) : null,
        }
      : { seat: seat ?? -1, spectator: true, hole: [] },
  };
}

export const halfGame: GameDef<HGState> = {
  id: 'half-game',
  name: 'Half a Game',
  blurb: "Texas Hold'em cards without the chips: bring real ones. Deal, flop, turn, river — everyone taps Ready to go on.",
  minPlayers: 2,
  maxPlayers: MAX_SEATS,

  create(setup: { seats: number[]; players: PlayerInfo[] }, ctx: GameContext): HGState {
    const players: (HGPlayer | null)[] = new Array(MAX_SEATS).fill(null);
    const nameBySeat = new Map(setup.players.map((p) => [p.seat, p.name]));
    for (const seat of setup.seats) {
      players[seat] = { name: nameBySeat.get(seat) ?? `Seat ${seat + 1}`, connected: true, hole: [], folded: false, ready: false };
    }
    const s: HGState = {
      players, seats: [...setup.seats].sort((a, b) => a - b), handNo: 0, dealer: setup.seats[0], sb: -1, bb: -1,
      deck: [], board: [], stage: 'preflop', result: null, over: false, log: [],
    };
    startHand(s, ctx.rng);
    return s;
  },

  act(s, seat, msg, ctx) {
    if (!s.players[seat]) return fail('You are not in this game.');
    if (s.over) return fail('The game is over.');
    switch (msg.type) {
      case 'ready':
        return setReady(s, seat, msg.ready !== false, ctx.rng);
      case 'fold':
        return fold(s, seat, ctx.rng);
      case 'endGame':
        // The client offers this to the host; ending a session for the table is not a secret.
        s.over = true;
        log(s, `${nameOf(s, seat)} ended the game.`);
        return ok;
    }
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
    return { over: s.over, winners: [] };
  },

  // A seat with nobody at it — a player who left — folds its hand and never holds the
  // table up. There are no chips here for a bot to play with.
  bot(s, seat) {
    const p = s.players[seat];
    if (!p || s.over) return null;
    if (!p.folded && s.stage !== 'showdown') return { type: 'fold' };
    if (s.stage === 'showdown' && !p.ready) return { type: 'ready' };
    return null;
  },
};
