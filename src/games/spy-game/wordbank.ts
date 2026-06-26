// games/spy-game/wordbank.ts — loads the injected Spy Game word bank from the
// repo-root players.json. Kept OUT of game.ts so the game module stays pure and
// data-agnostic; the registry passes this into createSpyGame().
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { PlayerCard } from './game.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const WORD_BANK: PlayerCard[] = JSON.parse(readFileSync(join(here, '../../../players.json'), 'utf8'));
