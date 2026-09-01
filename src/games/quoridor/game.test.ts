// game.test.ts — Quoridor. No randomness / no hidden info, so tests are fully
// deterministic. The weight is on movement + jump rules and the no-trap wall check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoridor, type QState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const seeded = (n: number) => { let a = n; return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648); };
const ctx: GameContext = { rng: () => 0.5, now: 0 };
function newQ(np: number): QState {
  const seats = Array.from({ length: np }, (_, i) => i);
  const players = seats.map((s) => ({ seat: s, name: 'P' + s }));
  return quoridor.create({ seats, players }, ctx) as QState;
}
const act = (s: QState, seat: number, msg: Record<string, unknown>) => quoridor.act(s, seat, msg, ctx) ?? {};

test('the opt-in turn timer auto-moves the active player on timeout', () => {
  const seats = [0, 1];
  const players = seats.map((s) => ({ seat: s, name: 'P' + s }));
  const s = quoridor.create({ seats, players, options: { timer: 30 } }, ctx) as QState;
  assert.equal(quoridor.tick!(s, { rng: () => 0.5, now: 0 }), true, 'first tick arms the clock');
  assert.ok((quoridor.view(s, 0) as any).timer.deadline > 0, 'countdown armed');
  const startTurn = s.turn;
  const startPawn = s.pawns[startTurn].join(',');
  assert.equal(quoridor.tick!(s, { rng: () => 0.5, now: 29000 }), false, 'no change before the deadline');
  quoridor.tick!(s, { rng: () => 0.5, now: 31000 }); // past the deadline → bot moves the pawn
  assert.notEqual(s.pawns[startTurn].join(','), startPawn, 'the stalling pawn was auto-moved');
});
const view = (s: QState, seat: number) => quoridor.view(s, seat) as any;
const activeMoves = (s: QState): [number, number][] => view(s, s.order[s.turn]).legal.moves;
const hasCell = (cells: [number, number][], r: number, c: number) => cells.some((m) => m[0] === r && m[1] === c);
// Try to place a wall as the active player without mutating turn bookkeeping in tests.
const tryWall = (s: QState, r: number, c: number, o: 'H' | 'V') =>
  act(s, s.order[s.turn], { type: 'placeWall', slot: [r, c], orientation: o });

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('2 / 3 / 4 player setups give the right starts, goals and wall counts', () => {
  const s2 = newQ(2);
  assert.deepEqual(s2.pawns, [[0, 4], [8, 4]]);
  assert.deepEqual(s2.goals, ['top', 'bottom']);
  assert.deepEqual(s2.wallsLeft, [10, 10]);

  const s3 = newQ(3);
  assert.deepEqual(s3.pawns, [[0, 4], [8, 4], [4, 0]]);
  assert.deepEqual(s3.goals, ['top', 'bottom', 'right']);
  assert.deepEqual(s3.wallsLeft, [7, 7, 7]);

  const s4 = newQ(4);
  assert.deepEqual(s4.pawns, [[0, 4], [8, 4], [4, 0], [4, 8]]);
  assert.deepEqual(s4.goals, ['top', 'bottom', 'right', 'left']);
  assert.deepEqual(s4.wallsLeft, [5, 5, 5, 5]);
});

// ---------------------------------------------------------------------------
// Movement & blocking
// ---------------------------------------------------------------------------

test('basic orthogonal moves, bounded by walls and the board edge', () => {
  const s = newQ(2); // P0 at (0,4)
  let m = activeMoves(s);
  assert.ok(hasCell(m, 1, 4) && hasCell(m, 0, 3) && hasCell(m, 0, 5));
  assert.ok(!hasCell(m, -1, 4), 'cannot leave the board');

  // a horizontal wall directly above P0 blocks the upward move
  s.walls = [{ r: 0, c: 4, o: 'H' }]; // blocks (0,4)|(1,4) and (0,5)|(1,5)
  m = activeMoves(s);
  assert.ok(!hasCell(m, 1, 4), 'wall blocks the move across it');
  assert.ok(hasCell(m, 0, 3) && hasCell(m, 0, 5), 'sideways still open');
});

