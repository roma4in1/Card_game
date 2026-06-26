// games/lock-in/game.ts — "Lock In", a press-your-luck dice game (2–8 players).
//
// Pure plugin: it owns and mutates an LIState but performs no I/O. The room
// (platform/room.ts) starts a match via create, routes actions through act,
// reads per-seat snapshots from view, and polls result. The server rolls every
// die (randomness arrives through the per-call context), so clients can never
// fabricate results and the state stays plain-JSON serializable.
//
// Each turn a player rolls 9 dice, locks a single target number, then presses
// their luck: every roll they may set aside one matching die, occasionally earn
// a chip, and choose to keep rolling or bank what they have. Bust on a no-match
// roll unless they pay a chip to try again. Most points after N rounds wins.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';

export const MAX_SEATS = 8;
export const DICE = 9;
export const START_PLAY = 8;
export const START_RESERVE = 2;
export const DEFAULT_ROUNDS = 5;

const rollDie = (rng: Rng): number => Math.floor(rng() * 6) + 1;
const rollDice = (n: number, rng: Rng): number[] => Array.from({ length: n }, () => rollDie(rng));

interface LIPlayer {
  name: string;
  connected: boolean;
  playArea: number; // spendable chips
  reserve: number; // locked chips, earned into play only by setting aside all 9
  discard: number; // spent chips; the pool you earn chips back from
  score: number; // points banked from finished turns
}

type TurnPhase = 'pick' | 'decide' | 'zero';

interface Turn {
  seat: number;
  target: number | null; // locked on the first roll for the whole turn
  dice: number[]; // the most recent roll on the table
  setAside: number; // dice locked away this turn (0–9)
  chipsSpent: number; // chips spent rerolling this turn (perfect run needs 0)
  earnedThisRoll: boolean; // did the last roll earn a chip (for the view)
  phase: TurnPhase;
}

interface FinalScore {
  seat: number;
  score: number;
  bonus: number; // +2 per play-area chip
  total: number;
  play: number;
}

