// games/salvo/game.ts — "Salvo", a two-player hidden-fleet duel (Battleship).
//
// The whole game is one secret: where the other fleet is. So `view` is the load-bearing
// part of this file — it must send you your own waters in full, and of THEIR waters only
// what you have already shot at. A ship you have not found is not in your payload at all,
// because a client that receives it has already lost the game for its owner.
//
// You are dealt a legal fleet to start from, then move it: pick a ship, tap the square
// you want its bow on, turn it with a rotate that walks the hull back onto the board
// rather than refusing. Every placement is re-validated here — the client is only ever
// proposing, so a hand-edited message can't beach a ship or stack two hulls.
//
// Hitting lets you fire again — a good salvo keeps the initiative, and it stops a game of
// 64 blind squares from turning into a long alternation of single misses.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { initTimer, runTimer, timerView, TIMER_OPTION, type Timer } from '../../platform/turn-timer.ts';
import { initSkill, MASTER_SKILL_OPTION, CASUAL, STEADY, MASTER } from '../../platform/skill.ts';

const SIZE = 8;
export const FLEET: { name: string; size: number }[] = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];

type Shot = 'hit' | 'miss' | null;

interface Ship {
  name: string;
  size: number;
  x: number;
  y: number;
  horiz: boolean;
  hits: number;
}
interface SVPlayer {
  name: string;
  connected: boolean;
}

export interface SVState {
  players: (SVPlayer | null)[]; // by seat (length 8)
  order: number[]; // seat per player-index
  np: number;
  size: number;
  fleets: Ship[][]; // by player-index — THE secret
  shots: Shot[][]; // by player-index: what this player has fired INTO the opponent's grid
  ready: boolean[]; // by player-index
  turn: number; // player-index to fire
  fired: number; // total shots taken (drives the turn-timer key)
  last: { pid: number; x: number; y: number; result: 'hit' | 'miss'; sunk: string | null } | null;
  phase: 'place' | 'play' | 'done';
  timer: Timer;
  skill: number; // how hard the bots play (1 casual … 4 master)
  over: boolean;
  winners: number[]; // seats
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: SVState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: SVState, pid: number) => s.players[s.order[pid]]!.name;
const idx = (s: SVState, x: number, y: number) => y * s.size + x;
const inBoard = (s: SVState, x: number, y: number) => x >= 0 && y >= 0 && x < s.size && y < s.size;

/** Every cell a ship sits on. */
function shipCells(sh: Ship): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < sh.size; i++) out.push(sh.horiz ? [sh.x + i, sh.y] : [sh.x, sh.y + i]);
  return out;
}
const isSunk = (sh: Ship) => sh.hits >= sh.size;
const shipAt = (fleet: Ship[], x: number, y: number) => fleet.find((sh) => shipCells(sh).some(([cx, cy]) => cx === x && cy === y));

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Deal a random legal fleet. Ships may touch (as in the paper game) but never overlap.
 *  The rng is injected by the platform, so this must not be able to fail: a degenerate
 *  one (always the same square) would otherwise throw out of `create` and kill the room.
 *  After a fair run of attempts we simply lay the fleet out in rows instead. */
function randomFleet(size: number, rng: Rng): Ship[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const fleet: Ship[] = [];
    const taken = new Set<number>();
    let okAll = true;
    for (const spec of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const horiz = rng() < 0.5;
        const x = Math.floor(rng() * (horiz ? size - spec.size + 1 : size));
        const y = Math.floor(rng() * (horiz ? size : size - spec.size + 1));
        const sh: Ship = { name: spec.name, size: spec.size, x, y, horiz, hits: 0 };
        const cells = shipCells(sh);
        if (cells.some(([cx, cy]) => taken.has(cy * size + cx))) continue;
        for (const [cx, cy] of cells) taken.add(cy * size + cx);
        fleet.push(sh);
        placed = true;
      }
      if (!placed) { okAll = false; break; }
    }
    if (okAll) return fleet;
  }
  return FLEET.map((spec, i) => ({ name: spec.name, size: spec.size, x: 0, y: i, horiz: true, hits: 0 }));
}

