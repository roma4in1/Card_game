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
import { initSkill, SKILL_OPTION, CASUAL, STEADY } from '../../platform/skill.ts';

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
  skill: number; // how hard the bots play (1 casual … 3 sharp)
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
// Endgame solver — exact play once the deck is short enough to see to the end.
//
// The information here is unusually friendly: both hands are PUBLIC (each is 1..13 less
// the cards spent, and every bid is revealed), so the only thing left unknown is the
// order of the prizes still to come. That makes the last few rounds a small, fully
// specified game, and small enough to solve outright rather than guess at.
//
// Each round is a simultaneous move, so it is a matrix game and its solution is a MIXED
// strategy — there is no single best card, and any deterministic rule can be read and
// beaten. Backward induction gives the exact value of every reachable position; Brown's
// fictitious play solves the matrix at each one and hands back the mixture to bid from.
//
// It maximises the final MARGIN rather than the probability of winning. The two only come
// apart when a match is already decided, which `decidedAlready` catches separately.
// ---------------------------------------------------------------------------

const ENDGAME_CARDS = 5; // solve once each hand is down to this many
const FP_ITERATIONS = 600; // fictitious-play sweeps per genuinely mixed matrix

export const bit = (card: number) => 1 << (card - 1);
function bitsOf(mask: number): number[] {
  const out: number[] = [];
  for (let c = 1; c <= CARDS; c++) if (mask & bit(c)) out.push(c);
  return out;
}

/** Solve a zero-sum matrix game from the row player's side. Fictitious play: each side
 *  repeatedly best-responds to the other's play so far, which converges to the value for
 *  zero-sum games. Returns that value and the row player's mixture over its bids. */
function solveMatrix(M: number[][]): { value: number; mix: number[] } {
  const rows = M.length;
  const cols = M[0].length;
  if (rows === 1 && cols === 1) return { value: M[0][0], mix: [1] };

  // Most positions have a saddle point — a bid that is best whatever they do. Where
  // maximin meets minimax the game has a pure solution and an exact value, so take it
  // rather than letting fictitious play creep up on a number we already know.
  const rowMins = M.map((r) => Math.min(...r));
  const colMaxs = M[0].map((_, j) => Math.max(...M.map((r) => r[j])));
  const maximin = Math.max(...rowMins);
  const minimax = Math.min(...colMaxs);
  if (maximin === minimax) {
    const mix = new Array(rows).fill(0);
    mix[rowMins.indexOf(maximin)] = 1;
    return { value: maximin, mix };
  }

  const rowGain = new Array(cols).fill(0); // what each column has scored against our play
  const colGain = new Array(rows).fill(0); // what each row has scored against theirs
  const played = new Array(rows).fill(0);
  for (let t = 0; t < FP_ITERATIONS; t++) {
    let br = 0;
    for (let i = 1; i < rows; i++) if (colGain[i] > colGain[br]) br = i;
    played[br] += 1;
    for (let j = 0; j < cols; j++) rowGain[j] += M[br][j];
    let bc = 0;
    for (let j = 1; j < cols; j++) if (rowGain[j] < rowGain[bc]) bc = j;
    for (let i = 0; i < rows; i++) colGain[i] += M[i][bc];
  }
  // The two running bests bracket the true value from either side; take the midpoint.
  // The two running bests bracket the true value from either side; the midpoint is the
  // best estimate, and it can never sit outside the exact maximin/minimax bounds.
  const upper = Math.max(...colGain) / FP_ITERATIONS;
  const lower = Math.min(...rowGain) / FP_ITERATIONS;
  const value = Math.min(minimax, Math.max(maximin, (upper + lower) / 2));
  return { value, mix: played.map((n) => n / FP_ITERATIONS) };
}

/** Exact value of a position, and the mixture to bid from. `pot` is what is on the table
 *  now; `unseen` is every prize still face-down. */
export function solveEndgame(
  handMe: number,
  handFoe: number,
  unseen: number,
  pot: number,
  memo: Map<string, { value: number; mix: number[] }>,
): { value: number; mix: number[] } {
  const key = `${handMe}:${handFoe}:${unseen}:${pot}`;
  const hit = memo.get(key);
  if (hit) return hit;

  const mine = bitsOf(handMe);
  const theirs = bitsOf(handFoe);
  const nextPrizes = bitsOf(unseen);
  const M: number[][] = [];
  for (const a of mine) {
    const row: number[] = [];
    for (const b of theirs) {
      const immediate = a > b ? pot : b > a ? -pot : 0;
      let rest = 0;
      if (nextPrizes.length) {
        // The next prize is equally likely to be any of the ones still face-down.
        for (const p of nextPrizes) {
          rest += solveEndgame(handMe & ~bit(a), handFoe & ~bit(b), unseen & ~bit(p), (a === b ? pot : 0) + p, memo).value;
        }
        rest /= nextPrizes.length;
      }
      // A tie on the very last round carries a pot that is never awarded — worth nothing.
      row.push(immediate + rest);
    }
    M.push(row);
  }
  const solved = solveMatrix(M);
  memo.set(key, solved);
  return solved;
}

