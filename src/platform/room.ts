// platform/room.ts — the game-agnostic room. Owns the lobby, seats, host, chat,
// reconnection and the game-selection lifecycle. It holds NOTHING game-specific:
// when the host starts, it instantiates the chosen game (a GameDef) and routes
// in-game actions to it. The view it sends each client is the room's lobby info,
// or — once playing — the active game's private view wrapped with room identity.

import { randomInt, randomBytes } from 'node:crypto';
import type { GameContext, GameDef, Rng } from './types.ts';
import { GAMES, GAME_SUMMARIES, DEFAULT_GAME } from './registry.ts';

export const MAX_SEATS = 8;

const cryptoRng: Rng = () => randomInt(0, 2 ** 30) / 2 ** 30;

interface Member {
  token: string;
  name: string;
  connected: boolean;
  bot?: boolean; // seat taken over by AI (after the human left)
  steppedOut?: boolean; // left the current match to wait in the lobby (a bot finishes their seat)
}

export interface Room {
  code: string;
  rng: Rng;
  members: (Member | null)[]; // length MAX_SEATS
  host: number;
  phase: 'lobby' | 'playing';
  gameId: string;
  options: Record<string, number>; // host-chosen settings for the selected game
  game: { def: GameDef; state: unknown } | null;
  log: string[];
  lastActivity: number;
}

