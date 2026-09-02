// games/volley-fire/game.ts — "Volley Fire", a two-player hidden-fleet duel where the
// answer comes back blurred.
//
// This is the harder relative of Salvo. There you fire one shot and are told hit or miss;
// here you fire FOUR at once and are told WHICH SHIPS they found — "two on the Carrier,
// one on the Destroyer" — but never which of your four shots did it. So a volley is a
// question you design, and the skill is designing questions whose answers mean something.
//
// Reporting the ships, rather than a bare count, is what makes it a deduction game instead
// of a sweep. A bare total was tried first and measured: the best bot still had to fire at
// 53 of the 64 squares to clear a fleet, barely better than shooting everywhere at random,
// because "two of these four landed" almost never resolves anything. Knowing a five-long
// ship lies under two of four named squares is a real constraint, and it compounds.
//
// Two rules hold the whole thing up, and both were found by trying to break it:
//
//   • Every shot must be at a square you have not fired at before. Without that you could
//     pad a volley with three known misses and one new square, get an unambiguous answer
//     every turn, and turn the game straight back into ordinary Battleship.
//
//   • A ship sinks once every one of its squares has been fired at — you do not have to
//     fire again at a hit you could not locate. Without that, a player who had shot the
//     whole board without identifying a ship would have no legal move left. It also makes
//     the game finite: at worst the board is exhausted and every ship goes down.
//
// `view` is the load-bearing part, as ever: it sends what a player has been TOLD, which is
// their own volley history and the deductions that follow from it with no thinking
// required — never the enemy fleet.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { initTimer, runTimer, timerView, TIMER_OPTION, type Timer } from '../../platform/turn-timer.ts';
import { initSkill, SKILL_OPTION, CASUAL, STEADY } from '../../platform/skill.ts';

const SIZE = 8;
const VOLLEY = 4; // shots per turn — fixed, so a losing fleet does not also lose firepower
export const FLEET: { name: string; size: number }[] = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];

/** What a player knows about one square of the enemy grid. */
export type Mark = 'unknown' | 'miss' | 'hit';

interface Ship {
  name: string;
  size: number;
  x: number;
  y: number;
  horiz: boolean;
}
interface VFPlayer {
  name: string;
  connected: boolean;
}
/** A volley as its firer sees it afterwards: where it went, and what it found. */
interface Volley {
  pid: number;
  cells: number[];
  hits: number;
  byShip: Record<string, number>; // ship name → how many of these shots struck it
  sunk: string[];
}

export interface VFState {
  players: (VFPlayer | null)[]; // by seat (length 8)
  order: number[]; // seat per player-index
  np: number;
  size: number;
  fleets: Ship[][]; // by player-index — THE secret
  fired: boolean[][]; // by player-index: squares this player has fired at
  known: Mark[][]; // by player-index: what they have been told about the enemy grid
  volleys: Volley[];
  ready: boolean[];
  turn: number;
  last: Volley | null;
  phase: 'place' | 'play' | 'done';
  timer: Timer;
  skill: number;
  over: boolean;
  winners: number[]; // seats
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: VFState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: VFState, pid: number) => s.players[s.order[pid]]!.name;
const cellOf = (s: VFState, x: number, y: number) => y * s.size + x;
const xOf = (s: VFState, i: number) => i % s.size;
const yOf = (s: VFState, i: number) => Math.floor(i / s.size);
const label = (s: VFState, i: number) => `${String.fromCharCode(65 + xOf(s, i))}${yOf(s, i) + 1}`;

/** Every square a ship sits on. */
function shipCells(s: VFState, sh: Ship): number[] {
  const out: number[] = [];
  for (let i = 0; i < sh.size; i++) out.push(sh.horiz ? cellOf(s, sh.x + i, sh.y) : cellOf(s, sh.x, sh.y + i));
  return out;
}
/** A ship is gone once every square it occupies has been fired at — no need to identify it. */
const isSunk = (s: VFState, sh: Ship, firedAt: boolean[]) => shipCells(s, sh).every((c) => firedAt[c]);
const shipAt = (s: VFState, fleet: Ship[], cell: number) => fleet.find((sh) => shipCells(s, sh).includes(cell));

