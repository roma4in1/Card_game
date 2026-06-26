// engine.ts — the authoritative "Win or Die" game engine (2–8 players).
//
// Pure with respect to the network: it owns and mutates game state but performs
// no I/O. Action handlers mutate the room and return an optional error; the
// transport observes state via viewFor() and pushes it to clients. Randomness is
// injected so the engine is deterministically testable.
//
// It owns ALL secret state (deck, every hidden hand, the phase machine) and
// viewFor() guarantees a client only ever sees its own cards plus public info.
//
// Players gather in a lobby; a host starts the match with whoever is present.
// Betting is multi-way with side pots; showdown ranks all live hands, and a
// rock-paper-scissor cycle at the top splits the pot among the cycling players.
// Players bust out as they hit 0 chips until one remains (last player standing).

import { randomInt, randomBytes } from 'node:crypto';
import { compare, evaluate, type Suit } from './evaluator.ts';
import { buildDeck, deckCopies, shuffle, bestResolution, ALL_VALUES, type Card } from './cards.ts';

export const MAX_SEATS = 8;
export const START_CHIPS = 35;
export const ANTE = 1;

export type Phase = 'lobby' | 'bet1' | 'reveal' | 'discuss' | 'bet2' | 'showdown' | 'matchover';
export type Seat = number;

export type Rng = () => number;
const cryptoRng: Rng = () => randomInt(0, 2 ** 30) / 2 ** 30;
const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);

interface PlayerLiar {
  wildSlots: number[];
  base: Suit[];
  suggestion: Suit[]; // rank-max fallback used on disconnect
  resolved: Suit[] | null;
  pending: boolean;
}

export interface Player {
  token: string;
  name: string;
  chips: number;
  connected: boolean;
  inMatch: boolean; // taking part in the current match
  eliminated: boolean; // busted out of the match
  // per-round state (reset each round):
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  committed: number; // chips committed in the CURRENT betting round
  contributed: number; // chips committed across the WHOLE round (for side pots)
  acted: boolean; // has acted since the last raise
  revealIndex: number | null;
  discussReady: boolean;
  liar: PlayerLiar | null;
}

export interface PotAward {
  seat: number;
  amount: number;
}
export interface Reveal {
  seat: number;
  name: string;
  cards: Suit[] | null; // null if folded
  rank: number | null;
  folded: boolean;
}
export interface RoundResult {
  kind: 'fold' | 'showdown';
  reveals: Reveal[];
  awards: PotAward[];
  carried: number; // chips carried to the next round (draws / indivisible remainders)
}

interface Round {
  shared: Card | null;
  reshuffled: boolean;
  dice: number[]; // each participant's d6 roll (0 for non-participants); highest acts first
  toAct: number; // seat to act, or -1
  firstActor: number; // seat that rolled highest and acts first this round
  pot: number;
  carryIn: number; // carried-over chips that seeded this round's pot (dead money)
  currentBet: number;
  participants: number[]; // seats dealt into this round
  result: RoundResult | null;
}

export interface Room {
  code: string;
  rng: Rng;
  players: (Player | null)[]; // length MAX_SEATS
  host: number; // seat that may start the match
  phase: Phase;
  deck: Card[];
  round: Round | null;
  roundNo: number;
  carry: number;
  log: string[];
  matchWinner: number | null;
  rematchReady: boolean[];
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
    players: new Array(MAX_SEATS).fill(null),
    host: 0,
    phase: 'lobby',
    deck: [],
    round: null,
    roundNo: 0,
    carry: 0,
    log: [],
    matchWinner: null,
    rematchReady: new Array(MAX_SEATS).fill(false),
    lastActivity: Date.now(),
  };
}

function genToken(): string {
  return randomBytes(16).toString('hex');
}

function log(room: Room, msg: string) {
  room.log.push(msg);
  if (room.log.length > 40) room.log.shift();
}

