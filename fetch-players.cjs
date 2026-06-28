// fetch-players.js
// Pulls notable footballers from Wikidata, normalizes them into the Spy Game schema,
// runs the decoy-coverage validator, and writes players.json (target ~500).
//
// Run:  node fetch-players.js
// Needs Node 18+ (global fetch). No API key. Wikidata is rate-limited but fine for one run.
//
// Output schema per player:
//   { name, nationality, positions: string[], leagues: string[], era: string }

const fs = require('fs');

const ENDPOINT = 'https://query.wikidata.org/sparql';
const QUERY = fs.readFileSync(__dirname + '/players.sparql', 'utf8');
const TARGET = 300; // keep the most famous/popular players (trimmed by Wikidata notability)

// ---- Wikidata position labels -> four honest buckets ----
// Wikidata's position data is coarse: the dominant labels are the generic
// "midfielder" / "forward" / "defender", with finer distinctions (def vs att mid,
// left vs right) mostly absent. We use four buckets that map directly to the role
// the source actually records, so none is starved or guessed:
//   GK | DEF | MID | ATT   (wingers fold into ATT)
const POS_MAP = new Map(Object.entries({
  // goalkeepers
  'goalkeeper': 'GK', 'goaltender': 'GK', 'association football goalkeeper': 'GK',
  // defenders (no reliable left/right or CB/FB split in the source)
  'defender': 'DEF', 'centre-back': 'DEF', 'center-back': 'DEF', 'central defender': 'DEF',
  'full-back': 'DEF', 'fullback': 'DEF', 'full back': 'DEF',
  'right-back': 'DEF', 'right back': 'DEF', 'left-back': 'DEF', 'left back': 'DEF',
  'sweeper': 'DEF', 'stopper': 'DEF', 'wing-back': 'DEF', 'centerhalf': 'DEF',
  'centre-half': 'DEF', 'association football defender': 'DEF',
  // midfielders (incl. historical "wing half"; def/att not distinguished by source)
  'midfielder': 'MID', 'central midfielder': 'MID', 'defensive midfielder': 'MID',
  'attacking midfielder': 'MID', 'wing half': 'MID', 'playmaker': 'MID',
  'association football midfielder': 'MID',
  // attackers (forwards + wingers + inside forwards all fold in)
  'forward': 'ATT', 'centre-forward': 'ATT', 'center-forward': 'ATT',
  'striker': 'ATT', 'second striker': 'ATT', 'association football forward': 'ATT',
  'winger': 'ATT', 'left winger': 'ATT', 'right winger': 'ATT',
  'right midfielder': 'ATT', 'left midfielder': 'ATT', 'inside forward': 'ATT',
}));

// ---- leagues we care about (normalize + whitelist to keep decoy matching meaningful) ----
// Map Wikidata league labels to clean names. Unlisted leagues are kept as-is only if
// they look like a top division; otherwise dropped to avoid noise.
const LEAGUE_NORMALIZE = new Map(Object.entries({
  'Premier League': 'Premier League',
  'English Football League First Division': 'First Division',
  'Football League First Division': 'First Division',
  'La Liga': 'La Liga', 'Primera División': 'La Liga', 'Campeonato Nacional de Liga de Primera División': 'La Liga',
  'Serie A': 'Serie A',
  'Bundesliga': 'Bundesliga', 'Fußball-Bundesliga': 'Bundesliga',
  'Ligue 1': 'Ligue 1',
  'Eredivisie': 'Eredivisie',
  'Primeira Liga': 'Primeira Liga', 'Liga Portugal': 'Primeira Liga',
  'Saudi Pro League': 'Saudi Pro League', 'Saudi Professional League': 'Saudi Pro League',
  'Campeonato Brasileiro Série A': 'Campeonato Brasileiro', 'Brazilian Série A': 'Campeonato Brasileiro',
  'Major League Soccer': 'MLS',
  'North American Soccer League': 'NASL',
  'Primera División de Argentina': 'Primera División (Argentina)', 'Argentine Primera División': 'Primera División (Argentina)',
}));
const KEPT_LEAGUES = new Set(LEAGUE_NORMALIZE.values());

function eraFromBirth(iso) {
  if (!iso) return null;
  const y = new Date(iso).getUTCFullYear();
  if (Number.isNaN(y)) return null;
  // crude career-era proxy: peak ~ born + 20..32. Bucket by the decade they turned ~24.
  const peak = y + 24;
  const dec = Math.floor(peak / 10) * 10;
  return `${dec}s`;
}

function mapPositions(raw) {
  const out = new Set();
  for (const p of raw.split('|')) {
    const key = p.trim().toLowerCase();
    if (POS_MAP.has(key)) out.add(POS_MAP.get(key));
  }
  return [...out];
}

function mapLeagues(raw) {
  const out = new Set();
  for (const l of raw.split('|')) {
    const name = l.trim();
    if (LEAGUE_NORMALIZE.has(name)) out.add(LEAGUE_NORMALIZE.get(name));
  }
  return [...out];
}

