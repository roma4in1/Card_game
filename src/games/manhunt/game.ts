// games/manhunt/game.ts — "Manhunt", a two-player hidden-movement pursuit.
//
// One player runs, hidden. The other hunts with two agents that both move every turn. The
// runner leaks exactly two things: the TRANSPORT they took (announced every turn, so the
// hunter can reason about how far they could have gone) and their actual position, but only
// on every third turn, when they have to surface.
//
// Asymmetric games are unfair over one run, so a match is TWO halves — you each run once,
// from the identical starting position, and whoever survives longer wins. That makes the
// map deal irrelevant to fairness: both players are handed the same puzzle.
//
// The secret here is positional and it decays: `view` sends the runner's node to the runner
// always, and to the hunter only when the runner has surfaced. Everything else — both
// agents, the whole trail of transports used — is public, because the hunter is meant to
// deduce from it.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';

const TURNS = 12; // a half lasts this many turns if the runner is never caught
const SURFACE_EVERY = 3; // …and they must surface on every third one
const HALF_BREAK_MS = 4500; // pause between the two halves

/** Transports, slowest to fastest. A runner announces which they took, never where to. */
export const TRANSPORT = [
  { key: 'taxi', name: 'Taxi', icon: '🚕' },
  { key: 'bus', name: 'Bus', icon: '🚌' },
  { key: 'tube', name: 'Underground', icon: '🚇' },
];

// The map: 16 nodes on a 4×4 grid. Taxis hop to a neighbour, buses skip a node, and the
// underground links the four corners and the middle — few stations, but they cross the map.
export const NODES = Array.from({ length: 16 }, (_, i) => ({ id: i, x: i % 4, y: Math.floor(i / 4) }));

function buildEdges(): number[][][] {
  const edges: number[][][] = TRANSPORT.map(() => NODES.map(() => [] as number[]));
  const link = (t: number, a: number, b: number) => {
    if (!edges[t][a].includes(b)) edges[t][a].push(b);
    if (!edges[t][b].includes(a)) edges[t][b].push(a);
  };
  for (const n of NODES) {
    // taxi: orthogonal neighbours
    if (n.x < 3) link(0, n.id, n.id + 1);
    if (n.y < 3) link(0, n.id, n.id + 4);
    // bus: skip one, along a row or a column
    if (n.x < 2) link(1, n.id, n.id + 2);
    if (n.y < 2) link(1, n.id, n.id + 8);
  }
  for (const [a, b] of [[0, 3], [3, 15], [15, 12], [12, 0], [5, 10], [6, 9]]) link(2, a, b);
  return edges;
}
export const EDGES = buildEdges();

/** Where `from` can reach on `transport`. */
const exits = (from: number, transport: number) => EDGES[transport][from];
/** Every (transport, node) a piece at `from` could move to. */
function allMoves(from: number): { transport: number; to: number }[] {
  const out: { transport: number; to: number }[] = [];
  for (let t = 0; t < TRANSPORT.length; t++) for (const to of exits(from, t)) out.push({ transport: t, to });
  return out;
}

interface MHPlayer {
  name: string;
  connected: boolean;
}
interface TrailStep {
  turn: number;
  transport: number;
  node: number | null; // filled in only on a surfacing turn
}

export interface MHState {
  players: (MHPlayer | null)[]; // by seat (length 8)
  order: number[]; // seat per player-index
  np: number;
  startRunner: number; // the same opening position is used for BOTH halves
  startHunters: number[];
  half: number; // 0 or 1
  runner: number; // player-index currently running
  turn: number; // 1..TURNS
  stage: 'runner' | 'hunter';
  hunterPiece: number; // which agent moves next (both move each turn)
  runnerAt: number;
  hunterAt: number[];
  trail: TrailStep[];
  survived: (number | null)[]; // by player-index: turns survived on their run
  caught: boolean;
  breakAt: number;
  phase: 'run' | 'break' | 'done';
  over: boolean;
  winners: number[]; // seats
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: MHState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: MHState, pid: number) => s.players[s.order[pid]]!.name;
const hunterOf = (s: MHState) => 1 - s.runner;
const surfaces = (turn: number) => turn % SURFACE_EVERY === 0;
/** The last node the hunter actually saw, or null if the runner has never surfaced. */
const lastSeen = (s: MHState) => {
  for (let i = s.trail.length - 1; i >= 0; i--) if (s.trail[i].node !== null) return s.trail[i];
  return null;
};

