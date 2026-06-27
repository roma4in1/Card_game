// server.ts — transport layer for the game platform.
//
// Thin and I/O-only: it serves the static client, accepts WebSocket
// connections, validates/parses messages, and forwards them to the pure room
// (platform/room.ts), which owns the lobby and routes in-game actions to the
// selected game plugin. After any state-changing call it broadcasts each seat's
// private view. It holds NO game rules — those live in the room and the games.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import {
  createRoom,
  join as joinRoom,
  selectGame,
  setOption,
  startMatch,
  setConnected,
  act,
  rematch,
  leave,
  botMove,
  hasHumans,
  tick,
  viewFor,
  MAX_SEATS,
  type Room,
} from './platform/room.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(__dirname, 'client');
const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 60 * 60 * 1000;

const rooms = new Map<string, Room>();
// Sockets are transport state, kept out of the engine. One slot per seat.
const sockets = new Map<string, (WebSocket | null)[]>();
// One pending bot-move timer per room (bots play on a human-like delay).
const botTimers = new Map<string, ReturnType<typeof setTimeout>>();

function send(ws: WebSocket | null, obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room: Room) {
  room.lastActivity = Date.now();
  const ws = sockets.get(room.code);
  if (ws) {
    for (let seat = 0; seat < MAX_SEATS; seat++) {
      if (room.members[seat]) send(ws[seat], viewFor(room, seat));
    }
  }
  scheduleBots(room); // let any bot whose turn it is play next
}

// If a bot-controlled seat has a move pending, play it after a short, human-like
// delay, then broadcast (which may schedule the following bot move, and so on).
function scheduleBots(room: Room) {
  if (botTimers.has(room.code) || !rooms.has(room.code)) return;
  if (!botMove(room)) return;
  const timer = setTimeout(() => {
    botTimers.delete(room.code);
    if (!rooms.has(room.code)) return;
    const mv = botMove(room);
    if (!mv) return;
    const res = act(room, mv.seat, mv.msg);
    if (res?.error) {
      console.warn('bot move rejected:', res.error, mv.msg);
      return; // stop the chain rather than loop on a bad move
    }
    broadcast(room);
  }, 650 + Math.floor(Math.random() * 500));
  botTimers.set(room.code, timer);
}

function dropRoom(code: string) {
  const t = botTimers.get(code);
  if (t) clearTimeout(t);
  botTimers.delete(code);
  rooms.delete(code);
  sockets.delete(code);
}

// ---------------------------------------------------------------------------
// Per-connection state & message handling
// ---------------------------------------------------------------------------

interface Conn {
  code: string | null;
  seat: number | null;
}

function handleJoin(ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
  const code = String(msg.room ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!code) return send(ws, { type: 'error', message: 'Missing room code.' });

  let room = rooms.get(code);
  if (!room) {
    room = createRoom(code);
    rooms.set(code, room);
    sockets.set(code, new Array(MAX_SEATS).fill(null));
  }

  const token = typeof msg.token === 'string' ? msg.token : undefined;
  const name = typeof msg.name === 'string' ? msg.name : undefined;
  const result = joinRoom(room, token, name);
  if (!result.ok) {
    const message = result.reason === 'in-progress'
      ? 'That game has already started.'
      : `Room is full (${MAX_SEATS} players max).`;
    return send(ws, { type: 'full', message });
  }

  conn.code = code;
  conn.seat = result.seat;
  sockets.get(code)![result.seat] = ws;
  setConnected(room, result.seat, true);
  send(ws, { type: 'joined', seat: result.seat, token: result.token, room: code });
  broadcast(room);
}

