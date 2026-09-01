// platform/telemetry.ts — one line of JSON per finished match, so the hub's games can be
// looked at in aggregate rather than argued about.
//
// Every strength number the bots have been tuned against so far is bot-versus-bot. This is
// what closes that gap: whether a skill level is actually beatable by a person, whether
// moving first decides games, how often real matches end level, and which games get walked
// out of half-way through.
//
// WHAT IS DELIBERATELY NOT RECORDED: player names, room codes, tokens, IP addresses,
// anything typed by a player. Names are free text and identify real people, and every
// question above is answerable from a seat index and a bot flag. A room code would tie
// records back to a session, so it is hashed rather than stored. If returning-player
// analysis is ever wanted, that hash is the hook — it never has to become a name.
//
// WHERE THE RECORDS GO. The file sink writes on whichever machine runs the server, which
// is the right thing locally and useless when deployed — a container's disk is wiped on
// every deploy, restart and idle spin-down. So if DATABASE_URL is set the records go to
// Postgres instead, and online play is actually captured. Nothing else changes: the games
// and the room know only about `recordMatch`.

import { appendFile, mkdir } from 'node:fs/promises';
import { makeDbSink, postgresQuery } from './telemetry-db.ts';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

/** One seat's part in a match. No name, by design. */
export interface SeatRecord {
  seat: number; // where they sat, so first-mover advantage is measurable
  bot: boolean;
  score: number | null; // the game's own score, where it keeps one
  won: boolean;
}

export interface MatchRecord {
  at: string; // ISO timestamp, match end
  game: string; // game id
  room: string; // salted hash of the room code — never the code itself
  players: number;
  bots: number;
  options: Record<string, number>; // the settings in force, bot skill included
  seats: SeatRecord[];
  winners: number[]; // seat indices; empty when abandoned, several when drawn
  drawn: boolean;
  finished: boolean; // false = everyone left before it ended
  actions: number; // how many moves were played
  seconds: number; // how long it took
}

export type Sink = (record: MatchRecord) => void | Promise<void>;

// Every setting is read WHEN USED, never at import. Module imports are hoisted above the
// `loadEnvFile()` call in whatever loads this, so anything captured here at import time
// would be read before .env exists — which is how a server configured for Postgres came to
// write every record to a local file instead, silently.
const telemetryFile = () => process.env.TELEMETRY_FILE || 'data/matches.jsonl';
const enabled = () => process.env.TELEMETRY !== 'off';

/** Room codes are short and guessable, so they are salted before hashing. The salt is
 *  per-process by default: records stay linkable within a run, and not across restarts.
 *  Settled on first use, and then fixed, so every record in a run hashes the same way. */
let salt: string | null = null;
const currentSalt = () => (salt ??= process.env.TELEMETRY_SALT || createHash('sha256').update(String(Math.random())).digest('hex'));
export const anonymise = (value: string): string => createHash('sha256').update(currentSalt() + value).digest('hex').slice(0, 12);

async function fileSink(record: MatchRecord) {
  const file = telemetryFile();
  await mkdir(dirname(file), { recursive: true }).catch(() => {});
  await appendFile(file, JSON.stringify(record) + '\n');
}

let warned = false;
/** Postgres when there is a database to write to, a local file otherwise. A record the
 *  database rejects still falls back to the file, so a bad connection loses nothing on a
 *  machine that has a disk worth writing to. */
function chooseSink(): Sink {
  const url = process.env.DATABASE_URL;
  if (!url) return fileSink;
  return makeDbSink(postgresQuery(url), (err, record) => {
    if (!warned) {
      warned = true;
      console.warn('telemetry: database write failed, falling back to file —', (err as Error)?.message ?? err);
    }
    fileSink(record).catch(() => {});
  });
}

// Chosen on FIRST USE, never at import time. Module imports are hoisted, so anything that
// loads `.env` in its own body runs after this file has already been evaluated — deciding
// here and now would read a DATABASE_URL that is not set yet and quietly pick the file
// sink for the whole process. Which is exactly what it did: a server configured for
// Postgres wrote every record to a local file instead, and said nothing.
let chosen: Sink | null = null;
let override: Sink | null = null;
const currentSink = (): Sink => override ?? (chosen ??= chooseSink());

/** Point the records somewhere else — a database, a queue, a test spy. Pass `null` to hand
 *  them back to the configured destination. */
export function setSink(next: Sink | null) {
  override = next;
}

/** File one record. Never throws and never blocks a game: telemetry losing a line is a
 *  nuisance, telemetry taking down a match in progress is not acceptable. */
export function recordMatch(record: MatchRecord): void {
  if (!enabled()) return;
  try {
    const done = currentSink()(record);
    if (done && typeof done.then === 'function') done.catch(() => {});
  } catch {
    /* a lost record must never surface as a broken game */
  }
}
