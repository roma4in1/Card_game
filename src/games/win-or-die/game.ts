// games/win-or-die/game.ts — "Win or Die" as a platform game plugin (2–8 players).
//
// Pure: it owns and mutates a Match (its own state) but performs no I/O and knows
// nothing about the lobby. The room (platform/room.ts) starts a Match via create,
// routes actions through act, reads per-seat snapshots from view, and polls
// result. Randomness arrives through the per-call context, so Match stays plain.
//
// Betting is multi-way with side pots; everyone rolls a die each round and the
// highest acts first; showdown ranks all live hands and a rock-paper-scissor
// cycle at the top splits the pot. Players bust out until one remains.

import { compare, evaluate, type Suit } from './evaluator.ts';
import { buildDeck, deckCopies, shuffle, bestResolution, ALL_VALUES, type Card } from './cards.ts';
import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';

export const MAX_SEATS = 8;
export const START_CHIPS = 35;
export const ANTE = 1; // base ante
export const ANTE_EVERY = 5; // blinds go up every N rounds
export const ANTE_CAP = 5; // ante never exceeds this

/** The ante for a given round number — rises by 1 every ANTE_EVERY rounds, up to the cap. */
export function anteFor(roundNo: number): number {
  return Math.min(ANTE_CAP, ANTE + Math.floor((roundNo - 1) / ANTE_EVERY));
}

export type GamePhase = 'bet1' | 'reveal' | 'discuss' | 'bet2' | 'showdown' | 'matchover';

const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);

interface PlayerLiar {
  wildSlots: number[];
  base: Suit[];
  suggestion: Suit[]; // rank-max fallback used on disconnect
  resolved: Suit[] | null;
  pending: boolean;
}

interface MP {
  name: string;
  connected: boolean;
  chips: number;
  eliminated: boolean;
  // per-round state (reset each round):
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  committed: number; // chips committed in the CURRENT betting round
  contributed: number; // chips committed across the WHOLE round (for side pots)
  acted: boolean;
  revealIndex: number | null;
  discussReady: boolean;
  liar: PlayerLiar | null;
}

interface PotAward {
  seat: number;
  amount: number;
}
interface Reveal {
  seat: number;
  name: string;
  cards: Suit[] | null;
  rank: number | null;
  folded: boolean;
}
interface RoundResult {
  kind: 'fold' | 'showdown';
  reveals: Reveal[];
  awards: PotAward[];
  carried: number;
}

interface Round {
  shared: Card | null;
  reshuffled: boolean;
  dice: number[];
  toAct: number;
  firstActor: number;
  pot: number;
  carryIn: number;
  currentBet: number;
  participants: number[];
  result: RoundResult | null;
}

