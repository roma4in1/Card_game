// game.test.ts — Tectonic Shift. Deterministic, perfect-info. Logic is exercised on
// hand-built minimal boards; the default board's value map + central hole are checked too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTectonic, decideWinners, recomputeAlive, type TState } from './game.ts';
import type { GameContext } from '../../platform/types.ts';

const ctx: GameContext = { rng: () => 0.5, now: 0 };
const def = createTectonic();
const act = (s: TState, seat: number, msg: Record<string, unknown>) => def.act(s, seat, msg, ctx) ?? {};
const view = (s: TState, seat: number) => def.view(s, seat) as any;

// Build a minimal state from an explicit hex list + pawns (then recompute alive).
function mk(opts: {
  hexes: { q: number; r: number; value?: number; state?: 'present' | 'gap' }[];
  pawns: { id: number; owner: number; q: number; r: number }[];
  np?: number;
}): TState {
  const np = opts.np ?? 2;
  const players: any[] = new Array(8).fill(null);
  for (let i = 0; i < np; i++) players[i] = { name: 'P' + i, connected: true };
  const hexes: Record<string, any> = {};
  for (const h of opts.hexes) hexes[`${h.q},${h.r}`] = { value: h.value ?? 1, state: h.state ?? 'present', pawn: null };
  const pawns = opts.pawns.map((p) => ({ ...p, alive: true }));
  for (const p of pawns) hexes[`${p.q},${p.r}`].pawn = p.id;
  const s: TState = {
    players, order: Array.from({ length: np }, (_, i) => i), np, radius: 3,
    hexes, pawns, scores: new Array(np).fill(0), turn: 0, winner: null, winners: [], over: false, log: [],
  };
  recomputeAlive(s);
  return s;
}
const line = (n: number, values: number[]) =>
  Array.from({ length: n }, (_, q) => ({ q, r: 0, value: values[q] ?? 1 }));

// ---------------------------------------------------------------------------
// Slide legality
// ---------------------------------------------------------------------------

test('a slide goes all the way to the last hex before a gap / pawn / edge', () => {
  // hexes (0,0)..(4,0); a gap at (3,0); pawn P0 at (0,0)
  const s = mk({ hexes: [...line(5, [0, 3, 3, 1, 1])].map((h, i) => (i === 3 ? { ...h, state: 'gap' as const } : h)), pawns: [{ id: 0, owner: 0, q: 0, r: 0 }] });
  const d0 = view(s, 0).legal.filter((m: any) => m.direction === 0); // direction 0 = +q
  assert.equal(d0.length, 1, 'exactly one slide per direction — the maximal one');
  assert.equal(d0[0].distance, 2);
  assert.deepEqual(d0[0].to, [2, 0], 'stops at (2,0), the last hex before the gap');

  // a pawn blocks the same way
  const s2 = mk({ hexes: line(5, [0, 1, 1, 1, 1]), pawns: [{ id: 0, owner: 0, q: 0, r: 0 }, { id: 1, owner: 1, q: 2, r: 0 }] });
  const e0 = view(s2, 0).legal.filter((m: any) => m.direction === 0);
  assert.equal(e0[0].distance, 1, 'stops on (1,0), right before the blocking pawn');
});

// ---------------------------------------------------------------------------
// Scoring: origin only
// ---------------------------------------------------------------------------

test('only the origin hex is removed + banked; passed-over hexes are untouched; a 0-start banks 0', () => {
  const s = mk({ hexes: line(4, [0, 2, 3, 4]), pawns: [{ id: 0, owner: 0, q: 0, r: 0 }] });
  // forced slide dir0 travels all the way to the far edge at (3,0), passing over (1,0),(2,0)
  assert.equal(act(s, 0, { type: 'slide', pawnId: 0, direction: 0 }).error, undefined);
  assert.equal(s.scores[0], 0, 'leaving a 0-value start banks 0');
  assert.equal(s.hexes['0,0'].state, 'gap', 'origin removed');
  assert.equal(s.hexes['1,0'].state, 'present', 'passed-over hex untouched');
  assert.equal(s.hexes['2,0'].value, 3, 'passed-over value unchanged');
  assert.equal(s.hexes['3,0'].pawn, 0, 'slid to the far end');

  // a fresh board: leaving a value-4 hex banks 4
  const s2 = mk({ hexes: line(3, [4, 1, 1]), pawns: [{ id: 0, owner: 0, q: 0, r: 0 }] });
  act(s2, 0, { type: 'slide', pawnId: 0, direction: 0 });
  assert.equal(s2.scores[0], 4, 'banked the value-4 hex it departed');
});

// ---------------------------------------------------------------------------
// Lost final hex + no auto-claim
// ---------------------------------------------------------------------------

test('a pawn that can never leave its hex is dead and that hex is scored by no one', () => {
  // single isolated hex (5) with a pawn — boxed by the edge on all sides
  const s = mk({ hexes: [{ q: 0, r: 0, value: 5 }], pawns: [{ id: 0, owner: 0, q: 0, r: 0 }] });
  assert.equal(s.pawns[0].alive, false, 'no slide → dead');
  assert.equal(s.scores[0], 0, 'the value-5 hex it dies on is never banked');
});

