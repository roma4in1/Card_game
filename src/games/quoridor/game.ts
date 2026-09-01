// games/quoridor/game.ts — "Quoridor", an abstract pawn-race + wall game (2–4 players).
//
// The first hub game with NO hidden information and NO randomness: every player sees the
// whole board, so `view` redacts nothing. All the weight is on move-legality validation
// — especially the no-trap rule (a wall may never leave any player with no path to their
// goal), which is the only real algorithmic work here (a BFS per player).
//
// Coordinates (one convention, documented):
//   cells  = [row 0..8, col 0..8];  row 0 = bottom, row 8 = top, col 0 = left, col 8 = right.
//   walls  = { r, c, o }, where (r,c) is the top-left INTERSECTION (r,c in 0..7) and o is
//            'H' (horizontal) or 'V' (vertical). A wall is 2 cells long:
//     H at (r,c) blocks the edges (r,c)|(r+1,c) and (r,c+1)|(r+1,c+1).
//     V at (r,c) blocks the edges (r,c)|(r,c+1) and (r+1,c)|(r+1,c+1).

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { initTimer, runTimer, timerView, TIMER_OPTION, type Timer } from '../../platform/turn-timer.ts';
import { initSkill, SKILL_OPTION, CASUAL, STEADY } from '../../platform/skill.ts';

export const N = 9; // board size
export type Cell = [number, number];
export type Orient = 'H' | 'V';
export type Goal = 'top' | 'bottom' | 'left' | 'right';
export interface Wall {
  r: number;
  c: number;
  o: Orient;
}

const SETUP: Record<number, { starts: Cell[]; goals: Goal[]; walls: number }> = {
  2: { starts: [[0, 4], [8, 4]], goals: ['top', 'bottom'], walls: 10 },
  3: { starts: [[0, 4], [8, 4], [4, 0]], goals: ['top', 'bottom', 'right'], walls: 7 },
  4: { starts: [[0, 4], [8, 4], [4, 0], [4, 8]], goals: ['top', 'bottom', 'right', 'left'], walls: 5 },
};

interface QPlayer {
  name: string;
  connected: boolean;
}

