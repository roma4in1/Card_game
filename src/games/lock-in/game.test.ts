// game.test.ts — deterministic unit tests for the Lock In dice game.
// Dice are driven by a scripted rng so every roll is exactly controllable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockIn, START_PLAY, START_RESERVE, type LIState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

// An rng that yields exactly the requested die faces (1–6), looping if exhausted.
// rollDie does floor(rng()*6)+1, so (f-0.5)/6 maps cleanly back to face f.
function scriptedRng(faces: number[]): () => number {
  let i = 0;
  return () => {
    const f = faces[i % faces.length];
    i += 1;
    return (f - 0.5) / 6;
  };
}

function newGame(n: number, faces: number[]): { s: LIState; c: GameContext } {
  const c: GameContext = { rng: scriptedRng(faces), now: 0 };
  const seats = Array.from({ length: n }, (_, i) => i);
  const players = seats.map((seat) => ({ seat, name: `P${seat}` }));
  const s = lockIn.create({ seats, players }, c);
  return { s, c };
}
const act = (s: LIState, c: GameContext, seat: number, msg: Record<string, unknown>) =>
  lockIn.act(s, seat, msg, c) ?? {};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('create deals starting chips and opens the first turn on a 9-dice roll', () => {
  const { s } = newGame(3, [1, 2, 3, 4, 5, 6, 1, 2, 3]);
  for (const seat of s.order) {
    const p = s.players[seat]!;
    assert.equal(p.playArea, START_PLAY);
    assert.equal(p.reserve, START_RESERVE);
    assert.equal(p.discard, 0);
    assert.equal(p.score, 0);
  }
  assert.equal(s.turn.seat, 0);
  assert.equal(s.turn.phase, 'pick');
  assert.equal(s.turn.dice.length, 9);
  assert.equal(s.over, false);
});

// ---------------------------------------------------------------------------
// First roll: pick the target
// ---------------------------------------------------------------------------

test('pick locks the target, sets aside exactly one, earns no chip', () => {
  const { s, c } = newGame(2, [3, 3, 3, 1, 1, 1, 2, 2, 2]); // three 3s present
  assert.match(act(s, c, 0, { type: 'pick', target: 5 }).error!, /not in your roll/i);
  assert.match(act(s, c, 1, { type: 'pick', target: 3 }).error!, /not your turn/i);
  assert.equal(act(s, c, 0, { type: 'pick', target: 3 }).error, undefined);
  assert.equal(s.turn.target, 3);
  assert.equal(s.turn.setAside, 1);
  assert.equal(s.turn.phase, 'decide');
  assert.equal(s.players[0]!.playArea, START_PLAY, 'no chip earned on the first roll');
});

// ---------------------------------------------------------------------------
// Subsequent rolls: set aside, chip earning, busting
// ---------------------------------------------------------------------------

test('a single match sets one aside; two or more also earns a chip from discard', () => {
  // first roll 9: [4,...]; pick 4. Then roll #1 (8 dice) shows two 4s.
  const { s, c } = newGame(2, [4, 1, 1, 1, 1, 1, 1, 1, 1]);
  act(s, c, 0, { type: 'pick', target: 4 });
  s.players[0]!.discard = 1; // give them something to earn back
  // next roll (8 dice): two 4s among them
  Object.assign(c, { rng: scriptedRng([4, 4, 1, 1, 1, 1, 1, 1]) });
  act(s, c, 0, { type: 'roll' });
  assert.equal(s.turn.setAside, 2);
  assert.equal(s.players[0]!.discard, 0, 'chip drawn from discard');
  assert.equal(s.players[0]!.playArea, START_PLAY + 1, 'chip moved into play');
  assert.equal(s.turn.earnedThisRoll, true);
});