test('no auto-claim: a lone pawn in its own region must move to collect, and loses its last hex', () => {
  // P0 has a private 3-hex strip (0,2,3); P1 has an identical mirrored strip so neither
  // player dominates — the game stays live (no early-end) while we walk P0 by hand.
  const s = mk({
    hexes: [
      ...line(3, [0, 2, 3]),
      { q: 0, r: 5, value: 0 }, { q: 1, r: 5, value: 2 }, { q: 2, r: 5, value: 3 },
    ],
    pawns: [{ id: 0, owner: 0, q: 0, r: 0 }, { id: 1, owner: 1, q: 0, r: 5 }],
  });
  s.turn = 0;
  act(s, 0, { type: 'slide', pawnId: 0, direction: 0 }); // forced: (0,0) v0 → slides to (2,0); banks 0
  s.turn = 0;
  act(s, 0, { type: 'slide', pawnId: 0, direction: 3 }); // forced: (2,0) v3 → slides back to (1,0); banks 3
  assert.equal(s.over, false, 'game continues — P1 still has moves');
  assert.equal(s.scores[0], 3, 'collected only the departed hexes (0 + 3)');
  assert.equal(s.pawns[0].alive, false, 'pawn is now boxed in on the value-2 hex');
  assert.equal(s.hexes['1,0'].pawn, 0, 'the value-2 hex it dies on is lost — never banked by anyone');
});

// ---------------------------------------------------------------------------
// Alive/dead + end condition
// ---------------------------------------------------------------------------

test('the game ends when no pawn has a legal move', () => {
  // two pawns facing each other on a 2-hex strip: each can move once, then both stuck
  const s = mk({ hexes: line(2, [3, 4]), pawns: [{ id: 0, owner: 0, q: 0, r: 0 }, { id: 1, owner: 1, q: 1, r: 0 }] });
  // neither can move (adjacent pawn / edge) → already dead
  assert.ok(s.pawns.every((p) => !p.alive));
  // make P0 able to move: extend the strip
  const s2 = mk({ hexes: line(3, [0, 2, 0]), pawns: [{ id: 0, owner: 0, q: 0, r: 0 }, { id: 1, owner: 1, q: 2, r: 0 }] });
  act(s2, 0, { type: 'slide', pawnId: 0, direction: 0, distance: 1 }); // P0 (0,0)->(1,0), banks 0
  assert.equal(s2.over, true, 'after P0 moves to the middle, nobody can move → end');
  assert.equal(s2.scores[0], 0);
});

test('early-end credits islands a player dominates, ending a decided game', () => {
  // P0 leads and alone controls a big island; P1 is stuck on a tiny one → result is fixed.
  const s = mk({
    hexes: [...line(5, [0, 3, 3, 3, 3]), { q: 0, r: 5, value: 1 }, { q: 1, r: 5, value: 1 }],
    pawns: [{ id: 0, owner: 0, q: 0, r: 0 }, { id: 1, owner: 1, q: 0, r: 5 }],
  });
  s.scores = [20, 5];
  s.turn = 0;
  act(s, 0, { type: 'slide', pawnId: 0, direction: 0 }); // any move triggers the check
  assert.equal(s.over, true, 'P0’s lead plus their dominated island puts them out of reach');
  assert.deepEqual(def.result(s).winners, [0]);
});

// ---------------------------------------------------------------------------
// Winner & tiebreak (pure)
// ---------------------------------------------------------------------------

test('winner is highest score, tiebroken by alive pawns, else shared', () => {
  assert.deepEqual(decideWinners([5, 3, 3], [0, 0, 0]), [0]);
  assert.deepEqual(decideWinners([5, 5, 3], [2, 1, 0]), [0], 'tie on score → more alive wins');
  assert.deepEqual(decideWinners([5, 5, 3], [2, 2, 0]).sort(), [0, 1], 'fully tied → shared');
});

// ---------------------------------------------------------------------------
// Default board: value map + central hole
// ---------------------------------------------------------------------------

test('the default board rises in value toward a central void', () => {
  const s = def.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as TState;
  assert.equal(s.hexes['0,0'], undefined, 'the centre is a void');
  const fives = Object.values(s.hexes).filter((h) => h.value === 5).length;
  assert.equal(fives, 3, 'exactly three 5-tiles on the board');
  assert.equal(s.hexes['3,0'].value, 4, 'the next ring in is worth 4');
  assert.equal(s.hexes['6,0'].value, 1, 'edge hexes are worth 1');
  // every player's pawns start in a contiguous arc on the outer ring, on 0-value hexes
  for (const p of s.pawns) assert.equal(s.hexes[`${p.q},${p.r}`].value, 0, 'start hexes are 0');
  const counts = [0, 0];
  for (const p of s.pawns) counts[p.owner]++;
  assert.deepEqual(counts, [5, 5], '5 pawns each (2-player default)');
});

// ---------------------------------------------------------------------------
// View parity (no redaction) + full autoplay
// ---------------------------------------------------------------------------

test('view returns identical public state to all players', () => {
  const s = mk({ hexes: line(4, [0, 2, 3, 4]), pawns: [{ id: 0, owner: 0, q: 0, r: 0 }, { id: 1, owner: 1, q: 3, r: 0 }] });
  const a = view(s, 0);
  const b = view(s, 1);
  assert.deepEqual(a.hexes, b.hexes);
  assert.deepEqual(a.pawns, b.pawns);
  assert.deepEqual(a.legal, b.legal);
  assert.equal(a.you.seat, 0);
  assert.equal(b.you.seat, 1);
});

test('a full default match plays to a decided result via the bot', () => {
  const s = def.create({ seats: [0, 1, 2], players: [0, 1, 2].map((i) => ({ seat: i, name: 'P' + i })) }, ctx) as TState;
  let guard = 0;
  while (!s.over && guard++ < 100000) {
    let acted = false;
    for (const seat of s.order) {
      const mv = def.bot!(s, seat, ctx);
      if (mv) {
        assert.equal(act(s, seat, mv).error, undefined, JSON.stringify(mv));
        acted = true;
        break;
      }
    }
    if (!acted) break;
  }
  assert.equal(s.over, true);
  assert.ok(def.result(s).winners.length >= 1);
});
