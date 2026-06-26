// games/codenames/wordbank.ts — loads the injected Codenames word bank from the
// repo-root words.json. Kept OUT of game.ts so the game module stays data-agnostic;
// the registry passes this into createCodenames().
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const WORD_BANK: string[] = JSON.parse(readFileSync(join(here, '../../../words.json'), 'utf8'));
