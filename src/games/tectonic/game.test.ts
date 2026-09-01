// game.test.ts — Tectonic Shift. Deterministic, perfect-info. Logic is exercised on
// hand-built minimal boards; the default board's value map + central hole are checked too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTectonic, decideWinners, recomputeAlive, DIRS, type TState } from './game.ts';
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
const line = (n: number, values: number[], r = 0) =>
  Array.from({ length: n }, (_, q) => ({ q, r, value: values[q] ?? 1 }));
// Let the bots play the position to its natural end.
function playOut(s: TState, guard = 500) {
  while (!s.over && guard-- > 0) {
    const seat = s.order.find((st) => def.bot!(s, st, ctx));
    if (seat === undefined) return;
    act(s, seat, def.bot!(s, seat, ctx)!);
  }
}

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

test('early-end never crowns a player it has just proved cannot win', () => {
  // P0 trails on the board (10 v 15) but alone owns a fat island, so their guaranteed
  // total is out of P1's reach. The ranking is read off the banked scores, so stopping
  // here would hand the win to P1 — the very player the check ruled out. Play on.
  const s = mk({
    hexes: [...line(6, [0, 5, 5, 5, 5, 5]), { q: 0, r: 5, value: 1 }, { q: 1, r: 5, value: 1 }],
    pawns: [{ id: 0, owner: 0, q: 0, r: 0 }, { id: 1, owner: 1, q: 0, r: 5 }],
  });
  s.scores = [10, 15];
  s.turn = 0;
  act(s, 0, { type: 'slide', pawnId: 0, direction: 0 });
  assert.equal(s.over, false, 'no early end while the guaranteed leader still trails on points');
  playOut(s);
  assert.ok(s.scores[0] > s.scores[1], `P0 harvests their island: ${s.scores}`);
  assert.deepEqual(def.result(s).winners, [0], 'the guaranteed leader wins the played-out game');
});

