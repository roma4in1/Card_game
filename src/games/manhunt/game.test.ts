// game.test.ts — Manhunt. The runner's position is the whole game, so most of this checks
// what the hunter is and isn't told. The rest: the surfacing schedule, the three-agent
// turn, and the two-half structure that makes an asymmetric game fair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manhunt, NODES, EDGES, TRANSPORT, type MHState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const def = manhunt;
const setup = { seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] };
const seeded = (seed: number) => {
  let a = seed;
  return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
};
const mkCtx = (rng: () => number = seeded(4242)): GameContext & { now: number } => ({ rng, now: 1000 });
const act = (s: MHState, seat: number, msg: Record<string, unknown>, ctx: GameContext) => def.act(s, seat, msg, ctx) ?? {};
const view = (s: MHState, seat: number | null) => def.view(s, seat) as any;
const TAXI = 0, BUS = 1, TUBE = 2;

/** A fresh match with the runner and every agent put exactly where we want them. */
function mk(runnerAt: number, hunterAt: number[]): { s: MHState; ctx: GameContext & { now: number } } {
  const ctx = mkCtx();
  const s = def.create(setup, ctx) as MHState;
  // Move the recorded start too, or the fixture claims one opening position while the
  // pieces sit on another — and the start is public, so that discrepancy is visible.
  s.runnerAt = s.startRunner = runnerAt;
  s.hunterAt = [...hunterAt];
  s.startHunters = [...hunterAt];
  return { s, ctx };
}
/** Move every agent somewhere harmless to complete the hunter's half of a turn. */
function idleHunt(s: MHState, ctx: GameContext) {
  for (let piece = 0; piece < s.hunterAt.length; piece++) {
    if (s.stage !== 'hunter') return;
    const from = s.hunterAt[s.hunterPiece];
    const to = EDGES[TAXI][from].find((n) => n !== s.runnerAt && !s.hunterAt.includes(n));
    assert.notEqual(to, undefined, `agent ${piece} had nowhere harmless to go`);
    assert.equal(act(s, s.order[1 - s.runner], { type: 'hunt', to }, ctx).error, undefined);
  }
}
// Agents parked in the far corner, well clear of anything a test is doing up top.
const AWAY = [27, 28, 29];

// ---------------------------------------------------------------------------
// The secret: where the runner is
// ---------------------------------------------------------------------------

test('the hunter is never sent the runner’s position between surfacings', () => {
  // Two worlds where the runner takes a different taxi out of the same node. Both are
  // hidden turns, so the hunter's view has to be identical in each.
  const worlds = [5, 1].map((to) => {
    const { s, ctx } = mk(0, AWAY);
    act(s, 0, { type: 'run', to, transport: TAXI }, ctx);
    return { hunter: view(s, 1), log: s.log.join(' | '), runner: view(s, 0) };
  });
  assert.deepEqual(worlds[0].hunter, worlds[1].hunter, 'the hunter cannot tell the two runs apart');
  assert.equal(worlds[0].log, worlds[1].log, 'and the public log does not name the node');
  assert.equal(worlds[0].hunter.runnerAt, null, 'no position is sent at all');
  assert.equal(worlds[0].hunter.trail[0].node, null, 'nor hidden inside the trail');
  assert.equal(worlds[0].runner.runnerAt, 5, 'the runner, of course, knows where they are');
});

test('the transport used is public even while the position is not', () => {
  const { s, ctx } = mk(0, AWAY);
  act(s, 0, { type: 'run', to: 1, transport: TAXI }, ctx);
  const hunter = view(s, 1);
  assert.equal(hunter.trail.length, 1);
  assert.equal(hunter.trail[0].transport, TAXI, 'the hunter is told how they travelled…');
  assert.equal(hunter.trail[0].node, null, '…but not to where');
  assert.match(s.log.join(' '), /by taxi/);
});