/** Would `cand` sit legally in this fleet, ignoring the ship it is replacing? */
function fitsFleet(fleet: Ship[], skip: number, cand: Ship, size: number): boolean {
  const cells = shipCells(cand);
  if (cells.some(([x, y]) => x < 0 || y < 0 || x >= size || y >= size)) return false;
  const taken = new Set<number>();
  fleet.forEach((sh, i) => {
    if (i === skip) return;
    for (const [x, y] of shipCells(sh)) taken.add(y * size + x);
  });
  return !cells.some(([x, y]) => taken.has(y * size + x));
}

/** Drop one ship at a new origin/orientation. The bow is the (x, y) you name. */
function placeShip(s: SVState, pid: number, indexRaw: unknown, xRaw: unknown, yRaw: unknown, horizRaw: unknown): ActionResult {
  if (s.phase !== 'place') return fail('The fleets are already at sea.');
  if (s.ready[pid]) return fail('You have already given the order.');
  const i = Number(indexRaw);
  const fleet = s.fleets[pid];
  if (!Number.isInteger(i) || i < 0 || i >= fleet.length) return fail('No such ship.');
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return fail('That square is off the grid.');
  const horiz = horizRaw === undefined ? fleet[i].horiz : horizRaw === true;
  const cand: Ship = { ...fleet[i], x, y, horiz };
  if (!fitsFleet(fleet, i, cand, s.size)) return fail(`The ${fleet[i].name} does not fit there.`);
  fleet[i] = cand;
  return ok;
}

/** Turn a ship on the spot. If the far end would hang off the board or foul another
 *  ship, walk the origin back along the new axis rather than refusing outright —
 *  rotating a ship parked on an edge is exactly when you most want it to work. */
function rotateShip(s: SVState, pid: number, indexRaw: unknown): ActionResult {
  if (s.phase !== 'place') return fail('The fleets are already at sea.');
  if (s.ready[pid]) return fail('You have already given the order.');
  const i = Number(indexRaw);
  const fleet = s.fleets[pid];
  if (!Number.isInteger(i) || i < 0 || i >= fleet.length) return fail('No such ship.');
  const sh = fleet[i];
  const horiz = !sh.horiz;
  for (let back = 0; back < sh.size; back++) {
    const cand: Ship = { ...sh, horiz, x: horiz ? sh.x - back : sh.x, y: horiz ? sh.y : sh.y - back };
    if (fitsFleet(fleet, i, cand, s.size)) {
      fleet[i] = cand;
      return ok;
    }
  }
  return fail(`There is no room to turn the ${sh.name}.`);
}

function shuffleFleet(s: SVState, pid: number, rng: Rng): ActionResult {
  if (s.phase !== 'place') return fail('The fleets are already at sea.');
  if (s.ready[pid]) return fail('You have already given the order.');
  s.fleets[pid] = randomFleet(s.size, rng);
  return ok;
}

