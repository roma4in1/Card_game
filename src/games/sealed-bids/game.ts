// games/sealed-bids/game.ts — "Sealed Bids", a two-player blind-auction duel.
//
// Thirteen prizes come up one at a time. Both players hold the SAME hand (1–13) and
// bid one card at the same time; the higher bid takes the prize. Both bids are spent
// either way — that's the whole game: overbid and you win a prize you didn't need with
// a card you'll miss later, underbid and you've thrown a card away for nothing. Tie and
// nobody takes it: the prize stays on the table and rides on top of the next one.
//
// The ONE secret is a bid in flight. `view` says whether your opponent has committed,
// never what they committed. Everything else is public — the prize, both scores, and
// which cards each player has already spent — because it is all deducible from the
// cards played anyway, and doing that deduction IS the game. Hiding it would only make
// players keep notes on paper.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';

const CARDS = 13; // hands are 1..13, and there are 13 prizes
const REVEAL_MS = 2200; // how long both bids stay face-up before the next prize

function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface SBPlayer {
  name: string;
  connected: boolean;
}
/** The round just resolved, kept face-up for a beat so both players see it. */
interface LastRound {
  prize: number[]; // every prize value that was riding on it
  bids: number[]; // by player-index
  winner: number | null; // player-index, or null on a tie
}

export interface SBState {
  players: (SBPlayer | null)[]; // by seat (length 8)
  order: number[]; // seat per player-index
  np: number;
  prizes: number[]; // the shuffled prize deck — order is SECRET beyond the current one
  round: number; // 0..CARDS-1
  pot: number[]; // prize values riding on this round (a tie carries them forward)
  hands: number[][]; // by player-index: the cards still in hand
  bids: (number | null)[]; // by player-index: this round's sealed bid
  scores: number[]; // by player-index
  last: LastRound | null;
  revealAt: number; // when the face-up reveal ends
  phase: 'bid' | 'reveal' | 'done';
  over: boolean;
  winners: number[]; // seats on the winning side
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: SBState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: SBState, pid: number) => s.players[s.order[pid]]!.name;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Round flow
// ---------------------------------------------------------------------------

function endGame(s: SBState) {
  s.over = true;
  s.phase = 'done';
  const max = Math.max(...s.scores);
  const top = s.scores.map((_, pid) => pid).filter((pid) => s.scores[pid] === max);
  s.winners = top.map((pid) => s.order[pid]);
  const names = top.map((pid) => nameOf(s, pid)).join(', ');
  log(s, `${top.length > 1 ? `Dead heat — shared victory: ${names}` : `🏆 ${names} wins`} on ${max} points.`);
}

/** Both bids are in: award the pot (or carry it on a tie) and hold the reveal. */
function resolveRound(s: SBState, now: number) {
  const bids = s.bids.map((b) => b!) as number[];
  for (let pid = 0; pid < s.np; pid++) s.hands[pid] = s.hands[pid].filter((c) => c !== bids[pid]);

  const potTotal = sum(s.pot);
  const winner = bids[0] === bids[1] ? null : bids[0] > bids[1] ? 0 : 1;
  const prize = [...s.pot];
  if (winner === null) {
    log(s, `Both bid ${bids[0]} — nobody takes the ${potTotal}; it rides on the next prize.`);
  } else {
    s.scores[winner] += potTotal;
    s.pot = [];
    log(s, `${nameOf(s, winner)} bids ${bids[winner]} against ${bids[1 - winner]} and takes ${potTotal} (now ${s.scores[winner]}).`);
  }
  s.last = { prize, bids, winner };
  s.bids = new Array(s.np).fill(null);
  s.phase = 'reveal';
  s.revealAt = now + REVEAL_MS;
}

/** The reveal has been up long enough — turn over the next prize, or end the match. */
function advanceRound(s: SBState): boolean {
  s.round += 1;
  if (s.round >= CARDS) {
    if (s.pot.length) log(s, `The last prize was tied — ${sum(s.pot)} points go unclaimed.`);
    endGame(s);
    return true;
  }
  s.pot.push(s.prizes[s.round]);
  s.phase = 'bid';
  s.last = null;
  return true;
}

function tickState(s: SBState, now: number): boolean {
  if (s.phase !== 'reveal' || now < s.revealAt) return false;
  return advanceRound(s);
}

function bid(s: SBState, pid: number, card: unknown): ActionResult {
  if (s.phase === 'done') return fail('The game is over.');
  if (s.phase === 'reveal') return fail('Wait for the next prize.');
  if (s.bids[pid] !== null) return fail('Your bid is already sealed.');
  const c = Number(card);
  if (!Number.isInteger(c) || !s.hands[pid].includes(c)) return fail('You do not hold that card.');
  s.bids[pid] = c;
  // Deliberately NOT logged — the log is public, and a bid is secret until both are in.
  return ok;
}

