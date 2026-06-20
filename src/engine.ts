// engine.ts — the authoritative "Love & Liar" game engine.
//
// This module is PURE with respect to the network: it owns and mutates game
// state but performs no I/O. Action handlers mutate the room and return an
// optional error string; the transport (server.ts) is responsible for observing
// state via viewFor() and pushing it to clients. Randomness is injected so the
// whole engine is deterministically testable (see engine.test.ts).
//
// It owns ALL secret state — the deck, both hidden hands, the phase machine —
// and viewFor() guarantees a client only ever sees its own cards plus public
// information. The opponent's hidden cards and the undealt deck never leave here.

import { randomInt, randomBytes } from 'node:crypto';
import { compare, evaluate, type Suit } from './evaluator.ts';
import { buildDeck, shuffle, bestResolution, ALL_VALUES, type Card } from './cards.ts';

export const START_CHIPS = 35;
export const BLIND = 1;
// Cards consumed by a full round: 2+2 hole + 1 shared + 1+1 hole at step 5.
export const CARDS_PER_ROUND = 7;

export type Phase = 'waiting' | 'bet1' | 'reveal' | 'discuss' | 'bet2' | 'showdown' | 'matchover';
export type Seat = 0 | 1;

/** Randomness source returning a float in [0, 1). */
export type Rng = () => number;
const cryptoRng: Rng = () => randomInt(0, 2 ** 30) / 2 ** 30;
const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);

export interface Player {
  token: string;
  name: string;
  chips: number;
  connected: boolean;
}

export interface RoundResult {
  kind: 'fold' | 'showdown' | 'draw';
  winner: number | null; // seat, or null on a draw
  potAwarded: number;
  hands?: [Suit[], Suit[]]; // resolved hands, public once shown
  names?: [string, string];
  ranks?: [number, number];
}

interface LiarState {
  pending: [boolean, boolean];
  wildSlots: [number[], number[]];
  baseSuits: [Suit[], Suit[]]; // concrete suit per slot; wild slots hold placeholders
  resolved: [Suit[] | null, Suit[] | null];
  suggestion: [Suit[] | null, Suit[] | null];
}

interface Round {
  holes: [Card[], Card[]];
  shared: Card | null;
  pot: number;
  committed: [number, number]; // chips committed in the CURRENT betting round
  toAct: Seat;
  firstActor: Seat;
  dice: [number, number]; // each player's d6 roll; higher acts first
  checked: Set<number>;
  revealIndex: [number | null, number | null];
  discussReady: [boolean, boolean];
  liar: LiarState | null;
  result: RoundResult | null;
}