// ---------------------------------------------------------------------------
// Placement — dealt legal, then yours to arrange (as in Salvo)
// ---------------------------------------------------------------------------

function randomFleet(s: VFState, rng: Rng): Ship[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const fleet: Ship[] = [];
    const taken = new Set<number>();
    let okAll = true;
    for (const spec of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const horiz = rng() < 0.5;
        const x = Math.floor(rng() * (horiz ? s.size - spec.size + 1 : s.size));
        const y = Math.floor(rng() * (horiz ? s.size : s.size - spec.size + 1));
        const sh: Ship = { name: spec.name, size: spec.size, x, y, horiz };
        const cells = shipCells(s, sh);
        if (cells.some((c) => taken.has(c))) continue;
        for (const c of cells) taken.add(c);
        fleet.push(sh);
        placed = true;
      }
      if (!placed) { okAll = false; break; }
    }
    if (okAll) return fleet;
  }
  // The rng is injected, so this must not be able to fail: lay them out in rows instead.
  return FLEET.map((spec, i) => ({ name: spec.name, size: spec.size, x: 0, y: i, horiz: true }));
}

function fitsFleet(s: VFState, fleet: Ship[], skip: number, cand: Ship): boolean {
  const cells: number[] = [];
  for (let i = 0; i < cand.size; i++) {
    const x = cand.horiz ? cand.x + i : cand.x;
    const y = cand.horiz ? cand.y : cand.y + i;
    if (x < 0 || y < 0 || x >= s.size || y >= s.size) return false;
    cells.push(cellOf(s, x, y));
  }
  const taken = new Set<number>();
  fleet.forEach((sh, i) => {
    if (i !== skip) for (const c of shipCells(s, sh)) taken.add(c);
  });
  return !cells.some((c) => taken.has(c));
}

function placeShip(s: VFState, pid: number, indexRaw: unknown, xRaw: unknown, yRaw: unknown, horizRaw: unknown): ActionResult {
  if (s.phase !== 'place') return fail('The fleets are already at sea.');
  if (s.ready[pid]) return fail('You have already given the order.');
  const i = Number(indexRaw);
  const fleet = s.fleets[pid];
  if (!Number.isInteger(i) || i < 0 || i >= fleet.length) return fail('No such ship.');
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return fail('That square is off the grid.');
  const cand: Ship = { ...fleet[i], x, y, horiz: horizRaw === undefined ? fleet[i].horiz : horizRaw === true };
  if (!fitsFleet(s, fleet, i, cand)) return fail(`The ${fleet[i].name} does not fit there.`);
  fleet[i] = cand;
  return ok;
}

function rotateShip(s: VFState, pid: number, indexRaw: unknown): ActionResult {
  if (s.phase !== 'place') return fail('The fleets are already at sea.');
  if (s.ready[pid]) return fail('You have already given the order.');
  const i = Number(indexRaw);
  const fleet = s.fleets[pid];
  if (!Number.isInteger(i) || i < 0 || i >= fleet.length) return fail('No such ship.');
  const sh = fleet[i];
  for (let back = 0; back < sh.size; back++) {
    const cand: Ship = { ...sh, horiz: !sh.horiz, x: sh.horiz ? sh.x : sh.x - back, y: sh.horiz ? sh.y - back : sh.y };
    if (fitsFleet(s, fleet, i, cand)) {
      fleet[i] = cand;
      return ok;
    }
  }
  return fail(`There is no room to turn the ${sh.name}.`);
}

