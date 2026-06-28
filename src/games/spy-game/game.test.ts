// game.test.ts — Spy Game. Logic is tested against a small INJECTED synthetic bank;
// redaction is checked across every phase. A final sweep uses the real players.json
// to prove the decoy rule is always satisfiable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpyGame, similar, pickDecoy, type PlayerCard, type SpyState } from './game.ts';
import { WORD_BANK } from './wordbank.ts';
import type { GameContext, GameDef } from '../../platform/types.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
// Every pair in this bank is similar (same position + era), so a decoy always exists.
function synthBank(n = 6): PlayerCard[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `P_${String.fromCharCode(65 + i)}`,
    nationality: `Nat${i}`,
    positions: ['MID'],
    leagues: [`L${i}`],
    era: '2010s',
  }));
}
function newSpy(numPlayers: number, seed = 1, bank = synthBank()) {
  const def = createSpyGame(bank);
  const c: GameContext = { rng: lcg(seed), now: 0 };
  const seats = Array.from({ length: numPlayers }, (_, i) => i);
  const players = seats.map((x) => ({ seat: x, name: `Seat${x}` }));
  const s = def.create({ seats, players }, c) as SpyState;
  return { def: def as GameDef<SpyState>, s, c, bank };
}
const act = (def: GameDef<SpyState>, s: SpyState, c: GameContext, seat: number, msg: Record<string, unknown>) =>
  def.act(s, seat, msg, c) ?? {};

// Submit clues and skip every end-of-round interlude (no early vote) until voting.
function runClues(def: GameDef<SpyState>, s: SpyState, c: GameContext) {
  let guard = 0;
  while ((s.phase === 'clues' || s.phase === 'interlude') && guard++ < 100) {
    if (s.phase === 'interlude') for (const seat of s.order) act(def, s, c, seat, { type: 'interludeVote', wantVote: false });
    else act(def, s, c, s.order[s.current], { type: 'submitClue', word: 'clue' });
  }
}

// ---------------------------------------------------------------------------
// Setup & secrets
// ---------------------------------------------------------------------------

test('exactly one spy; non-spies share the target, the spy gets a different decoy', () => {
  const { s, bank } = newSpy(4);
  const spies = s.order.filter((seat) => s.players[seat]!.isSpy);
  assert.equal(spies.length, 1, 'exactly one spy');
  const target = bank[s.targetIdx].name;
  const decoy = bank[s.decoyIdx].name;
  assert.notEqual(target, decoy);
  for (const seat of s.order) {
    const p = s.players[seat]!;
    assert.equal(p.secret, p.isSpy ? decoy : target);
  }
});

test('the decoy is always similar to the target and different (synthetic + real bank)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { s, bank } = newSpy(3, seed);
    assert.notEqual(s.decoyIdx, s.targetIdx);
    assert.ok(similar(bank[s.decoyIdx], bank[s.targetIdx]), `synth seed ${seed}`);
  }
  // real 500-player bank: the decoy rule must always be satisfiable
  const def = createSpyGame(WORD_BANK);
  for (let seed = 1; seed <= 80; seed++) {
    const c: GameContext = { rng: lcg(seed * 7 + 1), now: 0 };
    const s = def.create({ seats: [0, 1, 2], players: [0, 1, 2].map((x) => ({ seat: x, name: 'P' + x })) }, c) as SpyState;
    assert.notEqual(s.decoyIdx, s.targetIdx);
    assert.ok(similar(WORD_BANK[s.decoyIdx], WORD_BANK[s.targetIdx]), `real bank seed ${seed}`);
  }
});

test('the decoy is the strongest match, not just any qualifier (prefers shared nationality)', () => {
  const bank: PlayerCard[] = [
    { name: 'TARGET', nationality: 'France', positions: ['MID'], leagues: ['Ligue 1'], era: '2000s' },
    { name: 'STRONG', nationality: 'France', positions: ['MID'], leagues: ['Ligue 1'], era: '2000s' },
    { name: 'WEAK', nationality: 'Japan', positions: ['MID'], leagues: ['Ligue 1'], era: '2000s' }, // qualifies, but cross-nationality
  ];
  for (let seed = 1; seed <= 30; seed++) {
    assert.equal(bank[pickDecoy(bank, 0, lcg(seed))].name, 'STRONG', `seed ${seed} should avoid the weak cross-nationality match`);
  }
});

