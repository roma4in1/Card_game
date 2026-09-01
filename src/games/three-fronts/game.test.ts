// game.test.ts — Three Fronts. The load-bearing parts: a face-down card's identity, the
// strength arithmetic each theatre bonus produces, and the withdraw payout that makes
// conceding a real option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threeFronts, frontStrength, FRONTS, type TFState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const def = threeFronts;
const setup = { seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] };
const seeded = (seed: number) => {
  let a = seed;
  return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
};
const mkCtx = (rng: () => number = seeded(99)): GameContext & { now: number } => ({ rng, now: 1000 });
const act = (s: TFState, seat: number, msg: Record<string, unknown>, ctx: GameContext) => def.act(s, seat, msg, ctx) ?? {};
const view = (s: TFState, seat: number | null) => def.view(s, seat) as any;

const AIR = 0, LAND = 1, SEA = 2;
const card = (theatre: number, rank: number) => theatre * 6 + (rank - 1);

/** A battle with hands dealt by hand, A to move. */
function mk(handA: number[], handB: number[]): { s: TFState; ctx: GameContext & { now: number } } {
  const ctx = mkCtx();
  const s = def.create(setup, ctx) as TFState;
  s.hands = [[...handA], [...handB]];
  s.turn = 0;
  return { s, ctx };
}

// ---------------------------------------------------------------------------
// The secret: a face-down card
// ---------------------------------------------------------------------------

test('an opponent’s face-down card gives away nothing but its existence', () => {
  // Two worlds where A buries a different card at the same front — B must see one and
  // the same thing, and the log (which is public) must not name it either.
  const worlds = [card(AIR, 6), card(AIR, 1)].map((cardId) => {
    const { s, ctx } = mk([cardId, card(SEA, 3)], [card(LAND, 2), card(LAND, 4)]);
    act(s, 0, { type: 'deploy', cardId, front: SEA, faceDown: true }, ctx);
    return { theirs: view(s, 1), log: s.log.join(' | ') };
  });
  assert.deepEqual(worlds[0].theirs, worlds[1].theirs, 'B cannot tell a buried 6 from a buried 1');
  assert.equal(worlds[0].log, worlds[1].log, 'and the public log does not name it either');

  const play = worlds[0].theirs.board[SEA].plays[0];
  assert.equal(play.faceDown, true, 'B knows something is there…');
  assert.equal(play.cardId, null, '…and nothing else about it');
  assert.equal(play.rank, null);
  assert.equal(worlds[0].theirs.board[SEA].strength[0], 2, 'it musters a flat 2 from where B stands');
});

test('you can always see your own face-down cards', () => {
  const { s, ctx } = mk([card(AIR, 6)], [card(LAND, 2)]);
  act(s, 0, { type: 'deploy', cardId: card(AIR, 6), front: SEA, faceDown: true }, ctx);
  const mine = view(s, 0).board[SEA].plays[0];
  assert.equal(mine.rank, 6, 'you know what you buried');
  assert.equal(mine.mine, true);
});

test('every card turns over once the battle is decided', () => {
  const { s, ctx } = mk([card(AIR, 6)], [card(LAND, 2)]);
  act(s, 0, { type: 'deploy', cardId: card(AIR, 6), front: SEA, faceDown: true }, ctx);
  assert.equal(view(s, 1).board[SEA].plays[0].rank, null, 'hidden while the battle runs');
  act(s, 1, { type: 'deploy', cardId: card(LAND, 2), front: LAND, faceDown: false }, ctx); // both hands empty
  assert.equal(s.phase, 'result');
  assert.equal(view(s, 1).board[SEA].plays[0].rank, 6, 'and revealed the moment it ends');
});

// ---------------------------------------------------------------------------
// Deployment rules
// ---------------------------------------------------------------------------

