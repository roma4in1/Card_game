// games/penguin-knockout/game.ts — "Penguin Knockout", a simultaneous-commitment physics
// battle (2–8 players). Each round, every living penguin SECRETLY commits an aim angle +
// power; once everyone has (or the timer runs out) the server resolves ALL launches at once
// with deterministic 2D physics — friction, circle-circle collisions (chain reactions),
// and off-the-ice eliminations — then shrinks the platform. Last penguin standing wins,
// with knockout points along the way.
//
// HIDDEN INFO is only the current round's commitments (hidden during commit, fully public
// on resolution) — same simultaneous-reveal discipline as Win or Die. The server is the
// authoritative physics referee; the resolution ships per-tick frames so every client
// replays the exact same animation. No RNG in the physics → reproducible.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';

const MAX_SEATS = 8;

// --- physics constants (normalized: platform radius starts at 1.0, centred at 0,0) ---
const R0 = 1.0; // starting platform radius
const RING = 0.62; // starting placement ring
const RP = 0.075; // penguin radius
const VMAX = 0.155; // launch speed at power = 1 (per tick)
const DRAG = 0.86; // velocity retained per tick (friction)
const REST = 0.9; // collision restitution
const SHRINK = 0.86; // platform radius multiplier each round
const STOP = 0.0009; // speed below which a penguin is "stopped"
const MAX_TICKS = 240; // simulation safety cap
const KO_PTS = 1; // points per knockout
const SURV = 3; // sole-survivor bonus

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Penguin { name: string; connected: boolean; x: number; y: number; alive: boolean; knockouts: number; score: number; survived: boolean }
interface Commit { angle: number; power: number }
type Phase = 'commit' | 'resolve' | 'done';

interface Frame { id: number; x: number; y: number; a: boolean }
interface Impact { f: number; x: number; y: number; s: number } // collision flash: frame, position, strength
interface Resolution {
  radius: number; // platform radius during the motion
  radiusAfter: number; // after the shrink
  frames: Frame[][]; // penguin states per tick (the replay)
  reveal: { id: number; angle: number; power: number }[];
  knockouts: { by: number; victim: number }[];
  melted: number[]; // shrink-eliminated (no credit)
  impacts: Impact[]; // collision flashes for the replay
}

export interface PKState {
  penguins: (Penguin | null)[]; // by seat
  order: number[];
  radius: number;
  phase: Phase;
  round: number;
  commitments: Record<number, Commit>; // SECRET until resolution
  commitDeadline: number; // epoch-ms
  resolveDeadline: number; // epoch-ms
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
function log(s: PKState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: PKState, seat: number) => s.penguins[seat]!.name;
const livingSeats = (s: PKState) => s.order.filter((seat) => s.penguins[seat]?.alive);

// ---------------------------------------------------------------------------
// Deterministic physics — pure, no RNG, no I/O
// ---------------------------------------------------------------------------

interface SimBody { id: number; x: number; y: number; vx: number; vy: number; alive: boolean }

function simulate(bodies: SimBody[], radius: number): { frames: Frame[][]; elim: { id: number; by: number | null }[]; impacts: Impact[] } {
  const frames: Frame[][] = [];
  const lastHitBy: Record<number, number> = {};
  const elim: { id: number; by: number | null }[] = [];
  const impacts: Impact[] = [];
  const snap = () => frames.push(bodies.map((b) => ({ id: b.id, x: +b.x.toFixed(4), y: +b.y.toFixed(4), a: b.alive })));
  const stopped = () => bodies.every((b) => !b.alive || Math.hypot(b.vx, b.vy) < STOP);

  snap();
  for (let t = 0; t < MAX_TICKS; t++) {
    // Substep so a fast body can't tunnel through a collision in one step. The number of
    // substeps tracks the fastest body so movement per substep stays well under a radius.
    let maxV = 0;
    for (const b of bodies) if (b.alive) maxV = Math.max(maxV, Math.hypot(b.vx, b.vy));
    const sub = Math.max(1, Math.min(16, Math.ceil(maxV / (RP * 0.4))));
    for (let k = 0; k < sub; k++) {
      for (const b of bodies) if (b.alive) { b.x += b.vx / sub; b.y += b.vy / sub; }

      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < bodies.length; i++) {
          for (let j = i + 1; j < bodies.length; j++) {
            const a = bodies[i], b = bodies[j];
            if (!a.alive || !b.alive) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = Math.hypot(dx, dy);
            const min = 2 * RP;
            if (d <= 0 || d >= min) continue;
            const nx = dx / d, ny = dy / d;
            const overlap = (min - d) / 2; // positional correction
            a.x -= nx * overlap; a.y -= ny * overlap;
            b.x += nx * overlap; b.y += ny * overlap;
            const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny; // closing speed along the normal
            if (vn > 0) {
              const imp = ((1 + REST) / 2) * vn; // equal mass: swap normal components, scaled by restitution
              a.vx -= imp * nx; a.vy -= imp * ny;
              b.vx += imp * nx; b.vy += imp * ny;
              lastHitBy[a.id] = b.id;
              lastHitBy[b.id] = a.id;
              if (vn > 0.012 && impacts.length < 40) impacts.push({ f: frames.length, x: +((a.x + b.x) / 2).toFixed(3), y: +((a.y + b.y) / 2).toFixed(3), s: +Math.min(1, vn * 3).toFixed(2) });
            }
          }
        }
      }

      for (const b of bodies) {
        if (b.alive && Math.hypot(b.x, b.y) > radius) { // centre past the rim → off the ice
          b.alive = false;
          elim.push({ id: b.id, by: lastHitBy[b.id] ?? null });
        }
      }
    }

