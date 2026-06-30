// games/ice-football/game.ts — "Ice Football", a simultaneous-commitment team physics
// football game (1v1 up to 4v4) on the same engine as Penguin Knockout. Each player is one
// piece on the ice; each round everyone SECRETLY commits their piece's { angle, power } (+
// optionally a banked power-up); all moves resolve AT ONCE via deterministic 2D physics. A
// free, lighter BALL gets shoved around by collisions — knock it through the opponent's goal.
//
// Selective boundary: the perimeter is a SOLID WALL to the ball (it bounces, only leaving
// through a goal gap) but OPEN to player pieces (they slide off and respawn). First to N goals.
// Server is the authoritative referee; only the round's commitments are hidden (revealed on
// resolve). No RNG in the physics → every client replays the identical animation.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';

const MAX_SEATS = 8;

// --- pitch + physics constants (normalized; pitch is [-HX,HX] x [-HY,HY]) ---
const HX = 1.0, HY = 0.6; // pitch half-extents
const GOAL_HY = 0.26; // goal-mouth half-height (gap in the x-end walls)
const RP = 0.07, P_MASS = 1, P_DRAG = 0.86; // piece radius / mass / friction
const RB = 0.05, B_MASS = 0.45, B_DRAG = 0.93; // ball: lighter + slicker → kicks carry
const VMAX = 0.155, REST = 0.85, WALL_BOUNCE = 0.8;
const STOP = 0.0009, MAX_TICKS = 320;
const ITEM_R = 0.05, WALL_R = 0.14;
const PU = { powerShot: 1.9, bigR: RP * 1.6, bigM: 2.3, slickDrag: 0.96 } as const;
const ALL_POWERUPS = ['powerShot', 'bigPiece', 'slick', 'freeze', 'wall'];
const SPAWN_SPOTS = [[0, 0.4], [0, -0.4], [0.5, 0], [-0.5, 0]];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
type Team = 'red' | 'blue';
const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

interface Piece { name: string; connected: boolean; team: Team; x: number; y: number; homeX: number; homeY: number; powerUps: string[] }
interface Ball { x: number; y: number; vx: number; vy: number }
interface Item { id: number; type: string; x: number; y: number }
interface Commit { angle: number; power: number; usePowerUp?: { type: string; targetId?: number } }
type Phase = 'commit' | 'resolve' | 'done';

interface PFrame { id: number; x: number; y: number; o: boolean }
interface Impact { f: number; x: number; y: number; s: number } // collision flash: frame, position, strength
interface Resolution {
  frames: { b: { x: number; y: number }; p: PFrame[] }[];
  reveal: { id: number; angle: number; power: number; powerUp: string | null }[];
  goal: Team | null;
  walls: { x: number; y: number; r: number }[];
  pickups: { pieceId: number; type: string }[];
  impacts: Impact[];
}

export interface IFState {
  pieces: (Piece | null)[]; // by seat
  order: number[];
  ball: Ball;
  score: { red: number; blue: number };
  goalsToWin: number;
  phase: Phase;
  round: number;
  commitments: Record<number, Commit>; // SECRET until resolution
  powerUpsOnPitch: Item[];
  nextItemId: number;
  commitDeadline: number;
  resolveDeadline: number;
  pendingDone: boolean;
  lastResolution: Resolution | null;
  over: boolean;
  winners: number[];
  timerSecs: number;
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: IFState, msg: string) { s.log.push(msg); if (s.log.length > 40) s.log.shift(); }
const nameOf = (s: IFState, seat: number) => s.pieces[seat]!.name;
const seated = (s: IFState) => s.order.filter((seat) => s.pieces[seat]);

// ---------------------------------------------------------------------------
// Deterministic physics (pieces + ball + static blockers), no RNG
// ---------------------------------------------------------------------------

interface Body { id: number; x: number; y: number; vx: number; vy: number; mass: number; drag: number; radius: number; off: boolean }
interface Static { x: number; y: number; r: number }

