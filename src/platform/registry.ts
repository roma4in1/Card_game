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
import { quoridor } from '../games/quoridor/game.ts';
import { tectonic } from '../games/tectonic/game.ts';
import { createMemoryMatch } from '../games/memory-match/game.ts';
import { CONCEPTS } from '../games/memory-match/conceptbank.ts';
import { createWhoAmI } from '../games/who-am-i/game.ts';
import { createGuessPlayer } from '../games/guess-player/game.ts';

const spyGame = createSpyGame(SPY_WORDS);
const codenames = createCodenames(CODENAMES_WORDS);
const memoryMatch = createMemoryMatch(CONCEPTS);
const whoAmI = createWhoAmI(SPY_WORDS); // reuses the football player bank (players.json)
const guessPlayer = createGuessPlayer(SPY_WORDS); // also reuses players.json

const ALL: GameDef[] = [winOrDie, lockIn, yahtzee, spyGame, codenames, quoridor, tectonic, memoryMatch, whoAmI, guessPlayer];

export const GAMES: Record<string, GameDef> = Object.fromEntries(ALL.map((g) => [g.id, g]));
export const GAME_SUMMARIES: GameSummary[] = ALL.map(gameSummary);
export const DEFAULT_GAME = ALL[0].id;
