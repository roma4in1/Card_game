// games/three-fronts/game.ts — "Three Fronts", a two-player card duel over three battle
// lines (an Air, Land & Sea style theatre game).
//
// Eighteen cards: three theatres × ranks 1–6. Each battle deals six to each player and
// leaves six out, so nobody ever knows the full picture. On your turn you either commit a
// card or walk away:
//
//   • FACE-UP — only to its own theatre. It fights at its printed rank AND triggers that
//     theatre's standing bonus, which lasts the rest of the battle.
//   • FACE-DOWN — to any front. It fights at a flat 2 and its identity stays yours alone
//     until the battle ends. This is the bluff: a hidden 6 and a hidden 1 look the same.
//   • WITHDRAW — concede the battle now and pay less than you would by losing it outright.
//
// The withdraw payout is what makes the whole thing a game rather than an arithmetic
// exercise: fighting a battle out is worth 6 to the winner, but conceding early costs you
// only 2. Knowing when a battle is lost is worth as much as winning one.
//
// `view` hides exactly one thing: the rank and theatre of an opponent's face-down card.
// Everything else — hand sizes, every face-up card, every bonus in force — is on the table.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { initSkill, SKILL_OPTION, CASUAL, STEADY } from '../../platform/skill.ts';

/** Front 0/1/2 doubles as a card's theatre. */
export const FRONTS = [
  { key: 'air', name: 'Air', icon: '✈', bonus: 'Recon', blurb: 'your face-down cards here count 3, not 2' },
  { key: 'land', name: 'Land', icon: '⛰', bonus: 'Entrench', blurb: '+1 for every card you hold here' },
  { key: 'sea', name: 'Sea', icon: '⚓', bonus: 'Blockade', blurb: 'they can play no more face-down cards here' },
];
const RANKS = 6;
const TARGET = 12; // match points needed to win the war
const FOUGHT_OUT = 6; // what a battle played to the end is worth
const RESULT_MS = 4000; // how long the finished battle stays up before the next deal

const cardTheatre = (id: number) => Math.floor(id / RANKS);
const cardRank = (id: number) => (id % RANKS) + 1;
const cardName = (id: number) => `${FRONTS[cardTheatre(id)].name} ${cardRank(id)}`;

function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface Play {
  pid: number;
  cardId: number;
  faceDown: boolean;
}
interface TFPlayer {
  name: string;
  connected: boolean;
}
/** The battle just finished, kept on screen while both players read it. */
interface BattleResult {
  fronts: Play[][]; // fully revealed
  strength: number[][]; // [front][pid]
  control: (number | null)[]; // player-index controlling each front
  winner: number | null; // player-index, or null for a drawn battle
  points: number;
  withdrew: number | null;
}

export interface TFState {
  players: (TFPlayer | null)[]; // by seat (length 8)
  order: number[]; // seat per player-index
  np: number;
  scores: number[]; // match points, by player-index
  target: number;
  battleNo: number;
  hands: number[][]; // card ids, by player-index
  fronts: Play[][]; // [3] — plays in the order they were made
  recon: boolean[][]; // [pid][front] — face-down cards count 3
  entrench: boolean[][]; // [pid][front] — +1 per card held
  blocked: boolean[][]; // [pid][front] — pid may play no face-down cards here
  turn: number; // player-index
  lead: number; // who opens the current battle
  result: BattleResult | null;
  nextAt: number;
  phase: 'battle' | 'result' | 'done';
  skill: number; // how hard the bots play (1 casual … 3 sharp)
  over: boolean;
  winners: number[]; // seats
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: TFState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: TFState, pid: number) => s.players[s.order[pid]]!.name;

// ---------------------------------------------------------------------------
// Strength & control
// ---------------------------------------------------------------------------

/** The parts of a position the scoring rules actually read. `TFState` satisfies it, and
 *  so does the sampled board the bot reasons over — one implementation, both callers. */
interface Board {
  fronts: Play[][];
  recon: boolean[][];
  entrench: boolean[][];
}

/** What `pid` musters at `front`: face-up cards at rank, face-down at 2 (3 under Recon),
 *  plus one extra per card if they are Entrenched there. */
