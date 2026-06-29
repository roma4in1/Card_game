// game.test.ts — Guess the Player (Wordle-style). The server computes feedback; tests
// check each axis (incl. the directional value arrow), exact-solve, non-bank rejection,
// target redaction (opponents see counts not guesses), fewest-guesses win, and the limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuessPlayer, compare, type GPState, type PlayerCard } from './game.ts';
import type { GameContext, GameDef } from '../../platform/types.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
const ctx = (): GameContext => ({ rng: lcg(1), now: 0 });

const BANK: PlayerCard[] = [
  { name: 'Pedri', nationality: 'Spain', positions: ['CM', 'CAM'], leagues: ['La Liga'], marketValue: 140e6, status: 'active', eraOfPlay: '2020s' },
  { name: 'Gavi', nationality: 'Spain', positions: ['CM'], leagues: ['La Liga'], marketValue: 50e6, status: 'active', eraOfPlay: '2020s' },
  { name: 'Vinicius', nationality: 'Brazil', positions: ['LW', 'ST'], leagues: ['La Liga'], marketValue: 200e6, status: 'active', eraOfPlay: '2020s' },
  { name: 'Iker Casillas', nationality: 'Spain', positions: ['GK'], leagues: [], marketValue: null, status: 'retired', eraOfPlay: '2010s' },
];

function newGame(np = 2, opts: Record<string, number> = { rounds: 1, limit: 0 }, targetName = 'Pedri') {
  const def = createGuessPlayer(BANK) as GameDef<GPState>;
  const seats = Array.from({ length: np }, (_, i) => i);
  const players = seats.map((x) => ({ seat: x, name: 'P' + x }));
  const s = def.create({ seats, players, options: opts }, ctx()) as GPState;
  s.targetIdx = BANK.findIndex((p) => p.name === targetName);
  return { def, s };
}
const guess = (def: GameDef<GPState>, s: GPState, seat: number, name: string) => def.act(s, seat, { type: 'submitGuess', name }, ctx()) ?? {};

test('guess feedback compares each axis to the target (target = Pedri)', () => {
  const { def, s } = newGame(2, { rounds: 1, limit: 0 }, 'Pedri');
  guess(def, s, 0, 'Gavi');
  let fb = s.guesses[0][0].fb;
  assert.equal(fb.exact, false);
  assert.equal(fb.nationality, 'hit', 'same nationality');
  assert.equal(fb.position, 'partial', 'CM overlaps CM/CAM');
  assert.equal(fb.league, 'hit', 'both La Liga');
  assert.equal(fb.value, 'higher', 'target worth more than Gavi');
  assert.equal(fb.era, 'hit');
  assert.equal(fb.status, 'hit');

  guess(def, s, 0, 'Vinicius');
  fb = s.guesses[0][1].fb;
  assert.equal(fb.nationality, 'miss');
  assert.equal(fb.position, 'miss', 'no shared position');
  assert.equal(fb.league, 'hit');
  assert.equal(fb.value, 'equal', 'same value tier');

  guess(def, s, 0, 'Iker Casillas');
  fb = s.guesses[0][2].fb;
  assert.equal(fb.value, 'unknown', 'retired → no value');
  assert.equal(fb.league, 'none', 'retired → no league');
  assert.equal(fb.status, 'miss');
});

test('value arrow points toward the target value (tier-based)', () => {
  const mk = (mv: number | null): PlayerCard => ({ name: 'x', nationality: 'Spain', positions: ['CM'], leagues: ['La Liga'], marketValue: mv, status: 'active', eraOfPlay: '2020s' });
  const target = mk(50e6); // 40–75m tier
  assert.equal(compare(mk(20e6), target).value, 'higher', 'target worth more → go higher');
  assert.equal(compare(mk(140e6), target).value, 'lower', 'target worth less → go lower');
  assert.equal(compare(mk(55e6), target).value, 'equal', 'same tier');
  assert.equal(compare(mk(null), target).value, 'unknown');
  assert.equal(compare(mk(50e6), mk(null)).value, 'unknown', 'unknown target value');
});

test('exact guess solves; a non-bank name is rejected', () => {
  const { def, s } = newGame(2, { rounds: 1, limit: 0 }, 'Pedri');
  assert.match(guess(def, s, 0, 'Nobody Real').error!, /real player/i);
  guess(def, s, 0, 'pedri'); // case-insensitive
  assert.equal(s.solvedIn[0], 1, 'solved in 1');
});

test('target hidden until you solve or the round ends; opponents show counts not guesses', () => {
  const { def, s } = newGame(2, { rounds: 2, limit: 0 }, 'Pedri');
  guess(def, s, 1, 'Gavi');
  const v0 = def.view(s, 0) as any;
  assert.equal(v0.target, null, 'target hidden while playing');
  assert.equal(v0.you.guesses.length, 0, 'I only see my own grid');
  const opp = v0.opponents.find((o: any) => o.seat === 1);
  assert.equal(opp.count, 1, 'I see the opponent guess COUNT');
  assert.equal(opp.guesses, undefined, 'never the opponent guesses');
  guess(def, s, 0, 'Pedri'); // I solve
  assert.equal((def.view(s, 0) as any).target, 'Pedri', 'revealed to me once I solve');
  assert.equal((def.view(s, 1) as any).target, null, 'still hidden from others');
});

test('fewest guesses wins the round', () => {
  const { def, s } = newGame(2, { rounds: 1, limit: 2 }, 'Pedri');
  guess(def, s, 0, 'Gavi'); // seat0 wrong
  guess(def, s, 1, 'Pedri'); // seat1 solves in 1
  guess(def, s, 0, 'Pedri'); // seat0 solves in 2
  assert.equal(s.over, true, 'all done → match over');
  assert.equal(s.roundWinner, 1, 'fewer guesses wins');
  assert.deepEqual(def.result(s).winners, [1]);
});

test('hitting the guess limit without solving knocks you out (no winner if nobody solves)', () => {
  const { def, s } = newGame(1, { rounds: 1, limit: 2 }, 'Pedri'); // solo
  guess(def, s, 0, 'Gavi');
  guess(def, s, 0, 'Vinicius'); // 2nd wrong → limit reached → out → round/match over
  assert.equal(s.out[0], true);
  assert.equal(s.over, true);
  assert.deepEqual(def.result(s).winners, [], 'nobody solved → no winner');
});

test('the optional round timer resolves the round when time runs out', () => {
  const def = createGuessPlayer(BANK) as GameDef<GPState>;
  const s = def.create({ seats: [0, 1], players: [0, 1].map((x) => ({ seat: x, name: 'P' + x })), options: { rounds: 1, limit: 0, roundSecs: 30 } }, { rng: lcg(1), now: 1000 }) as GPState;
  s.targetIdx = BANK.findIndex((p) => p.name === 'Pedri');
  assert.equal(def.tick!(s, { rng: lcg(1), now: 30000 }), false, 'no change before the deadline');
  assert.equal(def.tick!(s, { rng: lcg(1), now: 31001 }), true, 'fires at the deadline');
  assert.equal(s.over, true);
  assert.ok(s.out[0] && s.out[1], 'unsolved players are out');
});
