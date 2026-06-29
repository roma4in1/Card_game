// games/guess-player/game.ts — "Guess the Player", a Wordle-style football deduction
// game (1–6 players). Everyone races to identify the SAME secret footballer. Each guess
// is a real player from the injected bank (players.json); the server compares it to the
// target and returns per-attribute feedback (nationality / position / league / value
// arrow / era / status). Fewest guesses wins. Real-time: players guess at their own pace.
//
// HIDDEN-INFO but symmetric: `view` never reveals the target, and a player only ever sees
// their OWN guess grid — opponents' guess COUNTS only, never their guesses.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { tierOf } from '../../../decoy.cjs'; // shared value-tier buckets (consistent with decoy scoring)

const MAX_SEATS = 8;

export interface PlayerCard {
  name: string;
  nationality: string;
  positions: string[];
  leagues: string[];
  marketValue: number | null;
  status: 'active' | 'retired';
  eraOfPlay: string;
}

const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);
const normName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ');
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const overlaps = (a: string[], b: string[]) => a.some((x) => b.includes(x));

type Cat = 'hit' | 'partial' | 'miss' | 'none';
type Dir = 'higher' | 'lower' | 'equal' | 'unknown';
export interface Feedback {
  exact: boolean;
  nationality: 'hit' | 'miss';
  position: Cat;
  league: Cat;
  value: Dir; // direction of the TARGET's value relative to the guess
  era: 'hit' | 'miss';
  status: 'hit' | 'miss';
}

/** Compare a guessed player to the target, the single source of guess feedback. */
export function compare(guess: PlayerCard, target: PlayerCard): Feedback {
  const position: Cat = sameSet(guess.positions, target.positions) ? 'hit' : overlaps(guess.positions, target.positions) ? 'partial' : 'miss';
  const league: Cat = !guess.leagues.length || !target.leagues.length
    ? 'none'
    : sameSet(guess.leagues, target.leagues) ? 'hit' : overlaps(guess.leagues, target.leagues) ? 'partial' : 'miss';
  let value: Dir = 'unknown';
  if (guess.marketValue != null && target.marketValue != null) {
    value = tierOf(guess.marketValue) === tierOf(target.marketValue) ? 'equal' : target.marketValue > guess.marketValue ? 'higher' : 'lower';
  }
  return {
    exact: normName(guess.name) === normName(target.name),
    nationality: guess.nationality === target.nationality ? 'hit' : 'miss',
    position,
    league,
    value,
    era: guess.eraOfPlay === target.eraOfPlay ? 'hit' : 'miss',
    status: guess.status === target.status ? 'hit' : 'miss',
  };
}

interface GPPlayer { name: string; connected: boolean }
interface GuessEntry {
  name: string;
  nationality: string;
  positions: string[];
  leagues: string[];
  marketValue: number | null;
  eraOfPlay: string;
  status: 'active' | 'retired';
  fb: Feedback;
}

export interface GPState {
  players: (GPPlayer | null)[]; // by seat
  order: number[];
  np: number;
  roundsTotal: number;
  roundNo: number;
  targetIdx: number; // SECRET
  guesses: GuessEntry[][]; // by player-index
  solvedIn: (number | null)[]; // by pid: guess count when solved
  solveSeq: (number | null)[]; // by pid: solve order (1,2,…) — earliest breaks a guess-count tie
  out: boolean[]; // by pid: hit the limit or gave up
  solvedCount: number; // solvers so far this round
  limit: number; // max guesses (0 = unlimited)
  roundSecs: number; // round time limit (0 = off)
  roundDeadline: number; // epoch-ms (0 = none)
  roundWins: number[]; // by pid
  totalGuesses: number[]; // by pid, cumulative across the match (tiebreak)
  roundWinner: number | null; // seat
  lastTargetName: string | null;
  roundOver: boolean;
  over: boolean;
  winners: number[]; // seats
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: GPState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: GPState, seat: number) => s.players[seat]!.name;
const isDone = (s: GPState, pid: number) => s.solvedIn[pid] != null || s.out[pid];

function matchWinners(s: GPState): number[] {
  const best = Math.max(...s.roundWins);
  if (best === 0) return [];
  let pids = s.order.map((_, i) => i).filter((i) => s.roundWins[i] === best);
  if (pids.length > 1) {
    const fewest = Math.min(...pids.map((i) => s.totalGuesses[i]));
    pids = pids.filter((i) => s.totalGuesses[i] === fewest);
  }
  return pids.map((i) => s.order[i]);
}

