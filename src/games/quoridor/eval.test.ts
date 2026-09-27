// eval.test.ts — a position suite for the Quoridor evaluation.
//
// This exists because "the bot feels stronger" is not a measurement. The evaluation is
// the part of the bot that search only amplifies: if it scores positions wrongly, looking
// further ahead makes play worse rather than better, which is exactly what happened here
// — a four-turn search lost to a two-turn one until the tempo term below was added.
//
// The anchor is the endgame. Once neither player holds a wall the game is a pure race
// with an exact, provable result: the player to move gets home first whenever their walk
// is no longer than their opponent's. That gives a whole class of positions where the
// right answer is known outright rather than agreed by opinion, so the evaluation can be
// pinned to it. The rest of the suite fixes the things a race cannot: what a wall is
// worth, and that the opening is level.
//
// It also has to be able to say NO. A corridor term — penalising a route one wall could
// cut — passed its own position tests here and then lost games (37% at equal nodes), so it
// was dropped. Tests that only ever confirm are not worth writing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoridor, evaluatePosition, N, type QState, type Cell, type Wall } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const ctx: GameContext = { rng: () => 0.5, now: 0 };

/** A two-player board with the pawns, walls and supplies placed by hand. */
function position(opts: { pawns: [Cell, Cell]; walls?: Wall[]; wallsLeft?: [number, number] }): QState {
  const s = quoridor.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as QState;
  s.pawns = opts.pawns.map((p) => [...p] as Cell);
  s.walls = (opts.walls ?? []).map((w) => ({ ...w }));
  s.wallsLeft = [...(opts.wallsLeft ?? [0, 0])];
  return s;
}
// Player 0 races to the top (row 8), player 1 to the bottom (row 0).
const distTop = (r: number) => N - 1 - r;
const distBottom = (r: number) => r;

// ---------------------------------------------------------------------------
// Races, where the answer is exact
// ---------------------------------------------------------------------------