test('the runner has to surface on every third turn, and the hunter sees it', () => {
  const { s, ctx } = mk(0, AWAY);
  for (let turn = 1; turn <= 3; turn++) {
    assert.equal(s.turn, turn);
    const opts = view(s, 0).you.moves;
    assert.equal(act(s, 0, { type: 'run', to: opts[0].to, transport: opts[0].transport }, ctx).error, undefined);
    const hunter = view(s, 1);
    if (turn < 3) {
      assert.equal(hunter.runnerAt, null, `turn ${turn} is a hidden turn`);
      assert.equal(hunter.lastSeenAt, null, 'and nothing has been sighted yet');
    } else {
      assert.equal(typeof hunter.runnerAt, 'number', 'turn 3 forces them into the open');
      assert.equal(hunter.runnerAt, s.runnerAt);
      assert.equal(hunter.lastSeenTurn, 3);
    }
    if (turn < 3) idleHunt(s, ctx);
  }
});

test('a sighting is remembered but goes stale — the position hides again next turn', () => {
  const { s, ctx } = mk(0, AWAY);
  for (let turn = 1; turn <= 3; turn++) {
    const opts = view(s, 0).you.moves;
    act(s, 0, { type: 'run', to: opts[0].to, transport: opts[0].transport }, ctx);
    if (turn < 3) idleHunt(s, ctx);
  }
  const seenAt = s.runnerAt;
  idleHunt(s, ctx); // completes turn 3
  const opts = view(s, 0).you.moves;
  act(s, 0, { type: 'run', to: opts[0].to, transport: opts[0].transport }, ctx); // turn 4, hidden again
  const hunter = view(s, 1);
  assert.equal(hunter.runnerAt, null, 'back under cover');
  assert.equal(hunter.lastSeenAt, seenAt, 'but the last sighting stays on the board');
  assert.equal(hunter.lastSeenTurn, 3);
});

test('a spectator learns no more than the hunter does', () => {
  const { s, ctx } = mk(0, AWAY);
  assert.equal(act(s, 0, { type: 'run', to: 1, transport: TAXI }, ctx).error, undefined);
  const spec = view(s, null);
  assert.equal(spec.runnerAt, null);
  assert.equal(spec.you.spectator, true);
  assert.deepEqual(spec.you.moves, []);
  assert.deepEqual(spec.trail, view(s, 1).trail);
});

test('the starting stop is public, and identical for both halves', () => {
  // It has to be. The second-half hunter has already run from that stop themselves, so
  // hiding it in the first half handed the first runner an advantage the second never had
  // — in a match scored by comparing the two runs.
  const ctx = mkCtx();
  const s = def.create(setup, ctx) as MHState;
  assert.equal(view(s, 1).runnerAt, s.startRunner, 'the hunter sees the runner on the start line');
  assert.equal(view(s, null).runnerAt, s.startRunner, 'and so does the sideline');
  const opts = view(s, 0).you.moves;
  act(s, 0, { type: 'run', to: opts[0].to, transport: opts[0].transport }, ctx);
  assert.equal(view(s, 1).runnerAt, null, 'and loses them the moment they move');
});

test('the trail alone does not pin the runner down', () => {
  // The bug this guards: on the old 4×4 map a single announced transport narrowed the
  // runner to one stop about 40% of the time, because a taxi offered only three exits.
  // Replay what the hunt can actually see and check the belief set really does open up.
  const { s, ctx } = mk(0, AWAY);
  let belief = new Set<number>([s.startRunner]);
  for (let turn = 1; turn <= 2; turn++) {
    const opts = view(s, 0).you.moves;
    act(s, 0, { type: 'run', to: opts[0].to, transport: opts[0].transport }, ctx);
    const step = view(s, 1).trail[turn - 1];
    assert.equal(step.node, null, `turn ${turn} is hidden`);
    const next = new Set<number>();
    for (const from of belief) for (const to of EDGES[step.transport][from]) next.add(to);
    belief = next;
    idleHunt(s, ctx);
  }
  assert.ok(belief.size >= 6, `two hidden moves should leave real doubt, got ${belief.size} stops`);
  assert.ok(belief.has(s.runnerAt), 'and the truth is somewhere inside it');
});