/** Default values for a game's host-configurable options. */
function defaultOptions(gameId: string): Record<string, number> {
  const specs = GAMES[gameId]?.options ?? [];
  return Object.fromEntries(specs.map((o) => [o.key, o.default]));
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function ctxFor(room: Room): GameContext {
  return { rng: room.rng, now: Date.now() };
}
function log(room: Room, msg: string) {
  room.log.push(msg);
  if (room.log.length > 40) room.log.shift();
}
function seats(room: Room): number[] {
  const out: number[] = [];
  room.members.forEach((m, s) => m && out.push(s));
  return out;
}
function connectedSeats(room: Room): number[] {
  return seats(room).filter((s) => room.members[s]!.connected);
}

export function createRoom(code: string, rng: Rng = cryptoRng): Room {
  return {
    code,
    rng,
    members: new Array(MAX_SEATS).fill(null),
    host: 0,
    phase: 'lobby',
    gameId: DEFAULT_GAME,
    options: defaultOptions(DEFAULT_GAME),
    game: null,
    log: [],
    lastActivity: Date.now(),
  };
}

export type JoinResult =
  | { ok: true; seat: number; token: string; reconnected: boolean }
  | { ok: false; reason: 'full' | 'in-progress' };

/** Join (or rejoin via token) a room. */
export function join(room: Room, token: string | undefined, name: string | undefined): JoinResult {
  if (token) {
    for (const s of seats(room)) {
      const m = room.members[s]!;
      if (m.token === token) {
        m.connected = true;
        log(room, `${m.name} reconnected.`);
        if (room.game) room.game.def.onReconnect?.(room.game.state, s);
        return { ok: true, seat: s, token, reconnected: true };
      }
    }
  }
  if (room.phase !== 'lobby') return { ok: false, reason: 'in-progress' };
  const free = room.members.findIndex((m) => m === null);
  if (free === -1) return { ok: false, reason: 'full' };

  const newToken = randomBytes(16).toString('hex');
  const cleanName = (name || `Player ${free + 1}`).slice(0, 16);
  room.members[free] = { token: newToken, name: cleanName, connected: true };
  if (seats(room).length === 1) room.host = free;
  log(room, `${cleanName} joined the lobby.`);
  return { ok: true, seat: free, token: newToken, reconnected: false };
}

export function setConnected(room: Room, seat: number, connected: boolean) {
  const m = room.members[seat];
  if (!m || m.connected === connected) return;
  m.connected = connected;
  log(room, `${m.name} ${connected ? 'reconnected' : 'disconnected'}.`);
  if (room.game) {
    if (connected) room.game.def.onReconnect?.(room.game.state, seat);
    else room.game.def.onDisconnect?.(room.game.state, seat, ctxFor(room));
  }
}

/** Host picks which game to play (lobby only). */
export function selectGame(room: Room, seat: number, gameId: string): ActionResult {
  if (room.phase !== 'lobby') return fail('Already playing.');
  if (seat !== room.host) return fail('Only the host can choose the game.');
  if (!GAMES[gameId]) return fail('Unknown game.');
  room.gameId = gameId;
  room.options = defaultOptions(gameId); // reset settings to the new game's defaults
  log(room, `Host chose ${GAMES[gameId].name}.`);
  return ok;
}

/** Host adjusts a numeric game setting (lobby only). */
export function setOption(room: Room, seat: number, key: string, value: unknown): ActionResult {
  if (room.phase !== 'lobby') return fail('Already playing.');
  if (seat !== room.host) return fail('Only the host can change settings.');
  const spec = (GAMES[room.gameId].options ?? []).find((o) => o.key === key);
  if (!spec) return fail('Unknown setting.');
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return fail('Bad value.');
  room.options[key] = Math.min(spec.max, Math.max(spec.min, v));
  return ok;
}

/** Host starts the selected game with everyone currently connected. */
export function startMatch(room: Room, seat: number): ActionResult {
  if (room.phase !== 'lobby') return fail('The match has already started.');
  if (seat !== room.host) return fail('Only the host can start.');
  const def = GAMES[room.gameId];
  const joined = connectedSeats(room);
  if (joined.length < def.minPlayers) return fail(`Need at least ${def.minPlayers} connected players.`);
  if (joined.length > def.maxPlayers) return fail(`${def.name} supports at most ${def.maxPlayers} players.`);
  const reason = def.validateStart?.(joined);
  if (reason) return fail(reason);

  buildGame(room, def, joined);
  log(room, `${def.name} started with ${joined.length} players.`);
  return ok;
}

/** Instantiate the chosen game for the given seats and enter the playing phase. */
function buildGame(room: Room, def: GameDef, joined: number[]) {
  const players = joined.map((s) => ({ seat: s, name: room.members[s]!.name }));
  room.game = { def, state: def.create({ seats: joined, players, options: room.options }, ctxFor(room)) };
  room.phase = 'playing';
}

/** Host replays the SAME game with the same players once the match is over —
 *  no trip back to the lobby. Players who stepped out are brought back in. */
export function restart(room: Room, seat: number): ActionResult {
  if (seat !== room.host) return fail('Only the host can restart.');
  if (room.phase !== 'playing' || !room.game) return fail('No match to restart.');
  if (!room.game.def.result(room.game.state).over) return fail('The match is not over yet.');
  for (const s of seats(room)) {
    const m = room.members[s]!;
    if (m.steppedOut) { m.steppedOut = false; m.bot = false; }
  }
  const def = GAMES[room.gameId];
  const joined = connectedSeats(room);
  if (joined.length < def.minPlayers) return fail(`Need at least ${def.minPlayers} players.`);
  buildGame(room, def, joined);
  log(room, `${def.name} — playing again.`);
  return ok;
}

/** Route an in-game action to the active game. */
export function act(room: Room, seat: number, msg: Record<string, unknown>): ActionResult {
  if (room.phase !== 'playing' || !room.game) return fail('No game in progress.');
  return room.game.def.act(room.game.state, seat, msg, ctxFor(room)) ?? ok;
}

/** Leave the room: a bot takes over the seat so play continues; the host is
 *  handed to another human if the leaver was hosting. */
export function leave(room: Room, seat: number): ActionResult {
  const m = room.members[seat];
  if (!m || m.bot) return ok;
  m.bot = true;
  m.connected = true; // bots are always "present"
  if (room.game) room.game.def.onReconnect?.(room.game.state, seat); // clear any disconnect flag
  log(room, `${m.name} left — a bot took over their seat.`);
  if (room.host === seat) {
    const human = seats(room).find((s) => !room.members[s]!.bot);
    if (human !== undefined) room.host = human; // never hand the host to a bot
  }
  return ok;
}

/** The next action a bot-controlled seat should take, or null if none is due. */
export function botMove(room: Room): { seat: number; msg: Record<string, unknown> } | null {
  if (room.phase !== 'playing' || !room.game || !room.game.def.bot) return null;
  const def = room.game.def;
  for (const s of seats(room)) {
    if (!room.members[s]!.bot) continue;
    const msg = def.bot!(room.game.state, s, ctxFor(room));
    if (msg) return { seat: s, msg };
  }
  return null;
}

/** Is any real (non-bot) player still seated? Once false, the room is abandoned. */
export function hasHumans(room: Room): boolean {
  return seats(room).some((s) => !room.members[s]!.bot);
}

/** Tear down the active match and return everyone to the lobby. Players who stepped
 *  out during the match rejoin as normal members (their bot stand-in is dropped). */
function toLobby(room: Room) {
  room.game = null;
  room.phase = 'lobby';
  for (const s of seats(room)) {
    const m = room.members[s]!;
    if (m.steppedOut) {
      m.steppedOut = false;
      m.bot = false;
    }
  }
}

/** From a finished match, return everyone to the lobby to pick/start again. */
export function rematch(room: Room, _seat: number): ActionResult {
  if (room.phase !== 'playing' || !room.game) return ok;
  if (!room.game.def.result(room.game.state).over) return ok; // only once the match is over
  toLobby(room);
  log(room, 'Back to the lobby.');
  return ok;
}

/** Leave the current match and wait in this room's lobby. A bot finishes the seat so
 *  the others can keep playing; when the match ends the player is back in the lobby.
 *  If they're the last human, the match simply ends and everyone returns to the lobby. */
export function backToLobby(room: Room, seat: number): ActionResult {
  const m = room.members[seat];
  if (!m) return fail('Not in this room.');
  if (room.phase !== 'playing' || !room.game) return ok; // already in the lobby
  const otherHumans = seats(room).filter((s) => s !== seat && !room.members[s]!.bot && !room.members[s]!.steppedOut);
  if (otherHumans.length === 0) {
    toLobby(room);
    log(room, 'Back to the lobby.');
    return ok;
  }
  m.steppedOut = true;
  m.bot = true; // a bot finishes their seat for the rest of the match
  if (room.host === seat) room.host = otherHumans[0]; // never leave a stepped-out player hosting
  log(room, `${m.name} stepped out to the lobby.`);
  return ok;
}

/** Host removes a player. In the lobby the seat is freed; mid-match a bot takes the seat
 *  so play continues and the booted human is dropped (the server closes their socket). */
export function kick(room: Room, seat: number, target: number): ActionResult {
  if (seat !== room.host) return fail('Only the host can remove players.');
  if (target === seat) return fail('You cannot remove yourself.');
  const m = room.members[target];
  if (!m) return ok;
  if (room.phase === 'playing' && room.game) {
    if (m.bot) return ok; // already AI-controlled; can't free a live seat mid-match
    m.bot = true; // a bot finishes the seat; the human is booted by the server
    log(room, `${m.name} was removed by the host — a bot took their seat.`);
    return ok;
  }
  log(room, `${m.name} was removed by the host.`);
  room.members[target] = null;
  return ok;
}

/** Periodic tick so games can enforce timeouts/clocks. Returns true if state changed. */
export function tick(room: Room): boolean {
  if (room.phase === 'playing' && room.game) return room.game.def.tick?.(room.game.state, ctxFor(room)) === true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-seat view: room identity + (when playing) the active game's private view.
// ---------------------------------------------------------------------------

export function viewFor(room: Room, seat: number): Record<string, unknown> {
  const me = room.members[seat]!;
  const roster = seats(room).map((s) => {
    const m = room.members[s]!;
    return { seat: s, name: m.name, connected: m.connected, host: s === room.host, bot: !!m.bot };
  });
  const identity = {
    type: 'state',
    room: room.code,
    seat,
    host: room.host,
    youAreHost: seat === room.host,
    gameId: room.gameId,
    roster,
  };

  // The lobby view is shown in the lobby, and to anyone who stepped out of an
  // in-progress match (they wait here until it ends).
  const inLobby = room.phase === 'lobby' || !room.game;
  if (inLobby || me.steppedOut) {
    const matchInProgress = !inLobby;
    return {
      ...identity,
      phase: 'lobby',
      you: { seat, name: me.name, connected: me.connected },
      lobby: {
        canStart: !matchInProgress && seat === room.host && connectedSeats(room).length >= 2,
        canKick: !matchInProgress && seat === room.host,
        matchInProgress,
        selectedGame: room.gameId,
        games: GAME_SUMMARIES,
        options: room.options,
      },
      log: room.log.slice(-15),
      matchWinner: null,
    };
  }

  // Playing: the game's private view, wrapped with room identity. The game's
  // `view` produces phase/you/others/pot/etc.; the room overlays who's who.
  const gv = room.game.def.view(room.game.state, seat);
  return { ...gv, ...identity };
}
