// games/memory-match/conceptbank.ts — loads the injected Memory Match concept dataset
// from the repo-root concepts.json. Kept OUT of game.ts so the game stays data-agnostic;
// the registry passes this into createMemoryMatch().
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { MMConcept } from './game.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const CONCEPTS: MMConcept[] = JSON.parse(readFileSync(join(here, '../../../concepts.json'), 'utf8'));