test('a move into another pawn is illegal except via a jump', () => {
  const s = newQ(2);
  s.pawns = [[0, 4], [1, 4]]; // P1 directly above P0
  s.turn = 0;
  const m = activeMoves(s);
  assert.ok(!hasCell(m, 1, 4), 'cannot step onto a pawn');
  assert.ok(hasCell(m, 2, 4), 'straight jump over it');
});

// ---------------------------------------------------------------------------
// Jumps
// ---------------------------------------------------------------------------

test('straight jump, and diagonal jump when the straight cell is wall-blocked', () => {
  const s = newQ(2);
  s.pawns = [[0, 4], [1, 4]];
  s.turn = 0;
  assert.ok(hasCell(activeMoves(s), 2, 4), 'straight jump');

  // wall behind the jumped pawn → must go diagonal
  s.walls = [{ r: 1, c: 4, o: 'H' }]; // blocks (1,4)|(2,4)
  const m = activeMoves(s);
  assert.ok(!hasCell(m, 2, 4), 'straight jump now blocked');
  assert.ok(hasCell(m, 1, 3) && hasCell(m, 1, 5), 'diagonal beside the jumped pawn');
});

test('no chain-jump: a second pawn behind the first forces a diagonal', () => {
  const s = newQ(3);
  s.pawns = [[0, 4], [1, 4], [2, 4]]; // two pawns stacked above P0
  s.turn = 0;
  const m = activeMoves(s);
  assert.ok(!hasCell(m, 2, 4), 'cannot land on the second pawn');
  assert.ok(!hasCell(m, 3, 4), 'cannot chain-jump two pawns');
  assert.ok(hasCell(m, 1, 3) && hasCell(m, 1, 5), 'diagonal instead');
});

// ---------------------------------------------------------------------------
// Wall overlap / cross rejection
// ---------------------------------------------------------------------------

test('overlapping and crossing walls are rejected', () => {
  const s = newQ(2);
  assert.equal(tryWall(s, 3, 3, 'H').error, undefined); // P0 places, turn → P1
  assert.equal(s.turn, 1);
  assert.match(tryWall(s, 3, 3, 'H').error!, /overlap|cross/i); // exact duplicate
  assert.match(tryWall(s, 3, 4, 'H').error!, /overlap|cross/i); // colinear overlap
  assert.match(tryWall(s, 3, 3, 'V').error!, /overlap|cross/i); // perpendicular cross (same slot)
  assert.equal(tryWall(s, 5, 6, 'V').error, undefined, 'a clear slot is fine');
});

test('walls cost from supply; none left → cannot place', () => {
  const s = newQ(2);
  s.wallsLeft[0] = 0;
  assert.match(tryWall(s, 2, 2, 'H').error!, /no walls/i);
});

// ---------------------------------------------------------------------------
// No-trap rule (the crux)
// ---------------------------------------------------------------------------

// Box a pawn at (4,4) on three sides; the fourth wall would seal it.
const BOX_3 = [{ r: 4, c: 3, o: 'H' as const }, { r: 3, c: 4, o: 'H' as const }, { r: 3, c: 3, o: 'V' as const }];
const SEAL = { r: 4, c: 4, o: 'V' as const }; // closes the last (right) exit of (4,4)

test('no-trap: a wall that seals your OWN only path is rejected', () => {
  const s = newQ(2);
  s.pawns[0] = [4, 4];
  s.walls = [...BOX_3];
  s.turn = 0;
  // pre-state is legal: P0 can still exit right
  assert.ok(hasCell(activeMoves(s), 4, 5), 'one exit remains');
  assert.match(tryWall(s, SEAL.r, SEAL.c, SEAL.o).error!, /trap|path/i);
  // a wall that merely lengthens a path (elsewhere) is allowed
  assert.equal(tryWall(s, 0, 0, 'H').error, undefined);
});

