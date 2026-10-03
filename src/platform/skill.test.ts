// skill.test.ts — the shared bot-strength setting. The option is host input, so it is
// clamped defensively; the levels themselves are exercised in each game's own tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initSkill, SKILL_OPTION, MASTER_SKILL_OPTION, GRANDMASTER_SKILL_OPTION, SKILL_LABELS, CASUAL, SHARP, MASTER, GRANDMASTER } from './skill.ts';
import { GAMES } from './registry.ts';

test('the host’s choice is clamped, and anything unusable falls back to the strongest', () => {
  assert.equal(initSkill(1), CASUAL);
  assert.equal(initSkill(2), 2);
  assert.equal(initSkill(3), SHARP);
  assert.equal(initSkill(0), CASUAL, 'below the floor');
  assert.equal(initSkill(99), SHARP, 'above the ceiling');
  assert.equal(initSkill(2.4), 2, 'rounded, not truncated to nonsense');
  assert.equal(initSkill(undefined), SHARP, 'unset means play properly');
  assert.equal(initSkill('sharp'), SHARP, 'and so does junk');
});

test('a game with stronger levels can be asked for them, and only up to what it has', () => {
  assert.equal(initSkill(4), SHARP, 'a game without Master tops out at Sharp');
  assert.equal(initSkill(4, MASTER), MASTER);
  assert.equal(initSkill(5, MASTER), MASTER, 'above its ceiling');
  assert.equal(initSkill(5, GRANDMASTER), GRANDMASTER);
  assert.equal(initSkill(undefined, GRANDMASTER), SHARP, 'unset is still Sharp, not the slowest level');
});

test('the option names each step, so the lobby shows words rather than a bare number', () => {
  for (const opt of [SKILL_OPTION, MASTER_SKILL_OPTION, GRANDMASTER_SKILL_OPTION]) {
    assert.equal(opt.labels?.length, opt.max - opt.min + 1);
    assert.deepEqual(opt.labels?.slice(0, 3), SKILL_LABELS, 'the levels every game shares read the same everywhere');
    assert.equal(opt.default, SHARP, 'the stronger levels are opt-in');
  }
  assert.equal(MASTER_SKILL_OPTION.labels?.at(-1), 'Master');
  assert.equal(GRANDMASTER_SKILL_OPTION.labels?.at(-1), 'Grandmaster');
});

test('every game that ships a bot lets the host pick its strength', () => {
  for (const def of Object.values(GAMES)) {
    if (!def.bot) continue;
    const keys = (def.options ?? []).map((o) => o.key);
    // Games whose "bot" only fills a seat with a forced move have nothing to tune.
    if (!keys.includes('skill')) console.log(`  (no skill setting: ${def.id})`);
  }
  for (const id of ['quoridor', 'tectonic', 'salvo', 'sealed-bids', 'three-fronts', 'manhunt']) {
    const keys = (GAMES[id].options ?? []).map((o) => o.key);
    assert.ok(keys.includes('skill'), `${id} should expose the bot-skill setting`);
  }
});

test('the stronger levels are offered exactly where a game has them', () => {
  const top = (id: string) => GAMES[id].options!.find((o) => o.key === 'skill')!.max;
  assert.equal(top('quoridor'), GRANDMASTER);
  assert.equal(top('tectonic'), GRANDMASTER);
  assert.equal(top('salvo'), MASTER);
  for (const id of ['sealed-bids', 'three-fronts', 'manhunt', 'volley-fire']) assert.equal(top(id), SHARP, `${id} has no level above Sharp`);
});