function seats(room: Room): number[] {
  const out: number[] = [];
  room.players.forEach((p, s) => p && out.push(s));
  return out;
}
function activeSeats(room: Room): number[] {
  return seats(room).filter((s) => room.players[s]!.inMatch && !room.players[s]!.eliminated);
}
function inHand(room: Room): number[] {
  const r = room.round;
  if (!r) return [];
  return r.participants.filter((s) => !room.players[s]!.folded);
}

export type JoinResult =
  | { ok: true; seat: Seat; token: string; reconnected: boolean }
  | { ok: false; reason: 'full' | 'in-progress' };

/** Join (or rejoin via token) a room's lobby. */
export function join(room: Room, token: string | undefined, name: string | undefined): JoinResult {
  if (token) {
    for (const s of seats(room)) {
      const p = room.players[s]!;
      if (p.token === token) {
        p.connected = true;
        log(room, `${p.name} reconnected.`);
        return { ok: true, seat: s, token, reconnected: true };
      }
    }
  }
  if (room.phase !== 'lobby') return { ok: false, reason: 'in-progress' };
  const free = room.players.findIndex((p) => p === null);
  if (free === -1) return { ok: false, reason: 'full' };

  const newToken = genToken();
  const cleanName = (name || `Player ${free + 1}`).slice(0, 16);
  room.players[free] = {
    token: newToken, name: cleanName, chips: START_CHIPS, connected: true,
    inMatch: false, eliminated: false, hole: [], folded: false, allIn: false,
    committed: 0, contributed: 0, acted: false, revealIndex: null, discussReady: false, liar: null,
  };
  if (seats(room).length === 1) room.host = free; // first to join hosts
  log(room, `${cleanName} joined the lobby.`);
  return { ok: true, seat: free, token: newToken, reconnected: false };
}

export function setConnected(room: Room, seat: Seat, connected: boolean) {
  const p = room.players[seat];
  if (!p || p.connected === connected) return;
  p.connected = connected;
  log(room, `${p.name} ${connected ? 'reconnected' : 'disconnected'}.`);
  if (!connected) autoResolveLiar(room, seat);
}