test('no-trap: a wall that seals an OPPONENT is rejected', () => {
  const s = newQ(2);
  s.pawns = [[0, 0], [4, 4]]; // P1 is the one boxed
  s.walls = [...BOX_3];
  s.turn = 0; // P0 to act
  assert.match(tryWall(s, SEAL.r, SEAL.c, SEAL.o).error!, /trap|path/i);
});

test('no-trap: a wall that seals a THIRD party is rejected (3p)', () => {
  const s = newQ(3);
  s.pawns = [[0, 0], [8, 8], [4, 4]]; // P2 boxed
  s.walls = [...BOX_3];
  s.turn = 0; // P0 to act
  assert.match(tryWall(s, SEAL.r, SEAL.c, SEAL.o).error!, /trap|path/i);
});

// ---------------------------------------------------------------------------
// Turn structure: move, then optionally a wall
// ---------------------------------------------------------------------------

test('a turn may be a move followed by an optional wall', () => {
  const s = newQ(2); // P0 at (0,4)
  assert.equal(act(s, 0, { type: 'movePawn', toCell: [1, 4] }).error, undefined);
  assert.equal(s.turn, 0, 'still P0 after moving — they may wall');
  assert.equal(s.turnStage, 'moved');
  assert.match(act(s, 0, { type: 'movePawn', toCell: [2, 4] }).error!, /already moved/i);
  assert.equal(act(s, 0, { type: 'placeWall', slot: [3, 3], orientation: 'H' }).error, undefined);
  assert.equal(s.turn, 1, 'turn passes after the wall');
  assert.equal(s.wallsLeft[0], 9);
});

test('after moving you may just end the turn; endTurn before moving is illegal', () => {
  const s = newQ(2);
  assert.match(act(s, 0, { type: 'endTurn' }).error!, /move first/i);
  act(s, 0, { type: 'movePawn', toCell: [1, 4] });
  assert.match(act(s, 1, { type: 'endTurn' }).error!, /not your turn/i);
  assert.equal(act(s, 0, { type: 'endTurn' }).error, undefined);
  assert.equal(s.turn, 1);
});

test('a wall-only turn (no move) is still allowed', () => {
  const s = newQ(2);
  assert.equal(act(s, 0, { type: 'placeWall', slot: [2, 2], orientation: 'V' }).error, undefined);
  assert.equal(s.turn, 1, 'placing a wall without moving ends the turn');
});

// ---------------------------------------------------------------------------
// Winning & view
// ---------------------------------------------------------------------------

test('reaching the goal edge wins immediately', () => {
  const s = newQ(2);
  s.pawns = [[7, 4], [8, 8]]; // P0 one step from the top edge; P1 out of the way
  s.turn = 0;
  assert.equal(act(s, 0, { type: 'movePawn', toCell: [8, 4] }).error, undefined);
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
  assert.deepEqual(quoridor.result(s).winners, [0]);
});

test('view returns the same full public board to everyone (no redaction)', () => {
  const s = newQ(2);
  s.walls = [{ r: 2, c: 2, o: 'H' }];
  const a = view(s, 0);
  const b = view(s, 1);
  assert.deepEqual(a.walls, b.walls);
  assert.deepEqual(a.pawns, b.pawns);
  assert.deepEqual(a.legal, b.legal, 'legal options are public and identical');
  assert.equal(a.you.seat, 0);
  assert.equal(b.you.seat, 1);
});

test('a full match plays to a winner via the bot', () => {
  const s = newQ(2);
  let guard = 0;
  while (!s.over && guard++ < 2000) {
    let acted = false;
    for (const seat of s.order) {
      const mv = quoridor.bot!(s, seat, ctx);
      if (mv) {
        assert.equal(act(s, seat, mv).error, undefined, JSON.stringify(mv));
        acted = true;
        break;
      }
    }
    if (!acted) break;
  }
  assert.equal(s.over, true);
  assert.ok(quoridor.result(s).winners.length === 1);
});

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

