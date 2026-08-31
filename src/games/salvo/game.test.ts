// game.test.ts — Salvo. The fleet is the only secret in the game, so most of this file
// is about what `view` refuses to send. The rest: placement, the fire-again-on-hit rule,
// and a bot that must hunt without peeking at the board it is shooting into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salvo, FLEET, type SVState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

// A seeded rng, so a "random" fleet is varied but reproducible across a test.
function seeded(seed: number) {
  let a = seed;
  return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
}

const def = salvo;
const setup = { seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] };
// A real (seeded) rng by default: a constant one would hand every ship the same square.
const mkCtx = (rng: () => number = seeded(20260831)): GameContext & { now: number } => ({ rng, now: 1000 });
const act = (s: SVState, seat: number, msg: Record<string, unknown>, ctx: GameContext) => def.act(s, seat, msg, ctx) ?? {};
const view = (s: SVState, seat: number | null) => def.view(s, seat) as any;

/** A match with hand-placed fleets, both sides at sea and A to fire. */
function mk(fleetA: [string, number, number, number, boolean][], fleetB: typeof fleetA): { s: SVState; ctx: GameContext & { now: number } } {
  const ctx = mkCtx();
  const s = def.create(setup, ctx) as SVState;
  const build = (spec: typeof fleetA) => spec.map(([name, size, x, y, horiz]) => ({ name, size, x, y, horiz, hits: 0 }));
  s.fleets = [build(fleetA), build(fleetB)];
  s.ready = [true, true];
  s.phase = 'play';
  return { s, ctx };
}
// A tiny stand-in fleet: one 2-cell Destroyer, so a match is over in two hits.
const oneShip = (x: number, y: number): [string, number, number, number, boolean][] => [['Destroyer', 2, x, y, true]];

// ---------------------------------------------------------------------------
// The secret: an enemy ship you have not found is not in your payload
// ---------------------------------------------------------------------------

test('an unsunk enemy ship is absent from your view, wherever it sits', () => {
  // Two worlds identical but for where B's fleet lies. A has fired nowhere near either,
  // so A's view must not be able to tell the worlds apart.
  const worlds = [oneShip(5, 5), oneShip(2, 7)].map((fleetB) => {
    const { s, ctx } = mk(oneShip(0, 0), fleetB);
    act(s, 0, { type: 'fire', x: 7, y: 0 }, ctx); // a miss, far from both placements
    return view(s, 0);
  });
  assert.deepEqual(worlds[0], worlds[1], 'A cannot tell where B’s ship is');
  assert.equal(worlds[0].you.enemy.every((c: any) => c.sunk === null), true, 'no enemy ship outline is sent');
  assert.equal(worlds[0].you.enemy.filter((c: any) => c.shot !== null).length, 1, 'only the square A actually fired at is marked');
});

test('you see your own waters in full, including where you have been hit', () => {
  const { s, ctx } = mk(oneShip(0, 0), oneShip(5, 5));
  s.turn = 1;
  act(s, 1, { type: 'fire', x: 0, y: 0 }, ctx); // B hits A's destroyer
  const mine = view(s, 0).you.own;
  const at = (x: number, y: number) => mine.find((c: any) => c.x === x && c.y === y);
  assert.equal(at(0, 0).ship, 'Destroyer', 'your own ship is yours to see');
  assert.equal(at(0, 0).shot, 'hit', 'and so is the damage');
  assert.equal(at(1, 0).ship, 'Destroyer');
  assert.equal(at(1, 0).shot, null, 'the untouched half is undamaged');
  assert.equal(at(4, 4).ship, null, 'empty water is empty');
});

test('a sunk ship is revealed to its killer, and both fleets open up once it is over', () => {
  const { s, ctx } = mk(oneShip(0, 0), oneShip(5, 5));
  act(s, 0, { type: 'fire', x: 5, y: 5 }, ctx);
  assert.equal(view(s, 0).you.enemy.filter((c: any) => c.sunk).length, 0, 'a wounded ship is still not outlined');
  act(s, 0, { type: 'fire', x: 6, y: 5 }, ctx); // sinks it — and ends the match
  const shown = view(s, 0).you.enemy.filter((c: any) => c.sunk);
  assert.equal(shown.length, 2, 'the sunk ship is drawn in');
  assert.deepEqual(shown.map((c: any) => c.sunk), ['Destroyer', 'Destroyer']);
});

