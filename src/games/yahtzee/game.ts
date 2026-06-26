// games/yahtzee/game.ts — classic 5-dice Yahtzee as a platform game plugin (1–8 players).
//
// Pure plugin: it owns and mutates a YState but performs no I/O. The server rolls
// every die (randomness via the per-call context), so clients can never fabricate
// results and the state stays plain-JSON serializable.
//
// Each turn a player rolls up to three times (keeping any dice between rolls) then
// commits the dice to exactly one unused category. After 13 rounds every category
// is filled and the highest grand total wins. The fiddly part is the bonus-Yahtzee
// Joker rule (see `score`), which is unit-tested heavily.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';

export const MAX_SEATS = 8;
export const DICE = 5;
export const ROUNDS = 13;

export const UPPER = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'] as const;
export const LOWER = ['threeOfAKind', 'fourOfAKind', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee', 'chance'] as const;
export const CATEGORIES = [...UPPER, ...LOWER] as const;
export type Category = (typeof CATEGORIES)[number];

const LABEL: Record<Category, string> = {
  ones: 'Ones', twos: 'Twos', threes: 'Threes', fours: 'Fours', fives: 'Fives', sixes: 'Sixes',
  threeOfAKind: 'Three of a Kind', fourOfAKind: 'Four of a Kind', fullHouse: 'Full House',
  smallStraight: 'Small Straight', largeStraight: 'Large Straight', yahtzee: 'Yahtzee', chance: 'Chance',
};

const rollDie = (rng: Rng): number => Math.floor(rng() * 6) + 1;
const rollDice = (n: number, rng: Rng): number[] => Array.from({ length: n }, () => rollDie(rng));

interface YPlayer {
  name: string;
  connected: boolean;
  scores: Record<Category, number | null>; // null = category still open
  yahtzeeBonus: number; // count of +100 bonus Yahtzees earned
}

interface Turn {
  seat: number;
  dice: number[]; // 5 dice
  kept: boolean[]; // which dice survive the next reroll
  rollsUsed: number; // 1..3
}

interface FinalScore {
  seat: number;
  upper: number;
  upperBonus: number;
  lower: number;
  bonus: number;
  total: number;
}

export interface YState {
  players: (YPlayer | null)[]; // length MAX_SEATS
  order: number[];
  current: number;
  round: number; // 1..13
  turn: Turn;
  over: boolean;
  winners: number[];
  finals: FinalScore[] | null;
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });

function log(s: YState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: YState, seat: number) => s.players[seat]!.name;
const isCategory = (c: unknown): c is Category => typeof c === 'string' && (CATEGORIES as readonly string[]).includes(c);

// ---------------------------------------------------------------------------
// Pure scoring
// ---------------------------------------------------------------------------

function counts(dice: number[]): number[] {
  const c = [0, 0, 0, 0, 0, 0, 0]; // index 1..6
  for (const d of dice) c[d]++;
  return c;
}
const sum = (dice: number[]): number => dice.reduce((a, b) => a + b, 0);

function hasRun(c: number[], len: number): boolean {
  let run = 0;
  for (let v = 1; v <= 6; v++) {
    run = c[v] > 0 ? run + 1 : 0;
    if (run >= len) return true;
  }
  return false;
}

/** The score a category would take for these dice, ignoring the Joker rule. */
function rawScore(category: Category, dice: number[]): number {
  const c = counts(dice);
  const s = sum(dice);
  switch (category) {
    case 'ones': return 1 * c[1];
    case 'twos': return 2 * c[2];
    case 'threes': return 3 * c[3];
    case 'fours': return 4 * c[4];
    case 'fives': return 5 * c[5];
    case 'sixes': return 6 * c[6];
    case 'threeOfAKind': return c.some((x) => x >= 3) ? s : 0;
    case 'fourOfAKind': return c.some((x) => x >= 4) ? s : 0;
    case 'fullHouse': return c.includes(3) && c.includes(2) ? 25 : 0;
    case 'smallStraight': return hasRun(c, 4) ? 30 : 0;
    case 'largeStraight': return hasRun(c, 5) ? 40 : 0;
    case 'yahtzee': return c.some((x) => x === 5) ? 50 : 0;
    case 'chance': return s;
  }
}

