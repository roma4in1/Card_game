// platform/telemetry-db.ts — the Postgres sink for match records.
//
// A deployed instance cannot keep files: the container's disk is wiped on every deploy,
// every restart, and every idle spin-down. So the records have to leave the box as they
// are made, or online play produces nothing anyone will ever read.
//
// The driver is kept behind an injected `query` function on purpose. Everything that can
// actually be wrong here — the columns, the parameters, the schema running once, a failing
// database not reaching the game — is then testable without a live server to point at, and
// the only untested part is the handful of lines that open the connection.

import type { MatchRecord, Sink } from './telemetry.ts';

export type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

// A few columns worth querying directly, plus the whole record as JSONB so that adding a
// field later never needs a migration — the old rows simply do not have it.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL,
  game      TEXT        NOT NULL,
  room      TEXT        NOT NULL,
  players   SMALLINT    NOT NULL,
  bots      SMALLINT    NOT NULL,
  finished  BOOLEAN     NOT NULL,
  drawn     BOOLEAN     NOT NULL,
  actions   INTEGER     NOT NULL,
  seconds   INTEGER     NOT NULL,
  skill     SMALLINT,
  record    JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_game_at ON matches (game, at);
`;

export const INSERT = `
INSERT INTO matches (at, game, room, players, bots, finished, drawn, actions, seconds, skill, record)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;

export const SELECT_ALL = 'SELECT record FROM matches ORDER BY at';

/** The parameters for one record, in the order `INSERT` expects them. */
export function insertParams(record: MatchRecord): unknown[] {
  return [
    record.at, record.game, record.room, record.players, record.bots,
    record.finished, record.drawn, record.actions, record.seconds,
    record.options?.skill ?? null,
    JSON.stringify(record),
  ];
}

/** A sink that writes each record as a row. The schema is created once, lazily, so there
 *  is no migration step to remember and no start-up ordering to get wrong. */
export function makeDbSink(query: Query, onError: (err: unknown, record: MatchRecord) => void = () => {}): Sink {
  let ready: Promise<unknown> | null = null;
  return async (record: MatchRecord) => {
    try {
      ready ??= query(SCHEMA);
      await ready;
      await query(INSERT, insertParams(record));
    } catch (err) {
      ready = null; // a failed connection should be retried, not remembered as done
      onError(err, record);
    }
  };
}

/** Open a Postgres connection lazily: the pool is built on the first record rather than at
 *  start-up, so a database that is slow or briefly down cannot delay the server booting.
 *  `pg` is imported dynamically, which keeps it an optional dependency — a local instance
 *  with no DATABASE_URL never loads it. */
export function postgresQuery(url: string): Query {
  let pool: Promise<{ query: (sql: string, params?: unknown[]) => Promise<unknown> }> | null = null;
  return async (sql, params) => {
    pool ??= import('pg').then((pg) => {
      const Pool = (pg.default ?? pg).Pool;
      // Hosted Postgres almost always terminates TLS with a certificate this client will
      // not chain to; the alternative is refusing to connect at all.
      return new Pool({ connectionString: url, ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false }, max: 2 });
    });
    const client = await pool;
    return client.query(sql, params);
  };
}
