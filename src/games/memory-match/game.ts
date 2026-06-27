// games/memory-match/game.ts — "Memory Match", a multilingual concentration game (2–4 players).
//
// Two cards match WORD↔IMAGE of the same concept (not identical pairs). It's a hidden-info
// game — face-down cards' concepts are secret — AND a per-language one: the SAME word card
// renders in each viewer's chosen language (en/fr/ko). So `view` does two things at once:
// redact face-down identities, and localize the visible word cards to the viewer. The board
// layout, face-up state and ownership are identical for everyone; only word TEXT differs.
//
// The concept dataset is INJECTED via createMemoryMatch(bank) — never hardcoded here.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';

export interface MMConcept {
  id: number;
  emoji: string;
  en: string;
  fr: string;
  ko: string;
}
export type Lang = 'en' | 'fr' | 'ko';
const LANGS: Lang[] = ['en', 'fr', 'ko'];
const REVEAL_MS = 1400; // how long a non-matching pair stays up before flipping back

const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);
function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface Card {
  conceptId: number;
  side: 'word' | 'image';
  faceUp: boolean;
  matchedBy: number | null; // player-index who matched it
}
interface MMPlayer {
  name: string;
  connected: boolean;
  lang: Lang;
}
type Phase = 'play' | 'reveal' | 'done';

export interface MMState {
  players: (MMPlayer | null)[]; // by seat
  order: number[];
  np: number;
  cards: Card[]; // index = position = cardId
  scores: number[]; // by player-index
  turn: number;
  flipped: number[]; // cardIds flipped in the current attempt (0 or 1; 2 resolves at once)
  peek: number[]; // the two non-matching cards waiting to flip back
  flipBackAt: number; // timestamp
  pairsTotal: number;
  pairsLeft: number;
  phase: Phase;
  lastResult: 'match' | 'miss' | null;
  over: boolean;
  winners: number[];
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: MMState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: MMState, pid: number) => s.players[s.order[pid]]!.name;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function endGame(s: MMState) {
  s.over = true;
  s.phase = 'done';
  const max = Math.max(...s.scores);
  const top: number[] = [];
  for (let pid = 0; pid < s.np; pid++) if (s.scores[pid] === max) top.push(pid);
  s.winners = top.map((pid) => s.order[pid]);
  const names = top.map((pid) => nameOf(s, pid)).join(', ');
  log(s, `Board cleared. ${top.length > 1 ? `Tie — shared victory: ${names}` : `🏆 ${names} wins`} with ${max} pairs.`);
}

function flipCard(s: MMState, pid: number, cardId: unknown, now: number): ActionResult {
  if (s.phase !== 'play') return fail(s.phase === 'reveal' ? 'Wait for the cards to flip back.' : 'The game is over.');
  if (pid !== s.turn) return fail('Not your turn.');
  const i = Number(cardId);
  const card = s.cards[i];
  if (!card) return fail('Bad card.');
  if (card.faceUp || card.matchedBy !== null) return fail('That card is already face-up.');
  if (s.flipped.includes(i)) return fail('You already flipped that card.');

  card.faceUp = true;
  s.flipped.push(i);
  if (s.flipped.length < 2) return ok; // wait for the second flip

  const [a, b] = s.flipped;
  const ca = s.cards[a];
  const cb = s.cards[b];
  const match = ca.conceptId === cb.conceptId && ca.side !== cb.side;
  s.flipped = [];
  if (match) {
    ca.matchedBy = pid;
    cb.matchedBy = pid;
    s.scores[pid] += 1;
    s.pairsLeft -= 1;
    s.lastResult = 'match';
    log(s, `${nameOf(s, pid)} matched a pair (${s.scores[pid]}) and goes again.`);
    if (s.pairsLeft === 0) endGame(s);
    // otherwise the same player keeps the turn
  } else {
    // no match — hold both up briefly, then a tick flips them back and passes the turn
    s.peek = [a, b];
    s.flipBackAt = now + REVEAL_MS;
    s.phase = 'reveal';
    s.lastResult = 'miss';
    log(s, `${nameOf(s, pid)} missed.`);
  }
  return ok;
}

function tickState(s: MMState, now: number): boolean {
  if (s.phase !== 'reveal' || now < s.flipBackAt) return false;
  for (const i of s.peek) s.cards[i].faceUp = false;
  s.peek = [];
  s.phase = 'play';
  s.turn = (s.turn + 1) % s.np;
  return true;
}

function setLanguage(s: MMState, pid: number, lang: unknown): ActionResult {
  if (typeof lang !== 'string' || !LANGS.includes(lang as Lang)) return fail('Unknown language.');
  s.players[s.order[pid]]!.lang = lang as Lang;
  return ok;
}

// ---------------------------------------------------------------------------
// Per-seat view: hide face-down concepts, localize visible word cards.
// ---------------------------------------------------------------------------

