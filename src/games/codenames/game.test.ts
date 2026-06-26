// game.test.ts — Codenames. Logic is tested against a small INJECTED word bank with a
// seeded rng; team-and-role redaction is checked, and the key/guess/win rules verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodenames, type CNState, type Team } from './game.ts';
import type { GameContext, GameDef } from '../../platform/types.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}
const bank = (n = 40): string[] => Array.from({ length: n }, (_, i) => 'W' + i);
const otherTeam = (t: Team): Team => (t === 'red' ? 'blue' : 'red');

function newCN(numPlayers: number, seed = 1, b = bank()) {
  const def = createCodenames(b);
  const c: GameContext = { rng: lcg(seed), now: 0 };
  const seats = Array.from({ length: numPlayers }, (_, i) => i);
  const players = seats.map((x) => ({ seat: x, name: 'P' + x }));
  const s = def.create({ seats, players }, c) as CNState;
  return { def: def as GameDef<CNState>, s, c, b };
}
const act = (def: GameDef<CNState>, s: CNState, c: GameContext, seat: number, msg: Record<string, unknown>) =>
  def.act(s, seat, msg, c) ?? {};
const doClue = (g: ReturnType<typeof newCN>, number = 2, word = 'X') =>
  act(g.def, g.s, g.c, g.s.teams[g.s.turnTeam].spymaster!, { type: 'giveClue', word, number });
const firstUnrevealed = (s: CNState) => s.grid.findIndex((c) => !c.revealed);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('teams, roles and the key are set up correctly', () => {
  const { s } = newCN(5, 7);
  // exactly one spymaster + ≥1 operative per team
  for (const t of ['red', 'blue'] as Team[]) {
    assert.notEqual(s.teams[t].spymaster, null);
    assert.ok(s.teams[t].operatives.length >= 1, `${t} has an operative`);
    assert.equal(s.players[s.teams[t].spymaster!]!.role, 'spymaster');
  }
  // key distribution: 9 starting / 8 other / 7 neutral / 1 assassin for 25 cards
  const counts = { red: 0, blue: 0, neutral: 0, assassin: 0 } as Record<string, number>;
  for (const card of s.grid) counts[card.identity]++;
  assert.equal(s.grid.length, 25);
  assert.equal(counts.assassin, 1);
  assert.equal(counts.neutral, 7);
  assert.equal(counts[s.startingTeam], 9);
  assert.equal(counts[otherTeam(s.startingTeam)], 8);
  assert.equal(s.agentsRemaining[s.startingTeam], 9);
  assert.equal(s.agentsRemaining[otherTeam(s.startingTeam)], 8);
});

test('25 distinct words are drawn from the injected bank, not hardcoded', () => {
  const custom = Array.from({ length: 30 }, (_, i) => 'ZZ' + i);
  const { s } = newCN(4, 3, custom);
  assert.equal(new Set(s.grid.map((c) => c.word)).size, 25, '25 distinct words');
  for (const c of s.grid) assert.ok(custom.includes(c.word), 'word comes from the injected bank');
});

// ---------------------------------------------------------------------------
// Redaction (team-and-role scoped)
// ---------------------------------------------------------------------------

test('operative view never carries an unrevealed identity; the spymaster view does', () => {
  const { def, s, c } = newCN(4, 9);
  const team = s.turnTeam;
  const spy = s.teams[team].spymaster!;
  const op = s.teams[team].operatives[0];

  let sv = def.view(s, spy) as any;
  let ov = def.view(s, op) as any;
  for (const card of sv.grid) assert.ok(['red', 'blue', 'neutral', 'assassin'].includes(card.identity), 'spymaster sees the key');
  for (const card of ov.grid) assert.equal(card.identity, null, 'operative sees no identities yet');

  // reveal a couple of cards, then the operative may see only those
  doClue({ def, s, c, b: [] } as any, 5);
  act(def, s, c, op, { type: 'guessCard', cardIndex: 0 });
  act(def, s, c, op, { type: 'guessCard', cardIndex: 1 });
  ov = def.view(s, op) as any;
  for (let i = 0; i < 25; i++) {
    if (s.grid[i].revealed) assert.equal(ov.grid[i].identity, s.grid[i].identity, `revealed card ${i} is public`);
    else assert.equal(ov.grid[i].identity, null, `unrevealed card ${i} stays hidden from the operative`);
  }
  // the operative's whole view must never serialise the assassin's hidden position
  const assassinIdx = s.grid.findIndex((card) => card.identity === 'assassin');
  if (!s.grid[assassinIdx].revealed) {
    assert.equal((def.view(s, op) as any).grid[assassinIdx].identity, null);
  }
});

// ---------------------------------------------------------------------------
// Clue + guess resolution
// ---------------------------------------------------------------------------

test('only the active spymaster clues, and operatives cannot guess before a clue', () => {
  const { def, s, c } = newCN(4, 4);
  const team = s.turnTeam;
  const op = s.teams[team].operatives[0];
  const enemySpy = s.teams[otherTeam(team)].spymaster!;
  assert.match(act(def, s, c, op, { type: 'guessCard', cardIndex: 0 }).error!, /no clue/i);
  assert.match(act(def, s, c, op, { type: 'giveClue', word: 'x', number: 1 }).error!, /spymaster/i);
  assert.match(act(def, s, c, enemySpy, { type: 'giveClue', word: 'x', number: 1 }).error!, /spymaster/i);
  assert.equal(doClue({ def, s, c, b: [] } as any, 2).error, undefined);
  assert.equal(s.phase, 'guess');
});

