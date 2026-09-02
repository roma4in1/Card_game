// game.test.ts — Volley Fire. The game is built on withholding information, so most of
// this is about what a player is NOT told, and about the two rules that stop the whole
// thing collapsing back into ordinary Battleship: no reusing a square, and ships that sink
// once their squares have all been fired at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { volleyFire, volleySize, FLEET, type VFState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const seeded = (n: number) => {
  let a = n;
  return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
};
const def = volleyFire;
const setup = { seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] };
const mkCtx = (rng: () => number = seeded(20260902)): GameContext & { now: number } => ({ rng, now: 1000 });
const act = (s: VFState, seat: number, msg: Record<string, unknown>, ctx: GameContext) => def.act(s, seat, msg, ctx) ?? {};
const view = (s: VFState, seat: number | null) => def.view(s, seat) as any;
const cell = (x: number, y: number) => y * 8 + x;

/** A match at sea, with both fleets placed by hand. */
function mk(a: [string, number, number, number, boolean][], b: typeof a): { s: VFState; ctx: GameContext & { now: number } } {
  const ctx = mkCtx();
  const s = def.create(setup, ctx) as VFState;
  const build = (spec: typeof a) => spec.map(([name, size, x, y, horiz]) => ({ name, size, x, y, horiz }));
  s.fleets = [build(a), build(b)];
  s.ready = [true, true];
  s.phase = 'play';
  return { s, ctx };
}
// One two-square ship, so a match can be decided in a couple of volleys.
const oneShip = (x: number, y: number): [string, number, number, number, boolean][] => [['Destroyer', 2, x, y, true]];

// ---------------------------------------------------------------------------
// The secret: how many, never which
// ---------------------------------------------------------------------------

test('a volley reports its total only — the squares stay unknown', () => {
  const { s, ctx } = mk(oneShip(0, 0), [['Cruiser', 3, 4, 4, true]]);
  // Two of these four are ship, two are water.
  assert.equal(act(s, 0, { type: 'volley', cells: [cell(4, 4), cell(5, 4), cell(0, 7), cell(7, 7)] }, ctx).error, undefined);

  const me = view(s, 0);
  assert.equal(me.you.volleys[0].hits, 2, 'it says two landed');
  for (const c of [cell(4, 4), cell(5, 4), cell(0, 7), cell(7, 7)]) {
    const square = me.you.enemy[c];
    assert.equal(square.fired, true, 'the square shows as fired at');
    assert.equal(square.mark, 'unknown', 'but never says which two were the hits');
  }
});

test('none and all resolve themselves; anything between does not', () => {
  // B keeps a second ship, or sinking the cruiser would end the match and reveal the board.
  const { s, ctx } = mk(oneShip(0, 0), [['Cruiser', 3, 4, 4, true], ['Destroyer', 2, 0, 0, true]]);
  act(s, 0, { type: 'volley', cells: [cell(0, 7), cell(1, 7), cell(2, 7), cell(3, 7)] }, ctx); // all water
  let me = view(s, 0);
  for (const c of [cell(0, 7), cell(1, 7), cell(2, 7), cell(3, 7)]) {
    assert.equal(me.you.enemy[c].mark, 'miss', 'nothing landed, so all four are water');
  }

  s.turn = 0;
  // Three shots on the cruiser and one beside it → 3 of 4, which settles nothing.
  act(s, 0, { type: 'volley', cells: [cell(4, 4), cell(5, 4), cell(6, 4), cell(7, 4)] }, ctx);
  me = view(s, 0);
  assert.equal(me.you.volleys[1].hits, 3);
  // The Cruiser is sunk by this volley, so its squares are shown; the fourth stays open.
  assert.equal(me.you.enemy[cell(7, 4)].mark, 'unknown', 'the square that was not part of the wreck stays a mystery');
});

test('you see the splashes in your own water, but never the other side’s working', () => {
  // Being shot at is not a secret — the target watches the shots land in their own waters,
  // exactly as in the paper game. What must not cross over is the FIRER's side of it: the
  // record of what they have learned about the fleet they are hunting.
  const { s, ctx } = mk([['Cruiser', 3, 0, 3, true], ['Destroyer', 2, 6, 6, true]], [['Cruiser', 3, 0, 6, true], ['Destroyer', 2, 6, 0, true]]);
  const shots = [cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0)];
  act(s, 0, { type: 'volley', cells: shots }, ctx);

  const target = view(s, 1);
  for (const c of shots) assert.equal(target.you.own[c].incoming, true, 'the target sees where the shots landed');
  assert.deepEqual(target.you.volleys, [], 'but gets none of the firer’s volley record');
  for (const square of target.you.enemy) {
    assert.equal(square.fired, false, 'and none of the firer’s progress against them');
    assert.equal(square.mark, 'unknown');
  }
  // Nothing in B's payload describes A's fleet.
  assert.equal(JSON.stringify(target.you.enemy).includes('"hit"'), false);
});

