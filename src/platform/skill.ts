// platform/skill.ts — the shared "how hard should the bots play?" lobby setting.
//
// Every bot in the hub can be run at three strengths. This is not a handicap bolted on
// top of one algorithm: each level is a genuinely different policy, so a Casual bot plays
// like a beginner rather than like a strong player throwing moves away at random.
//
//   1 Casual — plays legally and sensibly, with no lookahead worth the name.
//   2 Steady — one move of thought: the best position it can reach right now.
//   3 Sharp  — the full search, sampling or solver the game has to offer.
//   4 Master — only where a game has more to give than Sharp spends: a deeper search, or
//              a sounder model of what it cannot see. It thinks longer, so it is opt-in.
//
// A game embeds `skill` in its state at create time and branches on it inside `bot`.

import type { GameOption } from './types.ts';

export const CASUAL = 1;
export const STEADY = 2;
export const SHARP = 3;
export const MASTER = 4;
export const GRANDMASTER = 5;

export const SKILL_LABELS = ['Casual', 'Steady', 'Sharp'];

export const SKILL_OPTION: GameOption = {
  key: 'skill',
  label: 'Bot skill',
  min: CASUAL,
  max: SHARP,
  step: 1,
  default: SHARP,
  labels: SKILL_LABELS,
};

/** The same setting with Master on the end, for the games that have one. The default
 *  stays Sharp: Master is the strongest the bot can play, not the strongest it should
 *  play at someone who has not asked for it. */
export const MASTER_SKILL_OPTION: GameOption = {
  ...SKILL_OPTION,
  max: MASTER,
  labels: [...SKILL_LABELS, 'Master'],
};

/** And Grandmaster above that, where a game's search still has more to give. */
export const GRANDMASTER_SKILL_OPTION: GameOption = {
  ...SKILL_OPTION,
  max: GRANDMASTER,
  labels: [...SKILL_LABELS, 'Master', 'Grandmaster'],
};

/** Read the host's choice defensively — it arrives as untrusted client input. `max` is
 *  the highest level the game offers; anything above it is that level, and anything
 *  unusable is Sharp, which every game has. */
export function initSkill(raw: unknown, max = SHARP): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(CASUAL, n)) : SHARP;
}
