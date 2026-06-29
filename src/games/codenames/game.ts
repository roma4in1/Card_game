// games/codenames/game.ts — "Codenames", a 2-team word-association game (4–8 players).
//
// Pure plugin built by `createCodenames(wordBank)` so the word bank is INJECTED, never
// hardcoded. The new pattern this game introduces is TEAM-AND-ROLE-SCOPED redaction:
// both spymasters see the full secret key, operatives never do — they only ever learn
// a card's identity once it's been revealed. The server owns the grid, the key and all
// reveals (rng via the per-call context), so operative clients can't see the key.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { initTimer, runTimer, timerView, TIMER_OPTION, type Timer } from '../../platform/turn-timer.ts';

export const MAX_SEATS = 8;
export const GRID = 25;

export type Team = 'red' | 'blue';
export type Identity = 'red' | 'blue' | 'neutral' | 'assassin';
const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);
function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface Card {
  word: string;
  identity: Identity;
  revealed: boolean;
}

interface CNPlayer {
  name: string;
  connected: boolean;
  team: Team;
  role: 'spymaster' | 'operative';
}

type Phase = 'clue' | 'guess' | 'done';

interface TeamInfo {
  spymaster: number | null;
  operatives: number[];
}

interface ClueEntry {
  team: Team;
  by: string;
  word: string;
  number: number;
}