test('a spectator is told nothing about either fleet', () => {
  // Same two-worlds check from the sideline: move BOTH fleets and the spectator's payload
  // must not budge. (The roster of ship names and sizes is public — it's the same five
  // ships every game — so it's placement, not the word "Destroyer", that has to be absent.)
  const specs = [
    [oneShip(0, 0), oneShip(5, 5)],
    [oneShip(3, 2), oneShip(1, 6)],
  ].map(([a, b]) => view(mk(a, b).s, null));
  assert.deepEqual(specs[0], specs[1], 'the sideline cannot see either fleet move');
  assert.equal(specs[0].you.spectator, true);
  assert.deepEqual(specs[0].you.own, []);
  assert.deepEqual(specs[0].you.enemy, []);
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test('the dealt fleet is always legal: every ship on the board, none overlapping', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const s = def.create(setup, mkCtx(seeded(seed * 977))) as SVState;
    for (const fleet of s.fleets) {
      assert.deepEqual(fleet.map((sh) => sh.name).sort(), FLEET.map((f) => f.name).sort(), 'the whole fleet is dealt');
      const taken = new Set<string>();
      for (const sh of fleet) {
        for (let i = 0; i < sh.size; i++) {
          const x = sh.horiz ? sh.x + i : sh.x;
          const y = sh.horiz ? sh.y : sh.y + i;
          assert.ok(x >= 0 && y >= 0 && x < s.size && y < s.size, `${sh.name} runs off the board`);
          assert.equal(taken.has(`${x},${y}`), false, `${sh.name} overlaps another ship`);
          taken.add(`${x},${y}`);
        }
      }
    }
  }
});

test('shuffling rerolls your fleet until you give the order, then it is locked', () => {
  const ctx = mkCtx(seeded(5));
  const s = def.create(setup, ctx) as SVState;
  const before = JSON.stringify(s.fleets[0]);
  const theirs = JSON.stringify(s.fleets[1]);
  act(s, 0, { type: 'shuffleFleet' }, ctx);
  assert.notEqual(JSON.stringify(s.fleets[0]), before, 'a shuffle moves your ships');
  assert.equal(JSON.stringify(s.fleets[1]), theirs, 'and never touches theirs');

  assert.equal(act(s, 0, { type: 'ready' }, ctx).error, undefined);
  assert.match(act(s, 0, { type: 'shuffleFleet' }, ctx).error!, /already given the order/);
  assert.match(act(s, 0, { type: 'fire', x: 0, y: 0 }, ctx).error!, /must be at sea/);
  assert.equal(s.phase, 'place', 'still waiting on B');
  act(s, 1, { type: 'ready' }, ctx);
  assert.equal(s.phase, 'play', 'both ready → guns out');
});

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

test('a hit fires again, a miss hands over the initiative', () => {
  const { s, ctx } = mk(oneShip(0, 0), [['Cruiser', 3, 4, 4, true]]);
  act(s, 0, { type: 'fire', x: 4, y: 4 }, ctx);
  assert.equal(s.last!.result, 'hit');
  assert.equal(s.turn, 0, 'a hit keeps the guns with A');
  act(s, 0, { type: 'fire', x: 0, y: 7 }, ctx);
  assert.equal(s.last!.result, 'miss');
  assert.equal(s.turn, 1, 'a miss passes the turn');
  assert.match(act(s, 0, { type: 'fire', x: 1, y: 7 }, ctx).error!, /Not your turn/);
});

