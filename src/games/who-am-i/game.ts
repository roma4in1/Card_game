// games/who-am-i/game.ts — "Who Am I?", a football 20-questions deduction game (2–6 players).
//
// One secret footballer per round, drawn from the INJECTED bank (players.json). On your
// turn you either ASK a structured yes/no question — which the SERVER answers
// deterministically from the target's data — or GUESS a name. Every Q&A is public, so a
// useful question helps your rivals too. A wrong guess knocks you out for the round; the
// first correct guess wins it. Best-of-N rounds; fewest questions breaks a tie.
//
// This is a HIDDEN-INFO game: nobody (not even a "host") knows the target — the data is
// the oracle. `view` never reveals the target (or any unasked attribute) until a round ends.

import type { GameContext, GameDef, GameOutcome, PlayerInfo, Rng } from '../../platform/types.ts';
import { initTimer, runTimer, timerView, TIMER_OPTION, type Timer } from '../../platform/turn-timer.ts';

const MAX_SEATS = 8;

export interface PlayerCard {
  name: string;
  nationality: string;
  positions: string[];
  leagues: string[];
  marketValue: number | null;
  status: 'active' | 'retired';
  eraOfPlay: string;
}

// nationality → continent (covers every nation in the bank; UEFA nations count as Europe).
const CONTINENT: Record<string, string> = {
  Algeria: 'Africa', 'Burkina Faso': 'Africa', Cameroon: 'Africa', "Cote d'Ivoire": 'Africa', 'DR Congo': 'Africa',
  Egypt: 'Africa', Ghana: 'Africa', Guinea: 'Africa', Liberia: 'Africa', Mali: 'Africa', Morocco: 'Africa',
  Nigeria: 'Africa', Senegal: 'Africa', 'The Gambia': 'Africa',
  Argentina: 'South America', Brazil: 'South America', Chile: 'South America', Colombia: 'South America',
  Ecuador: 'South America', Paraguay: 'South America', Uruguay: 'South America',
  Canada: 'North America', 'Costa Rica': 'North America', Mexico: 'North America', Panama: 'North America', 'United States': 'North America',
  Japan: 'Asia', 'Korea, South': 'Asia', Uzbekistan: 'Asia',
  Austria: 'Europe', Belgium: 'Europe', 'Bosnia-Herzegovina': 'Europe', Bulgaria: 'Europe', Croatia: 'Europe',
  'Czech Republic': 'Europe', Denmark: 'Europe', England: 'Europe', France: 'Europe', Georgia: 'Europe', Germany: 'Europe',
  Greece: 'Europe', Hungary: 'Europe', Iceland: 'Europe', Ireland: 'Europe', Italy: 'Europe', Kosovo: 'Europe',
  Montenegro: 'Europe', Netherlands: 'Europe', 'Northern Ireland': 'Europe', Norway: 'Europe', Poland: 'Europe',
  Portugal: 'Europe', Russia: 'Europe', Scotland: 'Europe', Serbia: 'Europe', Slovakia: 'Europe', Slovenia: 'Europe',
  Spain: 'Europe', Sweden: 'Europe', Switzerland: 'Europe', 'Türkiye': 'Europe', Ukraine: 'Europe', Wales: 'Europe',
};
export const continentOf = (nationality: string): string | null => CONTINENT[nationality] ?? null;
const CONTINENT_ORDER = ['Europe', 'South America', 'Africa', 'North America', 'Asia', 'Oceania'];
const CONTINENT_ADJ: Record<string, string> = {
  Europe: 'European', 'South America': 'South American', Africa: 'African', 'North America': 'North American', Asia: 'Asian', Oceania: 'from Oceania',
};

const POS_GROUP: Record<string, string[]> = { GK: ['GK'], DEF: ['CB', 'LB', 'RB'], MID: ['CDM', 'CM', 'CAM'], ATT: ['LW', 'RW', 'ST'] };
const GROUP_LABEL: Record<string, string> = { GK: 'a goalkeeper', DEF: 'a defender', MID: 'a midfielder', ATT: 'a forward' };
const POS_LABEL: Record<string, string> = {
  GK: 'a goalkeeper', CB: 'a centre-back', LB: 'a left-back', RB: 'a right-back', CDM: 'a defensive midfielder',
  CM: 'a central midfielder', CAM: 'an attacking midfielder', LW: 'a left winger', RW: 'a right winger', ST: 'a striker',
};
const POS_ORDER = ['GK', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LW', 'RW', 'ST'];
const VALUE_THRESHOLDS = [20, 50, 75, 100];

const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);
const normName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ');

interface WAPlayer {
  name: string;
  connected: boolean;
  questionsAsked: number; // cumulative across the match (tiebreak)
}
interface QEntry { by: number; q: string; answer: boolean; key: string }
interface GEntry { by: number; name: string; correct: boolean }

