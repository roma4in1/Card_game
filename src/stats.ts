// stats.ts — read the match records back and answer the questions the bot benchmarks
// could not. Run with `npm run stats` (optionally `npm run stats -- path/to/file.jsonl`).
//
// Everything the bots were tuned against was bot-versus-bot. These are the numbers that
// come from people actually playing: whether a difficulty is beatable, whether moving
// first decides games, how often real matches end level, and what gets walked out of.

import './platform/env.ts'; // settings first, before anything reads them
import { readFile } from 'node:fs/promises';
import type { MatchRecord } from './platform/telemetry.ts';
import { postgresQuery, SELECT_ALL } from './platform/telemetry-db.ts';

const FILE = process.argv[2] || process.env.TELEMETRY_FILE || 'data/matches.jsonl';
const SKILL_NAME = ['', 'Casual', 'Steady', 'Sharp'];

const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(0)}%` : '—');
const pad = (s: string, n: number) => s.padEnd(n);
const num = (s: string, n: number) => s.padStart(n);

/** A win rate is meaningless without knowing how much it rests on. */
function withCount(part: number, whole: number): string {
  return whole ? `${pct(part, whole)} (${whole})` : '—';
}

/** Read the records from wherever this instance actually writes them: the database when
 *  one is configured — which is where a deployed server's records go — otherwise the local
 *  file. Naming a file explicitly always wins, so a downloaded export can be read too. */
async function load(): Promise<MatchRecord[] | null> {
  const url = process.env.DATABASE_URL;
  if (url && !process.argv[2]) {
    const rows = (await postgresQuery(url)(SELECT_ALL)) as { rows: { record: MatchRecord | string }[] };
    console.log('reading from the database\n');
    return rows.rows.map((r) => (typeof r.record === 'string' ? JSON.parse(r.record) : r.record));
  }
  let text: string;
  try {
    text = await readFile(FILE, 'utf8');
  } catch {
    console.log(`No match records yet at ${FILE}.`);
    console.log('They are written as matches finish — play a few games, then run this again.');
    console.log('(A deployed server writes to DATABASE_URL instead; set it here to read those.)');
    return null;
  }
  const out: MatchRecord[] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a truncated final line is normal if the server died mid-write */
    }
  }
  return out;
}

async function main() {
  const all = await load();
  if (!all) return;
  if (!all.length) return console.log('No readable records yet.');

  const finished = all.filter((m) => m.finished);
  const from = all.reduce((a, m) => (m.at < a ? m.at : a), all[0].at).slice(0, 10);
  console.log(`${all.length} matches recorded since ${from} — ${finished.length} played out, ${all.length - finished.length} abandoned\n`);

  // ── per game ───────────────────────────────────────────────────────────────
  console.log(pad('GAME', 18) + num('played', 7) + num('done', 6) + num('drawn', 7) + num('mins', 6) + num('moves', 7));
  const games = [...new Set(all.map((m) => m.game))].sort();
  for (const game of games) {
    const mine = all.filter((m) => m.game === game);
    const done = mine.filter((m) => m.finished);
    // Length and move counts are only meaningful for matches that actually ended; with
    // none, say so rather than printing a zero that reads like a real measurement.
    const mins = done.length ? (done.reduce((a, m) => a + m.seconds, 0) / done.length / 60).toFixed(1) : '—';
    const moves = done.length ? (done.reduce((a, m) => a + m.actions, 0) / done.length).toFixed(0) : '—';
    console.log(
      pad(game, 18) + num(String(mine.length), 7) + num(pct(done.length, mine.length), 6) +
      num(pct(done.filter((m) => m.drawn).length, done.length), 7) +
      num(mins, 6) + num(moves, 7),
    );
  }

  // ── are the bots set at the right strength? ────────────────────────────────
  // Only matches mixing people and bots say anything about this.
  const mixed = finished.filter((m) => m.bots > 0 && m.bots < m.players);
  console.log(`\nHUMANS v BOTS  (${mixed.length} mixed matches)`);
  if (!mixed.length) console.log('  nothing yet — needs matches with both a person and a bot in them');
  else {
    console.log('  ' + pad('skill', 10) + num('matches', 9) + num('human wins', 13));
    for (const skill of [1, 2, 3]) {
      const at = mixed.filter((m) => (m.options.skill ?? 3) === skill);
      const humanWon = at.filter((m) => m.seats.some((s) => !s.bot && s.won)).length;
      console.log('  ' + pad(SKILL_NAME[skill], 10) + num(String(at.length), 9) + num(withCount(humanWon, at.length), 13));
    }
  }

  // ── does moving first decide it? ───────────────────────────────────────────
  // Seat order is turn order in most of these games, so a lopsided first seat is a real
  // fairness problem rather than a curiosity.
  console.log('\nFIRST SEAT  (decided matches only — a draw favours nobody)');
  console.log('  ' + pad('game', 18) + num('decided', 9) + num('seat 0 wins', 14) + num('expected', 10));
  for (const game of games) {
    const decided = finished.filter((m) => m.game === game && !m.drawn && m.winners.length === 1);
    if (decided.length < 5) continue; // too few to mean anything
    const firstWon = decided.filter((m) => m.winners[0] === m.seats[0].seat).length;
    const expected = decided.reduce((a, m) => a + 1 / m.players, 0);
    console.log(
      '  ' + pad(game, 18) + num(String(decided.length), 9) + num(withCount(firstWon, decided.length), 14) +
      num(pct(expected, decided.length), 10),
    );
  }

  // ── all-human matches, which are the ones that matter most ─────────────────
  const human = finished.filter((m) => m.bots === 0);
  console.log(`\nALL-HUMAN MATCHES: ${human.length}`);
  if (human.length) {
    for (const game of [...new Set(human.map((m) => m.game))].sort()) {
      const mine = human.filter((m) => m.game === game);
      console.log(`  ${pad(game, 18)}${num(String(mine.length), 5)} played, ${pct(mine.filter((m) => m.drawn).length, mine.length)} drawn`);
    }
  }
}

main().then(
  () => process.exit(0), // the database pool would otherwise hold the process open
  (err) => {
    console.error('could not read the records:', err?.message ?? err);
    if (process.env.DATABASE_URL) console.error('run `npm run db:check` for a diagnosis of the connection.');
    process.exit(1);
  },
);
