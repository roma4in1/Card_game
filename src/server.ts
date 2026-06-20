// server.ts — authoritative referee for "Love & Liar".
//
// Owns ALL secret state: the deck, both players' hidden cards, the phase
// machine, bet validation, simultaneous reveal buffering, liar resolution,
// showdown evaluation and chip accounting. Clients only ever receive their own
// private view (see buildStateFor). The opponent's hidden cards and the undealt
// deck never leave this process.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

import { compare, evaluate, type Suit } from './evaluator.ts';
import { buildDeck, shuffle, bestResolution, ALL_VALUES, type Card } from './cards.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(__dirname, 'client');
const PORT = Number(process.env.PORT) || 3000;

const START_CHIPS = 35;
const BLIND = 1;

type Phase = 'waiting' | 'bet1' | 'reveal' | 'discuss' | 'bet2' | 'showdown' | 'matchover';

interface Seat {
  token: string;
  name: string;
  chips: number;
  ws: WebSocket | null;
  connected: boolean;
}

interface RoundResult {
  kind: 'fold' | 'showdown' | 'draw';
  winner: number | null; // seat or null on draw
  potAwarded: number;
  // showdown reveal (public once resolved):
  hands?: [Suit[], Suit[]];
  names?: [string, string];
  ranks?: [number, number];
}

interface LiarState {
  pending: [boolean, boolean];
  wildSlots: [number[], number[]];
  baseSuits: [Suit[], Suit[]]; // concrete suits per slot (wild slots hold placeholders)
  resolved: [Suit[] | null, Suit[] | null];
  suggestion: [Suit[] | null, Suit[] | null]; // best auto-pick for wild slots
}

interface Round {
  deck: Card[];
  holes: [Card[], Card[]];
  shared: Card | null;
  pot: number;
  committed: [number, number];
  toAct: 0 | 1;
  firstActor: 0 | 1;
  checked: Set<number>;
  revealIndex: [number | null, number | null];
  discussReady: [boolean, boolean];
  liar: LiarState | null;
  result: RoundResult | null;
}

interface Room {
  code: string;
  seats: [Seat | null, Seat | null];
  phase: Phase;
  round: Round | null;
  carry: number; // pot carried forward from draws
  log: string[];
  matchWinner: number | null;
  nextRoundAck: [boolean, boolean];
  lastActivity: number;
}

const rooms = new Map<string, Room>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += alphabet[randomInt(0, alphabet.length)];
  } while (rooms.has(code));
  return code;
}

function genToken(): string {
  return randomBytes(16).toString('hex');
}

function log(room: Room, msg: string) {
  room.log.push(msg);
  if (room.log.length > 30) room.log.shift();
}