test('a face-up card must go to its own theatre; face-down goes anywhere', () => {
  const { s, ctx } = mk([card(AIR, 5), card(SEA, 3)], [card(LAND, 2), card(LAND, 4)]);
  assert.match(act(s, 0, { type: 'deploy', cardId: card(AIR, 5), front: SEA, faceDown: false }, ctx).error!, /own theatre/);
  assert.equal(act(s, 0, { type: 'deploy', cardId: card(AIR, 5), front: SEA, faceDown: true }, ctx).error, undefined, 'face-down may go anywhere');
  assert.equal(s.turn, 1, 'and the turn passes');
});

test('you cannot deploy a card you do not hold, to a front that does not exist, or out of turn', () => {
  const { s, ctx } = mk([card(AIR, 5)], [card(LAND, 2)]);
  assert.match(act(s, 0, { type: 'deploy', cardId: card(SEA, 6), front: SEA, faceDown: true }, ctx).error!, /not in your hand/);
  assert.match(act(s, 0, { type: 'deploy', cardId: card(AIR, 5), front: 7, faceDown: true }, ctx).error!, /No such front/);
  assert.match(act(s, 1, { type: 'deploy', cardId: card(LAND, 2), front: LAND, faceDown: false }, ctx).error!, /Not your turn/);
  assert.match(act(s, 5, { type: 'withdraw' }, ctx).error!, /not in this match/);
});

test('a player out of cards is skipped, not asked to play', () => {
  const { s, ctx } = mk([card(AIR, 5)], [card(LAND, 2), card(LAND, 3)]);
  act(s, 0, { type: 'deploy', cardId: card(AIR, 5), front: AIR, faceDown: false }, ctx); // A is now empty
  act(s, 1, { type: 'deploy', cardId: card(LAND, 2), front: LAND, faceDown: false }, ctx);
  assert.equal(s.phase, 'battle', 'B still holds a card, so the battle continues');
  assert.equal(s.turn, 1, 'and it stays with B rather than passing to an empty hand');
  act(s, 1, { type: 'deploy', cardId: card(LAND, 3), front: LAND, faceDown: true }, ctx);
  assert.equal(s.phase, 'result', 'both hands empty ends it');
});

// ---------------------------------------------------------------------------
// The three bonuses
// ---------------------------------------------------------------------------

test('Recon lifts your buried cards at Air from 2 to 3', () => {
  const { s, ctx } = mk([card(AIR, 1), card(SEA, 4)], [card(LAND, 2), card(LAND, 3)]);
  act(s, 0, { type: 'deploy', cardId: card(SEA, 4), front: AIR, faceDown: true }, ctx);
  assert.equal(frontStrength(s, AIR, 0), 2, 'a buried card is worth 2 on its own');
  s.turn = 0;
  act(s, 0, { type: 'deploy', cardId: card(AIR, 1), front: AIR, faceDown: false }, ctx);
  // the Air 1 itself adds 1, and Recon lifts the buried card 2 → 3
  assert.equal(frontStrength(s, AIR, 0), 4, 'Recon is worth more than the card that brings it');
  assert.equal(frontStrength(s, AIR, 1), 0, 'and does nothing for the other side');
});

test('Entrench adds one for every card you hold at Land, as they arrive', () => {
  const { s, ctx } = mk([card(LAND, 2), card(AIR, 5), card(SEA, 5)], [card(AIR, 1), card(AIR, 2), card(AIR, 3)]);
  act(s, 0, { type: 'deploy', cardId: card(LAND, 2), front: LAND, faceDown: false }, ctx);
  assert.equal(frontStrength(s, LAND, 0), 3, 'rank 2, plus 1 for the single card held');
  s.turn = 0;
  act(s, 0, { type: 'deploy', cardId: card(AIR, 5), front: LAND, faceDown: true }, ctx);
  assert.equal(frontStrength(s, LAND, 0), 6, '2 + 2 buried, plus 1 each for two cards');
});