function simulate(pieces: Body[], ball: Body, statics: Static[], items: Item[]) {
  const frames: Resolution['frames'] = [];
  const pickups: { pieceId: number; type: string }[] = [];
  const impacts: Impact[] = [];
  const taken = new Set<number>();
  let goal: Team | null = null;
  const snap = () => frames.push({
    b: { x: +ball.x.toFixed(4), y: +ball.y.toFixed(4) },
    p: pieces.map((p) => ({ id: p.id, x: +p.x.toFixed(4), y: +p.y.toFixed(4), o: p.off })),
  });
  const dynPair = (a: Body, b: Body) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    const min = a.radius + b.radius;
    if (d <= 0 || d >= min) return;
    const nx = dx / d, ny = dy / d;
    const overlap = min - d;
    const wa = b.mass / (a.mass + b.mass), wb = a.mass / (a.mass + b.mass);
    a.x -= nx * overlap * wa; a.y -= ny * overlap * wa;
    b.x += nx * overlap * wb; b.y += ny * overlap * wb;
    const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (closing > 0) {
      const j = ((1 + REST) * closing) / (1 / a.mass + 1 / b.mass);
      a.vx -= (j / a.mass) * nx; a.vy -= (j / a.mass) * ny;
      b.vx += (j / b.mass) * nx; b.vy += (j / b.mass) * ny;
      if (closing > 0.012 && impacts.length < 40) impacts.push({ f: frames.length, x: +((a.x + b.x) / 2).toFixed(3), y: +((a.y + b.y) / 2).toFixed(3), s: +Math.min(1, closing * 3).toFixed(2) });
    }
  };
  const staticHit = (d: Body, st: Static) => {
    const dx = d.x - st.x, dy = d.y - st.y;
    const dist = Math.hypot(dx, dy);
    const min = d.radius + st.r;
    if (dist <= 0 || dist >= min) return;
    const nx = dx / dist, ny = dy / dist;
    d.x += nx * (min - dist); d.y += ny * (min - dist);
    const vn = d.vx * nx + d.vy * ny;
    if (vn < 0) { d.vx -= (1 + REST) * vn * nx; d.vy -= (1 + REST) * vn * ny; }
  };
  const allDyn = [...pieces, ball];
  const moving = (b: Body) => b !== ball && b.off; // off pieces stop simulating

  snap();
  let scored = false;
  for (let t = 0; t < MAX_TICKS && !scored; t++) {
    // Substep so the (fast, slick) ball can't tunnel through a wall, goal mouth or piece.
    let maxV = 0;
    for (const b of allDyn) if (!moving(b)) maxV = Math.max(maxV, Math.hypot(b.vx, b.vy));
    const sub = Math.max(1, Math.min(20, Math.ceil(maxV / (RB * 0.5))));
    for (let k = 0; k < sub && !scored; k++) {
      for (const b of allDyn) if (!moving(b)) { b.x += b.vx / sub; b.y += b.vy / sub; }

      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < allDyn.length; i++) {
          for (let j = i + 1; j < allDyn.length; j++) {
            if (moving(allDyn[i]) || moving(allDyn[j])) continue;
            dynPair(allDyn[i], allDyn[j]);
          }
        }
        for (const d of allDyn) if (!moving(d)) for (const st of statics) staticHit(d, st);
      }

      // ball: goal first, then bounce off the solid perimeter (gap only at the goal mouths)
      if (Math.abs(ball.y) < GOAL_HY && ball.x > HX) { goal = 'red'; scored = true; break; }
      if (Math.abs(ball.y) < GOAL_HY && ball.x < -HX) { goal = 'blue'; scored = true; break; }
      const inGap = Math.abs(ball.y) < GOAL_HY;
      if (!inGap && ball.x + RB > HX) { ball.x = HX - RB; ball.vx = -ball.vx * WALL_BOUNCE; }
      if (!inGap && ball.x - RB < -HX) { ball.x = -HX + RB; ball.vx = -ball.vx * WALL_BOUNCE; }
      if (ball.y + RB > HY) { ball.y = HY - RB; ball.vy = -ball.vy * WALL_BOUNCE; }
      if (ball.y - RB < -HY) { ball.y = -HY + RB; ball.vy = -ball.vy * WALL_BOUNCE; }

      // pieces: the perimeter is OPEN to them — slide off and they're out for the round
      for (const p of pieces) if (!p.off && (Math.abs(p.x) > HX || Math.abs(p.y) > HY)) p.off = true;

      // power-up pickups (pass over an item)
      for (const p of pieces) if (!p.off) for (const it of items) {
        if (!taken.has(it.id) && Math.hypot(p.x - it.x, p.y - it.y) < p.radius + ITEM_R) { taken.add(it.id); pickups.push({ pieceId: p.id, type: it.type }); }
      }
    }

    for (const b of allDyn) if (!moving(b)) { b.vx *= b.drag; b.vy *= b.drag; }
    snap();
    if (allDyn.every((b) => (b !== ball && b.off) || Math.hypot(b.vx, b.vy) < STOP)) break;
  }
  return { frames, goal, pickups, impacts, takenItems: [...taken], offIds: pieces.filter((p) => p.off).map((p) => p.id), finalPieces: pieces, finalBall: ball };
}