test('two or more matches earn nothing when the discard pile is empty', () => {
  const { s, c } = newGame(2, [4, 1, 1, 1, 1, 1, 1, 1, 1]);
  act(s, c, 0, { type: 'pick', target: 4 });
  Object.assign(c, { rng: scriptedRng([4, 4, 1, 1, 1, 1, 1, 1]) });
  act(s, c, 0, { type: 'roll' });
  assert.equal(s.turn.setAside, 2);
  assert.equal(s.players[0]!.playArea, START_PLAY, 'no discard chip to draw, so none earned');
  assert.equal(s.turn.earnedThisRoll, false);
});

test('a no-match roll offers a reroll; paying a chip moves play→discard and rolls again', () => {
  const { s, c } = newGame(2, [4, 1, 1, 1, 1, 1, 1, 1, 1]);
  act(s, c, 0, { type: 'pick', target: 4 });
  Object.assign(c, { rng: scriptedRng([1, 1, 1, 1, 1, 1, 1, 1]) }); // no 4s
  act(s, c, 0, { type: 'roll' });
  assert.equal(s.turn.phase, 'zero');
  assert.match(act(s, c, 0, { type: 'roll' }).error!, /cannot roll/i);
  // pay a chip and reroll into a match
  Object.assign(c, { rng: scriptedRng([4, 1, 1, 1, 1, 1, 1, 1]) });
  act(s, c, 0, { type: 'reroll' });
  assert.equal(s.players[0]!.playArea, START_PLAY - 1);
  assert.equal(s.players[0]!.discard, 1);
  assert.equal(s.turn.chipsSpent, 1);
  assert.equal(s.turn.setAside, 2);
  assert.equal(s.turn.phase, 'decide');
});

test('a no-match roll with no chips ends the turn immediately', () => {
  const { s, c } = newGame(2, [4, 1, 1, 1, 1, 1, 1, 1, 1]);
  act(s, c, 0, { type: 'pick', target: 4 });
  s.players[0]!.playArea = 0; // cannot afford a reroll
  Object.assign(c, { rng: scriptedRng([1, 1, 1, 1, 1, 1, 1, 1]) });
  act(s, c, 0, { type: 'roll' });
  assert.equal(s.players[0]!.score, 1, 'banked 1 point for the single die set aside');
  assert.equal(s.turn.seat, 1, 'advanced to the next player');
});

// ---------------------------------------------------------------------------
// Stopping & scoring
// ---------------------------------------------------------------------------

test('stop banks one point per die set aside and passes the turn', () => {
  const { s, c } = newGame(2, [4, 1, 1, 1, 1, 1, 1, 1, 1]);
  act(s, c, 0, { type: 'pick', target: 4 });
  act(s, c, 0, { type: 'stop' });
  assert.equal(s.players[0]!.score, 1);
  assert.equal(s.turn.seat, 1);
});

test('setting aside exactly 8 scores a +1 bonus', () => {
  const { s, c } = newGame(2, [4, 1, 1, 1, 1, 1, 1, 1, 1]);
  act(s, c, 0, { type: 'pick', target: 4 });
  s.turn.setAside = 8; // white-box: jump to the brink
  act(s, c, 0, { type: 'stop' });
  assert.equal(s.players[0]!.score, 9, '8 dice + 1 bonus');
});

test('a clean sweep of 9 scores +3 and pulls a chip from reserve into play', () => {
  const { s, c } = newGame(2, [4, 1, 1, 1, 1, 1, 1, 1, 1]);
  act(s, c, 0, { type: 'pick', target: 4 });
  s.turn.setAside = 8;
  s.turn.chipsSpent = 1; // spent a chip → not a perfect run
  Object.assign(c, { rng: scriptedRng([4]) }); // final single die matches
  act(s, c, 0, { type: 'roll' });
  assert.equal(s.players[0]!.score, 12, '9 dice + 3 bonus');
  assert.equal(s.players[0]!.reserve, START_RESERVE - 1);
  assert.equal(s.players[0]!.playArea, START_PLAY + 1, 'reserve chip moved into play');
});