test('a square cannot be fired at twice, or off the grid', () => {
  const { s, ctx } = mk(oneShip(0, 0), oneShip(5, 5));
  act(s, 0, { type: 'fire', x: 5, y: 5 }, ctx); // hit → A fires again
  assert.match(act(s, 0, { type: 'fire', x: 5, y: 5 }, ctx).error!, /already fired/);
  assert.match(act(s, 0, { type: 'fire', x: 8, y: 0 }, ctx).error!, /off the grid/);
  assert.match(act(s, 0, { type: 'fire', x: -1, y: 0 }, ctx).error!, /off the grid/);
  assert.match(act(s, 0, { type: 'fire', x: 1.5, y: 0 }, ctx).error!, /off the grid/);
  assert.match(act(s, 5, { type: 'fire', x: 1, y: 1 }, ctx).error!, /not in this match/);
});

test('sinking the last ship ends it', () => {
  const { s, ctx } = mk(oneShip(0, 0), oneShip(5, 5));
  act(s, 0, { type: 'fire', x: 5, y: 5 }, ctx);
  assert.equal(s.over, false, 'one hit is not a sinking');
  act(s, 0, { type: 'fire', x: 6, y: 5 }, ctx);
  assert.equal(s.over, true);
  assert.deepEqual(def.result(s).winners, [0]);
  assert.match(s.log.join(' '), /Destroyer sunk/);
  assert.match(act(s, 0, { type: 'fire', x: 1, y: 1 }, ctx).error!, /game is over/);
  assert.equal(view(s, 1).you.enemy.filter((c: any) => c.sunk).length, 2, 'the loser gets to see it all afterwards');
});

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

test('the bot readies up, then finishes a ship it has wounded', () => {
  const ctx = mkCtx(seeded(11));
  const s = def.create(setup, ctx) as SVState;
  assert.deepEqual(def.bot!(s, 1, ctx), { type: 'ready' }, 'it accepts the fleet it was dealt');
  act(s, 1, { type: 'ready' }, ctx);
  assert.equal(def.bot!(s, 1, ctx), null, 'and then waits');

  const built = mk(oneShip(0, 0), [['Cruiser', 3, 4, 4, true]]);
  built.s.turn = 1;
  built.s.shots[1][0 * built.s.size + 3] = 'hit'; // B has wounded something at (3,0)
  const mv = def.bot!(built.s, 1, built.ctx) as any;
  const adjacent = [[2, 0], [4, 0], [3, 1]];
  assert.ok(adjacent.some(([x, y]) => mv.x === x && mv.y === y), `expected a follow-up shot next to (3,0), got ${mv.x},${mv.y}`);
});

test('the bot only ever fires at squares it has not tried', () => {
  const rng = seeded(3);
  const ctx = mkCtx(rng);
  const s = def.create(setup, ctx) as SVState;
  act(s, 0, { type: 'ready' }, ctx);
  act(s, 1, { type: 'ready' }, ctx);
  for (let guard = 0; guard < 400 && !s.over; guard++) {
    const seat = s.order[s.turn];
    const mv = def.bot!(s, seat, ctx) as any;
    assert.ok(mv, 'a bot on turn always has a shot');
    assert.equal(s.shots[s.turn][mv.y * s.size + mv.x], null, 'never fires into a square it has already tried');
    assert.equal(act(s, seat, mv, ctx).error, undefined, JSON.stringify(mv));
  }
  assert.equal(s.over, true, 'bot v bot always reaches a sinking');
  assert.equal(def.result(s).winners.length, 1);
});

test('a bot-played match never takes more shots than there are squares', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const ctx = mkCtx(seeded(seed * 31 + 1));
    const s = def.create(setup, ctx) as SVState;
    act(s, 0, { type: 'ready' }, ctx);
    act(s, 1, { type: 'ready' }, ctx);
    while (!s.over) {
      const seat = s.order[s.turn];
      act(s, seat, def.bot!(s, seat, ctx)!, ctx);
    }
    for (const pid of [0, 1]) {
      const used = s.shots[pid].filter((v) => v !== null).length;
      assert.ok(used <= s.size * s.size, `seed ${seed}: ${used} shots on a ${s.size}×${s.size} grid`);
    }
  }
});