/** Start the match from the lobby with everyone currently connected. */
export function startMatch(room: Room, seat: Seat): ActionResult {
  if (room.phase !== 'lobby') return fail('The match has already started.');
  if (seat !== room.host) return fail('Only the host can start.');
  // Only deal in connected players, so a no-show can't stall the table.
  const joined = seats(room).filter((s) => room.players[s]!.connected);
  if (joined.length < 2) return fail('Need at least 2 connected players to start.');
  for (const s of seats(room)) {
    const p = room.players[s]!;
    p.inMatch = joined.includes(s);
    p.eliminated = false;
    p.chips = START_CHIPS;
  }
  room.deck = shuffle(buildDeck(deckCopies(joined.length)), room.rng);
  room.carry = 0;
  room.matchWinner = null;
  room.round = null;
  log(room, `Match started with ${joined.length} players.`);
  startRound(room);
  return ok;
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

function resetRoundState(p: Player) {
  p.hole = [];
  p.folded = false;
  p.allIn = false;
  p.committed = 0;
  p.contributed = 0;
  p.acted = false;
  p.revealIndex = null;
  p.discussReady = false;
  p.liar = null;
}

function startRound(room: Room) {
  // Eliminate broke players, but only when there's no carried pot still to play for.
  if (room.carry === 0) {
    for (const s of activeSeats(room)) {
      if (room.players[s]!.chips === 0) {
        room.players[s]!.eliminated = true;
        log(room, `${room.players[s]!.name} is out of chips — eliminated.`);
      }
    }
  }
  const active = activeSeats(room);
  if (active.length <= 1) {
    room.phase = 'matchover';
    room.matchWinner = active[0] ?? null;
    if (room.matchWinner !== null) log(room, `🏆 ${room.players[room.matchWinner]!.name} wins the match!`);
    return;
  }

  room.roundNo += 1;
  room.rematchReady = new Array(MAX_SEATS).fill(false);

  const need = 3 * active.length + 1;
  const reshuffled = room.deck.length < need;
  if (reshuffled) {
    // Reshuffle sized to the current table (it shrinks as players bust out).
    room.deck = shuffle(buildDeck(deckCopies(active.length)), room.rng);
    log(room, 'Deck ran low — reshuffled a fresh deck.');
  }

  for (const p of room.players) if (p) resetRoundState(p);

  const round: Round = {
    shared: null,
    reshuffled,
    dice: new Array(MAX_SEATS).fill(0),
    toAct: -1,
    firstActor: active[0],
    pot: room.carry,
    carryIn: room.carry,
    currentBet: 0,
    participants: active,
    result: null,
  };
  room.carry = 0;
  room.round = round;

  // Everyone rolls a die; the highest roll acts first (ties are re-rolled).
  let firstActor = active[0];
  for (let tries = 0; tries < 60; tries++) {
    for (const s of active) round.dice[s] = 1 + randInt(room.rng, 6);
    const max = Math.max(...active.map((s) => round.dice[s]));
    const leaders = active.filter((s) => round.dice[s] === max);
    firstActor = leaders[0];
    if (leaders.length === 1) break;
  }
  round.firstActor = firstActor;

  // Antes: each player who can afford one posts it. Players with no chips (all-in
  // from a carried pot) post nothing and are marked all-in — they still contest
  // the carried pot but make no betting decisions.
  let anteCount = 0;
  for (const s of active) {
    if (room.players[s]!.chips >= ANTE) {
      commit(room, s, ANTE);
      anteCount++;
    }
    if (room.players[s]!.chips === 0) room.players[s]!.allIn = true;
  }
  log(room, `New round. 🎲 ${room.players[firstActor]!.name} rolled highest — acts first. ${anteCount} antes → pot ${round.pot}.`);

  // Deal 2 hole cards each, then the shared community card.
  for (let i = 0; i < 2; i++) for (const s of active) room.players[s]!.hole.push(room.deck.pop()!);
  round.shared = room.deck.pop()!;
  log(room, `Shared card: ${round.shared.suit === 'liar' ? '🃏 LIAR' : round.shared.suit}.`);

  room.phase = 'bet1';
  enterBetting(room);
}

// ---------------------------------------------------------------------------
// Betting (multi-way)
// ---------------------------------------------------------------------------

function commit(room: Room, seat: number, amount: number) {
  const p = room.players[seat]!;
  p.chips -= amount;
  p.committed += amount;
  p.contributed += amount;
  room.round!.pot += amount;
}

function canAct(room: Room, seat: number): boolean {
  const p = room.players[seat]!;
  const r = room.round!;
  return r.participants.includes(seat) && !p.folded && !p.allIn && !p.acted;
}

function nextToAct(room: Room, fromSeat: number): number {
  for (let i = 1; i <= MAX_SEATS; i++) {
    const s = (fromSeat + i) % MAX_SEATS;
    if (room.players[s] && canAct(room, s)) return s;
  }
  return -1;
}

function enterBetting(room: Room) {
  const r = room.round!;
  r.currentBet = 0;
  for (const s of r.participants) {
    room.players[s]!.committed = 0;
    room.players[s]!.acted = false;
  }
  // Action opens on the dice winner (or the next able player if they've folded).
  r.toAct = nextToAct(room, (r.firstActor - 1 + MAX_SEATS) % MAX_SEATS);
  if (r.toAct === -1) closeBetting(room); // everyone folded or all-in
}

function advance(room: Room, fromSeat: number) {
  const r = room.round!;
  const next = nextToAct(room, fromSeat);
  if (next === -1) closeBetting(room);
  else r.toAct = next;
}

function closeBetting(room: Room) {
  const r = room.round!;
  if (room.phase === 'bet1') {
    // Deal a 3rd hole card to each player still in the hand.
    for (const s of inHand(room)) room.players[s]!.hole.push(room.deck.pop()!);
    log(room, 'Third card dealt. Choose a card to reveal.');
    room.phase = 'reveal';
  } else if (room.phase === 'bet2') {
    enterShowdown(room);
  }
}

function awardFoldWin(room: Room, winner: number) {
  const r = room.round!;
  const amount = r.pot;
  room.players[winner]!.chips += amount;
  r.result = { kind: 'fold', reveals: [], awards: [{ seat: winner, amount }], carried: 0 };
  log(room, `Everyone folded to ${room.players[winner]!.name} — wins ${amount}.`);
  r.pot = 0;
  room.phase = 'showdown';
}

export function bet(room: Room, seat: Seat, action: string, amount = 0): ActionResult {
  const r = room.round;
  if (!r || (room.phase !== 'bet1' && room.phase !== 'bet2')) return fail('No betting right now.');
  if (seat !== r.toAct) return fail('Not your turn.');
  const p = room.players[seat]!;
  const toCall = r.currentBet - p.committed;

  switch (action) {
    case 'fold': {
      p.folded = true;
      p.acted = true;
      log(room, `${p.name} folds.`);
      const live = inHand(room);
      if (live.length === 1) return (awardFoldWin(room, live[0]), ok);
      advance(room, seat);
      return ok;
    }
    case 'check': {
      if (toCall !== 0) return fail('You cannot check facing a bet.');
      p.acted = true;
      log(room, `${p.name} checks.`);
      advance(room, seat);
      return ok;
    }
    case 'call': {
      if (toCall <= 0) return fail('Nothing to call — check instead.');
      const pay = Math.min(toCall, p.chips);
      commit(room, seat, pay);
      if (pay < toCall) p.allIn = true;
      p.acted = true;
      log(room, `${p.name} calls${p.allIn ? ' (all-in)' : ''}.`);
      advance(room, seat);
      return ok;
    }
    case 'raise': {
      if (!Number.isFinite(amount) || amount < 1) return fail('Raise must be at least 1.');
      const pay = Math.min(toCall + Math.floor(amount), p.chips);
      if (pay <= toCall) return fail('Not enough chips to raise — call instead.');
      commit(room, seat, pay);
      p.acted = true;
      if (p.chips === 0) p.allIn = true; // committed every chip
      if (p.committed > r.currentBet) {
        r.currentBet = p.committed;
        for (const s of r.participants) {
          const o = room.players[s]!;
          if (s !== seat && !o.folded && !o.allIn) o.acted = false; // must respond to the raise
        }
      }
      log(room, `${p.name} ${toCall > 0 ? 'raises' : 'bets'} to ${p.committed}${p.allIn ? ' (all-in)' : ''}.`);
      advance(room, seat);
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
  const p = room.players[seat];
  if (!p || !r.participants.includes(seat) || p.folded) return fail('You are not in this hand.');
  if (p.revealIndex !== null) return fail('Already revealed.');
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= p.hole.length) return fail('Bad card.');
  if (p.hole[cardIndex].suit === 'liar') return fail('You cannot reveal the liar.');

  p.revealIndex = cardIndex;
  if (inHand(room).every((s) => room.players[s]!.revealIndex !== null)) {
    log(room, 'All cards revealed.');
    room.phase = 'discuss';
  }
  return ok;
}

export function discussDone(room: Room, seat: Seat): ActionResult {
  const r = room.round;
  if (!r || room.phase !== 'discuss') return fail('Not the discussion step.');
  const p = room.players[seat];
  if (!p || !r.participants.includes(seat) || p.folded) return fail('You are not in this hand.');
  p.discussReady = true;
  log(room, `${p.name} is ready to bet.`);
  if (inHand(room).every((s) => room.players[s]!.discussReady)) {
    room.phase = 'bet2';
    enterBetting(room);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Step 9 — liar resolution + multi-way showdown with side pots
// ---------------------------------------------------------------------------

function slotSuits(p: Player, shared: Card): Suit[] {
  return [...p.hole, shared].map((c) => (c.suit === 'liar' ? 'rock' : (c.suit as Suit)));
}

function enterShowdown(room: Room) {
  const r = room.round!;
  const sharedIsLiar = r.shared!.suit === 'liar';
  for (const s of inHand(room)) {
    const p = room.players[s]!;
    let wildSlots: number[] = [];
    if (sharedIsLiar) wildSlots = [3];
    else if (p.hole.some((c) => c.suit === 'liar')) wildSlots = [0, 1, 2].filter((i) => i !== p.revealIndex);
    const base = slotSuits(p, r.shared!);
    const best = bestResolution(base, wildSlots);
    p.liar = {
      wildSlots,
      base,
      suggestion: best.chosen,
      resolved: wildSlots.length ? null : best.resolved,
      pending: wildSlots.length > 0,
    };
  }
  room.phase = 'showdown';
  if (inHand(room).every((s) => !room.players[s]!.liar!.pending)) finalizeShowdown(room);
  else log(room, 'Showdown — liar holder(s) choosing values…');
}

export function setLiar(room: Room, seat: Seat, payload: { values?: string[] }): ActionResult {
  const r = room.round;
  if (!r || room.phase !== 'showdown') return fail('Nothing to resolve.');
  const p = room.players[seat];
  if (!p || !p.liar || !p.liar.pending) return fail('You have no liar to set.');
  const slots = p.liar.wildSlots;
  const resolved = [...p.liar.base];
  if (!payload.values || payload.values.length !== slots.length) return fail('Pick a value for each card.');
  if (!payload.values.every((v) => ALL_VALUES.includes(v as Suit))) return fail('Bad liar value.');
  slots.forEach((slot, i) => (resolved[slot] = payload.values![i] as Suit));
  p.liar.resolved = resolved;
  p.liar.pending = false;
  log(room, `${p.name} locked their liar.`);
  if (inHand(room).every((s) => !room.players[s]!.liar!.pending)) finalizeShowdown(room);
  return ok;
}

function autoResolveLiar(room: Room, seat: Seat) {
  const p = room.players[seat];
  if (room.phase === 'showdown' && p?.liar?.pending) {
    const slots = p.liar.wildSlots;
    const resolved = [...p.liar.base];
    slots.forEach((slot, i) => (resolved[slot] = p.liar!.suggestion[i]));
    p.liar.resolved = resolved;
    p.liar.pending = false;
    if (inHand(room).every((s) => !room.players[s]!.liar!.pending)) finalizeShowdown(room);
  }
}

interface Pot {
  amount: number;
  eligible: number[]; // non-folded seats contesting this pot
}

function buildPots(room: Room): Pot[] {
  const r = room.round!;
  const parts = r.participants;
  const contrib = (s: number) => room.players[s]!.contributed;
  const levels = [...new Set(parts.map(contrib).filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  let dead = 0;
  for (const lvl of levels) {
    const layer = lvl - prev;
    const contributors = parts.filter((s) => contrib(s) >= lvl);
    const amount = layer * contributors.length;
    const eligible = contributors.filter((s) => !room.players[s]!.folded);
    if (eligible.length > 0) pots.push({ amount, eligible });
    else dead += amount; // everyone at this level folded
    prev = lvl;
  }
  // Dead money (levels where every contributor folded) joins the main pot.
  if (dead > 0) {
    if (pots.length) pots[0].amount += dead;
    else pots.push({ amount: dead, eligible: inHand(room) });
  }
  // Carried-in chips from a previous draw are contested by EVERYONE still in the
  // hand — including a 0-chip player who couldn't ante. So it's its own pot whose
  // eligibility isn't tied to this round's contributions.
  if (r.carryIn > 0) pots.push({ amount: r.carryIn, eligible: inHand(room) });
  return pots;
}

/** Winners of a pot among `eligible`: lowest rank, breaking ties by the cyclic
 *  rule. A pure rock-paper-scissor cycle (no one unbeaten) returns everyone. */
function winnerSet(eligible: number[], hand: (s: number) => Suit[]): number[] {
  if (eligible.length <= 1) return [...eligible];
  let minRank = Infinity;
  for (const s of eligible) minRank = Math.min(minRank, evaluate(hand(s)).rank);
  const cand = eligible.filter((s) => evaluate(hand(s)).rank === minRank);
  if (cand.length === 1) return cand;
  const unbeaten = cand.filter((c) => !cand.some((d) => d !== c && compare(hand(d), hand(c)) === 1));
  return unbeaten.length ? unbeaten : cand; // empty ⇒ full cycle ⇒ split among all
}

function finalizeShowdown(room: Room) {
  const r = room.round!;
  const live = inHand(room);
  const hand = (s: number) => room.players[s]!.liar!.resolved!;

  const pots = buildPots(room);
  const awards = new Map<number, number>();
  let carried = 0;
  for (const pot of pots) {
    const winners = winnerSet(pot.eligible, hand);
    if (winners.length === pot.eligible.length && pot.eligible.length === 2) {
      // A genuine heads-up draw for this pot — carry it whole.
      carried += pot.amount;
      continue;
    }
    const share = Math.floor(pot.amount / winners.length);
    const rem = pot.amount - share * winners.length;
    for (const w of winners) awards.set(w, (awards.get(w) ?? 0) + share);
    carried += rem; // indivisible remainder carries
  }
  for (const [s, amt] of awards) room.players[s]!.chips += amt;
  room.carry = carried;
  r.pot = 0;

  const reveals: Reveal[] = r.participants.map((s) => {
    const p = room.players[s]!;
    const folded = p.folded;
    return {
      seat: s,
      name: p.name,
      cards: folded ? null : hand(s),
      rank: folded ? null : evaluate(hand(s)).rank,
      folded,
    };
  });
  r.result = {
    kind: 'showdown',
    reveals,
    awards: [...awards].map(([seat, amount]) => ({ seat, amount })),
    carried,
  };
  const winnerNames = r.result.awards.map((a) => room.players[a.seat]!.name).join(', ');
  log(room, `Showdown. Pot to ${winnerNames || 'carry'}${carried ? ` (${carried} carried)` : ''}.`);
}

export function nextRound(room: Room, _seat: Seat): ActionResult {
  // Either player may advance once the result is shown; if the round already
  // advanced (another player clicked first), this is a harmless no-op rather
  // than an error.
  if (room.phase !== 'showdown' || !room.round?.result) return ok;
  startRound(room);
  return ok;
}

export function rematch(room: Room, seat: Seat): ActionResult {
  if (room.phase !== 'matchover') return ok; // already past match-over — no-op
  room.rematchReady[seat] = true;
  log(room, `${room.players[seat]!.name} wants a rematch.`);
  // Don't let a player who left block the rest — only connected entrants count.
  const wanters = seats(room).filter((s) => room.players[s]!.inMatch && room.players[s]!.connected);
  if (wanters.length >= 2 && wanters.every((s) => room.rematchReady[s])) {
    room.phase = 'lobby'; // back to the lobby so the host can start fresh
    room.round = null;
    room.matchWinner = null;
    room.carry = 0;
    for (const s of seats(room)) {
      const p = room.players[s]!;
      p.inMatch = false;
      p.eliminated = false;
      p.chips = START_CHIPS;
    }
    room.rematchReady = new Array(MAX_SEATS).fill(false);
    log(room, 'Rematch — back to the lobby.');
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Private per-seat view
// ---------------------------------------------------------------------------

export interface CardView {
  suit: string;
  id: number;
}
function cardView(c: Card | null): CardView | null {
  return c ? { suit: c.suit, id: c.id } : null;
}

export function viewFor(room: Room, seat: Seat): Record<string, unknown> {
  const me = room.players[seat]!;
  const r = room.round;
  const revealsPublic = room.phase === 'discuss' || room.phase === 'bet2' || room.phase === 'showdown';

  const roster = seats(room).map((s) => {
    const p = room.players[s]!;
    return { seat: s, name: p.name, chips: p.chips, connected: p.connected, host: s === room.host };
  });

  const view: Record<string, unknown> = {
    type: 'state',
    room: room.code,
    seat,
    phase: room.phase,
    you: { seat, name: me.name, chips: me.chips, connected: me.connected },
    roster,
    pot: r ? r.pot : 0,
    carry: room.carry,
    roundNo: room.roundNo,
    deckCount: r ? room.deck.length : null,
    log: room.log.slice(-15),
    matchWinner: room.matchWinner,
    host: room.host,
    youAreHost: seat === room.host,
  };

  if (room.phase === 'lobby') {
    view.lobby = { players: roster, canStart: seat === room.host && roster.length >= 2 };
    return view;
  }
  if (!r) return view;

  view.firstActor = r.firstActor;
  view.dice = r.dice;
  view.currentBet = r.currentBet;
  view.shared = cardView(r.shared);

  const you = view.you as Record<string, unknown>;
  you.inMatch = me.inMatch; // false ⇒ spectating this match
  you.inHand = r.participants.includes(seat) && !me.folded;
  you.folded = me.folded;
  you.allIn = me.allIn;
  you.committed = me.committed;
  you.hole = me.hole.map(cardView);
  you.revealIndex = me.revealIndex;
  you.revealedCard = me.revealIndex !== null ? cardView(me.hole[me.revealIndex]) : null;

  // Opponents — never their hidden cards.
  view.others = seats(room)
    .filter((s) => s !== seat)
    .map((s) => {
      const p = room.players[s]!;
      const dealt = r.participants.includes(s);
      const showReveal = revealsPublic && p.revealIndex !== null && !p.folded;
      return {
        seat: s,
        name: p.name,
        chips: p.chips,
        connected: p.connected,
        eliminated: p.eliminated,
        inHand: dealt && !p.folded,
        folded: p.folded,
        allIn: p.allIn,
        committed: p.committed,
        holeCount: p.hole.length,
        isTurn: r.toAct === s,
        firstActor: r.firstActor === s,
        revealedCard: showReveal ? cardView(p.hole[p.revealIndex!]) : null,
        revealIndex: showReveal ? p.revealIndex : null,
      };
    });

  if (room.phase === 'bet1' || room.phase === 'bet2') {
    const toCall = r.currentBet - me.committed;
    view.betting = {
      toAct: r.toAct,
      yourTurn: r.toAct === seat,
      toCall,
      yourChips: me.chips,
      canCheck: toCall === 0,
    };
  }
  if (room.phase === 'reveal') {
    view.reveal = {
      youLocked: me.revealIndex !== null,
      waiting: inHand(room).filter((s) => room.players[s]!.revealIndex === null).length,
    };
  }
  if (room.phase === 'discuss') {
    view.discuss = {
      youReady: me.discussReady,
      waiting: inHand(room).filter((s) => !room.players[s]!.discussReady).length,
    };
  }
  if (room.phase === 'showdown') {
    if (me.liar?.pending) {
      view.liar = {
        needsYou: true,
        wildSlots: me.liar.wildSlots,
        sharedIsLiar: r.shared!.suit === 'liar',
      };
    } else if (inHand(room).some((s) => room.players[s]!.liar?.pending)) {
      view.liar = { needsYou: false, waitingOnOpponent: true };
    }
    if (r.result) view.result = r.result;
  }
  return view;
}
