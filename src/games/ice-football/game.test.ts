// game.test.ts — Ice Football. Pins down commit secrecy, determinism, the ball "kick"
// (lighter/slicker than a piece), goal detection, power-ups (pickup/freeze/powerShot/wall),
// the selective boundary (ball bounces, pieces fall off), off-pitch respawn, ball
// containment, and the win condition. Positions/ball are set directly for exact scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iceFootball as def, type IFState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const ctx = (now = 0): GameContext => ({ rng: () => 0.5, now });

function newIF(np: number, opts: Record<string, number> = {}) {
  const seats = Array.from({ length: np }, (_, i) => i);
  const players = seats.map((s) => ({ seat: s, name: 'P' + s }));
  return def.create({ seats, players, options: { goals: 3, timer: 20, ...opts } }, ctx()) as IFState;
}
const put = (s: IFState, seat: number, x: number, y: number) => { const p = s.pieces[seat]!; p.x = x; p.y = y; };
const ball = (s: IFState, x: number, y: number) => { s.ball = { x, y, vx: 0, vy: 0 }; };
const commit = (s: IFState, seat: number, angle: number, power: number, usePowerUp?: any, now = 0) => def.act(s, seat, { type: 'commitMove', angle, power, usePowerUp }, ctx(now)) ?? {};
const pc = (s: IFState, seat: number) => s.pieces[seat]!;
const finish = (s: IFState) => def.tick!(s, ctx(s.resolveDeadline + 1));
const maxBallX = (s: IFState) => Math.max(...s.lastResolution!.frames.map((f) => f.b.x));
const maxPieceX = (s: IFState, id: number) => Math.max(...s.lastResolution!.frames.map((f) => f.p.find((p) => p.id === id)!.x));

test('commit secrecy: others see only a committed tick', () => {
  const s = newIF(2);
  commit(s, 0, 137, 0.7);
  assert.equal(s.phase, 'commit', 'one of two committed — not resolved');
  const vb = def.view(s, 1) as any;
  const pa = vb.pieces.find((p: any) => p.seat === 0);
  assert.equal(pa.committed, true);
  assert.ok(!('angle' in pa) && !('power' in pa));
  assert.equal(vb.you.commitment, null);
  assert.equal((def.view(s, 0) as any).you.commitment.angle, 137);
});

test('physics is deterministic: same setup + commitments → identical resolution', () => {
  const run = () => { const s = newIF(2); put(s, 0, -0.2, 0.1); ball(s, 0, 0.1); commit(s, 0, 10, 0.5); commit(s, 1, 200, 0.3); return s.lastResolution; };
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});

test('a kicked ball carries farther than the piece that hit it (lighter + slicker)', () => {
  const s = newIF(2);
  put(s, 0, -0.25, 0.4); ball(s, 0, 0.4); put(s, 1, 0.5, -0.5); // above the goal gap, blue out of the lane
  commit(s, 1, 0, 0); commit(s, 0, 0, 0.6);
  assert.equal(s.lastResolution!.goal, null, 'y=0.4 is above the goal mouth — no goal');
  assert.ok(maxBallX(s) > 0.55, 'the ball travelled well downfield');
  assert.ok(maxBallX(s) > maxPieceX(s, 0), 'the ball outran the kicking piece');
});

test('goal detection: ball into the opponent goal scores and resets', () => {
  const s = newIF(2);
  put(s, 0, -0.2, 0); ball(s, 0, 0); put(s, 1, 0.5, 0.5); // clear the lane
  commit(s, 1, 0, 0); commit(s, 0, 0, 0.6);
  assert.equal(s.lastResolution!.goal, 'red');
  assert.equal(s.score.red, 1);
  assert.deepEqual(s.ball, { x: 0, y: 0, vx: 0, vy: 0 }, 'ball reset to centre');
  assert.equal(s.over, false);
});

test('selective boundary: the ball BOUNCES off the perimeter (stays in play, no goal)', () => {
  const s = newIF(2);
  put(s, 0, -0.15, 0.45); ball(s, 0, 0.45); put(s, 1, 0.5, -0.5);
  commit(s, 1, 0, 0); commit(s, 0, 0, 0.7); // drive the ball into the +x wall above the goal gap
  assert.equal(s.lastResolution!.goal, null, 'hit the wall, not the gap');
  assert.ok(s.lastResolution!.frames.every((f) => f.b.x <= 1.0 + 1e-6), 'ball never leaves the pitch');
  assert.ok(maxBallX(s) > 0.5, 'it did reach the wall');
});

