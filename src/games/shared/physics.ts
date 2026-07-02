// games/shared/physics.ts — the deterministic 2D arena engine shared by the ice games
// (Penguin Knockout, Ice Football). Bodies slide with per-body drag, collide as circles
// with mass-weighted impulses, and optionally bounce off static circle blockers. Pure and
// RNG-free: given the same bodies and rules, every run produces the identical trajectory,
// which is what lets the server ship per-tick frames that all clients replay in lockstep.
//
// The engine owns motion and collisions only. Everything a game disagrees about —
// boundaries (a shrinking square rim vs. walls with goal gaps), eliminations, goals,
// pickups — lives in the game's `onSubstep` hook, which runs after each collision pass
// and may end the simulation early (e.g. a goal). Frames are recorded by the game in its
// own format via `onSnap`, called once at the start and once per tick.

export interface SimBody {
  id: number;
  x: number; y: number;
  vx: number; vy: number;
  mass: number;
  drag: number; // velocity retained per tick
  radius: number;
  out: boolean; // out of play: skipped by integration, collisions, drag and the stop check
}

export interface StaticCircle { x: number; y: number; r: number }

/** Collision flash for the client replay: frame index, position, strength 0→1. */
export interface Impact { f: number; x: number; y: number; s: number }

export interface SimContext {
  bodies: SimBody[];
  /** Index of the frame the CURRENT tick will record (impacts use the same numbering). */
  frame: number;
  /** Last dynamic body to touch each body — the games use it to credit knockouts. */
  lastHitBy: Record<number, number>;
}

export interface SimRules {
  restitution: number;
  /** Max travel per substep; the tick splits into substeps so fast bodies can't tunnel. */
  substepLen: number;
  maxSubsteps: number;
  maxTicks: number;
  stopSpeed: number; // speed below which a body counts as stopped
  statics?: StaticCircle[];
  /** Game rules, run each substep after collisions. Return true to end the sim now. */
  onSubstep?(ctx: SimContext): boolean | void;
  /** Record one frame in the game's own format (called once up front, then per tick). */
  onSnap(ctx: SimContext): void;
}

// Impact flashes are cosmetic; cap them and skip soft touches so replays stay lean.
const IMPACT_MIN_SPEED = 0.012;
const IMPACT_MAX = 40;

/** Two live circles: positional correction + impulse, both weighted by mass. */
function collidePair(a: SimBody, b: SimBody, restitution: number, ctx: SimContext, impacts: Impact[]) {
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
    const j = ((1 + restitution) * closing) / (1 / a.mass + 1 / b.mass);
    a.vx -= (j / a.mass) * nx; a.vy -= (j / a.mass) * ny;
    b.vx += (j / b.mass) * nx; b.vy += (j / b.mass) * ny;
    ctx.lastHitBy[a.id] = b.id;
    ctx.lastHitBy[b.id] = a.id;
    if (closing > IMPACT_MIN_SPEED && impacts.length < IMPACT_MAX) {
      impacts.push({ f: ctx.frame, x: +((a.x + b.x) / 2).toFixed(3), y: +((a.y + b.y) / 2).toFixed(3), s: +Math.min(1, closing * 3).toFixed(2) });
    }
  }
}

/** A live circle against an immovable blocker: push out + reflect. */
function collideStatic(d: SimBody, st: StaticCircle, restitution: number) {
  const dx = d.x - st.x, dy = d.y - st.y;
  const dist = Math.hypot(dx, dy);
  const min = d.radius + st.r;
  if (dist <= 0 || dist >= min) return;
  const nx = dx / dist, ny = dy / dist;
  d.x += nx * (min - dist); d.y += ny * (min - dist);
  const vn = d.vx * nx + d.vy * ny;
  if (vn < 0) { d.vx -= (1 + restitution) * vn * nx; d.vy -= (1 + restitution) * vn * ny; }
}

/**
 * Run the simulation to rest (or `maxTicks`, or an early end from `onSubstep`).
 * Mutates `bodies` in place; the caller reads final positions off its own references.
 */
export function simulate(bodies: SimBody[], rules: SimRules): { impacts: Impact[]; lastHitBy: Record<number, number> } {
  const impacts: Impact[] = [];
  const statics = rules.statics || [];
  const ctx: SimContext = { bodies, frame: 0, lastHitBy: {} };

  rules.onSnap(ctx);
  let ended = false;
  for (let t = 0; t < rules.maxTicks && !ended; t++) {
    ctx.frame = t + 1;
    // Substep so a fast body can't tunnel through a collision in one step. The number of
    // substeps tracks the fastest body so movement per substep stays well under a radius.
    let maxV = 0;
    for (const b of bodies) if (!b.out) maxV = Math.max(maxV, Math.hypot(b.vx, b.vy));
    const sub = Math.max(1, Math.min(rules.maxSubsteps, Math.ceil(maxV / rules.substepLen)));
    for (let k = 0; k < sub && !ended; k++) {
      for (const b of bodies) if (!b.out) { b.x += b.vx / sub; b.y += b.vy / sub; }

      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < bodies.length; i++) {
          for (let j = i + 1; j < bodies.length; j++) {
            if (bodies[i].out || bodies[j].out) continue;
            collidePair(bodies[i], bodies[j], rules.restitution, ctx, impacts);
          }
        }
        if (statics.length) for (const d of bodies) if (!d.out) for (const st of statics) collideStatic(d, st, rules.restitution);
      }

      if (rules.onSubstep && rules.onSubstep(ctx) === true) ended = true;
    }

    for (const b of bodies) if (!b.out) { b.vx *= b.drag; b.vy *= b.drag; }
    rules.onSnap(ctx);
    if (!ended && bodies.every((b) => b.out || Math.hypot(b.vx, b.vy) < rules.stopSpeed)) break;
  }
  return { impacts, lastHitBy: ctx.lastHitBy };
}