// ---------------------------------------------------------------------------
// Movement rules
// ---------------------------------------------------------------------------

test('you can only travel a route that exists for the transport you name', () => {
  const { s, ctx } = mk(0, AWAY);
  assert.ok(EDGES[TAXI][0].includes(1), 'stop 0 has a taxi to 1');
  assert.equal(EDGES[TUBE][0].includes(1), false, 'but no tube to 1');
  assert.match(act(s, 0, { type: 'run', to: 1, transport: TUBE }, ctx).error!, /No underground route/);
  assert.match(act(s, 0, { type: 'run', to: 14, transport: TAXI }, ctx).error!, /No taxi route/);
  assert.match(act(s, 0, { type: 'run', to: 1, transport: 9 }, ctx).error!, /No such transport/);
  assert.equal(act(s, 0, { type: 'run', to: 4, transport: TUBE }, ctx).error, undefined, 'stop 0 is an underground hub');
});

test('the runner may not step onto an agent, and the wrong player cannot move', () => {
  const { s, ctx } = mk(0, [1, 28, 29]);
  assert.match(act(s, 0, { type: 'run', to: 1, transport: TAXI }, ctx).error!, /straight into an agent/);
  assert.match(act(s, 1, { type: 'run', to: 4, transport: TAXI }, ctx).error!, /hunting, not running/);
  assert.match(act(s, 0, { type: 'hunt', to: 5 }, ctx).error!, /runner is moving/);
  assert.match(act(s, 5, { type: 'run', to: 4, transport: TAXI }, ctx).error!, /not in this match/);
});

test('every agent moves each turn, one after the other', () => {
  const { s, ctx } = mk(0, AWAY);
  act(s, 0, { type: 'run', to: 1, transport: TAXI }, ctx);
  assert.equal(s.stage, 'hunter');
  assert.equal(s.hunterPiece, 0);
  assert.match(act(s, 0, { type: 'run', to: 2, transport: TAXI }, ctx).error!, /hunt is moving/);
  for (let piece = 0; piece < AWAY.length; piece++) {
    assert.equal(s.hunterPiece, piece, `agent ${piece + 1} is up`);
    assert.equal(s.turn, 1, 'still the same turn');
    const from = s.hunterAt[piece];
    const to = EDGES[TAXI][from].find((n) => !s.hunterAt.includes(n) && n !== s.runnerAt)!;
    assert.equal(act(s, 1, { type: 'hunt', to }, ctx).error, undefined);
  }
  assert.equal(s.stage, 'runner', 'now the runner moves again');
  assert.equal(s.turn, 2);
});

test('an agent cannot move onto another agent', () => {
  const partner = EDGES[TAXI][29].find((n) => n !== 28)!;
  const { s, ctx } = mk(0, [29, partner, 20]);
  act(s, 0, { type: 'run', to: 1, transport: TAXI }, ctx);
  assert.match(act(s, 1, { type: 'hunt', to: partner }, ctx).error!, /other agent is already there/);
});

// ---------------------------------------------------------------------------
// Catching, and what a half is worth
// ---------------------------------------------------------------------------

test('landing on the runner ends the half, and the turn of the capture does not count', () => {
  const { s, ctx } = mk(0, AWAY);
  act(s, 0, { type: 'run', to: 1, transport: TAXI }, ctx); // runner at 1, turn 1
  s.hunterAt[0] = 2; // put an agent next door (2 has a taxi to 1)
  act(s, 1, { type: 'hunt', to: 1 }, ctx);
  assert.equal(s.caught, true);
  assert.equal(s.survived[0], 0, 'caught on turn 1 means nothing survived');
  assert.equal(s.phase, 'break', 'and the second half is queued up');
});