test('the report names the ships it found, and counts them', () => {
  // A bare total was the first design and it made the game a sweep: the best bot still had
  // to fire at 53 of 64 squares. Naming the ships is what gives a volley something to
  // deduce from — and it must still not say WHICH shot found what.
  const { s, ctx } = mk(oneShip(0, 0), [['Carrier', 5, 0, 4, true], ['Destroyer', 2, 6, 0, true]]);
  act(s, 0, { type: 'volley', cells: [cell(0, 4), cell(1, 4), cell(6, 0), cell(7, 7)] }, ctx);

  const v = view(s, 0).you.volleys[0];
  assert.deepEqual(v.byShip, { Carrier: 2, Destroyer: 1 }, 'two on the carrier, one on the destroyer');
  assert.equal(v.hits, 3);
  for (const c of v.cells) {
    assert.equal(view(s, 0).you.enemy[c].mark, 'unknown', 'but which shot found which ship stays hidden');
  }
});

test('the report tells you nothing about ships you did not touch', () => {
  const { s, ctx } = mk(oneShip(0, 0), [['Carrier', 5, 0, 4, true], ['Destroyer', 2, 6, 0, true]]);
  act(s, 0, { type: 'volley', cells: [cell(0, 4), cell(1, 4), cell(2, 4), cell(3, 4)] }, ctx);
  const v = view(s, 0).you.volleys[0];
  assert.deepEqual(Object.keys(v.byShip), ['Carrier'], 'only the ship actually struck is named');
  assert.equal(v.byShip.Carrier, 4);
});

test('a spectator is told nothing about either fleet', () => {
  const specs = [[oneShip(0, 0), oneShip(5, 5)], [oneShip(3, 2), oneShip(1, 6)]].map(([a, b]) => view(mk(a, b).s, null));
  assert.deepEqual(specs[0], specs[1], 'the sideline cannot see either fleet move');
  assert.deepEqual(specs[0].you.enemy, []);
  assert.deepEqual(specs[0].you.volleys, []);
});

// ---------------------------------------------------------------------------
// The two rules the game rests on
// ---------------------------------------------------------------------------

test('a volley may not reuse a square, which is what stops it becoming Battleship', () => {
  // Padding three known misses around one new square would give an unambiguous answer
  // every turn, and the whole point of the game would be gone.
  const { s, ctx } = mk(oneShip(0, 0), oneShip(5, 5));
  act(s, 0, { type: 'volley', cells: [cell(0, 7), cell(1, 7), cell(2, 7), cell(3, 7)] }, ctx);
  s.turn = 0;
  const reuse = act(s, 0, { type: 'volley', cells: [cell(0, 7), cell(1, 7), cell(2, 7), cell(4, 4)] }, ctx);
  assert.match(reuse.error!, /already fired/);
  assert.match(act(s, 0, { type: 'volley', cells: [cell(4, 4), cell(4, 4), cell(5, 5), cell(6, 6)] }, ctx).error!, /same square/);
  assert.match(act(s, 0, { type: 'volley', cells: [cell(4, 4), cell(5, 5)] }, ctx).error!, /A volley is 4 shots/);
});

test('a ship goes down once its squares have all been fired at, located or not', () => {
  // Otherwise a player who had shot the whole board without identifying a ship would have
  // no legal move left, and the match could not finish.
  const { s, ctx } = mk(oneShip(0, 0), oneShip(5, 5));
  act(s, 0, { type: 'volley', cells: [cell(5, 5), cell(0, 7), cell(1, 7), cell(2, 7)] }, ctx);
  assert.equal(s.over, false, 'half the destroyer is not a sinking');
  s.turn = 0;
  act(s, 0, { type: 'volley', cells: [cell(6, 5), cell(3, 7), cell(4, 7), cell(5, 7)] }, ctx);
  assert.equal(s.over, true, 'the second half sinks it and ends the match');
  assert.deepEqual(def.result(s).winners, [0]);
  assert.match(s.log.join(' '), /Destroyer sunk/);
});

test('a sunk ship is shown; the fleet still afloat is not', () => {
  const { s, ctx } = mk(oneShip(0, 0), [['Cruiser', 3, 4, 4, true], ['Destroyer', 2, 0, 0, true]]);
  act(s, 0, { type: 'volley', cells: [cell(4, 4), cell(5, 4), cell(6, 4), cell(0, 7)] }, ctx);
  const me = view(s, 0);
  assert.equal(me.you.wrecks.length, 1, 'the cruiser it sank is drawn in');
  assert.equal(me.you.wrecks[0].name, 'Cruiser');
  for (const c of [cell(4, 4), cell(5, 4), cell(6, 4)]) assert.equal(me.you.enemy[c].mark, 'hit');
  assert.equal(me.you.enemy[cell(0, 0)].mark, 'unknown', 'the destroyer it has not found is not given away');
});

