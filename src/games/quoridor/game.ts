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
import { initSkill, GRANDMASTER_SKILL_OPTION, CASUAL, STEADY, SHARP, MASTER, GRANDMASTER } from '../../platform/skill.ts';

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
  turnsPlayed: number; // completed turns, so the bots can tell an opening from a middlegame
  winner: number | null; // player-index
  over: boolean;
  timer: Timer; // opt-in per-turn countdown
  skill: number; // how hard the bots play (1 casual … 5 grandmaster)
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
const DIRS4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const onBoard = (r: number, c: number) => r >= 0 && r < N && c >= 0 && c < N;
const isGoal = (goal: Goal, r: number, c: number) =>
  goal === 'top' ? r === N - 1 : goal === 'bottom' ? r === 0 : goal === 'left' ? c === 0 : c === N - 1;

// ---------------------------------------------------------------------------
// Wall ⇄ edge geometry
// ---------------------------------------------------------------------------

// Edges are numbered, not named. Every path search asks "is this edge walled?" for each
// of four neighbours of every cell it visits, so this is the hottest operation in the
// game — and it used to build a string like "3,4|4,4" and hash it into a Set each time.
// Numbering the board's 144 edges turns that into one multiply and an array read.
//
//   0..71   a step between rows r and r+1 in column c   → r * N + c        (r < N-1)
//   72..143 a step between columns c and c+1 in row r   → 72 + r * (N-1) + c
const V_EDGES = (N - 1) * N; // 72 vertical steps
const EDGE_COUNT = V_EDGES * 2;
export type Blocked = Uint8Array;

/** The index of the edge between two ADJACENT cells. */
function edgeIndex(r1: number, c1: number, r2: number, c2: number): number {
  return c1 === c2 ? Math.min(r1, r2) * N + c1 : V_EDGES + r1 * (N - 1) + Math.min(c1, c2);
}

function blockedEdges(walls: Wall[]): Blocked {
  const bs = new Uint8Array(EDGE_COUNT);
  for (const w of walls) {
    if (w.o === 'H') {
      // blocks stepping between rows w.r and w.r+1, in both columns it spans
      bs[w.r * N + w.c] = 1;
      bs[w.r * N + w.c + 1] = 1;
    } else {
      // blocks stepping between columns w.c and w.c+1, in both rows it spans
      bs[V_EDGES + w.r * (N - 1) + w.c] = 1;
      bs[V_EDGES + (w.r + 1) * (N - 1) + w.c] = 1;
    }
  }
  return bs;
}
const isEdgeBlocked = (bs: Blocked, r1: number, c1: number, r2: number, c2: number) => bs[edgeIndex(r1, c1, r2, c2)] === 1;

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
// Pathfinding (no-trap rule)
// ---------------------------------------------------------------------------

