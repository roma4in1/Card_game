// game.test.ts — Who Am I? The server is the oracle: each question type must answer
// correctly from a known target, the target must stay hidden until a round ends, and
// wrong-guess elimination / round resolution must be exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWhoAmI, continentOf, type WAState, type PlayerCard } from './game.ts';
import { WORD_BANK } from '../spy-game/wordbank.ts';
import type { GameContext, GameDef } from '../../platform/types.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
const ctx = (): GameContext => ({ rng: lcg(1), now: 0 });

const BANK: PlayerCard[] = [
  { name: 'Pedri', nationality: 'Spain', positions: ['CM', 'CAM'], leagues: ['La Liga'], marketValue: 140e6, status: 'active', eraOfPlay: '2020s' },
  { name: 'Iker Casillas', nationality: 'Spain', positions: ['GK'], leagues: [], marketValue: null, status: 'retired', eraOfPlay: '2010s' },
  { name: 'Vinicius', nationality: 'Brazil', positions: ['LW', 'ST'], leagues: ['La Liga'], marketValue: 200e6, status: 'active', eraOfPlay: '2020s' },
  { name: 'Virgil van Dijk', nationality: 'Netherlands', positions: ['CB'], leagues: ['Premier League'], marketValue: 45e6, status: 'active', eraOfPlay: '2020s' },
];

function newGame(np = 2, opts: Record<string, number> = { rounds: 1 }, targetName = 'Pedri') {
  const def = createWhoAmI(BANK) as GameDef<WAState>;
  const seats = Array.from({ length: np }, (_, i) => i);
  const players = seats.map((x) => ({ seat: x, name: 'P' + x }));
  const s = def.create({ seats, players, options: opts }, ctx()) as WAState;
  s.targetIdx = BANK.findIndex((p) => p.name === targetName);
  return { def, s };
}
const askBy = (def: GameDef<WAState>, s: WAState, qtype: string, param = '') =>
  def.act(s, s.order[s.turn], { type: 'askQuestion', qtype, param }, ctx()) ?? {};
const lastAns = (s: WAState) => s.questionLog[s.questionLog.length - 1].answer;

test('the server answers each question type from the target (Pedri)', () => {
  const { def, s } = newGame(2, { rounds: 1 }, 'Pedri');
  const ask = (qtype: string, param = '') => {
    assert.equal(askBy(def, s, qtype, param).error, undefined, `${qtype}:${param}`);
    return lastAns(s);
  };
  assert.equal(ask('posGroup', 'MID'), true, 'midfielder');
  assert.equal(ask('posGroup', 'DEF'), false, 'not a defender');
  assert.equal(ask('posGroup', 'ATT'), false);
  assert.equal(ask('posGroup', 'GK'), false);
  assert.equal(ask('posCode', 'CM'), true);
  assert.equal(ask('posCode', 'CB'), false);
  assert.equal(ask('nationality', 'Spain'), true);
  assert.equal(ask('nationality', 'Brazil'), false);
  assert.equal(ask('continent', 'Europe'), true);
  assert.equal(ask('continent', 'South America'), false);
  assert.equal(ask('league', 'La Liga'), true);
  assert.equal(ask('league', 'Premier League'), false);
  assert.equal(ask('valueOver', '75'), true);
  assert.equal(ask('valueOver', '100'), true);
  assert.equal(ask('retired'), false);
  assert.equal(ask('era', '2020s'), true);
  assert.equal(ask('era', '2010s'), false);
});

test('answers handle a retired keeper with no market value (Casillas)', () => {
  const { def, s } = newGame(2, { rounds: 1 }, 'Iker Casillas');
  const ask = (qtype: string, param = '') => {
    assert.equal(askBy(def, s, qtype, param).error, undefined);
    return lastAns(s);
  };
  assert.equal(ask('posGroup', 'GK'), true);
  assert.equal(ask('retired'), true);
  assert.equal(ask('valueOver', '20'), false, 'null value is not "worth more than"');
  assert.equal(ask('era', '2010s'), true);
  assert.equal(ask('continent', 'Europe'), true);
});

test('rejects out-of-menu and duplicate questions', () => {
  const { def, s } = newGame(2);
  assert.match(askBy(def, s, 'league', 'Serie A').error!, /valid/i, 'no Serie A in this bank');
  assert.match(askBy(def, s, 'valueOver', '999').error!, /valid/i);
  def.act(s, s.order[s.turn], { type: 'askQuestion', qtype: 'retired', param: '' }, ctx());
  assert.match(def.act(s, s.order[s.turn], { type: 'askQuestion', qtype: 'retired', param: '' }, ctx())!.error!, /already asked/i);
});

