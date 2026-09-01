// platform/env.ts — load local settings before anything reads them.
//
// Import this FIRST in an entry point. Module imports are evaluated in source order, so
// putting it at the top means .env is in place before the modules that depend on it load.
//
// Three ways a real deployment supplies DATABASE_URL, all of which have to work:
//   • Render/Fly environment variables — already in process.env, nothing to do
//   • a Render Secret File named `.env` — mounted at the project root AND /etc/secrets/
//   • a local .env file, gitignored, for development
//
// A value already in the environment always wins: a dashboard variable is more deliberate
// than a file that happens to be lying next to the code.

import { existsSync } from 'node:fs';

const CANDIDATES = ['.env', '/etc/secrets/.env'];

const preset = new Set(Object.keys(process.env));
for (const path of CANDIDATES) {
  try {
    if (existsSync(path)) process.loadEnvFile(path);
  } catch {
    /* unreadable or malformed — the environment is expected to supply what it needs */
  }
}
// Anything that was already set stays as it was.
for (const key of preset) {
  const original = process.env[key];
  if (original !== undefined) process.env[key] = original;
}

/** Where DATABASE_URL came from, for a startup line that makes a misconfiguration obvious
 *  rather than leaving it to be discovered through an empty table weeks later. */
export function describeTelemetryTarget(): string {
  if (process.env.TELEMETRY === 'off') return 'match records: off';
  if (process.env.DATABASE_URL) return 'match records → database';
  return `match records → ${process.env.TELEMETRY_FILE || 'data/matches.jsonl'} (no DATABASE_URL; a deployed instance loses these on restart)`;
}