function bfsCanReach(bs: Blocked, start: Cell, goal: Goal): boolean {
  // Flat arrays and a read pointer rather than a Set of "r,c" strings and shift().
  const seen = new Uint8Array(N * N);
  const queue = new Int16Array(N * N);
  let head = 0;
  let tail = 0;
  queue[tail++] = start[0] * N + start[1];
  seen[start[0] * N + start[1]] = 1;
  while (head < tail) {
    const cell = queue[head++];
    const r = (cell / N) | 0;
    const c = cell % N;
    if (isGoal(goal, r, c)) return true;
    for (const [dr, dc] of DIRS4) {
      const nr = r + dr;
      const nc = c + dc;
      if (!onBoard(nr, nc) || isEdgeBlocked(bs, r, c, nr, nc)) continue;
      const next = nr * N + nc;
      if (seen[next]) continue;
      seen[next] = 1;
      queue[tail++] = next;
    }
  }
  return false;
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
  for (const [dr, dc] of DIRS4) {
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
  s.turnsPlayed += 1;
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
// Bot — races AND walls, searching whole turns.
//
// Positions are scored by the classic measure — how much further the opposition has to
// walk than you do — plus the walls still in hand. Walls are not enumerated blindly (128
// slots, each needing a path check for every player): only a wall lying across a rival's
// shortest route can cost them a step, so those are the only ones worth searching.
//
// What the previous version got wrong, each measured before it was changed:
//
//   • It spent its walls in the opening. A wall in hand was worth a fifth of a step, so
//     any wall that cost the opponent one step read as a gain. See WALL_WORTH.
//   • With three or four players it only ever walled the NEXT player in turn order — not
//     whoever was about to win. Walls now go on the rival nearest to arriving.
//   • It chose its step assuming no wall would follow it, then chose the wall afterwards.
//     A turn is now searched whole: a step, a step and a wall, or a wall alone.
//   • It rebuilt the wall map and allocated fresh distance tables for every position.
//     The board is now flat arrays, played and taken back in place, and a step with no
//     wall reuses the distances it already has.
//
// Measured against it, seats rotated: the new Sharp wins 98.5% of 2-player games, 95% of
// 3-player games against two old bots, and 91% of 4-player games against three. A player
// as strong as the old bot, facing three new ones, wins 6.6%.
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

// ---------------------------------------------------------------------------
// Bot engine — the board as flat arrays
// ---------------------------------------------------------------------------

const WIN = 10000;
const STEP = 100; // one step of the race, in evaluation points
// A wall still in hand, in the same units. It was a fifth of a step (22), and the bot spent
// its walls in the opening, a step at a time, because any wall that cost the opponent one
// step read as a gain. Played out, holding them is worth far more. Against the old bot:
// 22 won 65% of 2-player games, 100 won 85%, 130 won 94%. Head to head, 250 beat 170 and
// 200 (61%, 61%), and neither 300 nor 350 beat it. At this value a wall is spent on a long
// detour, or on a race it decides — never on a single step.
const WALL_WORTH = 250;
// How far from home a walk must be for walls held against it to count in full. Measured
// on the rival's walk: 4 and 6 steps played alike, 8 lost (45%).
const ROOM_STEPS = 6;

// --- Zobrist keys --------------------------------------------------------------
// Quoridor transposes heavily: the same walls arrive in many orders, so without a table
// the search re-solves identical boards over and over.
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

const CELLS = N * N;
const SLOTS = (N - 1) * (N - 1);
const NOMOVE = 255; // a turn that leaves the pawn where it is
const NOWALL = 255; // a turn with no wall in it

/** cell * 4 + direction → the neighbouring cell (-1 off the board), and the edge crossed. */
const NB_CELL = new Int16Array(CELLS * 4).fill(-1);
const NB_EDGE = new Int16Array(CELLS * 4).fill(-1);
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    for (let d = 0; d < 4; d++) {
      const nr = r + DIRS4[d][0];
      const nc = c + DIRS4[d][1];
      if (!onBoard(nr, nc)) continue;
      NB_CELL[(r * N + c) * 4 + d] = nr * N + nc;
      NB_EDGE[(r * N + c) * 4 + d] = edgeIndex(r, c, nr, nc);
    }
  }
}
const GOALS: Goal[] = ['top', 'bottom', 'right', 'left'];
const GOAL_CELLS: number[][] = GOALS.map((g) => {
  const out: number[] = [];
  for (let cell = 0; cell < CELLS; cell++) if (isGoal(g, (cell / N) | 0, cell % N)) out.push(cell);
  return out;
});
const IS_GOAL = new Uint8Array(4 * CELLS);
GOAL_CELLS.forEach((cells, g) => cells.forEach((cell) => { IS_GOAL[g * CELLS + cell] = 1; }));

// A wall is a number: slot * 2 + (0 horizontal | 1 vertical), slot = r * (N - 1) + c —
// the same numbering as the Zobrist table below. These are the two edges each one blocks,
// and, the other way round, the (up to) two walls that can block each edge.
const WALL_E1 = new Int16Array(SLOTS * 2);
const WALL_E2 = new Int16Array(SLOTS * 2);
const EDGE_WALLS = new Int16Array(EDGE_COUNT * 2).fill(-1);
for (let slot = 0; slot < SLOTS; slot++) {
  const r = (slot / (N - 1)) | 0;
  const c = slot % (N - 1);
  const edges = [
    [r * N + c, r * N + c + 1], // H
    [V_EDGES + r * (N - 1) + c, V_EDGES + (r + 1) * (N - 1) + c], // V
  ];
  for (let o = 0; o < 2; o++) {
    const w = slot * 2 + o;
    [WALL_E1[w], WALL_E2[w]] = edges[o];
    for (const e of edges[o]) EDGE_WALLS[e * 2 + (EDGE_WALLS[e * 2] < 0 ? 0 : 1)] = w;
  }
}
const wallOf = (w: number): Wall => ({ r: ((w >> 1) / (N - 1)) | 0, c: (w >> 1) % (N - 1), o: w & 1 ? 'V' : 'H' });

interface QBoard {
  np: number;
  pawn: Int16Array; // pid → cell
  goal: Uint8Array; // pid → index into GOALS
  left: Int8Array; // pid → walls in hand
  blocked: Uint8Array; // edge → 1 when walled
  slot: Uint8Array; // slot → 0 free, 1 horizontal, 2 vertical
  hash: number; // Zobrist over pawns, walls and supplies; the side to move is added on lookup
}

