// games/tectonic/game.ts — "Tectonic Shift", a hex territory-isolation game (2–4 players).
//
// Perfect information, no randomness — like Quoridor, `view` redacts nothing. The weight
// is on slide legality, the origin-only scoring rule, alive/dead detection, and the end
// condition (plus an optional early-termination once the winner is mathematically fixed).
//
// Hex coordinates: axial (q, r), cube s = -q-r. A board of radius R holds every hex with
// max(|q|,|r|,|s|) ≤ R. The 6 slide directions (index 0..5):
//   0:(+1,0) 1:(+1,-1) 2:(0,-1) 3:(-1,0) 4:(-1,+1) 5:(0,+1)
// You slide a pawn ≥1 hex in one direction, blocked by the first gap/pawn/edge; only the
// hex you LEAVE is removed (becomes a gap) and its value banked to you.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { initSkill, GRANDMASTER_SKILL_OPTION, CASUAL, STEADY, SHARP, MASTER, GRANDMASTER } from '../../platform/skill.ts';

export const DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const DEFAULT_PAWNS: Record<number, number> = { 2: 5, 3: 4, 4: 4 };

export interface TectonicConfig {
  radius?: number;
  holeRadius?: number; // central hexes within this distance are absent (a void), like the show's board
  value?: (dist: number) => number; // value of a hex by its ring distance (default rises toward the centre)
  pawnsPer?: Record<number, number>;
}

const hexDist = (q: number, r: number) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
const id = (q: number, r: number) => `${q},${r}`;

interface Hex {
  value: number;
  state: 'present' | 'gap';
  pawn: number | null; // pawn id, or null
}
interface Pawn {
  id: number;
  owner: number; // player-index
  q: number;
  r: number;
  alive: boolean;
}
interface TPlayer {
  name: string;
  connected: boolean;
}

export interface TState {
  players: (TPlayer | null)[]; // by seat (length 8)
  order: number[]; // seat per player-index
  np: number;
  radius: number;
  hexes: Record<string, Hex>;
  pawns: Pawn[];
  scores: number[]; // by player-index
  turn: number; // player-index
  winner: number | null; // player-index, or null when shared
  winners: number[]; // seats on the winning side
  over: boolean;
  skill: number; // how hard the bots play (1 casual … 5 grandmaster)
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: TState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: TState, pid: number) => s.players[s.order[pid]]!.name;

// ---------------------------------------------------------------------------
// Geometry: board + ring
// ---------------------------------------------------------------------------

// Keep only 3 of the highest-value (5) tiles, spaced evenly around the centre; the rest
// become 1s. (The show's board has just three 5s, not a full inner ring of them.)
function reduceFives(hexes: Record<string, Hex>) {
  const keys = Object.keys(hexes).filter((k) => hexes[k].value === 5);
  if (keys.length <= 3) return;
  const angle = (key: string) => {
    const [q, r] = key.split(',').map(Number);
    return Math.atan2(Math.sqrt(3) * (r + q / 2), 1.5 * q);
  };
  keys.sort((a, b) => angle(a) - angle(b));
  const keep = new Set<number>();
  for (let i = 0; i < 3; i++) keep.add(Math.round((i * keys.length) / 3) % keys.length);
  keys.forEach((k, idx) => {
    if (!keep.has(idx)) hexes[k].value = 1;
  });
}

