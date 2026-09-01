// platform/skill.ts — the shared "how hard should the bots play?" lobby setting.
//
// Every bot in the hub can be run at three strengths. This is not a handicap bolted on
// top of one algorithm: each level is a genuinely different policy, so a Casual bot plays
// like a beginner rather than like a strong player throwing moves away at random.
//
//   1 Casual — plays legally and sensibly, with no lookahead worth the name.
//   2 Steady — one move of thought: the best position it can reach right now.
//   3 Sharp  — the full search, sampling or solver the game has to offer.
//
// A game embeds `skill` in its state at create time and branches on it inside `bot`.

import type { GameOption } from './types.ts';

export const CASUAL = 1;
export const STEADY = 2;
export const SHARP = 3;

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

/** Read the host's choice defensively — it arrives as untrusted client input. */
export function initSkill(raw: unknown): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(SHARP, Math.max(CASUAL, n)) : SHARP;
}