// ---------------------------------------------------------------------------
// Half / match flow
// ---------------------------------------------------------------------------

function beginHalf(s: MHState, half: number) {
  s.half = half;
  s.runner = half; // player 0 runs the first half, player 1 the second
  s.turn = 1;
  s.stage = 'runner';
  s.hunterPiece = 0;
  s.runnerAt = s.startRunner;
  s.hunterAt = [...s.startHunters];
  s.trail = [];
  s.caught = false;
  s.phase = 'run';
  log(s, `Half ${half + 1}: ${nameOf(s, s.runner)} runs, ${nameOf(s, hunterOf(s))} hunts. ${TURNS} turns.`);
}

function endHalf(s: MHState, survivedTurns: number, now: number) {
  s.survived[s.runner] = survivedTurns;
  log(s, s.caught
    ? `${nameOf(s, s.runner)} is caught on turn ${s.turn} — ${survivedTurns} turn${survivedTurns === 1 ? '' : 's'} survived.`
    : `${nameOf(s, s.runner)} runs out the clock — all ${survivedTurns} turns survived.`);

  if (s.half === 0) {
    s.phase = 'break';
    s.breakAt = now + HALF_BREAK_MS;
    return;
  }
  s.over = true;
  s.phase = 'done';
  const [a, b] = s.survived as number[];
  if (a === b) {
    s.winners = s.order.slice();
    log(s, `Both lasted ${a} turns — honours even.`);
  } else {
    const win = a > b ? 0 : 1;
    s.winners = [s.order[win]];
    log(s, `🏆 ${nameOf(s, win)} wins — ${Math.max(a, b)} turns survived to ${Math.min(a, b)}.`);
  }
}

