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

import type { GameContext, GameDef, GameOutcome, PlayerInfo } from '../../platform/types.ts';
import { initTimer, runTimer, timerView, TIMER_OPTION, type Timer } from '../../platform/turn-timer.ts';

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
// Bot — walk the shortest path toward the goal (move-only; never traps itself)
// ---------------------------------------------------------------------------

// --- turn timer: signature of the current turn, and the auto-move on timeout ---
const qTurnKey = (s: QState): string => (s.over ? '' : `${s.turn}:${s.turnStage}`);
function qForceTimeout(s: QState) {
  const pid = s.turn;
  const mv = botMove(s, s.order[pid]);
  if (!mv) return;
  if (mv.type === 'movePawn') movePawn(s, pid, mv.toCell);
  else if (mv.type === 'endTurn') endTurn(s, pid);
}

function botMove(s: QState, seat: number): Record<string, unknown> | null {
  if (s.over) return null;
  const pid = s.order.indexOf(seat);
  if (pid !== s.turn) return null;
  if (s.turnStage === 'moved') return { type: 'endTurn' }; // simple bot moves but doesn't wall
  const bs = blockedEdges(s.walls);
  const dist = distToGoal(bs, s.goals[pid]);
  const moves = legalMoves(s);
  if (!moves.length) return null; // no-trap guarantees this won't happen
  let best = moves[0];
  let bestD = Infinity;
  for (const [r, c] of moves) {
    const d = dist[r][c];
    if (d < bestD) ((bestD = d), (best = [r, c]));
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
  options: [TIMER_OPTION],

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
    return runTimer(s.timer, () => qTurnKey(s), ctx.now, () => qForceTimeout(s));
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

  bot(s, seat) {
    return botMove(s, seat);
  },
};
