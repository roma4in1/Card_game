// game.test.ts — Penguin Knockout. The physics is the bug-prone part, so we pin down
// commit secrecy, determinism, self-slide, knockout attribution, multi-bounce chains,
// shrink elimination, scoring, and end conditions. Positions are set directly to make
// the (RNG-free) simulation scenarios exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { penguinKnockout as def, type PKState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const ctx = (now = 0): GameContext => ({ rng: () => 0.5, now });

function newPK(np: number, timer = 20) {
  const seats = Array.from({ length: np }, (_, i) => i);
  const players = seats.map((s) => ({ seat: s, name: 'P' + s }));
  return def.create({ seats, players, options: { timer } }, ctx()) as PKState;
}
const put = (s: PKState, seat: number, x: number, y: number) => { s.penguins[seat]!.x = x; s.penguins[seat]!.y = y; };
const commit = (s: PKState, seat: number, angle: number, power: number, now = 0) => def.act(s, seat, { type: 'commitMove', angle, power }, ctx(now)) ?? {};
const pen = (s: PKState, seat: number) => s.penguins[seat]!;
// after a round resolves the game sits in 'resolve' (animating); advance to 'done'/next
const finish = (s: PKState) => def.tick!(s, ctx(s.resolveDeadline + 1));

test('commit secrecy: others see only a committed tick, never your angle/power', () => {
  const s = newPK(3);
  commit(s, 0, 137, 0.731);
  assert.equal(s.phase, 'commit', 'one of three committed — not resolved yet');
  const vb = def.view(s, 1) as any;
  const pa = vb.penguins.find((p: any) => p.seat === 0);
  assert.equal(pa.committed, true);
  assert.ok(!('angle' in pa) && !('power' in pa), 'no commitment values leak in the roster');
  assert.equal(vb.you.commitment, null, 'I only ever see my own commitment');
  const va = def.view(s, 0) as any;
  assert.equal(va.you.commitment.angle, 137, 'you see your own move');
});

test('physics is deterministic: same setup + commitments → identical resolution', () => {
  const run = () => {
    const s = newPK(3);
    commit(s, 0, 0, 0.5);
    commit(s, 1, 90, 0.5);
    commit(s, 2, 200, 0.5); // third commit triggers resolution
    return s.lastResolution;
  };
  assert.equal(s_json(run()), s_json(run()));
});
function s_json(r: unknown) { return JSON.stringify(r); }

test('high power past the edge eliminates YOURSELF — no credit', () => {
  const s = newPK(2);
  put(s, 0, 0.8, 0); // near +x edge
  put(s, 1, -0.8, 0);
  commit(s, 0, 0, 0.95); // launch straight off the +x edge
  commit(s, 1, 90, 0); // stay put
  assert.equal(pen(s, 0).alive, false, 'penguin 0 slid off');
  assert.equal(pen(s, 1).alive, true);
  assert.equal(s.lastResolution!.knockouts.length, 0, 'no one is credited for a self-miss');
  finish(s);
  assert.equal(s.over, true);
  assert.equal(pen(s, 1).survived, true);
  assert.deepEqual(def.result(s).winners, [1]);
});

test('knockout attribution: shoving B off the ice credits A (+ scoring)', () => {
  const s = newPK(2);
  put(s, 0, 0, 0); // A at centre
  put(s, 1, 0.5, 0); // B to the right
  commit(s, 1, 90, 0); // B stays
  commit(s, 0, 0, 0.85); // A drives +x into B
  assert.equal(pen(s, 1).alive, false, 'B was knocked off');
  assert.equal(pen(s, 0).alive, true);
  assert.equal(pen(s, 0).knockouts, 1);
  assert.deepEqual(s.lastResolution!.knockouts, [{ by: 0, victim: 1 }]);
  finish(s);
  assert.equal(s.over, true);
  assert.equal(pen(s, 0).score, 1 * 1 + 3, 'knockout + survival bonus');
  assert.deepEqual(def.result(s).winners, [0]);
});

test('multi-bounce: a chain hit (A→B→C) credits the last impactor for C', () => {
  const s = newPK(3);
  put(s, 0, 0, 0);
  put(s, 1, 0.32, 0);
  put(s, 2, 0.64, 0);
  commit(s, 0, 0, 0.95); // A barrels +x into the line
  commit(s, 1, 90, 0);
  commit(s, 2, 90, 0);
  assert.equal(pen(s, 2).alive, false, 'C flew off the end of the chain');
  assert.ok(s.lastResolution!.knockouts.some((k) => k.by === 1 && k.victim === 2), 'B (not A) gets the C knockout — it was the last to hit C');
});

test('shrink elimination: a penguin outside the smaller platform melts (no credit)', () => {
  const s = newPK(2);
  put(s, 0, 0.9, 0); // survives the round but is outside radius*0.86 = 0.86
  put(s, 1, -0.4, 0);
  commit(s, 0, 0, 0); // nobody moves
  commit(s, 1, 0, 0);
  assert.equal(pen(s, 0).alive, false, '0 melted on the shrink');
  assert.ok(s.lastResolution!.melted.includes(0));
  assert.equal(s.lastResolution!.knockouts.length, 0, 'shrink gives no knockout credit');
  assert.equal(pen(s, 1).alive, true);
  finish(s);
  assert.equal(s.over, true);
});

test('the commit timer auto-defaults stragglers and resolves the round', () => {
  const s = newPK(2, 20);
  assert.equal(def.tick!(s, ctx(19000)), false, 'no resolution before the deadline');
  assert.equal(s.phase, 'commit');
  assert.equal(def.tick!(s, ctx(21000)), true, 'deadline → resolve');
  assert.equal(s.phase, 'resolve');
  assert.ok(s.lastResolution, 'a resolution (with replay frames) was produced');
  assert.ok(Array.isArray(s.lastResolution!.frames) && s.lastResolution!.frames.length > 0);
});