function viewState(byId: Map<number, MMConcept>, s: MMState, seat: number | null): Record<string, unknown> {
  const me = seat !== null && s.players[seat] ? s.players[seat]! : null;
  const myLang: Lang = me?.lang ?? 'en';

  const cards = s.cards.map((c, i) => {
    const revealed = c.faceUp || c.matchedBy !== null || s.over;
    const entry: Record<string, unknown> = {
      cardId: i,
      faceUp: c.faceUp || c.matchedBy !== null,
      matched: c.matchedBy !== null,
      matchedBy: c.matchedBy !== null ? s.order[c.matchedBy] : null,
      peek: s.peek.includes(i),
    };
    // A face-down card reveals NOTHING — not its concept, not even its side (word
    // vs image) — so the backs are indistinguishable and you can wrongly flip two
    // words or two images. Side + identity appear only once it's flipped/matched.
    if (revealed) {
      const concept = byId.get(c.conceptId)!;
      entry.side = c.side;
      entry.conceptId = c.conceptId;
      if (c.side === 'word') entry.text = concept[myLang];
      else entry.emoji = concept.emoji;
    }
    return entry;
  });

  const players = s.order.map((seatNo, pid) => {
    const p = s.players[seatNo]!;
    return { seat: seatNo, name: p.name, connected: p.connected, score: s.scores[pid], lang: p.lang, isTurn: !s.over && pid === s.turn };
  });

  return {
    game: 'memory-match',
    phase: s.over ? 'done' : s.phase,
    over: s.over,
    cards,
    players,
    turn: s.turn,
    activeSeat: s.over ? null : s.order[s.turn],
    flipped: s.flipped,
    pairsLeft: s.pairsLeft,
    pairsTotal: s.pairsTotal,
    lastResult: s.lastResult,
    you: me
      ? { seat, lang: me.lang, isTurn: !s.over && s.order.indexOf(seat!) === s.turn, canFlip: !s.over && s.phase === 'play' && s.order.indexOf(seat!) === s.turn }
      : { seat: seat ?? -1, spectator: true, lang: myLang },
    winners: s.over ? s.winners : null,
    log: s.log.slice(-15),
    matchWinner: null,
  };
}

// ---------------------------------------------------------------------------
// Bot — flips random unseen cards (no memory; a fair fallback for left seats)
// ---------------------------------------------------------------------------

function botMove(s: MMState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.over || s.phase !== 'play') return null;
  const pid = s.order.indexOf(seat);
  if (pid !== s.turn) return null;
  const avail: number[] = [];
  for (let i = 0; i < s.cards.length; i++) if (!s.cards[i].faceUp && s.cards[i].matchedBy === null && !s.flipped.includes(i)) avail.push(i);
  if (!avail.length) return null;
  return { type: 'flipCard', cardId: avail[randInt(rng, avail.length)] };
}

// ---------------------------------------------------------------------------
// GameDef factory — concept dataset injected, never hardcoded.
// ---------------------------------------------------------------------------

export function createMemoryMatch(conceptBank: MMConcept[], config: { pairs?: number } = {}): GameDef<MMState> {
  const bank = conceptBank;
  const byId = new Map(bank.map((c) => [c.id, c]));
  const maxPairs = Math.min(20, bank.length);
  const defaultPairs = Math.min(maxPairs, Math.max(10, config.pairs ?? 12));

  return {
    id: 'memory-match',
    name: 'Memory Match',
    blurb: 'Flip cards to match a word to its picture — in your own language. Most pairs wins.',
    minPlayers: 2,
    maxPlayers: 4,
    options: [{ key: 'pairs', label: 'Pairs', min: 10, max: maxPairs, step: 1, default: defaultPairs }],

    create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): MMState {
      const pairs = Math.min(maxPairs, Math.max(10, Math.round(setup.options?.pairs ?? defaultPairs)));
      const chosen = shuffle([...bank], ctx.rng).slice(0, pairs);
      const cards: Card[] = [];
      for (const c of chosen) {
        cards.push({ conceptId: c.id, side: 'word', faceUp: false, matchedBy: null });
        cards.push({ conceptId: c.id, side: 'image', faceUp: false, matchedBy: null });
      }
      shuffle(cards, ctx.rng);

      const players: (MMPlayer | null)[] = new Array(8).fill(null);
      for (const pi of setup.players) players[pi.seat] = { name: pi.name, connected: true, lang: 'en' };

      const s: MMState = {
        players,
        order: [...setup.seats],
        np: setup.seats.length,
        cards,
        scores: new Array(setup.seats.length).fill(0),
        turn: 0,
        flipped: [],
        peek: [],
        flipBackAt: 0,
        pairsTotal: pairs,
        pairsLeft: pairs,
        phase: 'play',
        lastResult: null,
        over: false,
        winners: [],
        log: [],
      };
      log(s, `${pairs} pairs, ${setup.seats.length} players. ${nameOf(s, 0)} starts — flip two cards.`);
      return s;
    },

    act(s, seat, msg, ctx) {
      const pid = s.order.indexOf(seat);
      if (pid < 0) return fail('You are not in this match.');
      switch (msg.type) {
        case 'flipCard':
          return flipCard(s, pid, msg.cardId, ctx.now);
        case 'setLanguage':
          return setLanguage(s, pid, msg.lang);
      }
    },

    tick(s, ctx) {
      return tickState(s, ctx.now);
    },

    onDisconnect(s, seat) {
      const p = s.players[seat];
      if (p) p.connected = false;
    },
    onReconnect(s, seat) {
      const p = s.players[seat];
      if (p) p.connected = true;
    },

    view(s, seat) {
      return viewState(byId, s, seat);
    },

    result(s): GameOutcome {
      return { over: s.over, winners: s.over ? s.winners : [] };
    },

    bot(s, seat, ctx) {
      return botMove(s, seat, ctx.rng);
    },
  };
}