function tickState(s: MHState, now: number): boolean {
  if (s.phase !== 'break' || now < s.breakAt) return false;
  beginHalf(s, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

function runMove(s: MHState, pid: number, toRaw: unknown, transportRaw: unknown, now: number): ActionResult {
  if (s.phase !== 'run') return fail(s.phase === 'break' ? 'The next half is about to start.' : 'The game is over.');
  if (s.stage !== 'runner') return fail('The hunt is moving.');
  if (pid !== s.runner) return fail('You are hunting, not running.');
  const to = Number(toRaw);
  const transport = Number(transportRaw);
  if (!Number.isInteger(transport) || transport < 0 || transport >= TRANSPORT.length) return fail('No such transport.');
  if (!Number.isInteger(to) || !exits(s.runnerAt, transport).includes(to)) return fail(`No ${TRANSPORT[transport].name.toLowerCase()} route there.`);
  if (s.hunterAt.includes(to)) return fail('You would run straight into an agent.');

  s.runnerAt = to;
  const step: TrailStep = { turn: s.turn, transport, node: surfaces(s.turn) ? to : null };
  s.trail.push(step);
  log(s, step.node !== null
    ? `Turn ${s.turn}: the runner surfaces at ${to + 1} — by ${TRANSPORT[transport].name.toLowerCase()}.`
    : `Turn ${s.turn}: the runner moves by ${TRANSPORT[transport].name.toLowerCase()}.`);
  s.stage = 'hunter';
  s.hunterPiece = 0;
  return ok;
}

function huntMove(s: MHState, pid: number, toRaw: unknown, now: number): ActionResult {
  if (s.phase !== 'run') return fail(s.phase === 'break' ? 'The next half is about to start.' : 'The game is over.');
  if (s.stage !== 'hunter') return fail('The runner is moving.');
  if (pid !== hunterOf(s)) return fail('You are running, not hunting.');
  const to = Number(toRaw);
  const from = s.hunterAt[s.hunterPiece];
  if (!Number.isInteger(to) || !allMoves(from).some((m) => m.to === to)) return fail('No route there.');
  if (s.hunterAt.some((n, i) => i !== s.hunterPiece && n === to)) return fail('Your other agent is already there.');

  s.hunterAt[s.hunterPiece] = to;
  if (to === s.runnerAt) {
    s.caught = true;
    log(s, `Agent ${s.hunterPiece + 1} closes on ${to + 1}.`);
    endHalf(s, s.turn - 1, now); // caught during this turn, so it doesn't count as survived
    return ok;
  }
  if (s.hunterPiece === 0) {
    s.hunterPiece = 1;
    return ok;
  }

  // Both agents have moved — the turn is complete.
  if (s.turn >= TURNS) {
    endHalf(s, TURNS, now);
    return ok;
  }
  s.turn += 1;
  s.stage = 'runner';
  s.hunterPiece = 0;
  // A runner with nowhere to go is run to ground.
  if (!runnerOptions(s).length) {
    s.caught = true;
    log(s, `The runner is cornered at turn ${s.turn} with no way out.`);
    endHalf(s, s.turn - 1, now);
  }
  return ok;
}

/** Every move the runner could legally make right now. */
function runnerOptions(s: MHState): { transport: number; to: number }[] {
  return allMoves(s.runnerAt).filter((m) => !s.hunterAt.includes(m.to));
}

// ---------------------------------------------------------------------------
// View — the runner's node is the one thing the hunter must earn
// ---------------------------------------------------------------------------

function viewState(s: MHState, seat: number | null): Record<string, unknown> {
  const myPid = seat !== null ? s.order.indexOf(seat) : -1;
  const amRunner = myPid === s.runner && myPid >= 0;
  const done = s.phase !== 'run'; // between halves and at the end, everything is shown
  const seen = lastSeen(s);
  // A surfaced runner stays in plain sight until they move again — the last trail entry
  // carrying a node means exactly that, since every move pushes a fresh one.
  const inTheOpen = s.trail.length > 0 && s.trail[s.trail.length - 1].node !== null;

  const players = Array.from({ length: s.np }, (_, pid) => ({
    seat: s.order[pid],
    name: nameOf(s, pid),
    connected: s.players[s.order[pid]]!.connected,
    role: pid === s.runner ? 'runner' : 'hunter',
    survived: s.survived[pid],
    isTurn: s.phase === 'run' && (s.stage === 'runner' ? pid === s.runner : pid === hunterOf(s)),
  }));

  return {
    game: 'manhunt',
    phase: s.phase,
    over: s.over,
    nodes: NODES,
    edges: EDGES,
    transport: TRANSPORT,
    turn: s.turn,
    turns: TURNS,
    surfaceEvery: SURFACE_EVERY,
    surfacesThisTurn: surfaces(s.turn),
    half: s.half,
    stage: s.stage,
    hunterPiece: s.hunterPiece,
    hunterAt: s.hunterAt, // the agents are always in plain sight
    // The runner's node goes to the runner, to everyone while they stand surfaced, and to
    // everyone once the half is over. Otherwise it is simply not in the payload.
    runnerAt: amRunner || done || inTheOpen ? s.runnerAt : null,
    lastSeenAt: seen ? seen.node : null,
    lastSeenTurn: seen ? seen.turn : null,
    trail: s.trail.map((t) => ({ turn: t.turn, transport: t.transport, node: amRunner || done ? (t.node ?? null) : t.node })),
    players,
    activeSeat: s.phase === 'run' ? s.order[s.stage === 'runner' ? s.runner : hunterOf(s)] : null,
    caught: s.caught,
    survived: s.survived,
    you:
      myPid >= 0
        ? {
            seat,
            pid: myPid,
            role: amRunner ? 'runner' : 'hunter',
            isTurn: s.phase === 'run' && (s.stage === 'runner' ? amRunner : !amRunner),
            // the runner gets their routes; the hunter gets the current agent's
            moves: s.phase !== 'run' ? [] : amRunner ? (s.stage === 'runner' ? runnerOptions(s) : []) : s.stage === 'hunter' ? allMoves(s.hunterAt[s.hunterPiece]).filter((m) => !s.hunterAt.some((n, i) => i !== s.hunterPiece && n === m.to)) : [],
          }
        : { seat: seat ?? -1, spectator: true, role: 'spectator', isTurn: false, moves: [] },
    winners: s.over ? s.winners : null,
    log: s.log.slice(-15),
    matchWinner: null,
  };
}

// ---------------------------------------------------------------------------
// Bot — the runner flees the agents; the hunter converges on the last sighting.
// Neither consults anything its seat cannot see: the hunter bot navigates by
// `lastSeen`, never by `runnerAt`.
// ---------------------------------------------------------------------------

/** Hop counts from `from` to every node, over all transports. */
function distances(from: number): number[] {
  const dist = NODES.map(() => Infinity);
  dist[from] = 0;
  const queue = [from];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of allMoves(n)) {
      if (dist[m.to] !== Infinity) continue;
      dist[m.to] = dist[n] + 1;
      queue.push(m.to);
    }
  }
  return dist;
}