    for (const b of bodies) if (b.alive) { b.vx *= DRAG; b.vy *= DRAG; }
    snap();
    if (stopped()) break;
  }
  return { frames, elim, impacts };
}

// ---------------------------------------------------------------------------
// Round resolution
// ---------------------------------------------------------------------------

function resolveRound(s: PKState, now: number) {
  const live = livingSeats(s);
  const bodies: SimBody[] = live.map((seat) => {
    const p = s.penguins[seat]!;
    const c = s.commitments[seat] || { angle: 0, power: 0 };
    const v0 = clamp(c.power, 0, 1) * VMAX;
    const a = (c.angle * Math.PI) / 180;
    return { id: seat, x: p.x, y: p.y, vx: Math.cos(a) * v0, vy: Math.sin(a) * v0, alive: true };
  });

  const { frames, elim, impacts } = simulate(bodies, s.radius);

  for (const e of elim) {
    s.penguins[e.id]!.alive = false;
    if (e.by != null && s.penguins[e.by]) {
      s.penguins[e.by]!.knockouts += 1;
      log(s, `${nameOf(s, e.by)} knocked ${nameOf(s, e.id)} off the ice!`);
    } else {
      log(s, `${nameOf(s, e.id)} slid off the edge.`);
    }
  }
  for (const b of bodies) if (b.alive) { s.penguins[b.id]!.x = b.x; s.penguins[b.id]!.y = b.y; }

  // shrink — anyone now outside the smaller platform melts in (no credit)
  const radiusFrom = s.radius;
  s.radius = +(s.radius * SHRINK).toFixed(4);
  const melted: number[] = [];
  for (const seat of s.order) {
    const p = s.penguins[seat];
    if (p && p.alive && Math.hypot(p.x, p.y) > s.radius) { p.alive = false; melted.push(seat); log(s, `The ice melted under ${nameOf(s, seat)}.`); }
  }

  s.lastResolution = {
    radius: radiusFrom,
    radiusAfter: s.radius,
    frames,
    reveal: live.map((seat) => ({ id: seat, ...(s.commitments[seat] || { angle: 0, power: 0 }) })),
    knockouts: elim.filter((e) => e.by != null).map((e) => ({ by: e.by as number, victim: e.id })),
    melted,
    impacts,
  };

  s.phase = 'resolve';
  // Hold long enough for the (min 10s) interpolated replay + the shrink + a short beat,
  // scaling up a little for longer rounds. Keep client REPLAY_MS in app.js in sync.
  s.resolveDeadline = now + Math.min(13500, Math.max(11500, frames.length * 200 + 1500));
  s.pendingDone = livingSeats(s).length <= 1;
}

function finishGame(s: PKState) {
  s.over = true;
  s.phase = 'done';
  const alive = livingSeats(s);
  if (alive.length === 1) s.penguins[alive[0]]!.survived = true;
  let best = -Infinity;
  for (const seat of s.order) {
    const p = s.penguins[seat]!;
    p.score = p.knockouts * KO_PTS + (p.survived ? SURV : 0);
    best = Math.max(best, p.score);
  }
  s.winners = s.order.filter((seat) => s.penguins[seat]!.score === best);
  const names = s.winners.map((seat) => nameOf(s, seat)).join(' & ');
  log(s, `🏆 ${s.winners.length > 1 ? `Tie: ${names}` : `${names} wins`} (${best} pts).`);
}

function startCommit(s: PKState, now: number) {
  s.round += 1;
  s.commitments = {};
  s.lastResolution = null;
  s.phase = 'commit';
  s.commitDeadline = now + s.timerSecs * 1000;
  log(s, `Round ${s.round} — aim and commit!`);
}

function commitMove(s: PKState, seat: number, angle: unknown, power: unknown, now: number): ActionResult {
  if (s.phase !== 'commit') return fail('Not the commit phase.');
  const p = s.penguins[seat];
  if (!p || !p.alive) return fail('You are not in play.');
  if (s.commitments[seat]) return fail('You already committed this round.');
  let a = Number(angle);
  if (!Number.isFinite(a)) return fail('Bad angle.');
  a = ((a % 360) + 360) % 360;
  const pw = clamp(Number(power) || 0, 0, 1);
  s.commitments[seat] = { angle: a, power: pw };
  // resolve once every living penguin has locked in
  if (livingSeats(s).every((x) => s.commitments[x])) resolveRound(s, now);
  return ok;
}