function setReady(s: VFState, pid: number): ActionResult {
  if (s.phase !== 'place') return fail('The fleets are already at sea.');
  if (s.ready[pid]) return fail('You have already given the order.');
  s.ready[pid] = true;
  log(s, `${nameOf(s, pid)}'s fleet is at sea.`);
  if (s.ready.every(Boolean)) {
    s.phase = 'play';
    log(s, `Both fleets are out. ${nameOf(s, s.turn)} fires the first volley of ${VOLLEY}.`);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Firing a volley
// ---------------------------------------------------------------------------

/** Squares a player may still fire at. */
const openCells = (s: VFState, pid: number): number[] => {
  const out: number[] = [];
  for (let c = 0; c < s.size * s.size; c++) if (!s.fired[pid][c]) out.push(c);
  return out;
};
/** How many shots this volley may carry — fewer only when the board is nearly exhausted. */
export const volleySize = (s: VFState, pid: number) => Math.min(VOLLEY, openCells(s, pid).length);

const sunkNames = (s: VFState, pid: number): string[] =>
  s.fleets[1 - pid].filter((sh) => isSunk(s, sh, s.fired[pid])).map((sh) => sh.name);

function endGame(s: VFState, winner: number) {
  s.over = true;
  s.phase = 'done';
  s.winners = [s.order[winner]];
  const shots = s.fired[winner].filter(Boolean).length;
  log(s, `🏆 ${nameOf(s, winner)} sinks the last ship — the fleet is gone in ${shots} shots.`);
}

function fireVolley(s: VFState, pid: number, cellsRaw: unknown): ActionResult {
  if (s.phase === 'place') return fail('Both fleets must be at sea first.');
  if (s.phase === 'done') return fail('The game is over.');
  if (pid !== s.turn) return fail('Not your turn.');
  if (!Array.isArray(cellsRaw)) return fail('A volley is a list of squares.');
  const want = volleySize(s, pid);
  const cells = cellsRaw.map(Number);
  if (cells.length !== want) return fail(`A volley is ${want} shot${want === 1 ? '' : 's'} — you picked ${cells.length}.`);
  if (new Set(cells).size !== cells.length) return fail('Two shots at the same square.');
  for (const c of cells) {
    if (!Number.isInteger(c) || c < 0 || c >= s.size * s.size) return fail('That square is off the grid.');
    // The rule the game rests on: no padding a volley with squares you already know.
    if (s.fired[pid][c]) return fail(`You have already fired at ${label(s, c)}.`);
  }

  const foe = 1 - pid;
  const before = new Set(sunkNames(s, pid));
  const byShip: Record<string, number> = {};
  let hits = 0;
  for (const c of cells) {
    s.fired[pid][c] = true;
    const hit = shipAt(s, s.fleets[foe], c);
    if (hit) {
      hits += 1;
      byShip[hit.name] = (byShip[hit.name] ?? 0) + 1;
    }
  }
  const sunk = sunkNames(s, pid).filter((n) => !before.has(n));

  // Mark what follows with no thinking required. All of them or none of them is not a
  // deduction, it is bookkeeping — but anything between stays genuinely open, which is
  // the whole game.
  if (hits === 0) for (const c of cells) s.known[pid][c] = 'miss';
  else if (hits === cells.length) for (const c of cells) s.known[pid][c] = 'hit';
  // A ship that has gone down is no longer a mystery: show where it was.
  for (const sh of s.fleets[foe]) {
    if (!isSunk(s, sh, s.fired[pid])) continue;
    for (const c of shipCells(s, sh)) s.known[pid][c] = 'hit';
  }

  const volley: Volley = { pid, cells: [...cells], hits, byShip, sunk };
  s.volleys.push(volley);
  s.last = volley;
  const where = cells.map((c) => label(s, c)).join(' ');
  const found = Object.entries(byShip).map(([n, k]) => `${k} on the ${n}`).join(', ');
  log(s, `${nameOf(s, pid)} fires at ${where} — ${found || 'all water'}${sunk.length ? `. ${sunk.join(' and ')} sunk!` : '.'}`);

  if (s.fleets[foe].every((sh) => isSunk(s, sh, s.fired[pid]))) {
    endGame(s, pid);
    return ok;
  }
  s.turn = foe;
  return ok;
}

// ---------------------------------------------------------------------------
// View — your own grid in full, theirs only as far as you have been told
// ---------------------------------------------------------------------------

function viewState(s: VFState, seat: number | null): Record<string, unknown> {
  const myPid = seat !== null ? s.order.indexOf(seat) : -1;
  const spectator = myPid < 0;
  const reveal = s.over;

  /** The grid you are firing into: what you have been told, and nothing else. */
  const enemyGrid = (pid: number) => {
    const foe = 1 - pid;
    const truth = new Set<number>();
    if (reveal) for (const sh of s.fleets[foe]) for (const c of shipCells(s, sh)) truth.add(c);
    const cells: Record<string, unknown>[] = [];
    for (let c = 0; c < s.size * s.size; c++) {
      cells.push({
        cell: c,
        x: xOf(s, c),
        y: yOf(s, c),
        fired: s.fired[pid][c],
        // 'unknown' on a fired square is the point of the game: you shot there and still
        // do not know what you hit.
        mark: reveal ? (truth.has(c) ? 'hit' : 'miss') : s.known[pid][c],
      });
    }
    return cells;
  };

  /** Your own waters: your ships, and every square they have fired at. */
  const ownGrid = (pid: number) => {
    const foe = 1 - pid;
    const mine = new Map<number, string>();
    for (const sh of s.fleets[pid]) for (const c of shipCells(s, sh)) mine.set(c, sh.name);
    const cells: Record<string, unknown>[] = [];
    for (let c = 0; c < s.size * s.size; c++) {
      cells.push({ cell: c, x: xOf(s, c), y: yOf(s, c), ship: mine.get(c) ?? null, incoming: s.fired[foe][c] });
    }
    return cells;
  };

  const fleetOf = (pid: number) => s.fleets[pid].map((sh, index) => ({
    index, name: sh.name, size: sh.size, x: sh.x, y: sh.y, horiz: sh.horiz,
    sunk: isSunk(s, sh, s.fired[1 - pid]),
  }));
  /** Of the fleet you are shooting at, only the wrecks — and everything, once it is over. */
  const wrecksOf = (pid: number) => s.fleets[1 - pid]
    .map((sh, index) => ({ index, name: sh.name, size: sh.size, x: sh.x, y: sh.y, horiz: sh.horiz, sunk: isSunk(s, sh, s.fired[pid]) }))
    .filter((sh) => sh.sunk || reveal);

  const players = Array.from({ length: s.np }, (_, pid) => ({
    seat: s.order[pid],
    name: nameOf(s, pid),
    connected: s.players[s.order[pid]]!.connected,
    ready: s.ready[pid],
    afloat: s.fleets[pid].filter((sh) => !isSunk(s, sh, s.fired[1 - pid])).length,
    sunkShips: s.fleets[pid].filter((sh) => isSunk(s, sh, s.fired[1 - pid])).map((sh) => sh.name),
    isTurn: s.phase === 'play' && pid === s.turn,
  }));

  return {
    game: 'volley-fire',
    phase: s.phase,
    over: s.over,
    size: s.size,
    fleet: FLEET,
    volleySize: myPid >= 0 && s.phase === 'play' ? volleySize(s, myPid) : VOLLEY,
    players,
    activeSeat: s.phase === 'play' && !s.over ? s.order[s.turn] : null,
    // The player being shot at sees the splashes in their own water regardless, so hiding
    // the squares from them would be for show. A spectator, who sees neither grid, gets
    // the count and nothing else.
    last: s.last ? (spectator ? { ...s.last, cells: [] } : s.last) : null,
    timer: timerView(s.timer),
    you: spectator
      ? { seat: seat ?? -1, spectator: true, own: [], enemy: [], fleet: [], wrecks: [], volleys: [] }
      : {
          seat,
          pid: myPid,
          own: ownGrid(myPid),
          enemy: enemyGrid(myPid),
          fleet: fleetOf(myPid),
          wrecks: wrecksOf(myPid),
          // Your own volley history is your working: which squares, and how many landed.
          volleys: s.volleys.filter((v) => v.pid === myPid).map((v, i) => ({ n: i + 1, cells: v.cells, hits: v.hits, byShip: v.byShip, sunk: v.sunk })),
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
// Bot
//
// The reports name ships, which turns each past volley into an EXACT statement about every
// ship still afloat: "the Carrier put two squares inside this set of four, the Cruiser
// none". So for each named ship the Sharp bot walks every placement it could still occupy
// and throws away the ones that disagree with any volley it has fired — a placement that
// would have shown up in a report and did not is simply impossible. What survives is the
// density map, and it sharpens with every volley rather than blurring.
//
// It then picks its shots to keep the ANSWER readable: after choosing a square, everything
// sharing an unresolved volley with it is discounted, so a volley tends not to ask about
// the same ambiguity twice. Four shots into one uncertain patch come back as one number
// and settle almost nothing.
//
// It reads only what its own seat is told: its shot history, its own volley results, and
// the ships it has actually sunk.
// ---------------------------------------------------------------------------

function chooseVolley(s: VFState, pid: number, rng: Rng): number[] {
  const foe = 1 - pid;
  const n = s.size * s.size;
  const open = openCells(s, pid);
  const want = volleySize(s, pid);
  if (s.skill <= CASUAL) {
    const pool = [...open];
    const out: number[] = [];
    while (out.length < want && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    return out;
  }

  // Ships still afloat. Names matter now, not just sizes: the reports are by name, and two
  // of the ships are the same length.
  const gone = new Set(sunkNames(s, pid));
  const afloatShips = FLEET.filter((spec) => !gone.has(spec.name));

  // What each still-open square is worth, from the volleys that remain unresolved.
  const prior = new Array(n).fill(0);
  if (s.skill > STEADY) {
    for (const v of s.volleys) {
      if (v.pid !== pid) continue;
      const unresolved = v.cells.filter((c) => s.known[pid][c] === 'unknown');
      if (!unresolved.length) continue;
      const already = v.cells.filter((c) => s.known[pid][c] === 'hit').length;
      const left = Math.max(0, v.hits - already);
      for (const c of unresolved) prior[c] += left / unresolved.length;
    }
  }

  // My own volleys, as constraints to test placements against.
  const mine = s.volleys.filter((v) => v.pid === pid);
  const density = new Array(n).fill(0);
  for (const spec of afloatShips) {
    for (let y = 0; y < s.size; y++) {
      for (let x = 0; x < s.size; x++) {
        for (const horiz of [true, false]) {
          if (horiz ? x + spec.size > s.size : y + spec.size > s.size) continue;
          const cells: number[] = [];
          let okAll = true;
          let covers = 0;
          for (let k = 0; k < spec.size && okAll; k++) {
            const c = cellOf(s, horiz ? x + k : x, horiz ? y : y + k);
            if (s.known[pid][c] === 'miss') okAll = false;
            else {
              cells.push(c);
              if (s.known[pid][c] === 'hit') covers += 1;
              else covers += prior[c]; // a square a volley suggested is warm
            }
          }
          if (!okAll) continue;
          // Sharp holds every placement to the reports: this ship must have put exactly
          // the number of squares inside each past volley that the answer said it did.
          if (s.skill > STEADY) {
            let consistent = true;
            for (const v of mine) {
              const said = v.byShip[spec.name] ?? 0;
              let inside = 0;
              for (const c of cells) if (v.cells.includes(c)) inside += 1;
              if (inside !== said) { consistent = false; break; }
            }
            if (!consistent) continue;
          }
          const weight = 1 + covers * 6;
          for (const c of cells) if (!s.fired[pid][c]) density[c] += weight;
        }
      }
    }
  }

  // Pick shots that do not ask the same question twice.
  const share = new Map<number, Set<number>>(); // square → squares sharing an unresolved volley
  if (s.skill > STEADY) {
    for (const v of s.volleys) {
      if (v.pid !== pid) continue;
      const unresolved = v.cells.filter((c) => s.known[pid][c] === 'unknown');
      for (const a of unresolved) {
        const set = share.get(a) ?? new Set<number>();
        for (const b of unresolved) if (b !== a) set.add(b);
        share.set(a, set);
      }
    }
  }
  const picked: number[] = [];
  const discount = new Array(n).fill(1);
  while (picked.length < want) {
    let best = -1;
    let bestScore = -Infinity;
    for (const c of open) {
      if (picked.includes(c)) continue;
      const score = density[c] * discount[c] + rng() * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best < 0) break;
    picked.push(best);
    for (const other of share.get(best) ?? []) discount[other] *= 0.25;
    // Neighbours of a chosen square answer much the same question, so ease off them too.
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      const nx = xOf(s, best) + dx;
      const ny = yOf(s, best) + dy;
      if (nx >= 0 && ny >= 0 && nx < s.size && ny < s.size) discount[cellOf(s, nx, ny)] *= 0.6;
    }
  }
  return picked;
}

function botMove(s: VFState, seat: number, rng: Rng): Record<string, unknown> | null {
  const pid = s.order.indexOf(seat);
  if (pid < 0 || s.over) return null;
  if (s.phase === 'place') return s.ready[pid] ? null : { type: 'ready' };
  if (s.phase !== 'play' || pid !== s.turn) return null;
  const cells = chooseVolley(s, pid, rng);
  return cells.length ? { type: 'volley', cells } : null;
}

const vfTurnKey = (s: VFState): string => (s.phase === 'play' && !s.over ? `${s.turn}:${s.volleys.length}` : '');
function vfForceTimeout(s: VFState, rng: Rng) {
  const mv = botMove(s, s.order[s.turn], rng) as { type: string; cells: number[] } | null;
  if (mv && mv.type === 'volley') fireVolley(s, s.turn, mv.cells);
}

// ---------------------------------------------------------------------------
// GameDef
// ---------------------------------------------------------------------------

export const volleyFire: GameDef<VFState> = {
  id: 'volley-fire',
  name: 'Volley Fire',
  blurb: 'Fire four shots at once and learn only how many landed. Design volleys whose answers mean something.',
  minPlayers: 2,
  maxPlayers: 2,
  options: [SKILL_OPTION, TIMER_OPTION],

  validateStart(seats) {
    return seats.length === 2 ? null : 'Volley Fire is a two-player duel.';
  },

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): VFState {
    const players: (VFPlayer | null)[] = new Array(8).fill(null);
    for (const pi of setup.players) players[pi.seat] = { name: pi.name, connected: true };
    const np = setup.seats.length;
    const s: VFState = {
      players,
      order: [...setup.seats],
      np,
      size: SIZE,
      fleets: [],
      fired: setup.seats.map(() => new Array(SIZE * SIZE).fill(false)),
      known: setup.seats.map(() => new Array(SIZE * SIZE).fill('unknown') as Mark[]),
      volleys: [],
      ready: new Array(np).fill(false),
      turn: 0,
      last: null,
      phase: 'place',
      timer: initTimer(setup.options?.timer),
      skill: initSkill(setup.options?.skill),
      over: false,
      winners: [],
      log: [],
    };
    s.fleets = setup.seats.map(() => randomFleet(s, ctx.rng));
    log(s, `${SIZE}×${SIZE} waters, ${FLEET.length} ships each. Volleys of ${VOLLEY} — you learn how many hit, never which.`);
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
        if (s.phase !== 'place') return fail('The fleets are already at sea.');
        if (s.ready[pid]) return fail('You have already given the order.');
        s.fleets[pid] = randomFleet(s, ctx.rng);
        return ok;
      case 'ready':
        return setReady(s, pid);
      case 'volley':
        return fireVolley(s, pid, msg.cells);
    }
  },

  tick(s, ctx) {
    return runTimer(s.timer, () => vfTurnKey(s), ctx.now, () => vfForceTimeout(s, ctx.rng));
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
