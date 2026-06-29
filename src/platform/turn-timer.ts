// turn-timer.ts — an opt-in per-turn countdown shared by games (Spy, Quoridor, Codenames).
//
// A game embeds a `Timer` in its state, then calls runTimer() from its `tick`. The timer
// arms a deadline whenever the "turn key" changes, and once the deadline passes it invokes
// the game's own auto-action (usually its bot) so play never stalls. The client renders a
// countdown by restarting from `secs` each time `deadline` changes — no clock-skew math.

import type { GameOption } from './types.ts';

export interface Timer {
  timerSecs: number; // 0 = timer off
  deadline: number; // server epoch-ms the current actor must act by; 0 = unarmed
  timerKey: string; // signature of the current turn/phase (so we re-arm on changes)
}

/** Shared host option. 0 = off; otherwise seconds per turn. */
export const TIMER_OPTION: GameOption = { key: 'timer', label: 'Turn timer (s, 0=off)', min: 0, max: 60, step: 15, default: 0 };

export function initTimer(secs: unknown): Timer {
  return { timerSecs: Math.max(0, Math.min(60, Math.round(Number(secs) || 0))), deadline: 0, timerKey: '' };
}

/** What the client needs to draw a countdown (or null when the timer is off). */
export function timerView(t: Timer): { secs: number; deadline: number } | null {
  return t.timerSecs ? { secs: t.timerSecs, deadline: t.deadline } : null;
}

/**
 * Drive the timer for one tick. `keyFn` returns the current turn signature ('' when there's
 * no active turn, e.g. game over). `onTimeout` performs the auto-action when time runs out.
 * Returns true if anything changed (so the caller should broadcast).
 */
export function runTimer(t: Timer, keyFn: () => string, now: number, onTimeout: () => void): boolean {
  if (!t.timerSecs) return false;
  const key = keyFn();
  if (!key) {
    if (t.deadline || t.timerKey) { t.deadline = 0; t.timerKey = ''; return true; }
    return false;
  }
  if (key !== t.timerKey) {
    t.timerKey = key;
    t.deadline = now + t.timerSecs * 1000;
    return true;
  }
  if (t.deadline > 0 && now >= t.deadline) {
    onTimeout();
    const next = keyFn(); // re-arm for whatever turn we're on now
    if (next) { t.timerKey = next; t.deadline = now + t.timerSecs * 1000; }
    else { t.timerKey = ''; t.deadline = 0; }
    return true;
  }
  return false;
}
