// telemetry-db.test.ts — the Postgres sink, tested against a fake query function.
//
// A live database is not needed to check the things that actually go wrong here: writing
// the wrong columns, drifting the parameter order, running the schema on every insert, or
// letting a database outage surface inside a game. The real driver is a handful of lines
// around `pool.query`, and it is the only part not covered here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDbSink, insertParams, INSERT, SCHEMA, type Query } from './telemetry-db.ts';
import type { MatchRecord } from './telemetry.ts';

const record: MatchRecord = {
  at: '2026-09-01T12:00:00.000Z',
  game: 'quoridor',
  room: 'ab12cd34ef56',
  players: 2,
  bots: 1,
  options: { skill: 3, timer: 0 },
  seats: [
    { seat: 0, bot: false, score: null, won: true },
    { seat: 1, bot: true, score: null, won: false },
  ],
  winners: [0],
  drawn: false,
  finished: true,
  actions: 41,
  seconds: 275,
};

/** Records every call instead of talking to a database. */
function spy(fail = false) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const query: Query = async (sql, params) => {
    calls.push({ sql, params });
    if (fail) throw new Error('connection refused');
    return { rows: [] };
  };
  return { calls, query };
}

test('a record becomes one row, with the parameters in the order the statement expects', async () => {
  const { calls, query } = spy();
  await makeDbSink(query)(record);

  assert.equal(calls.length, 2, 'schema first, then the insert');
  assert.equal(calls[0].sql, SCHEMA);
  assert.equal(calls[1].sql, INSERT);

  // The count must match the statement, or Postgres silently binds the wrong values.
  const placeholders = new Set(INSERT.match(/\$\d+/g));
  assert.equal(calls[1].params!.length, placeholders.size, 'a parameter for every placeholder and no more');

  const [at, game, room, players, bots, finished, drawn, actions, seconds, skill, blob] = calls[1].params!;
  assert.equal(at, record.at);
  assert.equal(game, 'quoridor');
  assert.equal(room, 'ab12cd34ef56');
  assert.equal(players, 2);
  assert.equal(bots, 1);
  assert.equal(finished, true);
  assert.equal(drawn, false);
  assert.equal(actions, 41);
  assert.equal(seconds, 275);
  assert.equal(skill, 3, 'the difficulty is lifted into its own column, since it is the thing most often grouped by');
  assert.deepEqual(JSON.parse(blob as string), record, 'and the whole record is kept, so a field added later needs no migration');
});

test('a game with no skill setting stores null rather than failing', () => {
  const [, , , , , , , , , skill] = insertParams({ ...record, options: {} });
  assert.equal(skill, null);
});

test('the schema is created once, not on every record', async () => {
  const { calls, query } = spy();
  const sink = makeDbSink(query);
  await sink(record);
  await sink(record);
  await sink(record);
  assert.equal(calls.filter((c) => c.sql === SCHEMA).length, 1, 'one schema call');
  assert.equal(calls.filter((c) => c.sql === INSERT).length, 3, 'three inserts');
});

test('a database that is down is reported, never thrown into the game', async () => {
  const seen: MatchRecord[] = [];
  const { query } = spy(true);
  const sink = makeDbSink(query, (_err, rec) => seen.push(rec));
  await assert.doesNotReject(() => Promise.resolve(sink(record)));
  assert.deepEqual(seen, [record], 'the record is handed to the fallback rather than lost silently');
});

test('a failed connection is retried on the next record, not written off', async () => {
  let failing = true;
  const calls: string[] = [];
  const query: Query = async (sql) => {
    calls.push(sql);
    if (failing) throw new Error('down');
    return { rows: [] };
  };
  const sink = makeDbSink(query, () => {});
  await sink(record);
  failing = false;
  await sink(record);
  assert.equal(calls.filter((s) => s === SCHEMA).length, 2, 'it tries to set up again after a failure');
  assert.equal(calls.filter((s) => s === INSERT).length, 1, 'and the second record lands');
});
