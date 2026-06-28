// build-wordbank.cjs — assemble the final Spy Game word bank from the Transfermarkt dumps.
//
//   raw-players.json   active players (current squads, 6 top leagues)
//   legends-raw.json   ~172 curated retired players (_legend / _eraOfPlay)
//
// The two files disagree on some field names, so we read defensively. Output schema:
//   { name, nationality, positions:[codes], leagues:[..], marketValue, status, eraOfPlay }
// Writes players.json and prints a full report. Raw inputs are read-only.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const actives = require('./raw-players.json');
const legends = require('./legends-raw.json');

// ---- position labels -> FINE codes (unmapped labels are dropped) ----
const POS_MAP = new Map(Object.entries({
  'Goalkeeper': 'GK',
  'Centre-Back': 'CB',
  'Left-Back': 'LB',
  'Right-Back': 'RB',
  'Defensive Midfield': 'CDM',
  'Central Midfield': 'CM',
  'Attacking Midfield': 'CAM',
  'Left Winger': 'LW',
  'Left Midfield': 'LW',
  'Right Winger': 'RW',
  'Right Midfield': 'RW',
  'Centre-Forward': 'ST',
  'Second Striker': 'ST',
}));

function mapPositions(position) {
  if (!position) return [];
  // Most records use { main, other }, but a few store a bare string label. Sparse
  // legends store abbreviations ("CM","SW",…) that don't match the full-word map and
  // so correctly drop; full-word strings like "Left-Back" map fine.
  const labels = typeof position === 'string'
    ? [position]
    : [position.main, ...(Array.isArray(position.other) ? position.other : [])];
  const out = new Set();
  for (const label of labels) {
    if (label && POS_MAP.has(label)) out.add(POS_MAP.get(label));
  }
  return [...out];
}

const firstOf = (...arrs) => {
  for (const a of arrs) if (Array.isArray(a) && a.length && a[0]) return a[0];
  return null;
};

function normLeague(comp) {
  if (!comp) return null;
  return comp === 'Liga Portugal' ? 'Primeira Liga' : comp;
}

// ---- market-value tiers (euros). null counts as the lowest tier. ----
const TIERS = ['≥75m', '40–75m', '20–40m', '10–20m', '<10m'];
function tierOf(mv) {
  if (mv == null) return '<10m';
  if (mv >= 75e6) return '≥75m';
  if (mv >= 40e6) return '40–75m';
  if (mv >= 20e6) return '20–40m';
  if (mv >= 10e6) return '10–20m';
  return '<10m';
}

// ---- shape a raw record; return null (with a reason) if it must be skipped ----
const skipped = [];
function shape(rec, isLegend) {
  const name = rec.name || rec._query;
  const positions = mapPositions(rec.position);
  const nationality = firstOf(rec.nationality, rec.nationalities, rec.citizenship);
  if (positions.length === 0 || !nationality) {
    skipped.push({ name, reason: positions.length === 0 ? 'no mapped position' : 'no nationality', legend: !!isLegend });
    return null;
  }
  const retired = rec.isRetired === true || rec._legend === true;
  return {
    name,
    nationality,
    positions,
    leagues: isLegend ? [] : [normLeague(rec._competition)].filter(Boolean),
    marketValue: isLegend ? null : (typeof rec.marketValue === 'number' ? rec.marketValue : null),
    status: retired ? 'retired' : 'active',
    eraOfPlay: isLegend ? (rec._eraOfPlay || null) : '2020s',
  };
}

const shapedActives = actives.map((r) => shape(r, false)).filter(Boolean);
const shapedLegends = legends.map((r) => shape(r, true)).filter(Boolean);

// ---- active trim: keep players valued at or above the cap (capped at 1000) ----
shapedActives.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
const m = (rank) => shapedActives[rank - 1] ? (shapedActives[rank - 1].marketValue || 0) : 0;
const em = (v) => (v / 1e6).toFixed(1) + 'm';

const CUT_MV = 20e6; // market-value cap: include actives worth at least this
const CUT_CAP = Math.min(1000, shapedActives.length); // never more than this many actives
let cutoffRank = 0;
while (cutoffRank < CUT_CAP && m(cutoffRank + 1) >= CUT_MV) cutoffRank++;
const rationale = cutoffRank === CUT_CAP
  ? `hit the ${CUT_CAP}-active cap before reaching €${em(CUT_MV)} (rank ${CUT_CAP} = €${em(m(CUT_CAP))})`
  : `kept every active worth ≥ €${em(CUT_MV)}: the top ${cutoffRank} (rank ${cutoffRank} = €${em(m(cutoffRank))}; next is €${em(m(cutoffRank + 1))}, below the cap)`;