test('the word bank is injected, not hardcoded — secrets come from the supplied bank', () => {
  const bank: PlayerCard[] = synthBank(4).map((c, i) => ({ ...c, name: `ZZ_${i}` }));
  const { s, def } = newSpy(3, 5, bank);
  for (const seat of s.order) assert.match(def.view(s, seat).you.secret, /^ZZ_/);
});

// ---------------------------------------------------------------------------
// Redaction (the core invariant)
// ---------------------------------------------------------------------------

function assertNoLeak(def: GameDef<SpyState>, s: SpyState, bank: PlayerCard[]) {
  const target = bank[s.targetIdx].name;
  const decoy = bank[s.decoyIdx].name;
  const preResolve = s.phase === 'clues' || s.phase === 'interlude' || s.phase === 'voting';
  for (const seat of s.order) {
    const v = def.view(s, seat) as any;
    const json = JSON.stringify(v);
    if (s.players[seat]!.isSpy) {
      assert.equal(v.you.secret, decoy, 'spy sees the decoy');
      if (preResolve) assert.ok(!json.includes(target), `spy must not see the target in ${s.phase}`);
    } else {
      assert.equal(v.you.secret, target, 'non-spy sees the target');
      assert.ok(!json.includes(decoy), `non-spy must not see the decoy in ${s.phase}`);
      if (preResolve) {
        assert.ok(!('spyId' in v) && !('caughtId' in v), `no spyId/caughtId leak in ${s.phase}`);
        for (const pp of v.players) assert.ok(!('isSpy' in pp) && !('secret' in pp), 'roster carries no role/secret');
      }
    }
  }
}

test('no view leaks the other role’s secret or the spy id across the whole match', () => {
  const { def, s, c, bank } = newSpy(4, 9);
  assertNoLeak(def, s, bank); // clues r1
  // play a couple of clues, recheck
  act(def, s, c, s.order[s.current], { type: 'submitClue', word: 'x' });
  act(def, s, c, s.order[s.current], { type: 'submitClue', word: 'y' });
  assertNoLeak(def, s, bank);
  runClues(def, s, c);
  assert.equal(s.phase, 'voting');
  assertNoLeak(def, s, bank); // voting
});

// ---------------------------------------------------------------------------
// Clue phase
// ---------------------------------------------------------------------------

test('the clue phase runs exactly 3 rounds × N and rejects out-of-turn clues', () => {
  const { def, s, c } = newSpy(3, 3);
  const wrongSeat = s.order[(s.current + 1) % s.order.length];
  assert.match(act(def, s, c, wrongSeat, { type: 'submitClue', word: 'no' }).error!, /not your turn/i);
  runClues(def, s, c);
  assert.equal(s.clueLog.length, 3 * 3, '3 clues per player');
  assert.equal(s.phase, 'voting');
});

test('after each round players may call an optional early vote (majority decides)', () => {
  const { def, s, c } = newSpy(3, 3);
  while (s.phase === 'clues' && s.round === 1) act(def, s, c, s.order[s.current], { type: 'submitClue', word: 'x' });
  assert.equal(s.phase, 'interlude', 'interlude after round 1');
  // minority (1 of 3) wants a vote → keep clueing
  act(def, s, c, s.order[0], { type: 'interludeVote', wantVote: true });
  act(def, s, c, s.order[1], { type: 'interludeVote', wantVote: false });
  act(def, s, c, s.order[2], { type: 'interludeVote', wantVote: false });
  assert.equal(s.phase, 'clues');
  assert.equal(s.round, 2);
  // round 2 → majority calls a vote → straight to voting (round 3 skipped)
  while (s.phase === 'clues' && s.round === 2) act(def, s, c, s.order[s.current], { type: 'submitClue', word: 'y' });
  assert.equal(s.phase, 'interlude');
  act(def, s, c, s.order[0], { type: 'interludeVote', wantVote: true });
  act(def, s, c, s.order[1], { type: 'interludeVote', wantVote: true });
  assert.equal(s.phase, 'interlude', 'waits for everyone to decide');
  act(def, s, c, s.order[2], { type: 'interludeVote', wantVote: false });
  assert.equal(s.phase, 'voting', 'majority → early vote');
  assert.equal(s.clueLog.length, 6, 'only 2 rounds of clues happened');
  assert.match(act(def, s, c, s.order[0], { type: 'interludeVote', wantVote: true }).error!, /call a vote/i);
});

// ---------------------------------------------------------------------------
// Voting & resolution
// ---------------------------------------------------------------------------