interface Preview {
  value: number;
  allowed: boolean;
}

/** Per-open-category {value, allowed} for these dice, applying the Joker rule. */
export function previews(p: YPlayer, dice: number[]): Record<string, Preview> {
  const c = counts(dice);
  const isFive = c.some((x) => x === 5);
  const face = isFive ? dice[0] : 0;
  const yahtzeeFilled = p.scores.yahtzee !== null;
  const joker = isFive && yahtzeeFilled; // bonus-Yahtzee regime: forced placement
  const U: Category | null = isFive ? UPPER[face - 1] : null;
  const uOpen = U !== null && p.scores[U] === null;
  const lowerOpen = (LOWER as readonly Category[]).some((cat) => p.scores[cat] === null);

  const out: Record<string, Preview> = {};
  for (const cat of CATEGORIES) {
    if (p.scores[cat] !== null) continue; // already filled
    let value = rawScore(cat, dice);
    let allowed = true;
    if (joker) {
      if (uOpen) {
        allowed = cat === U; // must score the matching upper box
      } else if (lowerOpen) {
        allowed = (LOWER as readonly Category[]).includes(cat); // Joker: any open lower box
        if (allowed) {
          if (cat === 'fullHouse') value = 25;
          else if (cat === 'smallStraight') value = 30;
          else if (cat === 'largeStraight') value = 40;
        }
      } else {
        allowed = (UPPER as readonly Category[]).includes(cat); // forced 0 into an open upper box
      }
    }
    out[cat] = { value, allowed };
  }
  return out;
}