function handleMessage(ws: WebSocket, conn: Conn, raw: string) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof msg !== 'object' || msg === null) return;

  if (msg.type === 'join') return handleJoin(ws, conn, msg);

  if (conn.code === null || conn.seat === null) return;
  const room = rooms.get(conn.code);
  if (!room) return;
  const seat = conn.seat;

  if (msg.type === 'leave') return handleLeave(ws, conn, room, seat);

  // Chat is pure transport (no game state) — relay verbatim to everyone.
  if (msg.type === 'chat') {
    const text = String(msg.text ?? '').slice(0, 200);
    if (!text.trim()) return;
    const payload = { type: 'chat', seat, name: room.members[seat]!.name, text };
    for (const s of sockets.get(conn.code)!) send(s, payload);
    return;
  }

  const result = dispatch(room, seat, msg);
  if (result?.error) send(ws, { type: 'error', message: result.error });
  else broadcast(room);
}

// Room-level messages are handled here; anything else is an in-game action
// routed to the active game plugin.
function dispatch(room: Room, seat: number, msg: Record<string, unknown>): { error?: string } | void {
  switch (msg.type) {
    case 'selectGame':
      return selectGame(room, seat, String(msg.gameId ?? ''));
    case 'setOption':
      return setOption(room, seat, String(msg.key ?? ''), msg.value);
    case 'start':
      return startMatch(room, seat);
    case 'rematch':
      return rematch(room, seat);
    default:
      return act(room, seat, msg);
  }
}

function handleLeave(ws: WebSocket, conn: Conn, room: Room, seat: number) {
  // Detach the socket first so the leaver isn't broadcast to and the later
  // close handler is a no-op, then free the seat for everyone else.
  const sk = sockets.get(conn.code!);
  if (sk && sk[seat] === ws) sk[seat] = null;
  conn.code = null;
  conn.seat = null;
  leave(room, seat);
  // If only bots remain, there's no one to play for — discard the room.
  if (!hasHumans(room)) dropRoom(room.code);
  else broadcast(room);
  send(ws, { type: 'left' });
}

function handleClose(conn: Conn, closed: WebSocket) {
  if (conn.code === null || conn.seat === null) return;
  const ws = sockets.get(conn.code);
  // If the player already reconnected on a newer socket, this stale close is a
  // no-op — don't tear down the live connection.
  if (!ws || ws[conn.seat] !== closed) return;
  ws[conn.seat] = null;
  const room = rooms.get(conn.code);
  if (!room) return;
  setConnected(room, conn.seat, false);
  broadcast(room);
}

// ---------------------------------------------------------------------------
// Static file serving + WebSocket upgrade
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  let url = (req.url || '/').split('?')[0];
  // Room links like /r/ABCD serve the SPA shell; the client reads the code.
  if (url === '/' || url.startsWith('/r/')) url = '/index.html';
  const safe = normalize(url).replace(/^(\.\.[/\\])+/, '');
  const ext = safe.slice(safe.lastIndexOf('.'));
  try {
    const body = await readFile(join(CLIENT_DIR, safe));
    // Revalidate on every load so clients never run a stale app.js/style.css.
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const conn: Conn = { code: null, seat: null };
  ws.on('message', (data) => {
    // Isolate every message: a bug on one connection must never crash the server.
    try {
      handleMessage(ws, conn, data.toString());
    } catch (e) {
      console.error('message error:', e);
    }
  });
  ws.on('close', () => {
    try {
      handleClose(conn, ws);
    } catch (e) {
      console.error('close error:', e);
    }
  });
  ws.on('error', () => {});
});

// Drive timed game mechanics (e.g. Memory Match's no-match flip-back). Tick each
// playing room; broadcast only those whose state actually advanced.
setInterval(() => {
  for (const room of rooms.values()) if (tick(room)) broadcast(room);
}, 500).unref();

// Reap abandoned rooms (no connected human for over an hour; bots don't count).
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyHuman = room.members.some((m) => m && !m.bot && m.connected);
    if (!anyHuman && now - room.lastActivity > ROOM_TTL_MS) dropRoom(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Love & Liar server on http://localhost:${PORT}`));

export { rooms };
