// games/manhunt/game.ts — "Manhunt", a two-player hidden-movement pursuit.
//
// One player runs, hidden. The other hunts with three agents that all move every turn. The
// runner leaks exactly two things: the TRANSPORT they took (announced every turn, so the
// hunter can reason about how far they could have gone) and their actual position, but only
// on every third turn, when they have to surface.
//
// Announcing the transport only works if the map is big enough to hide in. On the first
// 4×4 board it was not: a taxi offered three exits, a bus two, the underground barely one,
// so one announcement narrowed the runner to a single stop 40% of the time and the doubt
// never grew back between surfacings. Hence 30 stops, diagonal taxi hops, and six
// underground hubs — the same announcement now leaves the hunt a real question to answer.
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
// The map has to be big and well connected enough that announcing the transport does not
// hand over the position. On a 4×4 grid it did: from a known stop a taxi offered 3 exits,
// a bus 2 and the underground 1.5, so one announcement pinned the runner outright most of
// the time and the belief never recovered between surfacings.
const COLS = 5;
const ROWS = 6;
// Three agents on thirty stops. Two could not close a net this size once the map was big
// enough to hide in — half the matches ended with nobody caught either way.
const AGENTS = 3;
const HALF_BREAK_MS = 4500; // pause between the two halves

/** Transports, slowest to fastest. A runner announces which they took, never where to. */
export const TRANSPORT = [
  { key: 'taxi', name: 'Taxi', icon: '🚕' },
  { key: 'bus', name: 'Bus', icon: '🚌' },
  { key: 'tube', name: 'Underground', icon: '🚇' },
];

// The map: 30 stops on a 5×6 grid. Taxis hop to a neighbour or a diagonal, buses skip a
// stop, and the underground links six hubs right across the board.
export const NODES = Array.from({ length: COLS * ROWS }, (_, i) => ({ id: i, x: i % COLS, y: Math.floor(i / COLS) }));

function buildEdges(): number[][][] {
  const edges: number[][][] = TRANSPORT.map(() => NODES.map(() => [] as number[]));
  const link = (t: number, a: number, b: number) => {
    if (!edges[t][a].includes(b)) edges[t][a].push(b);
    if (!edges[t][b].includes(a)) edges[t][b].push(a);
  };
  const at = (x: number, y: number) => y * COLS + x;
  for (const n of NODES) {
    // taxi: orthogonal neighbours, plus diagonals — the fan-out is what buys the runner
    // room, so a taxi from an interior stop opens eight ways rather than four
    if (n.x < COLS - 1) link(0, n.id, at(n.x + 1, n.y));
    if (n.y < ROWS - 1) link(0, n.id, at(n.x, n.y + 1));
    if (n.x < COLS - 1 && n.y < ROWS - 1) link(0, n.id, at(n.x + 1, n.y + 1));
    if (n.x > 0 && n.y < ROWS - 1) link(0, n.id, at(n.x - 1, n.y + 1));
    // bus: skip a stop along a row or a column
    if (n.x < COLS - 2) link(1, n.id, at(n.x + 2, n.y));
    if (n.y < ROWS - 2) link(1, n.id, at(n.x, n.y + 2));
  }
  // underground: six hubs, each reaching clear across the map
  for (const [a, b] of [[0, 4], [4, 29], [29, 25], [25, 0], [0, 12], [12, 29], [4, 22], [22, 25], [12, 22]]) link(2, a, b);
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
  log(s, `Half ${half + 1}: ${nameOf(s, s.runner)} runs from stop ${s.startRunner + 1}, ${nameOf(s, hunterOf(s))} hunts. ${TURNS} turns.`);
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
  if (s.hunterPiece < s.hunterAt.length - 1) {
    s.hunterPiece += 1;
    return ok;
  }

  // Every agent has moved — the turn is complete.
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
  // carrying a node means exactly that, since every move pushes a fresh one. Before the
  // first move of a half the start is on show too: the second-half hunter has already run
  // from that very stop, so hiding it in the first half only made the two runs unequal —
  // and the whole match is a comparison of those two runs.
  const inTheOpen = s.trail.length === 0 || s.trail[s.trail.length - 1].node !== null;

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

/** Every stop the runner could be standing on, given ONLY what the hunt can see: the
 *  start, the transports announced since, each surfacing, and the fact that the runner
 *  never steps onto an agent. This is the deduction a human hunter does on the trail —
 *  the bot must reason from it rather than from `runnerAt`, which it is not entitled to. */
export function beliefSet(s: MHState): number[] {
  let belief = new Set<number>([s.startRunner]);
  for (const step of s.trail) {
    if (step.node !== null) {
      belief = new Set([step.node]);
      continue;
    }
    const next = new Set<number>();
    for (const from of belief) for (const to of exits(from, step.transport)) next.add(to);
    belief = next;
  }
  for (const h of s.hunterAt) belief.delete(h); // they would have been caught
  return [...belief];
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

  // Close on the whole belief set, not just the last sighting: land on a candidate stop if
  // one is in reach, otherwise take the move that sits nearest the most candidates. Agents
  // spread across the set instead of all chasing the same stop — the other agents' own
  // distances are subtracted, so this one goes where it is most needed.
  const belief = beliefSet(s);
  if (!belief.length) return { type: 'hunt', to: opts[Math.floor(rng() * opts.length)].to };
  const others = s.hunterAt.filter((_, i) => i !== s.hunterPiece).map((h) => distances(h));
  let best = opts[0];
  let bestScore = Infinity;
  for (const m of opts) {
    if (belief.includes(m.to)) return { type: 'hunt', to: m.to }; // a chance of an outright catch
    const d = distances(m.to);
    let score = 0;
    for (const b of belief) {
      const mine = d[b];
      const nearestOther = others.length ? Math.min(...others.map((o) => o[b])) : Infinity;
      score += Math.min(mine, nearestOther); // only count what nobody else already covers
    }
    score = score / belief.length + rng() * 0.25;
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
  blurb: 'One runs hidden, one hunts with three agents. Swap roles at half time — outlast their run to win.',
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
    // Agents start spread out and clear of the runner: take the stops furthest away, but
    // keep them apart from each other so they do not open the hunt bunched together.
    const far = distances(startRunner)
      .map((d, id) => ({ d, id }))
      .filter((n) => n.d >= 2)
      .sort((a, b) => b.d - a.d || a.id - b.id);
    const startHunters: number[] = [];
    for (const cand of far) {
      if (startHunters.length >= AGENTS) break;
      if (startHunters.every((h) => distances(h)[cand.id] >= 2)) startHunters.push(cand.id);
    }
    for (const cand of far) { // top up if the spacing rule was too strict for this map
      if (startHunters.length >= AGENTS) break;
      if (!startHunters.includes(cand.id)) startHunters.push(cand.id);
    }

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