export interface WAState {
  players: (WAPlayer | null)[]; // by seat
  order: number[];
  np: number;
  roundsTotal: number;
  roundNo: number; // 1..roundsTotal
  targetIdx: number; // SECRET bank index
  questionLog: QEntry[]; // public
  guessLog: GEntry[]; // public
  turn: number; // index into order
  eliminated: number[]; // seats out this round (wrong guess)
  roundWins: number[]; // by player-index
  roundWinner: number | null; // seat that won the current/last round (null = nobody)
  lastTargetName: string | null; // revealed once a round ends
  roundOver: boolean; // between rounds (reveal showing)
  over: boolean; // match finished
  winners: number[]; // seats — match winners (set when over)
  timer: Timer;
  log: string[];
}

type ActionResult = { error?: string };
const ok: ActionResult = {};
const fail = (error: string): ActionResult => ({ error });
function log(s: WAState, msg: string) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}
const nameOf = (s: WAState, seat: number) => s.players[seat]!.name;
const active = (s: WAState): number[] => s.order.filter((seat) => !s.eliminated.includes(seat));

// ---------------------------------------------------------------------------
// The oracle: answer a structured question from the target's data
// ---------------------------------------------------------------------------

function answer(t: PlayerCard, qtype: string, param: string): boolean {
  switch (qtype) {
    case 'posGroup': return (POS_GROUP[param] ?? []).some((c) => t.positions.includes(c));
    case 'posCode': return t.positions.includes(param);
    case 'nationality': return t.nationality === param;
    case 'continent': return CONTINENT[t.nationality] === param;
    case 'league': return t.leagues.includes(param);
    case 'valueOver': return t.marketValue != null && t.marketValue > Number(param) * 1e6;
    case 'retired': return t.status === 'retired';
    case 'era': return t.eraOfPlay === param;
    default: return false;
  }
}

function questionText(qtype: string, param: string): string {
  switch (qtype) {
    case 'posGroup': return `Is he ${GROUP_LABEL[param]}?`;
    case 'posCode': return `Is he ${POS_LABEL[param]}?`;
    case 'nationality': return `Is he from ${param}?`;
    case 'continent': return `Is he ${CONTINENT_ADJ[param] ?? param}?`;
    case 'league': return `Does he play in the ${param}?`;
    case 'valueOver': return `Is he worth more than €${param}m?`;
    case 'retired': return 'Is he retired?';
    case 'era': return `Did he play mainly in the ${param}?`;
    default: return '?';
  }
}

// The fixed menu of askable questions for this bank (computed once).
function buildMenu(bank: PlayerCard[]) {
  const codes = POS_ORDER.filter((c) => bank.some((p) => p.positions.includes(c)));
  const nationalities = [...new Set(bank.map((p) => p.nationality))].sort();
  const leagues = [...new Set(bank.flatMap((p) => p.leagues))].sort();
  const eras = [...new Set(bank.map((p) => p.eraOfPlay))].sort();
  const present = new Set(nationalities.map((n) => CONTINENT[n]).filter(Boolean));
  const continents = CONTINENT_ORDER.filter((c) => present.has(c));
  return {
    posGroups: ['GK', 'DEF', 'MID', 'ATT'].map((g) => ({ param: g, label: GROUP_LABEL[g] })),
    posCodes: codes.map((c) => ({ param: c, label: POS_LABEL[c] })),
    nationalities,
    continents,
    leagues,
    eras,
    valueThresholds: VALUE_THRESHOLDS,
  };
}

// All legal question keys (`qtype:param`) — for validation and the bot/timeout pool.
function questionKeys(menu: ReturnType<typeof buildMenu>): string[] {
  const keys: string[] = ['retired:'];
  for (const g of menu.posGroups) keys.push(`posGroup:${g.param}`);
  for (const c of menu.posCodes) keys.push(`posCode:${c.param}`);
  for (const n of menu.nationalities) keys.push(`nationality:${n}`);
  for (const c of menu.continents) keys.push(`continent:${c}`);
  for (const l of menu.leagues) keys.push(`league:${l}`);
  for (const v of menu.valueThresholds) keys.push(`valueOver:${v}`);
  for (const e of menu.eras) keys.push(`era:${e}`);
  return keys;
}

// ---------------------------------------------------------------------------
// Turn helpers
// ---------------------------------------------------------------------------

function advanceTurn(s: WAState) {
  for (let n = 0; n < s.order.length; n++) {
    s.turn = (s.turn + 1) % s.order.length;
    if (!s.eliminated.includes(s.order[s.turn])) return;
  }
}