// ---------------------------------------------------------------------------
// Bot — spends in proportion to what is left, and reads the opponent's hand.
//
// The old bot bid whatever card sat nearest the pot's face value, which is a losing rule:
// early on it burns a 9 on a 9 that is only the fourth-best prize still to come, and late
// on it has nothing left for the prizes that matter.
//
// This one ranks the pot against every prize NOT yet turned over — all public, since the
// deck is 1..13 and you have seen the ones that have gone — and spends the card of the
// matching rank. If this pot is the second-richest thing left, it plays its second-best
// card. It then checks the opponent's remaining hand (equally public, being 1..13 minus
// what they have spent) and, where it can, shades down to the cheapest card that still
// beats what they would play by the same reasoning: winning a prize by one point leaves
// the better card in hand. Prizes it cannot win economically it concedes with its lowest
// card rather than throwing a good one away.
// ---------------------------------------------------------------------------

function botMove(s: SBState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.phase !== 'bid') return null;
  const pid = s.order.indexOf(seat);
  if (pid < 0 || s.bids[pid] !== null || !s.hands[pid].length) return null;

  const mine = [...s.hands[pid]].sort((a, b) => b - a); // best first
  const theirs = [...s.hands[1 - pid]].sort((a, b) => b - a);
  if (mine.length === 1) return { type: 'bid', card: mine[0] };

  // Casual: bids at random. Unreadable, but it throws its best cards away on scraps.
  if (s.skill <= CASUAL) return { type: 'bid', card: mine[Math.floor(rng() * mine.length)] };
  // Steady: spends whatever card sits nearest the pot's face value — the obvious rule,
  // and a losing one, since it burns a 9 on a 9 that is only the fourth prize left.
  if (s.skill <= STEADY) {
    const target = sum(s.pot);
    const ranked = [...mine].sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    return { type: 'bid', card: ranked[Math.min(ranked.length - 1, Math.floor(rng() * Math.min(3, ranked.length)))] };
  }

  // Every prize still to be turned over, plus the one on the table. Revealed prizes are
  // public — they have each been played for — so this is deduction, not peeking.
  const revealed = new Set(s.prizes.slice(0, s.round + 1));
  const unseen = s.prizes.filter((v) => !revealed.has(v));
  const potTotal = sum(s.pot);

  // Short enough to see to the end: stop guessing and solve it.
  if (mine.length <= ENDGAME_CARDS) {
    const lead = s.scores[pid] - s.scores[1 - pid];
    const stillOnTable = potTotal + unseen.reduce((a, b) => a + b, 0);
    if (lead > stillOnTable) return { type: 'bid', card: mine[mine.length - 1] }; // already won; spend nothing
    const maskOf = (cards: number[]) => cards.reduce((m, c) => m | bit(c), 0);
    const { mix } = solveEndgame(maskOf(mine), maskOf(theirs), maskOf(unseen), potTotal, new Map());
    // Bid from the equilibrium mixture — a fixed choice here would be readable.
    const order = [...mine].sort((a, b) => a - b); // solveEndgame enumerates ascending
    let roll = rng();
    for (let i = 0; i < order.length; i++) {
      roll -= mix[i] ?? 0;
      if (roll <= 0) return { type: 'bid', card: order[i] };
    }
    return { type: 'bid', card: order[order.length - 1] };
  }
  // Where this pot ranks among what remains: 0 = the richest thing still on offer.
  const rank = unseen.filter((v) => v > potTotal).length;
  const target = mine[Math.min(rank, mine.length - 1)];

  // What they would spend if they reasoned the same way — their card of the same rank.
  const predicted = theirs[Math.min(rank, theirs.length - 1)];
  let pick = target;
  if (target > predicted) {
    // Winning is affordable: shade down to the cheapest card that still takes it, and
    // keep the better one back for a richer pot.
    const cheapest = mine.filter((c) => c > predicted).sort((a, b) => a - b)[0];
    if (cheapest !== undefined) pick = cheapest;
  } else if (potTotal <= (unseen.length ? unseen.reduce((a, b) => a + b, 0) / unseen.length : potTotal)) {
    // Not worth a fight, and below the average prize still to come: concede it cheaply.
    pick = mine[mine.length - 1];
  }

  // A pinch of noise, or a human reads the rule off two rounds of play and bids one over.
  if (rng() < 0.18) {
    const i = mine.indexOf(pick);
    const shift = rng() < 0.5 ? -1 : 1;
    const j = Math.max(0, Math.min(mine.length - 1, i + shift));
    pick = mine[j];
  }
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
  options: [SKILL_OPTION],

  validateStart(seats) {
    return seats.length === 2 ? null : 'Sealed Bids is a two-player duel.';
  },

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): SBState {
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
      skill: initSkill(setup.options?.skill),
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