export interface Match {
  players: (MP | null)[]; // length MAX_SEATS
  deck: Card[];
  round: Round | null;
  roundNo: number;
  carry: number;
  phase: GamePhase;
  winner: number | null;
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function log(m: Match, msg: string) {
  m.log.push(msg);
  if (m.log.length > 40) m.log.shift();
}

function seats(m: Match): number[] {
  const out: number[] = [];
  m.players.forEach((p, s) => p && out.push(s));
  return out;
}
function activeSeats(m: Match): number[] {
  return seats(m).filter((s) => !m.players[s]!.eliminated);
}
function inHand(m: Match): number[] {
  const r = m.round;
  if (!r) return [];
  return r.participants.filter((s) => !m.players[s]!.folded);
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

function resetRoundState(p: MP) {
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

function startRound(m: Match, rng: Rng) {
  // Eliminate broke players, but only when there's no carried pot still to play for.
  if (m.carry === 0) {
    for (const s of activeSeats(m)) {
      if (m.players[s]!.chips === 0) {
        m.players[s]!.eliminated = true;
        log(m, `${m.players[s]!.name} is out of chips — eliminated.`);
      }
    }
  }
  const active = activeSeats(m);
  if (active.length <= 1) {
    m.phase = 'matchover';
    m.winner = active[0] ?? null;
    if (m.winner !== null) log(m, `🏆 ${m.players[m.winner]!.name} wins the match!`);
    return;
  }

  m.roundNo += 1;

  const need = 3 * active.length + 1;
  const reshuffled = m.deck.length < need;
  if (reshuffled) {
    m.deck = shuffle(buildDeck(deckCopies(active.length)), rng);
    log(m, 'Deck ran low — reshuffled a fresh deck.');
  }

  for (const p of m.players) if (p) resetRoundState(p);

  const round: Round = {
    shared: null,
    reshuffled,
    dice: new Array(MAX_SEATS).fill(0),
    toAct: -1,
    firstActor: active[0],
    pot: m.carry,
    carryIn: m.carry,
    currentBet: 0,
    participants: active,
    result: null,
  };
  m.carry = 0;
  m.round = round;

  // Everyone rolls a die; the highest roll acts first (ties are re-rolled).
  let firstActor = active[0];
  for (let tries = 0; tries < 60; tries++) {
    for (const s of active) round.dice[s] = 1 + randInt(rng, 6);
    const max = Math.max(...active.map((s) => round.dice[s]));
    const leaders = active.filter((s) => round.dice[s] === max);
    firstActor = leaders[0];
    if (leaders.length === 1) break;
  }
  round.firstActor = firstActor;

  // Escalating antes; a short stack posts what it can (all-in for less).
  const ante = anteFor(m.roundNo);
  if (m.roundNo > 1 && ante > anteFor(m.roundNo - 1)) log(m, `⬆️ Blinds up — the ante is now ${ante}.`);
  let anteCount = 0;
  for (const s of active) {
    const pay = Math.min(ante, m.players[s]!.chips);
    if (pay > 0) {
      commit(m, s, pay);
      anteCount++;
    }
    if (m.players[s]!.chips === 0) m.players[s]!.allIn = true;
  }
  log(m, `New round (ante ${ante}). 🎲 ${m.players[firstActor]!.name} rolled highest — acts first. ${anteCount} antes → pot ${round.pot}.`);

  for (let i = 0; i < 2; i++) for (const s of active) m.players[s]!.hole.push(m.deck.pop()!);
  round.shared = m.deck.pop()!;
  log(m, `Shared card: ${round.shared.suit === 'liar' ? '🃏 LIAR' : round.shared.suit}.`);

  m.phase = 'bet1';
  enterBetting(m);
}

// ---------------------------------------------------------------------------
// Betting (multi-way)
// ---------------------------------------------------------------------------

function commit(m: Match, seat: number, amount: number) {
  const p = m.players[seat]!;
  p.chips -= amount;
  p.committed += amount;
  p.contributed += amount;
  m.round!.pot += amount;
}

function canAct(m: Match, seat: number): boolean {
  const p = m.players[seat]!;
  const r = m.round!;
  return r.participants.includes(seat) && !p.folded && !p.allIn && !p.acted;
}

function nextToAct(m: Match, fromSeat: number): number {
  for (let i = 1; i <= MAX_SEATS; i++) {
    const s = (fromSeat + i) % MAX_SEATS;
    if (m.players[s] && canAct(m, s)) return s;
  }
  return -1;
}

function enterBetting(m: Match) {
  const r = m.round!;
  r.currentBet = 0;
  for (const s of r.participants) {
    m.players[s]!.committed = 0;
    m.players[s]!.acted = false;
  }
  r.toAct = nextToAct(m, (r.firstActor - 1 + MAX_SEATS) % MAX_SEATS);
  if (r.toAct === -1) closeBetting(m);
}

function advance(m: Match, fromSeat: number) {
  const next = nextToAct(m, fromSeat);
  if (next === -1) closeBetting(m);
  else m.round!.toAct = next;
}

function closeBetting(m: Match) {
  if (m.phase === 'bet1') {
    for (const s of inHand(m)) m.players[s]!.hole.push(m.deck.pop()!);
    log(m, 'Third card dealt. Choose a card to reveal.');
    m.phase = 'reveal';
  } else if (m.phase === 'bet2') {
    enterShowdown(m);
  }
}

function awardFoldWin(m: Match, winner: number) {
  const r = m.round!;
  const amount = r.pot;
  m.players[winner]!.chips += amount;
  r.result = { kind: 'fold', reveals: [], awards: [{ seat: winner, amount }], carried: 0 };
  log(m, `Everyone folded to ${m.players[winner]!.name} — wins ${amount}.`);
  r.pot = 0;
  m.phase = 'showdown';
}

function bet(m: Match, seat: number, action: string, amount: number): ActionResult {
  const r = m.round;
  if (!r || (m.phase !== 'bet1' && m.phase !== 'bet2')) return fail('No betting right now.');
  if (seat !== r.toAct) return fail('Not your turn.');
  const p = m.players[seat]!;
  const toCall = r.currentBet - p.committed;

  switch (action) {
    case 'fold': {
      p.folded = true;
      p.acted = true;
      log(m, `${p.name} folds.`);
      const live = inHand(m);
      if (live.length === 1) return (awardFoldWin(m, live[0]), ok);
      advance(m, seat);
      return ok;
    }
    case 'check': {
      if (toCall !== 0) return fail('You cannot check facing a bet.');
      p.acted = true;
      log(m, `${p.name} checks.`);
      advance(m, seat);
      return ok;
    }
    case 'call': {
      if (toCall <= 0) return fail('Nothing to call — check instead.');
      const pay = Math.min(toCall, p.chips);
      commit(m, seat, pay);
      if (pay < toCall) p.allIn = true;
      p.acted = true;
      log(m, `${p.name} calls${p.allIn ? ' (all-in)' : ''}.`);
      advance(m, seat);
      return ok;
    }
    case 'raise': {
      if (!Number.isFinite(amount) || amount < 1) return fail('Raise must be at least 1.');
      const pay = Math.min(toCall + Math.floor(amount), p.chips);
      if (pay <= toCall) return fail('Not enough chips to raise — call instead.');
      commit(m, seat, pay);
      p.acted = true;
      if (p.chips === 0) p.allIn = true;
      if (p.committed > r.currentBet) {
        r.currentBet = p.committed;
        for (const s of r.participants) {
          const o = m.players[s]!;
          if (s !== seat && !o.folded && !o.allIn) o.acted = false;
        }
      }
      log(m, `${p.name} ${toCall > 0 ? 'raises' : 'bets'} to ${p.committed}${p.allIn ? ' (all-in)' : ''}.`);
      advance(m, seat);
      return ok;
    }
    default:
      return fail('Unknown action.');
  }
}

// ---------------------------------------------------------------------------
// Step 6 — simultaneous reveal
// ---------------------------------------------------------------------------

function reveal(m: Match, seat: number, cardIndex: number): ActionResult {
  const r = m.round;
  if (!r || m.phase !== 'reveal') return fail('Not the reveal step.');
  const p = m.players[seat];
  if (!p || !r.participants.includes(seat) || p.folded) return fail('You are not in this hand.');
  if (p.revealIndex !== null) return fail('Already revealed.');
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= p.hole.length) return fail('Bad card.');
  if (p.hole[cardIndex].suit === 'liar') return fail('You cannot reveal the liar.');

  p.revealIndex = cardIndex;
  if (inHand(m).every((s) => m.players[s]!.revealIndex !== null)) {
    log(m, 'All cards revealed.');
    m.phase = 'discuss';
  }
  return ok;
}

function discussDone(m: Match, seat: number): ActionResult {
  const r = m.round;
  if (!r || m.phase !== 'discuss') return fail('Not the discussion step.');
  const p = m.players[seat];
  if (!p || !r.participants.includes(seat) || p.folded) return fail('You are not in this hand.');
  p.discussReady = true;
  log(m, `${p.name} is ready to bet.`);
  if (inHand(m).every((s) => m.players[s]!.discussReady)) {
    m.phase = 'bet2';
    enterBetting(m);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Step 9 — liar resolution + multi-way showdown with side pots
// ---------------------------------------------------------------------------

function slotSuits(p: MP, shared: Card): Suit[] {
  return [...p.hole, shared].map((c) => (c.suit === 'liar' ? 'rock' : (c.suit as Suit)));
}

function enterShowdown(m: Match) {
  const r = m.round!;
  const sharedIsLiar = r.shared!.suit === 'liar';
  for (const s of inHand(m)) {
    const p = m.players[s]!;
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
  m.phase = 'showdown';
  if (inHand(m).every((s) => !m.players[s]!.liar!.pending)) finalizeShowdown(m);
  else log(m, 'Showdown — liar holder(s) choosing values…');
}

function setLiar(m: Match, seat: number, payload: { values?: string[] }): ActionResult {
  const r = m.round;
  if (!r || m.phase !== 'showdown') return fail('Nothing to resolve.');
  const p = m.players[seat];
  if (!p || !p.liar || !p.liar.pending) return fail('You have no liar to set.');
  const slots = p.liar.wildSlots;
  const resolved = [...p.liar.base];
  if (!payload.values || payload.values.length !== slots.length) return fail('Pick a value for each card.');
  if (!payload.values.every((v) => ALL_VALUES.includes(v as Suit))) return fail('Bad liar value.');
  slots.forEach((slot, i) => (resolved[slot] = payload.values![i] as Suit));
  p.liar.resolved = resolved;
  p.liar.pending = false;
  log(m, `${p.name} locked their liar.`);
  if (inHand(m).every((s) => !m.players[s]!.liar!.pending)) finalizeShowdown(m);
  return ok;
}

function autoResolveLiar(m: Match, seat: number) {
  const p = m.players[seat];
  if (m.phase === 'showdown' && p?.liar?.pending) {
    const slots = p.liar.wildSlots;
    const resolved = [...p.liar.base];
    slots.forEach((slot, i) => (resolved[slot] = p.liar!.suggestion[i]));
    p.liar.resolved = resolved;
    p.liar.pending = false;
    if (inHand(m).every((s) => !m.players[s]!.liar!.pending)) finalizeShowdown(m);
  }
}

interface Pot {
  amount: number;
  eligible: number[];
}

function buildPots(m: Match): Pot[] {
  const r = m.round!;
  const parts = r.participants;
  const contrib = (s: number) => m.players[s]!.contributed;
  const levels = [...new Set(parts.map(contrib).filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  let dead = 0;
  for (const lvl of levels) {
    const layer = lvl - prev;
    const contributors = parts.filter((s) => contrib(s) >= lvl);
    const amount = layer * contributors.length;
    const eligible = contributors.filter((s) => !m.players[s]!.folded);
    if (eligible.length > 0) pots.push({ amount, eligible });
    else dead += amount;
    prev = lvl;
  }
  if (dead > 0) {
    if (pots.length) pots[0].amount += dead;
    else pots.push({ amount: dead, eligible: inHand(m) });
  }
  if (r.carryIn > 0) pots.push({ amount: r.carryIn, eligible: inHand(m) });
  return pots;
}

function winnerSet(eligible: number[], hand: (s: number) => Suit[]): number[] {
  if (eligible.length <= 1) return [...eligible];
  let minRank = Infinity;
  for (const s of eligible) minRank = Math.min(minRank, evaluate(hand(s)).rank);
  const cand = eligible.filter((s) => evaluate(hand(s)).rank === minRank);
  if (cand.length === 1) return cand;
  const unbeaten = cand.filter((c) => !cand.some((d) => d !== c && compare(hand(d), hand(c)) === 1));
  return unbeaten.length ? unbeaten : cand;
}

function finalizeShowdown(m: Match) {
  const r = m.round!;
  const hand = (s: number) => m.players[s]!.liar!.resolved!;

  const pots = buildPots(m);
  const awards = new Map<number, number>();
  let carried = 0;
  for (const pot of pots) {
    const winners = winnerSet(pot.eligible, hand);
    if (winners.length === pot.eligible.length && pot.eligible.length === 2) {
      carried += pot.amount;
      continue;
    }
    const share = Math.floor(pot.amount / winners.length);
    const rem = pot.amount - share * winners.length;
    for (const w of winners) awards.set(w, (awards.get(w) ?? 0) + share);
    carried += rem;
  }
  for (const [s, amt] of awards) m.players[s]!.chips += amt;
  m.carry = carried;
  r.pot = 0;

  const reveals: Reveal[] = r.participants.map((s) => {
    const p = m.players[s]!;
    return {
      seat: s,
      name: p.name,
      cards: p.folded ? null : hand(s),
      rank: p.folded ? null : evaluate(hand(s)).rank,
      folded: p.folded,
    };
  });
  r.result = {
    kind: 'showdown',
    reveals,
    awards: [...awards].map(([seat, amount]) => ({ seat, amount })),
    carried,
  };
  const winnerNames = r.result.awards.map((a) => m.players[a.seat]!.name).join(', ');
  log(m, `Showdown. Pot to ${winnerNames || 'carry'}${carried ? ` (${carried} carried)` : ''}.`);
}

function nextRound(m: Match, rng: Rng): ActionResult {
  // Idempotent: a stale click after the round already advanced is a no-op.
  if (m.phase !== 'showdown' || !m.round?.result) return ok;
  startRound(m, rng);
  return ok;
}

// ---------------------------------------------------------------------------
// Private per-seat view (game portion only — the room adds room/roster/host)
// ---------------------------------------------------------------------------

interface CardView {
  suit: string;
  id: number;
}
function cardView(c: Card | null): CardView | null {
  return c ? { suit: c.suit, id: c.id } : null;
}

function view(m: Match, seat: number | null): Record<string, unknown> {
  const r = m.round;
  const me = seat !== null && m.players[seat] ? m.players[seat]! : null;
  const revealsPublic = m.phase === 'discuss' || m.phase === 'bet2' || m.phase === 'showdown';

  const v: Record<string, unknown> = {
    phase: m.phase,
    pot: r ? r.pot : 0,
    carry: m.carry,
    roundNo: m.roundNo,
    ante: anteFor(m.roundNo),
    anteUpInRounds: Math.min(ANTE_CAP, ANTE + Math.floor((m.roundNo - 1) / ANTE_EVERY)) >= ANTE_CAP ? null : ANTE_EVERY - ((m.roundNo - 1) % ANTE_EVERY),
    deckCount: r ? m.deck.length : null,
    log: m.log.slice(-15),
    matchWinner: m.winner,
  };
  // A `you` always exists so the client never crashes; spectators get a stub.
  v.you = me
    ? { seat, name: me.name, chips: me.chips, connected: me.connected, inMatch: !me.eliminated }
    : { seat: seat ?? -1, name: '', chips: 0, connected: true, inMatch: false, hole: null };
  if (!r) return v;

  v.firstActor = r.firstActor;
  v.dice = r.dice;
  v.currentBet = r.currentBet;
  v.shared = cardView(r.shared);

  if (me) {
    const you = v.you as Record<string, unknown>;
    you.inHand = r.participants.includes(seat!) && !me.folded;
    you.folded = me.folded;
    you.allIn = me.allIn;
    you.committed = me.committed;
    you.hole = me.hole.map(cardView);
    you.revealIndex = me.revealIndex;
    you.revealedCard = me.revealIndex !== null ? cardView(me.hole[me.revealIndex]) : null;
  }

  v.others = seats(m)
    .filter((s) => s !== seat)
    .map((s) => {
      const p = m.players[s]!;
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

  if (me && (m.phase === 'bet1' || m.phase === 'bet2')) {
    const toCall = r.currentBet - me.committed;
    v.betting = { toAct: r.toAct, yourTurn: r.toAct === seat, toCall, yourChips: me.chips, canCheck: toCall === 0 };
  }
  if (me && m.phase === 'reveal') {
    v.reveal = {
      youLocked: me.revealIndex !== null,
      waiting: inHand(m).filter((s) => m.players[s]!.revealIndex === null).length,
    };
  }
  if (me && m.phase === 'discuss') {
    v.discuss = {
      youReady: me.discussReady,
      waiting: inHand(m).filter((s) => !m.players[s]!.discussReady).length,
    };
  }
  if (m.phase === 'showdown') {
    if (me?.liar?.pending) {
      v.liar = { needsYou: true, wildSlots: me.liar.wildSlots, sharedIsLiar: r.shared!.suit === 'liar' };
    } else if (inHand(m).some((s) => m.players[s]!.liar?.pending)) {
      v.liar = { needsYou: false, waitingOnOpponent: true };
    }
    if (r.result) v.result = r.result;
  }
  return v;
}

// ---------------------------------------------------------------------------
// GameDef plugin
// ---------------------------------------------------------------------------

export const winOrDie: GameDef<Match> = {
  id: 'win-or-die',
  name: 'Win or Die',
  blurb: 'Poker-style bluffing with rock-paper-scissors hands. Last player standing.',
  minPlayers: 2,
  maxPlayers: MAX_SEATS,

  create(setup: { seats: number[]; players: PlayerInfo[] }, ctx: GameContext): Match {
    const players: (MP | null)[] = new Array(MAX_SEATS).fill(null);
    for (const pi of setup.players) {
      players[pi.seat] = {
        name: pi.name, connected: true, chips: START_CHIPS, eliminated: false,
        hole: [], folded: false, allIn: false, committed: 0, contributed: 0,
        acted: false, revealIndex: null, discussReady: false, liar: null,
      };
    }
    const m: Match = { players, deck: [], round: null, roundNo: 0, carry: 0, phase: 'bet1', winner: null, log: [] };
    m.deck = shuffle(buildDeck(deckCopies(setup.seats.length)), ctx.rng);
    startRound(m, ctx.rng);
    return m;
  },

  act(m, seat, msg, ctx) {
    switch (msg.type) {
      case 'action':
        return bet(m, seat, String(msg.action ?? ''), Number(msg.amount) || 0);
      case 'reveal':
        return reveal(m, seat, Number(msg.cardIndex));
      case 'discussDone':
        return discussDone(m, seat);
      case 'liar':
        return setLiar(m, seat, msg as { values?: string[] });
      case 'nextRound':
        return nextRound(m, ctx.rng);
    }
  },

  onDisconnect(m, seat) {
    const p = m.players[seat];
    if (p) p.connected = false;
    autoResolveLiar(m, seat);
  },

  onReconnect(m, seat) {
    const p = m.players[seat];
    if (p) p.connected = true;
  },

  view,

  result(m): GameOutcome {
    return { over: m.phase === 'matchover', winners: m.winner !== null ? [m.winner] : [] };
  },

  // A cautious bot: checks/calls modest bets, folds to big ones, reveals a
  // non-liar, readies up, and locks any pending liar to its rank-max suggestion.
  // It never advances the round (a human always remains to click "Next round").
  bot(m, seat, ctx) {
    void ctx;
    if (m.phase === 'matchover') return null;
    const p = m.players[seat];
    const r = m.round;
    if (!p || p.eliminated || !r) return null;
    const inHand = r.participants.includes(seat) && !p.folded;
    switch (m.phase) {
      case 'bet1':
      case 'bet2': {
        if (r.toAct !== seat) return null;
        const toCall = r.currentBet - p.committed;
        if (toCall <= 0) return { type: 'action', action: 'check' };
        if (toCall <= Math.max(2, Math.floor(p.chips * 0.25))) return { type: 'action', action: 'call' };
        return { type: 'action', action: 'fold' };
      }
      case 'reveal': {
        if (!inHand || p.revealIndex !== null) return null;
        const idx = p.hole.findIndex((c) => c.suit !== 'liar');
        return idx >= 0 ? { type: 'reveal', cardIndex: idx } : null;
      }
      case 'discuss':
        return inHand && !p.discussReady ? { type: 'discussDone' } : null;
      case 'showdown':
        return inHand && p.liar?.pending ? { type: 'liar', values: p.liar.suggestion } : null;
      default:
        return null;
    }
  },
};