export interface LIState {
  players: (LIPlayer | null)[]; // length MAX_SEATS
  order: number[]; // seat turn order
  current: number; // index into order
  round: number; // 1-based
  rounds: number;
  turn: Turn;
  over: boolean;
  winners: number[];
  finals: FinalScore[] | null;
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function log(s: LIState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: LIState, seat: number) => s.players[seat]!.name;

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

function startTurn(s: LIState, idx: number, rng: Rng) {
  const seat = s.order[idx];
  s.turn = {
    seat,
    target: null,
    dice: rollDice(DICE, rng),
    setAside: 0,
    chipsSpent: 0,
    earnedThisRoll: false,
    phase: 'pick',
  };
  log(s, `${nameOf(s, seat)}'s turn (round ${s.round}). Rolled 9 — pick a target number.`);
}

function advance(s: LIState, rng: Rng) {
  s.current += 1;
  if (s.current >= s.order.length) {
    s.current = 0;
    s.round += 1;
  }
  if (s.round > s.rounds) {
    endGame(s);
    return;
  }
  startTurn(s, s.current, rng);
}

function endTurn(s: LIState, rng: Rng) {
  const t = s.turn;
  const p = s.players[t.seat]!;
  let pts = t.setAside;
  if (t.setAside === 8) pts += 1;
  if (t.setAside === 9) pts += t.chipsSpent === 0 ? 5 : 3; // perfect run vs full sweep
  p.score += pts;
  if (t.setAside === 9 && p.reserve > 0) {
    p.reserve -= 1;
    p.playArea += 1;
  }
  const perfect = t.setAside === 9 && t.chipsSpent === 0;
  log(
    s,
    `${p.name} banks ${pts} point${pts === 1 ? '' : 's'} (set aside ${t.setAside}${
      perfect ? ', perfect run!' : t.setAside === 9 ? ', clean sweep!' : ''
    }).`,
  );
  advance(s, rng);
}

// Roll every die still on the table, then resolve matches against the target.
function doRoll(s: LIState, rng: Rng) {
  const t = s.turn;
  const p = s.players[t.seat]!;
  const n = DICE - t.setAside;
  t.dice = rollDice(n, rng);
  t.earnedThisRoll = false;
  const matches = t.dice.filter((d) => d === t.target).length;

  if (matches >= 1) {
    t.setAside += 1;
    if (matches >= 2 && p.discard > 0) {
      p.discard -= 1;
      p.playArea += 1;
      t.earnedThisRoll = true;
    }
    log(
      s,
      `${p.name} rolls ${matches} of ${t.target} — sets one aside (${t.setAside}/9)${
        t.earnedThisRoll ? ', earns a chip' : ''
      }.`,
    );
    if (t.setAside === DICE) return endTurn(s, rng); // all nine locked
    t.phase = 'decide';
  } else if (p.playArea > 0) {
    t.phase = 'zero';
    log(s, `${p.name} rolls no ${t.target} — pay 1 chip to reroll, or stop.`);
  } else {
    log(s, `${p.name} rolls no ${t.target} and has no chip to reroll — turn ends.`);
    endTurn(s, rng);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function pick(s: LIState, seat: number, target: number, rng: Rng): ActionResult {
  const t = s.turn;
  if (seat !== t.seat) return fail('Not your turn.');
  if (t.phase !== 'pick') return fail('Target already chosen.');
  if (!Number.isInteger(target) || target < 1 || target > 6) return fail('Pick a number from 1 to 6.');
  if (!t.dice.includes(target)) return fail('That number is not in your roll.');
  t.target = target;
  t.setAside = 1; // set aside exactly one of the target (no chip on the first roll)
  t.phase = 'decide';
  log(s, `${nameOf(s, seat)} locks in ${target} and sets one aside (1/9).`);
  void rng;
  return ok;
}

function roll(s: LIState, seat: number, rng: Rng): ActionResult {
  const t = s.turn;
  if (seat !== t.seat) return fail('Not your turn.');
  if (t.phase !== 'decide') return fail('You cannot roll right now.');
  doRoll(s, rng);
  return ok;
}

function reroll(s: LIState, seat: number, rng: Rng): ActionResult {
  const t = s.turn;
  const p = s.players[seat];
  if (seat !== t.seat) return fail('Not your turn.');
  if (t.phase !== 'zero') return fail('You can only reroll after a no-match roll.');
  if (!p || p.playArea <= 0) return fail('No chips to spend on a reroll.');
  p.playArea -= 1;
  p.discard += 1;
  t.chipsSpent += 1;
  log(s, `${p.name} spends a chip to reroll.`);
  doRoll(s, rng);
  return ok;
}

function stop(s: LIState, seat: number, rng: Rng): ActionResult {
  const t = s.turn;
  if (seat !== t.seat) return fail('Not your turn.');
  if (t.phase !== 'decide' && t.phase !== 'zero') return fail('Nothing to stop yet.');
  endTurn(s, rng);
  return ok;
}

// ---------------------------------------------------------------------------
// End of game
// ---------------------------------------------------------------------------

function endGame(s: LIState) {
  const finals: FinalScore[] = s.order.map((seat) => {
    const p = s.players[seat]!;
    const bonus = p.playArea * 2; // only play-area chips count
    return { seat, score: p.score, bonus, total: p.score + bonus, play: p.playArea };
  });
  const maxTotal = Math.max(...finals.map((f) => f.total));
  let top = finals.filter((f) => f.total === maxTotal);
  if (top.length > 1) {
    const maxPlay = Math.max(...top.map((f) => f.play)); // tiebreak: most play-area chips
    top = top.filter((f) => f.play === maxPlay);
  }
  finals.sort((a, b) => b.total - a.total || b.play - a.play);
  s.finals = finals;
  s.winners = top.map((f) => f.seat);
  s.over = true;
  const names = s.winners.map((seat) => nameOf(s, seat)).join(', ');
  log(s, `Game over. ${s.winners.length > 1 ? `Shared victory: ${names}` : `🏆 ${names} wins`}.`);
}

// ---------------------------------------------------------------------------
// Per-seat view
// ---------------------------------------------------------------------------

function view(s: LIState, seat: number | null): Record<string, unknown> {
  const t = s.turn;
  const me = seat !== null && s.players[seat] ? s.players[seat]! : null;
  const yourTurn = me !== null && seat === t.seat && !s.over;

  const players = s.order.map((seatNo) => {
    const p = s.players[seatNo]!;
    return {
      seat: seatNo,
      name: p.name,
      connected: p.connected,
      playArea: p.playArea,
      reserve: p.reserve,
      discard: p.discard,
      score: p.score,
      isTurn: !s.over && seatNo === t.seat,
    };
  });

  const matches = t.target === null ? 0 : t.dice.filter((d) => d === t.target).length;

  return {
    game: 'lock-in',
    phase: s.over ? 'over' : 'playing',
    round: s.round,
    rounds: s.rounds,
    over: s.over,
    winners: s.winners,
    finals: s.finals,
    players,
    you: me
      ? { seat, name: me.name, connected: me.connected, playArea: me.playArea, reserve: me.reserve, discard: me.discard, score: me.score }
      : { seat: seat ?? -1, name: '', playArea: 0, reserve: 0, discard: 0, score: 0 },
    turn: {
      seat: t.seat,
      name: nameOf(s, t.seat),
      yourTurn,
      target: t.target,
      dice: t.dice,
      matches,
      setAside: t.setAside,
      remaining: DICE - t.setAside,
      chipsSpent: t.chipsSpent,
      earnedThisRoll: t.earnedThisRoll,
      phase: t.phase,
      // What the active player may do right now:
      canPick: yourTurn && t.phase === 'pick',
      canRoll: yourTurn && t.phase === 'decide',
      canStop: yourTurn && (t.phase === 'decide' || t.phase === 'zero'),
      canReroll: yourTurn && t.phase === 'zero' && (me?.playArea ?? 0) > 0,
    },
    log: s.log.slice(-15),
    matchWinner: null,
  };
}

// ---------------------------------------------------------------------------
// GameDef plugin
// ---------------------------------------------------------------------------

export const lockIn: GameDef<LIState> = {
  id: 'lock-in',
  name: 'Lock In',
  blurb: 'Press-your-luck with 9 dice: lock a number, set aside one per roll, bank before you bust.',
  minPlayers: 2,
  maxPlayers: MAX_SEATS,

  create(setup: { seats: number[]; players: PlayerInfo[] }, ctx: GameContext): LIState {
    const players: (LIPlayer | null)[] = new Array(MAX_SEATS).fill(null);
    for (const pi of setup.players) {
      players[pi.seat] = {
        name: pi.name,
        connected: true,
        playArea: START_PLAY,
        reserve: START_RESERVE,
        discard: 0,
        score: 0,
      };
    }
    const order = [...setup.seats];
    const s: LIState = {
      players,
      order,
      current: 0,
      round: 1,
      rounds: DEFAULT_ROUNDS,
      turn: { seat: order[0], target: null, dice: [], setAside: 0, chipsSpent: 0, earnedThisRoll: false, phase: 'pick' },
      over: false,
      winners: [],
      finals: null,
      log: [],
    };
    startTurn(s, 0, ctx.rng);
    return s;
  },

  act(s, seat, msg, ctx) {
    if (s.over) return fail('The game is over.');
    switch (msg.type) {
      case 'pick':
        return pick(s, seat, Number(msg.target), ctx.rng);
      case 'roll':
        return roll(s, seat, ctx.rng);
      case 'reroll':
        return reroll(s, seat, ctx.rng);
      case 'stop':
        return stop(s, seat, ctx.rng);
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
    return { over: s.over, winners: s.winners };
  },

  bot(s, seat, ctx) {
    if (s.over) return null;
    const t = s.turn;
    if (t.seat !== seat) return null;
    const rng = ctx.rng;
    if (t.phase === 'pick') {
      // Lock the number that came up most often.
      const counts = new Map<number, number>();
      for (const d of t.dice) counts.set(d, (counts.get(d) ?? 0) + 1);
      let best = t.dice[0];
      let bestC = 0;
      for (const [v, c] of counts) if (c > bestC) ((best = v), (bestC = c));
      return { type: 'pick', target: best };
    }
    if (t.phase === 'zero') {
      // Pay to reroll only when there's a decent stack worth protecting.
      const p = s.players[seat]!;
      if (p.playArea > 1 && t.setAside >= 3 && rng() < 0.5) return { type: 'reroll' };
      return { type: 'stop' };
    }
    if (t.phase === 'decide') {
      // Press your luck while the pile is small; chase the 8/9 bonus a bit at the end.
      const sa = t.setAside;
      const rollProb = sa <= 2 ? 0.95 : sa <= 4 ? 0.7 : sa <= 6 ? 0.4 : 0.55;
      return rng() < rollProb ? { type: 'roll' } : { type: 'stop' };
    }
    return null;
  },
};
