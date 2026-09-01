// skill.test.ts — the shared bot-strength setting. The option is host input, so it is
// clamped defensively; the levels themselves are exercised in each game's own tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initSkill, SKILL_OPTION, SKILL_LABELS, CASUAL, SHARP } from './skill.ts';
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

test('the option names each step, so the lobby shows words rather than a bare number', () => {
  assert.equal(SKILL_OPTION.labels?.length, SKILL_OPTION.max - SKILL_OPTION.min + 1);
  assert.deepEqual(SKILL_OPTION.labels, SKILL_LABELS);
  assert.equal(SKILL_OPTION.default, SHARP);
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
