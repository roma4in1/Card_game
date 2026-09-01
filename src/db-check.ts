// db-check.ts — confirm the match-record database is reachable, and create its table.
// Run with `npm run db:check`. Safe to run repeatedly; it changes no existing data.
//
// This exists so the connection can be proved on its own, rather than discovered later
// through matches that quietly went nowhere.

import './platform/env.ts'; // settings first, before anything reads them
import { promises as dns } from 'node:dns';
import { postgresQuery, SCHEMA } from './platform/telemetry-db.ts';

/** Say what went wrong in terms of what to do about it. Where the failure is a name that
 *  will not resolve, look the name up properly rather than guessing: "no IPv4 address, an
 *  IPv6 one" is a diagnosis, "it might be IPv6-only" is a hunch. */
async function diagnose(err: { code?: string; message?: string }, url: string): Promise<string[]> {
  const message = err?.message ?? String(err);
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '(unparseable)';
    }
  })();

  if (/password authentication failed/i.test(message)) {
    return [
      'The host answered, so the address is right — the password is not.',
      'Supabase → Project Settings → Database → Reset database password.',
      'Note it is the DATABASE password, not your Supabase account password.',
    ];
  }
  if (err?.code === 'ENOTFOUND') {
    const v4 = await dns.resolve4(host).catch(() => null);
    const v6 = await dns.resolve6(host).catch(() => null);
    if (!v4 && v6) {
      return [
        `${host} has no IPv4 address — only IPv6 (${v6[0]}).`,
        'Your network has no route to IPv6, so it cannot be reached from here. Supabase\'s',
        'direct db.*.supabase.co hosts are IPv6-only; the pooler is not.',
        '',
        'Fix: Supabase → Connect → Session pooler, and copy that string. It looks like',
        '  postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres',
        'Note the username carries the project ref (postgres.PROJECT_REF), not plain postgres.',
        'It stores exactly the same rows — only the route in differs.',
      ];
    }
    if (!v4 && !v6) {
      return [
        `${host} does not exist in DNS at all.`,
        'Check the project reference in the host name, and that the project has not been deleted.',
      ];
    }
    return [`${host} resolves (${(v4 ?? v6)![0]}) but the connection could not be opened — check any firewall.`];
  }
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNREFUSED') {
    return [`Could not reach ${host}. Check the project is not paused, and that the port is open from here.`];
  }
  if (/Invalid URL|Invalid connection string/i.test(message)) {
    return [
      'The connection string will not parse.',
      'If the password contains @ : / ? # or %, percent-encode it (@ becomes %40).',
    ];
  }
  return [message];
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('DATABASE_URL is not set.');
    console.log('Copy .env.example to .env and put the connection string in it, then run this again.');
    console.log('Without it, match records go to data/matches.jsonl — fine locally, lost once deployed.');
    return 1;
  }
  if (url.includes('[YOUR-PASSWORD]') || url.includes('YOUR-PASSWORD')) {
    console.log('DATABASE_URL still has the [YOUR-PASSWORD] placeholder in it.');
    console.log('Replace it in .env with the real database password, then run this again.');
    return 1;
  }

  const safe = url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:••••@'); // never print the password
  console.log(`connecting to ${safe}`);
  const query = postgresQuery(url);
  try {
    await query(SCHEMA);
    const res = (await query('SELECT count(*)::int AS n FROM matches')) as { rows: { n: number }[] };
    const n = res.rows?.[0]?.n ?? 0;
    console.log('\n✅ connected, and the `matches` table is ready.');
    console.log(`   ${n} record${n === 1 ? '' : 's'} stored so far.`);
    console.log('\nThe server will write here whenever DATABASE_URL is set — locally via .env,');
    console.log('and in production once it is set in the Render dashboard.');
    console.log('Read them back any time with `npm run stats`.');
    return 0;
  } catch (err) {
    console.log('\n❌ could not use the database.\n');
    for (const line of await diagnose(err as { code?: string; message?: string }, url)) console.log('   ' + line);
    console.log('\nNothing is lost meanwhile: with the database unreachable the server falls back');
    console.log('to data/matches.jsonl rather than dropping records.');
    return 1;
  }
}

main().then(
  (code) => process.exit(code), // the pool would otherwise hold the process open
  (err) => {
    console.error('unexpected failure:', err?.message ?? err);
    process.exit(1);
  },
);