test('selective boundary: a PIECE slides through the perimeter and respawns (not eliminated)', () => {
  const s = newIF(2);
  put(s, 0, -0.5, 0.45); ball(s, 0, -0.5); put(s, 1, 0.5, 0); // ball tucked away
  commit(s, 1, 0, 0); commit(s, 0, 90, 0.95); // launch up and off the top edge
  assert.ok(s.lastResolution!.frames.some((f) => f.p.find((p) => p.id === 0)!.o), 'piece went off the pitch');
  assert.equal(pc(s, 0).x, pc(s, 0).homeX, 'respawned to home x');
  assert.equal(pc(s, 0).y, pc(s, 0).homeY, 'respawned to home y');
  assert.ok(s.pieces[0], 'still in the match (football, not knockout)');
});

test('power-up pickup banks the item; freeze zeroes an opponent and is consumed', () => {
  // pickup
  let s = newIF(2);
  s.powerUpsOnPitch = [{ id: 99, type: 'powerShot', x: 0.1, y: 0 }];
  put(s, 0, -0.2, 0); ball(s, 0, 0.5); put(s, 1, 0.5, 0.5);
  commit(s, 1, 0, 0); commit(s, 0, 0, 0.4);
  assert.ok(pc(s, 0).powerUps.includes('powerShot'), 'piece banked the power-up');
  assert.equal(s.powerUpsOnPitch.length, 0, 'item removed from the pitch');

  // freeze: blue commits a big move but is frozen by red → it doesn't move, freeze consumed
  s = newIF(2);
  s.powerUpsOnPitch = []; // clear spawned pickups so nothing else is banked mid-sim
  put(s, 0, -0.5, 0); put(s, 1, 0.5, 0); ball(s, 0, 0.5);
  pc(s, 0).powerUps = ['freeze'];
  commit(s, 1, 180, 0.8); // blue would charge left…
  commit(s, 0, 0, 0, { type: 'freeze', targetId: 1 }); // …but red freezes it
  assert.ok(Math.abs(pc(s, 1).x - 0.5) < 0.02, 'frozen blue did not move');
  assert.deepEqual(pc(s, 0).powerUps, [], 'freeze was consumed');
});

test('power-up: a power shot launches farther; a wall blocker is placed and blocks a goal', () => {
  const far = (usePU: boolean) => {
    const s = newIF(2);
    put(s, 0, -0.5, 0); ball(s, 0, 0.55); put(s, 1, 0.5, 0.5);
    if (usePU) pc(s, 0).powerUps = ['powerShot'];
    commit(s, 1, 0, 0);
    commit(s, 0, 0, 0.3, usePU ? { type: 'powerShot' } : undefined);
    return maxPieceX(s, 0);
  };
  assert.ok(far(true) > far(false) + 0.2, 'power shot travels noticeably farther');

  // wall: blue drives the ball at red's goal; red drops a wall → no goal, blocker recorded
  const s = newIF(2);
  put(s, 1, 0.2, 0); ball(s, 0, 0); put(s, 0, -0.95, 0.5); // red defender out of the lane
  pc(s, 0).powerUps = ['wall'];
  commit(s, 0, 0, 0, { type: 'wall' });
  commit(s, 1, 180, 0.7); // blue blasts the ball toward red's goal (-x)
  assert.equal(s.lastResolution!.walls.length, 1, 'a blocker was placed');
  assert.equal(s.lastResolution!.goal, null, 'the wall blocked the shot');
});

test('win: first team to N goals wins; all its players win', () => {
  const s = newIF(4, { goals: 1 }); // 2v2, first to 1
  // red seat 0 taps the ball straight in
  put(s, 0, -0.2, 0); ball(s, 0, 0);
  put(s, 1, 0.5, 0.5); put(s, 2, -0.5, 0.5); put(s, 3, 0.5, -0.5); // clear the lane
  for (const seat of [1, 2, 3]) commit(s, seat, 0, 0);
  commit(s, 0, 0, 0.6);
  assert.equal(s.score.red, 1);
  finish(s); // resolve → done
  assert.equal(s.over, true);
  const reds = s.order.filter((seat) => s.pieces[seat]!.team === 'red');
  assert.deepEqual(def.result(s).winners.slice().sort((a, b) => a - b), reds.sort((a, b) => a - b));
});