function ringCells(R: number): [number, number][] {
  if (R === 0) return [[0, 0]];
  const cells: [number, number][] = [];
  let q = DIRS[4][0] * R;
  let r = DIRS[4][1] * R;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < R; j++) {
      cells.push([q, r]);
      q += DIRS[i][0];
      r += DIRS[i][1];
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Slides (legality + enumeration)
// ---------------------------------------------------------------------------

interface Slide {
  pawnId: number;
  direction: number;
  distance: number;
  to: [number, number];
}

/** Legal slides for one pawn: one per direction, sliding ALL the way to the last hex
 *  before the first gap/pawn/edge (you cannot choose to stop short). */
function pawnSlides(s: TState, p: Pawn): Slide[] {
  const out: Slide[] = [];
  for (let dir = 0; dir < 6; dir++) {
    let q = p.q;
    let r = p.r;
    let dist = 0;
    for (;;) {
      const nq = q + DIRS[dir][0];
      const nr = r + DIRS[dir][1];
      const h = s.hexes[id(nq, nr)];
      if (!h || h.state !== 'present' || h.pawn !== null) break; // edge / gap / pawn
      q = nq;
      r = nr;
      dist++;
    }
    if (dist >= 1) out.push({ pawnId: p.id, direction: dir, distance: dist, to: [q, r] });
  }
  return out;
}

function legalMoves(s: TState): Slide[] {
  const out: Slide[] = [];
  for (const p of s.pawns) if (p.owner === s.turn && p.alive) out.push(...pawnSlides(s, p));
  return out;
}

export function recomputeAlive(s: TState) {
  for (const p of s.pawns) p.alive = pawnSlides(s, p).length > 0;
}

/** Winners: highest score; tiebreak by most alive pawns; still tied ⇒ shared. */
export function decideWinners(scores: number[], alive: number[]): number[] {
  const max = Math.max(...scores);
  let top = scores.map((_, i) => i).filter((i) => scores[i] === max);
  if (top.length > 1) {
    const maxAlive = Math.max(...top.map((i) => alive[i]));
    top = top.filter((i) => alive[i] === maxAlive);
  }
  return top;
}
const playerHasMove = (s: TState, pid: number) => s.pawns.some((p) => p.owner === pid && p.alive);

// ---------------------------------------------------------------------------
// End detection
// ---------------------------------------------------------------------------

/** Per-player bounds on the points still to be banked, computed per land-island
 *  (connected component of present hexes), accounting for the lost-final-hex rule:
 *   - ub[pid]: the MOST a player could still collect — sum of every island their alive
 *     pawns can reach, minus the cheapest hex per pawn (each pawn must abandon one).
 *   - lb[pid]: the least they are GUARANTEED to collect from islands they DOMINATE
 *     alone — the dearest hex one of their alive pawns is standing on, per such island.
 *     Nothing there can change until they move (no rival pawn can reach it), so that
 *     one bank is certain; anything past it is not. Contested islands credit nothing.
 *  So a player who dominates islands gets those points counted toward their guaranteed
 *  total, and the game can end as soon as a leader is mathematically out of reach. */
function islandBounds(s: TState): { ub: number[]; lb: number[] } {
  const comp: Record<string, number> = {};
  const compKeys: string[][] = [];
  let nc = 0;
  for (const key of Object.keys(s.hexes)) {
    if (s.hexes[key].state !== 'present' || comp[key] !== undefined) continue;
    const keys: string[] = [];
    const stack = [key];
    comp[key] = nc;
    while (stack.length) {
      const k = stack.pop()!;
      keys.push(k);
      const [q, r] = k.split(',').map(Number);
      for (const [dq, dr] of DIRS) {
        const nk = id(q + dq, r + dr);
        if (s.hexes[nk] && s.hexes[nk].state === 'present' && comp[nk] === undefined) {
          comp[nk] = nc;
          stack.push(nk);
        }
      }
    }
    compKeys[nc++] = keys;
  }

  const ub = new Array(s.np).fill(0);
  const lb = new Array(s.np).fill(0);
  for (let c = 0; c < nc; c++) {
    const values = compKeys[c].map((k) => s.hexes[k].value).sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const counts: Record<number, number> = {};
    const standing: Record<number, number> = {}; // dearest hex an owner's alive pawn stands on here
    for (const p of s.pawns) {
      if (!p.alive || comp[id(p.q, p.r)] !== c) continue;
      counts[p.owner] = (counts[p.owner] || 0) + 1;
      standing[p.owner] = Math.max(standing[p.owner] ?? 0, s.hexes[id(p.q, p.r)].value);
    }
    const owners = Object.keys(counts).map(Number);
    const cheapest = (k: number) => values.slice(0, k).reduce((a, b) => a + b, 0);
    for (const pid of owners) {
      ub[pid] += Math.max(0, sum - cheapest(counts[pid]));
      // An island this player dominates: nobody else can move here, so their pawn keeps
      // its slide until they play it and that one hex is banked for sure. Do NOT credit
      // the whole island minus its dearest hexes — a pawn slides all the way, so it can
      // strand itself with most of the island still on the board.
      if (owners.length === 1) lb[pid] += standing[pid];
    }
  }
  return { ub, lb };
}

function endGame(s: TState) {
  s.over = true;
  recomputeAlive(s);
  const aliveCount = new Array(s.np).fill(0);
  for (const p of s.pawns) if (p.alive) aliveCount[p.owner]++;
  const top = decideWinners(s.scores, aliveCount);
  s.winners = top.map((pid) => s.order[pid]);
  s.winner = top.length === 1 ? top[0] : null;
  const names = top.map((pid) => nameOf(s, pid)).join(', ');
  log(s, `Game over. ${top.length > 1 ? `Shared victory: ${names}` : `🏆 ${names} wins`} (${Math.max(...s.scores)} pts).`);
}

/** Early-end: if a player's guaranteed total (current score + points from islands they
 *  dominate) already beats every rival's best case, the ranking is fixed — stop. */
function tryEarlyEnd(s: TState): boolean {
  const { ub, lb } = islandBounds(s);
  const aliveCount = new Array(s.np).fill(0);
  for (const p of s.pawns) if (p.alive) aliveCount[p.owner]++;
  const leaders = decideWinners(s.scores, aliveCount);
  for (let L = 0; L < s.np; L++) {
    let unbeatable = true;
    for (let o = 0; o < s.np; o++) if (o !== L && s.scores[L] + lb[L] <= s.scores[o] + ub[o]) unbeatable = false;
    // Stop only once L is also in front on the board: the final ranking is read off the
    // scores as they stand, so ending while L still trails would hand the win to the very
    // player we just proved cannot win. If L leads on guaranteed points but not yet on
    // banked ones, play on — they will pull ahead, or the game ends naturally.
    if (unbeatable && leaders.length === 1 && leaders[0] === L) {
      endGame(s);
      return true;
    }
  }
  return false;
}

function advanceTurn(s: TState) {
  for (let i = 1; i <= s.np; i++) {
    const cand = (s.turn + i) % s.np;
    if (playerHasMove(s, cand)) {
      s.turn = cand;
      return;
    }
  }
  // no other player can move; the current player keeps the turn (they're the only mover)
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

function slide(s: TState, pid: number, pawnId: unknown, direction: unknown): ActionResult {
  if (pid !== s.turn) return fail('Not your turn.');
  const p = s.pawns.find((x) => x.id === Number(pawnId));
  if (!p || p.owner !== pid) return fail('That is not your pawn.');
  const dir = Number(direction);
  if (!Number.isInteger(dir) || dir < 0 || dir > 5) return fail('Bad direction.');

  // Slide ALL the way: travel to the last present, unoccupied hex before the first
  // gap / pawn / edge. You cannot stop short.
  let q = p.q;
  let r = p.r;
  let dist = 0;
  for (;;) {
    const nq = q + DIRS[dir][0];
    const nr = r + DIRS[dir][1];
    const h = s.hexes[id(nq, nr)];
    if (!h || h.state !== 'present' || h.pawn !== null) break;
    q = nq;
    r = nr;
    dist++;
  }
  if (dist < 1) return fail('No slide that way — blocked.');

  // Remove + bank ONLY the origin hex; move the pawn to the target.
  const origin = s.hexes[id(p.q, p.r)];
  s.scores[pid] += origin.value;
  log(s, `${nameOf(s, pid)} slides a pawn and banks ${origin.value} (now ${s.scores[pid]}).`);
  origin.state = 'gap';
  origin.pawn = null;
  p.q = q;
  p.r = r;
  s.hexes[id(q, r)].pawn = p.id;

  recomputeAlive(s);
  if (s.pawns.every((x) => !x.alive)) {
    endGame(s);
    return ok;
  }
  if (tryEarlyEnd(s)) return ok;
  advanceTurn(s);
  return ok;
}

// ---------------------------------------------------------------------------
// View (identical full public state for everyone)
// ---------------------------------------------------------------------------

function viewState(s: TState, seat: number | null): Record<string, unknown> {
  const myPid = seat !== null ? s.order.indexOf(seat) : -1;
  const aliveCount = new Array(s.np).fill(0);
  for (const p of s.pawns) if (p.alive) aliveCount[p.owner]++;

  const hexes = Object.keys(s.hexes).map((key) => {
    const [q, r] = key.split(',').map(Number);
    const h = s.hexes[key];
    const pawn = h.pawn !== null ? s.pawns.find((p) => p.id === h.pawn) : null;
    return { q, r, value: h.value, state: h.state, owner: pawn ? s.order[pawn.owner] : null };
  });
  const pawns = s.pawns.map((p) => ({ id: p.id, owner: s.order[p.owner], q: p.q, r: p.r, alive: p.alive }));
  const players = Array.from({ length: s.np }, (_, pid) => ({
    seat: s.order[pid],
    name: nameOf(s, pid),
    connected: s.players[s.order[pid]]!.connected,
    score: s.scores[pid],
    alivePawns: aliveCount[pid],
    isTurn: !s.over && pid === s.turn,
  }));

  return {
    game: 'tectonic',
    phase: s.over ? 'done' : 'play',
    over: s.over,
    radius: s.radius,
    hexes,
    pawns,
    players,
    turn: s.turn,
    activeSeat: s.over ? null : s.order[s.turn],
    legal: s.over ? [] : legalMoves(s),
    you: myPid >= 0 ? { seat, pid: myPid, isTurn: !s.over && myPid === s.turn } : { seat: seat ?? -1, spectator: true },
    winner: s.over ? s.winner : null,
    winners: s.over ? s.winners : null,
    log: s.log.slice(-15),
    matchWinner: null,
  };
}

// ---------------------------------------------------------------------------
// Bot engine — the board as flat arrays
// ---------------------------------------------------------------------------

/** The board as flat arrays, for thinking with. The rules keep hexes in a record keyed by
 *  "q,r" strings, which suits the view and the tests but costs a string build and a hash
 *  lookup for every step of every slide. Here a hex is a number, a neighbour is a table
 *  lookup, and a move is played and taken back by flipping a few array slots. */
interface Sim {
  np: number;
  nHex: number;
  nPawn: number;
  nb: Int16Array; // hex * 6 + direction → the neighbouring hex, or -1 past the edge
  value: Int16Array;
  present: Uint8Array;
  pawnAt: Int16Array; // hex → the pawn standing on it, or -1
  pos: Int16Array; // pawn → hex
  owner: Uint8Array; // pawn → player-index
  alive: Uint8Array;
  scores: Float64Array;
}

function toSim(s: TState): Sim {
  const keys = Object.keys(s.hexes);
  const index = new Map<string, number>();
  keys.forEach((k, i) => index.set(k, i));
  const nHex = keys.length;
  const nb = new Int16Array(nHex * 6).fill(-1);
  const value = new Int16Array(nHex);
  const present = new Uint8Array(nHex);
  const pawnAt = new Int16Array(nHex).fill(-1);
  keys.forEach((k, i) => {
    const [q, r] = k.split(',').map(Number);
    for (let d = 0; d < 6; d++) nb[i * 6 + d] = index.get(id(q + DIRS[d][0], r + DIRS[d][1])) ?? -1;
    value[i] = s.hexes[k].value;
    present[i] = s.hexes[k].state === 'present' ? 1 : 0;
  });
  const nPawn = s.pawns.length;
  const pos = new Int16Array(nPawn);
  const owner = new Uint8Array(nPawn);
  s.pawns.forEach((p, i) => {
    pos[i] = index.get(id(p.q, p.r))!;
    owner[i] = p.owner;
    pawnAt[pos[i]] = i;
  });
  const sim: Sim = {
    np: s.np, nHex, nPawn, nb, value, present, pawnAt, pos, owner,
    alive: new Uint8Array(nPawn), scores: Float64Array.from(s.scores),
  };
  refreshAlive(sim);
  return sim;
}

/** A pawn lives while it has an open neighbour to slide into. */
function canSlide(sim: Sim, pawn: number): number {
  const { nb, present, pawnAt } = sim;
  for (let k = sim.pos[pawn] * 6, end = k + 6; k < end; k++) {
    const n = nb[k];
    if (n >= 0 && present[n] && pawnAt[n] < 0) return 1;
  }
  return 0;
}

function refreshAlive(sim: Sim) {
  for (let p = 0; p < sim.nPawn; p++) sim.alive[p] = canSlide(sim, p);
}

/** After a slide, or taking one back, only two things can have changed who is alive: the
 *  pawn that moved, and the pawns beside the hex it landed on, which just gained or lost
 *  an open neighbour. The hex it left is no help to anyone either way — occupied before,
 *  a gap after. Checking those few rather than every pawn is most of the cost of a node. */
function touchUp(sim: Sim, pawn: number, landed: number) {
  const { nb, pawnAt, alive } = sim;
  alive[pawn] = canSlide(sim, pawn);
  for (let k = landed * 6, end = k + 6; k < end; k++) {
    const n = nb[k];
    if (n >= 0 && pawnAt[n] >= 0) alive[pawnAt[n]] = canSlide(sim, pawnAt[n]);
  }
}

/** Where a slide ends: the last open hex before the first gap, pawn or edge. */
function landing(sim: Sim, pawn: number, dir: number): number {
  const { nb, present, pawnAt } = sim;
  let h = sim.pos[pawn];
  for (;;) {
    const n = nb[h * 6 + dir];
    if (n < 0 || !present[n] || pawnAt[n] >= 0) return h;
    h = n;
  }
}

/** The slide rule on the flat board: bank the hex you leave, and it is gone. */
function play(sim: Sim, pawn: number, to: number) {
  const from = sim.pos[pawn];
  sim.scores[sim.owner[pawn]] += sim.value[from];
  sim.present[from] = 0;
  sim.pawnAt[from] = -1;
  sim.pawnAt[to] = pawn;
  sim.pos[pawn] = to;
  touchUp(sim, pawn, to);
}

function unplay(sim: Sim, pawn: number, from: number) {
  const to = sim.pos[pawn];
  sim.pawnAt[to] = -1;
  sim.pos[pawn] = from;
  sim.present[from] = 1;
  sim.pawnAt[from] = pawn;
  sim.scores[sim.owner[pawn]] -= sim.value[from];
  touchUp(sim, pawn, to);
}

function canMove(sim: Sim, pid: number): boolean {
  for (let p = 0; p < sim.nPawn; p++) if (sim.alive[p] && sim.owner[p] === pid) return true;
  return false;
}
function rivalsCanMove(sim: Sim, me: number): boolean {
  for (let p = 0; p < sim.nPawn; p++) if (sim.alive[p] && sim.owner[p] !== me) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** How much of each kind of ground a player can expect to turn into points. */
export interface Weights {
  stand: number; // the hex under a living pawn — banked the moment it moves
  sealed: number; // land only one player's pawns can still reach
  claim: number; // shared land that player gets to first
  pawn: number; // a living pawn, over and above where it stands
  focus: number; // 1 = measure yourself against the leading rival only, 0 = against their average
}

interface Engine {
  sim: Sim;
  me: number;
  w: Weights;
  budget: number;
  nodes: number;
  aborted: boolean;
  horizon: boolean; // did the last iteration stop anywhere short of the end of the game?
  moves: Int32Array[]; // per ply
  keys: Float64Array[]; // per ply, move-ordering scores
  history: Float64Array; // (hex * 6 + direction) → how often that slide refuted something
  dist: Int16Array;
  claim: Int8Array;
  comp: Int16Array;
  queue: Int16Array;
  mask: Int32Array; // component → which players' living pawns border it
  worth: Float64Array;
  tt: Map<number, TTEntry> | null; // positions already searched, when the plan keeps them
  zob: Zobrist | null;
  hash: number; // the board's key, kept up to date move by move — two halves, see keyOf
  check: number;
}

// --- Transposition table -------------------------------------------------------
// Slides by different pawns mostly commute: move A then B, or B then A, and the board is
// the same. Without a table the search solves every such board once per order it can be
// reached in. The table also remembers which slide was best at each board, and trying
// that one first on the next, deeper pass is what makes the cutoffs bite.

interface TTEntry {
  depth: number;
  value: number;
  flag: 0 | 1 | 2; // exact, lower bound, upper bound
  best: number; // (from hex * 6 + direction) of the best slide — by square, not by pawn,
  // because two of one player's pawns that have swapped places are the same position
  horizon: boolean; // did anything below this stop short of the end of the game?
}

/** Random keys for everything a position is made of. Who has banked what is part of it:
 *  two orders of play can reach the same board with the points split differently. */
interface Zobrist {
  gone: Uint32Array[]; // [half][hex] — the hex has been taken off the board
  pawn: Uint32Array[]; // [half][owner * nHex + hex]
  score: Uint32Array[]; // [half][owner * SCORE_CAP + score]
  mover: Uint32Array[]; // [half][player-index, or np for "any rival"]
}
const SCORE_CAP = 1024; // more points than any board holds

function zobristFor(sim: Sim): Zobrist {
  let x = 0x9e3779b9;
  const table = (n: number) => {
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      out[i] = x;
    }
    return out;
  };
  const both = (n: number) => [table(n), table(n)];
  return { gone: both(sim.nHex), pawn: both(sim.np * sim.nHex), score: both(sim.np * SCORE_CAP), mover: both(sim.np + 1) };
}

/** The key of the board as it stands, worked out from scratch (once, at the root). Two
 *  32-bit halves: one alone would collide a few times in a search this size. */
function keyOf(sim: Sim, z: Zobrist, half: number): number {
  let h = 0;
  for (let i = 0; i < sim.nHex; i++) if (!sim.present[i]) h ^= z.gone[half][i];
  for (let p = 0; p < sim.nPawn; p++) h ^= z.pawn[half][sim.owner[p] * sim.nHex + sim.pos[p]];
  for (let pid = 0; pid < sim.np; pid++) h ^= z.score[half][pid * SCORE_CAP + sim.scores[pid]];
  return h >>> 0;
}

/** What a slide from `from` to `to` does to one half of the key — the same change undoes it. */
function slideKey(sim: Sim, z: Zobrist, half: number, pawn: number, from: number, to: number): number {
  const o = sim.owner[pawn];
  const before = sim.scores[o];
  return (z.gone[half][from] ^ z.pawn[half][o * sim.nHex + from] ^ z.pawn[half][o * sim.nHex + to] ^
    z.score[half][o * SCORE_CAP + before] ^ z.score[half][o * SCORE_CAP + before + sim.value[from]]) >>> 0;
}

/** Play a slide in the search, keeping the key in step when there is a table. */
function enter(e: Engine, pawn: number, to: number) {
  if (e.zob) {
    const from = e.sim.pos[pawn];
    e.hash = (e.hash ^ slideKey(e.sim, e.zob, 0, pawn, from, to)) >>> 0;
    e.check = (e.check ^ slideKey(e.sim, e.zob, 1, pawn, from, to)) >>> 0;
  }
  play(e.sim, pawn, to);
}

function leave(e: Engine, pawn: number, from: number) {
  const to = e.sim.pos[pawn];
  unplay(e.sim, pawn, from);
  if (e.zob) {
    e.hash = (e.hash ^ slideKey(e.sim, e.zob, 0, pawn, from, to)) >>> 0;
    e.check = (e.check ^ slideKey(e.sim, e.zob, 1, pawn, from, to)) >>> 0;
  }
}

/** What the board is worth to `me`: banked points plus the land each side can expect to
 *  bank, less the rivals' same totals.
 *
 *  Land is read in two ways. Free land is split into islands: a pawn's own hex is never
 *  land for anyone else (it is a gap the moment it is left), so an island is a region of
 *  open hexes, and the players who own it are those with a living pawn on its shore. An
 *  island with one owner is SEALED — nobody else can ever touch it — and is counted at a
 *  high rate. Shared islands are settled by a race: every living pawn spreads out at the
 *  same speed, a hex goes to whoever reaches it first, and a dead heat goes to nobody. */
function evaluate(e: Engine): number {
  const { sim, w, dist, claim, comp, queue, mask, worth } = e;
  const { nb, present, pawnAt, value, pos, owner, alive, nPawn, nHex, np } = sim;
  for (let pid = 0; pid < np; pid++) worth[pid] = sim.scores[pid];
  dist.fill(-1);

  // Islands, and who borders each. This pass is a third of the evaluation's cost, and
  // it was tried without: at an equal number of positions searched, counting sealed and
  // shared land alike lost 4 points of win share in both 2- and 4-player games.
  comp.fill(-1);
  let nComp = 0;
  for (let p = 0; p < nPawn; p++) {
    if (!alive[p]) continue;
    const bit = 1 << owner[p];
    for (let k = pos[p] * 6, end = k + 6; k < end; k++) {
      const start = nb[k];
      if (start < 0 || !present[start] || pawnAt[start] >= 0) continue;
      if (comp[start] < 0) {
        const c = nComp++;
        mask[c] = 0;
        comp[start] = c;
        let tail = 0;
        queue[tail++] = start;
        for (let head = 0; head < tail; head++) {
          const h = queue[head];
          for (let j = h * 6, e2 = j + 6; j < e2; j++) {
            const n = nb[j];
            if (n >= 0 && present[n] && pawnAt[n] < 0 && comp[n] < 0) {
              comp[n] = c;
              queue[tail++] = n;
            }
          }
        }
      }
      mask[comp[start]] |= bit;
    }
  }

  // The race over shared ground.
  let tail = 0;
  for (let p = 0; p < nPawn; p++) {
    if (!alive[p]) continue;
    const h = pos[p];
    worth[owner[p]] += value[h] * w.stand + w.pawn;
    dist[h] = 0;
    claim[h] = owner[p];
    queue[tail++] = h;
  }
  for (let head = 0; head < tail; head++) {
    const h = queue[head];
    const d = dist[h] + 1;
    const c = claim[h];
    for (let k = h * 6, end = k + 6; k < end; k++) {
      const n = nb[k];
      if (n < 0 || !present[n] || pawnAt[n] >= 0) continue;
      if (dist[n] < 0) {
        dist[n] = d;
        claim[n] = c;
        queue[tail++] = n;
      } else if (dist[n] === d && claim[n] !== c) claim[n] = -1;
    }
  }

  for (let i = 0; i < tail; i++) {
    const h = queue[i];
    if (pawnAt[h] >= 0) continue; // a pawn's own hex, already counted
    const m = mask[comp[h]];
    if ((m & (m - 1)) === 0) worth[31 - Math.clz32(m)] += value[h] * w.sealed;
    else if (claim[h] >= 0) worth[claim[h]] += value[h] * w.claim;
  }

  // Only first place wins, which argues for measuring yourself against the leader alone.
  // In a 4-player game that turned out to be too narrow: a bot that only watches the
  // leader lets the other two walk off with land. Half leader, half field finished a
  // place higher on average (2.32 → 2.16 over 640 games) and won more.
  let lead = -Infinity;
  let sum = 0;
  for (let pid = 0; pid < np; pid++) {
    if (pid === e.me) continue;
    sum += worth[pid];
    if (worth[pid] > lead) lead = worth[pid];
  }
  return worth[e.me] - (w.focus * lead + (1 - w.focus) * (sum / (np - 1)));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Best-reply search. With three or four players, following the real turn order spends
// nearly the whole lookahead on other people's moves: four plies is one move of your own
// and three replies, and you never see your own follow-up. So the rivals are merged into
// one layer — after each of your moves, ONE of them answers, whichever answer hurts you
// most — and then it is your turn again. Two plies now reach your own next move. It is a
// deliberate fiction (the others do all get a turn), and it measured better than the
// honest version: 69% against 58% over 80 four-player games each, at the same budget,
// against the old bot. With two players it is ordinary alpha-beta.
const ANY = -1; // whichever rival hurts most moves next
const NONE = -2; // nobody can move — the game is over

/** Who moves after `mover`. Only ever names a side that has a move to make. */
function after(e: Engine, mover: number): number {
  const { sim, me } = e;
  const mine = canMove(sim, me);
  const theirs = rivalsCanMove(sim, me);
  if (mover === me) return theirs ? ANY : mine ? me : NONE;
  return mine ? me : theirs ? ANY : NONE;
}

function generate(e: Engine, mover: number, out: Int32Array): number {
  const { sim, me } = e;
  const { nb, present, pawnAt, pos, owner, alive } = sim;
  let n = 0;
  for (let p = 0; p < sim.nPawn; p++) {
    if (!alive[p]) continue;
    if (mover === ANY ? owner[p] === me : owner[p] !== me) continue;
    const base = pos[p] * 6;
    for (let d = 0; d < 6; d++) {
      const h = nb[base + d];
      if (h >= 0 && present[h] && pawnAt[h] < 0) out[n++] = p * 6 + d;
    }
  }
  return n;
}

/** Fattest hex first, then whatever has refuted things before: good ordering is most of
 *  what makes the cutoffs work. */
function order(e: Engine, moves: Int32Array, n: number, keys: Float64Array) {
  const { sim, history } = e;
  for (let i = 0; i < n; i++) {
    const pawn = (moves[i] / 6) | 0;
    const from = sim.pos[pawn];
    keys[i] = sim.value[from] * 1e6 + history[from * 6 + moves[i] - pawn * 6];
  }
  for (let i = 1; i < n; i++) {
    const mv = moves[i];
    const k = keys[i];
    let j = i - 1;
    while (j >= 0 && keys[j] < k) {
      moves[j + 1] = moves[j];
      keys[j + 1] = keys[j];
      j--;
    }
    moves[j + 1] = mv;
    keys[j + 1] = k;
  }
}

function search(e: Engine, depth: number, alpha: number, beta: number, mover: number, ply: number): number {
  if (++e.nodes > e.budget) {
    e.aborted = true;
    return 0;
  }
  if (mover === NONE) return evaluate(e);
  if (depth === 0) {
    e.horizon = true;
    return evaluate(e);
  }
  const sim = e.sim;
  let key = 0;
  let hit: TTEntry | undefined;
  if (e.tt) {
    // Both halves of the key, folded into one exact Map key (53 bits).
    const m = mover === ANY ? sim.np : mover;
    key = ((e.hash ^ e.zob!.mover[0][m]) >>> 0) * 2097152 + (((e.check ^ e.zob!.mover[1][m]) >>> 0) & 0x1fffff);
    hit = e.tt.get(key);
    // A subtree that played out to the end everywhere holds at any depth.
    if (hit && (hit.depth >= depth || !hit.horizon)) {
      if (hit.horizon) e.horizon = true;
      if (hit.flag === 0) return hit.value;
      if (hit.flag === 1 && hit.value > alpha) alpha = hit.value;
      else if (hit.flag === 2 && hit.value < beta) beta = hit.value;
      if (alpha >= beta) return hit.value;
    }
  }
  // The window this node is actually searched in, which is what its result is a bound of.
  const alpha0 = alpha;
  const beta0 = beta;
  const moves = e.moves[ply];
  const n = generate(e, mover, moves);
  order(e, moves, n, e.keys[ply]);
  if (hit) {
    // Last time's best slide goes first; most of the time it still is.
    for (let i = 1; i < n; i++) {
      const pawn = (moves[i] / 6) | 0;
      if (sim.pos[pawn] * 6 + moves[i] - pawn * 6 !== hit.best) continue;
      const mv = moves[i];
      moves.copyWithin(1, 0, i);
      moves[0] = mv;
      break;
    }
  }
  const outer = e.horizon;
  e.horizon = false;
  const maximising = mover === e.me;
  let best = maximising ? -Infinity : Infinity;
  let bestSlide = -1;
  for (let i = 0; i < n; i++) {
    const pawn = (moves[i] / 6) | 0;
    const dir = moves[i] - pawn * 6;
    const from = sim.pos[pawn];
    enter(e, pawn, landing(sim, pawn, dir));
    const v = search(e, depth - 1, alpha, beta, after(e, mover), ply + 1);
    leave(e, pawn, from);
    if (e.aborted) return 0;
    if (maximising ? v > best : v < best) {
      best = v;
      bestSlide = from * 6 + dir;
    }
    if (maximising) {
      if (best > alpha) alpha = best;
    } else if (best < beta) beta = best;
    if (alpha >= beta) {
      e.history[from * 6 + dir] += depth * depth;
      break;
    }
  }
  const horizon = e.horizon;
  e.horizon = outer || horizon;
  if (e.tt) e.tt.set(key, { depth, value: best, flag: best <= alpha0 ? 2 : best >= beta0 ? 1 : 0, best: bestSlide, horizon });
  return best;
}

/** How a skill level thinks. */
export interface Plan {
  budget: number; // positions examined per move — a count, never a clock
  maxDepth: number; // slides of lookahead at most
  band: number; // points: moves this close to the best are all fair game
  w: Weights;
  table?: boolean; // remember positions already searched (see TTEntry)
}

const MAX_PLY = 64;

/** The move `me` should play: iterative deepening, one full ply at a time, keeping the
 *  last depth that was finished (or the part of an unfinished one that started from the
 *  previous best, which is the one comparison that is still fair). */
export function chooseSlide(s: TState, me: number, rng: Rng, plan: Plan): { pawnId: number; direction: number; distance: number } | null {
  const sim = toSim(s);
  const e: Engine = {
    sim, me, w: plan.w, budget: plan.budget, nodes: 0, aborted: false, horizon: false,
    moves: Array.from({ length: MAX_PLY }, () => new Int32Array(sim.nPawn * 6)),
    keys: Array.from({ length: MAX_PLY }, () => new Float64Array(sim.nPawn * 6)),
    history: new Float64Array(sim.nHex * 6),
    dist: new Int16Array(sim.nHex), claim: new Int8Array(sim.nHex), comp: new Int16Array(sim.nHex),
    queue: new Int16Array(sim.nHex + sim.nPawn), mask: new Int32Array(sim.nHex), worth: new Float64Array(sim.np),
    tt: plan.table ? new Map() : null, zob: null, hash: 0, check: 0,
  };
  if (plan.table) {
    e.zob = zobristFor(sim);
    e.hash = keyOf(sim, e.zob, 0);
    e.check = keyOf(sim, e.zob, 1);
  }
  const rootBuf = new Int32Array(sim.nPawn * 6);
  const n = generate(e, me, rootBuf);
  if (!n) return null;
  order(e, rootBuf, n, new Float64Array(n));
  let ranked = Array.from(rootBuf.subarray(0, n), (mv) => ({ mv, v: 0 }));

  for (let depth = 1; depth <= Math.min(plan.maxDepth, MAX_PLY - 1); depth++) {
    e.horizon = false;
    const done: { mv: number; v: number }[] = [];
    let best = -Infinity;
    for (const { mv } of ranked) {
      const pawn = (mv / 6) | 0;
      const from = sim.pos[pawn];
      enter(e, pawn, landing(sim, pawn, mv - pawn * 6));
      const v = search(e, depth - 1, best - plan.band, Infinity, after(e, me), 1);
      leave(e, pawn, from);
      if (e.aborted) break;
      done.push({ mv, v });
      if (v > best) best = v;
    }
    if (done.length) {
      // An unfinished depth still settles every move it reached, and it reached the old
      // favourite first; the ones it never got to were already behind.
      const rest = ranked.filter((r) => !done.some((d) => d.mv === r.mv)).map((r) => ({ mv: r.mv, v: -Infinity }));
      ranked = [...done.sort((a, b) => b.v - a.v), ...rest];
    }
    if (e.aborted || !e.horizon) break; // out of budget, or already seen to the end
  }

  const top = ranked[0].v;
  let pick = ranked[0];
  let pickScore = -Infinity;
  for (const r of ranked) {
    if (r !== ranked[0] && !(r.v > top - plan.band)) continue;
    const score = r.v + rng() * plan.band;
    if (score > pickScore) {
      pickScore = score;
      pick = r;
    }
  }
  const pawn = (pick.mv / 6) | 0;
  const dir = pick.mv - pawn * 6;
  let distance = 0;
  for (let h = sim.pos[pawn], to = landing(sim, pawn, dir); h !== to; distance++) h = sim.nb[h * 6 + dir];
  return { pawnId: s.pawns[pawn].id, direction: dir, distance };
}

// ---------------------------------------------------------------------------
// Bot
//
// The previous Sharp bot searched three slides deep inside a 350-position budget, with no
// iterative deepening. The budget ran out part-way down the list of candidate moves, and
// every move after that point was judged on the board straight after it — nobody allowed
// to reply. About two thirds of the candidates were scored that way, so the comparison
// was between moves looked at pessimistically and moves looked at optimistically, and the
// optimistic ones won: in practice the bot mostly played whichever moves it happened to
// list last. Deepening one full ply at a time, and only ever comparing moves searched to
// the same depth, is the largest single part of what changed.
//
// Measured against that bot, with seats rotated and each board dealt at random: one new
// Sharp wins 72% of four-player games against three old ones (fair share 25%), 87% of
// three-player games, and all but one of 200 two-player games. The other way round, a
// player exactly as strong as the old bot, facing three new ones, wins 2.4% of games.
// ---------------------------------------------------------------------------

// Standing on a hex is as good as having banked it, near enough, because you bank the hex
// you LEAVE. The old weighting (half) taught the bot to cash in rather than to land on
// rich ground; counting it in full, with shared land trimmed to match, lifted the average
// 4-player finish from 2.41 to 1.92 against the untuned version (320 games).
const WEIGHTS: Weights = { stand: 1, sealed: 0.5, claim: 0.35, pawn: 0.5, focus: 0.5 };
// Steady judges the board its move leaves; Sharp searches. 12,000 positions is about 22ms
// a move on a laptop, 41ms at worst in 95 moves of 100 — in line with Quoridor's Sharp.
// A third of that, the same bot lost 70% of 2-player games to this one.
export const STEADY_PLAN: Plan = { budget: Infinity, maxDepth: 1, band: 0.3, w: WEIGHTS };
export const SHARP_PLAN: Plan = { budget: 12000, maxDepth: 40, band: 0.3, w: WEIGHTS };
// Master searches five times as far, and always plays the move it rates best — the board
// is dealt afresh every match, so there is no need to buy variety with strength. About
// 120ms a move (210ms at worst in 95 of 100). Against Sharp it wins 79% of 2-player games
// (160, ±3); one Master among three Sharps wins a third of 4-player games (60, fair share
// a quarter), finishing 2.08th on average.
export const MASTER_PLAN: Plan = { budget: 60000, maxDepth: 40, band: 0, w: WEIGHTS };
// Grandmaster remembers what it has searched (see TTEntry). At Master's own budget that
// alone won 67.5% of 2-player games against it (120); with two and a half times the
// budget it wins 78% (120, ±4). About 270ms a move, 530ms at worst in 95 of 100.
export const GRANDMASTER_PLAN: Plan = { budget: 150000, maxDepth: 40, band: 0, w: WEIGHTS, table: true };

function botMove(s: TState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.over) return null;
  const pid = s.order.indexOf(seat);
  if (pid !== s.turn) return null;
  const moves = legalMoves(s);
  if (!moves.length) return null;

  // Casual: banks the dearest hex it is standing on and ignores where that leaves it —
  // which is how a pawn ends up stranded on good land with nothing left to reach.
  if (s.skill <= CASUAL) {
    let pick = moves[0];
    let bestVal = -1;
    for (const m of moves) {
      const p = s.pawns.find((x) => x.id === m.pawnId)!;
      const v = s.hexes[id(p.q, p.r)].value + rng() * 0.5;
      if (v > bestVal) {
        bestVal = v;
        pick = m;
      }
    }
    return { type: 'slide', pawnId: pick.pawnId, direction: pick.direction, distance: pick.distance };
  }

  const plan = s.skill <= STEADY ? STEADY_PLAN : s.skill <= SHARP ? SHARP_PLAN : s.skill <= MASTER ? MASTER_PLAN : GRANDMASTER_PLAN;
  const mv = chooseSlide(s, pid, rng, plan);
  return mv && { type: 'slide', ...mv };
}

// ---------------------------------------------------------------------------
// GameDef factory (board config injected; no data bank needed)
// ---------------------------------------------------------------------------

export function createTectonic(config: TectonicConfig = {}): GameDef<TState> {
  const radius = config.radius ?? 6;
  const holeRadius = config.holeRadius ?? 1;
  // Shapes the POOL of tile values — edge hexes = 1 up to 5 beside the central void.
  // `create` then scatters that pool at random, so position does not imply value.
  const usingDefaultValue = !config.value;
  const valueOf = config.value ?? ((d: number) => Math.max(1, Math.min(5, radius + 1 - d)));
  const pawnsPer = config.pawnsPer ?? DEFAULT_PAWNS;

  return {
    id: 'tectonic',
    name: 'Tectonic Shift',
    blurb: 'Slide pawns across a shrinking hex board, banking the tiles you leave. Isolate land, harvest the most.',
    minPlayers: 2,
    maxPlayers: 4,
    options: [GRANDMASTER_SKILL_OPTION],

    validateStart(seats) {
      return seats.length >= 2 && seats.length <= 4 ? null : 'Tectonic Shift is for 2 to 4 players.';
    },

    create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): TState {
      const np = setup.seats.length;
      const players: (TPlayer | null)[] = new Array(8).fill(null);
      const nameBySeat = new Map(setup.players.map((p) => [p.seat, p.name]));
      for (const seat of setup.seats) players[seat] = { name: nameBySeat.get(seat) ?? `Seat ${seat + 1}`, connected: true };

      // Build the board, skipping the central void (hexes within holeRadius are absent).
      const hexes: Record<string, Hex> = {};
      for (let q = -radius; q <= radius; q++) {
        for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
          if (hexDist(q, r) <= holeRadius) continue;
          hexes[id(q, r)] = { value: valueOf(hexDist(q, r)), state: 'present', pawn: null };
        }
      }
      if (usingDefaultValue) reduceFives(hexes); // exactly three 5-tiles on the default board

      // Each player's pawns take an arc of the outer ring, SPACED rather than shoulder to
      // shoulder. Packing them together left the pawns in the middle of an arc with their
      // two ring neighbours taken by their own side and a single hex inward as their only
      // way out — one exit, which any opponent could seal on the opening move. Leaving a
      // hex between them gives every pawn both ring neighbours as well, so no single move
      // by anyone can strand one from the starting position.
      const ring = ringCells(radius);
      const arc = Math.floor(ring.length / np);
      const STRIDE = 2; // one empty hex between neighbouring pawns
      // Never claim more of the ring than this player's own arc: overlapping arcs would
      // stack pawns on one hex and orphan the hex→pawn link.
      const per = Math.min(pawnsPer[np] ?? 4, Math.floor((arc + 1) / STRIDE));
      const span = (per - 1) * STRIDE; // ring hexes from this player's first pawn to their last
      // Turn the whole arrangement by a random amount each match. The board's values are
      // already dealt afresh every game; rotating the pieces too means the opening itself
      // differs, instead of every match starting from the identical picture.
      const spin = Math.floor(ctx.rng() * ring.length);
      const pawns: Pawn[] = [];
      let pawnId = 0;
      for (let pid = 0; pid < np; pid++) {
        const start = pid * arc + Math.floor((arc - span) / 2);
        for (let k = 0; k < per; k++) {
          const idx = (start + k * STRIDE + spin + ring.length) % ring.length;
          const [q, r] = ring[idx];
          pawns.push({ id: pawnId, owner: pid, q, r, alive: true });
          hexes[id(q, r)].pawn = pawnId;
          hexes[id(q, r)].value = 0; // starting hexes are worth 0
          pawnId++;
        }
      }

      // Randomize the point layout each game: keep the exact multiset of tile values
      // (same total, same three 5s) but scatter them randomly across the non-starting
      // hexes. Starting hexes stay at 0 and are left untouched.
      const scoringKeys = Object.keys(hexes).filter((k) => hexes[k].pawn === null);
      const pool = shuffle(scoringKeys.map((k) => hexes[k].value), ctx.rng);
      scoringKeys.forEach((k, i) => { hexes[k].value = pool[i]; });

      const s: TState = {
        players,
        order: [...setup.seats],
        np,
        radius,
        hexes,
        pawns,
        scores: new Array(np).fill(0),
        turn: 0,
        winner: null,
        winners: [],
        over: false,
        skill: initSkill(setup.options?.skill, GRANDMASTER),
        log: [],
      };
      recomputeAlive(s);
      log(s, `${np}-player Tectonic Shift on a radius-${radius} board. ${nameOf(s, 0)} starts.`);
      return s;
    },

    act(s, seat, msg) {
      if (s.over) return fail('The game is over.');
      const pid = s.order.indexOf(seat);
      if (pid < 0) return fail('You are not in this match.');
      if (msg.type === 'slide') return slide(s, pid, msg.pawnId, msg.direction);
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
}

export const tectonic = createTectonic();
