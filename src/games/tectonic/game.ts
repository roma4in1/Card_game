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
import { initSkill, SKILL_OPTION, CASUAL, STEADY } from '../../platform/skill.ts';

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
  skill: number; // how hard the bots play (1 casual … 3 sharp)
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

/** A working copy of everything a slide changes. */
function cloneState(s: TState): TState {
  const hexes: Record<string, Hex> = {};
  for (const k of Object.keys(s.hexes)) hexes[k] = { ...s.hexes[k] };
  return { ...s, hexes, pawns: s.pawns.map((p) => ({ ...p })), scores: [...s.scores] };
}

/** The slide rule again, on a scratch board: bank the hex you leave, travel to the last
 *  free hex, hand the turn to the next player who can still move. */
function simSlide(sim: TState, pawnId: number, direction: number) {
  const p = sim.pawns.find((x) => x.id === pawnId)!;
  let q = p.q;
  let r = p.r;
  for (;;) {
    const nq = q + DIRS[direction][0];
    const nr = r + DIRS[direction][1];
    const h = sim.hexes[id(nq, nr)];
    if (!h || h.state !== 'present' || h.pawn !== null) break;
    q = nq;
    r = nr;
  }
  const origin = sim.hexes[id(p.q, p.r)];
  sim.scores[p.owner] += origin.value;
  origin.state = 'gap';
  origin.pawn = null;
  p.q = q;
  p.r = r;
  sim.hexes[id(q, r)].pawn = p.id;
  recomputeAlive(sim);
  for (let i = 1; i <= sim.np; i++) {
    const cand = (sim.turn + i) % sim.np;
    if (sim.pawns.some((x) => x.owner === cand && x.alive)) {
      sim.turn = cand;
      break;
    }
  }
}

/** What the board is worth to `me`: points banked, plus a share of what is still standing
 *  on each island, minus what the opposition can expect from theirs.
 *
 *  The share matters more than the immediate grab. Land nobody can reach is worth nothing
 *  to anyone; land only YOUR pawns can reach is as good as banked; land you are sharing
 *  splits by how many pawns each side has on it. A pawn also always strands itself on one
 *  last hex, so no island is ever collected clean — hence the discount. */
function evalPosition(s: TState, me: number): number {
  const comp: Record<string, number> = {};
  const sums: number[] = [];
  const counts: Record<number, number>[] = [];
  let nc = 0;
  for (const key of Object.keys(s.hexes)) {
    if (s.hexes[key].state !== 'present' || comp[key] !== undefined) continue;
    let sum = 0;
    const stack = [key];
    comp[key] = nc;
    while (stack.length) {
      const k = stack.pop()!;
      sum += s.hexes[k].value;
      const [q, r] = k.split(',').map(Number);
      for (const [dq, dr] of DIRS) {
        const nk = id(q + dq, r + dr);
        if (s.hexes[nk] && s.hexes[nk].state === 'present' && comp[nk] === undefined) {
          comp[nk] = nc;
          stack.push(nk);
        }
      }
    }
    sums[nc] = sum;
    counts[nc] = {};
    nc++;
  }
  for (const p of s.pawns) {
    if (!p.alive) continue;
    const c = comp[id(p.q, p.r)];
    if (c === undefined) continue;
    counts[c][p.owner] = (counts[c][p.owner] || 0) + 1;
  }

  const potential = new Array(s.np).fill(0);
  for (let c = 0; c < nc; c++) {
    const owners = Object.keys(counts[c]).map(Number);
    if (!owners.length) continue; // an island nobody can still reach is worth nothing
    const pawnsHere = owners.reduce((a, pid) => a + counts[c][pid], 0);
    for (const pid of owners) potential[pid] += sums[c] * (counts[c][pid] / pawnsHere) * 0.8;
  }

  const alive = new Array(s.np).fill(0);
  for (const p of s.pawns) if (p.alive) alive[p.owner]++;

  const worth = (pid: number) => s.scores[pid] + potential[pid] + alive[pid] * 0.4;
  let rival = -Infinity;
  for (let pid = 0; pid < s.np; pid++) if (pid !== me) rival = Math.max(rival, worth(pid));
  return worth(me) - rival;
}

// ---------------------------------------------------------------------------
// Bot — looks a move ahead and plays for territory, not for the next hex.
//
// The old bot banked whichever hex it happened to be standing on that was worth most,
// and never looked at where the slide put it. That loses two ways: it strands pawns on
// good land, and it opens islands for the other side to harvest. This one plays the move
// out, lets the next player answer it, and scores the board that results — so it will
// take a cheap hex now to seal an island only its own pawns can reach.
// ---------------------------------------------------------------------------

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

  let best = moves[0];
  let bestValue = -Infinity;
  for (const m of moves) {
    const sim = cloneState(s);
    simSlide(sim, m.pawnId, m.direction);
    let value: number;
    // Steady stops here: it judges the board it just made, but never lets the next player
    // answer, so it walks into replies it could have seen coming.
    if (s.skill <= STEADY) value = evalPosition(sim, pid);
    else if (sim.turn === pid || sim.pawns.every((p) => !p.alive)) {
      value = evalPosition(sim, pid); // nobody else can answer
    } else {
      // Let the next player take their best swing at it, and judge what is left.
      const replies = legalMoves(sim);
      value = Infinity;
      for (const r of replies) {
        const after = cloneState(sim);
        simSlide(after, r.pawnId, r.direction);
        value = Math.min(value, evalPosition(after, pid));
      }
      if (!replies.length) value = evalPosition(sim, pid);
    }
    // Only separates options the evaluation already rates level, but it keeps repeat
    // matches from replaying the same game move for move.
    const score = value + rng() * 0.3;
    if (score > bestValue) {
      bestValue = score;
      best = m;
    }
  }
  return { type: 'slide', pawnId: best.pawnId, direction: best.direction, distance: best.distance };
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
    options: [SKILL_OPTION],

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

      // Place each player's pawns in a contiguous arc on the outer ring (own side).
      const ring = ringCells(radius);
      const arc = Math.floor(ring.length / np);
      // Never hand out more pawns than the player's own arc of the ring can hold: two
      // arcs overlapping would stack pawns on one hex and orphan the hex→pawn link.
      const per = Math.min(pawnsPer[np] ?? 4, arc);
      const pawns: Pawn[] = [];
      let pawnId = 0;
      for (let pid = 0; pid < np; pid++) {
        const center = pid * arc + Math.floor(arc / 2);
        for (let k = 0; k < per; k++) {
          const idx = (center - Math.floor(per / 2) + k + ring.length) % ring.length;
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
        skill: initSkill(setup.options?.skill),
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
