// decoy.cjs — choose the spy's decoy: the player in the pool most similar to the
// target. The Spy Game plugin calls pickDecoy(target, pool) at match start.
//
// A candidate must share at least one position code with the target (hard filter).
// Among those, score by how much else it shares and take the best (random tie-break).

const TIERS = ['≥75m', '40–75m', '20–40m', '10–20m', '<10m'];
function tierOf(mv) {
  if (mv == null) return '<10m'; // unknown value (legends) sits in the lowest tier
  if (mv >= 75e6) return '≥75m';
  if (mv >= 40e6) return '40–75m';
  if (mv >= 20e6) return '20–40m';
  if (mv >= 10e6) return '10–20m';
  return '<10m';
}

const sharesPosition = (a, b) => a.positions.some((p) => b.positions.includes(p));

/** Pick the most-similar decoy for `target` from `pool`. `rng` is injectable for tests. */
function pickDecoy(target, pool, rng = Math.random) {
  const candidates = pool.filter((p) => p.name !== target.name && sharesPosition(p, target));
  if (candidates.length === 0) return null;

  const targetTier = tierOf(target.marketValue);
  let best = -1;
  let bestList = [];
  for (const c of candidates) {
    let score = 0;
    if (c.nationality === target.nationality) score += 3;
    if (c.leagues.some((l) => target.leagues.includes(l))) score += 2;
    if (c.eraOfPlay === target.eraOfPlay) score += 2;
    if (tierOf(c.marketValue) === targetTier) score += 2;
    if (score > best) {
      best = score;
      bestList = [c];
    } else if (score === best) {
      bestList.push(c);
    }
  }
  return bestList[Math.floor(rng() * bestList.length)];
}

module.exports = { pickDecoy, tierOf };

// ---------------------------------------------------------------------------
// Unit tests — run with `node decoy.cjs`
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('node:assert/strict');
  const P = (name, nationality, positions, leagues, marketValue, eraOfPlay) =>
    ({ name, nationality, positions, leagues, marketValue, status: marketValue == null ? 'retired' : 'active', eraOfPlay });

  // 1) A Spanish CB target prefers another Spanish CB of similar value/era over players
  //    who merely share the position (a Brazilian CB) — and ignores a Brazilian ST entirely.
  {
    const target = P('Target', 'Spain', ['CB'], ['La Liga'], 40e6, '2020s');
    const spanishCB = P('SpanishCB', 'Spain', ['CB'], ['La Liga'], 45e6, '2020s'); // +3 +2 +2 +2 = 9
    const brazilCB = P('BrazilCB', 'Brazil', ['CB'], ['Serie A'], 45e6, '2020s'); // +0 +0 +2 +2 = 4
    const brazilST = P('BrazilST', 'Brazil', ['ST'], ['Premier League'], 90e6, '2020s'); // not a candidate (no shared position)
    assert.equal(pickDecoy(target, [brazilST, brazilCB, spanishCB]).name, 'SpanishCB');
  }

  // 2) A legend target prefers a same-era same-position legend over a same-nation,
  //    same-position legend from a different era (era bonus tips it).
  {
    const target = P('LegendTarget', 'France', ['CAM'], [], null, '1980s');
    const sameEra = P('SameEra', 'France', ['CAM'], [], null, '1980s'); // +3 +0 +2 +2 = 7
    const otherEra = P('OtherEra', 'France', ['CAM'], [], null, '2010s'); // +3 +0 +0 +2 = 5
    assert.equal(pickDecoy(target, [otherEra, sameEra]).name, 'SameEra');
  }

  // 3) Sharing a league breaks an otherwise-even pair, and ties resolve via rng.
  {
    const target = P('T', 'England', ['LW', 'RW'], ['Premier League'], 30e6, '2020s');
    const sameLeague = P('SameLeague', 'Germany', ['LW'], ['Premier League'], 30e6, '2020s'); // +0 +2 +2 +2 = 6
    const otherLeague = P('OtherLeague', 'Germany', ['RW'], ['Bundesliga'], 30e6, '2020s'); // +0 +0 +2 +2 = 4
    assert.equal(pickDecoy(target, [otherLeague, sameLeague]).name, 'SameLeague');
    // a genuine tie returns a candidate deterministically under a fixed rng
    const tieA = P('TieA', 'Germany', ['LW'], ['Bundesliga'], 30e6, '2020s');
    const tieB = P('TieB', 'Germany', ['RW'], ['Bundesliga'], 30e6, '2020s');
    assert.equal(pickDecoy(target, [tieA, tieB], () => 0).name, 'TieA');
  }

  console.log('decoy.cjs: all unit tests passed ✓');
}
