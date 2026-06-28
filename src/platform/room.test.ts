// room.test.ts — the game-agnostic room: lobby, host, game selection, routing,
// reconnection and rematch. The game rules themselves live (and are tested) in
// games/win-or-die; here we only check the room wires them up correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom, join, setConnected, selectGame, setOption, startMatch, act, rematch, backToLobby, kick, leave, botMove, hasHumans, viewFor,
  type Room,
} from './room.ts';

function seatList(room: Room): number[] {
  return room.members.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
}
import { DEFAULT_GAME } from './registry.ts';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}

function lobby(n: number, seed = 1): Room {
  const room = createRoom('T', lcg(seed));
  for (let i = 0; i < n; i++) join(room, undefined, `P${i}`);
  return room;
}
function playing(n: number, seed = 1): Room {
  const room = lobby(n, seed);
  startMatch(room, room.host);
  return room;
}

// ---------------------------------------------------------------------------
// Lobby & start
// ---------------------------------------------------------------------------

test('lobby gathers players; only the host can start; needs 2+', () => {
  const room = lobby(3);
  assert.equal(room.phase, 'lobby');
  const hv = viewFor(room, room.host) as any;
  assert.equal(hv.phase, 'lobby');
  assert.equal(hv.lobby.canStart, true);
  assert.equal(hv.lobby.selectedGame, DEFAULT_GAME);
  assert.ok(Array.isArray(hv.lobby.games) && hv.lobby.games.length >= 1);

  assert.match(startMatch(room, (room.host + 1) % 3).error!, /host/i);
  const solo = lobby(1);
  assert.match(startMatch(solo, solo.host).error!, /at least 2/i);

  assert.equal(startMatch(room, room.host).error, undefined);
  assert.equal(room.phase, 'playing');
  assert.ok(room.game);
  // The playing view is the game's view wrapped with room identity.
  const pv = viewFor(room, room.host) as any;
  assert.equal(pv.type, 'state');
  assert.equal(pv.youAreHost, true);
  assert.equal(pv.phase, 'bet1');
  assert.equal(pv.roster.length, 3);
});

test('the host can set a game option in range; it resets on game switch and reaches create', () => {
  const room = lobby(2);
  selectGame(room, room.host, 'memory-match');
  assert.equal(room.options.pairs, 12, 'defaults to 12 pairs');
  assert.match(setOption(room, (room.host + 1) % 2, 'pairs', 18).error!, /host/i);
  setOption(room, room.host, 'pairs', 18);
  assert.equal(room.options.pairs, 18);
  setOption(room, room.host, 'pairs', 999); // clamped to max
  assert.equal(room.options.pairs, 20);
  setOption(room, room.host, 'pairs', 1); // clamped to min
  assert.equal(room.options.pairs, 10);
  assert.match(setOption(room, room.host, 'bogus', 5).error!, /unknown/i);
  // switching games resets options to that game's defaults (win-or-die has none)
  selectGame(room, room.host, 'win-or-die');
  assert.deepEqual(room.options, {});
  // the chosen value flows into create
  selectGame(room, room.host, 'memory-match');
  setOption(room, room.host, 'pairs', 14);
  startMatch(room, room.host);
  assert.equal((viewFor(room, room.host) as any).pairsTotal, 14, 'the match was built with 14 pairs');
});

test('the host can switch games in the lobby; non-hosts cannot', () => {
  const room = lobby(2);
  assert.match(selectGame(room, (room.host + 1) % 2, DEFAULT_GAME).error!, /host/i);
  assert.match(selectGame(room, room.host, 'no-such-game').error!, /unknown/i);
  assert.equal(selectGame(room, room.host, DEFAULT_GAME).error, undefined);
  assert.equal(room.gameId, DEFAULT_GAME);
});

test('a player cannot join a match in progress, but a token reconnect works', () => {
  const room = playing(2);
  const late = join(room, undefined, 'late');
  assert.equal(late.ok, false);
  const tok = room.members[0]!.token;
  const rj = join(room, tok, 'P0');
  assert.equal(rj.ok, true);
  assert.equal((rj as any).reconnected, true);
});

test('leaving hands the seat to a bot and passes the host to a human', () => {
  const room = lobby(3);
  const host = room.host;
  assert.equal(hasHumans(room), true);
  // the host leaves: their seat becomes a bot, host passes to a human seat
  leave(room, host);
  assert.ok(room.members[host], 'seat is still occupied');
  assert.equal(room.members[host]!.bot, true);
  assert.notEqual(room.host, host);
  assert.equal(room.members[room.host]!.bot ?? false, false, 'a bot is never the host');
});

test('backToLobby steps a player out (bot finishes their seat); the last to leave ends the match', () => {
  const room = playing(2, 7);
  const host = room.host;
  const other = seatList(room).find((s) => s !== host)!;
  // a non-host steps out: a bot takes over, the others keep playing
  backToLobby(room, other);
  assert.equal(room.members[other]!.steppedOut, true);
  assert.equal(room.members[other]!.bot, true);
  assert.equal(room.phase, 'playing', 'the others keep playing');
  const lv = viewFor(room, other) as any;
  assert.equal(lv.phase, 'lobby', 'the stepped-out player sees the lobby');
  assert.equal(lv.lobby.matchInProgress, true);
  // the last human leaves → the match ends and everyone is back in the lobby, restored
  backToLobby(room, host);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.game, null);
  assert.equal(room.members[other]!.steppedOut ?? false, false, 'stepped-out player is restored');
  assert.equal(room.members[other]!.bot ?? false, false);
});

