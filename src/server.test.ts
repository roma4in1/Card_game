// server.test.ts — end-to-end smoke test: spins up the real server, connects
// two WebSocket clients, and drives a full round to completion. Verifies the
// phase machine advances, chips are conserved (total stays 70), and the
// opponent's hidden cards are NEVER leaked to a client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 3199;
const URL = `ws://localhost:${PORT}/ws`;

function startServer(): Promise<ChildProcess> {
  const child = spawn('node', ['src/server.ts'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
    child.stdout!.on('data', (d) => {
      if (d.toString().includes('server on')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr!.on('data', (d) => process.stderr.write(d));
    child.on('error', reject);
  });
}

interface Bot {
  ws: WebSocket;
  seat: number;
  token?: string;
  lastState?: any;
}

function makeBot(room: string, name: string, onResult: (s: any) => void): Promise<Bot> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const bot: Bot = { ws, seat: -1 };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, name })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'joined') {
        bot.seat = msg.seat;
        bot.token = msg.token;
        resolve(bot);
      } else if (msg.type === 'state') {
        bot.lastState = msg;
        // Anti-cheat invariant: opponent hidden cards must never be sent.
        if (msg.opp) {
          assert.equal(msg.opp.hole, undefined, 'opponent hole cards leaked!');
        }
        driveBot(bot, msg);
        if (msg.phase === 'showdown' && msg.result) onResult(msg);
      }
    });
  });
}

// A passive bot: always checks/calls, reveals the first non-liar card, auto-
// resolves liar, and readies up. Enough to push a round to showdown.
function driveBot(bot: Bot, s: any) {
  const send = (o: any) => bot.ws.send(JSON.stringify(o));
  if ((s.phase === 'bet1' || s.phase === 'bet2') && s.betting?.yourTurn) {
    if (s.betting.canCheck) send({ type: 'action', action: 'check' });
    else send({ type: 'action', action: 'call' });
  } else if (s.phase === 'reveal' && s.reveal && !s.reveal.youLocked) {
    const idx = s.you.hole.findIndex((c: any) => c.suit !== 'liar');
    send({ type: 'reveal', cardIndex: idx });
  } else if (s.phase === 'discuss' && s.discuss && !s.discuss.youReady) {
    send({ type: 'discussDone' });
  } else if (s.phase === 'showdown' && s.liar?.needsYou) {
    send({ type: 'liar', auto: true });
  }
}

test('full round plays to showdown with conserved chips and no card leaks', async () => {
  const server = await startServer();
  try {
    let resolveRound: (s: any) => void;
    const roundDone = new Promise<any>((r) => (resolveRound = r));
    let fired = false;
    const onResult = (s: any) => {
      if (!fired) {
        fired = true;
        resolveRound(s);
      }
    };

    const room = 'TEST';
    const a = await makeBot(room, 'Alice', onResult);
    const b = await makeBot(room, 'Bob', onResult);
    assert.notEqual(a.seat, b.seat);

    const result = await Promise.race([
      roundDone,
      new Promise((_, rej) => setTimeout(() => rej(new Error('round timeout')), 8000).unref()),
    ]);

    const s: any = result;
    // Chip conservation: chips of both seats + carried pot == 70 total.
    const total = s.you.chips + s.opp.chips + (s.carry || 0);
    assert.equal(total, 70, `chips should be conserved (got ${total})`);
    assert.ok(['fold', 'showdown', 'draw'].includes(s.result.kind));

    a.ws.close();
    b.ws.close();
  } finally {
    server.kill('SIGKILL');
  }
});

test('third player is rejected as room full', async () => {
  const server = await startServer();
  try {
    const room = 'FULL';
    await makeBot(room, 'A', () => {});
    await makeBot(room, 'B', () => {});
    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(URL);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, name: 'C' })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'full') resolve(true);
        if (msg.type === 'joined') resolve(false);
      });
    });
    assert.equal(rejected, true, 'third player should be rejected');
  } finally {
    server.kill('SIGKILL');
  }
});