// ---------------------------------------------------------------------------
// GameDef
// ---------------------------------------------------------------------------

export const penguinKnockout: GameDef<PKState> = {
  id: 'penguin-knockout',
  name: 'Penguin Knockout',
  blurb: 'Secretly aim & power up, then all penguins launch at once — physics chaos. Shove rivals off the shrinking ice.',
  minPlayers: 2,
  maxPlayers: 8,
  options: [{ key: 'timer', label: 'Commit timer (s)', min: 10, max: 45, step: 5, default: 20 }],

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): PKState {
    const order = [...setup.seats];
    const np = order.length;
    const penguins: (Penguin | null)[] = new Array(MAX_SEATS).fill(null);
    const nameBySeat = new Map(setup.players.map((p) => [p.seat, p.name]));
    order.forEach((seat, i) => {
      const ang = (2 * Math.PI * i) / np - Math.PI / 2;
      penguins[seat] = { name: nameBySeat.get(seat) ?? `Seat ${seat + 1}`, connected: true, x: +(Math.cos(ang) * RING).toFixed(4), y: +(Math.sin(ang) * RING).toFixed(4), alive: true, knockouts: 0, score: 0, survived: false };
    });
    const s: PKState = {
      penguins, order, radius: R0, phase: 'commit', round: 1, commitments: {},
      commitDeadline: ctx.now + Math.round(clamp(setup.options?.timer ?? 20, 10, 45)) * 1000,
      resolveDeadline: 0, pendingDone: false, lastResolution: null, over: false, winners: [],
      timerSecs: Math.round(clamp(setup.options?.timer ?? 20, 10, 45)), log: [],
    };
    log(s, `${np} penguins on the ice. Round 1 — aim and commit!`);
    return s;
  },

  act(s, seat, msg, ctx) {
    if (s.over) return fail('The match is over.');
    if (msg.type === 'commitMove') return commitMove(s, seat, msg.angle, msg.power, ctx.now);
  },

  tick(s, ctx) {
    if (s.phase === 'commit' && ctx.now >= s.commitDeadline) {
      for (const seat of livingSeats(s)) if (!s.commitments[seat]) s.commitments[seat] = { angle: 0, power: 0 };
      resolveRound(s, ctx.now);
      return true;
    }
    if (s.phase === 'resolve' && ctx.now >= s.resolveDeadline) {
      if (s.pendingDone) finishGame(s);
      else startCommit(s, ctx.now);
      return true;
    }
    return false;
  },

  onDisconnect(s, seat) { const p = s.penguins[seat]; if (p) p.connected = false; },
  onReconnect(s, seat) { const p = s.penguins[seat]; if (p) p.connected = true; },

  view(s, seat) {
    const me = seat !== null && s.penguins[seat] ? s.penguins[seat]! : null;
    const committed = (x: number) => !!s.commitments[x];
    const penguins = s.order.map((sx) => {
      const p = s.penguins[sx]!;
      return { seat: sx, name: p.name, connected: p.connected, x: p.x, y: p.y, alive: p.alive, knockouts: p.knockouts, score: p.score, committed: committed(sx) };
    });
    return {
      game: 'penguin-knockout',
      phase: s.over ? 'done' : s.phase,
      over: s.over,
      round: s.round,
      radius: s.radius,
      penguins,
      penguinRadius: RP,
      // reuse the shared countdown chip during commit
      timer: s.phase === 'commit' ? { secs: s.timerSecs, deadline: s.commitDeadline } : null,
      // the public replay + simultaneous reveal — only on resolution
      resolution: s.phase === 'resolve' ? s.lastResolution : null,
      winners: s.over ? s.winners : null,
      matchWinner: null,
      log: s.log.slice(-15),
      you: me
        ? {
            seat,
            alive: me.alive,
            // a living penguin that hasn't locked in still has to act
            isTurn: s.phase === 'commit' && me.alive && !committed(seat!),
            committed: committed(seat!),
            commitment: s.commitments[seat!] || null, // your OWN move only
          }
        : { seat: seat ?? -1, spectator: true },
    };
  },

  result(s): GameOutcome {
    return { over: s.over, winners: s.over ? s.winners : [] };
  },

  bot(s, seat, ctx) {
    if (s.over || s.phase !== 'commit') return null;
    const me = s.penguins[seat];
    if (!me || !me.alive || s.commitments[seat]) return null;
    // aim at the nearest rival, power roughly enough to reach them (capped so we don't fly off)
    let best: Penguin | null = null;
    let bestD = Infinity;
    for (const other of livingSeats(s)) {
      if (other === seat) continue;
      const o = s.penguins[other]!;
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best) return { type: 'commitMove', angle: 0, power: 0 };
    const angle = (Math.atan2(best.y - me.y, best.x - me.x) * 180) / Math.PI + (ctx.rng() * 16 - 8);
    const power = clamp(bestD / 2.0 + 0.08, 0.18, 0.55);
    return { type: 'commitMove', angle, power };
  },
};