// ---------------------------------------------------------------------------
// Round resolution
// ---------------------------------------------------------------------------

function resolveRound(s: IFState, now: number) {
  const live = seated(s);
  const statics: Static[] = [];
  const freezeTargets = new Set<number>();
  const reveal: Resolution['reveal'] = [];

  const bodies: Body[] = live.map((seat) => {
    const p = s.pieces[seat]!;
    const c = s.commitments[seat] || { angle: 0, power: 0 };
    let v0 = clamp(c.power, 0, 1) * VMAX;
    let radius = RP, mass = P_MASS, drag = P_DRAG;
    let usedPU: string | null = null;
    const pu = c.usePowerUp;
    if (pu && p.powerUps.includes(pu.type)) {
      usedPU = pu.type;
      p.powerUps.splice(p.powerUps.indexOf(pu.type), 1); // consume
      if (pu.type === 'powerShot') v0 *= PU.powerShot;
      else if (pu.type === 'bigPiece') { radius = PU.bigR; mass = PU.bigM; }
      else if (pu.type === 'slick') drag = PU.slickDrag;
      else if (pu.type === 'wall') statics.push({ x: p.team === 'red' ? -(HX - 0.16) : HX - 0.16, y: 0, r: WALL_R });
      else if (pu.type === 'freeze' && pu.targetId != null && s.pieces[pu.targetId] && s.pieces[pu.targetId]!.team !== p.team) freezeTargets.add(pu.targetId);
    }
    const a = (c.angle * Math.PI) / 180;
    reveal.push({ id: seat, angle: c.angle, power: c.power, powerUp: usedPU });
    return { id: seat, x: p.x, y: p.y, vx: Math.cos(a) * v0, vy: Math.sin(a) * v0, mass, drag, radius, off: false };
  });
  for (const b of bodies) if (freezeTargets.has(b.id)) { b.vx = 0; b.vy = 0; } // frozen pieces can't move this round

  const ballBody: Body = { id: -1, x: s.ball.x, y: s.ball.y, vx: s.ball.vx, vy: s.ball.vy, mass: B_MASS, drag: B_DRAG, radius: RB, off: false };
  const sim = simulate(bodies, ballBody, statics, s.powerUpsOnPitch);

  // bank pickups; remove taken items
  for (const pk of sim.pickups) { const p = s.pieces[pk.pieceId]; if (p) p.powerUps.push(pk.type); }
  if (sim.takenItems.length) s.powerUpsOnPitch = s.powerUpsOnPitch.filter((it) => !sim.takenItems.includes(it.id));

  // write back final piece positions (off pieces handled below)
  for (const b of bodies) { const p = s.pieces[b.id]!; if (!b.off) { p.x = +b.x.toFixed(4); p.y = +b.y.toFixed(4); } }
  s.ball = { x: +ballBody.x.toFixed(4), y: +ballBody.y.toFixed(4), vx: 0, vy: 0 };

  s.lastResolution = {
    frames: sim.frames, reveal, goal: sim.goal,
    walls: statics.map((w) => ({ x: w.x, y: w.y, r: w.r })),
    pickups: sim.pickups.map((pk) => ({ pieceId: pk.pieceId, type: pk.type })),
    impacts: sim.impacts,
  };

  if (sim.goal) {
    s.score[sim.goal] += 1;
    log(s, `⚽ ${sim.goal.toUpperCase()} scores! ${s.score.red}–${s.score.blue}`);
    kickoff(s); // full reset (pieces, ball, power-ups)
    if (s.score.red >= s.goalsToWin || s.score.blue >= s.goalsToWin) s.pendingDone = true;
  } else {
    for (const seat of sim.offIds) { const p = s.pieces[seat]!; p.x = p.homeX; p.y = p.homeY; log(s, `${nameOf(s, seat)} slid off — back to position next round.`); }
  }

  s.phase = 'resolve';
  s.resolveDeadline = now + Math.min(6500, sim.frames.length * 26 + 900);
}