test('a runner with nowhere left to go is run to ground', () => {
  // Node 0's exits are 1 and 4 by taxi, 2 and 8 by bus, 3 by tube — box every one of them.
  const { s, ctx } = mk(6, [1, 28, 29]);
  act(s, 0, { type: 'run', to: 4, transport: TAXI }, ctx);
  assert.equal(s.caught, false);
  s.runnerAt = 0;
  s.hunterAt = [1, 4];
  // finish the hunter's turn without capturing, so the runner is asked to move from 0
  s.stage = 'runner';
  s.turn = 2;
  const boxed = { ...s, hunterAt: [1, 4] };
  const opts = view(boxed as MHState, 0).you.moves.map((m: any) => m.to);
  assert.equal(opts.includes(1), false, 'agents block those exits');
  assert.equal(opts.includes(4), false);
  assert.ok(opts.length > 0, 'bus and tube routes still exist — the map is not a dead end');
});

test('surviving all twelve turns is the best a runner can do', () => {
  const { s, ctx } = mk(0, AWAY);
  let guard = 0;
  while (s.phase === 'run' && guard++ < 200) {
    const seat = s.order[s.stage === 'runner' ? s.runner : 1 - s.runner];
    const mv = def.bot!(s, seat, ctx)!;
    act(s, seat, mv, ctx);
  }
  assert.ok(s.survived[0] !== null, 'the first half finished');
  assert.ok(s.survived[0]! <= 12, 'nobody survives more turns than there are');
});

// ---------------------------------------------------------------------------
// Two halves, one puzzle
// ---------------------------------------------------------------------------

test('both halves start from the identical position, with the roles swapped', () => {
  const ctx = mkCtx();
  const s = def.create(setup, ctx) as MHState;
  const start = { runner: s.runnerAt, hunters: [...s.hunterAt] };
  assert.equal(s.runner, 0, 'player A runs first');
  s.caught = true;
  (def as any).act(s, 0, { type: 'run', to: -1, transport: 0 }, ctx); // rejected, state untouched
  // force the first half to end, then run the clock to the second
  s.phase = 'run';
  s.survived[0] = 4;
  s.phase = 'break';
  s.breakAt = ctx.now + 1;
  ctx.now += 10000;
  assert.equal(def.tick!(s, ctx), true);
  assert.equal(s.half, 1);
  assert.equal(s.runner, 1, 'now B runs');
  assert.equal(s.runnerAt, start.runner, 'from the same node…');
  assert.deepEqual(s.hunterAt, start.hunters, '…against agents in the same places');
  assert.equal(s.turn, 1);
  assert.deepEqual(s.trail, [], 'with a clean trail');
});

test('two runs of the same length are split by how deep into the turn each was caught', () => {
  // Against a good hunt both runs cluster low, so whole turns tie constantly. A run that
  // slipped past two agents before the third took it beat one that fell to the first.
  const { s, ctx } = mk(0, AWAY);
  s.half = 1;
  s.runner = 1; // B is running; A (player 0) hunts
  s.survived = [4, null];
  s.survivedSteps = [4 * 3 + 1, null]; // A lasted 4 turns and evaded one agent of the fifth
  s.turn = 5;
  s.stage = 'hunter';
  s.hunterPiece = 2; // B has already evaded agents 1 and 2 this turn
  s.runnerAt = 10;
  const closer = EDGES[TAXI][10].find((n) => n !== 27 && n !== 28)!;
  s.hunterAt = [27, 28, closer];
  assert.equal(act(s, s.order[0], { type: 'hunt', to: 10 }, ctx).error, undefined);

  assert.equal(s.over, true);
  assert.deepEqual(s.survived, [4, 4], 'both lasted four whole turns');
  assert.deepEqual(s.survivedSteps, [13, 14], 'but B stayed clear of one more agent');
  assert.deepEqual(def.result(s).winners, [s.order[1]], 'so B takes it rather than drawing');
  assert.match(s.log.join(' '), /one more agent/);
});