test('a perfect run (9 set aside, 0 chips spent) scores +5 instead of +3', () => {
  const { s, c } = newGame(2, [4, 1, 1, 1, 1, 1, 1, 1, 1]);
  act(s, c, 0, { type: 'pick', target: 4 });
  s.turn.setAside = 8;
  s.turn.chipsSpent = 0;
  Object.assign(c, { rng: scriptedRng([4]) });
  act(s, c, 0, { type: 'roll' });
  assert.equal(s.players[0]!.score, 14, '9 dice + 5 perfect-run bonus');
  assert.equal(s.players[0]!.reserve, START_RESERVE - 1);
});

// ---------------------------------------------------------------------------
// Turn order, rounds & end of game
// ---------------------------------------------------------------------------

test('turns cycle seat order and rounds advance after everyone plays', () => {
  const { s, c } = newGame(3, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  s.rounds = 2;
  assert.equal(s.round, 1);
  for (const seat of [0, 1, 2]) {
    assert.equal(s.turn.seat, seat);
    act(s, c, seat, { type: 'pick', target: 1 });
    act(s, c, seat, { type: 'stop' });
  }
  assert.equal(s.round, 2, 'round advances once all three have played');
  assert.equal(s.turn.seat, 0);
});

test('after the final round the game ends and adds +2 per play-area chip', () => {
  const { s, c } = newGame(2, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  s.rounds = 1;
  // P0 plays, ends with a big play-area lead; P1 plays minimally.
  act(s, c, 0, { type: 'pick', target: 1 });
  act(s, c, 0, { type: 'stop' }); // P0 score 1, play 8
  s.players[1]!.playArea = 3; // engineer a clear gap before P1 finishes
  act(s, c, 1, { type: 'pick', target: 1 });
  act(s, c, 1, { type: 'stop' }); // P1 score 1, play 3
  assert.equal(s.over, true);
  const out = lockIn.result(s);
  assert.equal(out.over, true);
  // P0: 1 + 2*8 = 17; P1: 1 + 2*3 = 7.
  assert.deepEqual(out.winners, [0]);
  const f0 = s.finals!.find((f) => f.seat === 0)!;
  assert.equal(f0.total, 17);
});

test('a tie on points is broken by play-area chips; a full tie is shared', () => {
  // Identical lines → identical totals and identical play-area → shared win.
  const { s, c } = newGame(2, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  s.rounds = 1;
  act(s, c, 0, { type: 'pick', target: 1 });
  act(s, c, 0, { type: 'stop' });
  act(s, c, 1, { type: 'pick', target: 1 });
  act(s, c, 1, { type: 'stop' });
  assert.equal(s.over, true);
  assert.deepEqual(lockIn.result(s).winners.sort(), [0, 1], 'shared victory');
});

test('actions are rejected once the game is over', () => {
  const { s, c } = newGame(2, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  s.rounds = 1;
  act(s, c, 0, { type: 'pick', target: 1 });
  act(s, c, 0, { type: 'stop' });
  act(s, c, 1, { type: 'pick', target: 1 });
  act(s, c, 1, { type: 'stop' });
  assert.match(act(s, c, 0, { type: 'pick', target: 1 }).error!, /over/i);
});

// ---------------------------------------------------------------------------
// View safety
// ---------------------------------------------------------------------------

test('the view exposes only public dice and per-seat action affordances', () => {
  const { s, c } = newGame(2, [4, 4, 1, 1, 1, 1, 1, 1, 1]);
  const v0 = lockIn.view(s, 0) as any;
  assert.equal(v0.game, 'lock-in');
  assert.equal(v0.turn.yourTurn, true);
  assert.equal(v0.turn.canPick, true);
  assert.equal(v0.turn.dice.length, 9, 'dice are public');
  const v1 = lockIn.view(s, 1) as any;
  assert.equal(v1.turn.yourTurn, false);
  assert.equal(v1.turn.canPick, false);
  assert.deepEqual(v1.turn.dice, v0.turn.dice, 'both players see the same public roll');
  act(s, c, 0, { type: 'pick', target: 4 });
  const v0b = lockIn.view(s, 0) as any;
  assert.equal(v0b.turn.canRoll, true);
  assert.equal(v0b.turn.canStop, true);
});