export function createGuessPlayer(playerBank: PlayerCard[]): GameDef<GPState> {
  const bank = playerBank;
  const byName = new Map(bank.map((p, i) => [normName(p.name), i]));
  // Targets are only players WITH a market value, so the value ↑/↓ hint always works.
  // (Retired/null-value players can still be guessed — they just aren't the answer.)
  const valuedIdx = bank.map((_, i) => i).filter((i) => bank[i].marketValue != null);
  const pickTarget = (rng: Rng) => (valuedIdx.length ? valuedIdx[randInt(rng, valuedIdx.length)] : randInt(rng, bank.length));

  function endRound(s: GPState) {
    s.roundDeadline = 0;
    s.lastTargetName = bank[s.targetIdx].name;
    // winner: fewest guesses among solvers, earliest solve breaks the tie
    let winPid: number | null = null;
    for (let pid = 0; pid < s.np; pid++) {
      if (s.solvedIn[pid] == null) continue;
      if (winPid == null || s.solvedIn[pid]! < s.solvedIn[winPid]! || (s.solvedIn[pid] === s.solvedIn[winPid] && s.solveSeq[pid]! < s.solveSeq[winPid]!)) {
        winPid = pid;
      }
    }
    s.roundWinner = winPid != null ? s.order[winPid] : null;
    if (winPid != null) {
      s.roundWins[winPid] += 1;
      log(s, `Round ${s.roundNo}: ${nameOf(s, s.order[winPid])} got ${s.lastTargetName} in ${s.solvedIn[winPid]} — best this round.`);
    } else {
      log(s, `Round ${s.roundNo}: nobody found ${s.lastTargetName}.`);
    }
    if (s.roundNo >= s.roundsTotal) {
      s.over = true;
      s.winners = matchWinners(s);
      const names = s.winners.map((seat) => nameOf(s, seat)).join(' & ');
      log(s, `🏆 Match over — ${s.winners.length === 0 ? 'no winner' : s.winners.length > 1 ? `tie: ${names}` : `${names} wins`}.`);
    } else {
      s.roundOver = true;
    }
  }

  function maybeEndRound(s: GPState) {
    if (s.order.every((_, pid) => isDone(s, pid))) endRound(s);
  }

  function startRound(s: GPState, ctx: GameContext) {
    s.targetIdx = pickTarget(ctx.rng);
    s.guesses = s.order.map(() => []);
    s.solvedIn = s.order.map(() => null);
    s.solveSeq = s.order.map(() => null);
    s.out = s.order.map(() => false);
    s.solvedCount = 0;
    s.roundWinner = null;
    s.lastTargetName = null;
    s.roundOver = false;
    s.roundDeadline = s.roundSecs > 0 ? ctx.now + s.roundSecs * 1000 : 0;
  }

  function submitGuess(s: GPState, seat: number, name: unknown): ActionResult {
    if (s.roundOver || s.over) return fail('The round is between rounds.');
    const pid = s.order.indexOf(seat);
    if (pid < 0) return fail('You are not in this match.');
    if (s.solvedIn[pid] != null) return fail('You already solved it.');
    if (s.out[pid]) return fail("You're out of this round.");
    const idx = byName.get(normName(String(name ?? '')));
    if (idx === undefined) return fail('Pick a real player from the bank.');
    const guessed = bank[idx];
    const fb = compare(guessed, bank[s.targetIdx]);
    s.guesses[pid].push({
      name: guessed.name, nationality: guessed.nationality, positions: guessed.positions, leagues: guessed.leagues,
      marketValue: guessed.marketValue, eraOfPlay: guessed.eraOfPlay, status: guessed.status, fb,
    });
    s.totalGuesses[pid] += 1;
    if (fb.exact) {
      s.solvedIn[pid] = s.guesses[pid].length;
      s.solveSeq[pid] = ++s.solvedCount;
      log(s, `${nameOf(s, seat)} solved it in ${s.solvedIn[pid]}!`);
    } else if (s.limit > 0 && s.guesses[pid].length >= s.limit) {
      s.out[pid] = true;
      log(s, `${nameOf(s, seat)} used all ${s.limit} guesses.`);
    }
    maybeEndRound(s);
    return ok;
  }

  function giveUp(s: GPState, seat: number): ActionResult {
    if (s.roundOver || s.over) return ok;
    const pid = s.order.indexOf(seat);
    if (pid < 0 || isDone(s, pid)) return ok;
    s.out[pid] = true;
    log(s, `${nameOf(s, seat)} gave up.`);
    maybeEndRound(s);
    return ok;
  }

  function nextRound(s: GPState, ctx: GameContext): ActionResult {
    if (!s.roundOver || s.over) return fail('No round to advance.');
    s.roundNo += 1;
    startRound(s, ctx);
    log(s, `Round ${s.roundNo} of ${s.roundsTotal} — a new secret player. Guess away!`);
    return ok;
  }

  return {
    id: 'guess-player',
    name: 'Guess the Player',
    blurb: 'Wordle for footballers: guess real players and get attribute hints (nationality, position, value ↑/↓…). Fewest guesses wins.',
    minPlayers: 1,
    maxPlayers: 6,
    options: [
      { key: 'rounds', label: 'Rounds', min: 1, max: 7, step: 1, default: 3 },
      { key: 'limit', label: 'Guess limit (0=∞)', min: 0, max: 15, step: 1, default: 8 },
      { key: 'roundSecs', label: 'Round timer (s, 0=off)', min: 0, max: 300, step: 30, default: 0 },
    ],

    create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): GPState {
      const order = [...setup.seats];
      const players: (GPPlayer | null)[] = new Array(MAX_SEATS).fill(null);
      for (const pi of setup.players) players[pi.seat] = { name: pi.name, connected: true };
      const s: GPState = {
        players,
        order,
        np: order.length,
        roundsTotal: Math.min(7, Math.max(1, Math.round(setup.options?.rounds ?? 3))),
        roundNo: 1,
        targetIdx: 0,
        guesses: [],
        solvedIn: [],
        solveSeq: [],
        out: [],
        solvedCount: 0,
        limit: Math.min(15, Math.max(0, Math.round(setup.options?.limit ?? 8))),
        roundSecs: Math.min(300, Math.max(0, Math.round(setup.options?.roundSecs ?? 0))),
        roundDeadline: 0,
        roundWins: new Array(order.length).fill(0),
        totalGuesses: new Array(order.length).fill(0),
        roundWinner: null,
        lastTargetName: null,
        roundOver: false,
        over: false,
        winners: [],
        log: [],
      };
      startRound(s, ctx);
      log(s, `Round 1 of ${s.roundsTotal}. Guess the secret player${s.limit ? ` — ${s.limit} tries each` : ''}!`);
      return s;
    },

    act(s, seat, msg, ctx) {
      switch (msg.type) {
        case 'submitGuess':
          return submitGuess(s, seat, msg.name);
        case 'giveUp':
          return giveUp(s, seat);
        case 'nextRound':
          return nextRound(s, ctx);
      }
    },

    tick(s, ctx) {
      if (s.over || s.roundOver || s.roundDeadline === 0 || ctx.now < s.roundDeadline) return false;
      // time's up: everyone who hasn't solved is out, and the round resolves
      for (let pid = 0; pid < s.np; pid++) if (s.solvedIn[pid] == null) s.out[pid] = true;
      log(s, 'Time! The round is over.');
      endRound(s);
      return true;
    },

    onDisconnect(s, seat) {
      const p = s.players[seat];
      if (p) p.connected = false;
    },
    onReconnect(s, seat) {
      const p = s.players[seat];
      if (p) p.connected = true;
    },

    view(s, seat) {
      const pid = seat !== null ? s.order.indexOf(seat) : -1;
      const me = seat !== null && s.players[seat] ? s.players[seat]! : null;
      const reveal = s.over || s.roundOver || (pid >= 0 && s.solvedIn[pid] != null);
      const opponents = s.order
        .map((seatNo, p) => ({ seatNo, p }))
        .filter(({ seatNo }) => seatNo !== seat)
        .map(({ seatNo, p }) => ({
          seat: seatNo,
          name: s.players[seatNo]!.name,
          connected: s.players[seatNo]!.connected,
          count: s.guesses[p].length,
          solved: s.solvedIn[p] != null,
          solvedIn: s.solvedIn[p],
          out: s.out[p],
          roundWins: s.roundWins[p],
        }));
      const canGuess = pid >= 0 && !s.roundOver && !s.over && s.solvedIn[pid] == null && !s.out[pid];
      return {
        game: 'guess-player',
        phase: s.over ? 'done' : s.roundOver ? 'roundOver' : 'playing',
        over: s.over,
        roundNo: s.roundNo,
        roundsTotal: s.roundsTotal,
        limit: s.limit,
        roundDeadline: s.roundSecs > 0 && !reveal ? s.roundDeadline : 0,
        opponents,
        target: reveal ? bank[s.targetIdx].name : null,
        roundWinner: reveal ? s.roundWinner : null,
        winners: s.over ? s.winners : null,
        matchWinner: null,
        log: s.log.slice(-15),
        you: me
          ? {
              seat,
              guesses: pid >= 0 ? s.guesses[pid] : [],
              solved: pid >= 0 && s.solvedIn[pid] != null,
              solvedIn: pid >= 0 ? s.solvedIn[pid] : null,
              out: pid >= 0 && s.out[pid],
              roundWins: pid >= 0 ? s.roundWins[pid] : 0,
              remaining: s.limit > 0 && pid >= 0 ? Math.max(0, s.limit - s.guesses[pid].length) : null,
              canGuess,
              allNames: canGuess ? bank.map((p) => p.name) : undefined,
            }
          : { seat: seat ?? -1, spectator: true },
      };
    },

    result(s): GameOutcome {
      return { over: s.over, winners: s.over ? s.winners : [] };
    },

    bot(s, seat, ctx) {
      if (s.over || s.roundOver) return null;
      const pid = s.order.indexOf(seat);
      if (pid < 0 || s.solvedIn[pid] != null || s.out[pid]) return null;
      const cap = s.limit > 0 ? s.limit : 8;
      if (s.guesses[pid].length >= cap) return { type: 'giveUp' };
      return { type: 'submitGuess', name: bank[randInt(ctx.rng, bank.length)].name };
    },
  };
}