test('the host stepping out hands the host to another human', () => {
  const room = playing(3, 3);
  const host = room.host;
  backToLobby(room, host);
  assert.equal(room.members[host]!.steppedOut, true);
  assert.notEqual(room.host, host);
  assert.equal(room.members[room.host]!.steppedOut ?? false, false, 'a stepped-out player never hosts');
  assert.equal(room.members[room.host]!.bot ?? false, false);
});

test('the host can kick players (and bots) from the lobby; nobody else can, and not mid-match', () => {
  const room = lobby(3);
  const host = room.host;
  const victim = seatList(room).find((s) => s !== host)!;
  assert.match(kick(room, victim, host).error!, /host/i, 'non-host cannot kick');
  assert.match(kick(room, host, host).error!, /yourself/i);
  assert.equal(kick(room, host, victim).error, undefined);
  assert.equal(room.members[victim], null, 'kicked seat is freed');
  // bots can be kicked too
  const other = seatList(room).find((s) => s !== host)!;
  leave(room, other); // turns `other` into a bot
  assert.equal(room.members[other]!.bot, true);
  kick(room, host, other);
  assert.equal(room.members[other], null, 'bot removed');
  // cannot kick during a match
  const r2 = playing(2);
  assert.match(kick(r2, r2.host, seatList(r2).find((s) => s !== r2.host)!).error!, /lobby/i);
});

test('a bot plays its turn through botMove', () => {
  const room = lobby(2);
  startMatch(room, room.host);
  // hand seat 1 to a bot, then it should produce a legal move on its turn
  leave(room, 1);
  // drive the match purely via bot moves + host autoplay until something happens
  let moves = 0;
  for (let i = 0; i < 50; i++) {
    const mv = botMove(room);
    if (!mv) break;
    assert.equal(mv.seat, 1, 'only the bot seat is driven');
    assert.equal(act(room, mv.seat, mv.msg).error, undefined, 'bot moves are legal');
    moves++;
  }
  assert.ok(moves > 0, 'the bot took at least one action');
});

test('hasHumans is false once every seat is a bot', () => {
  const room = lobby(2);
  leave(room, 0);
  assert.equal(hasHumans(room), true);
  leave(room, 1);
  assert.equal(hasHumans(room), false);
});

// ---------------------------------------------------------------------------
// Routing & reconnection
// ---------------------------------------------------------------------------

test('in-game actions route to the active game', () => {
  const room = playing(2, 9);
  const game = room.game!;
  const first = (game.def.view(game.state, room.host) as any).betting.toAct as number;
  // A raise from the wrong seat is rejected by the game, surfaced through the room.
  const wrong = (first + 1) % 2;
  assert.match(act(room, wrong, { type: 'action', action: 'check' }).error!, /turn/i);
  // The correct seat's action is accepted.
  assert.equal(act(room, first, { type: 'action', action: 'check' }).error, undefined);
});

test('act outside a match is rejected', () => {
  const room = lobby(2);
  assert.match(act(room, 0, { type: 'action', action: 'check' }).error!, /no game/i);
});

test('disconnect/reconnect propagate to the game', () => {
  const room = playing(2, 4);
  const game = room.game!;
  setConnected(room, 0, false);
  assert.equal((game.def.view(game.state, 1) as any).others.find((o: any) => o.seat === 0).connected, false);
  setConnected(room, 0, true);
  assert.equal((game.def.view(game.state, 1) as any).others.find((o: any) => o.seat === 0).connected, true);
});

// ---------------------------------------------------------------------------
// Rematch
// ---------------------------------------------------------------------------

test('rematch only returns to the lobby once the match is over', () => {
  const room = playing(2, 11);
  // mid-match rematch is a no-op
  assert.equal(rematch(room, 0).error, undefined);
  assert.equal(room.phase, 'playing');

  // Drive the match to completion, then rematch back to the lobby.
  const c = { rng: room.rng, now: 0 };
  let guard = 0;
  while (!room.game!.def.result(room.game!.state).over && guard++ < 2_000_000) {
    autoStep(room, c);
  }
  rematch(room, 0);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.game, null);
  // Same members are still seated and can start again.
  assert.equal(room.members.filter(Boolean).length, 2);
});

// Minimal autoplayer that talks only through the room's act().
function autoStep(room: Room, _c: { rng: () => number; now: number }) {
  const v = room.game!.def.view(room.game!.state, room.host) as any;
  switch (v.phase) {
    case 'bet1':
    case 'bet2': {
      const s = v.betting?.toAct;
      if (typeof s !== 'number' || s === -1) return;
      const sv = room.game!.def.view(room.game!.state, s) as any;
      act(room, s, { type: 'action', action: sv.betting.canCheck ? 'check' : 'call' });
      break;
    }
    case 'reveal':
      for (const o of seatsInHand(room)) {
        const pv = room.game!.def.view(room.game!.state, o) as any;
        if (pv.you.revealIndex === null && pv.you.hole) {
          const idx = pv.you.hole.findIndex((c: any) => c && c.suit !== 'liar');
          act(room, o, { type: 'reveal', cardIndex: idx });
        }
      }
      break;
    case 'discuss':
      for (const o of seatsInHand(room)) act(room, o, { type: 'discussDone' });
      break;
    case 'showdown':
      for (const o of seatsInHand(room)) {
        const pv = room.game!.def.view(room.game!.state, o) as any;
        if (pv.liar?.needsYou) act(room, o, { type: 'liar', values: new Array(pv.liar.wildSlots.length).fill('rock') });
      }
      act(room, room.host, { type: 'nextRound' });
      break;
  }
}
function seatsInHand(room: Room): number[] {
  const v = room.game!.def.view(room.game!.state, room.host) as any;
  const out: number[] = [];
  if (v.you?.inHand) out.push(room.host);
  for (const o of v.others ?? []) if (o.inHand) out.push(o.seat);
  return out;
}