function kickoff(s: IFState) {
  for (const seat of s.order) { const p = s.pieces[seat]!; p.x = p.homeX; p.y = p.homeY; }
  s.ball = { x: 0, y: 0, vx: 0, vy: 0 };
  spawnPowerUps(s);
}

function spawnPowerUps(s: IFState) {
  // deterministic types from the round number (no per-client RNG)
  s.powerUpsOnPitch = SPAWN_SPOTS.map(([x, y], i) => ({ id: s.nextItemId++, type: ALL_POWERUPS[(s.round + i) % ALL_POWERUPS.length], x, y }));
}

function finishGame(s: IFState) {
  s.over = true;
  s.phase = 'done';
  const winTeam: Team = s.score.red >= s.score.blue ? 'red' : 'blue';
  s.winners = s.order.filter((seat) => s.pieces[seat]!.team === winTeam);
  log(s, `🏆 ${winTeam.toUpperCase()} wins ${s.score.red}–${s.score.blue}!`);
}

function startCommit(s: IFState, now: number) {
  s.round += 1;
  s.commitments = {};
  s.lastResolution = null;
  s.phase = 'commit';
  s.commitDeadline = now + s.timerSecs * 1000;
}

function commitMove(s: IFState, seat: number, msg: Record<string, unknown>, now: number): ActionResult {
  if (s.phase !== 'commit') return fail('Not the commit phase.');
  const p = s.pieces[seat];
  if (!p) return fail('You are not in this match.');
  if (s.commitments[seat]) return fail('You already committed this round.');
  let a = Number(msg.angle);
  if (!Number.isFinite(a)) return fail('Bad angle.');
  a = ((a % 360) + 360) % 360;
  const power = clamp(Number(msg.power) || 0, 0, 1);
  const c: Commit = { angle: a, power };
  const pu = msg.usePowerUp as { type?: string; targetId?: number } | undefined;
  if (pu && typeof pu.type === 'string') {
    if (!p.powerUps.includes(pu.type)) return fail("You don't have that power-up.");
    if (pu.type === 'freeze') {
      const tgt = Number(pu.targetId);
      if (!s.pieces[tgt] || s.pieces[tgt]!.team === p.team) return fail('Freeze needs an opponent target.');
      c.usePowerUp = { type: 'freeze', targetId: tgt };
    } else c.usePowerUp = { type: pu.type };
  }
  s.commitments[seat] = c;
  if (seated(s).every((x) => s.commitments[x])) resolveRound(s, now);
  return ok;
}

// ---------------------------------------------------------------------------
// GameDef
// ---------------------------------------------------------------------------