export interface QState {
  players: (QPlayer | null)[]; // length 8 (room MAX_SEATS), by seat
  order: number[]; // seat per player-index 0..np-1
  np: number;
  pawns: Cell[]; // by player-index
  goals: Goal[]; // by player-index
  wallsLeft: number[]; // by player-index
  walls: Wall[];
  turn: number; // active player-index
  turnStage: 'start' | 'moved'; // 'moved' = pawn already moved this turn, may still wall or end
  winner: number | null; // player-index
  over: boolean;
  timer: Timer; // opt-in per-turn countdown
  skill: number; // how hard the bots play (1 casual … 3 sharp)
  moveLog: string[];
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function log(s: QState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const onBoard = (r: number, c: number) => r >= 0 && r < N && c >= 0 && c < N;
const isGoal = (goal: Goal, r: number, c: number) =>
  goal === 'top' ? r === N - 1 : goal === 'bottom' ? r === 0 : goal === 'left' ? c === 0 : c === N - 1;

// ---------------------------------------------------------------------------
// Wall ⇄ edge geometry
// ---------------------------------------------------------------------------

function edgeKey(r1: number, c1: number, r2: number, c2: number): string {
  if (r1 > r2 || (r1 === r2 && c1 > c2)) return `${r2},${c2}|${r1},${c1}`;
  return `${r1},${c1}|${r2},${c2}`;
}

function blockedEdges(walls: Wall[]): Set<string> {
  const set = new Set<string>();
  for (const w of walls) {
    if (w.o === 'H') {
      set.add(edgeKey(w.r, w.c, w.r + 1, w.c));
      set.add(edgeKey(w.r, w.c + 1, w.r + 1, w.c + 1));
    } else {
      set.add(edgeKey(w.r, w.c, w.r, w.c + 1));
      set.add(edgeKey(w.r + 1, w.c, w.r + 1, w.c + 1));
    }
  }
  return set;
}
const isEdgeBlocked = (bs: Set<string>, r1: number, c1: number, r2: number, c2: number) => bs.has(edgeKey(r1, c1, r2, c2));

/** A new wall overlaps an existing one, or crosses a perpendicular wall at the same slot. */
function wallConflicts(walls: Wall[], r: number, c: number, o: Orient): boolean {
  for (const w of walls) {
    if (w.r === r && w.c === c) return true; // same slot: duplicate or a perpendicular cross
    if (o === 'H' && w.o === 'H' && w.r === r && Math.abs(w.c - c) === 1) return true; // colinear overlap
    if (o === 'V' && w.o === 'V' && w.c === c && Math.abs(w.r - r) === 1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pathfinding (no-trap rule) + bot distances
// ---------------------------------------------------------------------------

function bfsCanReach(bs: Set<string>, start: Cell, goal: Goal): boolean {
  const seen = new Set<string>([`${start[0]},${start[1]}`]);
  const queue: Cell[] = [start];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length) {
    const [r, c] = queue.shift()!;
    if (isGoal(goal, r, c)) return true;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (!onBoard(nr, nc) || isEdgeBlocked(bs, r, c, nr, nc)) continue;
      const key = `${nr},${nc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nr, nc]);
    }
  }
  return false;
}

/** Distance from every cell to the nearest goal-edge cell (walls block; pawns ignored). */
function distToGoal(bs: Set<string>, goal: Goal): number[][] {
  const dist = Array.from({ length: N }, () => new Array(N).fill(Infinity));
  const queue: Cell[] = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      if (isGoal(goal, r, c)) ((dist[r][c] = 0), queue.push([r, c]));
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length) {
    const [r, c] = queue.shift()!;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (!onBoard(nr, nc) || isEdgeBlocked(bs, r, c, nr, nc) || dist[nr][nc] < Infinity) continue;
      dist[nr][nc] = dist[r][c] + 1;
      queue.push([nr, nc]);
    }
  }
  return dist;
}

function everyoneHasPath(walls: Wall[], s: QState): boolean {
  const bs = blockedEdges(walls);
  for (let pid = 0; pid < s.np; pid++) if (!bfsCanReach(bs, s.pawns[pid], s.goals[pid])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Legal moves (base move + jump rules)
// ---------------------------------------------------------------------------

function occupantAt(s: QState, r: number, c: number): number {
  return s.pawns.findIndex((p) => p[0] === r && p[1] === c);
}

function legalMoves(s: QState): Cell[] {
  const pid = s.turn;
  const [r, c] = s.pawns[pid];
  const bs = blockedEdges(s.walls);
  const out: Cell[] = [];
  const push = (rr: number, cc: number) => {
    if (!out.some((m) => m[0] === rr && m[1] === cc)) out.push([rr, cc]);
  };
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dr, dc] of DIRS) {
    const nr = r + dr;
    const nc = c + dc;
    if (!onBoard(nr, nc) || isEdgeBlocked(bs, r, c, nr, nc)) continue;
    if (occupantAt(s, nr, nc) < 0) {
      push(nr, nc);
      continue;
    }
    // A pawn is in the way — try to jump it.
    const br = r + 2 * dr;
    const bc = c + 2 * dc;
    const straightOk = onBoard(br, bc) && !isEdgeBlocked(bs, nr, nc, br, bc) && occupantAt(s, br, bc) < 0;
    if (straightOk) {
      push(br, bc);
      continue;
    }
    // Straight blocked/occupied/off-board → diagonal beside the jumped pawn.
    for (const [pr, pc] of [[dc, dr], [-dc, -dr]]) {
      const dr2 = nr + pr;
      const dc2 = nc + pc;
      if (onBoard(dr2, dc2) && !isEdgeBlocked(bs, nr, nc, dr2, dc2) && occupantAt(s, dr2, dc2) < 0) push(dr2, dc2);
    }
  }
  return out;
}

function legalWalls(s: QState): Wall[] {
  if (s.wallsLeft[s.turn] <= 0) return [];
  const out: Wall[] = [];
  for (let r = 0; r < N - 1; r++) {
    for (let c = 0; c < N - 1; c++) {
      for (const o of ['H', 'V'] as Orient[]) {
        if (wallConflicts(s.walls, r, c, o)) continue;
        if (everyoneHasPath([...s.walls, { r, c, o }], s)) out.push({ r, c, o });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function nextTurn(s: QState) {
  s.turn = (s.turn + 1) % s.np;
  s.turnStage = 'start';
}

function movePawn(s: QState, pid: number, toCell: unknown): ActionResult {
  if (pid !== s.turn) return fail('Not your turn.');
  if (s.turnStage !== 'start') return fail('You already moved this turn.');
  if (!Array.isArray(toCell) || toCell.length !== 2) return fail('Bad target.');
  const [tr, tc] = [Number(toCell[0]), Number(toCell[1])];
  if (!legalMoves(s).some((m) => m[0] === tr && m[1] === tc)) return fail('Illegal move.');
  s.pawns[pid] = [tr, tc];
  log(s, `${s.players[s.order[pid]]!.name} moves to (${tr}, ${tc}).`);
  if (isGoal(s.goals[pid], tr, tc)) {
    s.winner = pid;
    s.over = true;
    log(s, `🏁 ${s.players[s.order[pid]]!.name} reaches the goal and wins!`);
    return ok;
  }
  // Stay on this player's turn so they may optionally place a wall (if any left).
  if (s.wallsLeft[pid] > 0) s.turnStage = 'moved';
  else nextTurn(s);
  return ok;
}

function endTurn(s: QState, pid: number): ActionResult {
  if (pid !== s.turn) return fail('Not your turn.');
  if (s.turnStage !== 'moved') return fail('Move first, then you may end your turn.');
  nextTurn(s);
  return ok;
}

function placeWall(s: QState, pid: number, slot: unknown, orientation: unknown): ActionResult {
  if (pid !== s.turn) return fail('Not your turn.');
  if (s.wallsLeft[pid] <= 0) return fail('No walls left.');
  if (!Array.isArray(slot) || slot.length !== 2) return fail('Bad wall slot.');
  const r = Number(slot[0]);
  const c = Number(slot[1]);
  const o = orientation === 'V' ? 'V' : orientation === 'H' ? 'H' : null;
  if (!o) return fail('Bad orientation.');
  if (r < 0 || r >= N - 1 || c < 0 || c >= N - 1) return fail('Wall is off the board.');
  if (wallConflicts(s.walls, r, c, o)) return fail('That wall overlaps or crosses another.');
  if (!everyoneHasPath([...s.walls, { r, c, o }], s)) return fail('That wall would trap a player with no path to their goal.');
  s.walls.push({ r, c, o });
  s.wallsLeft[pid] -= 1;
  log(s, `${s.players[s.order[pid]]!.name} places a ${o === 'H' ? 'horizontal' : 'vertical'} wall at (${r}, ${c}).`);
  nextTurn(s);
  return ok;
}

// ---------------------------------------------------------------------------
// View — identical full public state for everyone (no redaction)
// ---------------------------------------------------------------------------

function viewState(s: QState, seat: number | null): Record<string, unknown> {
  const myPid = seat !== null ? s.order.indexOf(seat) : -1;
  const pawns = Array.from({ length: s.np }, (_, pid) => ({
    pid,
    seat: s.order[pid],
    name: s.players[s.order[pid]]!.name,
    connected: s.players[s.order[pid]]!.connected,
    pos: s.pawns[pid],
    goal: s.goals[pid],
    wallsLeft: s.wallsLeft[pid],
    isTurn: !s.over && pid === s.turn,
  }));

  // Legal options are the active player's; identical for everyone (public).
  // A pawn may move only at the start of its turn; a wall any time it has supply.
  const legal = s.over
    ? { moves: [], walls: [] }
    : { moves: s.turnStage === 'start' ? legalMoves(s) : [], walls: s.wallsLeft[s.turn] > 0 ? legalWalls(s) : [] };

  return {
    game: 'quoridor',
    phase: s.over ? 'done' : 'play',
    over: s.over,
    boardSize: N,
    pawns,
    walls: s.walls,
    turn: s.turn,
    turnStage: s.turnStage,
    activeSeat: s.over ? null : s.order[s.turn],
    timer: timerView(s.timer),
    legal,
    you:
      myPid >= 0
        ? {
            seat,
            pid: myPid,
            goal: s.goals[myPid],
            wallsLeft: s.wallsLeft[myPid],
            isTurn: !s.over && myPid === s.turn,
            turnStage: s.turnStage,
            canMove: !s.over && myPid === s.turn && s.turnStage === 'start',
            canWall: !s.over && myPid === s.turn && s.wallsLeft[myPid] > 0,
            canEndTurn: !s.over && myPid === s.turn && s.turnStage === 'moved',
          }
        : { seat: seat ?? -1, spectator: true },
    winner: s.over ? s.winner : null,
    winners: s.over && s.winner !== null ? [s.order[s.winner]] : null,
    log: s.log.slice(-15),
    matchWinner: null,
  };
}

// ---------------------------------------------------------------------------
// Bot — races AND walls, searching its own turn and the reply to it.
//
// The old bot only ever walked its shortest path and never placed a wall, which throws
// away half of Quoridor: a player who never walls loses the race to anyone who does.
// This one scores positions by the classic measure — how much further the opposition has
// to walk than you do — counting walls still in hand, since spending your last one ends
// your leverage.
//
// Walls are not enumerated blindly (128 slots, each needing a path check for every
// player). Only a wall lying across the opponent's current shortest route can cost them
// a step, so those are the only ones worth searching.
// ---------------------------------------------------------------------------

// --- turn timer: signature of the current turn, and the auto-move on timeout ---
const qTurnKey = (s: QState): string => (s.over ? '' : `${s.turn}:${s.turnStage}`);
function qForceTimeout(s: QState, rng: Rng) {
  const pid = s.turn;
  const mv = botMove(s, s.order[pid], rng);
  if (!mv) return;
  if (mv.type === 'movePawn') movePawn(s, pid, mv.toCell);
  else if (mv.type === 'endTurn') endTurn(s, pid);
}

/** The part of a position the search moves around. */
interface QSim {
  pawns: Cell[];
  walls: Wall[];
  wallsLeft: number[];
  goals: Goal[];
  np: number;
}
const simOf = (s: QState): QSim => ({ pawns: s.pawns.map((p) => [...p] as Cell), walls: [...s.walls], wallsLeft: [...s.wallsLeft], goals: [...s.goals], np: s.np });
const distOf = (sim: QSim, pid: number, bs: Set<string>) => distToGoal(bs, sim.goals[pid])[sim.pawns[pid][0]][sim.pawns[pid][1]];

const WIN = 10000;

const STEP = 100; // one step of the race, in evaluation points
const WALL_WORTH = 22; // a wall still in hand, in the same units (~a fifth of a step)

/** How far ahead `me` is, counted in steps of the race — and crucially, WHO IS TO MOVE.
 *
 *  Once the walls are gone the game is a pure race, and its result is exact: the player
 *  to move gets home first whenever their walk is no longer than their opponent's. So a
 *  turn-blind evaluation is not merely imprecise, it is wrong by a whole step half the
 *  time, and it is wrong in ALTERNATING directions as the search goes deeper — which is
 *  what made searching further play worse rather than better. The half-step of tempo
 *  below puts the boundary in exactly the right place for both sides to move, so the sign
 *  of this function predicts a walls-free race outright. */
function evalSim(sim: QSim, me: number, toMove: number): number {
  const bs = blockedEdges(sim.walls);
  const mine = distOf(sim, me, bs);
  if (mine === 0) return WIN;
  let best = Infinity;
  for (let pid = 0; pid < sim.np; pid++) {
    if (pid === me) continue;
    const d = distOf(sim, pid, bs);
    if (d === 0) return -WIN;
    best = Math.min(best, d);
  }
  const tempo = toMove === me ? 0.5 : -0.5;
  const rivalWalls = Math.max(...sim.wallsLeft.filter((_, i) => i !== me));
  // Walls in hand are only worth something while there is still a race to shape: with the
  // opponent one step from home, a wall you are still holding has no time left to be used.
  const room = Math.min(1, Math.min(mine, best) / 6);
  return (best - mine + tempo) * STEP + (sim.wallsLeft[me] - rivalWalls) * WALL_WORTH * room;
}

/** The evaluation, on a real game state — exposed so the position suite can pin it down. */
export function evaluatePosition(s: QState, me: number, toMove: number): number {
  return evalSim(simOf(s), me, toMove);
}

/** Legal pawn steps for `pid` on a sim board — reuses the real rules, jumps included. */
function simMoves(sim: QSim, pid: number): Cell[] {
  return legalMoves({ pawns: sim.pawns, walls: sim.walls, turn: pid } as unknown as QState);
}

/** Walls worth considering: those lying across `target`'s shortest route. A wall anywhere
 *  else cannot lengthen their walk at all, so it cannot be this turn's best move. */
let WALL_CANDIDATES = 8; // per node; walls further along their route rarely matter yet
function candidateWalls(sim: QSim, placer: number, target: number): Wall[] {
  if (sim.wallsLeft[placer] <= 0) return [];
  const bs = blockedEdges(sim.walls);
  const dist = distToGoal(bs, sim.goals[target]);
  const slots = new Map<string, Wall>();
  let [r, c] = sim.pawns[target];
  if (!Number.isFinite(dist[r][c])) return [];
  for (let step = 0; step < N * 2 && dist[r][c] > 0; step++) {
    let nr = r;
    let nc = c;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ar = r + dr;
      const ac = c + dc;
      if (!onBoard(ar, ac) || isEdgeBlocked(bs, r, c, ar, ac)) continue;
      if (dist[ar][ac] === dist[r][c] - 1) { nr = ar; nc = ac; break; }
    }
    if (nr === r && nc === c) break;
    const vertical = nr !== r; // a step between rows is cut by a HORIZONTAL wall
    for (const off of [0, -1]) {
      const wr = vertical ? Math.min(r, nr) : r + off;
      const wc = vertical ? c + off : Math.min(c, nc);
      if (wr < 0 || wc < 0 || wr >= N - 1 || wc >= N - 1) continue;
      const o: Orient = vertical ? 'H' : 'V';
      slots.set(`${wr},${wc},${o}`, { r: wr, c: wc, o });
    }
    r = nr;
    c = nc;
  }
  // Insertion order is path order — the stops nearest their pawn come first, and those
  // are the walls that bite soonest. Cap the list BEFORE the legality check, because
  // `everyoneHasPath` is a BFS per player and it is the most expensive thing here.
  const fake = { pawns: sim.pawns, goals: sim.goals, np: sim.np } as unknown as QState;
  const out: Wall[] = [];
  for (const w of slots.values()) {
    if (out.length >= WALL_CANDIDATES) break;
    if (!wallConflicts(sim.walls, w.r, w.c, w.o) && everyoneHasPath([...sim.walls, w], fake)) out.push(w);
  }
  return out;
}

/** A whole turn. In this rule set a turn is a step and, optionally, a wall on top of it —
 *  or a wall on its own. Searching single actions instead (as this bot used to) quietly
 *  models the opponent replying to your step before you have finished your own turn. */
interface QTurn {
  move?: Cell;
  wall?: Wall;
}

function applyTurn(sim: QSim, pid: number, t: QTurn): QSim {
  const next: QSim = { pawns: sim.pawns.map((p) => [...p] as Cell), walls: [...sim.walls], wallsLeft: [...sim.wallsLeft], goals: sim.goals, np: sim.np };
  if (t.move) next.pawns[pid] = [...t.move] as Cell;
  if (t.wall) {
    next.walls.push(t.wall);
    next.wallsLeft[pid] -= 1;
  }
  return next;
}

/** Turns worth searching, best-looking first — alpha-beta lives or dies on this ordering.
 *  Steps come first (sorted by the ground they gain), then walls paired with the single
 *  best step, then walls alone. Pairing every wall with every step would square the
 *  branching for almost no gain: the two choices barely interact within one turn. */
function candidateTurns(sim: QSim, pid: number, foe: number): QTurn[] {
  const bs = blockedEdges(sim.walls);
  const dist = distToGoal(bs, sim.goals[pid]);
  const moves = simMoves(sim, pid).sort((a, b) => dist[a[0]][a[1]] - dist[b[0]][b[1]]);
  const walls = candidateWalls(sim, pid, foe); // already in "bites soonest" order
  const out: QTurn[] = moves.map((move) => ({ move }));
  if (moves.length) for (const wall of walls) out.push({ move: moves[0], wall });
  for (const wall of walls) out.push({ wall });
  return out;
}

// --- transposition table -----------------------------------------------------
// Quoridor transposes heavily: the same position is reached by many orders of the same
// walls, so without this the search re-solves identical boards over and over.
const ZOB_SEED = 0x9e3779b9;
function zobRand(n: number): number[] {
  // A fixed, cheap PRNG — the table only has to be consistent within a process.
  const out = new Array(n);
  let x = ZOB_SEED;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x >>> 0;
  }
  return out;
}
const ZOB_WALL = zobRand((N - 1) * (N - 1) * 2);
const ZOB_PAWN = zobRand(4 * N * N);
const ZOB_LEFT = zobRand(4 * 32);
const ZOB_SIDE = zobRand(4);
const ZOB_GOAL = zobRand(4 * 4);
const GOAL_INDEX: Record<Goal, number> = { top: 0, bottom: 1, left: 2, right: 3 };

function hashOf(sim: QSim, toMove: number, me: number): number {
  // Three things beyond the board itself have to be in this key, because the table now
  // outlives a single decision:
  //   • `me` — a stored value is scored from ONE player's side. Reusing player 0's number
  //     for player 1 reads every evaluation with its sign flipped, which measurably lost
  //     games before it was keyed in.
  //   • the goals and the player count — the same pawns behind the same walls mean
  //     something else entirely in a 4-player game, or with the goals dealt the other way.
  let h = (ZOB_SIDE[toMove] ^ ZOB_SIDE[me] * 0x27d4eb2d ^ sim.np * 0x85ebca6b) >>> 0;
  for (let pid = 0; pid < sim.np; pid++) h = (h ^ ZOB_GOAL[pid * 4 + GOAL_INDEX[sim.goals[pid]]]) >>> 0;
  for (const w of sim.walls) h = (h ^ ZOB_WALL[(w.r * (N - 1) + w.c) * 2 + (w.o === 'H' ? 0 : 1)]) >>> 0;
  for (let pid = 0; pid < sim.np; pid++) {
    h = (h ^ ZOB_PAWN[pid * N * N + sim.pawns[pid][0] * N + sim.pawns[pid][1]]) >>> 0;
    h = (h ^ ZOB_LEFT[pid * 32 + Math.min(31, sim.wallsLeft[pid])]) >>> 0;
  }
  return h >>> 0;
}

interface TTEntry {
  depth: number;
  value: number;
  flag: 'exact' | 'lower' | 'upper';
}

// Scoped to a single decision, deliberately. A process-wide table was tried and measured
// no better, and it is not free: it couples every room on the server to one mutable cache
// and every field that distinguishes two positions has to be in the key or the search
// reads someone else's numbers. Not worth it for a wash.

/** Alpha-beta over whole turns, with the table above. The node budget keeps a deep search
 *  from stalling the server — every room shares one thread, so this must stay bounded.
 *  `ctl.aborted` records that the budget cut the search short: nothing computed after that
 *  point may be filed in the table, because it is a stand-pat guess wearing the depth it
 *  never actually searched. Storing those poisons every later search that reads them. */
function search(sim: QSim, me: number, toMove: number, depth: number, alpha: number, beta: number, tt: Map<number, TTEntry>, ctl: { aborted: boolean; nodes: number; budget: number }): number {
  // The budget is counted in NODES, not milliseconds. A wall-clock limit makes the bot
  // play differently depending on what else the server is doing — strength that varies
  // with load, and tests that pass alone and fail in a full run.
  //
  // Count LEAVES as well as interior nodes: a leaf still costs two path searches, and
  // there are twenty of them per interior node, so counting only the interior ones left
  // the budget measuring about 5% of the actual work.
  //
  // There is no wall-clock cap alongside it. The node count already bounds the work, and
  // a clock on top only puts the load-dependence back — with both, the same position
  // played out differently from one run to the next.
  ctl.nodes += 1;
  if (depth === 0) return evalSim(sim, me, toMove);
  if (ctl.nodes > ctl.budget) {
    ctl.aborted = true;
    return evalSim(sim, me, toMove);
  }
  const key = hashOf(sim, toMove, me);
  const hit = tt.get(key);
  if (hit && hit.depth >= depth) {
    if (hit.flag === 'exact') return hit.value;
    if (hit.flag === 'lower' && hit.value > alpha) alpha = hit.value;
    else if (hit.flag === 'upper' && hit.value < beta) beta = hit.value;
    if (alpha >= beta) return hit.value;
  }

  const foe = toMove === me ? (me + 1) % sim.np : me;
  const turns = candidateTurns(sim, toMove, foe);
  if (!turns.length) return evalSim(sim, me, toMove);

  const maximising = toMove === me;
  const alpha0 = alpha;
  const beta0 = beta;
  let best = maximising ? -Infinity : Infinity;
  for (const t of turns) {
    let v: number;
    if (t.move && isGoal(sim.goals[toMove], t.move[0], t.move[1])) v = maximising ? WIN : -WIN;
    else v = search(applyTurn(sim, toMove, t), me, (toMove + 1) % sim.np, depth - 1, alpha, beta, tt, ctl);
    if (maximising) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break; // this line is already refuted
  }

  if (!ctl.aborted) {
    const flag: TTEntry['flag'] = best <= alpha0 ? 'upper' : best >= beta0 ? 'lower' : 'exact';
    tt.set(key, { depth, value: best, flag });
  }
  return best;
}

const NODE_BUDGET = 800; // per decision — deterministic, so play never depends on load

function botMove(s: QState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.over) return null;
  const pid = s.order.indexOf(seat);
  if (pid !== s.turn) return null;
  const sim = simOf(s);
  const foe = (pid + 1) % s.np;
  // Casual never walls at all — it just races, which is exactly the beginner's mistake
  // and exactly what this bot used to do at every level.
  if (s.skill <= CASUAL) {
    if (s.turnStage === 'moved') return { type: 'endTurn' };
    const dist = distToGoal(blockedEdges(s.walls), s.goals[pid]);
    const moves = simMoves(sim, pid);
    if (!moves.length) return null;
    let pick = moves[0];
    let bestD = Infinity;
    for (const m of moves) {
      const d = dist[m[0]][m[1]] + rng() * 0.5;
      if (d < bestD) {
        bestD = d;
        pick = m;
      }
    }
    return { type: 'movePawn', toCell: pick };
  }

  // The search is deterministic, so without this every bot match is the identical game
  // and a human who beat it once could replay the line forever. A step is worth 12, so
  // this only ever separates options the search already rated level.
  const jitter = () => rng() * 3;
  // Search COMPLETE ROUNDS only. A depth here is one player's whole turn, so stopping on
  // an odd one hands the bot a turn the opponent never gets to answer — it then rates the
  // position as if it moved twice in a row.
  //
  // Depth used to make this bot actively WORSE: four turns lost to two, 40-60. That was
  // never the search — it was the evaluation, which could not tell whose move it was and
  // so misjudged every race by a step, in alternating directions as the tree deepened.
  // With the tempo term in `evalSim` that reverses: four turns now beats two, 58-42.
  //
  // It still does not pay for its keep HERE, though. Given a fixed node budget, a second
  // round costs more than it returns — Sharp at four turns fell to 48% against Steady,
  // where Sharp at two turns beats the same opponent 65%. The budget buys more by weighing
  // more walls than by looking further ahead, so both levels search one round and Sharp is
  // separated by breadth. Worth revisiting if the evaluation gets sharper still: the
  // position suite in eval.test.ts is there to make that measurable rather than hopeful.
  const maxDepth = 2;
  WALL_CANDIDATES = s.skill <= STEADY ? 3 : 8;
  const budget = s.skill <= STEADY ? 150 : NODE_BUDGET;
  const tt = new Map<number, TTEntry>();
  const ctl = { aborted: false, nodes: 0, budget };
  if (s.turnStage === 'moved') {
    // The step is taken; all that is left is whether a wall is worth one of ours.
    const walls = candidateWalls(sim, pid, foe);
    if (!walls.length) return { type: 'endTurn' };
    let best: Wall | null = null;
    let bestValue = -Infinity;
    for (let depth = 2; depth <= maxDepth; depth += 2) {
      if (ctl.aborted) break;
      let holdValue = search(sim, pid, foe, depth, -Infinity, Infinity, tt, ctl) + jitter();
      let localBest: Wall | null = null;
      let localValue = holdValue;
      for (const wall of walls) {
        const v = search(applyTurn(sim, pid, { wall }), pid, foe, depth, -Infinity, Infinity, tt, ctl) + jitter();
        if (v > localValue) {
          localValue = v;
          localBest = wall;
        }
      }
      best = localBest;
      bestValue = localValue;
    }
    return best ? { type: 'placeWall', slot: [best.r, best.c], orientation: best.o } : { type: 'endTurn' };
  }

  let moves = simMoves(sim, pid);
  if (!moves.length) return null; // no-trap guarantees this won't happen
  for (const m of moves) if (isGoal(s.goals[pid], m[0], m[1])) return { type: 'movePawn', toCell: m }; // take the win

  // Iterative deepening: each pass reuses the table the last one filled, so the deeper
  // search is far cheaper than it looks, and we always have a finished answer in hand.
  //
  // Ties are broken toward the square nearer our own goal, and that is not cosmetic:
  // there is no repetition rule in this game, and two squares an equal walk from the goal
  // evaluate identically, so a bot with nothing else to separate them will step between
  // the pair forever. Preferring progress guarantees it always has a reason to move on.
  const myDist = distToGoal(blockedEdges(sim.walls), sim.goals[pid]);
  const closeness = (m: Cell) => -myDist[m[0]][m[1]];
  // Never step AWAY from the goal while a step toward it exists. This is a guarantee, not
  // a preference: the game has no repetition rule, so without it two bots can shuffle
  // between the same squares forever — which they measurably did, a 4-move cycle that ran
  // until the test's guard gave up. Restricting the pawn to forward steps makes its
  // distance strictly decrease every turn it can move, so a match always terminates.
  // Walls are unaffected and still chosen by the full search, which is where the play is.
  const here = myDist[sim.pawns[pid][0]][sim.pawns[pid][1]];
  const forward = moves.filter((m) => myDist[m[0]][m[1]] < here);
  if (forward.length) moves = forward;
  let best = moves[0];
  for (let depth = 2; depth <= maxDepth; depth += 2) {
    if (ctl.aborted) break;
    let localBest = moves[0];
    let localValue = -Infinity;
    let localClose = -Infinity;
    for (const move of moves) {
      const v = search(applyTurn(sim, pid, { move }), pid, foe, depth, -Infinity, Infinity, tt, ctl) + jitter();
      const c = closeness(move);
      if (v > localValue || (v === localValue && c > localClose)) {
        localValue = v;
        localClose = c;
        localBest = move;
      }
    }
    best = localBest;
  }
  return { type: 'movePawn', toCell: best };
}


// ---------------------------------------------------------------------------
// GameDef plugin
// ---------------------------------------------------------------------------

export const quoridor: GameDef<QState> = {
  id: 'quoridor',
  name: 'Quoridor',
  blurb: 'Race your pawn to the far side — or wall off your rivals. Pure strategy, no luck.',
  minPlayers: 2,
  maxPlayers: 4,
  options: [SKILL_OPTION, TIMER_OPTION],

  validateStart(seats) {
    return seats.length === 2 || seats.length === 3 || seats.length === 4 ? null : 'Quoridor is for 2, 3 or 4 players.';
  },

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }): QState {
    const np = setup.seats.length;
    const cfg = SETUP[np];
    const players: (QPlayer | null)[] = new Array(8).fill(null);
    const nameBySeat = new Map(setup.players.map((p) => [p.seat, p.name]));
    for (const seat of setup.seats) players[seat] = { name: nameBySeat.get(seat) ?? `Seat ${seat + 1}`, connected: true };
    const s: QState = {
      players,
      order: [...setup.seats],
      np,
      pawns: cfg.starts.map((cell) => [cell[0], cell[1]] as Cell),
      goals: [...cfg.goals],
      wallsLeft: new Array(np).fill(cfg.walls),
      walls: [],
      turn: 0,
      turnStage: 'start',
      winner: null,
      over: false,
      timer: initTimer(setup.options?.timer),
      skill: initSkill(setup.options?.skill),
      moveLog: [],
      log: [],
    };
    log(s, `${np}-player Quoridor — ${cfg.walls} walls each. ${players[s.order[0]]!.name} starts.`);
    return s;
  },

  act(s, seat, msg) {
    if (s.over) return fail('The game is over.');
    const pid = s.order.indexOf(seat);
    if (pid < 0) return fail('You are not in this match.');
    switch (msg.type) {
      case 'movePawn':
        return movePawn(s, pid, msg.toCell);
      case 'placeWall':
        return placeWall(s, pid, msg.slot, msg.orientation);
      case 'endTurn':
        return endTurn(s, pid);
    }
  },

  tick(s, ctx) {
    return runTimer(s.timer, () => qTurnKey(s), ctx.now, () => qForceTimeout(s, ctx.rng));
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
    return { over: s.over, winners: s.over && s.winner !== null ? [s.order[s.winner]] : [] };
  },

  bot(s, seat, ctx) {
    return botMove(s, seat, ctx.rng);
  },
};