// ---------------------------------------------------------------------------
// View — the pending bid is the only secret
// ---------------------------------------------------------------------------

function viewState(s: SBState, seat: number | null): Record<string, unknown> {
  const myPid = seat !== null ? s.order.indexOf(seat) : -1;
  const spent = (pid: number) => {
    const held = new Set(s.hands[pid]);
    return Array.from({ length: CARDS }, (_, i) => i + 1).filter((c) => !held.has(c));
  };

  const players = Array.from({ length: s.np }, (_, pid) => ({
    seat: s.order[pid],
    name: nameOf(s, pid),
    connected: s.players[s.order[pid]]!.connected,
    score: s.scores[pid],
    // Both hands are public knowledge: they are exactly 1..13 minus the cards already
    // bid, and every bid is revealed. Only the bid IN FLIGHT is withheld.
    spent: spent(pid),
    cardsLeft: s.hands[pid].length,
    committed: s.bids[pid] !== null,
  }));

  return {
    game: 'sealed-bids',
    phase: s.phase,
    over: s.over,
    round: s.round + 1,
    rounds: CARDS,
    pot: s.pot,
    potTotal: sum(s.pot),
    players,
    activeSeat: null, // both players act at once
    last: s.phase === 'reveal' && s.last ? { ...s.last, winnerSeat: s.last.winner === null ? null : s.order[s.last.winner] } : null,
    you:
      myPid >= 0
        ? {
            seat,
            pid: myPid,
            hand: [...s.hands[myPid]],
            bid: s.bids[myPid], // your own sealed bid, so the UI can show what you committed
            canBid: s.phase === 'bid' && s.bids[myPid] === null,
          }
        : { seat: seat ?? -1, spectator: true, hand: [] },
    winners: s.over ? s.winners : null,
    log: s.log.slice(-15),
    matchWinner: null,
  };
}

// ---------------------------------------------------------------------------
// Bot — bids around the prize's worth, never quite predictably
// ---------------------------------------------------------------------------

function botMove(s: SBState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.phase !== 'bid') return null;
  const pid = s.order.indexOf(seat);
  if (pid < 0 || s.bids[pid] !== null || !s.hands[pid].length) return null;
  // Spend roughly in proportion to what's on the table, then jitter one step either way
  // so a human can't simply read the pot and bid one higher every round.
  const target = sum(s.pot);
  const ranked = [...s.hands[pid]].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  const pick = ranked[Math.min(ranked.length - 1, Math.floor(rng() * Math.min(3, ranked.length)))];
  return { type: 'bid', card: pick };
}

// ---------------------------------------------------------------------------
// GameDef
// ---------------------------------------------------------------------------

export const sealedBids: GameDef<SBState> = {
  id: 'sealed-bids',
  name: 'Sealed Bids',
  blurb: 'Both bid a card in secret for each prize — highest takes it, and both cards are spent either way.',
  minPlayers: 2,
  maxPlayers: 2,

  validateStart(seats) {
    return seats.length === 2 ? null : 'Sealed Bids is a two-player duel.';
  },

  create(setup: { seats: number[]; players: PlayerInfo[] }, ctx: GameContext): SBState {
    const players: (SBPlayer | null)[] = new Array(8).fill(null);
    for (const pi of setup.players) players[pi.seat] = { name: pi.name, connected: true };
    const deck = Array.from({ length: CARDS }, (_, i) => i + 1);
    const s: SBState = {
      players,
      order: [...setup.seats],
      np: setup.seats.length,
      prizes: shuffle([...deck], ctx.rng),
      round: 0,
      pot: [],
      hands: setup.seats.map(() => [...deck]),
      bids: new Array(setup.seats.length).fill(null),
      scores: new Array(setup.seats.length).fill(0),
      last: null,
      revealAt: 0,
      phase: 'bid',
      over: false,
      winners: [],
      log: [],
    };
    s.pot.push(s.prizes[0]);
    log(s, `${CARDS} prizes, one sealed bid each. First up: ${s.prizes[0]} points.`);
    return s;
  },

  act(s, seat, msg, ctx) {
    const pid = s.order.indexOf(seat);
    if (pid < 0) return fail('You are not in this match.');
    if (msg.type !== 'bid') return;
    const res = bid(s, pid, msg.card);
    if (res.error) return res;
    if (s.bids.every((b) => b !== null)) resolveRound(s, ctx.now);
    return ok;
  },

  tick(s, ctx) {
    return tickState(s, ctx.now);
  },

  onDisconnect(s, seat) {
    const p = s.players[seat];
    if (p) p.connected = false;
  },
  onReconnect(s, seat) {
    const p = s.players[seat];
    if (p) p.connected = true;
  },

  view: viewState,

  result(s): GameOutcome {
    return { over: s.over, winners: s.over ? s.winners : [] };
  },

  bot(s, seat, ctx) {
    return botMove(s, seat, ctx.rng);
  },
};