test('wrong guess eliminates; correct guess wins; target hidden until the round ends', () => {
  const { def, s } = newGame(2, { rounds: 2 }, 'Pedri'); // 2 rounds → a round can end without ending the match
  assert.equal((def.view(s, s.order[0]) as any).target, null, 'target hidden while asking');
  const a = s.order[s.turn];
  def.act(s, a, { type: 'guessPlayer', name: 'Vinicius' }, ctx());
  assert.ok(s.eliminated.includes(a), 'wrong guess → out');
  const b = s.order[s.turn];
  assert.notEqual(b, a, 'turn passed to the other player');
  def.act(s, b, { type: 'guessPlayer', name: 'pedri' }, ctx()); // case-insensitive
  assert.equal(s.roundWinner, b);
  assert.equal(s.roundOver, true);
  assert.equal(s.over, false);
  assert.equal((def.view(s, a) as any).target, 'Pedri', 'revealed at round end');
  assert.match(def.act(s, a, { type: 'guessPlayer', name: 'x' }, ctx())!.error!, /between rounds/i);
});

test('all players eliminated → nobody wins the round (target revealed)', () => {
  const { def, s } = newGame(2, { rounds: 1 }, 'Pedri');
  def.act(s, s.order[s.turn], { type: 'guessPlayer', name: 'Vinicius' }, ctx());
  def.act(s, s.order[s.turn], { type: 'guessPlayer', name: 'Vinicius' }, ctx());
  assert.equal(s.over, true);
  assert.equal(s.roundWinner, null);
  assert.deepEqual(def.result(s).winners, [], 'nobody won a round → no winner');
  assert.equal((def.view(s, s.order[0]) as any).target, 'Pedri');
});

test('best-of-N: round wins decide the match; nextRound advances and rotates the start', () => {
  const { def, s } = newGame(2, { rounds: 2 }, 'Pedri');
  const a = s.order[s.turn];
  def.act(s, a, { type: 'guessPlayer', name: 'Vinicius' }, ctx()); // a out
  const b = s.order[s.turn];
  def.act(s, b, { type: 'guessPlayer', name: 'Pedri' }, ctx()); // b wins round 1
  assert.equal(s.roundOver, true);
  assert.equal(def.act(s, a, { type: 'nextRound' }, ctx())!.error, undefined);
  assert.equal(s.roundNo, 2);
  assert.equal(s.eliminated.length, 0, 'eliminations reset');
  s.targetIdx = BANK.findIndex((p) => p.name === 'Vinicius');
  assert.equal(s.order[s.turn], b, 'round 2 starts with the rotated player');
  def.act(s, b, { type: 'guessPlayer', name: 'Vinicius' }, ctx()); // b wins round 2
  assert.equal(s.over, true);
  assert.deepEqual(def.result(s).winners, [b], 'two round wins → b wins the match');
});

test('every nationality in the real bank maps to a continent (no silent gaps)', () => {
  const unmapped = [...new Set(WORD_BANK.map((p: PlayerCard) => p.nationality))].filter((n) => continentOf(n) === null);
  assert.deepEqual(unmapped, [], `unmapped nationalities: ${unmapped.join(', ')}`);
});

test('the opt-in turn timer auto-asks (never eliminates) on timeout', () => {
  const { def, s } = newGame(2, { rounds: 1 });
  // re-create with a timer enabled
  const def2 = createWhoAmI(BANK) as GameDef<WAState>;
  const s2 = def2.create({ seats: [0, 1], players: [0, 1].map((x) => ({ seat: x, name: 'P' + x })), options: { rounds: 1, timer: 30 } }, { rng: lcg(1), now: 1000 }) as WAState;
  assert.equal(def2.tick!(s2, { rng: lcg(1), now: 1000 }), true, 'arms the clock');
  const before = s2.questionLog.length;
  def2.tick!(s2, { rng: lcg(1), now: 32000 }); // past the deadline
  assert.equal(s2.questionLog.length, before + 1, 'a question was auto-asked');
  assert.equal(s2.eliminated.length, 0, 'nobody is eliminated by a timeout');
  void def, void s;
});