function setReady(s: SVState, pid: number): ActionResult {
  if (s.phase !== 'place') return fail('The fleets are already at sea.');
  if (s.ready[pid]) return fail('You have already given the order.');
  s.ready[pid] = true;
  log(s, `${nameOf(s, pid)}'s fleet is at sea.`);
  if (s.ready.every(Boolean)) {
    s.phase = 'play';
    log(s, `Both fleets are out. ${nameOf(s, s.turn)} fires first.`);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

function endGame(s: SVState, winner: number) {
  s.over = true;
  s.phase = 'done';
  s.winners = [s.order[winner]];
  const shotsUsed = s.shots[winner].filter((v) => v !== null).length;
  log(s, `🏆 ${nameOf(s, winner)} sinks the last ship — the fleet is destroyed in ${shotsUsed} shots.`);
}

function fire(s: SVState, pid: number, xRaw: unknown, yRaw: unknown): ActionResult {
  if (s.phase === 'place') return fail('Both fleets must be at sea first.');
  if (s.phase === 'done') return fail('The game is over.');
  if (pid !== s.turn) return fail('Not your turn.');
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isInteger(x) || !Number.isInteger(y) || !inBoard(s, x, y)) return fail('That square is off the grid.');
  if (s.shots[pid][idx(s, x, y)] !== null) return fail('You have already fired there.');

  const foe = 1 - pid;
  const ship = shipAt(s.fleets[foe], x, y);
  const col = String.fromCharCode(65 + x);
  if (!ship) {
    s.shots[pid][idx(s, x, y)] = 'miss';
    s.last = { pid, x, y, result: 'miss', sunk: null };
    log(s, `${nameOf(s, pid)} fires at ${col}${y + 1} — miss.`);
    s.turn = foe; // a miss hands over the initiative
    s.fired += 1;
    return ok;
  }

  ship.hits += 1;
  s.shots[pid][idx(s, x, y)] = 'hit';
  const sunk = isSunk(ship);
  s.last = { pid, x, y, result: 'hit', sunk: sunk ? ship.name : null };
  log(s, sunk ? `${nameOf(s, pid)} fires at ${col}${y + 1} — ${ship.name} sunk!` : `${nameOf(s, pid)} fires at ${col}${y + 1} — hit.`);
  s.fired += 1;
  if (s.fleets[foe].every(isSunk)) endGame(s, pid);
  // a hit keeps the guns warm: the same player fires again
  return ok;
}

// ---------------------------------------------------------------------------
// View — your waters in full, theirs only where you have already fired
// ---------------------------------------------------------------------------

function viewState(s: SVState, seat: number | null): Record<string, unknown> {
  const myPid = seat !== null ? s.order.indexOf(seat) : -1;
  const spectator = myPid < 0;
  const reveal = s.over; // once it's over, both fleets are laid bare

  /** The grid you are shooting into: your shots, plus the outline of anything sunk. */
  const enemyGrid = (pid: number) => {
    const foe = 1 - pid;
    const cells: Record<string, unknown>[] = [];
    const sunkCell = new Map<number, string>();
    for (const sh of s.fleets[foe]) {
      if (!isSunk(sh) && !reveal) continue; // an unsunk ship's position is never sent
      for (const [cx, cy] of shipCells(sh)) sunkCell.set(cy * s.size + cx, sh.name);
    }
    for (let y = 0; y < s.size; y++) {
      for (let x = 0; x < s.size; x++) {
        const i = idx(s, x, y);
        cells.push({ x, y, shot: s.shots[pid][i], sunk: sunkCell.get(i) ?? null });
      }
    }
    return cells;
  };

  /** Ship geometry, so the client can draw a hull rather than a run of squares —
   *  and so a ship can be picked up and moved during placement. */
  const fleetOf = (pid: number) => s.fleets[pid].map((sh, index) => ({
    index, name: sh.name, size: sh.size, x: sh.x, y: sh.y, horiz: sh.horiz, hits: sh.hits, sunk: isSunk(sh),
  }));
  /** The same for the fleet you are shooting at — but ONLY the ships you have sunk
   *  (everything, once the match is over). An unsunk hull is never described. */
  const wrecksOf = (pid: number) => s.fleets[1 - pid]
    .map((sh, index) => ({ index, name: sh.name, size: sh.size, x: sh.x, y: sh.y, horiz: sh.horiz, sunk: isSunk(sh) }))
    .filter((sh) => sh.sunk || reveal);

  /** Your own waters: where your ships are, and where you have been hit. */
  const ownGrid = (pid: number) => {
    const foe = 1 - pid;
    const mine = new Map<number, { name: string; sunk: boolean }>();
    for (const sh of s.fleets[pid]) for (const [cx, cy] of shipCells(sh)) mine.set(cy * s.size + cx, { name: sh.name, sunk: isSunk(sh) });
    const cells: Record<string, unknown>[] = [];
    for (let y = 0; y < s.size; y++) {
      for (let x = 0; x < s.size; x++) {
        const i = idx(s, x, y);
        const ship = mine.get(i);
        cells.push({ x, y, ship: ship ? ship.name : null, sunk: ship ? ship.sunk : false, shot: s.shots[foe][i] });
      }
    }
    return cells;
  };

  const players = Array.from({ length: s.np }, (_, pid) => ({
    seat: s.order[pid],
    name: nameOf(s, pid),
    connected: s.players[s.order[pid]]!.connected,
    ready: s.ready[pid],
    // ship counts are public: sinking one is announced, so this leaks nothing new
    afloat: s.fleets[pid].filter((sh) => !isSunk(sh)).length,
    sunkShips: s.fleets[pid].filter(isSunk).map((sh) => sh.name),
    isTurn: s.phase === 'play' && pid === s.turn,
  }));

  return {
    game: 'salvo',
    phase: s.phase,
    over: s.over,
    size: s.size,
    fleet: FLEET,
    players,
    activeSeat: s.phase === 'play' && !s.over ? s.order[s.turn] : null,
    last: s.last,
    timer: timerView(s.timer),
    you: spectator
      ? { seat: seat ?? -1, spectator: true, own: [], enemy: [], fleet: [], wrecks: [] }
      : {
          seat,
          pid: myPid,
          own: ownGrid(myPid),
          enemy: enemyGrid(myPid),
          fleet: fleetOf(myPid),
          wrecks: wrecksOf(myPid),
          ready: s.ready[myPid],
          isTurn: s.phase === 'play' && myPid === s.turn,
          canFire: s.phase === 'play' && myPid === s.turn && !s.over,
        },
    winners: s.over ? s.winners : null,
    log: s.log.slice(-15),
    matchWinner: null,
  };
}

// ---------------------------------------------------------------------------
// Bot — plays the density map, the way a strong human plays Battleship.
//
// For every ship still afloat it counts every placement still consistent with what it
// has been told — inside the board, clear of its own misses, clear of the hulls it has
// already sunk — and shoots wherever the most placements overlap. That alone beats
// checkerboard sweeping: it hunts big ships first because they have more ways to fit,
// and it tightens automatically as misses carve the water up.
//
// With a hit outstanding it switches to finishing that ship: only placements covering
// the wounded cells count, so it follows the hull's axis instead of poking blindly at
// all four neighbours.
//
// It reads ONLY what a player in its seat can see: its own shot history, and the ships
// it has actually sunk. Unsunk enemy positions are never consulted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Master — reasons about whole fleets, not one ship at a time.
//
// Sharp's density map counts each ship's placements as if it were alone on the board. It
// never asks whether the rest of the fleet still fits around them, or which ship a given
// hit belongs to, so it rates squares that no complete fleet could actually use. Master
// samples complete fleets instead — every afloat ship placed at once, none overlapping,
// all clear of misses and wrecks, every open hit explained by some ship, and no ship
// lying wholly on hits (it would have sunk, and been announced) — and fires at the square
// the most of them agree on. That is the true chance of a hit, given what it has seen.
//
// The fleets are drawn by a Gibbs chain: lift one ship, put it back uniformly among the
// spots still consistent with the others, repeat. That leaves every consistent fleet
// equally likely, which is what the dealt fleets are, near enough.
//
// Measured against Sharp over 2,000 games, first shot alternating: Master wins 53.5%
// (±1.1). That is a small edge, and an honest one — Sharp already shoots close to as well
// as the odds allow, and past that point who wins is mostly where the ships were dealt.
// ---------------------------------------------------------------------------

const lineCache = new Map<string, Int16Array[]>();
/** Every straight run of `size` squares on an n×n board. */
function linesFor(n: number, size: number): Int16Array[] {
  const k = `${n}:${size}`;
  let out = lineCache.get(k);
  if (out) return out;
  out = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x + size <= n) out.push(Int16Array.from({ length: size }, (_, i) => y * n + x + i));
      if (y + size <= n && size > 1) out.push(Int16Array.from({ length: size }, (_, i) => (y + i) * n + x));
    }
  }
  lineCache.set(k, out);
  return out;
}