test('Blockade shuts the opponent out of Sea face-downs, but not your own', () => {
  const { s, ctx } = mk([card(SEA, 4), card(AIR, 1)], [card(LAND, 2), card(LAND, 5)]);
  act(s, 0, { type: 'deploy', cardId: card(SEA, 4), front: SEA, faceDown: false }, ctx);
  assert.match(act(s, 1, { type: 'deploy', cardId: card(LAND, 2), front: SEA, faceDown: true }, ctx).error!, /blockaded/);
  assert.equal(act(s, 1, { type: 'deploy', cardId: card(LAND, 2), front: LAND, faceDown: true }, ctx).error, undefined, 'other fronts stay open');
  assert.equal(act(s, 0, { type: 'deploy', cardId: card(AIR, 1), front: SEA, faceDown: true }, ctx).error, undefined, 'your own blockade never blocks you');
  assert.deepEqual(view(s, 1).you.blocked, [false, false, true], 'and the client is told which front is shut');
});

// ---------------------------------------------------------------------------
// Winning a battle, and the price of walking away
// ---------------------------------------------------------------------------

test('the battle goes to whoever holds more fronts; a fought-out win is worth 6', () => {
  const { s, ctx } = mk([card(AIR, 6), card(LAND, 6)], [card(SEA, 6), card(AIR, 1)]);
  act(s, 0, { type: 'deploy', cardId: card(AIR, 6), front: AIR, faceDown: false }, ctx);
  act(s, 1, { type: 'deploy', cardId: card(SEA, 6), front: SEA, faceDown: false }, ctx);
  act(s, 0, { type: 'deploy', cardId: card(LAND, 6), front: LAND, faceDown: false }, ctx);
  act(s, 1, { type: 'deploy', cardId: card(AIR, 1), front: AIR, faceDown: false }, ctx);
  assert.equal(s.phase, 'result');
  assert.deepEqual(s.scores, [6, 0], 'A held Air and Land, B only Sea');
  assert.equal(s.result!.points, 6);
});

test('an even battle is a stalemate worth nothing to either side', () => {
  // Air and Sea, deliberately: Recon only lifts buried cards and Blockade adds nothing, so
  // both sides really do muster 4. (Land would not be level — Entrench is the one bonus
  // that adds raw strength, and it would quietly make this 5 v 4.)
  const { s, ctx } = mk([card(AIR, 4)], [card(SEA, 4)]);
  act(s, 0, { type: 'deploy', cardId: card(AIR, 4), front: AIR, faceDown: false }, ctx);
  act(s, 1, { type: 'deploy', cardId: card(SEA, 4), front: SEA, faceDown: false }, ctx);
  assert.deepEqual([frontStrength(s, AIR, 0), frontStrength(s, SEA, 1)], [4, 4], 'genuinely level');
  assert.equal(s.result!.winner, null, 'one front each, equal strength');
  assert.deepEqual(s.scores, [0, 0]);
  assert.match(s.log.join(' '), /stalemate/);
});

test('withdrawing early is cheap; withdrawing with nothing left is nearly a full defeat', () => {
  const table: [number, number][] = [[6, 2], [4, 2], [3, 3], [2, 3], [1, 4], [0, 4]];
  for (const [cardsLeft, expected] of table) {
    const hand = Array.from({ length: cardsLeft }, (_, i) => card(AIR, i + 1));
    const { s, ctx } = mk(hand, [card(LAND, 1)]);
    act(s, 0, { type: 'withdraw' }, ctx);
    assert.equal(s.scores[1], expected, `withdrawing with ${cardsLeft} in hand should pay ${expected}`);
    assert.equal(s.result!.withdrew, 0);
  }
});

test('a withdrawal never pays more than fighting the battle out', () => {
  for (let left = 0; left <= 6; left++) {
    const hand = Array.from({ length: left }, (_, i) => card(AIR, i + 1));
    const { s, ctx } = mk(hand, [card(LAND, 1)]);
    act(s, 0, { type: 'withdraw' }, ctx);
    assert.ok(s.scores[1] < 6, `conceding with ${left} cards paid ${s.scores[1]}, which is no cheaper than losing outright`);
  }
});