test('the bot places walls, and a bot match still reaches a winner', () => {
  // The regression this guards: the old bot only ever walked its shortest path and never
  // placed a single wall, handing away half the game to anyone who did.
  const ctx: GameContext = { rng: seeded(2024), now: 0 };
  const s = quoridor.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as QState;
  let acts = 0;
  for (; acts < 3000 && !s.over; acts++) {
    const seat = s.order[s.turn];
    const mv = quoridor.bot!(s, seat, ctx)!;
    assert.ok(mv, 'the bot on turn always has something to do');
    assert.equal((quoridor.act(s, seat, mv, ctx) ?? {}).error, undefined, JSON.stringify(mv));
  }
  assert.equal(s.over, true, 'the match finished');
  assert.equal(typeof s.winner, 'number');
  assert.ok(s.walls.length >= 4, `a bot game should see walls go down, saw ${s.walls.length}`);
  assert.ok(s.wallsLeft.some((w) => w < 10), 'and they came out of someone’s supply');
});

test('every level varies its opening, and Sharp tightens up once past it', () => {
  // Repetition between games is a real complaint, and it is not free to fix: from the
  // starting square only one move makes ground, and it is a full step better than
  // sidestepping. The search calls that decisive because it assumes the opposition answers
  // perfectly — against a person it does not, so Sharp spends the tempo on being
  // unpredictable while there is a whole match left to recover in, and plays it straight
  // afterwards, when a move given away stays given away.
  const firstMoves = (skill: number, turnsPlayed = 0) => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 12; seed++) {
      const ctx: GameContext = { rng: seeded(seed * 4409 + 7), now: 0 };
      const s = quoridor.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as QState;
      s.skill = skill;
      s.turnsPlayed = turnsPlayed;
      const mv = quoridor.bot!(s, 0, ctx) as { toCell?: [number, number] };
      seen.add(JSON.stringify(mv.toCell));
    }
    return seen;
  };
  assert.ok(firstMoves(1).size > 1, 'Casual should not open the same way every game');
  assert.ok(firstMoves(3).size > 1, 'nor should Sharp');

  // Past the opening the band closes: the same position, played straight, every time.
  assert.equal(firstMoves(3, 30).size, 1, 'Sharp should stop improvising once the game is under way');
});

test('a varied opening is still a sensible one — never a step backwards', () => {
  // Unpredictable is not the same as careless. Whatever Sharp opens with, it must not
  // actually lose ground; the band is one step wide so it can sidestep, not retreat.
  for (let seed = 0; seed < 15; seed++) {
    const ctx: GameContext = { rng: seeded(seed * 913 + 5), now: 0 };
    const s = quoridor.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as QState;
    const before = s.pawns[0][0]; // player 0 races toward row 8, so its row is its progress
    const mv = quoridor.bot!(s, 0, ctx) as { type: string; toCell: [number, number] };
    assert.equal(mv.type, 'movePawn');
    assert.ok(mv.toCell[0] >= before, `opened by retreating from row ${before} to ${mv.toCell[0]}`);
  }
});

test('the bot answers a wall rather than replaying the same game every time', () => {
  // Deterministic search means two bots play the identical match forever, which a human
  // can simply memorise. The tie-break jitter has to make repeat games diverge.
  const play = (seed: number) => {
    const ctx: GameContext = { rng: seeded(seed), now: 0 };
    const s = quoridor.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as QState;
    for (let n = 0; n < 3000 && !s.over; n++) {
      const seat = s.order[s.turn];
      quoridor.act(s, seat, quoridor.bot!(s, seat, ctx)!, ctx);
    }
    // `moveLog` is dead state (declared, never written), so sign the game by what the
    // board actually ended up looking like.
    return JSON.stringify({ walls: s.walls, pawns: s.pawns, winner: s.winner });
  };
  assert.notEqual(play(11), play(77), 'two matches should not be move-for-move identical');
});