export const iceFootball: GameDef<IFState> = {
  id: 'ice-football',
  name: 'Ice Football',
  blurb: 'Team physics football on ice: secretly aim & power your player, all launch at once, kick the ball into their goal.',
  minPlayers: 2,
  maxPlayers: 8,
  options: [
    { key: 'goals', label: 'Goals to win', min: 1, max: 7, step: 1, default: 3 },
    { key: 'timer', label: 'Commit timer (s)', min: 10, max: 45, step: 5, default: 20 },
  ],

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): IFState {
    const order = [...setup.seats];
    const np = order.length;
    const half = Math.ceil(np / 2);
    const nameBySeat = new Map(setup.players.map((p) => [p.seat, p.name]));
    const pieces: (Piece | null)[] = new Array(MAX_SEATS).fill(null);
    const reds = order.slice(0, half), blues = order.slice(half);
    const place = (members: number[], team: Team) => {
      const m = members.length;
      members.forEach((seat, k) => {
        const x = (team === 'red' ? -0.5 : 0.5);
        const y = m === 1 ? 0 : (k / (m - 1) - 0.5) * 0.7;
        pieces[seat] = { name: nameBySeat.get(seat) ?? `Seat ${seat + 1}`, connected: true, team, x: +x.toFixed(4), y: +y.toFixed(4), homeX: +x.toFixed(4), homeY: +y.toFixed(4), powerUps: [] };
      });
    };
    place(reds, 'red');
    place(blues, 'blue');
    const timer = Math.round(clamp(setup.options?.timer ?? 20, 10, 45));
    const s: IFState = {
      pieces, order, ball: { x: 0, y: 0, vx: 0, vy: 0 },
      score: { red: 0, blue: 0 }, goalsToWin: Math.round(clamp(setup.options?.goals ?? 3, 1, 7)),
      phase: 'commit', round: 1, commitments: {}, powerUpsOnPitch: [], nextItemId: 1,
      commitDeadline: ctx.now + timer * 1000, resolveDeadline: 0, pendingDone: false, lastResolution: null,
      over: false, winners: [], timerSecs: timer, log: [],
    };
    spawnPowerUps(s);
    log(s, `Kickoff! First to ${s.goalsToWin} goals. Aim and commit.`);
    return s;
  },

  act(s, seat, msg, ctx) {
    if (s.over) return fail('The match is over.');
    if (msg.type === 'commitMove') return commitMove(s, seat, msg, ctx.now);
  },

  tick(s, ctx) {
    if (s.phase === 'commit' && ctx.now >= s.commitDeadline) {
      for (const seat of seated(s)) if (!s.commitments[seat]) s.commitments[seat] = { angle: 0, power: 0 };
      resolveRound(s, ctx.now);
      return true;
    }
    if (s.phase === 'resolve' && ctx.now >= s.resolveDeadline) {
      if (s.pendingDone) finishGame(s); else startCommit(s, ctx.now);
      return true;
    }
    return false;
  },

  onDisconnect(s, seat) { const p = s.pieces[seat]; if (p) p.connected = false; },
  onReconnect(s, seat) { const p = s.pieces[seat]; if (p) p.connected = true; },

  view(s, seat) {
    const me = seat !== null && s.pieces[seat] ? s.pieces[seat]! : null;
    const committed = (x: number) => !!s.commitments[x];
    const pieces = s.order.map((sx) => {
      const p = s.pieces[sx]!;
      return { seat: sx, name: p.name, team: p.team, connected: p.connected, x: p.x, y: p.y, committed: committed(sx) };
    });
    return {
      game: 'ice-football',
      phase: s.over ? 'done' : s.phase,
      over: s.over,
      round: s.round,
      score: s.score,
      goalsToWin: s.goalsToWin,
      pitch: { hx: HX, hy: HY, goalHy: GOAL_HY, rp: RP, rb: RB },
      pieces,
      ball: { x: s.ball.x, y: s.ball.y },
      items: s.powerUpsOnPitch.map((it) => ({ id: it.id, type: it.type, x: it.x, y: it.y })),
      timer: s.phase === 'commit' ? { secs: s.timerSecs, deadline: s.commitDeadline } : null,
      resolution: s.phase === 'resolve' ? s.lastResolution : null,
      winners: s.over ? s.winners : null,
      winningTeam: s.over ? (s.score.red >= s.score.blue ? 'red' : 'blue') : null,
      matchWinner: null,
      log: s.log.slice(-15),
      you: me
        ? {
            seat, team: me.team,
            isTurn: s.phase === 'commit' && !committed(seat!),
            committed: committed(seat!),
            commitment: s.commitments[seat!] || null,
            powerUps: me.powerUps.slice(), // your OWN banked power-ups
          }
        : { seat: seat ?? -1, spectator: true },
    };
  },

  result(s): GameOutcome {
    return { over: s.over, winners: s.over ? s.winners : [] };
  },

  bot(s, seat, ctx) {
    if (s.over || s.phase !== 'commit') return null;
    const me = s.pieces[seat];
    if (!me || s.commitments[seat]) return null;
    // aim at the ball, nudging it toward the opponent goal
    const goalX = me.team === 'red' ? HX : -HX;
    const aimX = s.ball.x + (goalX - s.ball.x) * 0.18;
    const dx = aimX - me.x, dy = s.ball.y - me.y;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI + (ctx.rng() * 14 - 7);
    const power = clamp(Math.hypot(dx, dy) / 1.8 + 0.12, 0.2, 0.6);
    return { type: 'commitMove', angle, power };
  },
};
