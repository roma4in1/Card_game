// server.ts — transport layer for "Love & Liar".
//
// Thin and I/O-only: it serves the static client, accepts WebSocket
// connections, validates/parses messages, and forwards them to the pure engine
// (engine.ts). After any state-changing call it broadcasts each seat's private
// view. It holds NO game rules — those all live in the engine.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import {
  createRoom,
  join as joinRoom,
  setConnected,
  bet,
  reveal,
  discussDone,
  setLiar,
  nextRound,
  viewFor,
  type Room,
  type Seat,
} from './engine.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(__dirname, 'client');
const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 60 * 60 * 1000;

const rooms = new Map<string, Room>();
// Sockets are transport state, kept out of the engine. One slot per seat.
const sockets = new Map<string, [WebSocket | null, WebSocket | null]>();

function send(ws: WebSocket | null, obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room: Room) {
  room.lastActivity = Date.now();
  const ws = sockets.get(room.code);
  if (!ws) return;
  for (const seat of [0, 1] as const) {
    if (room.players[seat]) send(ws[seat], viewFor(room, seat));
  }
}

// ---------------------------------------------------------------------------
// Per-connection state & message handling
// ---------------------------------------------------------------------------

interface Conn {
  code: string | null;
  seat: Seat | null;
}

function handleJoin(ws: WebSocket, conn: Conn, msg: Record<string, unknown>) {
  const code = String(msg.room ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!code) return send(ws, { type: 'error', message: 'Missing room code.' });

  let room = rooms.get(code);
  if (!room) {
    room = createRoom(code);
    rooms.set(code, room);
    sockets.set(code, [null, null]);
  }

  const token = typeof msg.token === 'string' ? msg.token : undefined;
  const name = typeof msg.name === 'string' ? msg.name : undefined;
  const result = joinRoom(room, token, name);
  if (!result.ok) return send(ws, { type: 'full', message: 'Room is full (2 players max).' });

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

  // Chat is pure transport (no game state) — relay verbatim to both seats.
  if (msg.type === 'chat') {
    const text = String(msg.text ?? '').slice(0, 200);
    if (!text.trim()) return;
    const payload = { type: 'chat', seat, name: room.players[seat]!.name, text };
    for (const s of sockets.get(conn.code)!) send(s, payload);
    return;
  }

  const result = dispatch(room, seat, msg);
  if (result?.error) send(ws, { type: 'error', message: result.error });
  else broadcast(room);
}

function dispatch(room: Room, seat: Seat, msg: Record<string, unknown>): { error?: string } | void {
  switch (msg.type) {
    case 'action':
      return bet(room, seat, String(msg.action ?? ''), Number(msg.amount) || 0);
    case 'reveal':
      return reveal(room, seat, Number(msg.cardIndex));
    case 'discussDone':
      return discussDone(room, seat);
    case 'liar':
      return setLiar(room, seat, msg as { auto?: boolean; values?: string[] });
    case 'nextRound':
      return nextRound(room, seat);
  }
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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

// Reap abandoned rooms (both seats disconnected for over an hour).
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.players.some((p) => p?.connected);
    if (!anyConnected && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
      sockets.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Love & Liar server on http://localhost:${PORT}`));

export { rooms };
