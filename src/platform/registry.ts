// platform/registry.ts — the games a room can host. New games register here.
import type { GameDef } from './types.ts';
import { gameSummary, type GameSummary } from './types.ts';
import { winOrDie } from '../games/win-or-die/game.ts';
import { lockIn } from '../games/lock-in/game.ts';
import { yahtzee } from '../games/yahtzee/game.ts';
import { createSpyGame } from '../games/spy-game/game.ts';
import { WORD_BANK as SPY_WORDS } from '../games/spy-game/wordbank.ts';
import { createCodenames } from '../games/codenames/game.ts';
import { WORD_BANK as CODENAMES_WORDS } from '../games/codenames/wordbank.ts';

const spyGame = createSpyGame(SPY_WORDS);
const codenames = createCodenames(CODENAMES_WORDS);

const ALL: GameDef[] = [winOrDie, lockIn, yahtzee, spyGame, codenames];

export const GAMES: Record<string, GameDef> = Object.fromEntries(ALL.map((g) => [g.id, g]));
export const GAME_SUMMARIES: GameSummary[] = ALL.map(gameSummary);
export const DEFAULT_GAME = ALL[0].id;