test('the volley shrinks only when the board runs out, and the match always ends', () => {
  const { s, ctx } = mk(oneShip(0, 0), oneShip(5, 5));
  assert.equal(volleySize(s, 0), 4);
  // Fire at everything except three squares.
  for (let c = 0; c < 61; c++) s.fired[0][c] = true;
  assert.equal(volleySize(s, 0), 3, 'a short board means a short volley, not an illegal one');
  assert.equal(act(s, 0, { type: 'volley', cells: [61, 62, 63] }, ctx).error, undefined);
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test('the dealt fleet is legal, and stays legal however it is rearranged', () => {
  const ctx = mkCtx(seeded(31));
  const s = def.create(setup, ctx) as VFState;
  const rng = seeded(77);
  for (let n = 0; n < 300; n++) {
    const i = Math.floor(rng() * s.fleets[0].length);
    if (rng() < 0.3) act(s, 0, { type: 'rotateShip', index: i }, ctx);
    else act(s, 0, { type: 'placeShip', index: i, x: Math.floor(rng() * 8), y: Math.floor(rng() * 8), horiz: rng() < 0.5 }, ctx);
    const taken = new Set<number>();
    for (const sh of s.fleets[0]) {
      for (let k = 0; k < sh.size; k++) {
        const x = sh.horiz ? sh.x + k : sh.x;
        const y = sh.horiz ? sh.y : sh.y + k;
        assert.ok(x >= 0 && y >= 0 && x < 8 && y < 8, `${sh.name} left the board`);
        assert.equal(taken.has(cell(x, y)), false, `${sh.name} overlaps another ship`);
        taken.add(cell(x, y));
      }
    }
  }
  assert.deepEqual(s.fleets[0].map((sh) => sh.name).sort(), FLEET.map((f) => f.name).sort());
});

test('firing waits for both fleets', () => {
  const ctx = mkCtx(seeded(9));
  const s = def.create(setup, ctx) as VFState;
  assert.match(act(s, 0, { type: 'volley', cells: [0, 1, 2, 3] }, ctx).error!, /must be at sea/);
  act(s, 0, { type: 'ready' }, ctx);
  assert.equal(s.phase, 'place', 'still waiting on B');
  act(s, 1, { type: 'ready' }, ctx);
  assert.equal(s.phase, 'play');
  assert.match(act(s, 1, { type: 'volley', cells: [0, 1, 2, 3] }, ctx).error!, /Not your turn/);
  assert.match(act(s, 5, { type: 'volley', cells: [0, 1, 2, 3] }, ctx).error!, /not in this match/);
});

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

test('the bot fires legal volleys and finishes matches at every skill', () => {
  for (const skill of [1, 2, 3]) {
    for (let seed = 1; seed <= 4; seed++) {
      const ctx = mkCtx(seeded(seed * 811 + skill));
      const s = def.create(setup, ctx) as VFState;
      s.skill = skill;
      act(s, 0, { type: 'ready' }, ctx);
      act(s, 1, { type: 'ready' }, ctx);
      for (let n = 0; n < 200 && !s.over; n++) {
        const seat = s.order[s.turn];
        const mv = def.bot!(s, seat, ctx) as { type: string; cells: number[] };
        assert.ok(mv, 'a bot on turn always has a volley');
        assert.equal(new Set(mv.cells).size, mv.cells.length, 'no square twice in one volley');
        for (const c of mv.cells) assert.equal(s.fired[s.turn][c], false, 'never fires where it has already fired');
        assert.equal(act(s, seat, mv, ctx).error, undefined, JSON.stringify(mv));
      }
      assert.equal(s.over, true, `skill ${skill} seed ${seed} did not finish`);
      assert.equal(def.result(s).winners.length, 1);
    }
  }
});

test('the sharp bot reads its volley history — it does not just sweep', () => {
  // Told that two of four landed, it should come back to that neighbourhood rather than
  // treating those squares like any other.
  const { s, ctx } = mk(oneShip(0, 0), [['Cruiser', 3, 4, 4, true], ['Destroyer', 2, 0, 5, true]]);
  s.skill = 3;
  act(s, 0, { type: 'volley', cells: [cell(4, 4), cell(5, 4), cell(0, 7), cell(7, 7)] }, ctx); // 2 hits
  assert.equal(s.volleys[0].hits, 2);
  s.turn = 0;
  const next = def.bot!(s, 0, ctx) as { cells: number[] };
  const nearCruiser = next.cells.filter((c) => {
    const x = c % 8;
    const y = Math.floor(c / 8);
    return Math.abs(y - 4) <= 1 && x >= 3 && x <= 7;
  });
  assert.ok(nearCruiser.length >= 1, `expected it to follow up near the hits, got ${JSON.stringify(next.cells)}`);
});
