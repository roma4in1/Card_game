// game.test.ts — Half a Game: dealing a Hold'em hand a step at a time, with no chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfGame, type HGState } from './game.ts';
import { parse } from '../shared/poker.ts';
import type { GameContext } from '../../platform/types.ts';

const seeded = (n: number) => { let a = n >>> 0; return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296); };
const ctx: GameContext = { rng: seeded(9), now: 0 };
function newGame(n: number): HGState {
  const seats = Array.from({ length: n }, (_, i) => i);
  return halfGame.create({ seats, players: seats.map((seat) => ({ seat, name: 'P' + seat })) }, ctx) as HGState;
}
const act = (s: HGState, seat: number, msg: Record<string, unknown>) => halfGame.act(s, seat, msg, ctx) ?? {};
const view = (s: HGState, seat: number) => halfGame.view(s, seat) as any;
const allReady = (s: HGState) => { for (const seat of s.seats) if (!s.players[seat]!.folded || s.stage === 'showdown') act(s, seat, { type: 'ready' }); };

test('each player is dealt two cards, and nobody sees anyone else’s', () => {
  const s = newGame(4);
  const cards = s.seats.flatMap((seat) => s.players[seat]!.hole);
  assert.equal(cards.length, 8);
  assert.equal(new Set(cards).size, 8, 'no card dealt twice');
  const v = view(s, 0);
  assert.equal(v.you.hole.length, 2);
  for (const p of v.players) assert.equal(p.shown, null);
  for (const seat of [1, 2, 3]) {
    for (const c of view(s, seat).you.hole) assert.ok(!JSON.stringify(v).includes(`"${c}"`), `seat ${seat}'s ${c} is not in seat 0's view`);
  }
});

test('the board comes out a step at a time, once everyone still in is ready', () => {
  const s = newGame(3);
  assert.equal(s.stage, 'preflop');
  act(s, 0, { type: 'ready' });
  act(s, 1, { type: 'ready' });
  assert.equal(s.stage, 'preflop', 'still waiting for one player');
  assert.equal(view(s, 2).waiting, 1);
  act(s, 2, { type: 'ready' });
  assert.equal(s.stage, 'flop');
  assert.equal(s.board.length, 3);
  allReady(s);
  assert.equal(s.stage, 'turn');
  assert.equal(s.board.length, 4);
  allReady(s);
  assert.equal(s.stage, 'river');
  assert.equal(s.board.length, 5);
  allReady(s);
  assert.equal(s.stage, 'showdown');
  assert.equal(s.result?.kind, 'showdown');
});

test('a player can take back their ready before the others are', () => {
  const s = newGame(2);
  act(s, 0, { type: 'ready' });
  act(s, 0, { type: 'ready', ready: false });
  act(s, 1, { type: 'ready' });
  assert.equal(s.stage, 'preflop');
});

test('the showdown turns over the hands still in, names them, and calls the winner', () => {
  const s = newGame(3);
  s.players[0]!.hole = ['Ah', 'Ad'].map(parse);
  s.players[1]!.hole = ['Kh', 'Kd'].map(parse);
  s.players[2]!.hole = ['2c', '7d'].map(parse);
  const board = ['As', '9c', '4h', 'Jd', '3s'].map(parse);
  const used = new Set([...board, ...s.seats.flatMap((x) => s.players[x]!.hole)]);
  s.deck = [...Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c)), ...board.reverse()];
  act(s, 2, { type: 'fold' });
  for (let i = 0; i < 4; i++) allReady(s);
  assert.equal(s.stage, 'showdown');
  assert.deepEqual(s.result?.winners, [0]);
  const v = view(s, 1);
  assert.equal(v.result.reveals.find((r: any) => r.seat === 0).hand, 'Three Aces');
  assert.ok(v.players.find((p: any) => p.seat === 0).shown, 'the winner is shown');
  assert.equal(v.players.find((p: any) => p.seat === 2).shown, null, 'the folded hand stays hidden');
});

test('when everyone else folds, the last player wins and nothing is shown', () => {
  const s = newGame(3);
  act(s, 0, { type: 'fold' });
  act(s, 1, { type: 'fold' });
  assert.equal(s.stage, 'showdown');
  assert.equal(s.result?.kind, 'fold');
  assert.deepEqual(s.result?.winners, [2]);
  assert.deepEqual(s.result?.reveals, []);
  assert.match(act(s, 0, { type: 'fold' }).error ?? '', /over/);
});

test('folded players do not hold up the hand', () => {
  const s = newGame(3);
  act(s, 1, { type: 'fold' });
  act(s, 0, { type: 'ready' });
  act(s, 2, { type: 'ready' });
  assert.equal(s.stage, 'flop');
  assert.match(act(s, 1, { type: 'ready' }).error ?? '', /folded/);
});

test('after the showdown the whole table readies up, then a fresh shuffle and the button moves on', () => {
  const s = newGame(3);
  const firstDealer = s.dealer;
  const firstHand = s.seats.map((x) => s.players[x]!.hole.join());
  for (let i = 0; i < 4; i++) allReady(s);
  assert.equal(s.stage, 'showdown');
  allReady(s);
  assert.equal(s.handNo, 2);
  assert.equal(s.stage, 'preflop');
  assert.equal(s.board.length, 0);
  assert.equal(s.deck.length, 52 - 6, 'a full deck, less the hole cards just dealt');
  assert.notEqual(s.dealer, firstDealer, 'the button moves on');
  assert.notDeepEqual(s.seats.map((x) => s.players[x]!.hole.join()), firstHand);
  for (const x of s.seats) assert.equal(s.players[x]!.folded, false, 'everyone is back in');
});

test('the blinds follow the button, heads-up included', () => {
  const s3 = newGame(3);
  assert.equal(s3.sb, s3.seats[(s3.seats.indexOf(s3.dealer) + 1) % 3]);
  assert.equal(s3.bb, s3.seats[(s3.seats.indexOf(s3.dealer) + 2) % 3]);
  const s2 = newGame(2);
  assert.equal(s2.sb, s2.dealer, 'heads-up the dealer is the small blind');
  assert.notEqual(s2.bb, s2.dealer);
});

test('a seat nobody is playing folds and readies, so the table never waits on it', () => {
  const s = newGame(3);
  const bot = (seat: number) => { const mv = halfGame.bot!(s, seat, ctx); if (mv) act(s, seat, mv); };
  bot(2);
  assert.equal(s.players[2]!.folded, true);
  act(s, 0, { type: 'ready' });
  act(s, 1, { type: 'ready' });
  assert.equal(s.stage, 'flop');
  for (let i = 0; i < 3; i++) { act(s, 0, { type: 'ready' }); act(s, 1, { type: 'ready' }); }
  assert.equal(s.stage, 'showdown');
  bot(2);
  act(s, 0, { type: 'ready' });
  act(s, 1, { type: 'ready' });
  assert.equal(s.handNo, 2);
});

test('the game runs until someone ends it', () => {
  const s = newGame(2);
  assert.equal(halfGame.result(s).over, false);
  act(s, 1, { type: 'endGame' });
  assert.equal(halfGame.result(s).over, true);
  assert.match(act(s, 0, { type: 'ready' }).error ?? '', /over/);
});