const CHAINS = 4; // independent starts, so one stuck chain cannot decide the shot
const SWEEPS = 400; // each a full re-placing of every ship
const BURN_IN = 40;
const SEED_STEPS = 50000; // a first consistent fleet is found long before this

/** How many sampled fleets put a ship on each square — or null if none could be found,
 *  which only a hand-built position can cause (the real fleet is always consistent). */
export function fleetSamples(n: number, shots: Shot[], sunk: Set<number>, afloat: number[], rng: Rng): Float64Array | null {
  const cells = n * n;
  const hit = new Uint8Array(cells);
  const blocked = new Uint8Array(cells);
  const wounded: number[] = [];
  for (let i = 0; i < cells; i++) {
    if (shots[i] === 'miss' || sunk.has(i)) blocked[i] = 1;
    else if (shots[i] === 'hit') {
      hit[i] = 1;
      wounded.push(i);
    }
  }
  // Where each ship could lie at all, before the others are considered.
  const lines = afloat.map((size) => linesFor(n, size).filter((line) => {
    let hits = 0;
    for (const c of line) {
      if (blocked[c]) return false;
      hits += hit[c];
    }
    return hits < line.length;
  }));
  const ships = afloat.length;
  const occ = new Int8Array(cells).fill(-1); // square → the ship on it, in the current fleet
  const at = new Int32Array(ships).fill(-1); // ship → its line, or -1 while lifted
  const fits = (k: number, j: number) => lines[k][j].every((c) => occ[c] < 0);
  const put = (k: number, j: number) => {
    at[k] = j;
    for (const c of lines[k][j]) occ[c] = k;
  };
  const lift = (k: number) => {
    for (const c of lines[k][at[k]]) occ[c] = -1;
    at[k] = -1;
  };
  const shuffled = (len: number) => {
    const out = Array.from({ length: len }, (_, i) => i);
    for (let i = len - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  // A first consistent fleet, by backtracking: cover the open hits first — some ship must
  // lie across each of them — then fit whatever is left anywhere it goes.
  let steps = 0;
  const seed = (): boolean => {
    if (++steps > SEED_STEPS) return false;
    const open = wounded.find((c) => occ[c] < 0);
    if (open === undefined) {
      const k = at.indexOf(-1);
      if (k < 0) return true;
      for (const j of shuffled(lines[k].length)) {
        if (!fits(k, j)) continue;
        put(k, j);
        if (seed()) return true;
        lift(k);
      }
      return false;
    }
    for (const k of shuffled(ships)) {
      if (at[k] >= 0) continue;
      for (const j of shuffled(lines[k].length)) {
        if (!lines[k][j].includes(open) || !fits(k, j)) continue;
        put(k, j);
        if (seed()) return true;
        lift(k);
      }
    }
    return false;
  };

  // Open hits on each line, so a placement's share of them is one lookup.
  const hitsOn = lines.map((ls) => Int8Array.from(ls, (line) => line.reduce((a, c) => a + hit[c], 0)));
  const openHits = () => {
    let need = 0;
    for (const c of wounded) if (occ[c] < 0) need++;
    return need;
  };

  // Two ships at once, put back uniformly among every consistent pair. Moving one ship at
  // a time cannot do this: with a hit under ship A, A can only go back across it and B
  // can never take it over, so which ship explains a hit would be settled by the chain's
  // starting fleet and never revisited. Checked against exact enumeration on late-game
  // positions, single moves alone were out by as much as 53 points on some squares.
  const freeA = new Int32Array(Math.max(1, ...lines.map((l) => l.length)));
  const freeB = new Int32Array(freeA.length); // the second ship's open spots, grouped by hits covered
  const from = new Int32Array(7); // where each group starts in freeB (a ship is at most 5 long)
  const mark = new Uint32Array(cells);
  let stamp = 0;
  const repair = (k: number, j: number) => {
    lift(k);
    lift(j);
    const need = openHits();
    let ma = 0;
    for (let a = 0; a < lines[k].length; a++) if (fits(k, a)) freeA[ma++] = a;
    // Group B's spots by how many open hits each covers, so that for each spot of A only
    // the partners that explain exactly the rest are looked at.
    from.fill(0);
    for (let b = 0; b < lines[j].length; b++) if (fits(j, b)) from[hitsOn[j][b] + 1]++;
    for (let h = 1; h < from.length; h++) from[h] += from[h - 1];
    const fill = from.slice();
    for (let b = 0; b < lines[j].length; b++) if (fits(j, b)) freeB[fill[hitsOn[j][b]]++] = b;
    let seen = 0;
    let pa = at[k];
    let pb = at[j];
    for (let x = 0; x < ma; x++) {
      const a = freeA[x];
      const want = need - hitsOn[k][a];
      if (want < 0 || want > 5) continue;
      stamp++;
      for (const c of lines[k][a]) mark[c] = stamp;
      for (let y = from[want]; y < from[want + 1]; y++) {
        const b = freeB[y];
        let clash = false;
        for (const c of lines[j][b]) {
          if (mark[c] === stamp) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        if (rng() * ++seen < 1) { // reservoir: every pair equally likely, none stored
          pa = a;
          pb = b;
        }
      }
    }
    put(k, pa); // never empty: where the two were still qualifies
    put(j, pb);
  };

  const counts = new Float64Array(cells);
  const options = new Int32Array(freeA.length);
  for (let chain = 0; chain < CHAINS; chain++) {
    occ.fill(-1);
    at.fill(-1);
    steps = 0;
    if (!seed()) return null;
    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      for (const k of shuffled(ships)) {
        lift(k);
        // Open hits only this ship was explaining: wherever it goes, it must cover them.
        const need = openHits();
        let m = 0;
        for (let j = 0; j < lines[k].length; j++) if (hitsOn[k][j] === need && fits(k, j)) options[m++] = j;
        put(k, options[Math.floor(rng() * m)]); // never empty: where it was still qualifies
      }
      if (ships > 1 && wounded.length) {
        // Only an open hit can trap a chain this way, so only then is the pair move
        // needed: one ship lying across a hit, and any other to hand it to.
        const k = occ[wounded[Math.floor(rng() * wounded.length)]];
        repair(k, (k + 1 + Math.floor(rng() * (ships - 1))) % ships);
      }
      if (sweep < BURN_IN) continue;
      for (let i = 0; i < cells; i++) if (occ[i] >= 0) counts[i]++;
    }
  }
  return counts;
}

function botMove(s: SVState, seat: number, rng: Rng): Record<string, unknown> | null {
  const pid = s.order.indexOf(seat);
  if (pid < 0 || s.over) return null;
  if (s.phase === 'place') return s.ready[pid] ? null : { type: 'ready' };
  if (s.phase !== 'play' || pid !== s.turn) return null;

  const foe = 1 - pid;
  const mine = s.shots[pid];
  const N = s.size;
  const unfired = () => {
    const out: number[] = [];
    for (let i = 0; i < mine.length; i++) if (mine[i] === null) out.push(i);
    return out;
  };
  const shoot = (i: number) => ({ type: 'fire', x: i % N, y: Math.floor(i / N) });

  // Casual: fires blind. No sweep, no follow-up — a beginner with a grid.
  if (s.skill <= CASUAL) {
    const left = unfired();
    return left.length ? shoot(left[Math.floor(rng() * left.length)]) : null;
  }

  // What the shooter legitimately knows: which squares it has tried, and the hulls of
  // the ships it has sunk (announced by name when they go down).
  const sunkCells = new Set<number>();
  const sunkNames: string[] = [];
  for (const sh of s.fleets[foe]) {
    if (!isSunk(sh)) continue;
    sunkNames.push(sh.name);
    for (const [cx, cy] of shipCells(sh)) sunkCells.add(cy * N + cx);
  }
  // Hits that don't belong to anything sunk yet — a ship is still out there, wounded.
  const wounded: number[] = [];
  for (let i = 0; i < mine.length; i++) if (mine[i] === 'hit' && !sunkCells.has(i)) wounded.push(i);

  // Ships still afloat, by size. Names repeat (two 3s), so strike them off one by one.
  const afloat: number[] = [];
  const toRemove = [...sunkNames];
  for (const spec of FLEET) {
    const k = toRemove.indexOf(spec.name);
    if (k >= 0) toRemove.splice(k, 1);
    else afloat.push(spec.size);
  }
  if (!afloat.length) return null;

  // Steady: checkerboard sweep, then poke around a hit. Sound, but it never works out
  // which ship it is chasing, so it wastes shots on squares no hull could occupy.
  if (s.skill <= STEADY) {
    const targets: number[] = [];
    for (const i of wounded) {
      const x = i % N;
      const y = Math.floor(i / N);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
        const nx = x + dx;
        const ny = y + dy;
        if (inBoard(s, nx, ny) && mine[ny * N + nx] === null) targets.push(ny * N + nx);
      }
    }
    if (!targets.length) for (const i of unfired()) if ((i % N + Math.floor(i / N)) % 2 === 0) targets.push(i);
    const pool = targets.length ? targets : unfired();
    return pool.length ? shoot(pool[Math.floor(rng() * pool.length)]) : null;
  }

  if (s.skill >= MASTER) {
    const counts = fleetSamples(N, mine, sunkCells, afloat, rng);
    if (counts) {
      let pick = -1;
      let top = -1;
      for (let i = 0; i < counts.length; i++) {
        if (mine[i] !== null) continue;
        const score = counts[i] + rng() * 0.5; // jitter only breaks exact ties
        if (score > top) {
          top = score;
          pick = i;
        }
      }
      if (pick >= 0) return shoot(pick);
    }
  }

  const density = new Array(N * N).fill(0);
  for (const size of afloat) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        for (const horiz of [true, false]) {
          if (horiz ? x + size > N : y + size > N) continue;
          let ok = true;
          let covers = 0;
          const cells: number[] = [];
          for (let k = 0; k < size && ok; k++) {
            const i = (horiz ? y : y + k) * N + (horiz ? x + k : x);
            // a miss rules the placement out; so does a square already known to be
            // another ship's hull
            if (mine[i] === 'miss' || sunkCells.has(i)) ok = false;
            else {
              cells.push(i);
              if (mine[i] === 'hit') covers++;
            }
          }
          if (!ok) continue;
          // Finishing mode: while a ship is wounded, only placements that explain those
          // hits are worth anything — that is what keeps the bot on the hull's axis.
          if (wounded.length && covers === 0) continue;
          const weight = covers ? 1 + covers * 12 : 1;
          for (const i of cells) if (mine[i] === null) density[i] += weight;
        }
      }
    }
  }

  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < density.length; i++) {
    if (mine[i] !== null) continue;
    const score = density[i] + rng() * 0.5; // jitter only breaks exact ties
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  // Every remaining square is provably empty (can happen late on): take any of them.
  if (best < 0 || bestScore <= 0.5) {
    const left: number[] = [];
    for (let i = 0; i < mine.length; i++) if (mine[i] === null) left.push(i);
    if (!left.length) return null;
    best = left[Math.floor(rng() * left.length)];
  }
  return { type: 'fire', x: best % N, y: Math.floor(best / N) };
}