function boardOf(s: { np: number; pawns: Cell[]; goals: Goal[]; wallsLeft: number[]; walls: Wall[] }): QBoard {
  const b: QBoard = {
    np: s.np,
    pawn: Int16Array.from(s.pawns, ([r, c]) => r * N + c),
    goal: Uint8Array.from(s.goals, (g) => GOALS.indexOf(g)),
    left: Int8Array.from(s.wallsLeft),
    blocked: blockedEdges(s.walls),
    slot: new Uint8Array(SLOTS),
    hash: 0,
  };
  for (const w of s.walls) b.slot[w.r * (N - 1) + w.c] = w.o === 'H' ? 1 : 2;
  for (const w of s.walls) b.hash ^= ZOB_WALL[(w.r * (N - 1) + w.c) * 2 + (w.o === 'H' ? 0 : 1)];
  for (let pid = 0; pid < b.np; pid++) {
    b.hash ^= ZOB_PAWN[pid * CELLS + b.pawn[pid]] ^ ZOB_LEFT[pid * 32 + b.left[pid]] ^ ZOB_GOAL[pid * 4 + b.goal[pid]];
  }
  b.hash >>>= 0;
  return b;
}

function occupied(b: QBoard, cell: number): boolean {
  for (let pid = 0; pid < b.np; pid++) if (b.pawn[pid] === cell) return true;
  return false;
}
/** Free of every wall it would overlap or cross. (Overlapping a wall in line means
 *  sharing an edge with it, so the edge check is the overlap rule.) */
const wallFits = (b: QBoard, w: number) => !b.slot[w >> 1] && !b.blocked[WALL_E1[w]] && !b.blocked[WALL_E2[w]];

function putWall(b: QBoard, pid: number, w: number) {
  b.slot[w >> 1] = (w & 1) + 1;
  b.blocked[WALL_E1[w]] = 1;
  b.blocked[WALL_E2[w]] = 1;
  b.hash = (b.hash ^ ZOB_WALL[w] ^ ZOB_LEFT[pid * 32 + b.left[pid]] ^ ZOB_LEFT[pid * 32 + b.left[pid] - 1]) >>> 0;
  b.left[pid] -= 1;
}
function takeWall(b: QBoard, pid: number, w: number) {
  b.slot[w >> 1] = 0;
  b.blocked[WALL_E1[w]] = 0;
  b.blocked[WALL_E2[w]] = 0;
  b.hash = (b.hash ^ ZOB_WALL[w] ^ ZOB_LEFT[pid * 32 + b.left[pid]] ^ ZOB_LEFT[pid * 32 + b.left[pid] + 1]) >>> 0;
  b.left[pid] += 1;
}
function stepPawn(b: QBoard, pid: number, to: number) {
  b.hash = (b.hash ^ ZOB_PAWN[pid * CELLS + b.pawn[pid]] ^ ZOB_PAWN[pid * CELLS + to]) >>> 0;
  b.pawn[pid] = to;
}

/** Every cell's walk to goal `g`, pawns ignored; -1 where there is none. */
function goalMap(b: QBoard, g: number, out: Int8Array, queue: Int16Array) {
  out.fill(-1);
  let tail = 0;
  for (const cell of GOAL_CELLS[g]) {
    out[cell] = 0;
    queue[tail++] = cell;
  }
  for (let head = 0; head < tail; head++) {
    const cell = queue[head];
    const d = out[cell] + 1;
    for (let k = cell * 4, end = k + 4; k < end; k++) {
      const n = NB_CELL[k];
      if (n < 0 || out[n] >= 0 || b.blocked[NB_EDGE[k]]) continue;
      out[n] = d;
      queue[tail++] = n;
    }
  }
}

/** One player's walk home, stopping the moment it is known; -1 if they are walled off. */
function walk(b: QBoard, pid: number, seen: Int8Array, queue: Int16Array): number {
  const start = b.pawn[pid];
  const g = b.goal[pid] * CELLS;
  if (IS_GOAL[g + start]) return 0;
  seen.fill(-1);
  seen[start] = 0;
  let tail = 0;
  queue[tail++] = start;
  for (let head = 0; head < tail; head++) {
    const cell = queue[head];
    const d = seen[cell] + 1;
    for (let k = cell * 4, end = k + 4; k < end; k++) {
      const n = NB_CELL[k];
      if (n < 0 || seen[n] >= 0 || b.blocked[NB_EDGE[k]]) continue;
      if (IS_GOAL[g + n]) return d;
      seen[n] = d;
      queue[tail++] = n;
    }
  }
  return -1;
}

