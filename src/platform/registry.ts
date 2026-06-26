// platform/registry.ts — the games a room can host. New games register here.
import type { GameDef } from './types.ts';
import { gameSummary, type GameSummary } from './types.ts';
import { winOrDie } from '../games/win-or-die/game.ts';
import { lockIn } from '../games/lock-in/game.ts';
import { yahtzee } from '../games/yahtzee/game.ts';

const ALL: GameDef[] = [winOrDie, lockIn, yahtzee];

export const GAMES: Record<string, GameDef> = Object.fromEntries(ALL.map((g) => [g.id, g]));
export const GAME_SUMMARIES: GameSummary[] = ALL.map(gameSummary);
export const DEFAULT_GAME = ALL[0].id;