test('own agent continues; neutral and enemy both end the turn (enemy marks for them)', () => {
  // own agent → keep going
  let g = newCN(4, 4);
  let team = g.s.turnTeam;
  doClue(g, 3);
  let i = firstUnrevealed(g.s);
  g.s.grid[i].identity = team;
  act(g.def, g.s, g.c, g.s.teams[team].operatives[0], { type: 'guessCard', cardIndex: i });
  assert.equal(g.s.phase, 'guess');
  assert.equal(g.s.turnTeam, team, 'still our turn after a correct guess');

  // neutral → turn ends
  g = newCN(4, 4);
  team = g.s.turnTeam;
  doClue(g, 3);
  i = firstUnrevealed(g.s);
  g.s.grid[i].identity = 'neutral';
  act(g.def, g.s, g.c, g.s.teams[team].operatives[0], { type: 'guessCard', cardIndex: i });
  assert.equal(g.s.turnTeam, otherTeam(team), 'neutral ends the turn');

  // enemy agent → marked for them, turn ends
  g = newCN(4, 4);
  team = g.s.turnTeam;
  const enemy = otherTeam(team);
  doClue(g, 3);
  i = firstUnrevealed(g.s);
  g.s.grid[i].identity = enemy;
  const enemyBefore = g.s.agentsRemaining[enemy];
  act(g.def, g.s, g.c, g.s.teams[team].operatives[0], { type: 'guessCard', cardIndex: i });
  assert.equal(g.s.grid[i].revealed, true);
  assert.equal(g.s.agentsRemaining[enemy], enemyBefore - 1, "enemy's agent count drops (it helped them)");
  assert.equal(g.s.turnTeam, enemy, 'turn ends');
});

test('the assassin ends the game and the guessing team loses', () => {
  const g = newCN(4, 4);
  const team = g.s.turnTeam;
  doClue(g, 3);
  const i = firstUnrevealed(g.s);
  g.s.grid[i].identity = 'assassin';
  act(g.def, g.s, g.c, g.s.teams[team].operatives[0], { type: 'guessCard', cardIndex: i });
  assert.equal(g.s.over, true);
  assert.equal(g.s.endReason, 'assassin');
  assert.equal(g.s.winner, otherTeam(team));
  assert.deepEqual(g.def.result(g.s).winners.sort(), g.s.order.filter((x) => g.s.players[x]!.team === otherTeam(team)));
});

// ---------------------------------------------------------------------------
// Guess cap + stopping
// ---------------------------------------------------------------------------

test('operatives get at most N+1 guesses, and may stop after at least one', () => {
  // cap: clue number 1 → 2 guesses, both own agents, then turn auto-ends
  let g = newCN(4, 4);
  let team = g.s.turnTeam;
  doClue(g, 1);
  const op = g.s.teams[team].operatives[0];
  for (const k of [0, 1]) {
    const i = firstUnrevealed(g.s);
    g.s.grid[i].identity = team;
    act(g.def, g.s, g.c, op, { type: 'guessCard', cardIndex: i });
  }
  assert.equal(g.s.turnTeam, otherTeam(team), 'turn passes after N+1 guesses');

  // voluntary stop
  g = newCN(4, 4);
  team = g.s.turnTeam;
  doClue(g, 3);
  const op2 = g.s.teams[team].operatives[0];
  assert.match(act(g.def, g.s, g.c, op2, { type: 'stopGuessing' }).error!, /at least one/i);
  const i = firstUnrevealed(g.s);
  g.s.grid[i].identity = team;
  act(g.def, g.s, g.c, op2, { type: 'guessCard', cardIndex: i });
  assert.equal(act(g.def, g.s, g.c, op2, { type: 'stopGuessing' }).error, undefined);
  assert.equal(g.s.turnTeam, otherTeam(team), 'voluntary stop passes the turn');
});

// ---------------------------------------------------------------------------
// Winning
// ---------------------------------------------------------------------------

test('revealing the last of a team’s agents wins immediately — even via the other team', () => {
  // own last agent
  let g = newCN(4, 4);
  let team = g.s.turnTeam;
  doClue(g, 5);
  g.s.agentsRemaining[team] = 1;
  let i = firstUnrevealed(g.s);
  g.s.grid[i].identity = team;
  act(g.def, g.s, g.c, g.s.teams[team].operatives[0], { type: 'guessCard', cardIndex: i });
  assert.equal(g.s.winner, team);
  assert.equal(g.s.endReason, 'all-agents');

  // edge case: our misguess reveals the enemy's LAST agent → enemy wins
  g = newCN(4, 4);
  team = g.s.turnTeam;
  const enemy = otherTeam(team);
  doClue(g, 5);
  g.s.agentsRemaining[enemy] = 1;
  i = firstUnrevealed(g.s);
  g.s.grid[i].identity = enemy;
  act(g.def, g.s, g.c, g.s.teams[team].operatives[0], { type: 'guessCard', cardIndex: i });
  assert.equal(g.s.winner, enemy, 'the team whose last agent was revealed wins');
});

// ---------------------------------------------------------------------------
// Full autoplay via the bot
// ---------------------------------------------------------------------------

test('a full match plays to a winning team via the bot', () => {
  const { def, s, c } = newCN(4, 123);
  let guard = 0;
  while (!s.over && guard++ < 5000) {
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
  assert.ok(out.winners.every((seat) => s.players[seat]!.team === s.winner));
});