function totals(p: YPlayer): { upper: number; upperBonus: number; lower: number; bonus: number; grand: number } {
  const upper = UPPER.reduce((a, c) => a + (p.scores[c] ?? 0), 0);
  const upperBonus = upper >= 63 ? 35 : 0;
  const lower = LOWER.reduce((a, c) => a + (p.scores[c] ?? 0), 0);
  const bonus = 100 * p.yahtzeeBonus;
  return { upper, upperBonus, lower, bonus, grand: upper + upperBonus + lower + bonus };
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

function startTurn(s: YState, idx: number, rng: Rng) {
  const seat = s.order[idx];
  s.turn = { seat, dice: rollDice(DICE, rng), kept: [false, false, false, false, false], rollsUsed: 1 };
  log(s, `${nameOf(s, seat)}'s turn — round ${s.round}/${ROUNDS}.`);
}

function advance(s: YState, rng: Rng) {
  s.current += 1;
  if (s.current >= s.order.length) {
    s.current = 0;
    s.round += 1;
  }
  if (s.round > ROUNDS) {
    endGame(s);
    return;
  }
  startTurn(s, s.current, rng);
}

function endGame(s: YState) {
  const finals: FinalScore[] = s.order.map((seat) => {
    const p = s.players[seat]!;
    const tt = totals(p);
    return { seat, upper: tt.upper, upperBonus: tt.upperBonus, lower: tt.lower, bonus: tt.bonus, total: tt.grand };
  });
  const max = Math.max(...finals.map((f) => f.total));
  s.winners = finals.filter((f) => f.total === max).map((f) => f.seat); // ties share
  finals.sort((a, b) => b.total - a.total);
  s.finals = finals;
  s.over = true;
  const names = s.winners.map((seat) => nameOf(s, seat)).join(', ');
  log(s, `Game over. ${s.winners.length > 1 ? `Shared victory: ${names}` : `🏆 ${names} wins`} (${max}).`);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function hold(s: YState, seat: number, index: number): ActionResult {
  const t = s.turn;
  if (seat !== t.seat) return fail('Not your turn.');
  if (t.rollsUsed >= 3) return fail('No rerolls left.');
  if (!Number.isInteger(index) || index < 0 || index >= DICE) return fail('Bad die.');
  t.kept[index] = !t.kept[index];
  return ok;
}

function roll(s: YState, seat: number, keep: unknown, rng: Rng): ActionResult {
  const t = s.turn;
  if (seat !== t.seat) return fail('Not your turn.');
  if (t.rollsUsed >= 3) return fail('No rolls left — choose a category.');
  // Optional explicit keep-mask (indices to keep); else use the held state.
  if (Array.isArray(keep)) {
    t.kept = [0, 1, 2, 3, 4].map((i) => keep.includes(i));
  }
  for (let i = 0; i < DICE; i++) if (!t.kept[i]) t.dice[i] = rollDie(rng);
  t.rollsUsed += 1;
  log(s, `${nameOf(s, seat)} rolls (#${t.rollsUsed}): ${t.dice.join(' ')}.`);
  return ok;
}

function score(s: YState, seat: number, category: unknown, rng: Rng): ActionResult {
  const t = s.turn;
  if (seat !== t.seat) return fail('Not your turn.');
  if (!isCategory(category)) return fail('Unknown category.');
  const p = s.players[seat]!;
  if (p.scores[category] !== null) return fail('That category is already filled.');

  const dice = t.dice;
  const c = counts(dice);
  const isFive = c.some((x) => x === 5);
  const face = isFive ? dice[0] : 0;
  const yahtzeeFilled = p.scores.yahtzee !== null;
  const joker = isFive && yahtzeeFilled;

  // Validate forced placement when a five-of-a-kind is rolled with Yahtzee filled.
  let jokerLower = false;
  if (joker) {
    const U = UPPER[face - 1];
    if (p.scores[U] === null) {
      if (category !== U) return fail(`Five ${face}s: you must score in ${LABEL[U]}.`);
    } else {
      const lowerOpen = (LOWER as readonly Category[]).some((cat) => p.scores[cat] === null);
      if (lowerOpen) {
        if (!(LOWER as readonly Category[]).includes(category)) return fail('Joker: choose an open lower box.');
        jokerLower = true;
      } else if (!(UPPER as readonly Category[]).includes(category)) {
        return fail('Score 0 in an open upper box.');
      }
    }
  }

  // Value (the Joker lets full house / straights count at full value).
  let value = rawScore(category, dice);
  if (jokerLower) {
    if (category === 'fullHouse') value = 25;
    else if (category === 'smallStraight') value = 30;
    else if (category === 'largeStraight') value = 40;
  }

  // Apply: a bonus only when the prior Yahtzee was itself a 50, then write the score.
  if (joker && p.scores.yahtzee === 50) {
    p.yahtzeeBonus += 1;
    log(s, `${p.name} rolls another Yahtzee — +100 bonus!`);
  }
  p.scores[category] = value;
  log(s, `${p.name} scores ${value} in ${LABEL[category]}.`);
  advance(s, rng);
  return ok;
}

// ---------------------------------------------------------------------------
// Per-seat view
// ---------------------------------------------------------------------------

function view(s: YState, seat: number | null): Record<string, unknown> {
  const t = s.turn;
  const me = seat !== null && s.players[seat] ? s.players[seat]! : null;
  const yourTurn = me !== null && seat === t.seat && !s.over;

  const players = s.order.map((seatNo) => {
    const p = s.players[seatNo]!;
    const tt = totals(p);
    return {
      seat: seatNo, name: p.name, connected: p.connected,
      scores: p.scores, yahtzeeBonus: p.yahtzeeBonus,
      upper: tt.upper, upperBonus: tt.upperBonus, lower: tt.lower, grand: tt.grand,
      isTurn: !s.over && seatNo === t.seat,
    };
  });

  const v: Record<string, unknown> = {
    game: 'yahtzee',
    phase: s.over ? 'over' : 'playing',
    round: s.round,
    rounds: ROUNDS,
    over: s.over,
    winners: s.winners,
    finals: s.finals,
    players,
    you: me ? { seat, name: me.name, connected: me.connected } : { seat: seat ?? -1, name: '' },
    log: s.log.slice(-15),
    matchWinner: null,
  };

  const turn: Record<string, unknown> = {
    seat: t.seat,
    name: nameOf(s, t.seat),
    yourTurn,
    dice: t.dice,
    kept: t.kept,
    rollsUsed: t.rollsUsed,
    rollsLeft: 3 - t.rollsUsed,
    canRoll: yourTurn && t.rollsUsed < 3,
    canScore: yourTurn,
  };
  if (yourTurn && me) {
    turn.previews = previews(me, t.dice);
    turn.bonusReady = counts(t.dice).some((x) => x === 5) && me.scores.yahtzee === 50;
  }
  v.turn = turn;
  return v;
}

// ---------------------------------------------------------------------------
// GameDef plugin
// ---------------------------------------------------------------------------

function emptyScores(): Record<Category, number | null> {
  const out = {} as Record<Category, number | null>;
  for (const c of CATEGORIES) out[c] = null;
  return out;
}

// Tie-break order for the bot when several categories score equally (e.g. all 0):
// dump into the cheapest box first (low upper, then chance), keep premium boxes.
const DUMP_ORDER: Category[] = ['ones', 'twos', 'threes', 'threeOfAKind', 'fours', 'fourOfAKind', 'fives', 'sixes', 'chance', 'fullHouse', 'smallStraight', 'largeStraight', 'yahtzee'];

export const yahtzee: GameDef<YState> = {
  id: 'yahtzee',
  name: 'Yahtzee',
  blurb: 'Roll five dice up to three times and fill all 13 scorecard categories. Highest total wins.',
  minPlayers: 1,
  maxPlayers: MAX_SEATS,

  create(setup: { seats: number[]; players: PlayerInfo[] }, ctx: GameContext): YState {
    const players: (YPlayer | null)[] = new Array(MAX_SEATS).fill(null);
    for (const pi of setup.players) {
      players[pi.seat] = { name: pi.name, connected: true, scores: emptyScores(), yahtzeeBonus: 0 };
    }
    const order = [...setup.seats];
    const s: YState = {
      players, order, current: 0, round: 1,
      turn: { seat: order[0], dice: [], kept: [false, false, false, false, false], rollsUsed: 1 },
      over: false, winners: [], finals: null, log: [],
    };
    startTurn(s, 0, ctx.rng);
    return s;
  },

  act(s, seat, msg, ctx) {
    if (s.over) return fail('The game is over.');
    switch (msg.type) {
      case 'hold':
        return hold(s, seat, Number(msg.index));
      case 'roll':
        return roll(s, seat, msg.keep, ctx.rng);
      case 'score':
        return score(s, seat, msg.category, ctx.rng);
    }
  },

  onDisconnect(s, seat) {
    const p = s.players[seat];
    if (p) p.connected = false;
  },
  onReconnect(s, seat) {
    const p = s.players[seat];
    if (p) p.connected = true;
  },

  view,

  result(s): GameOutcome {
    return { over: s.over, winners: s.winners };
  },

  bot(s, seat) {
    if (s.over) return null;
    const t = s.turn;
    if (t.seat !== seat) return null;
    const p = s.players[seat]!;

    // Reroll twice, keeping the most common face (prefer the higher value on ties).
    if (t.rollsUsed < 3) {
      const c = counts(t.dice);
      let modal = 1;
      for (let v = 2; v <= 6; v++) if (c[v] >= c[modal]) modal = v;
      if (c[modal] < 5) {
        const keep: number[] = [];
        t.dice.forEach((d, i) => d === modal && keep.push(i));
        return { type: 'roll', keep };
      }
      // already five-of-a-kind — fall through and score it
    }

    // Score the best available (highest value); break ties by the dump order.
    const pv = previews(p, t.dice);
    let best: Category | null = null;
    let bestVal = -1;
    for (const cat of CATEGORIES) {
      const e = pv[cat];
      if (!e || !e.allowed) continue;
      if (e.value > bestVal) ((bestVal = e.value), (best = cat));
    }
    if (bestVal <= 0) {
      best = DUMP_ORDER.find((cat) => pv[cat]?.allowed) ?? CATEGORIES.find((cat) => p.scores[cat] === null) ?? null;
    }
    return best ? { type: 'score', category: best } : null;
  },
};