test('with no walls left, the evaluation decides every race correctly', () => {
  // Sweep every pair of distances on an open board and check the sign of the evaluation
  // against the rule the race actually follows. This is ground truth, not a judgement
  // call: the side to move wins if and only if its walk is no longer than the other's.
  let checked = 0;
  for (let rowA = 0; rowA < N - 1; rowA++) {
    for (let rowB = 1; rowB < N; rowB++) {
      const s = position({ pawns: [[rowA, 0], [rowB, 8]] });
      const dA = distTop(rowA);
      const dB = distBottom(rowB);
      for (const toMove of [0, 1]) {
        const winner = toMove === 0 ? (dA <= dB ? 0 : 1) : (dB <= dA ? 1 : 0);
        const v = evaluatePosition(s, 0, toMove);
        assert.notEqual(v, 0, `A${dA} v B${dB}, ${toMove} to move: a race is never level`);
        assert.equal(v > 0, winner === 0, `A needs ${dA}, B needs ${dB}, ${toMove} to move → ${winner === 0 ? 'A' : 'B'} wins, but eval said ${v.toFixed(1)}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 100, `swept ${checked} races`);
});

test('the tempo is worth exactly one step, and only to the player holding it', () => {
  // Level distances: whoever is to move wins. A turn-blind evaluation scores these two
  // identically and gets one of them wrong — this is the bug the suite exists to catch.
  const level = position({ pawns: [[4, 0], [4, 8]] }); // both four steps out
  assert.ok(evaluatePosition(level, 0, 0) > 0, 'A to move, level race: A wins');
  assert.ok(evaluatePosition(level, 0, 1) < 0, 'B to move, same board: B wins');

  // One step behind is exactly enough to lose the tempo back.
  const behind = position({ pawns: [[3, 0], [4, 8]] }); // A five out, B four
  assert.ok(evaluatePosition(behind, 0, 0) < 0, 'a step behind, even on the move, A loses');
});

test('being on the move never hurts, and the two players see the same race', () => {
  for (const [a, b] of [[2, 6], [4, 4], [7, 1], [0, 8]] as [number, number][]) {
    const s = position({ pawns: [[a, 0], [b, 8]] });
    assert.ok(evaluatePosition(s, 0, 0) > evaluatePosition(s, 0, 1), 'the move is worth having');
    // Zero-sum: what A sees as good, B must see as equally bad.
    for (const toMove of [0, 1]) {
      const fromA = evaluatePosition(s, 0, toMove);
      const fromB = evaluatePosition(s, 1, toMove);
      assert.ok(Math.abs(fromA + fromB) < 1e-9, `A ${fromA} and B ${fromB} disagree about the same board`);
    }
  }
});

// ---------------------------------------------------------------------------
// What a wall is worth
// ---------------------------------------------------------------------------

test('a wall is worth spending only on a detour longer than it is worth keeping', () => {
  // This used to say the opposite — that any wall costing them a step reads as progress —
  // and a bot built on it spent its walls in the opening, a step at a time. Measured in
  // play, a wall in hand is worth about two and a half steps (see WALL_WORTH), so the one-
  // step detour is a waste and the one that sends them the long way round is the point.
  //
  // A runs up column 0, well out of the way. The wall lies across B's route only.
  const short = { pawns: [[0, 0], [7, 4]] as [Cell, Cell], wall: { r: 6, c: 4, o: 'H' } as Wall };
  const holdShort = evaluatePosition(position({ pawns: short.pawns, wallsLeft: [1, 0] }), 0, 0);
  const spendShort = evaluatePosition(position({ pawns: short.pawns, walls: [short.wall], wallsLeft: [0, 0] }), 0, 0);
  assert.ok(spendShort < holdShort, `a one-step detour is not worth a wall (${holdShort.toFixed(0)} → ${spendShort.toFixed(0)})`);

  // B inside a channel: walls either side of column 4. Capping it sends B back out and
  // round, five steps or so — worth the wall and then some.
  const channel: Wall[] = [{ r: 3, c: 3, o: 'V' }, { r: 3, c: 4, o: 'V' }, { r: 5, c: 3, o: 'V' }, { r: 5, c: 4, o: 'V' }];
  const pawns: [Cell, Cell] = [[0, 0], [5, 4]];
  const hold = evaluatePosition(position({ pawns, walls: channel, wallsLeft: [1, 0] }), 0, 0);
  const spend = evaluatePosition(position({ pawns, walls: [...channel, { r: 4, c: 4, o: 'H' }], wallsLeft: [0, 0] }), 0, 0);
  assert.ok(spend > hold, `a long detour is worth the wall (${hold.toFixed(0)} → ${spend.toFixed(0)})`);
});

test('a wall that costs us more than them is never an improvement', () => {
  // A wall across A's OWN route, with B untouched: strictly bad for A however it is read.
  const open = position({ pawns: [[4, 4], [8, 0]], wallsLeft: [1, 0] });
  const selfHarm = position({ pawns: [[4, 4], [8, 0]], walls: [{ r: 4, c: 3, o: 'H' }], wallsLeft: [0, 0] });
  assert.ok(evaluatePosition(selfHarm, 0, 0) < evaluatePosition(open, 0, 0), 'walling your own path must score worse');
});

test('walls in hand are worth most while the rival has far to go', () => {
  // Same three-wall advantage twice: once with B seven steps from home, once with B one
  // step away. A wall's worth is what it can still cost them, and a rival about to arrive
  // has little left to lose — so the advantage must fade, though not to nothing: one step
  // out is exactly when a wall across the last step decides the game.
  const early = position({ pawns: [[1, 4], [7, 4]], wallsLeft: [3, 0] });
  const earlyNone = position({ pawns: [[1, 4], [7, 4]], wallsLeft: [0, 0] });
  const earlyGap = evaluatePosition(early, 0, 0) - evaluatePosition(earlyNone, 0, 0);
  assert.ok(earlyGap > 0, 'held walls count while there is a race to shape');

  const late = position({ pawns: [[7, 4], [1, 4]], wallsLeft: [3, 0] });
  const lateNone = position({ pawns: [[7, 4], [1, 4]], wallsLeft: [0, 0] });
  const lateGap = evaluatePosition(late, 0, 0) - evaluatePosition(lateNone, 0, 0);
  assert.ok(lateGap > 0 && lateGap < earlyGap / 4, `and fade as the rival nears home (${earlyGap.toFixed(0)} → ${lateGap.toFixed(0)})`);
});

// ---------------------------------------------------------------------------
// The opening
// ---------------------------------------------------------------------------

test('the opening board is level but for the move', () => {
  const s = quoridor.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as QState;
  const toMove = evaluatePosition(s, 0, 0);
  const waiting = evaluatePosition(s, 0, 1);
  assert.ok(toMove > 0 && waiting < 0, 'a symmetric start is decided only by whose turn it is');
  assert.ok(Math.abs(toMove + waiting) < 1e-9, 'and by the same amount either way');
});
