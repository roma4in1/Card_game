// smoke/smoke.cjs — browser smoke test for the client (`npm run smoke`).
//
// The server games are unit-tested, but the client (src/client/app.js) has no
// coverage of its own — this harness is the regression net for it. It boots the
// real server, drives real Chrome through the actual UI, and checks that:
//
//   1. every registered game can be picked in the lobby, started (empty seats
//      filled with bots), and renders its screen without a page error;
//   2. the two physics games work end-to-end with two human players — drag to
//      aim, lock in, watch the replay (reveal ghost arrows included).
//
// Requirements: Google Chrome installed (uses playwright-core's `channel:
// 'chrome'`, no browser download). Run: `npm run smoke`.
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const PORT = 3000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { failures++; console.log(`  ❌ ${msg}`); };

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not come up');
}

function trackErrors(page, tag, errors) {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
}

async function enter(page, code, name) {
  await page.goto(`${BASE}/r/${code}`);
  await page.fill('#nameInput', name);
  await page.click('#enterBtn');
  await page.waitForSelector('#lobbyList li', { timeout: 5000 });
}

async function dragOn(page, sel, dx, dy) {
  const box = await page.locator(sel).boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 8 }); await page.mouse.up();
}

const rnd = () => Math.random().toString(36).slice(2, 6).toUpperCase();

// ── 1. Every game starts and renders (host + bots) ─────────────────────────────
async function smokeAllGames(browser, errors) {
  const page = await (await browser.newContext()).newPage();
  trackErrors(page, 'lobby', errors);
  await enter(page, 'SA' + rnd().slice(0, 2), 'Smoke');
  const names = await page.locator('.gp-card .gp-name').allTextContents();
  const metas = await page.locator('.gp-card .gp-meta').allTextContents();
  await page.close();
  console.log(`Lobby lists ${names.length} games.`);

  for (let g = 0; g < names.length; g++) {
    const name = names[g];
    const min = Number((metas[g].match(/^(\d+)/) || [0, 2])[1]);
    const errs = [];
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    trackErrors(p, name, errs);
    try {
      await enter(p, 'S' + rnd().slice(0, 3), 'Smoke');
      await p.click(`.gp-card:has(.gp-name:text-is("${name}"))`);
      await sleep(200);
      for (let i = 1; i < min; i++) { await p.click('#addBotBtn'); await sleep(120); }
      await p.click('#startBtn');
      await p.waitForSelector('#lobby.hidden', { state: 'attached', timeout: 5000 }); // left the lobby screen
      await sleep(2000); // let the game screen render (and bots act) a moment
      if (errs.length) fail(`${name}: page errors — ${errs[0]}`);
      else pass(`${name} (${min}p) starts and renders`);
    } catch (e) {
      fail(`${name}: ${String(e).split('\n')[0]}`);
    }
    errors.push(...errs);
    await ctx.close();
  }
}

// ── 2. The physics games, end to end with two humans ───────────────────────────
async function smokeIceGames(browser, errors) {
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  trackErrors(A, 'iceA', errors);
  trackErrors(B, 'iceB', errors);

  // Penguin Knockout: default aims are head-on → collision, KOs, banner
  let code = 'SP' + rnd().slice(0, 2);
  await enter(A, code, 'Host');
  await enter(B, code, 'Guest');
  await A.click('.gp-card:has(.gp-name:text-is("Penguin Knockout"))');
  await sleep(200);
  await A.click('#startBtn');
  await A.waitForSelector('.pk3d-stage', { timeout: 5000 });
  await B.waitForSelector('.pk3d-stage', { timeout: 5000 });
  await sleep(300);
  await dragOn(A, '.pk3d-stage', 80, 40); // exercise drag-aim on one client
  await A.click('.pk3d-lockbtn');
  await B.click('.pk3d-lockbtn');
  let ghosts = 0, impacts = 0, banners = 0;
  for (let t = 0; t < 60; t++) { // poll through the replay + shrink + banner
    ghosts = Math.max(ghosts, await A.locator('.pk3d-ghost').count());
    impacts = Math.max(impacts, await A.locator('.pk3d-impact').count());
    banners = Math.max(banners, await A.locator('.a3d-banner').count());
    if (banners && ghosts) break;
    await sleep(250);
  }
  (ghosts >= 2 ? pass : fail)(`Penguin Knockout: reveal ghost arrows during replay (saw ${ghosts})`);
  (banners >= 1 ? pass : fail)(`Penguin Knockout: arena banner fired (saw ${banners})`);
  console.log(`  (impact flashes seen: ${impacts} — collision-dependent, not asserted)`);

  // Ice Football: one exchange — aim, lock, replay with ghosts
  code = 'SF' + rnd().slice(0, 2);
  await enter(A, code, 'Host');
  await enter(B, code, 'Guest');
  await A.click('.gp-card:has(.gp-name:text-is("Ice Football"))');
  await sleep(200);
  await A.click('#startBtn');
  await A.waitForSelector('.if3d-stage', { timeout: 5000 });
  await B.waitForSelector('.if3d-stage', { timeout: 5000 });
  await sleep(300);
  await dragOn(A, '.if3d-stage', 120, 0);
  await A.click('.pk3d-lockbtn');
  await B.click('.pk3d-lockbtn');
  let ifGhosts = 0;
  for (let t = 0; t < 30; t++) {
    ifGhosts = Math.max(ifGhosts, await A.locator('.pk3d-ghost').count());
    if (ifGhosts >= 2) break;
    await sleep(200);
  }
  (ifGhosts >= 2 ? pass : fail)(`Ice Football: reveal ghost arrows during replay (saw ${ifGhosts})`);
  await A.close(); await B.close();
}

(async () => {
  const server = spawn('node', ['src/server.ts'], {
    cwd: `${__dirname}/..`,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    await waitForServer();
    console.log(`Server up on :${PORT}. Launching Chrome…`);
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const errors = [];
    await smokeAllGames(browser, errors);
    await smokeIceGames(browser, errors);
    await browser.close();
    if (errors.length) { console.log('\nPage errors:'); for (const e of errors) console.log('  ' + e); }
    console.log(failures || errors.length ? `\nSMOKE FAILED (${failures} failures, ${errors.length} page errors)` : '\nSMOKE PASSED');
    process.exitCode = failures || errors.length ? 1 : 0;
  } finally {
    server.kill();
  }
})().catch((e) => { console.error('SMOKE CRASHED:', e); process.exit(1); });