export interface Room {
  code: string;
  rng: Rng;
  players: [Player | null, Player | null];
  phase: Phase;
  deck: Card[]; // finite deck, persists across rounds; reshuffled only when too thin
  round: Round | null;
  roundNo: number; // increments each new round (lets the client detect round starts)
  carry: number; // pot carried forward from a draw
  log: string[];
  matchWinner: number | null;
  rematchReady: [boolean, boolean]; // both must opt in to start a fresh match
  lastActivity: number;
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

// ---------------------------------------------------------------------------
// Construction & membership
// ---------------------------------------------------------------------------

export function createRoom(code: string, rng: Rng = cryptoRng): Room {
  return {
    code,
    rng,
    players: [null, null],
    phase: 'waiting',
    deck: [],
    round: null,
    roundNo: 0,
    carry: 0,
    log: [],
    matchWinner: null,
    rematchReady: [false, false],
    lastActivity: Date.now(),
  };
}

function genToken(): string {
  return randomBytes(16).toString('hex');
}

function log(room: Room, msg: string) {
  room.log.push(msg);
  if (room.log.length > 30) room.log.shift();
}

export type JoinResult =
  | { ok: true; seat: Seat; token: string; reconnected: boolean }
  | { ok: false; reason: 'full' };

/**
 * Join (or rejoin) a room. A token matching an existing seat reconnects to it;
 * otherwise the next free seat is taken. The first two players seat into 0 and 1;
 * a third is rejected as full.
 */
export function join(room: Room, token: string | undefined, name: string | undefined): JoinResult {
  if (token) {
    for (const seat of [0, 1] as const) {
      const p = room.players[seat];
      if (p && p.token === token) {
        p.connected = true;
        log(room, `${p.name} reconnected.`);
        return { ok: true, seat, token, reconnected: true };
      }
    }
  }
  const free: Seat | -1 = room.players[0] === null ? 0 : room.players[1] === null ? 1 : -1;
  if (free === -1) return { ok: false, reason: 'full' };

  const newToken = genToken();
  const cleanName = (name || `Player ${free + 1}`).slice(0, 16);
  room.players[free] = { token: newToken, name: cleanName, chips: START_CHIPS, connected: true };
  log(room, `${cleanName} joined as seat ${free + 1}.`);

  if (room.players[0] && room.players[1] && room.phase === 'waiting') startRound(room);
  return { ok: true, seat: free, token: newToken, reconnected: false };
}

export function setConnected(room: Room, seat: Seat, connected: boolean) {
  const p = room.players[seat];
  if (!p || p.connected === connected) return;
  p.connected = connected;
  log(room, `${p.name} ${connected ? 'reconnected' : 'disconnected'}.`);
  // Don't stall a showdown waiting on a vanished player's liar choice.
  if (!connected) autoResolveLiar(room, seat);
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

function startRound(room: Room) {
  const [p0, p1] = room.players;
  if (!p0 || !p1) return;

  // Elimination is decided only at the start of a round: a player who cannot
  // post the blind genuinely cannot continue (spending the last chip on a blind
  // or an all-in mid-round is not, by itself, elimination).
  if (p0.chips < BLIND || p1.chips < BLIND) {
    room.phase = 'matchover';
    room.matchWinner = p0.chips >= p1.chips ? 0 : 1;
    log(room, `Match over — ${room.players[room.matchWinner]!.name} wins!`);
    return;
  }

  room.roundNo += 1;
  room.rematchReady = [false, false];
  // The deck is a finite set that persists across rounds (cards already played
  // stay out). Only when too few remain for a full round do we reshuffle a fresh 49.
  if (room.deck.length < CARDS_PER_ROUND) {
    room.deck = shuffle(buildDeck(), room.rng);
    log(room, 'Deck ran low — reshuffled a fresh 49 cards.');
  }
  const round: Round = {
    holes: [[], []],
    shared: null,
    pot: room.carry,
    committed: [0, 0],
    toAct: 0,
    firstActor: 0,
    dice: [0, 0],
    checked: new Set(),
    revealIndex: [null, null],
    discussReady: [false, false],
    liar: null,
    result: null,
  };
  room.carry = 0;

  // Step 1: blinds (antes) + a dice roll for act order — each rolls a d6, higher
  // acts first, re-rolling on a tie.
  p0.chips -= BLIND;
  p1.chips -= BLIND;
  round.pot += 2 * BLIND;
  let d0 = 1 + randInt(room.rng, 6);
  let d1 = 1 + randInt(room.rng, 6);
  while (d0 === d1) {
    d0 = 1 + randInt(room.rng, 6);
    d1 = 1 + randInt(room.rng, 6);
  }
  const first = (d0 > d1 ? 0 : 1) as Seat;
  round.dice = [d0, d1];
  round.firstActor = first;
  round.toAct = first;
  log(room, `New round. 🎲 ${p0.name} ${d0}, ${p1.name} ${d1} — ${room.players[first]!.name} acts first (pot ${round.pot}).`);

  // Step 2: two hole cards each. Step 3: one shared community card.
  for (let i = 0; i < 2; i++) {
    round.holes[0].push(room.deck.pop()!);
    round.holes[1].push(room.deck.pop()!);
  }
  round.shared = room.deck.pop()!;
  log(room, `Shared card revealed: ${round.shared.suit === 'liar' ? '🃏 LIAR' : round.shared.suit}.`);

  room.round = round;
  room.phase = 'bet1';
  enterBetting(room);
}

function enterBetting(room: Room) {
  const r = room.round!;
  r.committed = [0, 0];
  r.checked = new Set();
  r.toAct = r.firstActor;
  // With either player all-in there is no betting decision to make; skip ahead.
  if (room.players[0]!.chips === 0 || room.players[1]!.chips === 0) closeBetting(room);
}

function closeBetting(room: Room) {
  if (room.phase === 'bet1') {
    const r = room.round!;
    // Step 5: deal the 3rd hole card to each.
    r.holes[0].push(room.deck.pop()!);
    r.holes[1].push(room.deck.pop()!);
    log(room, 'Third card dealt. Choose a card to reveal.');
    room.phase = 'reveal';
  } else if (room.phase === 'bet2') {
    enterShowdown(room);
  }
}

function awardFold(room: Room, winner: Seat) {
  const r = room.round!;
  r.result = { kind: 'fold', winner, potAwarded: r.pot };
  log(room, `${room.players[1 - winner]!.name} folded. ${room.players[winner]!.name} wins ${r.pot}.`);
  room.players[winner]!.chips += r.pot;
  r.pot = 0; // moved into the winner's stack; keep chips+pot+carry conserved
  room.phase = 'showdown';
}

// ---------------------------------------------------------------------------
// Betting
// ---------------------------------------------------------------------------

function commit(room: Room, seat: Seat, amount: number) {
  const r = room.round!;
  room.players[seat]!.chips -= amount;
  r.committed[seat] += amount;
  r.pot += amount;
}

/** Return an all-in caller's uncalled overage to the player who over-committed. */
function refundExcess(room: Room, over: Seat, under: Seat) {
  const r = room.round!;
  const diff = r.committed[over] - r.committed[under];
  if (diff > 0) {
    room.players[over]!.chips += diff;
    r.committed[over] -= diff;
    r.pot -= diff;
  }
}

export function bet(room: Room, seat: Seat, action: string, amount = 0): ActionResult {
  const r = room.round;
  if (!r || (room.phase !== 'bet1' && room.phase !== 'bet2')) return fail('No betting right now.');
  if (seat !== r.toAct) return fail('Not your turn.');

  const opp = (1 - seat) as Seat;
  const chips = room.players[seat]!.chips;
  const toCall = r.committed[opp] - r.committed[seat];

  switch (action) {
    case 'fold':
      awardFold(room, opp);
      return ok;

    case 'check': {
      if (toCall !== 0) return fail('You cannot check facing a bet.');
      r.checked.add(seat);
      log(room, `${room.players[seat]!.name} checks.`);
      if (r.checked.has(opp)) closeBetting(room);
      else r.toAct = opp;
      return ok;
    }

    case 'call': {
      if (toCall <= 0) return fail('Nothing to call — check instead.');
      const pay = Math.min(toCall, chips);
      commit(room, seat, pay);
      if (r.committed[seat] < r.committed[opp]) refundExcess(room, opp, seat);
      log(room, `${room.players[seat]!.name} calls${pay < toCall ? ' (all-in)' : ''}.`);
      closeBetting(room);
      return ok;
    }

    case 'raise': {
      if (!Number.isFinite(amount) || amount < 1) return fail('Raise must be at least 1.');
      const pay = Math.min(toCall + Math.floor(amount), chips); // chips put in this action
      if (pay <= toCall) return fail('Not enough chips to raise — call instead.');
      commit(room, seat, pay);
      r.checked.clear();
      const allIn = pay === chips;
      log(room, `${room.players[seat]!.name} ${toCall > 0 ? 'raises' : 'bets'} to ${r.committed[seat]}${allIn ? ' (all-in)' : ''}.`);
      r.toAct = opp;
      return ok;
    }

    default:
      return fail('Unknown action.');
  }
}

// ---------------------------------------------------------------------------
// Step 6 — simultaneous reveal
// ---------------------------------------------------------------------------

export function reveal(room: Room, seat: Seat, cardIndex: number): ActionResult {
  const r = room.round;
  if (!r || room.phase !== 'reveal') return fail('Not the reveal step.');
  if (r.revealIndex[seat] !== null) return fail('Already revealed.');
  const hole = r.holes[seat];
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= hole.length) {
    return fail('Bad card.');
  }
  if (hole[cardIndex].suit === 'liar') return fail('You cannot reveal the liar.');

  r.revealIndex[seat] = cardIndex;
  // Buffer: a player's choice stays hidden until BOTH have locked in.
  if (r.revealIndex[0] !== null && r.revealIndex[1] !== null) {
    log(room, `Both revealed — ${room.players[0]!.name}: ${revealedSuit(r, 0)}, ${room.players[1]!.name}: ${revealedSuit(r, 1)}.`);
    room.phase = 'discuss';
  }
  return ok;
}

function revealedSuit(r: Round, seat: number): string {
  return r.holes[seat][r.revealIndex[seat]!].suit;
}

export function discussDone(room: Room, seat: Seat): ActionResult {
  const r = room.round;
  if (!r || room.phase !== 'discuss') return fail('Not the discussion step.');
  r.discussReady[seat] = true;
  log(room, `${room.players[seat]!.name} is ready to bet.`);
  if (r.discussReady[0] && r.discussReady[1]) {
    room.phase = 'bet2';
    enterBetting(room);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Step 9 — liar resolution + showdown
// ---------------------------------------------------------------------------

function slotSuits(r: Round, seat: number): Suit[] {
  // Concrete suit for [hole0, hole1, hole2, shared]; a liar gets a placeholder
  // that resolution overwrites.
  return [...r.holes[seat], r.shared!].map((c) => (c.suit === 'liar' ? 'rock' : (c.suit as Suit)));
}

function enterShowdown(room: Room) {
  const r = room.round!;
  const sharedIsLiar = r.shared!.suit === 'liar';

  const wildSlots: [number[], number[]] = [[], []];
  for (const seat of [0, 1] as const) {
    if (sharedIsLiar) {
      wildSlots[seat] = [3]; // each player independently sets the shared liar
    } else if (r.holes[seat].some((c) => c.suit === 'liar')) {
      // Both still-hidden hole cards (the two NOT revealed at step 6) become wild.
      wildSlots[seat] = [0, 1, 2].filter((i) => i !== r.revealIndex[seat]);
    }
  }

  const base: [Suit[], Suit[]] = [slotSuits(r, 0), slotSuits(r, 1)];
  // Resolve opponent-aware (win-max). The hand to beat is the opponent's fixed
  // hand when they hold no liar, else their strongest-by-rank provisional (the
  // shared-liar case where both sides are wild at once).
  const provisional: [Suit[], Suit[]] = [
    bestResolution(base[0], wildSlots[0]).resolved,
    bestResolution(base[1], wildSlots[1]).resolved,
  ];
  const liar: LiarState = {
    pending: [wildSlots[0].length > 0, wildSlots[1].length > 0],
    wildSlots,
    baseSuits: base,
    resolved: [null, null],
    suggestion: [null, null],
  };
  for (const seat of [0, 1] as const) {
    const best = bestResolution(base[seat], wildSlots[seat], provisional[1 - seat]);
    if (liar.pending[seat]) liar.suggestion[seat] = best.chosen;
    else liar.resolved[seat] = best.resolved;
  }
  r.liar = liar;
  room.phase = 'showdown';

  if (!liar.pending[0] && !liar.pending[1]) finalizeShowdown(room);
  else log(room, 'Showdown — liar holder(s) choosing values…');
}

export function setLiar(
  room: Room,
  seat: Seat,
  payload: { auto?: boolean; values?: string[] },
): ActionResult {
  const r = room.round;
  if (!r || room.phase !== 'showdown' || !r.liar) return fail('Nothing to resolve.');
  const liar = r.liar;
  if (!liar.pending[seat]) return fail('You have no liar to set.');

  const slots = liar.wildSlots[seat];
  const resolved = [...liar.baseSuits[seat]];
  if (payload.auto || !payload.values) {
    slots.forEach((slot, i) => (resolved[slot] = liar.suggestion[seat]![i]));
  } else {
    if (payload.values.length !== slots.length) return fail('Wrong number of liar values.');
    if (!payload.values.every((v) => ALL_VALUES.includes(v as Suit))) return fail('Bad liar value.');
    slots.forEach((slot, i) => (resolved[slot] = payload.values![i] as Suit));
  }
  liar.resolved[seat] = resolved;
  liar.pending[seat] = false;
  log(room, `${room.players[seat]!.name} locked their liar.`);

  if (!liar.pending[0] && !liar.pending[1]) finalizeShowdown(room);
  return ok;
}

function autoResolveLiar(room: Room, seat: Seat) {
  if (room.round?.liar?.pending[seat]) setLiar(room, seat, { auto: true });
}

function finalizeShowdown(room: Room) {
  const r = room.round!;
  const [handA, handB] = [r.liar!.resolved[0]!, r.liar!.resolved[1]!];
  const cmp = compare(handA, handB);
  const evA = evaluate(handA);
  const evB = evaluate(handB);

  r.result = {
    kind: cmp === 0 ? 'draw' : 'showdown',
    winner: cmp === 1 ? 0 : cmp === -1 ? 1 : null,
    potAwarded: r.pot,
    hands: [handA, handB],
    names: [room.players[0]!.name, room.players[1]!.name],
    ranks: [evA.rank, evB.rank],
  };

  if (cmp === 0) {
    room.carry = r.pot; // draw → pot carries to the next round
    log(room, `Showdown: DRAW (${evA.name} vs ${evB.name}). Pot of ${r.pot} carries over.`);
  } else {
    const w = r.result.winner!;
    room.players[w]!.chips += r.pot;
    log(room, `Showdown: ${room.players[w]!.name} wins ${r.pot} with ${(w === 0 ? evA : evB).name}.`);
  }
  r.pot = 0; // moved into a stack or the carry; keep chips+pot+carry conserved
}

export function nextRound(room: Room, _seat: Seat): ActionResult {
  if (room.phase !== 'showdown' || !room.round?.result) return fail('No round to advance.');
  // Either player may advance once the result is shown (friendly game).
  startRound(room);
  return ok;
}

/**
 * Request a rematch after the match is over. Both players must opt in; once they
 * do, chips reset to the starting stack and a fresh match begins.
 */
export function rematch(room: Room, seat: Seat): ActionResult {
  if (room.phase !== 'matchover') return fail('No match to rematch.');
  room.rematchReady[seat] = true;
  log(room, `${room.players[seat]!.name} wants a rematch.`);
  if (room.rematchReady[0] && room.rematchReady[1]) {
    for (const p of room.players) if (p) p.chips = START_CHIPS;
    room.carry = 0;
    room.matchWinner = null;
    startRound(room); // also clears rematchReady
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Private per-seat view (the only data a client ever receives)
// ---------------------------------------------------------------------------

export interface CardView {
  suit: string;
  id: number;
}

function cardView(c: Card | null): CardView | null {
  return c ? { suit: c.suit, id: c.id } : null;
}

/**
 * Build the private state for one seat. By construction this never includes the
 * opponent's hidden cards or the undealt deck — only the viewer's own hand and
 * public information.
 */
export function viewFor(room: Room, seat: Seat): Record<string, unknown> {
  const me = room.players[seat]!;
  const oppSeat = (1 - seat) as Seat;
  const opp = room.players[oppSeat];
  const r = room.round;

  const you: Record<string, unknown> = { name: me.name, chips: me.chips, connected: me.connected };
  const view: Record<string, unknown> = {
    type: 'state',
    room: room.code,
    seat,
    phase: room.phase,
    you,
    opp: opp ? { name: opp.name, chips: opp.chips, connected: opp.connected } : null,
    pot: r ? r.pot : 0,
    carry: room.carry,
    roundNo: room.roundNo,
    deckCount: room.deck.length,
    log: room.log.slice(-15),
    matchWinner: room.matchWinner,
  };
  if (!r) return view;

  view.shared = cardView(r.shared);
  view.firstActor = r.firstActor;
  view.dice = r.dice;

  you.hole = r.holes[seat].map(cardView); // your own cards in full (liar shown to you)
  you.revealIndex = r.revealIndex[seat];
  you.revealedCard =
    r.revealIndex[seat] !== null ? cardView(r.holes[seat][r.revealIndex[seat]!]) : null;

  const bothRevealed = r.revealIndex[0] !== null && r.revealIndex[1] !== null;
  view.opp = {
    ...(view.opp as object),
    holeCount: r.holes[oppSeat].length,
    // Buffered reveal: withhold the opponent's chosen slot AND card until both lock.
    revealIndex: bothRevealed ? r.revealIndex[oppSeat] : null,
    revealedCard: bothRevealed ? cardView(r.holes[oppSeat][r.revealIndex[oppSeat]!]) : null,
  };

  if (room.phase === 'bet1' || room.phase === 'bet2') {
    const toCall = r.committed[oppSeat] - r.committed[seat];
    view.betting = {
      toAct: r.toAct,
      yourTurn: r.toAct === seat,
      committed: r.committed,
      toCall,
      yourChips: me.chips,
      canCheck: toCall === 0,
    };
  }
  if (room.phase === 'reveal') {
    view.reveal = { youLocked: r.revealIndex[seat] !== null, oppLocked: r.revealIndex[oppSeat] !== null };
  }
  if (room.phase === 'discuss') {
    view.discuss = { youReady: r.discussReady[seat], oppReady: r.discussReady[oppSeat] };
  }
  if (room.phase === 'showdown') {
    const liar = r.liar;
    if (liar?.pending[seat]) {
      view.liar = {
        needsYou: true,
        wildSlots: liar.wildSlots[seat], // slot indices 0..3 (3 = shared)
        sharedIsLiar: r.shared!.suit === 'liar',
      };
    } else if (liar && (liar.pending[0] || liar.pending[1])) {
      view.liar = { needsYou: false, waitingOnOpponent: true };
    }
    if (r.result) view.result = r.result;
  }
  if (room.phase === 'matchover') {
    view.rematch = { youReady: room.rematchReady[seat], oppReady: room.rematchReady[oppSeat] };
  }
  return view;
}