export function frontStrength(s: Board, front: number, pid: number): number {
  let total = 0;
  let count = 0;
  for (const p of s.fronts[front]) {
    if (p.pid !== pid) continue;
    count += 1;
    total += p.faceDown ? (s.recon[pid][front] ? 3 : 2) : cardRank(p.cardId);
  }
  if (s.entrench[pid][front]) total += count;
  return total;
}

/** Who holds each front — a tie is held by neither. */
function control(s: Board): (number | null)[] {
  return FRONTS.map((_, f) => {
    const a = frontStrength(s, f, 0);
    const b = frontStrength(s, f, 1);
    return a === b ? null : a > b ? 0 : 1;
  });
}

const heldBy = (ctl: (number | null)[], pid: number) => ctl.filter((c) => c === pid).length;
const totalStrength = (s: Board, pid: number) => FRONTS.reduce((acc, _, f) => acc + frontStrength(s, f, pid), 0);

/** Conceding early is cheap; conceding with nothing left costs nearly a full defeat. */
function withdrawValue(cardsLeft: number): number {
  if (cardsLeft >= 4) return 2;
  if (cardsLeft >= 2) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Battles
// ---------------------------------------------------------------------------

function startBattle(s: TFState, rng: Rng) {
  const deck = shuffle(Array.from({ length: FRONTS.length * RANKS }, (_, i) => i), rng);
  s.hands = [deck.slice(0, 6), deck.slice(6, 12)]; // six cards each; six sit out, unseen
  s.fronts = FRONTS.map(() => []);
  s.recon = [FRONTS.map(() => false), FRONTS.map(() => false)];
  s.entrench = [FRONTS.map(() => false), FRONTS.map(() => false)];
  s.blocked = [FRONTS.map(() => false), FRONTS.map(() => false)];
  s.turn = s.lead;
  s.result = null;
  s.phase = 'battle';
  s.battleNo += 1;
  log(s, `Battle ${s.battleNo}: six cards each, ${nameOf(s, s.lead)} opens.`);
}

function endBattle(s: TFState, withdrew: number | null, now: number) {
  const ctl = control(s);
  const strength = FRONTS.map((_, f) => [frontStrength(s, f, 0), frontStrength(s, f, 1)]);

  let winner: number | null;
  let points: number;
  if (withdrew !== null) {
    winner = 1 - withdrew;
    points = withdrawValue(s.hands[withdrew].length);
    log(s, `${nameOf(s, withdrew)} withdraws with ${s.hands[withdrew].length} in hand — ${nameOf(s, winner)} takes ${points}.`);
  } else {
    const held = [heldBy(ctl, 0), heldBy(ctl, 1)];
    if (held[0] !== held[1]) winner = held[0] > held[1] ? 0 : 1;
    else {
      const tot = [totalStrength(s, 0), totalStrength(s, 1)];
      winner = tot[0] === tot[1] ? null : tot[0] > tot[1] ? 0 : 1;
    }
    points = winner === null ? 0 : FOUGHT_OUT;
    log(s, winner === null
      ? `Battle ${s.battleNo} is a stalemate — no points.`
      : `${nameOf(s, winner)} wins battle ${s.battleNo} ${held[winner]}–${held[1 - winner]} on fronts, taking ${points}.`);
  }
  if (winner !== null) s.scores[winner] += points;

  s.result = { fronts: s.fronts.map((f) => f.map((p) => ({ ...p }))), strength, control: ctl, winner, points, withdrew };
  // The loser opens the next battle; after a stalemate the lead simply changes hands.
  s.lead = winner === null ? 1 - s.lead : 1 - winner;

  const leader = s.scores.findIndex((sc) => sc >= s.target);
  if (leader >= 0) {
    s.over = true;
    s.phase = 'done';
    s.winners = [s.order[leader]];
    log(s, `🏆 ${nameOf(s, leader)} wins the war ${s.scores[leader]}–${s.scores[1 - leader]}.`);
    return;
  }
  s.phase = 'result';
  s.nextAt = now + RESULT_MS;
}

function tickState(s: TFState, now: number, rng: Rng): boolean {
  if (s.phase !== 'result' || now < s.nextAt) return false;
  startBattle(s, rng);
  return true;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function deploy(s: TFState, pid: number, cardIdRaw: unknown, frontRaw: unknown, faceDownRaw: unknown, now: number): ActionResult {
  if (s.phase === 'done') return fail('The war is over.');
  if (s.phase === 'result') return fail('Wait for the next battle.');
  if (pid !== s.turn) return fail('Not your turn.');
  const cardId = Number(cardIdRaw);
  const front = Number(frontRaw);
  const faceDown = faceDownRaw === true;
  if (!Number.isInteger(cardId) || !s.hands[pid].includes(cardId)) return fail('That card is not in your hand.');
  if (!Number.isInteger(front) || front < 0 || front >= FRONTS.length) return fail('No such front.');
  if (!faceDown && cardTheatre(cardId) !== front) return fail(`A face-up card must go to its own theatre — ${cardName(cardId)} belongs at ${FRONTS[cardTheatre(cardId)].name}.`);
  if (faceDown && s.blocked[pid][front]) return fail(`${FRONTS[front].name} is blockaded — no more face-down cards there.`);

  s.hands[pid] = s.hands[pid].filter((c) => c !== cardId);
  s.fronts[front].push({ pid, cardId, faceDown });

  if (faceDown) {
    // The log is public, so it must not name the card.
    log(s, `${nameOf(s, pid)} commits a card face-down to ${FRONTS[front].name}.`);
  } else {
    const f = FRONTS[front];
    if (front === 0) s.recon[pid][front] = true;
    else if (front === 1) s.entrench[pid][front] = true;
    else s.blocked[1 - pid][front] = true;
    log(s, `${nameOf(s, pid)} plays ${cardName(cardId)} face-up — ${f.bonus} at ${f.name}.`);
  }

  if (s.hands.every((h) => h.length === 0)) {
    endBattle(s, null, now);
    return ok;
  }
  // A player with no cards left is simply skipped; the other plays their remainder out.
  const foe = 1 - pid;
  s.turn = s.hands[foe].length ? foe : pid;
  return ok;
}

function withdraw(s: TFState, pid: number, now: number): ActionResult {
  if (s.phase === 'done') return fail('The war is over.');
  if (s.phase === 'result') return fail('Wait for the next battle.');
  if (pid !== s.turn) return fail('Not your turn.');
  endBattle(s, pid, now);
  return ok;
}

// ---------------------------------------------------------------------------
// View — an opponent's face-down card keeps its secret
// ---------------------------------------------------------------------------

function viewState(s: TFState, seat: number | null): Record<string, unknown> {
  const myPid = seat !== null ? s.order.indexOf(seat) : -1;
  const revealAll = s.phase !== 'battle'; // the battle is over: every card turns over

  const showPlay = (p: Play) => {
    const mine = p.pid === myPid;
    const open = !p.faceDown || mine || revealAll;
    return {
      seat: s.order[p.pid],
      faceDown: p.faceDown,
      // A hidden card is sent as `null`, not as a redacted object — there is nothing to leak.
      cardId: open ? p.cardId : null,
      theatre: open ? cardTheatre(p.cardId) : null,
      rank: open ? cardRank(p.cardId) : null,
      label: open ? cardName(p.cardId) : null,
      mine,
    };
  };

  const board = FRONTS.map((f, i) => ({
    key: f.key,
    name: f.name,
    icon: f.icon,
    bonus: f.bonus,
    blurb: f.blurb,
    plays: s.fronts[i].map(showPlay),
    strength: [frontStrength(s, i, 0), frontStrength(s, i, 1)],
    control: (() => {
      const a = frontStrength(s, i, 0);
      const b = frontStrength(s, i, 1);
      return a === b ? null : s.order[a > b ? 0 : 1];
    })(),
    // whose bonuses are standing here, as seats
    recon: s.recon.map((r, pid) => (r[i] ? s.order[pid] : null)).filter((x) => x !== null),
    entrench: s.entrench.map((r, pid) => (r[i] ? s.order[pid] : null)).filter((x) => x !== null),
    blocked: s.blocked.map((r, pid) => (r[i] ? s.order[pid] : null)).filter((x) => x !== null),
  }));

  const ctl = control(s);
  const players = Array.from({ length: s.np }, (_, pid) => ({
    seat: s.order[pid],
    name: nameOf(s, pid),
    connected: s.players[s.order[pid]]!.connected,
    score: s.scores[pid],
    cardsLeft: s.hands[pid].length, // public: you can count what they've played
    fronts: heldBy(ctl, pid),
    isTurn: s.phase === 'battle' && pid === s.turn,
  }));

  return {
    game: 'three-fronts',
    phase: s.phase,
    over: s.over,
    target: s.target,
    battleNo: s.battleNo,
    board,
    players,
    activeSeat: s.phase === 'battle' && !s.over ? s.order[s.turn] : null,
    result: s.result
      ? {
          winnerSeat: s.result.winner === null ? null : s.order[s.result.winner],
          points: s.result.points,
          withdrewSeat: s.result.withdrew === null ? null : s.order[s.result.withdrew],
          control: s.result.control.map((c) => (c === null ? null : s.order[c])),
        }
      : null,
    you:
      myPid >= 0
        ? {
            seat,
            pid: myPid,
            hand: s.hands[myPid].map((id) => ({ cardId: id, theatre: cardTheatre(id), rank: cardRank(id), label: cardName(id) })),
            isTurn: s.phase === 'battle' && myPid === s.turn,
            // a front you may not sneak a face-down card into
            blocked: s.blocked[myPid],
            canAct: s.phase === 'battle' && myPid === s.turn && !s.over,
          }
        : { seat: seat ?? -1, spectator: true, hand: [], blocked: FRONTS.map(() => false) },
    winners: s.over ? s.winners : null,
    log: s.log.slice(-15),
    matchWinner: null,
  };
}

// ---------------------------------------------------------------------------
// Bot — samples the hands it cannot see, then plays each battle out.
//
// The old bot looked one card ahead: it played whatever left the board looking best right
// now. That loses to anyone who sets a trap, because a card that wins a front today is
// often the card you needed tomorrow, and it never valued a face-down bluff properly.
//
// This one plays imperfect information the way it should be played. It knows its own
// hand, every face-up card, and its own buried cards; everything else — the six cards
// that sat out, the opponent's hand, and what they have buried — is a single unknown pool.
// So it DEALS that pool at random a number of times, and for each deal plays the battle
// out to the end with both sides grabbing greedily. A move's worth is its average result
// over those deals, which is what makes it treat a buried 2 and a buried 6 as the same
// threat until it has reason not to.
//
// Withdrawing is scored on the same scale — its cost is known exactly — so the bot walks
// away precisely when fighting on is worth less than the concession.
// ---------------------------------------------------------------------------

const SAMPLES = 14; // deals per decision — enough to rank moves, cheap enough to be instant

/** The mutable part of a position a rollout needs. */
interface Sim extends Board {
  blocked: boolean[][];
  hands: number[][];
}

const cloneSim = (s: TFState | Sim): Sim => ({
  fronts: s.fronts.map((f) => f.map((p) => ({ ...p }))),
  recon: s.recon.map((r) => [...r]),
  entrench: s.entrench.map((r) => [...r]),
  blocked: s.blocked.map((r) => [...r]),
  hands: s.hands.map((h) => [...h]),
});

/** Apply a deployment to a sampled board, bonuses and all. */
function simDeploy(sim: Sim, pid: number, cardId: number, front: number, faceDown: boolean) {
  sim.hands[pid] = sim.hands[pid].filter((c) => c !== cardId);
  sim.fronts[front].push({ pid, cardId, faceDown });
  if (faceDown) return;
  if (front === 0) sim.recon[pid][front] = true;
  else if (front === 1) sim.entrench[pid][front] = true;
  else sim.blocked[1 - pid][front] = true;
}

function simMoves(sim: Sim, pid: number): { cardId: number; front: number; faceDown: boolean }[] {
  const out: { cardId: number; front: number; faceDown: boolean }[] = [];
  for (const cardId of sim.hands[pid]) {
    for (let front = 0; front < FRONTS.length; front++) {
      if (cardTheatre(cardId) === front) out.push({ cardId, front, faceDown: false });
      if (!sim.blocked[pid][front]) out.push({ cardId, front, faceDown: true });
    }
  }
  return out;
}

/** Score a position from `pid`'s side: fronts held first, raw strength as the tiebreak. */
function evaluate(b: Board, pid: number): number {
  const ctl = control(b);
  return (heldBy(ctl, pid) - heldBy(ctl, 1 - pid)) * 100 + (totalStrength(b, pid) - totalStrength(b, 1 - pid));
}

/** Play the battle out, both sides grabbing the best immediate position, and report the
 *  points it would pay the bot. Nobody withdraws inside a rollout — the real decision to
 *  withdraw is taken at the root, where the cost is known exactly. */
function rollout(sim: Sim, toMove: number, me: number, rng: Rng): number {
  let turn = toMove;
  for (let guard = 0; guard < 16; guard++) {
    if (!sim.hands[0].length && !sim.hands[1].length) break;
    if (!sim.hands[turn].length) turn = 1 - turn;
    const moves = simMoves(sim, turn);
    if (!moves.length) break;
    let best = moves[0];
    let bestScore = -Infinity;
    for (const m of moves) {
      const probe = cloneSim(sim);
      simDeploy(probe, turn, m.cardId, m.front, m.faceDown);
      const score = evaluate(probe, turn) + rng();
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    simDeploy(sim, turn, best.cardId, best.front, best.faceDown);
    turn = 1 - turn;
  }
  const ctl = control(sim);
  const held = [heldBy(ctl, 0), heldBy(ctl, 1)];
  let winner: number | null;
  if (held[0] !== held[1]) winner = held[0] > held[1] ? 0 : 1;
  else {
    const tot = [totalStrength(sim, 0), totalStrength(sim, 1)];
    winner = tot[0] === tot[1] ? null : tot[0] > tot[1] ? 0 : 1;
  }
  if (winner === null) return 0;
  return winner === me ? FOUGHT_OUT : -FOUGHT_OUT;
}

/** Deal the unknown pool: the opponent's buried cards and their hand. Everything the bot
 *  is entitled to know stays fixed; only what it cannot see is invented. */
function sampleBoard(s: TFState, me: number, rng: Rng): Sim {
  const foe = 1 - me;
  const known = new Set<number>(s.hands[me]);
  const hiddenSlots: { front: number; at: number }[] = [];
  s.fronts.forEach((plays, front) => {
    plays.forEach((p, at) => {
      if (!p.faceDown || p.pid === me) known.add(p.cardId);
      else hiddenSlots.push({ front, at });
    });
  });
  const pool = shuffle(Array.from({ length: FRONTS.length * RANKS }, (_, i) => i).filter((c) => !known.has(c)), rng);
  const sim = cloneSim(s);
  hiddenSlots.forEach((slot, i) => { sim.fronts[slot.front][slot.at].cardId = pool[i]; });
  sim.hands[foe] = pool.slice(hiddenSlots.length, hiddenSlots.length + s.hands[foe].length);
  return sim;
}

function botMove(s: TFState, seat: number, rng: Rng): Record<string, unknown> | null {
  if (s.phase !== 'battle' || s.over) return null;
  const pid = s.order.indexOf(seat);
  if (pid < 0 || pid !== s.turn || !s.hands[pid].length) return null;

  const candidates = simMoves(cloneSim(s), pid);
  if (!candidates.length) return null;

  // Casual: commits a card at random. It will bluff by accident and never on purpose.
  if (s.skill <= CASUAL) {
    const m = candidates[Math.floor(rng() * candidates.length)];
    return { type: 'deploy', cardId: m.cardId, front: m.front, faceDown: m.faceDown };
  }
  // Steady: takes the best board it can reach this move, and concedes on the same rule.
  // No sampling, so a face-down card is worth a flat 2 to it whatever is really under it.
  if (s.skill <= STEADY) {
    let pick = candidates[0];
    let bestNow = -Infinity;
    for (const m of candidates) {
      const probe = cloneSim(s);
      simDeploy(probe, pid, m.cardId, m.front, m.faceDown);
      const v = evaluate(probe, pid) + rng();
      if (v > bestNow) {
        bestNow = v;
        pick = m;
      }
    }
    const ctl = control(s);
    if (heldBy(ctl, 1 - pid) >= 2 && bestNow < 0 && withdrawValue(s.hands[pid].length) <= 2) return { type: 'withdraw' };
    return { type: 'deploy', cardId: pick.cardId, front: pick.front, faceDown: pick.faceDown };
  }
  const boards = Array.from({ length: SAMPLES }, () => sampleBoard(s, pid, rng));

  let best = candidates[0];
  let bestValue = -Infinity;
  for (const m of candidates) {
    let total = 0;
    for (const board of boards) {
      const probe = cloneSim(board);
      simDeploy(probe, pid, m.cardId, m.front, m.faceDown);
      total += rollout(probe, 1 - pid, pid, rng);
    }
    const value = total / boards.length + rng() * 0.01;
    if (value > bestValue) {
      bestValue = value;
      best = m;
    }
  }

  // Conceding is worth exactly minus its price. Fight on only if that beats it.
  const concede = -withdrawValue(s.hands[pid].length);
  if (concede > bestValue) return { type: 'withdraw' };
  return { type: 'deploy', cardId: best.cardId, front: best.front, faceDown: best.faceDown };
}

// ---------------------------------------------------------------------------
// GameDef
// ---------------------------------------------------------------------------

export const threeFronts: GameDef<TFState> = {
  id: 'three-fronts',
  name: 'Three Fronts',
  blurb: 'A card duel over air, land and sea — play face-up for power, face-down to bluff, or withdraw and pay less.',
  minPlayers: 2,
  maxPlayers: 2,
  options: [SKILL_OPTION],

  validateStart(seats) {
    return seats.length === 2 ? null : 'Three Fronts is a two-player duel.';
  },

  create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): TFState {
    const players: (TFPlayer | null)[] = new Array(8).fill(null);
    for (const pi of setup.players) players[pi.seat] = { name: pi.name, connected: true };
    const s: TFState = {
      players,
      order: [...setup.seats],
      np: setup.seats.length,
      scores: new Array(setup.seats.length).fill(0),
      target: TARGET,
      battleNo: 0,
      hands: [[], []],
      fronts: FRONTS.map(() => []),
      recon: [FRONTS.map(() => false), FRONTS.map(() => false)],
      entrench: [FRONTS.map(() => false), FRONTS.map(() => false)],
      blocked: [FRONTS.map(() => false), FRONTS.map(() => false)],
      turn: 0,
      lead: 0,
      result: null,
      nextAt: 0,
      phase: 'battle',
      skill: initSkill(setup.options?.skill),
      over: false,
      winners: [],
      log: [],
    };
    log(s, `First to ${TARGET} points wins the war.`);
    startBattle(s, ctx.rng);
    return s;
  },

  act(s, seat, msg, ctx) {
    const pid = s.order.indexOf(seat);
    if (pid < 0) return fail('You are not in this match.');
    switch (msg.type) {
      case 'deploy':
        return deploy(s, pid, msg.cardId, msg.front, msg.faceDown, ctx.now);
      case 'withdraw':
        return withdraw(s, pid, ctx.now);
    }
  },

  tick(s, ctx) {
    return tickState(s, ctx.now, ctx.rng);
  },

  onDisconnect(s, seat) {
    const p = s.players[seat];
    if (p) p.connected = false;
  },
  onReconnect(s, seat) {
    const p = s.players[seat];
    if (p) p.connected = true;
  },

  view: viewState,

  result(s): GameOutcome {
    return { over: s.over, winners: s.over ? s.winners : [] };
  },

  bot(s, seat, ctx) {
    return botMove(s, seat, ctx.rng);
  },
};