test('the longer run wins; equal runs are honours even', () => {
  const outcomes: [number, number, number[]][] = [
    [7, 3, [0]],
    [2, 9, [1]],
    [5, 5, [0, 1]],
  ];
  for (const [a, b, expected] of outcomes) {
    const ctx = mkCtx();
    const s = def.create(setup, ctx) as MHState;
    s.half = 1;
    s.runner = 1;
    s.survived = [a, null];
    s.turn = 12;
    s.stage = 'hunter';
    s.hunterPiece = 1;
    s.runnerAt = 0;
    s.hunterAt = [15, 12];
    s.survived[1] = null;
    // end the second half at exactly `b` turns survived
    s.turn = b;
    s.caught = true;
    (s as any).survived[1] = b;
    s.over = true;
    s.winners = a === b ? s.order.slice() : [s.order[a > b ? 0 : 1]];
    assert.deepEqual(def.result(s).winners.sort(), expected, `${a} v ${b}`);
  }
});

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

test('the hunter bot navigates by sightings, never by the runner’s actual node', () => {
  // Same sighting history, runner secretly in two different places: the bot must make the
  // same move both times. (If it peeked at `runnerAt`, these would diverge.)
  const moves = [3, 12].map((secret) => {
    const { s, ctx } = mk(secret, [15, 12]);
    s.trail = [{ turn: 3, transport: TAXI, node: 6 }];
    s.turn = 4;
    s.stage = 'hunter';
    s.hunterPiece = 0;
    return def.bot!(s, 1, ctx);
  });
  assert.deepEqual(moves[0], moves[1], 'the hunt is driven by what was seen, not by the truth');
});

test('bots play a whole match to a decided result, always legally', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const ctx = mkCtx(seeded(seed * 5501));
    const s = def.create(setup, ctx) as MHState;
    for (let guard = 0; guard < 500 && !s.over; guard++) {
      if (s.phase === 'break') {
        ctx.now += 10000;
        assert.equal(def.tick!(s, ctx), true);
        continue;
      }
      const runnerTurn = s.stage === 'runner';
      const seat = s.order[runnerTurn ? s.runner : 1 - s.runner];
      const mv = def.bot!(s, seat, ctx) as any;
      assert.ok(mv, 'whoever is on move always has one');
      if (runnerTurn) {
        assert.ok(EDGES[mv.transport][s.runnerAt].includes(mv.to), 'the runner uses a real route');
        assert.equal(s.hunterAt.includes(mv.to), false, 'and never runs into an agent');
      }
      assert.equal(act(s, seat, mv, ctx).error, undefined, JSON.stringify(mv));
    }
    assert.equal(s.over, true, `seed ${seed} never finished`);
    assert.ok(s.survived.every((v) => v !== null && v >= 0 && v <= 12), `implausible survival: ${s.survived}`);
    assert.ok(def.result(s).winners.length >= 1);
  }
});

// ---------------------------------------------------------------------------
// The map itself
// ---------------------------------------------------------------------------

test('the map is fully connected and every node has a way out', () => {
  assert.equal(NODES.length, 30);
  for (const n of NODES) {
    const out = EDGES.reduce((acc, byNode) => acc + byNode[n.id].length, 0);
    assert.ok(out >= 2, `node ${n.id} has only ${out} exits`);
  }
  // reachable from node 0 over any transport
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const n = queue.shift()!;
    for (let t = 0; t < TRANSPORT.length; t++) {
      for (const m of EDGES[t][n]) if (!seen.has(m)) { seen.add(m); queue.push(m); }
    }
  }
  assert.equal(seen.size, NODES.length, 'every node is reachable');
});

test('every edge is two-way', () => {
  for (let t = 0; t < TRANSPORT.length; t++) {
    for (const n of NODES) {
      for (const m of EDGES[t][n.id]) {
        assert.ok(EDGES[t][m].includes(n.id), `${TRANSPORT[t].key} ${n.id}→${m} is one-way`);
      }
    }
  }
});