test('an island a player dominates only guarantees the hex their pawn stands on', () => {
  // P0's lone pawn starts in the MIDDLE of its private 4-hex strip. A slide goes all the
  // way, so whichever way it leaves it strands itself with points still on the board: it
  // banks 2 of the 4, never "the island minus its dearest hex" (3). Crediting that as
  // guaranteed used to end the game on a promise P0 could not keep.
  const s = mk({
    hexes: [...line(4, [1, 1, 1, 1]), ...line(4, [1, 1, 1, 1], 5)],
    pawns: [{ id: 0, owner: 0, q: 1, r: 0 }, { id: 1, owner: 1, q: 1, r: 5 }],
  });
  s.turn = 0;
  act(s, 0, { type: 'slide', pawnId: 0, direction: 0 }); // banks 1, strands itself at the far end
  assert.equal(s.over, false, 'a stranding island is not a guaranteed haul — the game goes on');
  playOut(s);
  assert.deepEqual(s.scores, [2, 2], 'both lone pawns really collect 2 of their 4 points');
  assert.deepEqual(def.result(s).winners.sort(), [0, 1], 'the honest result is a shared win');
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

test('the default board has a central void and a randomized point layout', () => {
  const s = def.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as TState;
  assert.equal(s.hexes['0,0'], undefined, 'the centre is a void');
  const fives = Object.values(s.hexes).filter((h) => h.value === 5).length;
  assert.equal(fives, 3, 'the value multiset is preserved: exactly three 5-tiles');
  // every player's pawns start in a contiguous arc on the outer ring, on 0-value hexes
  for (const p of s.pawns) assert.equal(s.hexes[`${p.q},${p.r}`].value, 0, 'start hexes stay 0');
  const counts = [0, 0];
  for (const p of s.pawns) counts[p.owner]++;
  assert.deepEqual(counts, [5, 5], '5 pawns each (2-player default)');

  // Randomized each game: two matches with different rng scatter values differently,
  // while the multiset of values (its sorted list) is identical between them.
  const rng = (seq: number[]) => { let i = 0; return () => seq[i++ % seq.length]; };
  const layout = (st: TState) => Object.keys(st.hexes).sort().map((k) => st.hexes[k].value);
  const bag = (st: TState) => [...layout(st)].sort((a, b) => a - b);
  const setup = { seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] };
  const a = def.create(setup, { rng: rng([0.1, 0.9, 0.3, 0.7]), now: 0 }) as TState;
  const b = def.create(setup, { rng: rng([0.8, 0.2, 0.6, 0.4]), now: 0 }) as TState;
  assert.deepEqual(bag(a), bag(b), 'same pool of point values every game');
  assert.notDeepEqual(layout(a), layout(b), 'the layout differs between games');
});

// ---------------------------------------------------------------------------
// The opening position
// ---------------------------------------------------------------------------

test('no opening move by anyone can strand another player’s pawn', () => {
  // The bug this guards: pawns used to start shoulder to shoulder along the ring, which
  // left the ones in the middle of an arc with both ring neighbours taken by their own
  // side and a single hex inward as their only way out. One exit is one opponent move from
  // being eliminated, before that player had taken a turn at all — worst at three and four
  // players, and identical every match, because the placement never varied.
  for (const np of [2, 3, 4]) {
    for (let seed = 1; seed <= 8; seed++) {
      let a = seed * 613 + np;
      const rng = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
      const seats = Array.from({ length: np }, (_, i) => i);
      const s = def.create({ seats, players: seats.map((i) => ({ seat: i, name: 'P' + i })) }, { rng, now: 0 }) as TState;

      for (let mover = 0; mover < np; mover++) {
        const from: TState = JSON.parse(JSON.stringify(s));
        from.turn = mover;
        for (const m of (view(from, from.order[mover]) as any).legal) {
          const after: TState = JSON.parse(JSON.stringify(from));
          const p = after.pawns.find((x) => x.id === m.pawnId)!;
          const origin = after.hexes[`${p.q},${p.r}`];
          origin.state = 'gap';
          origin.pawn = null;
          p.q = m.to[0];
          p.r = m.to[1];
          after.hexes[`${p.q},${p.r}`].pawn = p.id;
          recomputeAlive(after);
          const stranded = after.pawns.find((x) => x.owner !== mover && !x.alive);
          assert.equal(stranded, undefined, `${np}p: seat ${mover} stranded pawn ${stranded?.id} of seat ${stranded?.owner} on move one`);
        }
      }
    }
  }
});

test('every pawn starts with room to move, whatever anyone else does first', () => {
  // The guarantee behind the test above: a single slide can cost a pawn at most two exits
  // — the gap it leaves behind and the hex it lands on — so three exits cannot be closed
  // in one move. This is the property to preserve if the layout is ever changed again.
  for (const np of [2, 3, 4]) {
    const seats = Array.from({ length: np }, (_, i) => i);
    const s = def.create({ seats, players: seats.map((i) => ({ seat: i, name: 'P' + i })) }, ctx) as TState;
    for (const p of s.pawns) {
      const exits = DIRS.filter(([dq, dr]) => {
        const h = s.hexes[`${p.q + dq},${p.r + dr}`];
        return h && h.state === 'present' && h.pawn === null;
      }).length;
      assert.ok(exits >= 3, `pawn ${p.id} (seat ${p.owner}, ${np}p) starts with only ${exits} way(s) out`);
    }
  }
});

test('the pieces are set out differently each match, not just the points', () => {
  // Values were already dealt afresh every game, but the pawns stood on the same hexes
  // every time — so the opening looked identical match after match, and the bot answered
  // it the same way.
  const layout = (seed: number) => {
    let a = seed;
    const rng = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
    const s = def.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, { rng, now: 0 }) as TState;
    return s.pawns.map((p) => `${p.q},${p.r}`).join('|');
  };
  const seen = new Set([layout(7), layout(99), layout(1234), layout(555)]);
  assert.ok(seen.size > 1, 'four matches produced the same starting layout every time');
});

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

test('the bot slides toward the land worth having, not just the first way out', () => {
  // Both slides bank the SAME hex — the one the pawn is standing on — so a bot that only
  // values the hex it leaves is choosing blind, and takes whichever direction it happens
  // to enumerate first. Leaving (0,0) splits the board in two: a dead end of 2 points to
  // the east, and 20 points of open ground to the west. Only the landing matters here.
  const s = mk({
    hexes: [
      { q: 0, r: 0, value: 3 },
      { q: 1, r: 0, value: 1 }, { q: 2, r: 0, value: 1 },
      { q: -1, r: 0, value: 4 }, { q: -2, r: 0, value: 4 }, { q: -3, r: 0, value: 4 },
      { q: -2, r: 1, value: 4 }, { q: -3, r: 1, value: 4 },
      // a private strip for P1 so the match doesn't end while we look
      { q: 0, r: 5, value: 1 }, { q: 1, r: 5, value: 1 }, { q: 2, r: 5, value: 1 },
    ],
    pawns: [{ id: 0, owner: 0, q: 0, r: 0 }, { id: 1, owner: 1, q: 0, r: 5 }],
  });
  s.turn = 0;
  const mv = def.bot!(s, 0, ctx) as any;
  assert.equal(mv.pawnId, 0);
  assert.equal(mv.direction, 3, 'it goes west, into the 20 points, not east into the dead end');

  act(s, 0, mv, ctx);
  assert.equal(s.scores[0], 3, 'either way it banks the 3 it was standing on');
  assert.equal(s.pawns[0].q, -3, 'and it is now sitting in the half worth having');
});