// ---------------------------------------------------------------------------
// Battles, the match, and the clock between them
// ---------------------------------------------------------------------------

test('the loser opens the next battle, and a fresh deal follows the result pause', () => {
  const { s, ctx } = mk([card(AIR, 6)], [card(LAND, 1)]);
  act(s, 0, { type: 'deploy', cardId: card(AIR, 6), front: AIR, faceDown: false }, ctx);
  act(s, 1, { type: 'deploy', cardId: card(LAND, 1), front: LAND, faceDown: false }, ctx);
  const winner = s.result!.winner!;
  assert.equal(s.phase, 'result');
  assert.match(act(s, 0, { type: 'withdraw' }, ctx).error!, /Wait for the next battle/);

  ctx.now += 100;
  assert.equal(def.tick!(s, ctx), false, 'the finished battle stays up a moment');
  ctx.now += 9000;
  assert.equal(def.tick!(s, ctx), true);
  assert.equal(s.phase, 'battle');
  assert.equal(s.turn, 1 - winner, 'the loser opens');
  assert.deepEqual(s.hands.map((h) => h.length), [6, 6], 'six fresh cards each');
  assert.equal(s.battleNo, 2);
});

test('a deal is six cards each out of eighteen, with six left out of the battle', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const s = def.create(setup, mkCtx(seeded(seed * 613))) as TFState;
    const all = [...s.hands[0], ...s.hands[1]];
    assert.equal(all.length, 12);
    assert.equal(new Set(all).size, 12, 'no card is dealt twice');
    assert.ok(all.every((c) => c >= 0 && c < 18), 'every card comes from the 18');
  }
});

test('first to the target wins the war, and the match ends the moment it is reached', () => {
  const { s, ctx } = mk([card(AIR, 6)], [card(LAND, 1)]);
  s.scores = [s.target - 6, 0]; // one fought-out battle from the win
  act(s, 0, { type: 'deploy', cardId: card(AIR, 6), front: AIR, faceDown: false }, ctx);
  act(s, 1, { type: 'deploy', cardId: card(LAND, 1), front: LAND, faceDown: false }, ctx);
  assert.equal(s.over, true);
  assert.equal(s.phase, 'done');
  assert.deepEqual(def.result(s).winners, [0]);
  assert.equal(def.tick!(s, ctx), false, 'no further battles are dealt');
  assert.match(act(s, 0, { type: 'withdraw' }, ctx).error!, /war is over/);
});

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

test('the bot only ever makes legal moves, and drives a match to a winner', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const ctx = mkCtx(seeded(seed * 7717));
    const s = def.create(setup, ctx) as TFState;
    for (let guard = 0; guard < 4000 && !s.over; guard++) {
      const seat = s.order[s.turn];
      const mv = def.bot!(s, seat, ctx) as any;
      if (!mv) {
        ctx.now += 9000;
        assert.equal(def.tick!(s, ctx), true, 'between battles the clock moves things on');
        continue;
      }
      if (mv.type === 'deploy') {
        assert.ok(s.hands[s.turn].includes(mv.cardId), 'the bot plays from its own hand');
        if (!mv.faceDown) assert.equal(Math.floor(mv.cardId / 6), mv.front, 'face-up only in its own theatre');
        else assert.equal(s.blocked[s.turn][mv.front], false, 'never into a blockade');
      }
      assert.equal(act(s, seat, mv, ctx).error, undefined, JSON.stringify(mv));
    }
    assert.equal(s.over, true, `seed ${seed} never finished`);
    assert.equal(def.result(s).winners.length, 1);
    assert.ok(Math.max(...s.scores) >= s.target, 'the winner actually reached the target');
  }
});

