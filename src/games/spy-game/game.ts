// games/spy-game/game.ts — "Spy Game", a hidden-role football clue game (3–8 players).
//
// Pure plugin built by `createSpyGame(wordBank)` so the word bank is INJECTED, never
// hardcoded here. The non-spies all share one secret player (the target); the spy gets
// a different-but-similar decoy for cover. Per-player `view` redaction is the whole
// point: a non-spy never sees the decoy or who the spy is, and the spy never sees the
// target — until the end-of-match reveal. Same secrecy discipline as Win or Die's
// hidden hole cards. The server owns all randomness (rng via the per-call context).

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
// Single source of truth for decoy selection — shared with the standalone build/tests.
import { pickDecoy, scoreDecoy, sharesPosition } from '../../../decoy.cjs';

export const MAX_SEATS = 8;
export const ROUNDS = 3;

export interface PlayerCard {
  name: string;
  nationality: string;
  positions: string[]; // fine codes: GK/CB/LB/RB/CDM/CM/CAM/LW/RW/ST
  leagues: string[];
  marketValue: number | null;
  status: 'active' | 'retired';
  eraOfPlay: string;
}

const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);
function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sanitizeWord(word: unknown): string {
  return String(word ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
}

type Phase = 'clues' | 'interlude' | 'voting' | 'spyGuess' | 'done';

interface SpyPlayer {
  name: string;
  connected: boolean;
  isSpy: boolean;
  secret: string; // own football player NAME (target for non-spies, decoy for the spy)
  hasVoted: boolean;
  vote: number | null; // seat voted for
  wantsVote: boolean | null; // interlude choice (secret): call an early vote, or keep clueing
}

interface Clue {
  seat: number;
  name: string;
  word: string;
  round: number;
}

export interface SpyState {
  players: (SpyPlayer | null)[]; // length MAX_SEATS
  order: number[];
  spyId: number;
  targetIdx: number; // word-bank index of the shared target
  decoyIdx: number; // word-bank index of the spy's decoy
  phase: Phase;
  round: number; // 1..3
  current: number; // index into order for whose clue
  clueLog: Clue[];
  caughtId: number | null; // seat caught by the vote (null = tie/no plurality)
  votesRevealed: boolean;
  shortlist: number[]; // word-bank indices (the bot's candidate pool when caught)
  guessIdx: number | null; // bank index the spy's guess resolved to (null if not a known player)
  guessName: string | null; // the exact name the spy typed
  guessCorrect: boolean | null;
  over: boolean;
  winners: number[]; // seats on the winning side
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function log(s: SpyState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: SpyState, seat: number) => s.players[seat]!.name;
const seated = (s: SpyState): number[] => s.order.filter((seat) => s.players[seat]);

// ---------------------------------------------------------------------------
// Setup (decoy selection lives in decoy.cjs — the single source of truth)
// ---------------------------------------------------------------------------

/** Choose the spy's decoy for a target, returning its bank index. Defers to decoy.cjs;
 *  falls back to any other player only if the bank has no position-sharing peer. */
function pickDecoyIdx(bank: PlayerCard[], targetIdx: number, rng: Rng): number {
  const decoy = pickDecoy(bank[targetIdx], bank, rng);
  const idx = decoy ? bank.indexOf(decoy) : -1;
  if (idx >= 0 && idx !== targetIdx) return idx;
  return (targetIdx + 1) % bank.length; // defensive: well-formed banks always have a peer
}

function buildShortlist(bank: PlayerCard[], targetIdx: number, decoyIdx: number, rng: Rng): number[] {
  const target = bank[targetIdx];
  const set = new Set<number>([targetIdx, decoyIdx]);
  // Distractors are the strongest position-sharing matches (same nationality first), so the
  // shortlist reads as five plausible peers rather than a nationality giveaway. Same hard
  // filter and scoring as the decoy itself, reused from decoy.cjs.
  const sims: number[] = [];
  for (let i = 0; i < bank.length; i++) if (i !== targetIdx && i !== decoyIdx && sharesPosition(bank[i], target)) sims.push(i);
  shuffle(sims, rng);
  sims.sort((a, b) => scoreDecoy(target, bank[b]) - scoreDecoy(target, bank[a]));
  for (const i of sims) {
    if (set.size >= 5) break;
    set.add(i);
  }
  let guard = 0;
  while (set.size < Math.min(5, bank.length) && guard++ < 200) {
    const i = randInt(rng, bank.length);
    if (i !== targetIdx) set.add(i);
  }
  return shuffle([...set], rng);
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

function resolve(s: SpyState, spyWon: boolean) {
  s.over = true;
  s.phase = 'done';
  s.winners = spyWon ? [s.spyId] : s.order.filter((seat) => seat !== s.spyId);
  log(s, spyWon ? '🕵️ The spy wins!' : '🎯 The non-spies win!');
}

function tally(bank: PlayerCard[], s: SpyState, rng: Rng) {
  s.votesRevealed = true;
  const counts = new Map<number, number>();
  for (const seat of seated(s)) {
    const v = s.players[seat]!.vote;
    if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let max = 0;
  let leaders: number[] = [];
  for (const [seat, n] of counts) {
    if (n > max) ((max = n), (leaders = [seat]));
    else if (n === max) leaders.push(seat);
  }
  const caught = leaders.length === 1 ? leaders[0] : null; // strict plurality only
  s.caughtId = caught;
  if (caught === s.spyId) {
    s.phase = 'spyGuess';
    s.shortlist = buildShortlist(bank, s.targetIdx, s.decoyIdx, rng);
    log(s, `${nameOf(s, s.spyId)} was caught — they get one guess at the target.`);
  } else {
    // a non-spy was caught, or a tie → the spy slips away
    log(s, caught === null ? 'A tied vote — no one is caught.' : `${nameOf(s, caught)} was caught, but they were not the spy.`);
    resolve(s, true);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function submitClue(s: SpyState, seat: number, word: unknown): ActionResult {
  if (s.phase !== 'clues') return fail('Not the clue phase.');
  if (seat !== s.order[s.current]) return fail('Not your turn.');
  const w = sanitizeWord(word);
  if (!w) return fail('Give a one-word clue.');
  s.clueLog.push({ seat, name: nameOf(s, seat), word: w, round: s.round });
  log(s, `${nameOf(s, seat)}: “${w}”`);
  s.current += 1;
  if (s.current >= s.order.length) {
    s.current = 0;
    if (s.round >= ROUNDS) {
      s.phase = 'voting';
      log(s, 'Final clues in — vote for the spy.');
    } else {
      // optional vote: the table decides whether to accuse now or keep clueing
      s.phase = 'interlude';
      for (const seat of seated(s)) s.players[seat]!.wantsVote = null;
      log(s, `Round ${s.round} done — call a vote now, or keep clueing?`);
    }
  }
  return ok;
}

function resolveInterlude(s: SpyState) {
  const seats = seated(s);
  if (!seats.every((seat) => s.players[seat]!.wantsVote !== null)) return; // wait for everyone
  const wants = seats.filter((seat) => s.players[seat]!.wantsVote === true).length;
  if (wants * 2 > seats.length) {
    s.phase = 'voting';
    log(s, `The table calls an early vote (${wants}/${seats.length}) — accuse the spy.`);
  } else {
    s.round += 1;
    s.current = 0;
    s.phase = 'clues';
    log(s, `No early vote — on to round ${s.round}.`);
  }
}

function interludeVote(s: SpyState, seat: number, wantVote: unknown): ActionResult {
  if (s.phase !== 'interlude') return fail('Not the moment to call a vote.');
  const p = s.players[seat];
  if (!p) return fail('Not in this match.');
  p.wantsVote = !!wantVote;
  log(s, `${p.name} weighs in.`); // keep the choice itself secret
  resolveInterlude(s);
  return ok;
}

function castVote(bank: PlayerCard[], s: SpyState, seat: number, target: unknown, rng: Rng): ActionResult {
  if (s.phase !== 'voting') return fail('Not the voting phase.');
  const p = s.players[seat];
  if (!p) return fail('Not in this match.');
  if (p.hasVoted) return fail('You already voted.');
  const t = Number(target);
  if (!s.order.includes(t)) return fail('Vote for a seated player.');
  if (t === seat) return fail('You cannot vote for yourself.');
  p.vote = t;
  p.hasVoted = true;
  log(s, `${p.name} cast a vote.`);
  if (seated(s).every((x) => s.players[x]!.hasVoted)) tally(bank, s, rng);
  return ok;
}

const normName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ');

function spyGuess(bank: PlayerCard[], s: SpyState, seat: number, guess: unknown): ActionResult {
  if (s.phase !== 'spyGuess') return fail('No guess to make.');
  if (seat !== s.spyId) return fail('Only the caught spy guesses.');
  const typed = String(guess ?? '').trim().slice(0, 60);
  if (!typed) return fail('Type the player you think it is.');
  s.guessName = typed;
  // Match the typed name against the bank; correct only if it's the real target.
  const idx = bank.findIndex((p) => normName(p.name) === normName(typed));
  s.guessIdx = idx >= 0 ? idx : null;
  s.guessCorrect = idx === s.targetIdx;
  resolve(s, s.guessCorrect); // a correct guess steals the win
  return ok;
}

// ---------------------------------------------------------------------------
// Per-seat view (redaction is the whole point)
// ---------------------------------------------------------------------------

function viewState(bank: PlayerCard[], s: SpyState, seat: number | null): Record<string, unknown> {
  const me = seat !== null && s.players[seat] ? s.players[seat]! : null;
  const activeSeat = s.phase === 'clues' ? s.order[s.current] : null;

  const players = s.order.map((seatNo) => {
    const p = s.players[seatNo]!;
    return {
      seat: seatNo,
      name: p.name,
      connected: p.connected,
      hasVoted: s.phase === 'voting' ? p.hasVoted : false,
      isTurn: !s.over && seatNo === activeSeat,
    };
  });

  const v: Record<string, unknown> = {
    game: 'spy-game',
    phase: s.over ? 'done' : s.phase,
    over: s.over,
    round: s.round,
    rounds: ROUNDS,
    clueLog: s.clueLog,
    players,
    activeSeat,
    log: s.log.slice(-15),
    matchWinner: null,
    winners: s.over ? s.winners : null,
  };

  // Your role + your OWN secret only. Never the other role's secret, never the spyId.
  v.you = me
    ? { seat, name: me.name, isSpy: me.isSpy, secret: me.secret, role: me.isSpy ? 'spy' : 'detective', hasVoted: me.hasVoted, vote: me.vote }
    : { seat: seat ?? -1, spectator: true };

  if (s.phase === 'clues' && me) {
    v.turn = { yourTurn: s.order[s.current] === seat, activeSeat, round: s.round };
  }
  if (s.phase === 'interlude' && me) {
    // Each choice is secret; we only expose how many are still deciding.
    v.interlude = {
      round: s.round,
      youDecided: me.wantsVote !== null,
      yourChoice: me.wantsVote,
      waiting: seated(s).filter((x) => s.players[x]!.wantsVote === null).length,
    };
  }
  if (s.phase === 'voting' && me) {
    v.voting = {
      youVoted: me.hasVoted,
      yourVote: me.vote,
      waiting: seated(s).filter((x) => !s.players[x]!.hasVoted).length,
      options: s.order.filter((x) => x !== seat).map((x) => ({ seat: x, name: nameOf(s, x) })),
    };
  }
  if (s.phase === 'spyGuess') {
    v.caughtId = s.caughtId; // the spy was outed by the vote — public now
    if (me && me.isSpy) {
      // The caught spy now searches the whole bank by name (no multiple choice).
      v.guess = { needsYou: true, allNames: bank.map((p) => p.name) };
    } else {
      v.guess = { needsYou: false, waitingOnSpy: true, caughtName: s.caughtId != null ? nameOf(s, s.caughtId) : null };
    }
  }

  // Votes become public only once everyone has voted (revealed together).
  if (s.votesRevealed) {
    v.voteResult = {
      caughtId: s.caughtId,
      votes: s.order.map((x) => ({ seat: x, name: nameOf(s, x), vote: s.players[x]!.vote })),
    };
  }

  // Full reveal once the match is over.
  if (s.over) {
    v.reveal = {
      spyId: s.spyId,
      spyName: nameOf(s, s.spyId),
      target: bank[s.targetIdx].name,
      decoy: bank[s.decoyIdx].name,
      caughtId: s.caughtId,
      guess: s.guessName ?? (s.guessIdx != null ? bank[s.guessIdx].name : null),
      guessCorrect: s.guessCorrect,
      spyWon: s.winners.includes(s.spyId),
      winners: s.winners,
      votes: s.order.map((x) => ({ seat: x, name: nameOf(s, x), vote: s.players[x]!.vote })),
    };
  }
  return v;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

function botMove(bank: PlayerCard[], s: SpyState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.over) return null;
  const p = s.players[seat];
  if (!p) return null;
  if (s.phase === 'clues') {
    if (s.order[s.current] !== seat) return null;
    // Clue from one of the player's OWN secret card's attributes (varies by round).
    const card = bank[p.isSpy ? s.decoyIdx : s.targetIdx];
    const opts = [card.nationality, card.leagues[0] || card.eraOfPlay, card.eraOfPlay, card.positions[0] || 'player'];
    const word = opts[(s.round - 1) % opts.length] || 'player';
    return { type: 'submitClue', word };
  }
  if (s.phase === 'interlude') {
    if (p.wantsVote !== null) return null;
    return { type: 'interludeVote', wantVote: false }; // bots prefer to keep clueing
  }
  if (s.phase === 'voting') {
    if (p.hasVoted) return null;
    const others = s.order.filter((x) => x !== seat);
    return { type: 'castVote', target: others[randInt(rng, others.length)] };
  }
  if (s.phase === 'spyGuess') {
    if (seat !== s.spyId) return null;
    return { type: 'spyGuess', guess: bank[s.shortlist[randInt(rng, s.shortlist.length)]].name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// GameDef factory — the word bank is injected, never hardcoded here.
// ---------------------------------------------------------------------------

export function createSpyGame(wordBank: PlayerCard[]): GameDef<SpyState> {
  const bank = wordBank;

  return {
    id: 'spy-game',
    name: 'Spy Game',
    blurb: 'Hidden-role football clues: everyone shares a secret player — except the spy. Find them, or bluff.',
    minPlayers: 3,
    maxPlayers: MAX_SEATS,

    create(setup: { seats: number[]; players: PlayerInfo[] }, ctx: GameContext): SpyState {
      const rng = ctx.rng;
      const order = [...setup.seats];
      const spyId = order[randInt(rng, order.length)];
      const targetIdx = randInt(rng, bank.length);
      const decoyIdx = pickDecoyIdx(bank, targetIdx, rng);

      const players: (SpyPlayer | null)[] = new Array(MAX_SEATS).fill(null);
      for (const pi of setup.players) {
        const isSpy = pi.seat === spyId;
        players[pi.seat] = {
          name: pi.name,
          connected: true,
          isSpy,
          secret: bank[isSpy ? decoyIdx : targetIdx].name,
          hasVoted: false,
          vote: null,
          wantsVote: null,
        };
      }
      const s: SpyState = {
        players, order, spyId, targetIdx, decoyIdx,
        phase: 'clues', round: 1, current: 0, clueLog: [],
        caughtId: null, votesRevealed: false, shortlist: [], guessIdx: null, guessName: null, guessCorrect: null,
        over: false, winners: [], log: [],
      };
      log(s, 'Match started. Round 1 — give a one-word clue on your turn.');
      return s;
    },

    act(s, seat, msg, ctx) {
      if (s.over) return fail('The match is over.');
      switch (msg.type) {
        case 'submitClue':
          return submitClue(s, seat, msg.word);
        case 'interludeVote':
          return interludeVote(s, seat, msg.wantVote);
        case 'castVote':
          return castVote(bank, s, seat, msg.target, ctx.rng);
        case 'spyGuess':
          return spyGuess(bank, s, seat, msg.guess);
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

    view(s, seat) {
      return viewState(bank, s, seat);
    },

    result(s): GameOutcome {
      return { over: s.over, winners: s.winners };
    },

    bot(s, seat, ctx) {
      return botMove(bank, s, seat, ctx.rng);
    },
  };
}