function botMove(s: MHState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.phase !== 'run' || s.over) return null;
  const pid = s.order.indexOf(seat);
  if (pid < 0) return null;

  if (s.stage === 'runner') {
    if (pid !== s.runner) return null;
    const opts = runnerOptions(s);
    if (!opts.length) return null;
    // Keep as far from both agents as possible; prefer the fast routes when it's close.
    const fromAgents = s.hunterAt.map((h) => distances(h));
    let best = opts[0];
    let bestScore = -Infinity;
    for (const m of opts) {
      const score = Math.min(...fromAgents.map((d) => d[m.to])) * 10 + m.transport + rng();
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return { type: 'run', to: best.to, transport: best.transport };
  }

  if (pid !== hunterOf(s)) return null;
  const from = s.hunterAt[s.hunterPiece];
  const opts = allMoves(from).filter((m) => !s.hunterAt.some((n, i) => i !== s.hunterPiece && n === m.to));
  if (!opts.length) return null;
  const seen = lastSeen(s);
  // Nothing sighted yet: fan out toward the middle of the map rather than sit still.
  const focus = seen ? seen.node! : 5 + Math.floor(rng() * 2) * 5;
  const toFocus = distances(focus);
  let best = opts[0];
  let bestScore = Infinity;
  for (const m of opts) {
    const score = toFocus[m.to] + rng() * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { type: 'hunt', to: best.to };
}

// ---------------------------------------------------------------------------
// GameDef
// ---------------------------------------------------------------------------

export const manhunt: GameDef<MHState> = {
  id: 'manhunt',
  name: 'Manhunt',
  blurb: 'One runs hidden, one hunts with two agents. Swap roles at half time — outlast their run to win.',
  minPlayers: 2,
  maxPlayers: 2,

  validateStart(seats) {
    return seats.length === 2 ? null : 'Manhunt is a two-player duel.';
  },

  create(setup: { seats: number[]; players: PlayerInfo[] }, ctx: GameContext): MHState {
    const players: (MHPlayer | null)[] = new Array(8).fill(null);
    for (const pi of setup.players) players[pi.seat] = { name: pi.name, connected: true };

    // One opening position, used for BOTH halves, so each player runs the same puzzle.
    const startRunner = Math.floor(ctx.rng() * NODES.length);
    const far = distances(startRunner)
      .map((d, id) => ({ d, id }))
      .filter((n) => n.d >= 2)
      .sort((a, b) => b.d - a.d);
    const startHunters = [far[0].id, far[Math.min(far.length - 1, 1 + Math.floor(ctx.rng() * 3))].id];
    if (startHunters[0] === startHunters[1]) startHunters[1] = far[far.length - 1].id;

    const s: MHState = {
      players,
      order: [...setup.seats],
      np: setup.seats.length,
      startRunner,
      startHunters,
      half: 0,
      runner: 0,
      turn: 1,
      stage: 'runner',
      hunterPiece: 0,
      runnerAt: startRunner,
      hunterAt: [...startHunters],
      trail: [],
      survived: [null, null],
      caught: false,
      breakAt: 0,
      phase: 'run',
      over: false,
      winners: [],
      log: [],
    };
    log(s, `Both players run the same map from the same start — longest run wins.`);
    beginHalf(s, 0);
    return s;
  },

  act(s, seat, msg, ctx) {
    const pid = s.order.indexOf(seat);
    if (pid < 0) return fail('You are not in this match.');
    switch (msg.type) {
      case 'run':
        return runMove(s, pid, msg.to, msg.transport, ctx.now);
      case 'hunt':
        return huntMove(s, pid, msg.to, ctx.now);
    }
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