test('the bot walks away only from a battle that is genuinely lost', () => {
  // Hopeless on purpose: A holds all three fronts, and the Sea front is BLOCKADED, so B —
  // holding no Sea cards — cannot legally place anything there at all. That caps B at one
  // front. Taking Air needs three of B's four cards, which leaves one for Land, and one
  // card cannot reach 8. Fighting on costs 6; conceding with four in hand costs 2.
  const { s, ctx } = mk([], [card(AIR, 1), card(AIR, 2), card(LAND, 1), card(LAND, 2)]);
  s.fronts[AIR] = [{ pid: 0, cardId: card(AIR, 6), faceDown: false }];
  s.fronts[LAND] = [{ pid: 0, cardId: card(LAND, 6), faceDown: false }];
  s.fronts[SEA] = [{ pid: 0, cardId: card(SEA, 6), faceDown: false }];
  s.recon[0][AIR] = true;
  s.entrench[0][LAND] = true;
  s.blocked[1][SEA] = true; // A's Sea card blockaded B out of that front
  s.turn = 1;
  assert.deepEqual(def.bot!(s, 1, ctx), { type: 'withdraw' });
});

test('the bot does not concede a battle it can still win with a Recon line', () => {
  // The same shape but WITHOUT the blockade, and this one is winnable: bury both Sea cards
  // behind a face-up Air 2 — Recon lifts them from 2 to 3 each, for 8 against A's 6 — then
  // take the empty Sea front with the spare Air 1. Two fronts to one. A bot that only
  // looks one card ahead cannot see it and throws away 2 points conceding.
  const { s, ctx } = mk([], [card(AIR, 1), card(AIR, 2), card(SEA, 1), card(SEA, 2)]);
  s.fronts[AIR] = [{ pid: 0, cardId: card(AIR, 6), faceDown: false }];
  s.fronts[LAND] = [{ pid: 0, cardId: card(LAND, 6), faceDown: false }];
  s.recon[0][AIR] = true;
  s.entrench[0][LAND] = true;
  s.turn = 1;
  const mv = def.bot!(s, 1, ctx) as any;
  assert.notEqual(mv.type, 'withdraw', 'this battle is there to be won');

  // and play the line out to prove the win is real, not just the bot's opinion
  for (const step of [
    { cardId: card(AIR, 2), front: AIR, faceDown: false },
    { cardId: card(SEA, 1), front: AIR, faceDown: true },
    { cardId: card(SEA, 2), front: AIR, faceDown: true },
    { cardId: card(AIR, 1), front: SEA, faceDown: true },
  ]) {
    s.turn = 1;
    assert.equal(act(s, 1, { type: 'deploy', ...step }, ctx).error, undefined);
  }
  assert.equal(frontStrength(s, AIR, 1), 8, 'Recon turned two buried 1s and 2s into 3s');
  assert.equal(s.result!.winner, 1, 'B takes Air and Sea');
  assert.deepEqual(s.scores, [0, 6]);
});

test('view is consistent for both seats on everything that is public', () => {
  const { s, ctx } = mk([card(AIR, 5), card(SEA, 2)], [card(LAND, 3), card(LAND, 4)]);
  act(s, 0, { type: 'deploy', cardId: card(AIR, 5), front: AIR, faceDown: false }, ctx);
  act(s, 1, { type: 'deploy', cardId: card(LAND, 3), front: LAND, faceDown: true }, ctx);
  const a = view(s, 0);
  const b = view(s, 1);
  assert.deepEqual(a.players, b.players, 'scores, hand sizes and fronts held match');
  assert.deepEqual(a.board.map((f: any) => f.strength), b.board.map((f: any) => f.strength), 'so does every strength total');
  assert.deepEqual(a.board.map((f: any) => f.control), b.board.map((f: any) => f.control));
  assert.equal(a.you.hand.length, 1);
  assert.equal(b.you.hand.length, 1);
});