async function main() {
  console.log('querying Wikidata…');
  const url = ENDPOINT + '?format=json&query=' + encodeURIComponent(QUERY);
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/sparql-results+json',
      // Wikidata asks for a descriptive UA with contact; edit this.
      'User-Agent': 'SpyGameWordBankBuilder/1.0 (your-email@example.com)',
    },
  });
  if (!res.ok) throw new Error('Wikidata HTTP ' + res.status + ' — ' + (await res.text()).slice(0, 200));
  const json = await res.json();
  const rows = json.results.bindings;
  console.log('rows returned:', rows.length);

  // DIAGNOSTIC: tally the raw position labels Wikidata returned, so we can see what
  // needs mapping. Comment out once POS_MAP is dialed in.
  const rawPosCount = {};
  for (const r of rows) {
    for (const p of (r.positions?.value || '').split('|')) {
      const k = p.trim().toLowerCase();
      if (k) rawPosCount[k] = (rawPosCount[k] || 0) + 1;
    }
  }
  const topRaw = Object.entries(rawPosCount).sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log('top raw position labels from Wikidata:');
  for (const [label, n] of topRaw) console.log(`  ${n}\t${label}${POS_MAP.has(label) ? ' -> ' + POS_MAP.get(label) : '  (UNMAPPED)'}`);

  const players = [];
  const seen = new Set();
  for (const r of rows) {
    const name = r.playerLabel?.value?.trim();
    if (!name || seen.has(name)) continue;
    // skip rows where the "name" is a bare Q-id (no English label)
    if (/^Q\d+$/.test(name)) continue;

    const positions = mapPositions(r.positions?.value || '');
    const leagues = mapLeagues(r.leagues?.value || '');
    const nationality = (r.nationalities?.value || '').split('|')[0]?.trim() || null;
    const era = eraFromBirth(r.birth?.value);
    const bornYear = r.birth?.value ? new Date(r.birth.value).getUTCFullYear() : null;

    // require nationality + position + age (leagues are optional — Wikidata's club→league
    // data is patchy and would otherwise drop stars like De Bruyne/Kane).
    if (!nationality || positions.length === 0 || !era || !bornYear) continue;

    seen.add(name);
    players.push({ name, nationality, positions, leagues, era, bornYear }); // bornYear used for recency, stripped before writing
    if (players.length >= TARGET * 4) break; // gather a big surplus so recent players can fill the bank
  }
  console.log('normalized players (pre-validation):', players.length);

  // ---- "mainly Champions League" filter ----
  // The CL is contested by clubs in the top UEFA leagues, so keep players who appear in
  // one of them. Wikidata league history is patchy (Messi shows only MLS, Ronaldo only
  // Saudi) and pre-dates some legends (Pelé), so ALSO keep the most globally famous
  // regardless of league. `players` is in sitelink (fame) order, so index ≈ fame rank.
  const EURO_LEAGUES = new Set(['Premier League', 'First Division', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Eredivisie', 'Primeira Liga']);
  const FAME_KEEP = 200; // keep the top-200 most famous regardless of (patchy) league data
  const europe = players.filter((p, idx) => idx < FAME_KEEP || p.leagues.some(l => EURO_LEAGUES.has(l)));
  console.log('after Champions-League/Europe filter:', europe.length, 'of', players.length);

  // ---- decoy-coverage validation (same permissive rule the server uses) ----
  // A candidate decoy shares the same nationality OR a position (the server then prefers
  // the strongest match). Permissive so lone-nation stars aren't dropped.
  const sharePos = (a, b) => a.positions.some(x => b.positions.includes(x));
  const isDecoy = (a, b) => a.nationality === b.nationality || sharePos(a, b);

  // Drop orphans iteratively (removing one can orphan another), until stable.
  let pool = europe;
  for (;;) {
    const kept = pool.filter(p => pool.some(q => q !== p && isDecoy(p, q)));
    if (kept.length === pool.length) break;
    pool = kept;
  }
  console.log('after orphan removal:', pool.length);

  // Favour RECENT players by birth year (a better signal than the era heuristic, which
  // misclassifies long-career stars). Always keep the top-N most famous regardless of age
  // (the GOATs/legends: Pelé, Maradona, Ronaldo…), then fill the rest with the most-notable
  // recent players. `pool` is in sitelink (fame) order.
  const FAME_ALWAYS = 80;
  const RECENT_CUTOFF = 1987; // "recent" = born this year or later (peaked ~2011+)
  const famous = pool.slice(0, FAME_ALWAYS);
  const recent = pool.slice(FAME_ALWAYS).filter(p => p.bornYear >= RECENT_CUTOFF);
  let final = [...famous, ...recent].slice(0, TARGET);

  // Re-run orphan removal on the biased subset so every player still has a valid decoy.
  for (;;) {
    const kept = final.filter(p => final.some(q => q !== p && isDecoy(p, q)));
    if (kept.length === final.length) break;
    final = kept;
  }

  const recentN = final.filter(p => p.bornYear >= RECENT_CUTOFF).length;
  for (const p of final) delete p.bornYear; // keep the stored schema clean
  fs.writeFileSync(__dirname + '/players.json', JSON.stringify(final, null, 2));
  console.log(`wrote players.json with ${final.length} players — ${recentN} born ${RECENT_CUTOFF}+ / ${final.length - recentN} older`);

  // quick coverage report
  const byPos = {};
  for (const p of final) for (const pos of p.positions) byPos[pos] = (byPos[pos] || 0) + 1;
  console.log('position coverage:', JSON.stringify(byPos));
}

main().catch(e => { console.error(e); process.exit(1); });