function send(ws: WebSocket | null, obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function suitOf(c: Card): Suit {
  // Only valid for non-liar cards.
  return c.suit as Suit;
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

function bothSeated(room: Room): boolean {
  return room.seats[0] !== null && room.seats[1] !== null;
}

function startRound(room: Room) {
  const s0 = room.seats[0]!;
  const s1 = room.seats[1]!;

  // Elimination is only decided at the start of a new round: a player who
  // cannot post the blind genuinely cannot continue.
  if (s0.chips < BLIND || s1.chips < BLIND) {
    room.phase = 'matchover';
    room.matchWinner = s0.chips >= s1.chips ? 0 : 1;
    log(room, `Match over — ${room.seats[room.matchWinner]!.name} wins!`);
    broadcast(room);
    return;
  }

  const deck = shuffle(buildDeck());
  const round: Round = {
    deck,
    holes: [[], []],
    shared: null,
    pot: room.carry,
    committed: [0, 0],
    toAct: 0,
    firstActor: 0,
    checked: new Set(),
    revealIndex: [null, null],
    discussReady: [false, false],
    liar: null,
    result: null,
  };
  room.carry = 0;
  room.nextRoundAck = [false, false];

  // Step 1: blinds (antes) + dice roll for act order.
  s0.chips -= BLIND;
  s1.chips -= BLIND;
  round.pot += 2 * BLIND;
  const first = randomInt(0, 2) as 0 | 1;
  round.firstActor = first;
  round.toAct = first;
  log(room, `New round. Blinds posted (pot ${round.pot}). 🎲 ${room.seats[first]!.name} acts first.`);

  // Step 2: deal 2 hole cards each.
  for (let i = 0; i < 2; i++) {
    round.holes[0].push(deck.pop()!);
    round.holes[1].push(deck.pop()!);
  }
  // Step 3: reveal shared community card.
  round.shared = deck.pop()!;
  log(room, `Shared card revealed: ${round.shared.suit === 'liar' ? '🃏 LIAR' : round.shared.suit}.`);

  room.round = round;
  room.phase = 'bet1';
  enterBetting(room); // may immediately close if someone is all-in from the blind
}

function enterBetting(room: Room) {
  const r = room.round!;
  r.committed = [0, 0];
  r.checked = new Set();
  r.toAct = r.firstActor;
  // If either player has no chips, there is no betting to do.
  if (room.seats[0]!.chips === 0 || room.seats[1]!.chips === 0) {
    closeBetting(room);
    return;
  }
  broadcast(room);
}

function closeBetting(room: Room) {
  if (room.phase === 'bet1') {
    // Step 5: deal a 3rd hole card to each.
    const r = room.round!;
    r.holes[0].push(r.deck.pop()!);
    r.holes[1].push(r.deck.pop()!);
    log(room, 'Third card dealt. Choose a card to reveal.');
    room.phase = 'reveal';
    broadcast(room);
  } else if (room.phase === 'bet2') {
    enterShowdown(room);
  }
}

function awardFold(room: Room, winner: number) {
  const r = room.round!;
  room.seats[winner]!.chips += r.pot;
  r.result = { kind: 'fold', winner, potAwarded: r.pot };
  log(room, `${room.seats[1 - winner]!.name} folded. ${room.seats[winner]!.name} wins ${r.pot}.`);
  room.phase = 'showdown';
  broadcast(room);
}

// ---------------------------------------------------------------------------
// Betting actions
// ---------------------------------------------------------------------------

function commit(room: Room, seat: number, amount: number) {
  const r = room.round!;
  room.seats[seat]!.chips -= amount;
  r.committed[seat] += amount;
  r.pot += amount;
}

function refundExcess(room: Room, over: number, under: number) {
  // `over` committed more than `under` could match (all-in for less): refund.
  const r = room.round!;
  const diff = r.committed[over] - r.committed[under];
  if (diff > 0) {
    room.seats[over]!.chips += diff;
    r.committed[over] -= diff;
    r.pot -= diff;
  }
}

function handleBet(room: Room, seat: number, action: string, amount: number) {
  const r = room.round;
  if (!r || (room.phase !== 'bet1' && room.phase !== 'bet2')) {
    return err(room, seat, 'No betting right now.');
  }
  if (seat !== r.toAct) return err(room, seat, 'Not your turn.');

  const me = seat;
  const opp = 1 - seat;
  const chips = room.seats[me]!.chips;
  const toCall = r.committed[opp] - r.committed[me];

  if (action === 'fold') {
    awardFold(room, opp);
    return;
  }

  if (action === 'check') {
    if (toCall !== 0) return err(room, seat, 'You cannot check facing a bet.');
    r.checked.add(me);
    log(room, `${room.seats[me]!.name} checks.`);
    if (r.checked.has(opp)) {
      closeBetting(room);
    } else {
      r.toAct = opp as 0 | 1;
      broadcast(room);
    }
    return;
  }

  if (action === 'call') {
    if (toCall <= 0) return err(room, seat, 'Nothing to call — check instead.');
    const pay = Math.min(toCall, chips);
    commit(room, me, pay);
    if (r.committed[me] < r.committed[opp]) refundExcess(room, opp, me);
    log(room, `${room.seats[me]!.name} calls${pay < toCall ? ' (all-in)' : ''}.`);
    closeBetting(room);
    return;
  }

  if (action === 'raise') {
    const total = toCall + Math.floor(amount); // chips put in this action
    if (!(amount >= 1)) return err(room, seat, 'Raise must be at least 1.');
    const pay = Math.min(total, chips);
    if (pay <= toCall) return err(room, seat, 'Not enough chips to raise — call instead.');
    commit(room, me, pay);
    r.checked.clear();
    const allIn = pay === chips;
    log(room, `${room.seats[me]!.name} ${toCall > 0 ? 'raises' : 'bets'} to ${r.committed[me]}${allIn ? ' (all-in)' : ''}.`);
    r.toAct = opp as 0 | 1;
    broadcast(room);
    return;
  }

  return err(room, seat, 'Unknown action.');
}

// ---------------------------------------------------------------------------
// Step 6 — simultaneous reveal
// ---------------------------------------------------------------------------

function handleReveal(room: Room, seat: number, cardIndex: number) {
  const r = room.round;
  if (!r || room.phase !== 'reveal') return err(room, seat, 'Not the reveal step.');
  if (r.revealIndex[seat] !== null) return err(room, seat, 'Already revealed.');
  const hole = r.holes[seat];
  if (cardIndex < 0 || cardIndex >= hole.length) return err(room, seat, 'Bad card.');
  if (hole[cardIndex].suit === 'liar') return err(room, seat, 'You cannot reveal the liar.');

  r.revealIndex[seat] = cardIndex;
  // Buffer: do not expose the chosen card until BOTH players have locked in.
  if (r.revealIndex[0] !== null && r.revealIndex[1] !== null) {
    log(
      room,
      `Both revealed — ${room.seats[0]!.name}: ${hole0Suit(r, 0)}, ${room.seats[1]!.name}: ${hole0Suit(r, 1)}.`,
    );
    room.phase = 'discuss';
  }
  broadcast(room);
}

function hole0Suit(r: Round, seat: number): string {
  const idx = r.revealIndex[seat]!;
  return r.holes[seat][idx].suit;
}

function handleDiscussDone(room: Room, seat: number) {
  const r = room.round;
  if (!r || room.phase !== 'discuss') return;
  r.discussReady[seat] = true;
  log(room, `${room.seats[seat]!.name} is ready to bet.`);
  if (r.discussReady[0] && r.discussReady[1]) {
    room.phase = 'bet2';
    enterBetting(room);
  } else {
    broadcast(room);
  }
}

// ---------------------------------------------------------------------------
// Step 9 — liar resolution + showdown
// ---------------------------------------------------------------------------

function slotSuits(r: Round, seat: number): Suit[] {
  // Base concrete suits for [hole0, hole1, hole2, shared]; liar slots get a
  // harmless placeholder (overwritten by resolution).
  const cards = [...r.holes[seat], r.shared!];
  return cards.map((c) => (c.suit === 'liar' ? 'rock' : (c.suit as Suit)));
}

function enterShowdown(room: Room) {
  const r = room.round!;
  const sharedIsLiar = r.shared!.suit === 'liar';

  const wildSlots: [number[], number[]] = [[], []];
  for (const seat of [0, 1] as const) {
    if (sharedIsLiar) {
      wildSlots[seat] = [3]; // each player independently sets the shared liar
    } else {
      const holeLiar = r.holes[seat].findIndex((c) => c.suit === 'liar');
      if (holeLiar >= 0) {
        // Both still-hidden hole cards become wild (the two NOT revealed at step 6).
        wildSlots[seat] = [0, 1, 2].filter((i) => i !== r.revealIndex[seat]);
      }
    }
  }

  const base: [Suit[], Suit[]] = [slotSuits(r, 0), slotSuits(r, 1)];
  const liar: LiarState = {
    pending: [wildSlots[0].length > 0, wildSlots[1].length > 0],
    wildSlots,
    baseSuits: base,
    resolved: [null, null],
    suggestion: [null, null],
  };
  for (const seat of [0, 1] as const) {
    const best = bestResolution(base[seat], wildSlots[seat]);
    if (liar.pending[seat]) {
      liar.suggestion[seat] = best.chosen;
    } else {
      liar.resolved[seat] = best.resolved; // no wilds → fixed
    }
  }
  r.liar = liar;
  room.phase = 'showdown';

  if (!liar.pending[0] && !liar.pending[1]) {
    finalizeShowdown(room);
  } else {
    log(room, 'Showdown — liar holder(s) choosing values…');
    broadcast(room);
  }
}

function handleLiar(room: Room, seat: number, payload: { auto?: boolean; values?: string[] }) {
  const r = room.round;
  if (!r || room.phase !== 'showdown' || !r.liar) return;
  const liar = r.liar;
  if (!liar.pending[seat]) return;

  const slots = liar.wildSlots[seat];
  const resolved = [...liar.baseSuits[seat]];
  if (payload.auto || !payload.values) {
    slots.forEach((slot, i) => (resolved[slot] = liar.suggestion[seat]![i]));
  } else {
    if (payload.values.length !== slots.length) return err(room, seat, 'Bad liar values.');
    for (const v of payload.values) {
      if (!ALL_VALUES.includes(v as Suit)) return err(room, seat, 'Bad liar value.');
    }
    slots.forEach((slot, i) => (resolved[slot] = payload.values![i] as Suit));
  }
  liar.resolved[seat] = resolved;
  liar.pending[seat] = false;
  log(room, `${room.seats[seat]!.name} locked their liar.`);

  if (!liar.pending[0] && !liar.pending[1]) finalizeShowdown(room);
  else broadcast(room);
}

function autoResolveLiar(room: Room, seat: number) {
  // Used when a wild-holder disconnects so the game can still finish.
  const r = room.round;
  if (!r || room.phase !== 'showdown' || !r.liar || !r.liar.pending[seat]) return;
  handleLiar(room, seat, { auto: true });
}

function finalizeShowdown(room: Room) {
  const r = room.round!;
  const liar = r.liar!;
  const handA = liar.resolved[0]!;
  const handB = liar.resolved[1]!;
  const cmp = compare(handA, handB);
  const evA = evaluate(handA);
  const evB = evaluate(handB);

  const result: RoundResult = {
    kind: cmp === 0 ? 'draw' : 'showdown',
    winner: cmp === 1 ? 0 : cmp === -1 ? 1 : null,
    potAwarded: r.pot,
    hands: [handA, handB],
    names: [room.seats[0]!.name, room.seats[1]!.name],
    ranks: [evA.rank, evB.rank],
  };

  if (cmp === 0) {
    room.carry = r.pot; // draw: pot carries to next round
    log(room, `Showdown: DRAW (${evA.name} vs ${evB.name}). Pot of ${r.pot} carries over.`);
  } else {
    const w = result.winner!;
    room.seats[w]!.chips += r.pot;
    log(
      room,
      `Showdown: ${room.seats[w]!.name} wins ${r.pot} with ${w === 0 ? evA.name : evB.name}.`,
    );
  }
  r.result = result;
  broadcast(room);
}

function handleNextRound(room: Room, seat: number) {
  if (room.phase !== 'showdown' || !room.round?.result) return;
  room.nextRoundAck[seat] = true;
  // Either player may advance once the result is shown (friendly game).
  startRound(room);
}

// ---------------------------------------------------------------------------
// Private state views
// ---------------------------------------------------------------------------

function cardView(c: Card | null): { suit: string; id: number } | null {
  return c ? { suit: c.suit, id: c.id } : null;
}

function buildStateFor(room: Room, seat: number) {
  const me = room.seats[seat]!;
  const oppSeat = 1 - seat;
  const opp = room.seats[oppSeat];
  const r = room.round;

  const base: any = {
    type: 'state',
    room: room.code,
    seat,
    phase: room.phase,
    you: { name: me.name, chips: me.chips, connected: me.connected },
    opp: opp
      ? { name: opp.name, chips: opp.chips, connected: opp.connected }
      : null,
    pot: r ? r.pot : 0,
    carry: room.carry,
    log: room.log.slice(-15),
    matchWinner: room.matchWinner,
  };

  if (!r) return base;

  base.shared = cardView(r.shared);
  base.firstActor = r.firstActor;

  // Your own hole cards — full detail. Liar is shown as its true face to YOU.
  base.you.hole = r.holes[seat].map(cardView);
  base.you.revealIndex = r.revealIndex[seat];

  // Opponent: only count + (after both reveal) their revealed card.
  const oppRevealed = r.revealIndex[oppSeat];
  const bothRevealed = r.revealIndex[0] !== null && r.revealIndex[1] !== null;
  base.opp = base.opp ?? {};
  base.opp.holeCount = r.holes[oppSeat].length;
  base.opp.revealIndex = oppRevealed;
  // Buffered reveal: the opponent's actual card is withheld until BOTH locked.
  base.opp.revealedCard =
    bothRevealed && oppRevealed !== null ? cardView(r.holes[oppSeat][oppRevealed]) : null;
  base.you.revealedCard =
    r.revealIndex[seat] !== null ? cardView(r.holes[seat][r.revealIndex[seat]!]) : null;

  // Betting context.
  if (room.phase === 'bet1' || room.phase === 'bet2') {
    const toCall = r.committed[oppSeat] - r.committed[seat];
    base.betting = {
      toAct: r.toAct,
      yourTurn: r.toAct === seat,
      committed: r.committed,
      toCall,
      yourChips: me.chips,
      canCheck: toCall === 0,
    };
  }

  if (room.phase === 'reveal') {
    base.reveal = {
      youLocked: r.revealIndex[seat] !== null,
      oppLocked: r.revealIndex[oppSeat] !== null,
    };
  }

  if (room.phase === 'discuss') {
    base.discuss = {
      youReady: r.discussReady[seat],
      oppReady: r.discussReady[oppSeat],
    };
  }

  if (room.phase === 'showdown') {
    const liar = r.liar;
    if (liar && liar.pending[seat]) {
      base.liar = {
        needsYou: true,
        wildSlots: liar.wildSlots[seat], // slot indices 0..3 (3 = shared)
        suggestion: liar.suggestion[seat],
        sharedIsLiar: r.shared!.suit === 'liar',
      };
    } else if (liar && (liar.pending[0] || liar.pending[1])) {
      base.liar = { needsYou: false, waitingOnOpponent: true };
    }
    if (r.result) {
      base.result = r.result;
      base.nextReady = room.nextRoundAck;
    }
  }

  return base;
}

function broadcast(room: Room) {
  room.lastActivity = Date.now();
  for (const seat of [0, 1] as const) {
    const s = room.seats[seat];
    if (s) send(s.ws, buildStateFor(room, seat));
  }
}

function err(room: Room, seat: number, message: string) {
  const s = room.seats[seat];
  send(s?.ws ?? null, { type: 'error', message });
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

interface Conn {
  roomCode: string | null;
  seat: number | null;
}

function handleJoin(ws: WebSocket, conn: Conn, msg: any) {
  const code = String(msg.room || '').toUpperCase().slice(0, 8);
  if (!code) return send(ws, { type: 'error', message: 'Missing room code.' });

  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      seats: [null, null],
      phase: 'waiting',
      round: null,
      carry: 0,
      log: [],
      matchWinner: null,
      nextRoundAck: [false, false],
      lastActivity: Date.now(),
    };
    rooms.set(code, room);
  }

  const token: string | undefined = msg.token;
  // Reconnection: match an existing seat by token.
  if (token) {
    for (const seat of [0, 1] as const) {
      const s = room.seats[seat];
      if (s && s.token === token) {
        s.ws = ws;
        s.connected = true;
        conn.roomCode = code;
        conn.seat = seat;
        send(ws, { type: 'joined', seat, token, room: code });
        log(room, `${s.name} reconnected.`);
        // If this player owed a liar choice while gone, nothing to do — rejoin.
        broadcast(room);
        return;
      }
    }
  }

  // New player: take a free seat.
  const free = room.seats[0] === null ? 0 : room.seats[1] === null ? 1 : -1;
  if (free === -1) {
    return send(ws, { type: 'full', message: 'Room is full (2 players max).' });
  }
  const newToken = genToken();
  const name = String(msg.name || `Player ${free + 1}`).slice(0, 16);
  room.seats[free] = { token: newToken, name, chips: START_CHIPS, ws, connected: true };
  conn.roomCode = code;
  conn.seat = free;
  send(ws, { type: 'joined', seat: free, token: newToken, room: code });
  log(room, `${name} joined as seat ${free + 1}.`);

  if (bothSeated(room) && room.phase === 'waiting') {
    startRound(room);
  } else {
    broadcast(room);
  }
}

function handleMessage(ws: WebSocket, conn: Conn, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'join') return handleJoin(ws, conn, msg);

  if (conn.roomCode === null || conn.seat === null) return;
  const room = rooms.get(conn.roomCode);
  if (!room) return;
  const seat = conn.seat;

  switch (msg.type) {
    case 'action':
      return handleBet(room, seat, String(msg.action), Number(msg.amount) || 0);
    case 'reveal':
      return handleReveal(room, seat, Number(msg.cardIndex));
    case 'discussDone':
      return handleDiscussDone(room, seat);
    case 'liar':
      return handleLiar(room, seat, msg);
    case 'nextRound':
      return handleNextRound(room, seat);
    case 'chat': {
      const text = String(msg.text || '').slice(0, 200);
      if (!text.trim()) return;
      const payload = { type: 'chat', seat, name: room.seats[seat]!.name, text };
      for (const s of room.seats) send(s?.ws ?? null, payload);
      return;
    }
  }
}

function handleClose(conn: Conn) {
  if (conn.roomCode === null || conn.seat === null) return;
  const room = rooms.get(conn.roomCode);
  if (!room) return;
  const s = room.seats[conn.seat];
  if (s) {
    s.connected = false;
    s.ws = null;
    log(room, `${s.name} disconnected.`);
    // Don't stall a showdown waiting on a vanished player's liar choice.
    autoResolveLiar(room, conn.seat);
    broadcast(room);
  }
}

// ---------------------------------------------------------------------------
// HTTP static file serving + WebSocket upgrade
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
  const ext = url.slice(url.lastIndexOf('.'));
  const safe = normalize(url).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(CLIENT_DIR, safe);
  try {
    const body = await readFile(filePath);
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
  const conn: Conn = { roomCode: null, seat: null };
  ws.on('message', (data) => handleMessage(ws, conn, data.toString()));
  ws.on('close', () => handleClose(conn));
  ws.on('error', () => {});
});

// Periodically reap abandoned rooms (both seats disconnected for >1h).
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.seats.some((s) => s?.connected);
    if (!anyConnected && now - room.lastActivity > 60 * 60 * 1000) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Love & Liar server on http://localhost:${PORT}`);
});

export { rooms }; // exported for potential testing