test('thinking leaves the board exactly as it found it', () => {
  // The search plays moves on the REAL state and takes them back again, rather than
  // copying ~130 hexes per node. That is only safe if the undo is perfect: a single field
  // left behind would corrupt a live match, silently and permanently.
  const s = def.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, ctx) as TState;
  for (let n = 0; n < 12 && !s.over; n++) {
    const seat = s.order[s.turn];
    const before = JSON.stringify(s);
    const mv = def.bot!(s, seat, ctx);
    assert.equal(JSON.stringify(s), before, 'the bot mutated the game while thinking about it');
    if (!mv) break;
    act(s, seat, mv, ctx);
  }
});

test('a bot-played match keeps the board consistent and the points conserved', () => {
  const s = def.create({ seats: [0, 1, 2], players: [0, 1, 2].map((i) => ({ seat: i, name: 'P' + i })) }, ctx) as TState;
  const total = Object.values(s.hexes).reduce((a, h) => a + h.value, 0);
  for (let n = 0; n < 4000 && !s.over; n++) {
    const seat = s.order[s.turn];
    const mv = def.bot!(s, seat, ctx);
    if (!mv) break;
    assert.equal(act(s, seat, mv, ctx).error, undefined, JSON.stringify(mv));

    // every pawn stands on a present hex that points back at it, and no two share one
    const seen = new Set<string>();
    for (const p of s.pawns) {
      const key = `${p.q},${p.r}`;
      const h = s.hexes[key];
      assert.ok(h, `pawn ${p.id} is off the board`);
      assert.equal(h.state, 'present', `pawn ${p.id} is standing on a gap`);
      assert.equal(h.pawn, p.id, `hex ${key} does not point back at pawn ${p.id}`);
      assert.equal(seen.has(key), false, `two pawns share ${key}`);
      seen.add(key);
    }
    // and every point banked is a hex that was actually removed
    const banked = s.scores.reduce((a, b) => a + b, 0);
    const gone = Object.values(s.hexes).filter((h) => h.state === 'gap').reduce((a, h) => a + h.value, 0);
    const standing = Object.values(s.hexes).filter((h) => h.state === 'present').reduce((a, h) => a + h.value, 0);
    assert.equal(banked, gone, 'points banked do not match the hexes removed');
    assert.equal(banked + standing, total, 'points appeared or vanished');
  }
  assert.equal(s.over, true);
});

test('the bot keeps its own counsel — repeat matches are not identical', () => {
  const play = (seq: number[]) => {
    let i = 0;
    const c = { rng: () => seq[i++ % seq.length], now: 0 };
    const st = def.create({ seats: [0, 1], players: [{ seat: 0, name: 'A' }, { seat: 1, name: 'B' }] }, c) as TState;
    for (let n = 0; n < 4000 && !st.over; n++) {
      const seat = st.order[st.turn];
      const mv = def.bot!(st, seat, c);
      if (!mv) break;
      act(st, seat, mv, c);
    }
    return JSON.stringify(st.scores) + '|' + st.log.length;
  };
  assert.notEqual(play([0.11, 0.83, 0.37, 0.62]), play([0.71, 0.19, 0.94, 0.28]));
});

// ---------------------------------------------------------------------------
// View parity (no redaction) + full autoplay
// ---------------------------------------------------------------------------

test('pawn arcs never overlap, even when the ring is barely wider than the pawn count', () => {
  // A small board leaves each of 4 players a 3-hex arc while the default hands out 4
  // pawns: unclamped, neighbouring arcs stack pawns on a shared hex and the hex→pawn
  // link points at only one of them.
  const small = createTectonic({ radius: 2 });
  const seats = [0, 1, 2, 3];
  const s = small.create({ seats, players: seats.map((i) => ({ seat: i, name: 'P' + i })) }, ctx) as TState;
  const occupied = new Set<string>();
  for (const p of s.pawns) {
    const key = `${p.q},${p.r}`;
    assert.equal(occupied.has(key), false, `two pawns stacked on ${key}`);
    occupied.add(key);
    assert.equal(s.hexes[key].pawn, p.id, `hex ${key} does not link back to pawn ${p.id}`);
  }
});

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
