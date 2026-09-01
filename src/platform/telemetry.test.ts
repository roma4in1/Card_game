// telemetry.test.ts — match records. Two things matter here and they pull in opposite
// directions: the record has to carry enough to answer real questions, and it has to
// carry nothing that identifies the people who played. The privacy assertions are the
// ones worth having, because the failure mode is silent — a field quietly added later,
// and a month of names on disk before anyone looks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { setSink, recordMatch, anonymise, type MatchRecord } from './telemetry.ts';
import { createRoom, join, selectGame, addBot, startMatch, act, matchRecord, type Room } from './room.ts';

/** Collect records instead of writing them anywhere. */
function capture(): MatchRecord[] {
  const out: MatchRecord[] = [];
  setSink((r) => { out.push(r); });
  return out;
}

/** A room with `humans` people and `bots` bots, mid-match. */
function playing(gameId: string, humans: number, bots: number): Room {
  const room = createRoom('QQ11', () => 0.5);
  for (let i = 0; i < humans; i++) join(room, `Player ${i}`);
  selectGame(room, 0, gameId);
  for (let i = 0; i < bots; i++) addBot(room, 0);
  startMatch(room, 0);
  return room;
}

test('a record carries the match, and nothing that says who played it', () => {
  const room = playing('sealed-bids', 1, 1);
  const names = ['Player 0', 'Bot 2', 'QQ11'];
  // finish it the blunt way — the record is built from `result`, not from how it ended
  room.game!.state = { ...(room.game!.state as object) } as unknown;
  (room.game!.state as { over: boolean; winners: number[] }).over = true;
  (room.game!.state as { over: boolean; winners: number[] }).winners = [0];

  const rec = matchRecord(room)!;
  assert.ok(rec, 'a finished match produces a record');
  const blob = JSON.stringify(rec);
  for (const name of names) {
    assert.equal(blob.includes(name), false, `the record leaks "${name}"`);
  }
  assert.equal(blob.includes('QQ11'), false, 'the room code is hashed, never stored');
  assert.equal(rec.room, anonymise('QQ11'), 'but the same room hashes the same way, so records stay linkable');

  // and it carries what the analysis actually needs
  assert.equal(rec.game, 'sealed-bids');
  assert.equal(rec.players, 2);
  assert.equal(rec.bots, 1);
  assert.deepEqual(rec.winners, [0]);
  assert.equal(rec.finished, true);
  assert.equal(rec.drawn, false);
  assert.equal(rec.seats.length, 2);
  assert.equal(rec.seats[1].bot, true, 'which seats were bots is the whole point of the bot-v-human split');
  assert.equal(typeof rec.options.skill, 'number', 'the difficulty in force is recorded with the result');
  assert.equal(typeof rec.at, 'string');
});

test('a match is filed exactly once, however many times it is asked for', () => {
  const room = playing('sealed-bids', 1, 1);
  (room.game!.state as { over: boolean; winners: number[] }).over = true;
  (room.game!.state as { over: boolean; winners: number[] }).winners = [0];
  assert.ok(matchRecord(room), 'first call files it');
  assert.equal(matchRecord(room), null, 'and every later call is a no-op');
  assert.equal(matchRecord(room, { abandoned: true }), null, 'including the abandonment path');
});

test('a match still running is not recorded, and one walked out of is', () => {
  const room = playing('sealed-bids', 1, 1);
  assert.equal(matchRecord(room), null, 'nothing to file while it is being played');

  const you = room.game!.state as { hands: number[][] };
  assert.equal(act(room, 0, { type: 'bid', card: you.hands[0][0] }).error, undefined);
  const abandoned = matchRecord(room, { abandoned: true })!;
  assert.ok(abandoned, 'a match walked out of is worth knowing about');
  assert.equal(abandoned.finished, false);
  assert.deepEqual(abandoned.winners, []);
  assert.ok(abandoned.actions >= 1, 'and it remembers how far it got');
});

test('a match nobody played is not a match', () => {
  const room = playing('sealed-bids', 1, 1);
  assert.equal(matchRecord(room, { abandoned: true }), null, 'joining and leaving is not data');
});

test('moves are counted, and rejected ones are not', () => {
  const room = playing('sealed-bids', 1, 1);
  const hand = (room.game!.state as { hands: number[][] }).hands[0];
  act(room, 0, { type: 'bid', card: hand[0] });
  act(room, 0, { type: 'bid', card: hand[1] }); // refused: already bid this round
  act(room, 0, { type: 'nonsense' });
  const rec = matchRecord(room, { abandoned: true })!;
  assert.equal(rec.actions, 1, 'only moves the game accepted should count');
});

test('scores are read off whatever the game reports, and absent where it keeps none', () => {
  const room = playing('sealed-bids', 1, 1);
  (room.game!.state as { over: boolean; winners: number[] }).over = true;
  (room.game!.state as { over: boolean; winners: number[] }).winners = [0];
  const rec = matchRecord(room)!;
  for (const seat of rec.seats) assert.equal(typeof seat.score, 'number', 'Sealed Bids keeps a score');

  const quiet = playing('quoridor', 1, 1);
  (quiet.game!.state as { over: boolean }).over = true;
  const other = matchRecord(quiet, { abandoned: true })!;
  assert.ok(other, 'a game without a scoreboard still files a record');
  for (const seat of other.seats) assert.ok(seat.score === null || typeof seat.score === 'number');
});

test('the sink never lets a failure reach the game', () => {
  const records = capture();
  setSink(() => { throw new Error('disk on fire'); });
  assert.doesNotThrow(() => recordMatch({ at: '', game: 'x', room: 'y', players: 2, bots: 0, options: {}, seats: [], winners: [], drawn: false, finished: true, actions: 0, seconds: 0 }));
  setSink((r) => { records.push(r); });
  recordMatch({ at: '', game: 'x', room: 'y', players: 2, bots: 0, options: {}, seats: [], winners: [], drawn: false, finished: true, actions: 0, seconds: 0 });
  assert.equal(records.length, 1, 'and a working sink still receives them');
});

test('settings are read when a record is written, not when this module was imported', async () => {
  // The bug this guards shipped, and only turned up by watching a real write: module
  // imports are hoisted above the `loadEnvFile()` call in whatever loads this file, so a
  // setting captured at import time is read BEFORE .env exists. A server pointed at
  // Postgres therefore chose the file sink at start-up and wrote every record to a local
  // file, reporting nothing wrong. Anything configurable has to be read late.
  setSink(null); // hand records back to the configured sink; an earlier test redirected them
  const target = pathJoin(tmpdir(), `telemetry-late-${process.pid}.jsonl`);
  await rm(target, { force: true });

  const previousFile = process.env.TELEMETRY_FILE;
  const previousDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; // force the file sink whatever the caller's env holds
  process.env.TELEMETRY_FILE = target; // set AFTER the module under test was imported

  try {
    recordMatch({
      at: new Date().toISOString(), game: 'late-binding', room: 'r', players: 2, bots: 0,
      options: {}, seats: [], winners: [], drawn: false, finished: true, actions: 1, seconds: 1,
    });
    await new Promise((r) => setTimeout(r, 200));
    const written = await readFile(target, 'utf8').catch(() => '');
    assert.match(written, /late-binding/, 'the record should follow a setting made after import');
  } finally {
    await rm(target, { force: true });
    if (previousFile === undefined) delete process.env.TELEMETRY_FILE;
    else process.env.TELEMETRY_FILE = previousFile;
    if (previousDb !== undefined) process.env.DATABASE_URL = previousDb;
  }
});
