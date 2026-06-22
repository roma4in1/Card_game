// server.test.ts — end-to-end smoke test: spins up the real server, connects
// three WebSocket clients through the lobby, starts the match, and drives a full
// round. Verifies the phase machine advances, chips are conserved, and no
// opponent's hidden cards are ever leaked to a client.
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
}

function makeBot(room: string, name: string, onState: (b: Bot, s: any) => void): Promise<Bot> {
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
        // Anti-cheat: opponents' hidden cards must never be sent.
        for (const o of msg.others ?? []) assert.equal(o.hole, undefined, 'opponent hole leaked!');
        onState(bot, msg);
      }
    });
  });
}

// Passive bot: checks/calls, reveals first non-liar, readies up, resolves liar.
function driveBot(bot: Bot, s: any) {
  const send = (o: any) => bot.ws.send(JSON.stringify(o));
  if ((s.phase === 'bet1' || s.phase === 'bet2') && s.betting?.yourTurn) {
    send({ type: 'action', action: s.betting.canCheck ? 'check' : 'call' });
  } else if (s.phase === 'reveal' && s.reveal && !s.reveal.youLocked && s.you.inHand) {
    send({ type: 'reveal', cardIndex: s.you.hole.findIndex((c: any) => c.suit !== 'liar') });
  } else if (s.phase === 'discuss' && s.discuss && !s.discuss.youReady && s.you.inHand) {
    send({ type: 'discussDone' });
  } else if (s.phase === 'showdown' && s.liar?.needsYou) {
    send({ type: 'liar', values: s.liar.wildSlots.map(() => 'rock') });
  }
}

test('a 3-player match plays a round to showdown with conserved chips and no leaks', async () => {
  const server = await startServer();
  try {
    let resolveRound: (s: any) => void;
    const roundDone = new Promise<any>((r) => (resolveRound = r));
    let fired = false;
    const onState = (bot: Bot, s: any) => {
      if (s.phase === 'lobby' && s.youAreHost && s.roster.length === 3) {
        bot.ws.send(JSON.stringify({ type: 'start' }));
        return;
      }
      driveBot(bot, s);
      if (s.phase === 'showdown' && s.result && !fired) {
        fired = true;
        resolveRound(s);
      }
    };

    const room = 'TEST';
    await makeBot(room, 'Alice', onState);
    await makeBot(room, 'Bob', onState);
    await makeBot(room, 'Carol', onState);

    const s: any = await Promise.race([
      roundDone,
      new Promise((_, rej) => setTimeout(() => rej(new Error('round timeout')), 8000).unref()),
    ]);

    const total = s.roster.reduce((sum: number, p: any) => sum + p.chips, 0) + s.pot + (s.carry || 0);
    assert.equal(total, 3 * 35, `chips should be conserved (got ${total})`);
    assert.ok(['fold', 'showdown'].includes(s.result.kind));
  } finally {
    server.kill('SIGKILL');
  }
});

test('joining a match that has already started is rejected', async () => {
  const server = await startServer();
  try {
    const room = 'BUSY';
    const host = await makeBot(room, 'A', (bot, s) => {
      if (s.phase === 'lobby' && s.youAreHost && s.roster.length === 2) {
        bot.ws.send(JSON.stringify({ type: 'start' }));
      }
    });
    await makeBot(room, 'B', () => {});
    // give the match a moment to start
    await new Promise((r) => setTimeout(r, 300));

    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(URL);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, name: 'C' })));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'full') resolve(true);
        if (msg.type === 'joined') resolve(false);
      });
    });
    assert.equal(rejected, true, 'a late joiner should be rejected once started');
    host.ws.close();
  } finally {
    server.kill('SIGKILL');
  }
});