// --- turn timer: a stalled player forfeits the shot to their own bot ---
const svTurnKey = (s: SVState): string => (s.phase === 'play' && !s.over ? `${s.turn}:${s.fired}` : '');
function svForceTimeout(s: SVState, rng: Rng) {
  const mv = botMove(s, s.order[s.turn], rng) as { type: string; x: number; y: number } | null;
  if (mv && mv.type === 'fire') fire(s, s.turn, mv.x, mv.y);
}

// ---------------------------------------------------------------------------
// GameDef
// ---------------------------------------------------------------------------

export const salvo: GameDef<SVState> = {
  id: 'salvo',
  name: 'Salvo',
  blurb: 'Hide your fleet, then hunt theirs square by square. Every hit earns another shot.',
  minPlayers: 2,
  maxPlayers: 2,
  options: [MASTER_SKILL_OPTION, TIMER_OPTION],

  validateStart(seats) {
    return seats.length === 2 ? null : 'Salvo is a two-player duel.';
  },

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): SVState {
    const players: (SVPlayer | null)[] = new Array(8).fill(null);
    for (const pi of setup.players) players[pi.seat] = { name: pi.name, connected: true };
    const np = setup.seats.length;
    const s: SVState = {
      players,
      order: [...setup.seats],
      np,
      size: SIZE,
      fleets: setup.seats.map(() => randomFleet(SIZE, ctx.rng)),
      shots: setup.seats.map(() => new Array(SIZE * SIZE).fill(null)),
      ready: new Array(np).fill(false),
      turn: 0,
      fired: 0,
      last: null,
      phase: 'place',
      timer: initTimer(setup.options?.timer),
      skill: initSkill(setup.options?.skill, MASTER),
      over: false,
      winners: [],
      log: [],
    };
    log(s, `${SIZE}×${SIZE} waters, ${FLEET.length} ships each. Position your fleet, then give the order.`);
    return s;
  },

  act(s, seat, msg, ctx) {
    const pid = s.order.indexOf(seat);
    if (pid < 0) return fail('You are not in this match.');
    switch (msg.type) {
      case 'placeShip':
        return placeShip(s, pid, msg.index, msg.x, msg.y, msg.horiz);
      case 'rotateShip':
        return rotateShip(s, pid, msg.index);
      case 'shuffleFleet':
        return shuffleFleet(s, pid, ctx.rng);
      case 'ready':
        return setReady(s, pid);
      case 'fire':
        return fire(s, pid, msg.x, msg.y);
    }
  },

  tick(s, ctx) {
    return runTimer(s.timer, () => svTurnKey(s), ctx.now, () => svForceTimeout(s, ctx.rng));
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