const trimmedActives = shapedActives.slice(0, cutoffRank);

// ---- combine, dedupe by name (keep first; actives precede legends) ----
let pool = [...trimmedActives, ...shapedLegends];
const seen = new Set();
const dupes = [];
pool = pool.filter((p) => {
  if (seen.has(p.name)) { dupes.push(p.name); return false; }
  seen.add(p.name);
  return true;
});

// ---- orphan check: every player must share >=1 position code with another ----
const sharePos = (a, b) => a.positions.some((p) => b.positions.includes(p));
const orphansRemoved = [];
for (;;) {
  const kept = pool.filter((p) => pool.some((q) => q !== p && sharePos(p, q)));
  if (kept.length === pool.length) break;
  for (const p of pool) if (!kept.includes(p)) orphansRemoved.push(p.name);
  pool = kept;
}

fs.writeFileSync(path.join(ROOT, 'players.json'), JSON.stringify(pool, null, 2));

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const tally = (arr, key) => {
  const t = {};
  for (const x of arr) for (const v of [].concat(key(x))) if (v != null) t[v] = (t[v] || 0) + 1;
  return t;
};
const sortEntries = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

const activeN = pool.filter((p) => p.status === 'active').length;
const retiredN = pool.length - activeN;

console.log('\n================  SPY GAME WORD BANK  ================');
console.log(`actives shaped: ${shapedActives.length}  |  legends shaped: ${shapedLegends.length}  |  skipped: ${skipped.length}`);
console.log(`\n-- active trim (value cap €${em(CUT_MV)}) --`);
for (let r = cutoffRank - 2; r <= cutoffRank + 2; r++) if (r >= 1) console.log(`  rank ${r}: €${em(m(r))}${r === cutoffRank ? '   <- last kept' : ''}`);
console.log(`\nCUTOFF: rank ${cutoffRank} @ €${em(m(cutoffRank))}`);
console.log(`RATIONALE: ${rationale}`);

console.log(`\nTOTAL written: ${pool.length}  (active ${activeN} / retired ${retiredN})`);

console.log('\n-- position coverage --');
console.log('  ' + sortEntries(tally(pool, (p) => p.positions)).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('\n-- league coverage --');
console.log('  ' + sortEntries(tally(pool, (p) => (p.leagues.length ? p.leagues : null))).map(([k, v]) => `${k}:${v}`).join('  ') + `   (retired/no-league: ${pool.filter((p) => !p.leagues.length).length})`);
console.log('\n-- nationality top-10 --');
console.log('  ' + sortEntries(tally(pool, (p) => p.nationality)).slice(0, 10).map(([k, v]) => `${k}:${v}`).join('  '));

console.log('\n-- market-value tiers --');
const tierT = {};
for (const p of pool) tierT[tierOf(p.marketValue)] = (tierT[tierOf(p.marketValue)] || 0) + 1;
console.log('  ' + TIERS.map((t) => `${t}:${tierT[t] || 0}`).join('  '));

console.log('\n-- THINNING CHECK: 10 lowest-value ACTIVE players included --');
pool.filter((p) => p.status === 'active')
  .sort((a, b) => (a.marketValue || 0) - (b.marketValue || 0))
  .slice(0, 10)
  .forEach((p) => console.log(`  €${em(p.marketValue || 0).padStart(6)}  ${p.name}  (${p.nationality}, ${p.positions.join('/')}, ${p.leagues.join('') || '—'})`));

console.log('\n-- skipped records (sparse / unmapped) --');
console.log(`  ${skipped.length} skipped:`);
for (const s of skipped) console.log(`    [${s.legend ? 'legend' : 'active'}] ${s.name} — ${s.reason}`);

console.log('\n-- dedupe & orphans --');
console.log(`  duplicate names dropped: ${dupes.length}${dupes.length ? ' (' + dupes.join(', ') + ')' : ''}`);
console.log(`  orphans removed (no position partner): ${orphansRemoved.length}${orphansRemoved.length ? ' (' + orphansRemoved.join(', ') + ')' : ''}`);

console.log('\n-- 3 sample records --');
for (const p of [pool[0], pool[Math.floor(pool.length / 2)], pool[pool.length - 1]]) console.log('  ' + JSON.stringify(p));
console.log('\n=====================================================\n');