export interface CNState {
  players: (CNPlayer | null)[]; // length MAX_SEATS
  order: number[];
  grid: Card[]; // 25
  startingTeam: Team;
  turnTeam: Team;
  phase: Phase;
  currentClue: { word: string; number: number } | null;
  guessesUsed: number;
  guessLimit: number; // N+1 for the current clue
  teams: { red: TeamInfo; blue: TeamInfo };
  agentsRemaining: { red: number; blue: number };
  clueLog: ClueEntry[];
  winner: Team | null;
  endReason: 'all-agents' | 'assassin' | null;
  timer: Timer; // opt-in per-turn countdown
  over: boolean;
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function log(s: CNState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: CNState, seat: number) => s.players[seat]!.name;

// ---------------------------------------------------------------------------
// Win / turn helpers
// ---------------------------------------------------------------------------

function win(s: CNState, team: Team, reason: 'all-agents' | 'assassin') {
  s.winner = team;
  s.endReason = reason;
  s.phase = 'done';
  s.over = true;
  log(s, reason === 'assassin' ? `💀 The assassin! ${team.toUpperCase()} wins.` : `🎉 ${team.toUpperCase()} found all their agents and wins!`);
}

// --- turn timer: signature of the current turn, and what timing out does (pass the turn) ---
const cnTurnKey = (s: CNState): string => (s.over ? '' : `${s.turnTeam}:${s.phase}`);

function endTurn(s: CNState) {
  s.turnTeam = other(s.turnTeam);
  s.phase = 'clue';
  s.currentClue = null;
  s.guessesUsed = 0;
  s.guessLimit = 0;
  log(s, `${s.turnTeam.toUpperCase()}'s turn — spymaster, give a clue.`);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function giveClue(s: CNState, seat: number, word: unknown, number: unknown): ActionResult {
  if (s.phase !== 'clue') return fail('Not time for a clue.');
  if (seat !== s.teams[s.turnTeam].spymaster) return fail('Only your team’s spymaster clues now.');
  const w = String(word ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
  if (!w) return fail('Enter a clue word.');
  const n = Math.floor(Number(number));
  if (!Number.isFinite(n) || n < 0 || n > GRID) return fail('Enter a clue number.');
  s.currentClue = { word: w, number: n };
  s.guessLimit = n + 1; // operatives get N+1 guesses
  s.guessesUsed = 0;
  s.phase = 'guess';
  s.clueLog.push({ team: s.turnTeam, by: nameOf(s, seat), word: w, number: n });
  log(s, `${s.turnTeam.toUpperCase()} clue: “${w}” ${n}.`);
  return ok;
}

function reveal(s: CNState, idx: number) {
  const card = s.grid[idx];
  card.revealed = true;
  if (card.identity === 'red' || card.identity === 'blue') s.agentsRemaining[card.identity] -= 1;
}

function guessCard(s: CNState, seat: number, cardIndex: unknown): ActionResult {
  if (s.phase !== 'guess') return fail('No clue to guess on yet.');
  const p = s.players[seat];
  if (!p || p.team !== s.turnTeam || p.role !== 'operative') return fail('Only the active team’s operatives may guess.');
  const i = Number(cardIndex);
  if (!Number.isInteger(i) || i < 0 || i >= GRID) return fail('Bad card.');
  if (s.grid[i].revealed) return fail('That card is already revealed.');

  reveal(s, i);
  s.guessesUsed += 1;
  const id = s.grid[i].identity;
  log(s, `${p.name} guesses ${s.grid[i].word} — ${id}.`);

  // Resolve. Any reveal can end the game (own/enemy agents both count down).
  if (id === 'assassin') return (win(s, other(s.turnTeam), 'assassin'), ok);
  if (s.agentsRemaining.red === 0) return (win(s, 'red', 'all-agents'), ok);
  if (s.agentsRemaining.blue === 0) return (win(s, 'blue', 'all-agents'), ok);

  if (id === s.turnTeam) {
    // correct — keep guessing unless the N+1 cap is hit
    if (s.guessesUsed >= s.guessLimit) {
      log(s, 'Guess limit reached — turn passes.');
      endTurn(s);
    }
  } else {
    // neutral or the enemy's agent — turn ends
    endTurn(s);
  }
  return ok;
}

function stopGuessing(s: CNState, seat: number): ActionResult {
  if (s.phase !== 'guess') return fail('Nothing to stop.');
  const p = s.players[seat];
  if (!p || p.team !== s.turnTeam || p.role !== 'operative') return fail('Only the active team’s operatives may stop.');
  if (s.guessesUsed < 1) return fail('Make at least one guess first.');
  log(s, `${p.name} stops guessing.`);
  endTurn(s);
  return ok;
}

// ---------------------------------------------------------------------------
// Per-seat view (team-and-role-scoped redaction)
// ---------------------------------------------------------------------------

function viewState(s: CNState, seat: number | null): Record<string, unknown> {
  const me = seat !== null && s.players[seat] ? s.players[seat]! : null;
  const seesKey = s.over || (me != null && me.role === 'spymaster');

  const grid = s.grid.map((c) => ({
    word: c.word,
    revealed: c.revealed,
    // Identity only when revealed, or to a spymaster, or after the game ends.
    identity: c.revealed || seesKey ? c.identity : null,
  }));

  const teamInfo = (t: Team) => ({
    spymaster: s.teams[t].spymaster != null ? { seat: s.teams[t].spymaster, name: nameOf(s, s.teams[t].spymaster!) } : null,
    operatives: s.teams[t].operatives.map((seatNo) => ({ seat: seatNo, name: nameOf(s, seatNo) })),
    agentsRemaining: s.agentsRemaining[t],
  });

  const v: Record<string, unknown> = {
    game: 'codenames',
    phase: s.over ? 'done' : s.phase,
    over: s.over,
    grid,
    turnTeam: s.turnTeam,
    startingTeam: s.startingTeam,
    timer: timerView(s.timer),
    currentClue: s.currentClue,
    guessesUsed: s.guessesUsed,
    guessesLeft: s.phase === 'guess' ? Math.max(0, s.guessLimit - s.guessesUsed) : 0,
    teams: { red: teamInfo('red'), blue: teamInfo('blue') },
    clueLog: s.clueLog,
    log: s.log.slice(-15),
    matchWinner: null,
    winner: s.over ? s.winner : null,
    endReason: s.over ? s.endReason : null,
    winners: s.over && s.winner ? s.order.filter((seatNo) => s.players[seatNo]!.team === s.winner) : null,
  };

  if (me) {
    const isSpy = me.role === 'spymaster';
    const yourTurn = !s.over && s.turnTeam === me.team && (isSpy ? s.phase === 'clue' : s.phase === 'guess');
    v.you = {
      seat,
      name: me.name,
      team: me.team,
      role: me.role,
      isSpymaster: isSpy,
      yourTurn,
      canClue: isSpy && yourTurn,
      canGuess: !isSpy && yourTurn,
      canStop: !isSpy && yourTurn && s.guessesUsed >= 1,
    };
  } else {
    v.you = { seat: seat ?? -1, spectator: true };
  }
  return v;
}

// ---------------------------------------------------------------------------
// Bot (fallback for seats taken over after a player leaves)
// ---------------------------------------------------------------------------

function botMove(s: CNState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.over) return null;
  const p = s.players[seat];
  if (!p || p.team !== s.turnTeam) return null;
  if (p.role === 'spymaster') {
    if (s.phase !== 'clue') return null;
    return { type: 'giveClue', word: 'AGENT', number: 1 };
  }
  if (s.phase !== 'guess') return null;
  if (s.guessesUsed >= 1) return { type: 'stopGuessing' }; // guess once, then play safe
  const unrevealed = s.grid.map((_, i) => i).filter((i) => !s.grid[i].revealed);
  if (!unrevealed.length) return { type: 'stopGuessing' };
  return { type: 'guessCard', cardIndex: unrevealed[randInt(rng, unrevealed.length)] };
}

// ---------------------------------------------------------------------------
// GameDef factory — the word bank is injected, never hardcoded here.
// ---------------------------------------------------------------------------

export function createCodenames(wordBank: string[]): GameDef<CNState> {
  const bank = wordBank;

  return {
    id: 'codenames',
    name: 'Codenames',
    blurb: 'Two teams, one secret key. Spymasters give one-word clues; operatives find their agents — avoid the assassin.',
    minPlayers: 4,
    maxPlayers: MAX_SEATS,
    options: [TIMER_OPTION],

    create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): CNState {
      const rng = ctx.rng;
      // Split players into balanced teams; the first of each team is the spymaster.
      const shuffled = shuffle([...setup.seats], rng);
      const red: number[] = [];
      const blue: number[] = [];
      shuffled.forEach((seat, i) => (i % 2 === 0 ? red : blue).push(seat));

      const players: (CNPlayer | null)[] = new Array(MAX_SEATS).fill(null);
      const nameBySeat = new Map(setup.players.map((p) => [p.seat, p.name]));
      const assign = (seats: number[], team: Team) =>
        seats.forEach((seat, i) =>
          (players[seat] = { name: nameBySeat.get(seat) ?? `Seat ${seat + 1}`, connected: true, team, role: i === 0 ? 'spymaster' : 'operative' }),
        );
      assign(red, 'red');
      assign(blue, 'blue');

      // Draw 25 distinct words.
      const words = shuffle([...bank], rng).slice(0, GRID);

      // Build the key: starting team 9, other 8, neutral 7, assassin 1.
      const startingTeam: Team = rng() < 0.5 ? 'red' : 'blue';
      const ids: Identity[] = [
        ...Array(9).fill(startingTeam),
        ...Array(8).fill(other(startingTeam)),
        ...Array(7).fill('neutral'),
        'assassin',
      ];
      shuffle(ids, rng);
      const grid: Card[] = words.map((word, i) => ({ word, identity: ids[i], revealed: false }));

      const s: CNState = {
        players,
        order: [...setup.seats],
        grid,
        startingTeam,
        turnTeam: startingTeam,
        phase: 'clue',
        currentClue: null,
        guessesUsed: 0,
        guessLimit: 0,
        teams: {
          red: { spymaster: red[0] ?? null, operatives: red.slice(1) },
          blue: { spymaster: blue[0] ?? null, operatives: blue.slice(1) },
        },
        agentsRemaining: { red: startingTeam === 'red' ? 9 : 8, blue: startingTeam === 'blue' ? 9 : 8 },
        clueLog: [],
        winner: null,
        endReason: null,
        timer: initTimer(setup.options?.timer),
        over: false,
        log: [],
      };
      log(s, `${startingTeam.toUpperCase()} starts. Spymaster, give a clue.`);
      return s;
    },

    act(s, seat, msg, ctx) {
      void ctx;
      if (s.over) return fail('The game is over.');
      switch (msg.type) {
        case 'giveClue':
          return giveClue(s, seat, msg.word, msg.number);
        case 'guessCard':
          return guessCard(s, seat, msg.cardIndex);
        case 'stopGuessing':
          return stopGuessing(s, seat);
      }
    },

    tick(s, ctx) {
      // On timeout the team forfeits its turn (use-it-or-lose-it), for both phases.
      return runTimer(s.timer, () => cnTurnKey(s), ctx.now, () => endTurn(s));
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
      return viewState(s, seat);
    },

    result(s): GameOutcome {
      return { over: s.over, winners: s.over && s.winner ? s.order.filter((seat) => s.players[seat]!.team === s.winner) : [] };
    },

    bot(s, seat, ctx) {
      return botMove(s, seat, ctx.rng);
    },
  };
}