/** Legal pawn steps, jumps included — the same rules as `legalMoves`. */
function pawnSteps(b: QBoard, pid: number, out: Int16Array): number {
  const from = b.pawn[pid];
  let n = 0;
  const push = (cell: number) => {
    for (let i = 0; i < n; i++) if (out[i] === cell) return;
    out[n++] = cell;
  };
  for (let d = 0; d < 4; d++) {
    const k = from * 4 + d;
    const next = NB_CELL[k];
    if (next < 0 || b.blocked[NB_EDGE[k]]) continue;
    if (!occupied(b, next)) {
      push(next);
      continue;
    }
    const k2 = next * 4 + d;
    const beyond = NB_CELL[k2];
    if (beyond >= 0 && !b.blocked[NB_EDGE[k2]] && !occupied(b, beyond)) {
      push(beyond);
      continue;
    }
    // Straight on is blocked: either side of the pawn being jumped. Directions come in
    // pairs (up/down, right/left), so the perpendicular pair is the other one.
    for (const side of d < 2 ? [2, 3] : [0, 1]) {
      const k3 = next * 4 + side;
      const diag = NB_CELL[k3];
      if (diag >= 0 && !b.blocked[NB_EDGE[k3]] && !occupied(b, diag)) push(diag);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** How far ahead `me` is, counted in steps of the race — and crucially, WHO IS TO MOVE.
 *
 *  Once the walls are gone the game is a pure race, and its result is exact: each player
 *  gets home on the turn their walk runs out, and turns go round in order. So the player
 *  `k` seats after the one to move, `d` steps from home, arrives at time d·np + k; the
 *  lowest time wins. The difference between our arrival and the first rival's, in rounds,
 *  is the race. With two players that is the old "their walk minus ours, plus half a step
 *  to whoever holds the move" exactly — the position suite pins it — and with three or
 *  four it puts each rival's half-step in the right place, which the old two-player rule
 *  applied to everyone at once did not.
 *
 *  TRIED AND REJECTED — a corridor term (see eval.test.ts): scoring how easily one wall
 *  could cut a route worked on test positions and lost games, 37% at an equal node count. */
function raceValue(b: QBoard, me: number, toMove: number, dist: Int16Array): number {
  const np = b.np;
  const mine = dist[me];
  const myTime = mine * np + ((me - toMove + np) % np);
  let first = Infinity;
  let nearest = Infinity;
  // Every rival's walls count against us, not just the best-stocked rival's. Counting only
  // the most, a rival with fewer could spend walls on us for free — so the search expected
  // to be walled the moment it pulled ahead, stepped back rather than lead, and three bots
  // doing that at once never finished the game (92 of 400 four-player matches; 47 with
  // this change). With two players the two readings are the same.
  let rivalWalls = 0;
  for (let pid = 0; pid < np; pid++) {
    if (pid === me) continue;
    first = Math.min(first, dist[pid] * np + ((pid - toMove + np) % np));
    nearest = Math.min(nearest, dist[pid]);
    rivalWalls += b.left[pid];
  }
  // A wall in hand is worth what it can still cost the other side, so each side's walls
  // fade as the walk they would lengthen runs out: ours with the leading rival's, theirs
  // with ours. The first version faded both with one shared factor — the shorter walk, and
  // later the rival's — and that shared factor had a perverse edge: whenever the rivals
  // held more walls between them, slowing the leader INCREASED what their walls read as
  // worth, so walling a rival about to win scored as a loss. Separate fades fixed that at
  // no cost in 2-player play (52%, 400 games).
  const mineCount = Math.min(1, nearest / ROOM_STEPS);
  const theirsCount = Math.min(1, mine / ROOM_STEPS);
  return ((first - myTime) / np) * STEP + (b.left[me] * mineCount - rivalWalls * theirsCount) * WALL_WORTH;
}

/** The evaluation, on a real game state — exposed so the position suite can pin it down. */
export function evaluatePosition(s: QState, me: number, toMove: number): number {
  const b = boardOf(s);
  const seen = new Int8Array(CELLS);
  const queue = new Int16Array(CELLS);
  const dist = Int16Array.from({ length: b.np }, (_, pid) => walk(b, pid, seen, queue));
  if (dist[me] === 0) return WIN;
  for (let pid = 0; pid < b.np; pid++) if (pid !== me && dist[pid] === 0) return -WIN;
  return raceValue(b, me, toMove, dist);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface TTEntry {
  depth: number;
  value: number;
  flag: 0 | 1 | 2; // exact, lower bound, upper bound
  best: number; // the turn that was best (or refuted), tried first next time
}

/** A search in progress: the board it plays on, what it may spend, and its scratch. */
interface QEngine {
  b: QBoard;
  me: number;
  budget: number;
  nodes: number;
  aborted: boolean;
  wallCap: number;
  tt: Map<number, TTEntry>;
  ply: {
    map: Int8Array; // the mover's walk from every cell
    target: Int8Array; // the victim's walk from every cell, for choosing walls
    dist: Int16Array; // every player's walk after each child turn
    turns: Int32Array;
    steps: Int16Array;
  }[];
  seen: Int8Array;
  queue: Int16Array;
  mark: Uint32Array; // wall → stamp, to list each candidate once
  stamp: number;
}

const MAX_PLY = 40;
const MAX_TURNS = 8 + 2 * 128;

function engineFor(b: QBoard, me: number, plan: QPlan): QEngine {
  return {
    b, me, budget: plan.budget, nodes: 0, aborted: false, wallCap: plan.wallCap, tt: new Map(),
    ply: Array.from({ length: MAX_PLY }, () => ({
      map: new Int8Array(CELLS), target: new Int8Array(CELLS), dist: new Int16Array(b.np),
      turns: new Int32Array(MAX_TURNS), steps: new Int16Array(8),
    })),
    seen: new Int8Array(CELLS), queue: new Int16Array(CELLS), mark: new Uint32Array(SLOTS * 2), stamp: 0,
  };
}

/** Who a wall from `pid` is aimed at: whoever, apart from them, is nearest to winning.
 *  That goes for the rivals as well as the bot. Assuming every rival walls the bot
 *  whatever the board says is the textbook pessimism, and in a race it backfires: out in
 *  front, the bot expects all three to turn on it, so it would rather not be in front.
 *  Modelled as they actually play — on the leader — stalled matches fell again (47 → 34
 *  of 400), and a player of the old bot's strength won less against three of it. */
function victim(e: QEngine, pid: number, toMove: number, dist: Int16Array): number {
  const np = e.b.np;
  let who = -1;
  let soonest = Infinity;
  for (let q = 0; q < np; q++) {
    if (q === pid) continue;
    const t = dist[q] * np + ((q - toMove + np) % np);
    if (t < soonest) {
      soonest = t;
      who = q;
    }
  }
  return who;
}

/** Walls worth trying against `target`: those across their shortest route, nearest their
 *  pawn first — a wall anywhere else cannot lengthen their walk at all. */
function candidateWallsFor(e: QEngine, target: number, map: Int8Array, out: Int32Array, n: number, move: number): number {
  const b = e.b;
  let cur = b.pawn[target];
  if (map[cur] < 0) return n;
  const stamp = ++e.stamp;
  let found = 0;
  while (map[cur] > 0 && found < e.wallCap) {
    let next = -1;
    let edge = -1;
    for (let k = cur * 4, end = k + 4; k < end; k++) {
      const c = NB_CELL[k];
      if (c >= 0 && !b.blocked[NB_EDGE[k]] && map[c] === map[cur] - 1) {
        next = c;
        edge = NB_EDGE[k];
        break;
      }
    }
    if (next < 0) break;
    for (let j = 0; j < 2 && found < e.wallCap; j++) {
      const w = EDGE_WALLS[edge * 2 + j];
      if (w < 0 || e.mark[w] === stamp || !wallFits(b, w)) continue;
      e.mark[w] = stamp;
      out[n++] = (move << 8) | w;
      found++;
    }
    cur = next;
  }
  return n;
}

/** Every turn worth searching for `pid`, best-looking first — alpha-beta lives or dies on
 *  this ordering. Steps come first (by the ground they gain), then walls played on top of
 *  the best step. A wall on its own is only offered when no step makes ground: stepping
 *  and then walling is otherwise the same wall with a free step thrown in. */
function genTurns(e: QEngine, pid: number, toMove: number, ply: number, dist: Int16Array): number {
  const b = e.b;
  const P = e.ply[ply];
  goalMap(b, b.goal[pid], P.map, e.queue);
  const ns = pawnSteps(b, pid, P.steps);
  const steps = P.steps;
  for (let i = 1; i < ns; i++) {
    const s = steps[i];
    let j = i - 1;
    while (j >= 0 && P.map[steps[j]] > P.map[s]) {
      steps[j + 1] = steps[j];
      j--;
    }
    steps[j + 1] = s;
  }
  let n = 0;
  for (let i = 0; i < ns; i++) P.turns[n++] = (steps[i] << 8) | NOWALL;
  if (b.left[pid] > 0) {
    const target = victim(e, pid, toMove, dist);
    goalMap(b, b.goal[target], P.target, e.queue);
    if (ns) n = candidateWallsFor(e, target, P.target, P.turns, n, steps[0]);
    if (!ns || P.map[steps[0]] >= P.map[b.pawn[pid]]) n = candidateWallsFor(e, target, P.target, P.turns, n, NOMOVE);
  }
  return n;
}

/** Play turn `t` for `pid` (whose pawn stands on `from`) and work out everyone's walk
 *  afterwards into `after`. A wall that would leave anyone with no way home is illegal:
 *  the turn is taken back and `false` returned. Checking here rather than when listing
 *  walls costs nothing extra — these walks are needed for the evaluation anyway. */
function playTurn(e: QEngine, pid: number, t: number, from: number, map: Int8Array, before: Int16Array, after: Int16Array): boolean {
  const b = e.b;
  const move = t >> 8;
  const wall = t & 255;
  if (move !== NOMOVE) stepPawn(b, pid, move);
  if (wall === NOWALL) {
    after.set(before);
    // Walls are unchanged, so the mover's new walk is read straight off their map.
    if (move !== NOMOVE) after[pid] = map[move];
    return true;
  }
  putWall(b, pid, wall);
  for (let q = 0; q < b.np; q++) {
    after[q] = walk(b, q, e.seen, e.queue);
    if (after[q] < 0) {
      undoTurn(e, pid, t, from);
      return false;
    }
  }
  return true;
}

function undoTurn(e: QEngine, pid: number, t: number, from: number) {
  if ((t & 255) !== NOWALL) takeWall(e.b, pid, t & 255);
  if (t >> 8 !== NOMOVE) stepPawn(e.b, pid, from);
}

/** Alpha-beta over whole turns, in turn order, everyone else playing against the bot. The
 *  budget is counted in positions, never milliseconds, so play cannot depend on load.
 *  Anything computed after the budget runs out is thrown away rather than filed in the
 *  table: it is a guess wearing a depth it never searched. */
function search(e: QEngine, depth: number, alpha: number, beta: number, toMove: number, ply: number, dist: Int16Array): number {
  if (++e.nodes > e.budget) {
    e.aborted = true;
    return 0;
  }
  const b = e.b;
  if (depth === 0 || ply >= MAX_PLY - 1) return raceValue(b, e.me, toMove, dist);
  const key = (b.hash ^ ZOB_SIDE[toMove]) >>> 0;
  const hit = e.tt.get(key);
  const alpha0 = alpha;
  const beta0 = beta;
  if (hit && hit.depth >= depth) {
    if (hit.flag === 0) return hit.value;
    if (hit.flag === 1 && hit.value > alpha) alpha = hit.value;
    else if (hit.flag === 2 && hit.value < beta) beta = hit.value;
    if (alpha >= beta) return hit.value;
  }

  const P = e.ply[ply];
  const n = genTurns(e, toMove, toMove, ply, dist);
  if (hit) {
    // The table's best turn from last time goes first; most of the time it still is.
    for (let i = 1; i < n; i++) {
      if (P.turns[i] === hit.best) {
        P.turns[i] = P.turns[0];
        P.turns[0] = hit.best;
        break;
      }
    }
  }
  const maximising = toMove === e.me;
  const next = (toMove + 1) % b.np;
  const from = b.pawn[toMove];
  const home = b.goal[toMove] * CELLS;
  let best = maximising ? -Infinity : Infinity;
  let bestTurn = -1;
  for (let i = 0; i < n; i++) {
    const t = P.turns[i];
    if (!playTurn(e, toMove, t, from, P.map, dist, P.dist)) continue;
    const move = t >> 8;
    const v = move !== NOMOVE && IS_GOAL[home + move]
      ? (maximising ? WIN - ply : ply - WIN) // a win sooner beats a win later
      : search(e, depth - 1, alpha, beta, next, ply + 1, P.dist);
    undoTurn(e, toMove, t, from);
    if (e.aborted) return 0;
    if (maximising ? v > best : v < best) {
      best = v;
      bestTurn = t;
    }
    if (maximising) {
      if (best > alpha) alpha = best;
    } else if (best < beta) beta = best;
    if (alpha >= beta) break; // already refuted
  }
  if (bestTurn < 0) return raceValue(b, e.me, toMove, dist); // boxed in with no wall to play
  e.tt.set(key, { depth, value: best, flag: best <= alpha0 ? 2 : best >= beta0 ? 1 : 0, best: bestTurn });
  return best;
}

/** How a skill level thinks. */
export interface QPlan {
  budget: number; // positions per decision — a count, never a clock
  maxDepth: number; // whole turns of lookahead at most, counting its own
  wallCap: number; // walls tried per turn, nearest the victim's pawn first
}

/** The turn `pid` should play, by iterative deepening: one whole turn deeper at a time,
 *  keeping the last depth that finished — or the part of an unfinished one that began
 *  with the previous best, which is the one comparison that is still fair. Any turn
 *  within `spread` of the best is taken at random among them. */
function chooseTurn(s: QState, pid: number, rng: Rng, plan: QPlan, spread: number, hurry = false): number | null {
  const b = boardOf(s);
  const e = engineFor(b, pid, plan);
  const dist = Int16Array.from({ length: b.np }, (_, q) => walk(b, q, e.seen, e.queue));
  const P = e.ply[0];
  let n: number;
  if (s.turnStage === 'moved') {
    // The step is taken; what is left is whether a wall is worth one of ours.
    goalMap(b, b.goal[pid], P.map, e.queue);
    P.turns[0] = (NOMOVE << 8) | NOWALL;
    const target = victim(e, pid, pid, dist);
    goalMap(b, b.goal[target], P.target, e.queue);
    n = candidateWallsFor(e, target, P.target, P.turns, 1, NOMOVE);
  } else n = genTurns(e, pid, pid, 0, dist);

  const from = b.pawn[pid];
  const home = b.goal[pid] * CELLS;
  const next = (pid + 1) % b.np;
  // Ground made breaks exact ties: there is no repetition rule in this game, and a bot
  // with nothing to separate two squares would otherwise step between them forever.
  const progress = (t: number) => -P.map[t >> 8 === NOMOVE ? from : t >> 8] * 0.001;
  // Only legal turns go forward: a wall may never leave anyone without a way home.
  const legal = (turns: Int32Array) => {
    const out: { t: number; v: number }[] = [];
    for (const t of turns) {
      if (!playTurn(e, pid, t, from, P.map, dist, P.dist)) continue;
      undoTurn(e, pid, t, from);
      out.push({ t, v: 0 });
    }
    return out;
  };
  let ranked = legal(P.turns.subarray(0, n));
  if (!ranked.length && s.turnStage === 'start' && b.left[pid] > 0) {
    // Boxed in by other pawns, and no wall across a rival's route will fit. The rules
    // still allow any legal wall, and something has to be played — so consider them all.
    let m = 0;
    for (let w = 0; w < SLOTS * 2; w++) if (wallFits(b, w)) P.turns[m++] = (NOMOVE << 8) | w;
    ranked = legal(P.turns.subarray(0, m));
  }
  if (!ranked.length) return null;
  if (hurry) {
    // Far past any normal match: only steps that shorten our walk (with or without a
    // wall on top), unless there are none. See LONG_MATCH.
    const onward = ranked.filter((r) => r.t >> 8 !== NOMOVE && P.map[r.t >> 8] < P.map[from]);
    if (onward.length) ranked = onward;
  }
  let settled: { t: number; v: number }[] | null = null;
  for (let depth = 1; depth <= Math.min(plan.maxDepth, MAX_PLY - 2); depth++) {
    const done: { t: number; v: number }[] = [];
    let best = -Infinity;
    for (const r of ranked) {
      playTurn(e, pid, r.t, from, P.map, dist, P.dist);
      const move = r.t >> 8;
      const v = move !== NOMOVE && IS_GOAL[home + move] ? WIN : search(e, depth - 1, best - spread, Infinity, next, 1, P.dist);
      undoTurn(e, pid, r.t, from);
      if (e.aborted) break;
      done.push({ t: r.t, v: v + progress(r.t) });
      if (v > best) best = v;
    }
    if (done.length) {
      // An unfinished depth still settles every turn it reached, and it reached the old
      // favourite first; the ones it never got to were already behind.
      const rest = ranked.filter((r) => !done.some((d) => d.t === r.t)).map((r) => ({ t: r.t, v: -Infinity }));
      ranked = [...done.sort((x, y) => y.v - x.v), ...rest];
    }
    if (!e.aborted && depth % b.np === 0) settled = ranked; // a complete round
    if (e.aborted || ranked[0].v >= WIN - MAX_PLY) break; // out of budget, or a forced win found
  }
  // Improvising (the opening, or a lower level) means choosing among near-equals, and that
  // is only fair among turns compared at one depth — the deepest COMPLETE ROUND finished,
  // where everyone has answered. An unfinished depth that only reached the favourite would
  // quietly narrow the choice to it; a depth that ends on the bot's own move hands it a
  // turn nobody answers, which made the step forward look two and a half steps better than
  // a sidestep instead of one. Playing it straight, the unfinished depth is the better
  // guide: it is what catches a favourite that has just been refuted.
  const pool = spread > STEP / 2 && settled ? settled : ranked;
  const top = pool[0].v;
  const band = pool.filter((r) => r === pool[0] || r.v > top - spread);
  return band[Math.floor(rng() * band.length)].t;
}

const OPENING_TURNS = 6; // three turns each, while a lost tempo is still recoverable
// There is no repetition rule in Quoridor, and bots that each prefer to let someone else
// lead can wait on one another indefinitely — 34 of 400 four-player matches did, even
// after the fixes above. A match this long (a normal one is 15–30 turns each) is stuck,
// so from here a bot's pawn only moves forward. Walls are finite, so every walk then
// runs out and the match ends.
const LONG_MATCH = 40; // turns each
// Steady judges the turn it is about to play and nothing past it — one move of thought.
// That is still enough to beat the old Sharp bot 74% of the time, because it values walls
// properly; Sharp beats it 89% of the time in 2-player games.
export const STEADY_PLAN: QPlan = { budget: 400, maxDepth: 1, wallCap: 3 };
// Sharp searches as deep as 20,000 positions allow: about 13ms a decision with two players
// and 18ms with four on a laptop, and its slowest are quicker than the old bot's were.
// With four players, capping it at one round played level against copies of itself but
// beat three old bots less often (85% against 91%) — the extra depth is what punishes
// weaker play, and weaker play is what it will meet.
export const SHARP_PLAN: QPlan = { budget: 20000, maxDepth: 20, wallCap: 18 };
// Master searches five times as far and plays its best move from the first turn — no
// tempo spent on variety (see `spread`). About 70ms a decision. Against Sharp it wins
// 82.5% of 2-player games (240, seats rotated). With four players it does not: one Master
// among three Sharps won its fair quarter and no more (80 games), with or without the
// varied opening. There, whoever leads is walled by everyone else, and that decides more
// than how far ahead anyone looks.
export const MASTER_PLAN: QPlan = { budget: 100000, maxDepth: 20, wallCap: 18 };
// Grandmaster searches four times as far again, about 230ms a decision. The return on depth
// is flattening: it beats Master in 59% of 2-player games (120, ±4.5).
export const GRANDMASTER_PLAN: QPlan = { budget: 400000, maxDepth: 24, wallCap: 18 };

const planFor = (skill: number): QPlan =>
  skill <= STEADY ? STEADY_PLAN : skill <= SHARP ? SHARP_PLAN : skill <= MASTER ? MASTER_PLAN : GRANDMASTER_PLAN;

function botMove(s: QState, seat: number, rng: Rng, plan?: QPlan): Record<string, unknown> | null {
  if (s.over) return null;
  const pid = s.order.indexOf(seat);
  if (pid !== s.turn) return null;
  // How near to the best a move has to be before this bot will consider it just as good,
  // and pick between them at random. The search is deterministic, so without something
  // here every match is the identical game and a human who beat it once could replay the
  // line forever.
  //
  // It is scaled to STEP and set by skill, because variety is not free: from the starting
  // square only one move makes ground, and it is a full step better than sidestepping.
  //
  // Sharp widens its band for the OPENING only. The search assumes the opposition answers
  // perfectly, which is what makes that step look decisive — against a person it is not,
  // and a game that always begins the same way is worth less than the tempo it costs, with
  // a whole match left to recover in. Past the opening it tightens again, because a
  // middlegame given away does not get recovered.
  //
  // Master and Grandmaster never widen it. Someone who picks them has asked for the
  // strongest game going, and the tempo is part of that.
  const opening = s.turnsPlayed < OPENING_TURNS;
  const spread = s.skill <= CASUAL
    ? STEP * 1.2
    : s.skill <= STEADY
      ? STEP * 0.55
      : opening && s.skill <= SHARP ? STEP * 1.05 : STEP * 0.06;

  // Casual never walls at all — it just races, which is exactly the beginner's mistake.
  // Walking the shortest path is a UNIQUE move most of the time, so judging steps on the
  // same scale as everything else lets the wide Casual band take a sidestep now and then:
  // varied, a little careless, and about right for the level.
  if (s.skill <= CASUAL && !plan) {
    if (s.turnStage === 'moved') return { type: 'endTurn' };
    const b = boardOf(s);
    const map = new Int8Array(CELLS);
    goalMap(b, b.goal[pid], map, new Int16Array(CELLS));
    const steps = new Int16Array(8);
    const n = pawnSteps(b, pid, steps);
    if (!n) {
      // Boxed in by other pawns: even a beginner has to play a wall rather than stall.
      const walls = legalWalls(s);
      if (!walls.length) return null;
      const w = walls[Math.floor(rng() * walls.length)];
      return { type: 'placeWall', slot: [w.r, w.c], orientation: w.o };
    }
    const scored = Array.from(steps.subarray(0, n), (cell) => ({ cell, value: -map[cell] * STEP }));
    const top = Math.max(...scored.map((x) => x.value));
    const band = scored.filter((x) => x.value >= top - spread);
    const cell = band[Math.floor(rng() * band.length)].cell;
    return { type: 'movePawn', toCell: [(cell / N) | 0, cell % N] };
  }

  const hurry = s.turnsPlayed >= LONG_MATCH * s.np;
  const t = chooseTurn(s, pid, rng, plan ?? planFor(s.skill), spread, hurry);
  if (t === null) return s.turnStage === 'moved' ? { type: 'endTurn' } : null;
  const move = t >> 8;
  const wall = t & 255;
  if (move !== NOMOVE) return { type: 'movePawn', toCell: [(move / N) | 0, move % N] };
  if (wall !== NOWALL) {
    const w = wallOf(wall);
    return { type: 'placeWall', slot: [w.r, w.c], orientation: w.o };
  }
  return { type: 'endTurn' };
}

/** The bot at a chosen plan, for measuring one against another. */
export function botWith(s: QState, seat: number, rng: Rng, plan: QPlan): Record<string, unknown> | null {
  return botMove(s, seat, rng, plan);
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
  options: [GRANDMASTER_SKILL_OPTION, TIMER_OPTION],

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
      turnsPlayed: 0,
      winner: null,
      over: false,
      timer: initTimer(setup.options?.timer),
      skill: initSkill(setup.options?.skill, GRANDMASTER),
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