function matchWinners(s: WAState): number[] {
  const best = Math.max(...s.roundWins);
  if (best === 0) return []; // nobody won a single round → no match winner
  let pids = s.order.map((_, i) => i).filter((i) => s.roundWins[i] === best);
  if (pids.length > 1) {
    const fewest = Math.min(...pids.map((i) => s.players[s.order[i]]!.questionsAsked));
    pids = pids.filter((i) => s.players[s.order[i]]!.questionsAsked === fewest);
  }
  return pids.map((i) => s.order[i]);
}

// ---------------------------------------------------------------------------
// GameDef factory — the player bank is injected, never hardcoded here.
// ---------------------------------------------------------------------------

export function createWhoAmI(playerBank: PlayerCard[]): GameDef<WAState> {
  const bank = playerBank;
  const menu = buildMenu(bank);
  const keySet = new Set(questionKeys(menu));
  const allKeys = questionKeys(menu);

  function endRound(s: WAState, winnerSeat: number | null) {
    s.roundWinner = winnerSeat;
    s.lastTargetName = bank[s.targetIdx].name;
    if (winnerSeat != null) {
      s.roundWins[s.order.indexOf(winnerSeat)] += 1;
      log(s, `🎯 ${nameOf(s, winnerSeat)} guessed it — ${s.lastTargetName}!`);
    } else {
      log(s, `Everyone's out — it was ${s.lastTargetName}. Nobody wins the round.`);
    }
    if (s.roundNo >= s.roundsTotal) {
      s.over = true;
      s.winners = matchWinners(s);
      const names = s.winners.map((seat) => nameOf(s, seat)).join(' & ');
      log(s, `🏆 Match over — ${s.winners.length > 1 ? `tie: ${names}` : `${names} wins`}.`);
    } else {
      s.roundOver = true;
    }
  }

  function nextRound(s: WAState, ctx: GameContext): ActionResult {
    if (!s.roundOver || s.over) return fail('No round to advance.');
    s.roundNo += 1;
    s.targetIdx = randInt(ctx.rng, bank.length);
    s.questionLog = [];
    s.guessLog = [];
    s.eliminated = [];
    s.roundWinner = null;
    s.lastTargetName = null;
    s.roundOver = false;
    s.turn = (s.roundNo - 1) % s.order.length; // rotate who starts
    log(s, `Round ${s.roundNo} of ${s.roundsTotal}. ${nameOf(s, s.order[s.turn])} starts.`);
    return ok;
  }

  function askQuestion(s: WAState, seat: number, qtype: unknown, param: unknown): ActionResult {
    if (s.roundOver || s.over) return fail('The round is between rounds.');
    if (s.order[s.turn] !== seat) return fail('Not your turn.');
    if (s.eliminated.includes(seat)) return fail("You're out of this round.");
    const qt = String(qtype ?? '');
    const pm = String(param ?? '');
    const key = `${qt}:${pm}`;
    if (!keySet.has(key)) return fail('Not a valid question.');
    if (s.questionLog.some((e) => e.key === key)) return fail('That question was already asked.');
    const a = answer(bank[s.targetIdx], qt, pm);
    s.questionLog.push({ by: seat, q: questionText(qt, pm), answer: a, key });
    s.players[seat]!.questionsAsked += 1;
    log(s, `${nameOf(s, seat)}: ${questionText(qt, pm)} → ${a ? 'YES' : 'no'}`);
    advanceTurn(s);
    return ok;
  }

  function guessPlayer(s: WAState, seat: number, name: unknown): ActionResult {
    if (s.roundOver || s.over) return fail('The round is between rounds.');
    if (s.order[s.turn] !== seat) return fail('Not your turn.');
    if (s.eliminated.includes(seat)) return fail("You're out of this round.");
    const typed = String(name ?? '').trim().slice(0, 60);
    if (!typed) return fail('Type a player to guess.');
    const correct = normName(typed) === normName(bank[s.targetIdx].name);
    s.guessLog.push({ by: seat, name: typed, correct });
    if (correct) {
      endRound(s, seat);
      return ok;
    }
    s.eliminated.push(seat);
    log(s, `${nameOf(s, seat)} guessed ${typed} — wrong, and out for the round.`);
    if (active(s).length === 0) endRound(s, null);
    else advanceTurn(s);
    return ok;
  }

  // Auto-action on turn-timeout: ask a random unasked question (never a guess, so a
  // timed-out player is not eliminated). If nothing's left to ask, just pass.
  function timeoutAct(s: WAState, rng: Rng) {
    if (s.roundOver || s.over) return;
    const seat = s.order[s.turn];
    if (s.eliminated.includes(seat)) { advanceTurn(s); return; }
    const unasked = allKeys.filter((k) => !s.questionLog.some((e) => e.key === k));
    if (unasked.length) {
      const [qt, pm] = splitKey(unasked[randInt(rng, unasked.length)]);
      askQuestion(s, seat, qt, pm);
    } else {
      advanceTurn(s);
    }
  }

  const turnKey = (s: WAState) => (s.over || s.roundOver ? '' : `${s.roundNo}:${s.turn}`);

  return {
    id: 'who-am-i',
    name: 'Who Am I?',
    blurb: 'Football 20-questions: ask yes/no questions the server answers from the data, then race to name the secret player.',
    minPlayers: 2,
    maxPlayers: 6,
    options: [
      { key: 'rounds', label: 'Rounds', min: 1, max: 7, step: 1, default: 3 },
      TIMER_OPTION,
    ],

    create(setup: { seats: number[]; players: PlayerInfo[]; options?: Record<string, number> }, ctx: GameContext): WAState {
      const order = [...setup.seats];
      const roundsTotal = Math.min(7, Math.max(1, Math.round(setup.options?.rounds ?? 3)));
      const players: (WAPlayer | null)[] = new Array(MAX_SEATS).fill(null);
      for (const pi of setup.players) players[pi.seat] = { name: pi.name, connected: true, questionsAsked: 0 };
      const s: WAState = {
        players,
        order,
        np: order.length,
        roundsTotal,
        roundNo: 1,
        targetIdx: randInt(ctx.rng, bank.length),
        questionLog: [],
        guessLog: [],
        turn: 0,
        eliminated: [],
        roundWins: new Array(order.length).fill(0),
        roundWinner: null,
        lastTargetName: null,
        roundOver: false,
        over: false,
        winners: [],
        timer: initTimer(setup.options?.timer),
        log: [],
      };
      log(s, `Round 1 of ${roundsTotal}. ${nameOf(s, order[0])} starts — ask a yes/no question or guess.`);
      return s;
    },

    act(s, seat, msg, ctx) {
      if (s.players[seat] == null) return fail('You are not in this match.');
      switch (msg.type) {
        case 'askQuestion':
          return askQuestion(s, seat, msg.qtype, msg.param);
        case 'guessPlayer':
          return guessPlayer(s, seat, msg.name);
        case 'nextRound':
          return nextRound(s, ctx);
      }
    },

    tick(s, ctx) {
      return runTimer(s.timer, () => turnKey(s), ctx.now, () => timeoutAct(s, ctx.rng));
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
      const me = seat !== null && s.players[seat] ? s.players[seat]! : null;
      const reveal = s.over || s.roundOver; // target is secret until the round ends
      const activeSeat = reveal ? null : s.order[s.turn];
      const players = s.order.map((seatNo, pid) => ({
        seat: seatNo,
        name: s.players[seatNo]!.name,
        connected: s.players[seatNo]!.connected,
        eliminated: s.eliminated.includes(seatNo),
        roundWins: s.roundWins[pid],
        questionsAsked: s.players[seatNo]!.questionsAsked,
        isTurn: !reveal && seatNo === activeSeat,
      }));
      return {
        game: 'who-am-i',
        phase: s.over ? 'done' : s.roundOver ? 'roundOver' : 'asking',
        over: s.over,
        roundNo: s.roundNo,
        roundsTotal: s.roundsTotal,
        activeSeat,
        questionLog: s.questionLog,
        guessLog: s.guessLog,
        players,
        menu,
        target: reveal ? s.lastTargetName : null,
        targetCard: reveal ? bank[s.targetIdx] : null,
        roundWinner: reveal ? s.roundWinner : null,
        timer: timerView(s.timer),
        matchWinner: null,
        winners: s.over ? s.winners : null,
        log: s.log.slice(-15),
        you: me
          ? {
              seat,
              eliminated: s.eliminated.includes(seat!),
              isTurn: !reveal && s.order[s.turn] === seat && !s.eliminated.includes(seat!),
              // the searchable name list for guessing — only when it's your turn (it's big)
              allNames: !reveal && s.order[s.turn] === seat && !s.eliminated.includes(seat!) ? bank.map((p) => p.name) : undefined,
            }
          : { seat: seat ?? -1, spectator: true },
      };
    },

    result(s): GameOutcome {
      return { over: s.over, winners: s.over ? s.winners : [] };
    },

    bot(s, seat, ctx) {
      if (s.over || s.roundOver) return null; // bots don't advance rounds (a human host does)
      if (s.order[s.turn] !== seat || s.eliminated.includes(seat)) return null;
      const unasked = allKeys.filter((k) => !s.questionLog.some((e) => e.key === k));
      if (unasked.length) {
        const [qtype, param] = splitKey(unasked[randInt(ctx.rng, unasked.length)]);
        return { type: 'askQuestion', qtype, param };
      }
      // out of questions — take a (likely wrong) guess so the round still resolves
      return { type: 'guessPlayer', name: bank[randInt(ctx.rng, bank.length)].name };
    },
  };
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}