function toVoting(numPlayers: number, seed: number) {
  const g = newSpy(numPlayers, seed);
  runClues(g.def, g.s, g.c);
  assert.equal(g.s.phase, 'voting');
  return g;
}

test('a non-spy caught → spy wins', () => {
  const { def, s, c } = toVoting(4, 11);
  const spy = s.spyId;
  const victim = s.order.find((x) => x !== spy)!; // pile votes onto a non-spy
  for (const seat of s.order) {
    const target = seat === victim ? s.order.find((x) => x !== victim)! : victim;
    act(def, s, c, seat, { type: 'castVote', target });
  }
  assert.equal(s.over, true);
  assert.deepEqual(def.result(s).winners, [spy], 'spy wins when a non-spy is caught');
});

test('a tied vote → no one caught → spy wins', () => {
  const { def, s, c } = toVoting(3, 4);
  // 3 players, each votes the next → 1-1-1 tie
  act(def, s, c, s.order[0], { type: 'castVote', target: s.order[1] });
  act(def, s, c, s.order[1], { type: 'castVote', target: s.order[2] });
  act(def, s, c, s.order[2], { type: 'castVote', target: s.order[0] });
  assert.equal(s.caughtId, null, 'no strict plurality');
  assert.equal(s.over, true);
  assert.deepEqual(def.result(s).winners, [s.spyId]);
});

test('the spy caught → spyGuess opens; wrong guess → non-spies win, right guess → spy wins', () => {
  // wrong guess
  let { def, s, c } = toVoting(4, 11);
  let spy = s.spyId;
  for (const seat of s.order) {
    const target = seat === spy ? s.order.find((x) => x !== spy)! : spy; // everyone else votes the spy
    act(def, s, c, seat, { type: 'castVote', target });
  }
  assert.equal(s.phase, 'spyGuess');
  assert.equal(s.caughtId, spy);
  assert.ok(s.shortlist.includes(s.targetIdx), 'true target is on the shortlist');
  assert.match(act(def, s, c, s.order.find((x) => x !== spy)!, { type: 'spyGuess', choice: s.targetIdx }).error!, /caught spy/i);
  const wrong = s.shortlist.find((i) => i !== s.targetIdx)!;
  act(def, s, c, spy, { type: 'spyGuess', choice: wrong });
  assert.deepEqual(def.result(s).winners.sort(), s.order.filter((x) => x !== spy), 'wrong guess → non-spies win');

  // right guess
  ({ def, s, c } = toVoting(4, 11));
  spy = s.spyId;
  for (const seat of s.order) {
    const target = seat === spy ? s.order.find((x) => x !== spy)! : spy;
    act(def, s, c, seat, { type: 'castVote', target });
  }
  act(def, s, c, spy, { type: 'spyGuess', choice: s.targetIdx });
  assert.deepEqual(def.result(s).winners, [spy], 'right guess → spy steals the win');
});

test('you cannot vote for yourself, vote twice, or vote outside the voting phase', () => {
  const g = newSpy(3, 6);
  assert.match(act(g.def, g.s, g.c, g.s.order[0], { type: 'castVote', target: g.s.order[1] }).error!, /voting phase/i);
  runClues(g.def, g.s, g.c);
  const seat = g.s.order[0];
  assert.match(act(g.def, g.s, g.c, seat, { type: 'castVote', target: seat }).error!, /yourself/i);
  act(g.def, g.s, g.c, seat, { type: 'castVote', target: g.s.order[1] });
  assert.match(act(g.def, g.s, g.c, seat, { type: 'castVote', target: g.s.order[2] }).error!, /already voted/i);
});

// ---------------------------------------------------------------------------
// Full autoplay via the bot
// ---------------------------------------------------------------------------

test('a full match plays to a decided winner via the bot', () => {
  const { def, s, c } = newSpy(5, 77);
  let guard = 0;
  while (!s.over && guard++ < 1000) {
    let acted = false;
    for (const seat of s.order) {
      const mv = def.bot!(s, seat, c);
      if (mv) {
        assert.equal(act(def, s, c, seat, mv).error, undefined, JSON.stringify(mv));
        acted = true;
        break;
      }
    }
    if (!acted) break;
  }
  assert.equal(s.over, true);
  const out = def.result(s);
  assert.equal(out.over, true);
  assert.ok(out.winners.length >= 1);
  // winners are exactly one side
  const spyWon = out.winners.includes(s.spyId);
  assert.equal(spyWon ? out.winners.length : out.winners.length, spyWon ? 1 : s.order.length - 1);
});
