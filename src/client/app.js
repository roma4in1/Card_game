// app.js — Love & Liar client. Vanilla ES module, no build step.
// The client is a thin renderer: it shows only what the server sends in its
// private "state" view and forwards user actions. It never knows the deck or
// the opponent's hidden cards.

// Hand-sign artwork matching the physical "THE RISK TAKER" cards. Each SVG
// fills with `currentColor`, so the suit colour is set via the .suit-* CSS class
// on the card. rock=red ✊, paper=yellow ✋, scissor=blue ✌️, love=green 🤟(ILY).
const SUIT_SVG = {
  rock: `<svg viewBox="0 0 100 100"><g fill="currentColor">
    <rect x="24" y="42" width="50" height="40" rx="13"/>
    <rect x="26" y="34" width="11" height="16" rx="5"/>
    <rect x="39" y="31" width="11" height="19" rx="5"/>
    <rect x="52" y="31" width="11" height="19" rx="5"/>
    <rect x="64" y="35" width="10" height="15" rx="5"/>
    <rect x="13" y="46" width="15" height="24" rx="7" transform="rotate(18 20 58)"/>
  </g></svg>`,
  paper: `<svg viewBox="0 0 100 100"><g fill="currentColor">
    <rect x="28" y="46" width="44" height="36" rx="15"/>
    <rect x="30" y="14" width="9" height="40" rx="4.5"/>
    <rect x="42" y="9" width="9" height="45" rx="4.5"/>
    <rect x="54" y="11" width="9" height="43" rx="4.5"/>
    <rect x="66" y="17" width="9" height="38" rx="4.5"/>
    <rect x="14" y="42" width="9" height="26" rx="4.5" transform="rotate(35 18 54)"/>
  </g></svg>`,
  scissor: `<svg viewBox="0 0 100 100"><g fill="currentColor">
    <rect x="30" y="48" width="42" height="34" rx="14"/>
    <rect x="34" y="10" width="9" height="46" rx="4.5" transform="rotate(-13 38 33)"/>
    <rect x="55" y="10" width="9" height="46" rx="4.5" transform="rotate(13 59 33)"/>
    <rect x="22" y="52" width="14" height="13" rx="6"/>
  </g></svg>`,
  love: `<svg viewBox="0 0 100 100"><g fill="currentColor">
    <rect x="30" y="46" width="40" height="36" rx="14"/>
    <rect x="33" y="10" width="9" height="46" rx="4.5"/>
    <rect x="58" y="16" width="9" height="40" rx="4.5"/>
    <rect x="11" y="40" width="9" height="28" rx="4.5" transform="rotate(42 15 54)"/>
    <rect x="44" y="43" width="8" height="11" rx="4"/>
    <rect x="53" y="43" width="8" height="11" rx="4"/>
  </g></svg>`,
  liar: `<svg viewBox="0 0 100 100"><g fill="currentColor">
    <rect x="30" y="50" width="40" height="34" rx="14"/>
    <rect x="20" y="52" width="15" height="13" rx="6.5"/>
    <rect x="42" y="14" width="11" height="46" rx="5.5" transform="rotate(16 47 56)"/>
    <rect x="42" y="12" width="11" height="48" rx="5.5" transform="rotate(-18 47 56)"/>
  </g></svg>`,
};
const SUIT_LABEL = {
  rock: 'Rock',
  paper: 'Paper',
  scissor: 'Scissor',
  love: 'Love',
  liar: 'Liar',
};
// A stable colour per seat so players are recognisable across the table and chat.
const SEAT_COLORS = ['#e8536b', '#2f86d6', '#5bbf3a', '#e0a01e', '#9a6cff', '#1fb6a8', '#ff7a3d', '#d65bb0'];
const seatColor = (seat) => SEAT_COLORS[seat % SEAT_COLORS.length] || '#888';
const botSeatSet = (s) => new Set((s.roster || []).filter((p) => p.bot).map((p) => p.seat));
const PHASE_LABEL = {
  lobby: 'Lobby',
  bet1: 'Betting · round 1',
  reveal: 'Reveal a card',
  discuss: 'Discussion',
  bet2: 'Betting · round 2',
  showdown: 'Showdown',
  matchover: 'Match over',
};

const $ = (id) => document.getElementById(id);

let ws = null;
let state = null;
let mySeat = 0;
let roomCode = null;
let lastRoundNo = 0;

// ---------------------------------------------------------------------------
// Routing: landing vs game
// ---------------------------------------------------------------------------

function roomFromPath() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{1,8})/);
  return m ? m[1].toUpperCase() : null;
}

// Only one .screen is ever visible at a time.
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function init() {
  const code = roomFromPath();
  if (code) {
    showGate(code);
  } else {
    showLanding();
  }
}

function showLanding() {
  showScreen('landing');
  $('createBtn').onclick = () => {
    const newCode = randomCode();
    location.href = `/r/${newCode}`;
  };
  $('joinBtn').onclick = () => {
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length >= 1) location.href = `/r/${code}`;
  };
  $('codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('joinBtn').click();
  });
}

function randomCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

function showGate(code) {
  roomCode = code;
  showScreen('gate');
  $('gateCode').textContent = code;
  const savedName = localStorage.getItem('ll_name') || '';
  $('nameInput').value = savedName;
  $('copyLinkBtn').onclick = copyInvite;
  $('enterBtn').onclick = () => {
    const name = $('nameInput').value.trim() || 'Player';
    localStorage.setItem('ll_name', name);
    connect(code, name); // render() picks the lobby/game screen from the first state
  };
  // If we already hold a token for this room, fast-path straight in.
  if (localStorage.getItem(tokenKey(code)) && savedName) {
    $('enterBtn').click();
  }
}

function tokenKey(code) {
  return `ll_token_${code}`;
}

function copyInvite() {
  const url = `${location.origin}/r/${roomCode}`;
  navigator.clipboard?.writeText(url).then(
    () => toast('Invite link copied', 'ok'),
    () => toast(url, 'ok'),
  );
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect(code, name) {
  showOverlay('Connecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    send({ type: 'join', room: code, name, token: localStorage.getItem(tokenKey(code)) || undefined });
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => {
    if (leaving) return; // we asked to leave — don't reconnect
    showOverlay('Reconnecting…');
    setTimeout(() => connect(code, name), 1500);
  };
  ws.onerror = () => {};
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function onMessage(msg) {
  switch (msg.type) {
    case 'joined':
      mySeat = msg.seat;
      roomCode = msg.room;
      localStorage.setItem(tokenKey(msg.room), msg.token);
      $('roomCode').textContent = msg.room;
      break;
    case 'state':
      hideOverlay();
      state = msg;
      render();
      break;
    case 'chat':
      addChat(msg);
      break;
    case 'error':
      toast(msg.message, 'err');
      shakeGuessInput();
      break;
    case 'full':
      hideOverlay();
      showScreen('gate');
      $('gateMsg').textContent = msg.message;
      break;
    case 'left':
      location.href = '/'; // server freed our seat — back to the landing page
      break;
    case 'kicked':
      if (roomCode) localStorage.removeItem(tokenKey(roomCode));
      toast('The host removed you from the room.', 'err');
      setTimeout(() => (location.href = '/'), 600);
      break;
  }
}

// Leave the current room: tell the server to free our seat, drop our token so we
// don't auto-rejoin, and return to the landing page.
let leaving = false;
function leaveRoom() {
  if (leaving) return;
  if (!confirm('Leave this room? A bot will take over your seat.')) return;
  leaving = true;
  if (roomCode) localStorage.removeItem(tokenKey(roomCode));
  send({ type: 'leave' });
  setTimeout(() => (location.href = '/'), 200); // fallback if no 'left' arrives
}

// Leave the current game but stay in the room: a bot finishes your seat and you wait
// in this room's lobby (same code) until the match ends. No navigation — the server
// switches you to the lobby view.
function backToLobby() {
  if (!confirm('Leave this game and go back to the lobby? A bot will finish your seat.')) return;
  send({ type: 'backToLobby' });
}

// Host removes a player or bot from the lobby.
function kickSeat(seat, name) {
  if (!confirm(`Remove ${name} from the room?`)) return;
  send({ type: 'kick', target: seat });
}

// End-of-match buttons: the host can replay the same game instantly, and anyone can
// return to the lobby to pick something else.
function appendEndButtons(box, s) {
  if (s.youAreHost) box.appendChild(actBtn('🔄 Play again', 'btn btn-primary btn-lg', () => send({ type: 'restart' })));
  box.appendChild(actBtn('Back to lobby', s.youAreHost ? 'btn btn-quiet btn-lg' : 'btn btn-primary btn-lg', () => send({ type: 'rematch' })));
}

// ---------------------------------------------------------------------------
// Player card (FUT/Panini) — shared by the football games
// ---------------------------------------------------------------------------
const COUNTRY_ISO = {
  Algeria: 'DZ', Argentina: 'AR', Austria: 'AT', Belgium: 'BE', 'Bosnia-Herzegovina': 'BA', Brazil: 'BR', Bulgaria: 'BG',
  'Burkina Faso': 'BF', Cameroon: 'CM', Canada: 'CA', Chile: 'CL', Colombia: 'CO', 'Costa Rica': 'CR', "Cote d'Ivoire": 'CI',
  Croatia: 'HR', 'Czech Republic': 'CZ', 'DR Congo': 'CD', Denmark: 'DK', Ecuador: 'EC', Egypt: 'EG', France: 'FR', Georgia: 'GE',
  Germany: 'DE', Ghana: 'GH', Greece: 'GR', Guinea: 'GN', Hungary: 'HU', Iceland: 'IS', Ireland: 'IE', Italy: 'IT', Japan: 'JP',
  'Korea, South': 'KR', Kosovo: 'XK', Liberia: 'LR', Mali: 'ML', Mexico: 'MX', Montenegro: 'ME', Morocco: 'MA', Netherlands: 'NL',
  Nigeria: 'NG', Norway: 'NO', Panama: 'PA', Paraguay: 'PY', Poland: 'PL', Portugal: 'PT', Russia: 'RU', Senegal: 'SN', Serbia: 'RS',
  Slovakia: 'SK', Slovenia: 'SI', Spain: 'ES', Sweden: 'SE', Switzerland: 'CH', 'The Gambia': 'GM', 'Türkiye': 'TR', Ukraine: 'UA',
  'United States': 'US', Uruguay: 'UY', Uzbekistan: 'UZ',
};
const COUNTRY_FLAG_SPECIAL = {
  England: '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  Scotland: '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  Wales: '🏴\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
  'Northern Ireland': '🇬🇧',
};
function flagEmoji(country) {
  if (COUNTRY_FLAG_SPECIAL[country]) return COUNTRY_FLAG_SPECIAL[country];
  const iso = COUNTRY_ISO[country];
  return iso ? iso.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0))) : '🏳️';
}
const LEAGUE_SHORT = { 'Premier League': 'PL', 'La Liga': 'La Liga', 'Serie A': 'Serie A', Bundesliga: 'Bundesliga', 'Ligue 1': 'Ligue 1', Eredivisie: 'Eredivisie', 'Primeira Liga': 'Primeira', 'First Division': 'First Div' };
function pcTier(p) {
  if (p.status === 'retired' || p.marketValue == null) return { cls: 'icon', label: 'ICON' };
  const m = p.marketValue;
  if (m >= 120e6) return { cls: 'special', label: 'TOP' };
  if (m >= 60e6) return { cls: 'gold', label: 'GOLD' };
  if (m >= 25e6) return { cls: 'silver', label: 'SILVER' };
  return { cls: 'bronze', label: 'BRONZE' };
}
function playerCardEl(p, opts = {}) {
  const t = pcTier(p);
  const el = document.createElement('div');
  el.className = 'pcard ' + t.cls + (opts.small ? ' sm' : '') + (opts.pop ? ' pop' : '') + (p.imageUrl ? ' has-photo' : '');
  const val = p.marketValue == null ? '—' : '€' + Math.round(p.marketValue / 1e6) + 'm';
  const league = (p.leagues && p.leagues[0] && (LEAGUE_SHORT[p.leagues[0]] || p.leagues[0])) || (p.status === 'retired' ? 'Legend' : '—');
  // The portrait is hotlinked; on a load error we drop the class so the gradient card shows.
  const photo = p.imageUrl
    ? `<img class="pc-photo" src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.pcard').classList.remove('has-photo'); this.remove();">`
    : '';
  el.innerHTML =
    photo +
    `<div class="pc-fg">` +
      `<div class="pc-top"><div class="pc-col">` +
        `<div class="pc-pos">${escapeHtml((p.positions && p.positions[0]) || '?')}</div>` +
        `<div class="pc-flag" title="${escapeHtml(p.nationality)}">${flagEmoji(p.nationality)}</div>` +
        `<div class="pc-league">${escapeHtml(league)}</div>` +
      `</div><div class="pc-tier">${t.label}</div></div>` +
      `<div class="pc-name">${escapeHtml(p.name)}</div>` +
      `<div class="pc-div"></div>` +
      `<div class="pc-stats">` +
        `<span class="pc-stat"><b>${escapeHtml(val)}</b><i>value</i></span>` +
        `<span class="pc-stat"><b>${escapeHtml(p.eraOfPlay || '—')}</b><i>era</i></span>` +
        `<span class="pc-stat"><b>${escapeHtml(p.nationality)}</b><i>nation</i></span>` +
      `</div>` +
    `</div>`;
  return el;
}
function labeledCard(tag, p, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'pcard-wrap';
  if (tag) { const t = document.createElement('div'); t.className = 'pcard-tag'; t.textContent = tag; wrap.appendChild(t); }
  wrap.appendChild(playerCardEl(p, opts));
  return wrap;
}

// FIFA-style "pack walkout": a full-screen reveal whose drama scales with the player's
// rarity tier (bronze → silver → gold → TOP → ICON). Pure CSS/SVG, auto-dismisses.
let _walkoutActive = false;
let _lastWalkoutKey = null;
function playerWalkout(p) {
  if (_walkoutActive || !p) return;
  _walkoutActive = true;
  const t = pcTier(p);
  const big = t.cls === 'gold' || t.cls === 'special' || t.cls === 'icon';
  const ov = document.createElement('div');
  ov.className = 'walkout tier-' + t.cls;
  const beams = t.cls === 'bronze' ? '' :
    `<div class="wo-beams">${Array.from({ length: 12 }, (_, i) => `<span style="--a:${i * 30}deg"></span>`).join('')}</div>`;
  const nSpark = t.cls === 'bronze' ? 0 : t.cls === 'silver' ? 12 : big ? 26 : 16;
  const sparks = `<div class="wo-sparks">${Array.from({ length: nSpark }, () => {
    const x = (Math.random() * 100).toFixed(1), y = (40 + Math.random() * 60).toFixed(1);
    const d = (Math.random() * 1.1).toFixed(2), sc = (0.5 + Math.random() * 0.9).toFixed(2);
    return `<span style="left:${x}%;top:${y}%;--d:${d}s;--sc:${sc}"></span>`;
  }).join('')}</div>`;
  ov.innerHTML = `<div class="wo-flash"></div><div class="wo-glow"></div>${beams}<div class="wo-stage"></div>${sparks}<div class="wo-hint">tap to continue</div>`;
  const card = playerCardEl(p, {});
  card.classList.add('wo-card');
  ov.querySelector('.wo-stage').appendChild(card);
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('show'));
  let done = false;
  const close = () => {
    if (done) return; done = true;
    ov.classList.add('out');
    setTimeout(() => { ov.remove(); _walkoutActive = false; }, 420);
  };
  ov.addEventListener('click', close);
  setTimeout(close, big ? 4600 : t.cls === 'bronze' ? 2400 : 3600);
}

// Win confetti (skips under reduced-motion)
function fireConfetti() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#f5c451', '#ff5d8f', '#34d399', '#5b9bf0', '#cf6ad0', '#ffd877'];
  for (let i = 0; i < 90; i++) {
    const s = document.createElement('i');
    s.style.left = Math.random() * 100 + 'vw';
    s.style.background = colors[i % colors.length];
    s.style.animationDuration = 2 + Math.random() * 1.6 + 's';
    s.style.animationDelay = Math.random() * 0.35 + 's';
    s.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
    box.appendChild(s);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4400);
}
// Nudge the active guess input on a rejected action (e.g. "not a real player").
function shakeGuessInput() {
  const el = document.querySelector('#gpGuessInput, #waGuessInput, #sgGuessInput');
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth; // restart the animation
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 450);
}

let _lastConfettiKey = '';
function maybeConfetti(s) {
  const won = !!s.over && ((Array.isArray(s.winners) && s.winners.includes(s.seat)) || s.matchWinner === s.seat);
  if (!s.over) { _lastConfettiKey = ''; return; }
  const key = s.room + ':' + s.gameId;
  if (won && key !== _lastConfettiKey) { _lastConfettiKey = key; fireConfetti(); }
}

// ---------------------------------------------------------------------------
// Turn alerts — buzz / chime / tab-title flash when it becomes your turn
// ---------------------------------------------------------------------------
let _soundOff = localStorage.getItem('soundOff') === '1';
let _wasMyTurn = false;
let _audioCtx = null;
function unlockAudio() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
  } catch { /* no audio */ }
}
window.addEventListener('pointerdown', unlockAudio); // browsers need a gesture to start audio
function chime() {
  if (_soundOff || !_audioCtx) return;
  const t0 = _audioCtx.currentTime;
  [880, 1320].forEach((f, i) => {
    const o = _audioCtx.createOscillator();
    const g = _audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = t0 + i * 0.11;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(_audioCtx.destination);
    o.start(t);
    o.stop(t + 0.2);
  });
}
const _origTitle = document.title;
function flashTitle(on) { document.title = on ? '🔔 Your turn!' : _origTitle; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) flashTitle(false); });

function myTurnNow(s) {
  if (!s || s.over || s.phase === 'lobby' || s.phase === 'done' || s.phase === 'roundOver') return false;
  const y = s.you || {};
  if (y.isTurn || y.yourTurn || y.canFlip) return true;
  if (s.turn && s.turn.yourTurn) return true;
  if (s.betting && s.betting.yourTurn) return true;
  if (typeof s.activeSeat === 'number' && s.activeSeat === s.seat) return true;
  return false;
}
function maybeTurnAlert(s) {
  const mine = myTurnNow(s);
  if (mine && !_wasMyTurn) {
    // rising edge — it just became your turn
    if (!_soundOff) {
      try { if (navigator.vibrate) navigator.vibrate(60); } catch { /* ignore */ }
      chime();
    }
    if (document.hidden) flashTitle(true);
  }
  if (!mine) flashTitle(false);
  _wasMyTurn = mine;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cardEl(card, opts = {}) {
  const el = document.createElement('div');
  el.className = 'card';
  if (!card) {
    el.classList.add('back');
    return el;
  }
  el.classList.add('suit-' + card.suit);
  if (opts.win) el.classList.add('win');
  el.innerHTML =
    '<span class="brand">THE RISK TAKER</span>' +
    `<span class="sign">${SUIT_SVG[card.suit] || ''}</span>` +
    '<span class="brand bot">THE RISK TAKER</span>';
  return el;
}

let shownScreen = null;
function ensureScreen(id) {
  if (shownScreen !== id) {
    showScreen(id);
    shownScreen = id;
  }
}

// Per-turn countdown chip. Skew-free: we restart a local count from `secs` each time the
// server arms a new `deadline` (the value just signals "a fresh turn started").
let _timerInterval = null;
let _timerDeadline = 0;
function updateTurnTimer(s) {
  const chip = $('turnTimer');
  const t = s && !s.over && s.phase !== 'lobby' && s.phase !== 'done' ? s.timer : null;
  if (!t || !t.deadline) {
    chip.classList.add('hidden');
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    _timerDeadline = 0;
    return;
  }
  if (t.deadline === _timerDeadline) return; // same turn — local countdown already running
  _timerDeadline = t.deadline;
  if (_timerInterval) clearInterval(_timerInterval);
  const start = Date.now();
  const tickDisplay = () => {
    const remain = Math.max(0, Math.ceil(t.secs - (Date.now() - start) / 1000));
    chip.textContent = '⏱ ' + remain + 's';
    chip.classList.toggle('urgent', remain <= 5);
    chip.classList.remove('hidden');
    if (remain <= 0 && _timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  };
  tickDisplay();
  _timerInterval = setInterval(tickDisplay, 250);
}

function render() {
  if (!state) return;
  const s = state;
  renderPlayersSheet(); // keep the players panel fresh if it's open (any screen)
  updateTurnTimer(s); // drive the per-turn countdown chip
  maybeConfetti(s); // celebrate a win once
  maybeTurnAlert(s); // buzz/chime/flash when it becomes your turn
  if (s.phase === 'lobby') {
    ensureScreen('lobby');
    renderLobby(s);
    return;
  }
  if (s.gameId === 'lock-in') {
    ensureScreen('lockin');
    renderLockIn(s);
    return;
  }
  if (s.gameId === 'yahtzee') {
    ensureScreen('yahtzee');
    renderYahtzee(s);
    return;
  }
  if (s.gameId === 'spy-game') {
    ensureScreen('spygame');
    renderSpyGame(s);
    return;
  }
  if (s.gameId === 'codenames') {
    ensureScreen('codenames');
    renderCodenames(s);
    return;
  }
  if (s.gameId === 'quoridor') {
    ensureScreen('quoridor');
    renderQuoridor(s);
    return;
  }
  if (s.gameId === 'tectonic') {
    ensureScreen('tectonic');
    renderTectonic(s);
    return;
  }
  if (s.gameId === 'manhunt') {
    ensureScreen('manhunt');
    renderManhunt(s);
    return;
  }
  if (s.gameId === 'three-fronts') {
    ensureScreen('threefronts');
    renderThreeFronts(s);
    return;
  }
  if (s.gameId === 'salvo') {
    ensureScreen('salvo');
    renderSalvo(s);
    return;
  }
  if (s.gameId === 'sealed-bids') {
    ensureScreen('sealedbids');
    renderSealedBids(s);
    return;
  }
  if (s.gameId === 'memory-match') {
    ensureScreen('memorymatch');
    renderMemoryMatch(s);
    return;
  }
  if (s.gameId === 'who-am-i') {
    ensureScreen('whoami');
    renderWhoAmI(s);
    return;
  }
  if (s.gameId === 'guess-player') {
    ensureScreen('guessplayer');
    renderGuessPlayer(s);
    return;
  }
  if (s.gameId === 'penguin-knockout') {
    ensureScreen('penguinknockout');
    renderPenguinKnockout(s);
    return;
  }
  if (s.gameId === 'ice-football') {
    ensureScreen('icefootball');
    renderIceFootball(s);
    return;
  }
  ensureScreen('game');
  maybeNotify(s);

  $('roomCode').textContent = s.room;
  $('phaseChip').textContent = PHASE_LABEL[s.phase] || s.phase;
  $('copyLink2').onclick = copyInvite;

  animateNumber($('pot'), s.pot);
  $('carry').textContent = s.carry ? `+${s.carry}` : '';
  if (s.deckCount != null) {
    $('deckBadge').style.display = '';
    animateNumber($('deckCount'), s.deckCount);
  } else {
    $('deckBadge').style.display = 'none';
  }
  document.body.classList.toggle('your-turn', !!(s.betting && s.betting.yourTurn));

  renderShared(s);
  renderSeats(s);
  renderYourHand(s);
  renderTurnFlag(s);
  renderActions(s);
  renderLog(s);
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function renderLobby(s) {
  $('lobbyCode').textContent = s.room;
  $('lobbyInvite').onclick = copyInvite;
  const lob = s.lobby || {};
  const canKick = !!lob.canKick;
  const list = $('lobbyList');
  list.innerHTML = '';
  s.roster.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'lobby-row';
    li.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(p.seat)}">${initial(p.name)}</span>` +
      `<span class="lobby-name">${escapeHtml(p.name)}${p.seat === s.seat ? ' (you)' : ''}</span>` +
      (p.host ? '<span class="badge b-host">host</span>' : '') +
      (p.bot ? '<span class="badge b-bot">🤖 bot</span>' : '') +
      `<i class="dot ${p.connected ? 'on' : ''}"></i>`;
    // Host can remove anyone else (humans and bots).
    if (canKick && !p.host && p.seat !== s.seat) {
      const x = document.createElement('button');
      x.className = 'lobby-kick';
      x.title = `Remove ${p.name}`;
      x.textContent = '✕';
      x.onclick = () => kickSeat(p.seat, p.name);
      li.appendChild(x);
    }
    list.appendChild(li);
  });
  renderGamePicker(s);

  const start = $('startBtn');
  const addBot = $('addBotBtn');
  if (lob.matchInProgress) {
    // You stepped out and are waiting in the lobby while the others finish the match.
    start.style.display = 'none';
    addBot.style.display = 'none';
    $('lobbyMsg').textContent = 'A match is in progress — you’ll rejoin the lobby when it ends.';
  } else if (s.youAreHost) {
    const need = (lob.minPlayers ?? 2);
    const short = s.roster.length < need;
    start.style.display = '';
    start.disabled = short;
    start.textContent = short ? 'Waiting for players…' : `Start game (${s.roster.length})`;
    start.onclick = () => send({ type: 'start' });
    // Fill empty seats with AI players (every game ships a bot brain).
    const sel = (lob.games || []).find((g) => g.id === lob.selectedGame);
    addBot.style.display = sel && s.roster.length < sel.maxPlayers ? '' : 'none';
    addBot.onclick = () => send({ type: 'addBot' });
    $('lobbyMsg').textContent = short ? (need <= 1 ? 'Add players, or start solo.' : 'Share the invite link to add players, or fill seats with bots.') : '';
  } else {
    start.style.display = 'none';
    addBot.style.display = 'none';
    $('lobbyMsg').textContent = 'Waiting for the host to start…';
  }
}

// Host chooses which game the room will play; others see the selection.
function renderGamePicker(s) {
  const box = $('gamePicker');
  const lob = s.lobby || {};
  const games = lob.games || [];
  box.innerHTML = '';
  if (games.length <= 1) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  const title = document.createElement('div');
  title.className = 'gp-title';
  title.textContent = s.youAreHost ? 'Choose a game' : 'Game';
  box.appendChild(title);
  games.forEach((g) => {
    const card = document.createElement('button');
    card.className = 'gp-card' + (g.id === lob.selectedGame ? ' sel' : '');
    card.innerHTML =
      `<div class="gp-name">${escapeHtml(g.name)}</div>` +
      `<div class="gp-blurb">${escapeHtml(g.blurb)}</div>` +
      `<div class="gp-meta">${g.minPlayers}–${g.maxPlayers} players</div>`;
    if (s.youAreHost) card.onclick = () => send({ type: 'selectGame', gameId: g.id });
    else card.disabled = true;
    box.appendChild(card);
  });

  // Settings for the selected game (host can adjust; others see them read-only).
  const sel = games.find((g) => g.id === lob.selectedGame);
  const specs = (sel && sel.options) || [];
  const values = lob.options || {};
  specs.forEach((opt) => {
    const cur = values[opt.key] != null ? values[opt.key] : opt.default;
    const row = document.createElement('div');
    row.className = 'gp-option';
    row.innerHTML = `<span class="gp-optlbl">${escapeHtml(opt.label)}</span>`;
    if (s.youAreHost) {
      const step = opt.step || 1;
      const stepper = document.createElement('div');
      stepper.className = 'gp-stepper';
      const dec = actBtn('−', 'gp-step', () => send({ type: 'setOption', key: opt.key, value: Math.max(opt.min, cur - step) }));
      const inc = actBtn('+', 'gp-step', () => send({ type: 'setOption', key: opt.key, value: Math.min(opt.max, cur + step) }));
      dec.disabled = cur <= opt.min;
      inc.disabled = cur >= opt.max;
      const val = document.createElement('span');
      val.className = 'gp-optval';
      val.textContent = String(cur);
      stepper.append(dec, val, inc);
      row.appendChild(stepper);
    } else {
      const val = document.createElement('span');
      val.className = 'gp-optval';
      val.textContent = String(cur);
      row.appendChild(val);
    }
    box.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Lock In — press-your-luck dice game
// ---------------------------------------------------------------------------

function renderLockIn(s) {
  $('liRoom').textContent = s.room;
  $('liRound').textContent = s.over ? 'Final' : `Round ${s.round}/${s.rounds}`;
  $('liCopy').onclick = copyInvite;
  renderLIBoard(s);
  renderLITable(s);
  renderLIActions(s);
  renderLILog(s);
}

function renderLIBoard(s) {
  const box = $('liBoard');
  const bots = botSeatSet(s);
  box.innerHTML = '';
  (s.players || []).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'li-prow' + (p.isTurn ? ' acting' : '') + (p.seat === s.seat ? ' you' : '');
    row.style.borderLeftColor = seatColor(p.seat);
    row.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(p.seat)}">${initial(p.name)}</span>` +
      `<span class="li-pname">${escapeHtml(p.name)}${p.seat === s.seat ? ' (you)' : ''}${bots.has(p.seat) ? ' 🤖' : ''}<i class="dot ${p.connected ? 'on' : ''}"></i></span>` +
      `<span class="li-score">${p.score}<small>pts</small></span>` +
      `<span class="li-chips">` +
      `<span class="z play" title="Play area (spendable, +2 pts each at the end)">▮ ${p.playArea}</span>` +
      `<span class="z res" title="Reserve (earned into play by setting aside all 9)">🔒 ${p.reserve}</span>` +
      `<span class="z dis" title="Discard (earn chips back from here)">♻ ${p.discard}</span>` +
      `</span>`;
    box.appendChild(row);
  });
}

function renderLITable(s) {
  const t = s.turn;
  const info = $('liTurnInfo');
  if (s.over) {
    info.innerHTML = '<div class="li-whose">Game over</div>';
  } else {
    const whose = t.yourTurn ? 'Your turn' : `${t.seat === s.seat ? 'You' : escapeHtml(t.name)}'s turn`;
    info.innerHTML =
      `<div class="li-whose ${t.yourTurn ? 'you' : ''}">${whose}</div>` +
      `<div class="li-target">${t.target ? `Target <b class="tnum">${t.target}</b>` : 'Pick a target number'}` +
      `<span class="li-aside">Set aside <b>${t.setAside}</b>/9</span></div>`;
  }
  renderLIDice(s);

  // Fill the set-aside track in sync with the dice: when a roll locks a die we
  // hold the newest pip back until the die actually lands (afterDiceLand fills it).
  const newTurn = t.seat !== liAside.seat;
  const increased = !newTurn && t.setAside === liAside.shown + 1;
  if (increased && liTumbling) renderAsideTrack(t.setAside - 1, false);
  else renderAsideTrack(t.setAside, increased);
  liAside = { seat: t.seat, shown: t.setAside };
}

let liAside = { seat: -1, shown: 0 };
function renderAsideTrack(count, justPop) {
  const track = $('liSetAside');
  track.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const pip = document.createElement('span');
    pip.className = 'aside-pip' + (i < count ? ' on' : '');
    if (justPop && i === count - 1) pip.classList.add('just');
    track.appendChild(pip);
  }
}

let liDiceSig = '';
let liDiceTimers = [];
let liTumbling = false;
function clearLIDiceAnim() {
  liDiceTimers.forEach((t) => {
    clearInterval(t);
    clearTimeout(t);
  });
  liDiceTimers = [];
}

const SPIN_MS = 540; // how long the whole set of dice tumbles before settling
const SETTLE_STAGGER = 75; // dice land left-to-right for a cascade feel

function renderLIDice(s) {
  const t = s.turn;
  const dl = $('liDice');
  const dice = t.dice || [];
  const valsSig = dice.join(',') + '|' + t.seat; // changes only on an actual roll
  const fullSig = valsSig + '|' + (t.target || 0) + '|' + t.setAside;
  if (fullSig === liDiceSig) return;
  // A fresh roll = the dice values changed (a pick keeps the same 9 faces).
  const isRoll = liDiceSig !== '' && liDiceSig.split('|').slice(0, 2).join('|') !== valsSig;
  liDiceSig = fullSig;

  clearLIDiceAnim();
  dl.innerHTML = '';
  const els = dice.map((v) => {
    const die = document.createElement('div');
    die.className = 'li-die';
    setDie(die, v);
    dl.appendChild(die);
    return { die, v };
  });

  const settle = (e) => {
    e.die.classList.remove('rolling');
    setDie(e.die, e.v);
    e.die.classList.add('land');
    if (t.target && e.v === t.target) e.die.classList.add('hit');
  };

  if (!isRoll) {
    // First paint or a target lock — no tumble, just mark matches (with a pop on pick).
    els.forEach((e) => {
      if (t.target && e.v === t.target) {
        e.die.classList.add('hit');
        if (t.setAside) e.die.classList.add('lockpop');
      }
    });
    return;
  }

  // Tumble: every die spins through random faces, then they settle one by one.
  liTumbling = true;
  els.forEach((e) => e.die.classList.add('rolling'));
  const spin = setInterval(() => {
    for (const e of els) setDie(e.die, 1 + Math.floor(Math.random() * 6));
  }, 65);
  liDiceTimers.push(spin);

  liDiceTimers.push(
    setTimeout(() => {
      clearInterval(spin);
      els.forEach((e, i) => liDiceTimers.push(setTimeout(() => settle(e), i * SETTLE_STAGGER)));
      const after = els.length * SETTLE_STAGGER + 120;
      liDiceTimers.push(setTimeout(() => afterDiceLand(s), after));
    }, SPIN_MS),
  );
}

// Tactile payoff once the dice have settled: glow the locked die, react to a
// bust, and surface an earned chip.
function afterDiceLand(s) {
  const t = s.turn;
  liTumbling = false;
  // The opening 9-dice roll has no target chosen yet — it's never a bust.
  if (t.target === null || t.phase === 'pick') return;
  // Fill the pip for the die that just landed (held back during the tumble).
  if (t.matches >= 1 && t.setAside > 0) renderAsideTrack(t.setAside, true);
  if (t.matches === 0) {
    const stage = document.querySelector('.li-stage');
    if (stage) {
      stage.classList.remove('shake');
      void stage.offsetWidth;
      stage.classList.add('shake');
    }
    if (t.yourTurn) toast('No match — reroll or bank', 'err');
  } else if (t.earnedThisRoll) {
    toast('💰 Chip earned — into your play area', 'ok');
  } else if (t.setAside === 9) {
    toast(t.chipsSpent === 0 ? '✨ Perfect run!' : '🎯 All nine locked!', 'ok');
  }
}

function renderLIActions(s) {
  const area = $('liActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(renderLIOver(s));
    return;
  }
  const t = s.turn;
  if (!t.yourTurn) {
    area.appendChild(callout(`Waiting for ${t.seat === s.seat ? 'you' : escapeHtml(t.name)} to play`, true));
    return;
  }
  if (t.canPick) {
    area.appendChild(prompt('Lock a <b>target number</b> from your roll — you set aside one of it each roll.'));
    const row = document.createElement('div');
    row.className = 'btn-row li-picks';
    const present = [...new Set(t.dice)].sort((a, b) => a - b);
    present.forEach((v) => {
      const count = t.dice.filter((d) => d === v).length;
      const b = actBtn('', 'btn btn-neutral li-pick', () => { tapAck(b); send({ type: 'pick', target: v }); });
      b.innerHTML = `<b class="pn">${v}</b><small>×${count}</small>`;
      row.appendChild(b);
    });
    area.appendChild(row);
    return;
  }
  if (t.phase === 'zero') {
    area.appendChild(prompt(`No <b>${t.target}</b> rolled. Spend a chip to reroll, or bank <b>${t.setAside}</b>.`));
  } else {
    area.appendChild(prompt(`<b>${t.setAside}</b>/9 set aside on <b>${t.target}</b>. Press your luck or bank it.`));
  }
  const row = document.createElement('div');
  row.className = 'btn-row';
  if (t.canRoll) row.appendChild(actBtn('🎲 Roll again', 'btn btn-good', () => send({ type: 'roll' })));
  if (t.canReroll) row.appendChild(actBtn('♻ Reroll · −1 chip', 'btn btn-gold', () => send({ type: 'reroll' })));
  if (t.canStop) row.appendChild(actBtn(`Bank ${t.setAside} pts`, 'btn btn-bad', () => send({ type: 'stop' })));
  area.appendChild(row);
}

function renderLIOver(s) {
  const box = document.createElement('div');
  box.className = 'result';
  const youWin = (s.winners || []).includes(s.seat);
  const shared = (s.winners || []).length > 1;
  const names = (s.winners || []).map((seat) => (seat === s.seat ? 'You' : nameForSeat(s, seat))).join(', ');
  box.appendChild(
    banner(youWin ? (shared ? '🤝 Shared win!' : '🏆 You win!') : `${names} win${shared ? '' : 's'}`, youWin ? 'win' : 'lose'),
  );

  const tbl = document.createElement('div');
  tbl.className = 'li-finals';
  (s.finals || []).forEach((f) => {
    const row = document.createElement('div');
    row.className = 'li-frow' + ((s.winners || []).includes(f.seat) ? ' win' : '');
    row.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(f.seat)}">${initial(nameForSeat(s, f.seat))}</span>` +
      `<span class="li-fname">${f.seat === s.seat ? 'You' : escapeHtml(nameForSeat(s, f.seat))}</span>` +
      `<span class="li-fbreak">${f.score} pts + ${f.bonus} chips</span>` +
      `<span class="li-ftotal">${f.total}</span>`;
    tbl.appendChild(row);
  });
  box.appendChild(tbl);
  appendEndButtons(box, s);
  return box;
}

function renderLILog(s) {
  const ul = $('liLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Yahtzee — 5-dice scorecard game
// ---------------------------------------------------------------------------

const YZ_ROWS = [
  { type: 'head', label: 'Upper section' },
  { type: 'cat', cat: 'ones', label: 'Ones' },
  { type: 'cat', cat: 'twos', label: 'Twos' },
  { type: 'cat', cat: 'threes', label: 'Threes' },
  { type: 'cat', cat: 'fours', label: 'Fours' },
  { type: 'cat', cat: 'fives', label: 'Fives' },
  { type: 'cat', cat: 'sixes', label: 'Sixes' },
  { type: 'sub', key: 'upper', label: 'Upper total' },
  { type: 'sub', key: 'upperBonus', label: 'Bonus (63+ → 35)' },
  { type: 'head', label: 'Lower section' },
  { type: 'cat', cat: 'threeOfAKind', label: '3 of a kind' },
  { type: 'cat', cat: 'fourOfAKind', label: '4 of a kind' },
  { type: 'cat', cat: 'fullHouse', label: 'Full house' },
  { type: 'cat', cat: 'smallStraight', label: 'Sm. straight' },
  { type: 'cat', cat: 'largeStraight', label: 'Lg. straight' },
  { type: 'cat', cat: 'yahtzee', label: 'Yahtzee' },
  { type: 'cat', cat: 'chance', label: 'Chance' },
  { type: 'sub', key: 'yBonus', label: 'Yahtzee bonus' },
  { type: 'sub', key: 'grand', label: 'Grand total' },
];

// Plain-language definition for each scorecard row (shown on hover / tap).
const YZ_DESC = {
  ones: 'Sum of all dice showing 1.',
  twos: 'Sum of all dice showing 2.',
  threes: 'Sum of all dice showing 3.',
  fours: 'Sum of all dice showing 4.',
  fives: 'Sum of all dice showing 5.',
  sixes: 'Sum of all dice showing 6.',
  threeOfAKind: 'Three or more of a kind — scores the sum of all five dice.',
  fourOfAKind: 'Four or more of a kind — scores the sum of all five dice.',
  fullHouse: 'Three of one number and two of another — 25 points.',
  smallStraight: 'Four in a row (e.g. 2-3-4-5) — 30 points.',
  largeStraight: 'Five in a row (1-2-3-4-5 or 2-3-4-5-6) — 40 points.',
  yahtzee: 'All five dice the same — 50 points.',
  chance: 'Any dice at all — scores the sum of all five.',
  upper: 'Sum of Ones through Sixes.',
  upperBonus: 'Score 63+ in the upper section to earn a +35 bonus.',
  yBonus: '+100 for each extra Yahtzee rolled after your first scored a 50.',
  grand: 'Final score: upper total + bonus + lower total + Yahtzee bonuses.',
};

function renderYahtzee(s) {
  $('yzRoom').textContent = s.room;
  $('yzRound').textContent = s.over ? 'Final' : `Round ${s.round}/${s.rounds}`;
  $('yzCopy').onclick = copyInvite;
  renderYzTurn(s);
  renderYzDice(s);
  renderYzActions(s);
  renderYzCard(s);
  renderYzLog(s);
}

function renderYzTurn(s) {
  const t = s.turn;
  const el = $('yzTurn');
  if (s.over) {
    el.innerHTML = '<div class="li-whose">Game over</div>';
    return;
  }
  const whose = t.yourTurn ? 'Your turn' : `${t.seat === s.seat ? 'You' : escapeHtml(t.name)}'s turn`;
  el.innerHTML =
    `<div class="li-whose ${t.yourTurn ? 'you' : ''}">${whose}</div>` +
    `<div class="yz-sub">Roll <b>${t.rollsUsed}</b>/3${t.bonusReady ? ' · <b class="yz-bonusflag">🎲 Yahtzee bonus +100 ready!</b>' : ''}</div>`;
}

let yzRollKey = '';
let yzRolling = false; // dice mid-tumble — hide previews so they can't contradict the dice
let yzTimers = [];
function clearYzAnim() {
  yzTimers.forEach((t) => {
    clearInterval(t);
    clearTimeout(t);
  });
  yzTimers = [];
}
function renderYzDice(s) {
  const t = s.turn;
  const box = $('yzDice');
  // Every distinct roll (including each turn's first roll, even for the same
  // player in a solo game) has a unique seat:round:rollNo key. A hold-toggle
  // keeps the same key, so it re-renders without re-tumbling.
  const rollKey = `${t.seat}:${s.round}:${t.rollsUsed}`;
  const rolled = !s.over && yzRollKey !== rollKey;
  yzRollKey = rollKey;
  clearYzAnim();
  box.innerHTML = '';
  const els = (t.dice || []).map((v, i) => {
    const die = document.createElement('div');
    die.className = 'li-die yz-die' + (t.kept[i] ? ' kept' : '');
    setDie(die, v);
    if (t.yourTurn && t.rollsUsed < 3 && !s.over) {
      die.classList.add('tappable');
      // Optimistic: flip the hold highlight instantly so a tap feels immediate; the
      // authoritative server state reconciles on the next render (it will match).
      die.onclick = () => { die.classList.toggle('kept'); send({ type: 'hold', index: i }); };
    }
    box.appendChild(die);
    return { die, v, kept: t.kept[i] };
  });
  if (!rolled) {
    yzRolling = false;
    return;
  }
  // Tumble only the dice that were actually rerolled (the un-kept ones).
  const moving = els.filter((e) => !e.kept);
  if (moving.length === 0) {
    yzRolling = false;
    return;
  }
  yzRolling = true; // previews stay hidden until these land (see renderYzCard)
  moving.forEach((e) => e.die.classList.add('rolling'));
  const spin = setInterval(() => {
    for (const e of moving) setDie(e.die, 1 + Math.floor(Math.random() * 6));
  }, 60);
  yzTimers.push(spin);
  yzTimers.push(
    setTimeout(() => {
      clearInterval(spin);
      moving.forEach((e, k) =>
        yzTimers.push(
          setTimeout(() => {
            e.die.classList.remove('rolling');
            setDie(e.die, e.v);
            e.die.classList.add('land');
          }, k * 60),
        ),
      );
      // Once the last die has landed, reveal the (now-matching) previews.
      yzTimers.push(
        setTimeout(() => {
          yzRolling = false;
          if (state && state.gameId === 'yahtzee' && !state.over) {
            renderYzCard(state);
            renderYzActions(state);
          }
        }, moving.length * 60 + 90),
      );
    }, 420),
  );
}

function renderYzActions(s) {
  const area = $('yzActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(renderYzOver(s));
    return;
  }
  const t = s.turn;
  if (!t.yourTurn) {
    area.appendChild(callout(`Waiting for ${t.seat === s.seat ? 'you' : escapeHtml(t.name)} to play`, true));
    return;
  }
  if (yzRolling) {
    area.appendChild(prompt('🎲 Rolling…'));
    return;
  }
  if (t.canRoll) {
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.appendChild(actBtn(`🎲 Roll · ${t.rollsLeft} left`, 'btn btn-good', () => send({ type: 'roll' })));
    area.appendChild(row);
    area.appendChild(prompt('Tap dice to <b>keep</b>, then roll again — or tap a category to <b>score</b>.'));
  } else {
    area.appendChild(prompt('No rolls left — tap a category cell to <b>score</b> and end your turn.'));
  }
}

function renderYzCard(s) {
  const box = $('yzCard');
  const players = s.players || [];
  const bots = botSeatSet(s);
  box.style.setProperty('--yz-cols', players.length);
  box.innerHTML = '';

  // header row: player names + running grand totals
  const head = document.createElement('div');
  head.className = 'yz-row yz-headrow';
  head.appendChild(yzCell('yz-cap', ''));
  players.forEach((p) => {
    const h = document.createElement('div');
    h.className = 'yz-pcol' + (p.isTurn ? ' acting' : '') + (p.seat === s.seat ? ' you' : '');
    h.style.borderTopColor = seatColor(p.seat);
    h.innerHTML =
      `<span class="yz-pname" style="color:${seatColor(p.seat)}">${escapeHtml(p.name)}${bots.has(p.seat) ? ' 🤖' : ''}</span>` +
      `<span class="yz-ptot">${p.grand}</span>`;
    head.appendChild(h);
  });
  box.appendChild(head);

  for (const row of YZ_ROWS) {
    const r = document.createElement('div');
    if (row.type === 'head') {
      r.className = 'yz-row yz-section';
      const c = yzCell('yz-sectionlbl', row.label);
      c.style.gridColumn = `1 / span ${players.length + 1}`;
      r.appendChild(c);
      box.appendChild(r);
      continue;
    }
    r.className = 'yz-row' + (row.type === 'sub' ? ' yz-subrow' : '');
    r.appendChild(yzCapCell(row.label, YZ_DESC[row.cat] || YZ_DESC[row.key]));
    for (const p of players) {
      const c = document.createElement('div');
      c.className = 'yz-cell';
      if (p.isTurn) c.classList.add('col-acting');
      if (row.type === 'sub') {
        c.classList.add('yz-subcell');
        c.textContent = yzSubValue(row.key, p);
      } else {
        const val = p.scores[row.cat];
        if (val != null) {
          c.classList.add('filled');
          c.textContent = val;
        } else if (p.seat === s.seat && s.turn.yourTurn && yzRolling) {
          // dice still tumbling — don't show a number that contradicts them
          c.classList.add('open');
          c.textContent = '·';
        } else if (p.seat === s.seat && s.turn.yourTurn) {
          const pv = (s.turn.previews || {})[row.cat];
          if (pv && pv.allowed) {
            c.classList.add('pick');
            if (pv.value > 0) c.classList.add('good');
            c.textContent = pv.value;
            c.onclick = () => { tapAck(c); send({ type: 'score', category: row.cat }); };
          } else {
            c.classList.add('locked');
            c.textContent = '–';
          }
        } else {
          c.classList.add('open');
          c.textContent = '·';
        }
      }
      r.appendChild(c);
    }
    box.appendChild(r);
  }
}

function yzCell(cls, text) {
  const c = document.createElement('div');
  c.className = cls;
  c.textContent = text;
  return c;
}
// A row label that reveals its rule on hover (desktop) or tap (mobile).
function yzCapCell(label, desc) {
  const c = document.createElement('div');
  c.className = 'yz-cap';
  if (!desc) {
    c.textContent = label;
    return c;
  }
  c.classList.add('has-desc');
  c.title = desc;
  c.innerHTML = `<span class="yz-caplbl">${escapeHtml(label)}</span><span class="yz-info" aria-hidden="true">ⓘ</span>`;
  c.onclick = () => toast(`${label}: ${desc}`, 'ok');
  return c;
}
function yzSubValue(key, p) {
  if (key === 'upper') return String(p.upper);
  if (key === 'upperBonus') return String(p.upperBonus);
  if (key === 'yBonus') return String((p.yahtzeeBonus || 0) * 100);
  if (key === 'grand') return String(p.grand);
  return '';
}

function renderYzOver(s) {
  const box = document.createElement('div');
  box.className = 'result';
  const youWin = (s.winners || []).includes(s.seat);
  const shared = (s.winners || []).length > 1;
  const names = (s.winners || []).map((seat) => (seat === s.seat ? 'You' : nameForSeat(s, seat))).join(', ');
  box.appendChild(
    banner(youWin ? (shared ? '🤝 Shared win!' : '🏆 You win!') : `${names} win${shared ? '' : 's'}`, youWin ? 'win' : 'lose'),
  );
  const tbl = document.createElement('div');
  tbl.className = 'li-finals';
  (s.finals || []).forEach((f) => {
    const row = document.createElement('div');
    row.className = 'li-frow' + ((s.winners || []).includes(f.seat) ? ' win' : '');
    row.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(f.seat)}">${initial(nameForSeat(s, f.seat))}</span>` +
      `<span class="li-fname">${f.seat === s.seat ? 'You' : escapeHtml(nameForSeat(s, f.seat))}</span>` +
      `<span class="li-fbreak">${f.upper}+${f.upperBonus} up · ${f.lower} low${f.bonus ? ` · +${f.bonus}` : ''}</span>` +
      `<span class="li-ftotal">${f.total}</span>`;
    tbl.appendChild(row);
  });
  box.appendChild(tbl);
  appendEndButtons(box, s);
  return box;
}

function renderYzLog(s) {
  const ul = $('yzLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Spy Game — hidden-role football clue game
// ---------------------------------------------------------------------------

const SG_PHASE_LABEL = { clues: 'Clues', interlude: 'Vote?', voting: 'Voting', spyGuess: "Spy's guess", done: 'Reveal' };
const sgName = (s, seat) => {
  const p = (s.players || []).find((x) => x.seat === seat);
  return p ? p.name : `Seat ${seat + 1}`;
};

function renderSpyGame(s) {
  $('sgRoom').textContent = s.room;
  $('sgPhase').textContent = s.over ? 'Reveal' : SG_PHASE_LABEL[s.phase] || s.phase;
  $('sgCopy').onclick = copyInvite;
  renderSgRole(s);
  renderSgActions(s);
  renderSgClues(s);
  renderSgLog(s);
}

function renderSgRole(s) {
  const el = $('sgRole');
  const you = s.you || {};
  if (you.spectator) {
    el.className = 'sg-role';
    el.innerHTML = '<div class="sg-rolecard">Spectating this match</div>';
    return;
  }
  const spy = you.isSpy;
  const twoSpies = s.spyCount === 2;
  el.className = 'sg-role ' + (spy ? 'is-spy' : 'is-detective');
  el.innerHTML = `<div class="sg-roletag">${spy ? '🕵️ You are a SPY' : '🔎 You are a Detective'}</div>`;
  if (you.secretCard) el.appendChild(labeledCard('Your player', you.secretCard));
  else el.insertAdjacentHTML('beforeend', `<div class="sg-secret"><span class="sg-secretlbl">Your player</span><b>${escapeHtml(you.secret || '?')}</b></div>`);
  el.insertAdjacentHTML('beforeend', `<div class="sg-rolehint">${spy
    ? 'Blend in — your player is a decoy, not the others’ one.' + (twoSpies ? ' There’s a second spy too.' : '')
    : 'Clue your player without tipping off the spy' + (twoSpies ? 's — there are <b>2</b> this game.' : '.')}</div>`);
}

function renderSgActions(s) {
  const area = $('sgActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(renderSgReveal(s));
    return;
  }
  if (s.phase === 'clues') return renderSgCluePhase(area, s);
  if (s.phase === 'interlude') return renderSgInterlude(area, s);
  if (s.phase === 'voting') return renderSgVoting(area, s);
  if (s.phase === 'spyGuess') return renderSgGuess(area, s);
}

function renderSgInterlude(area, s) {
  const il = s.interlude;
  if (!il) {
    area.appendChild(callout('Players are deciding whether to vote…', true));
    return;
  }
  if (il.youDecided) {
    area.appendChild(callout(`Locked in${il.yourChoice ? ' — you called a vote' : ''} · waiting for ${il.waiting} more`, true));
    return;
  }
  area.appendChild(prompt(`Round <b>${il.round}</b> done — accuse the <b>spy</b> now, or keep clueing? <i>(majority decides)</i>`));
  const row = document.createElement('div');
  row.className = 'btn-row';
  row.appendChild(actBtn('🗳️ Vote now', 'btn btn-gold', () => send({ type: 'interludeVote', wantVote: true })));
  row.appendChild(actBtn('Keep clueing', 'btn btn-neutral', () => send({ type: 'interludeVote', wantVote: false })));
  area.appendChild(row);
}

function renderSgCluePhase(area, s) {
  const t = s.turn || {};
  if (t.yourTurn) {
    area.appendChild(prompt(`Round <b>${s.round}</b>/3 — give a <b>one-word clue</b> about your player.`));
    const form = document.createElement('form');
    form.className = 'sg-clueform';
    const input = document.createElement('input');
    input.maxLength = 30;
    input.placeholder = 'your clue…';
    input.autocomplete = 'off';
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'btn btn-good';
    btn.textContent = 'Submit';
    form.append(input, btn);
    form.onsubmit = (e) => {
      e.preventDefault();
      const w = input.value.trim();
      if (w) send({ type: 'submitClue', word: w });
    };
    area.appendChild(form);
    setTimeout(() => input.focus(), 0);
  } else {
    const who = s.activeSeat != null ? sgName(s, s.activeSeat) : '';
    area.appendChild(callout(`Round ${s.round}/3 — waiting for ${escapeHtml(who)} to clue`, true));
  }
}

function renderSgVoting(area, s) {
  const v = s.voting || {};
  const bots = botSeatSet(s);
  if (v.youOut) {
    area.appendChild(callout('You were caught — spectating while the others hunt the remaining spy.', true));
  } else if (v.youVoted) {
    area.appendChild(callout(`Vote locked in — waiting for ${v.waiting} more`, true));
  } else {
    area.appendChild(prompt('Who is the <b>spy</b>? Cast your secret vote.'));
    const grid = document.createElement('div');
    grid.className = 'sg-votegrid';
    (v.options || []).forEach((o) => {
      const b = actBtn('', 'sg-votebtn', () => { tapAck(b); send({ type: 'castVote', target: o.seat }); });
      b.innerHTML =
        `<span class="avatar sm" style="background:${seatColor(o.seat)}">${initial(o.name)}</span>` +
        `<span>${escapeHtml(o.name)}${bots.has(o.seat) ? ' 🤖' : ''}</span>`;
      grid.appendChild(b);
    });
    area.appendChild(grid);
  }
  area.appendChild(renderSgVoteStatus(s));
}

function renderSgVoteStatus(s) {
  const box = document.createElement('div');
  box.className = 'sg-votestatus';
  (s.players || []).filter((p) => !p.eliminated).forEach((p) => {
    const chip = document.createElement('span');
    chip.className = 'sg-vchip' + (p.hasVoted ? ' voted' : '');
    chip.style.background = seatColor(p.seat);
    chip.title = p.name + (p.hasVoted ? ' — voted' : ' — thinking');
    chip.textContent = p.hasVoted ? '✓' : initial(p.name);
    box.appendChild(chip);
  });
  return box;
}

function renderSgGuess(area, s) {
  const g = s.guess || {};
  if (g.needsYou) {
    area.appendChild(prompt('🕵️ You were <b>caught</b>! Name the Detectives’ player to steal the win:'));
    const form = document.createElement('form');
    form.className = 'sg-clueform';
    const names = g.allNames || [];
    const listId = 'sgGuessNames';
    form.innerHTML =
      `<input id="sgGuessInput" type="text" placeholder="Search a player…" autocomplete="off" list="${listId}" maxlength="60" />` +
      `<datalist id="${listId}">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`;
    const btn = actBtn('Guess', 'btn btn-gold', null);
    btn.type = 'submit';
    form.appendChild(btn);
    form.onsubmit = (e) => {
      e.preventDefault();
      const val = form.querySelector('#sgGuessInput').value.trim();
      if (val) send({ type: 'spyGuess', guess: val });
    };
    area.appendChild(form);
  } else {
    area.appendChild(callout(`${escapeHtml(g.caughtName || 'The spy')} was caught — waiting for their guess…`, true));
  }
  if (s.voteResult) area.appendChild(renderSgVotes(s, s.voteResult.votes, s.caughtId));
}

function renderSgReveal(s) {
  const r = s.reveal || {};
  const box = document.createElement('div');
  box.className = 'result';
  const youWin = (s.winners || []).includes(s.seat);
  box.appendChild(banner(youWin ? '🏆 You win!' : 'You lose', youWin ? 'win' : 'lose'));

  const spyList = (r.spyNames || []).map((n) => `<b>${escapeHtml(n)}</b>`).join(' & ');
  const spyWord = (r.spyNames || []).length > 1 ? 'spies' : 'spy';
  const sub = document.createElement('div');
  sub.className = 'sg-revealsub';
  sub.innerHTML = r.spyWon
    ? `🕵️ The ${spyWord} (${spyList}) got away${r.guess ? ` — guessed <b>${escapeHtml(r.guess)}</b> ${r.guessCorrect ? '✓ correct!' : ''}` : ''}.`
    : `🎯 The Detectives caught a spy${r.guess ? `, who wrongly guessed ${escapeHtml(r.guess)}` : ''}. ${spyWord === 'spies' ? `The ${spyWord} were ${spyList}.` : ''}`;
  box.appendChild(sub);

  if (r.targetCard && r.decoyCard) {
    const cards = document.createElement('div');
    cards.className = 'pcard-row';
    cards.appendChild(labeledCard('Detectives’ player', r.targetCard, { pop: true }));
    cards.appendChild(labeledCard('Spy’s decoy', r.decoyCard, { pop: true }));
    box.appendChild(cards);
  } else {
    const cards = document.createElement('div');
    cards.className = 'sg-revealcards';
    cards.innerHTML =
      `<div class="sg-rcard det"><span>Detectives’ player</span><b>${escapeHtml(r.target)}</b></div>` +
      `<div class="sg-rcard spy"><span>Spy’s decoy</span><b>${escapeHtml(r.decoy)}</b></div>`;
    box.appendChild(cards);
  }

  box.appendChild(renderSgVotes(s, r.votes, r.spyIds || []));
  appendEndButtons(box, s);
  return box;
}

function renderSgVotes(s, votes, spyIds) {
  const spies = Array.isArray(spyIds) ? spyIds : [spyIds];
  const box = document.createElement('div');
  box.className = 'sg-votes';
  const title = document.createElement('div');
  title.className = 'sg-votestitle';
  title.textContent = 'Votes';
  box.appendChild(title);
  (votes || []).forEach((vt) => {
    const row = document.createElement('div');
    row.className = 'sg-voterow';
    const to = vt.vote != null ? sgName(s, vt.vote) : '—';
    row.innerHTML =
      `<span style="color:${seatColor(vt.seat)}">${escapeHtml(vt.name)}${spies.includes(vt.seat) ? ' 🕵️' : ''}</span>` +
      `<span class="sg-arrow">→</span><b>${escapeHtml(to)}</b>`;
    box.appendChild(row);
  });
  return box;
}

function renderSgClues(s) {
  const el = $('sgClues');
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'sg-cluestitle';
  title.textContent = 'Clue log';
  el.appendChild(title);
  if (!s.clueLog || !s.clueLog.length) {
    const empty = document.createElement('div');
    empty.className = 'sg-empty';
    empty.textContent = 'No clues yet…';
    el.appendChild(empty);
    return;
  }
  let curRound = 0;
  for (const c of s.clueLog) {
    if (c.round !== curRound) {
      curRound = c.round;
      const rd = document.createElement('div');
      rd.className = 'sg-round';
      rd.textContent = 'Round ' + curRound;
      el.appendChild(rd);
    }
    const row = document.createElement('div');
    row.className = 'sg-clue';
    row.innerHTML =
      `<span class="avatar xs" style="background:${seatColor(c.seat)}">${initial(c.name)}</span>` +
      `<span class="sg-cluename" style="color:${seatColor(c.seat)}">${escapeHtml(c.name)}</span>` +
      `<span class="sg-clueword">“${escapeHtml(c.word)}”</span>`;
    el.appendChild(row);
  }
}

function renderSgLog(s) {
  const ul = $('sgLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Codenames — two-team word game
// ---------------------------------------------------------------------------

function renderCodenames(s) {
  $('cnRoom').textContent = s.room;
  const phasePill = $('cnTurn');
  if (s.over) phasePill.textContent = 'Game over';
  else phasePill.textContent = `${s.turnTeam.toUpperCase()} ${s.phase === 'clue' ? 'clue' : 'guessing'}`;
  phasePill.className = 'phase-pill cn-turnpill ' + (s.over ? '' : s.turnTeam);
  $('cnCopy').onclick = copyInvite;
  renderCnTeams(s);
  renderCnClue(s);
  renderCnGrid(s);
  renderCnActions(s);
  renderCnLog(s);
}

function renderCnTeams(s) {
  const box = $('cnTeams');
  const bots = botSeatSet(s);
  box.innerHTML = '';
  const tag = (m) => escapeHtml(m.name) + (bots.has(m.seat) ? ' 🤖' : '') + (m.seat === s.seat ? ' (you)' : '');
  for (const team of ['red', 'blue']) {
    const t = s.teams[team];
    const active = !s.over && s.turnTeam === team;
    const panel = document.createElement('div');
    panel.className = 'cn-team ' + team + (active ? ' active' : '');
    panel.innerHTML =
      `<div class="cn-teamhead"><span class="cn-teamname">${team.toUpperCase()}</span><span class="cn-agents">${t.agentsRemaining}</span></div>` +
      `<div class="cn-roleline">🔍 ${t.spymaster ? tag(t.spymaster) : '—'}</div>` +
      `<div class="cn-roleline ops">${(t.operatives || []).map(tag).join(', ') || '—'}</div>`;
    box.appendChild(panel);
  }
}

function renderCnClue(s) {
  const el = $('cnClue');
  if (s.over) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  if (s.currentClue) {
    el.className = 'cn-cluebar ' + s.turnTeam;
    el.innerHTML =
      `<span class="cn-cluelbl">Clue</span>` +
      `<span class="cn-clueword">${escapeHtml(s.currentClue.word)}</span>` +
      `<span class="cn-cluenum">${s.currentClue.number}</span>` +
      `<span class="cn-guessesleft">${s.guessesLeft} guess${s.guessesLeft === 1 ? '' : 'es'} left</span>`;
  } else {
    el.className = 'cn-cluebar waiting';
    el.innerHTML = `<span>Waiting for ${s.turnTeam.toUpperCase()} spymaster’s clue…</span>`;
  }
}

function renderCnGrid(s) {
  const box = $('cnGrid');
  box.innerHTML = '';
  const you = s.you || {};
  (s.grid || []).forEach((card, i) => {
    const el = document.createElement('button');
    el.className = 'cn-card';
    const id = card.identity;
    if (card.revealed) el.classList.add('revealed', 'id-' + id);
    else if (id) el.classList.add('key', 'id-' + id); // spymaster's hidden key tint
    const guessable = !s.over && you.canGuess && !card.revealed;
    if (guessable) {
      el.classList.add('guessable');
      el.onclick = () => { tapAck(el); send({ type: 'guessCard', cardIndex: i }); };
    } else {
      el.disabled = true;
    }
    const mark = card.revealed && id === 'assassin' ? '<span class="cn-skull">💀</span>' : '';
    el.innerHTML = `${mark}<span class="cn-word">${escapeHtml(card.word)}</span>`;
    box.appendChild(el);
  });
}

function renderCnActions(s) {
  const area = $('cnActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(renderCnOver(s));
    return;
  }
  const you = s.you || {};
  if (you.spectator) {
    area.appendChild(callout('Spectating this match', true));
    return;
  }
  const chip = document.createElement('div');
  chip.className = 'cn-rolechip ' + you.team;
  chip.textContent = `You are ${you.team.toUpperCase()}'s ${you.isSpymaster ? 'Spymaster 🔍' : 'Operative'}`;
  area.appendChild(chip);

  if (you.canClue) {
    area.appendChild(renderCnClueForm());
  } else if (you.canGuess) {
    area.appendChild(prompt('Your team is guessing — tap a card on the board.'));
    if (you.canStop) {
      const row = document.createElement('div');
      row.className = 'btn-row';
      row.appendChild(actBtn(`Stop guessing · ${s.guessesLeft} left`, 'btn btn-neutral', () => send({ type: 'stopGuessing' })));
      area.appendChild(row);
    }
  } else {
    const what = s.phase === 'clue' ? 'spymaster to clue' : 'operatives to guess';
    area.appendChild(callout(`Waiting for ${s.turnTeam.toUpperCase()} ${what}`, true));
  }
}

function renderCnClueForm() {
  const box = document.createElement('div');
  box.appendChild(prompt('Give a <b>one-word clue</b> and a number (how many cards it points to).'));
  const form = document.createElement('form');
  form.className = 'cn-clueform';
  const word = document.createElement('input');
  word.maxLength = 24;
  word.placeholder = 'clue word';
  word.autocomplete = 'off';
  word.className = 'cn-clueinput';
  const num = document.createElement('input');
  num.type = 'number';
  num.min = '0';
  num.max = '9';
  num.value = '1';
  num.className = 'cn-numinput';
  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'btn btn-good';
  btn.textContent = 'Give clue';
  form.append(word, num, btn);
  form.onsubmit = (e) => {
    e.preventDefault();
    const w = word.value.trim();
    const n = parseInt(num.value, 10);
    if (w && Number.isFinite(n)) send({ type: 'giveClue', word: w, number: n });
  };
  box.appendChild(form);
  setTimeout(() => word.focus(), 0);
  return box;
}

function renderCnOver(s) {
  const box = document.createElement('div');
  box.className = 'result';
  const youWin = (s.winners || []).includes(s.seat);
  const wTeam = (s.winner || '').toUpperCase();
  box.appendChild(banner(youWin ? '🏆 You win!' : `${wTeam} wins`, youWin ? 'win' : 'lose'));
  const sub = document.createElement('div');
  sub.className = 'cn-oversub';
  sub.textContent = s.endReason === 'assassin' ? 'The other team tapped the assassin 💀' : `${wTeam} contacted all their agents.`;
  box.appendChild(sub);
  appendEndButtons(box, s);
  return box;
}

function renderCnLog(s) {
  const ul = $('cnLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Quoridor — pawn race + walls (no hidden info)
// ---------------------------------------------------------------------------

let qrMode = 'move'; // 'move' | 'wall'
let qrWallOrient = 'H'; // 'H' | 'V'
let qrPendingWall = null; // {r,c,o} a tapped-but-not-yet-confirmed wall
const QR_GOAL_ARROW = { top: '↑', bottom: '↓', left: '←', right: '→' };
// Visual top = board row 8. Tracks: cell c → 2c+1, cell row r → 2(8-r)+1; grooves are the even tracks.
const qrCellStyle = (r, c) => ({ gridRow: String(2 * (8 - r) + 1), gridColumn: String(2 * c + 1) });
function qrWallStyle(w) {
  if (w.o === 'H') {
    const row = 2 * (8 - w.r);
    return { gridRow: `${row} / ${row + 1}`, gridColumn: `${2 * w.c + 1} / ${2 * w.c + 4}` };
  }
  const a = 2 * (8 - w.r);
  return { gridColumn: `${2 * w.c + 2} / ${2 * w.c + 3}`, gridRow: `${a - 1} / ${a + 2}` };
}

function renderQuoridor(s) {
  $('qrRoom').textContent = s.room;
  const pill = $('qrTurn');
  const active = (s.pawns || []).find((p) => p.isTurn);
  pill.textContent = s.over ? 'Game over' : active ? `${active.seat === s.seat ? 'Your' : escapeHtml(active.name) + '’s'} turn` : '—';
  pill.className = 'phase-pill';
  $('qrCopy').onclick = copyInvite;
  renderQrPlayers(s);
  renderQrBoard(s);
  renderQrActions(s);
  renderQrLog(s);
}

function renderQrPlayers(s) {
  const box = $('qrPlayers');
  const bots = botSeatSet(s);
  box.innerHTML = '';
  (s.pawns || []).forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'qr-pchip' + (p.isTurn ? ' acting' : '');
    chip.style.borderColor = seatColor(p.seat);
    chip.innerHTML =
      `<span class="qr-pdot" style="background:${seatColor(p.seat)}">${QR_GOAL_ARROW[p.goal] || ''}</span>` +
      `<span class="qr-pname">${escapeHtml(p.name)}${bots.has(p.seat) ? ' 🤖' : ''}${p.seat === s.seat ? ' (you)' : ''}</span>` +
      `<span class="qr-pwalls">🧱 ${p.wallsLeft}</span>`;
    box.appendChild(chip);
  });
}

function renderQrBoard(s) {
  const board = $('qrBoard');
  board.innerHTML = '';
  const you = s.you || {};
  const yourTurn = !s.over && you.isTurn;
  const postMove = yourTurn && you.canEndTurn; // already moved → only walls/end remain
  const mode = postMove ? 'wall' : qrMode;
  const moveSet = new Set((s.legal?.moves || []).map((m) => m[0] + ',' + m[1]));
  const pawnAt = {};
  for (const p of s.pawns || []) pawnAt[p.pos[0] + ',' + p.pos[1]] = p;

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('div');
      cell.className = 'qr-cell';
      Object.assign(cell.style, qrCellStyle(r, c));
      const p = pawnAt[r + ',' + c];
      if (p) {
        const disc = document.createElement('div');
        disc.className = 'qr-pawn' + (p.isTurn ? ' acting' : '');
        disc.style.background = seatColor(p.seat);
        disc.textContent = initial(p.name);
        cell.appendChild(disc);
      }
      if (yourTurn && mode === 'move' && you.canMove && moveSet.has(r + ',' + c)) {
        cell.classList.add('qr-target');
        cell.onclick = () => { tapAck(cell); send({ type: 'movePawn', toCell: [r, c] }); };
      }
      board.appendChild(cell);
    }
  }

  for (const w of s.walls || []) {
    const bar = document.createElement('div');
    bar.className = 'qr-wall ' + (w.o === 'H' ? 'h' : 'v');
    Object.assign(bar.style, qrWallStyle(w));
    board.appendChild(bar);
  }

  if (yourTurn && mode === 'wall' && you.canWall) {
    for (const w of s.legal?.walls || []) {
      if (w.o !== qrWallOrient) continue;
      const sel = qrPendingWall && qrPendingWall.r === w.r && qrPendingWall.c === w.c && qrPendingWall.o === w.o;
      const slot = document.createElement('div');
      slot.className = 'qr-wallslot ' + (w.o === 'H' ? 'h' : 'v') + (sel ? ' sel' : '');
      Object.assign(slot.style, qrWallStyle(w));
      // Tap selects (shows a preview) rather than placing — confirm in the action area.
      slot.onclick = () => { qrPendingWall = { r: w.r, c: w.c, o: w.o }; render(); };
      board.appendChild(slot);
    }
  }
}

function renderQrActions(s) {
  const area = $('qrActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(renderQrOver(s));
    return;
  }
  const you = s.you || {};
  if (you.spectator) {
    area.appendChild(callout('Spectating this match', true));
    return;
  }
  if (!you.isTurn) {
    qrMode = 'move'; // reset for the start of your next turn
    qrPendingWall = null;
    const active = (s.pawns || []).find((p) => p.isTurn);
    area.appendChild(callout(`Waiting for ${active ? escapeHtml(active.name) : '…'} to play`, true));
    return;
  }

  const orientRow = () => {
    const orow = document.createElement('div');
    orow.className = 'btn-row';
    const set = (o) => () => { qrWallOrient = o; qrPendingWall = null; render(); }; // switching orientation drops the preview
    orow.appendChild(actBtn('Horizontal', 'btn ' + (qrWallOrient === 'H' ? 'btn-gold' : 'btn-neutral'), set('H')));
    orow.appendChild(actBtn('Vertical', 'btn ' + (qrWallOrient === 'V' ? 'btn-gold' : 'btn-neutral'), set('V')));
    return orow;
  };
  // Confirm/cancel for a previewed wall (shown in both wall flows below).
  const confirmRow = () => {
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.appendChild(actBtn('Place wall ✓', 'btn btn-primary', () => {
      const w = qrPendingWall; qrPendingWall = null;
      send({ type: 'placeWall', slot: [w.r, w.c], orientation: w.o });
    }));
    row.appendChild(actBtn('Cancel', 'btn btn-quiet', () => { qrPendingWall = null; render(); }));
    return row;
  };

  if (you.canEndTurn) {
    // already moved this turn — optionally place a wall, then end the turn
    if (you.canWall) {
      if (qrPendingWall) {
        area.appendChild(prompt('Place this <b>wall</b>, or cancel and pick another groove.'));
        area.appendChild(orientRow());
        area.appendChild(confirmRow());
        return;
      }
      area.appendChild(prompt(`You moved. Optionally place a <b>${qrWallOrient === 'H' ? 'horizontal' : 'vertical'}</b> wall — tap a groove — or end your turn.`));
      area.appendChild(orientRow());
    } else {
      area.appendChild(prompt('You moved. No walls left — end your turn.'));
    }
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.appendChild(actBtn('End turn ✓', 'btn btn-primary', () => send({ type: 'endTurn' })));
    area.appendChild(row);
    return;
  }

  // start of turn — choose to move (then optionally wall) or place a wall outright
  const bar = document.createElement('div');
  bar.className = 'btn-row qr-modebar';
  bar.appendChild(actBtn('♟ Move', 'btn ' + (qrMode === 'move' ? 'btn-good' : 'btn-neutral'), () => { qrMode = 'move'; qrPendingWall = null; render(); }));
  const wallBtn = actBtn('🧱 Wall', 'btn ' + (qrMode === 'wall' ? 'btn-good' : 'btn-neutral'), () => { qrMode = 'wall'; qrPendingWall = null; render(); });
  if (!you.canWall) {
    wallBtn.disabled = true;
    wallBtn.title = 'No walls left';
  }
  bar.appendChild(wallBtn);
  area.appendChild(bar);

  if (qrMode === 'move') {
    area.appendChild(prompt('Tap a highlighted cell to move — you can place a wall afterwards.'));
  } else if (qrPendingWall) {
    area.appendChild(prompt('Place this <b>wall</b>, or cancel and pick another groove.'));
    area.appendChild(orientRow());
    area.appendChild(confirmRow());
  } else {
    area.appendChild(orientRow());
    area.appendChild(prompt(`Pick orientation, then <b>tap a glowing groove</b> to preview a wall (ends your turn without moving).`));
  }
}

function renderQrOver(s) {
  const box = document.createElement('div');
  box.className = 'result';
  const youWin = (s.winners || []).includes(s.seat);
  const w = (s.pawns || []).find((p) => p.pid === s.winner);
  box.appendChild(banner(youWin ? '🏆 You win!' : `${w ? escapeHtml(w.name) : 'Someone'} wins`, youWin ? 'win' : 'lose'));
  appendEndButtons(box, s);
  return box;
}

function renderQrLog(s) {
  const ul = $('qrLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Tectonic Shift — hex territory game
// ---------------------------------------------------------------------------

const TEC_VAL_COLORS = { 1: '#6b78ff', 2: '#26c6da', 3: '#49b85a', 4: '#f0883e', 5: '#e5483f' };
const TEC_SQRT3 = Math.sqrt(3);
let tecSel = null; // selected pawn id
const tecPixel = (q, r, sz) => ({ x: sz * 1.5 * q, y: sz * TEC_SQRT3 * (r + q / 2) });
function tecPoints(x, y, sz) {
  let p = '';
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i);
    p += `${(x + sz * Math.cos(a)).toFixed(2)},${(y + sz * Math.sin(a)).toFixed(2)} `;
  }
  return p.trim();
}

function renderTectonic(s) {
  $('tecRoom').textContent = s.room;
  const active = (s.players || []).find((p) => p.isTurn);
  const pill = $('tecTurn');
  pill.textContent = s.over ? 'Game over' : active ? `${active.seat === s.seat ? 'Your' : escapeHtml(active.name) + '’s'} turn` : '—';
  pill.className = 'phase-pill';
  $('tecCopy').onclick = copyInvite;
  if (!s.you || !s.you.isTurn) tecSel = null;
  renderTecPlayers(s);
  renderTecBoard(s);
  renderTecActions(s);
  renderTecLog(s);
}

function renderTecPlayers(s) {
  const box = $('tecPlayers');
  const bots = botSeatSet(s);
  box.innerHTML = '';
  (s.players || []).forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'tec-pchip' + (p.isTurn ? ' acting' : '');
    chip.style.borderColor = seatColor(p.seat);
    chip.innerHTML =
      `<span class="tec-pdot" style="background:${seatColor(p.seat)}"></span>` +
      `<span class="tec-pname">${escapeHtml(p.name)}${bots.has(p.seat) ? ' 🤖' : ''}${p.seat === s.seat ? ' (you)' : ''}</span>` +
      `<span class="tec-pscore">${p.score}</span><span class="tec-palive">${p.alivePawns}♟</span>`;
    box.appendChild(chip);
  });
}

function renderTecBoard(s) {
  const board = $('tecBoard');
  const sz = 10;
  const present = (s.hexes || []).filter((h) => h.state === 'present');
  // Untouched board = a fresh match: drop last match's positions so pawns don't
  // animate in from wherever their id sat when the previous game ended.
  if (present.length === (s.hexes || []).length) _tecPrev = {};
  if (!present.length) {
    board.innerHTML = '';
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const h of present) {
    const { x, y } = tecPixel(h.q, h.r, sz);
    h._x = x;
    h._y = y;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const pad = sz * 1.5;
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`;

  const you = s.you || {};
  const pawnByHex = {};
  for (const p of s.pawns || []) pawnByHex[p.q + ',' + p.r] = p;
  const dest = new Set();
  if (tecSel != null && you.isTurn) for (const m of s.legal || []) if (m.pawnId === tecSel) dest.add(m.to[0] + ',' + m.to[1]);
  const selPawn = tecSel != null ? (s.pawns || []).find((p) => p.id === tecSel) : null;
  const lift = sz * 0.22; // raised-tile thickness (the dark base peeks out below)
  const top = sz * 0.92; // top face slightly inset → "grout" lines between tiles

  let svg = `<svg viewBox="${vb}" class="tec-svg" preserveAspectRatio="xMidYMid meet">`;
  svg += '<defs>'
    + '<linearGradient id="tecTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fdfefe"/><stop offset="1" stop-color="#cdd5e2"/></linearGradient>'
    + '<linearGradient id="tecGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#f3b740"/></linearGradient>'
    + '<filter id="tecPawnSh" x="-60%" y="-60%" width="220%" height="220%"><feDropShadow dx="0" dy="0.7" stdDeviation="0.5" flood-color="#000" flood-opacity="0.5"/></filter>'
    + '</defs>';

  // 1) raised tiles: dark base, then the inset top face + a value tint
  for (const h of present) {
    const key = h.q + ',' + h.r;
    const isDest = dest.has(key);
    svg += `<polygon points="${tecPoints(h._x, h._y, sz)}" class="tec-base"/>`;
    const ty = h._y - lift;
    const cls = 'tec-hex' + (isDest ? ' dest' : '') + (selPawn && selPawn.q === h.q && selPawn.r === h.r ? ' selhex' : '');
    svg += `<polygon points="${tecPoints(h._x, ty, top)}" class="${cls}" data-q="${h.q}" data-r="${h.r}"/>`;
    if (!isDest) svg += `<polygon points="${tecPoints(h._x, ty, top)}" class="tec-tint" style="fill:${TEC_VAL_COLORS[h.value] || '#888'}"/>`;
  }
  // 2) tile contents (value number, or a destination dot)
  for (const h of present) {
    const key = h.q + ',' + h.r;
    if (pawnByHex[key]) continue;
    const ty = h._y - lift;
    if (dest.has(key)) svg += `<circle cx="${h._x}" cy="${ty}" r="${sz * 0.26}" class="tec-destdot"/>`;
    else svg += `<text x="${h._x}" y="${ty}" class="tec-val" data-q="${h.q}" data-r="${h.r}">${h.value}</text>`;
  }
  // 3) pawns as glossy spheres (each a <g> we can slide-animate)
  for (const p of s.pawns || []) {
    const px = tecPixel(p.q, p.r, sz);
    const cx = px.x;
    const cy = px.y - lift;
    const r = sz * 0.5;
    const mine = p.owner === s.seat;
    svg += `<g class="tec-pawn-g${p.alive ? '' : ' dead'}${tecSel === p.id ? ' sel' : ''}" data-pawn="${p.id}">`
      + `<ellipse cx="${cx}" cy="${cy + r * 0.85}" rx="${r * 0.85}" ry="${r * 0.3}" class="tec-pawn-cast"/>`
      + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${seatColor(p.owner)}" class="tec-pawn${mine ? ' mine' : ''}" data-q="${p.q}" data-r="${p.r}"/>`
      + `<ellipse cx="${cx - r * 0.28}" cy="${cy - r * 0.34}" rx="${r * 0.34}" ry="${r * 0.26}" class="tec-pawn-shine"/>`
      + `</g>`;
  }
  svg += '</svg>';
  board.innerHTML = svg;
  const svgEl = board.querySelector('svg');

  // slide-animate any pawn that changed hex since the last render
  const nextPrev = {};
  for (const p of s.pawns || []) {
    const px = tecPixel(p.q, p.r, sz);
    nextPrev[p.id] = px;
    const g = svgEl.querySelector(`g[data-pawn="${p.id}"]`);
    const old = _tecPrev[p.id];
    if (g && old && (old.x !== px.x || old.y !== px.y)) {
      g.style.transition = 'none';
      g.style.transform = `translate(${old.x - px.x}px, ${old.y - px.y}px)`;
      g.getBoundingClientRect(); // force reflow so the start position takes
      requestAnimationFrame(() => { g.style.transition = ''; g.style.transform = 'translate(0px, 0px)'; });
    }
  }
  _tecPrev = nextPrev;

  svgEl.onclick = (e) => {
    const q = e.target.getAttribute && e.target.getAttribute('data-q');
    if (q == null) return;
    onTecClick(s, Number(q), Number(e.target.getAttribute('data-r')));
  };
}
let _tecPrev = {}; // pawn id → last pixel position (for slide animation)

function onTecClick(s, q, r) {
  const you = s.you || {};
  if (s.over || !you.isTurn) return;
  if (tecSel != null) {
    const m = (s.legal || []).find((mm) => mm.pawnId === tecSel && mm.to[0] === q && mm.to[1] === r);
    if (m) {
      send({ type: 'slide', pawnId: tecSel, direction: m.direction, distance: m.distance });
      tecSel = null;
      return;
    }
  }
  const pawn = (s.pawns || []).find((p) => p.q === q && p.r === r);
  tecSel = pawn && pawn.owner === s.seat && pawn.alive ? pawn.id : null;
  render();
}

function renderTecActions(s) {
  const area = $('tecActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(renderTecOver(s));
    return;
  }
  const you = s.you || {};
  if (you.spectator) {
    area.appendChild(callout('Spectating this match', true));
    return;
  }
  if (!you.isTurn) {
    const active = (s.players || []).find((p) => p.isTurn);
    area.appendChild(callout(`Waiting for ${active ? escapeHtml(active.name) : '…'} to move`, true));
    return;
  }
  area.appendChild(
    prompt(tecSel != null ? 'Tap a <b>highlighted hex</b> to slide there — you bank the hex you leave.' : 'Tap one of <b>your pawns</b>, then a highlighted hex to slide.'),
  );
}

function renderTecOver(s) {
  const box = document.createElement('div');
  box.className = 'result';
  const youWin = (s.winners || []).includes(s.seat);
  const shared = (s.winners || []).length > 1;
  const names = (s.winners || []).map((seat) => (seat === s.seat ? 'You' : (s.players.find((p) => p.seat === seat) || {}).name)).join(', ');
  box.appendChild(banner(youWin ? (shared ? '🤝 Shared win!' : '🏆 You win!') : `${escapeHtml(names)} win${shared ? '' : 's'}`, youWin ? 'win' : 'lose'));
  const tbl = document.createElement('div');
  tbl.className = 'li-finals';
  [...(s.players || [])].sort((a, b) => b.score - a.score).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'li-frow' + ((s.winners || []).includes(p.seat) ? ' win' : '');
    row.innerHTML =
      `<span class="tec-pdot" style="background:${seatColor(p.seat)}"></span>` +
      `<span class="li-fname">${p.seat === s.seat ? 'You' : escapeHtml(p.name)}</span>` +
      `<span class="li-fbreak">${p.alivePawns} pawns left</span>` +
      `<span class="li-ftotal">${p.score}</span>`;
    tbl.appendChild(row);
  });
  box.appendChild(tbl);
  appendEndButtons(box, s);
  return box;
}

function renderTecLog(s) {
  const ul = $('tecLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Shared chrome for the two-player duels (Manhunt, Three Fronts, Salvo, Sealed Bids)
// ---------------------------------------------------------------------------

// Inline monochrome icons. Emoji were rendering at different weights and colours on
// every platform, which is the fastest way to make a board look unfinished.
const DUEL_ICON = {
  air: '<path d="M12 2.5 4.2 21l7.8-4.4 7.8 4.4z"/>',
  land: '<path d="M2 19.2h20L14.4 5.6l-3.7 6.4-2.3-2.6z"/>',
  // Waves stay an outline — filling an open path would collapse it to a hairline.
  sea: '<path d="M2 11.5c2.6-2.8 4.4 2.8 7 0s4.4 2.8 7 0 4.4 2.8 6 0"/><path d="M2 17.5c2.6-2.8 4.4 2.8 7 0s4.4 2.8 7 0 4.4 2.8 6 0"/>',
};
const ICON_OUTLINE = { sea: true };
const FRONT_ICON = ['air', 'land', 'sea'];
const duelIcon = (name) => `<svg class="ico${ICON_OUTLINE[name] ? ' stroked' : ' solid'}" viewBox="0 0 24 24" aria-hidden="true">${DUEL_ICON[name] || ''}</svg>`;

/** One roster row per player; `meta(p)` fills the right-hand cell. */
function duelRoster(elId, s, meta) {
  const box = $(elId);
  const bots = botSeatSet(s);
  box.innerHTML = '';
  (s.players || []).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'duel-p' + (p.isTurn ? ' acting' : '');
    row.innerHTML =
      `<span class="duel-p-dot" style="background:${seatColor(p.seat)}"></span>` +
      `<span class="duel-p-name">${escapeHtml(p.name)}${bots.has(p.seat) ? ' 🤖' : ''}` +
      `${p.seat === s.seat ? ' <span class="you">(you)</span>' : ''}</span>` +
      `<span class="duel-p-meta">${meta(p)}</span>`;
    box.appendChild(row);
  });
}

/** The one-line "whose move and why" that sits above the action buttons. */
function duelStatus(elId, html, live) {
  const box = $(elId);
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'duel-status' + (live ? ' live' : '');
  d.innerHTML = (live ? '<span class="dot"></span>' : '') + html;
  box.appendChild(d);
}

const duelLog = (elId, s) => {
  const ul = $(elId);
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
};

/** Shared end-of-match panel: a banner plus one row per player. */
function duelOver(s, title, rows) {
  const box = document.createElement('div');
  box.className = 'result';
  const youWin = (s.winners || []).includes(s.seat);
  const shared = (s.winners || []).length > 1;
  const names = (s.winners || []).map((seat) => (seat === s.seat ? 'You' : (s.players.find((p) => p.seat === seat) || {}).name)).join(', ');
  box.appendChild(banner(title(youWin, shared, escapeHtml(names)), youWin ? 'win' : 'lose'));
  const tbl = document.createElement('div');
  tbl.className = 'li-finals';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'li-frow' + ((s.winners || []).includes(r.seat) ? ' win' : '');
    row.innerHTML =
      `<span class="duel-p-dot" style="background:${seatColor(r.seat)}"></span>` +
      `<span class="li-fname">${r.seat === s.seat ? 'You' : escapeHtml(r.name)}</span>` +
      (r.note ? `<span class="li-fbreak">${r.note}</span>` : '') +
      `<span class="li-ftotal">${r.total}</span>`;
    tbl.appendChild(row);
  });
  box.appendChild(tbl);
  appendEndButtons(box, s);
  return box;
}

// ---------------------------------------------------------------------------
// Manhunt — two-player hidden movement
// ---------------------------------------------------------------------------

let mhTransport = 0; // route the runner intends to take
const MH_ROUTE = ['taxi', 'bus', 'tube'];

function renderManhunt(s) {
  $('mhRoom').textContent = s.room;
  const you = s.you || {};
  const pill = $('mhPhase');
  pill.textContent = s.over ? 'Over' : s.phase === 'break' ? 'Half time' : `${s.turn}/${s.turns}`;
  pill.className = 'phase-pill';
  $('mhCopy').onclick = copyInvite;
  if (you.role === 'runner' && you.isTurn && !(you.moves || []).some((m) => m.transport === mhTransport)) {
    const first = (you.moves || [])[0];
    mhTransport = first ? first.transport : 0;
  }

  duelRoster('mhPlayers', s, (p) =>
    `<span class="duel-tag${p.role === 'runner' ? ' on' : ''}">${p.role === 'runner' ? 'running' : 'hunting'}</span>` +
    `<span class="duel-p-num">${p.survived == null ? '–' : p.survived}<span class="of">/${s.turns}</span></span>`);
  renderMhMap(s);
  renderMhTrail(s);
  renderMhStatus(s);
  renderMhActions(s);
  duelLog('mhLog', s);
}

function renderMhMap(s) {
  const box = $('mhMap');
  const nodes = s.nodes || [];
  if (!nodes.length) { box.innerHTML = ''; return; }
  const you = s.you || {};
  const STEP = 30;
  const PAD = 13;
  const px = (n) => ({ x: PAD + n.x * STEP, y: PAD + n.y * STEP });
  // Derive the viewBox from the stops themselves — the map is no longer square.
  const cols = Math.max(...nodes.map((n) => n.x)) + 1;
  const rows = Math.max(...nodes.map((n) => n.y)) + 1;
  const spanX = PAD * 2 + STEP * (cols - 1);
  const spanY = PAD * 2 + STEP * (rows - 1);

  const dests = new Map();
  if (you.isTurn) {
    for (const m of you.moves || []) {
      if (you.role === 'runner' && m.transport !== mhTransport) continue;
      dests.set(m.to, m);
    }
  }

  let svg = `<svg viewBox="0 0 ${spanX} ${spanY}" class="mh-svg" preserveAspectRatio="xMidYMid meet">`;
  // On a grid, a bus hop (skip one) and a tube run (corner to corner) are COLLINEAR with
  // the taxi hops beneath them — drawn straight they stack into one unreadable line. So
  // bow the longer routes off the axis, the way a transit map separates parallel lines.
  // Gentler than it looks it should be: these arcs are only there to keep collinear
  // routes apart, and on a 30-stop map an over-bowed line sweeps across half the board.
  const BOW = [0, 0.085, -0.11]; // taxi runs straight; bus and tube bend opposite ways
  for (let t = (s.transport || []).length - 1; t >= 0; t--) {
    for (const n of nodes) {
      for (const m of (s.edges || [])[t][n.id]) {
        if (m < n.id) continue; // one line per edge
        const a = px(n);
        const b = px(nodes[m]);
        const k = BOW[t];
        if (!k) {
          svg += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="mh-edge taxi"/>`;
        } else {
          const cx = (a.x + b.x) / 2 - (b.y - a.y) * k;
          const cy = (a.y + b.y) / 2 + (b.x - a.x) * k;
          svg += `<path d="M${a.x} ${a.y}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x} ${b.y}" class="mh-edge ${MH_ROUTE[t]}"/>`;
        }
      }
    }
  }
  // where the runner was last forced into the open
  if (s.lastSeenAt != null && s.runnerAt == null) {
    const p = px(nodes[s.lastSeenAt]);
    svg += `<circle cx="${p.x}" cy="${p.y}" r="5.6" class="mh-seen"/>`;
  }
  for (const n of nodes) {
    const p = px(n);
    const isDest = dests.has(n.id);
    if (isDest) svg += `<circle cx="${p.x}" cy="${p.y}" r="3.4" class="mh-halo"/>`;
    svg += `<circle cx="${p.x}" cy="${p.y}" r="3.8" class="mh-stop${isDest ? ' dest' : ''}"/>`;
    svg += `<text x="${p.x}" y="${p.y}" class="mh-slabel${isDest ? ' on' : ''}">${n.id + 1}</text>`;
    // A transparent disc carries the tap: the stop is only ~16px across on a phone, and
    // the number painted over it would otherwise swallow the press.
    if (isDest) svg += `<circle cx="${p.x}" cy="${p.y}" r="8" class="mh-hit" data-node="${n.id}"/>`;
  }
  // Tokens sit ON their stop. Agents sharing one fan out evenly rather than stacking.
  const share = {};
  (s.hunterAt || []).forEach((node) => { share[node] = (share[node] || 0) + 1; });
  const placed = {};
  (s.hunterAt || []).forEach((node, i) => {
    const p = px(nodes[node]);
    const n = share[node];
    const seat = placed[node] = (placed[node] == null ? 0 : placed[node] + 1);
    const shift = n > 1 ? (seat - (n - 1) / 2) * 4.6 : 0;
    const next = s.phase === 'run' && s.stage === 'hunter' && s.hunterPiece === i;
    svg += `<g class="mh-token mh-agent${next ? ' next' : ''}">` +
      `<circle cx="${(p.x + shift).toFixed(1)}" cy="${p.y - 5.4}" r="2.7" class="body"/>` +
      `<text x="${(p.x + shift).toFixed(1)}" y="${p.y - 5.4}" class="mark">${i + 1}</text></g>`;
  });
  if (s.runnerAt != null) {
    const p = px(nodes[s.runnerAt]);
    svg += `<g class="mh-token mh-runner"><circle cx="${p.x}" cy="${p.y + 5.4}" r="2.9" class="body"/>` +
      `<text x="${p.x}" y="${p.y + 5.4}" class="mark">R</text></g>`;
  }
  svg += '</svg>';
  box.innerHTML = svg;

  box.querySelector('svg').onclick = (e) => {
    const raw = e.target.getAttribute && e.target.getAttribute('data-node');
    if (raw == null) return;
    const m = dests.get(Number(raw));
    if (!m) return;
    tapAck(e.target);
    if (you.role === 'runner') send({ type: 'run', to: m.to, transport: m.transport });
    else send({ type: 'hunt', to: m.to });
  };
}

function renderMhTrail(s) {
  const box = $('mhTrail');
  const trail = s.trail || [];
  if (!trail.length) {
    box.innerHTML = '<span class="empty">No moves yet</span>';
    return;
  }
  box.innerHTML = trail.map((step) => {
    const t = (s.transport || [])[step.transport] || {};
    return `<span class="mh-step ${MH_ROUTE[step.transport]}${step.node != null ? ' seen' : ''}" ` +
      `title="Turn ${step.turn} · ${escapeHtml(t.name || '')}${step.node != null ? ' · surfaced at ' + (step.node + 1) : ''}">` +
      `<i class="line"></i>${step.node != null ? step.node + 1 : `<i class="t">${step.turn}</i>`}</span>`;
  }).join('');
}

function renderMhStatus(s) {
  const you = s.you || {};
  if (s.over) return duelStatus('mhStatus', 'Both runs are in', false);
  if (you.spectator) return duelStatus('mhStatus', 'Spectating — the runner is hidden from you too', false);
  if (s.phase === 'break') return duelStatus('mhStatus', 'Half time — <b>you swap roles</b> on the same map', true);
  if (!you.isTurn) {
    const active = (s.players || []).find((p) => p.isTurn);
    return duelStatus('mhStatus', `Waiting for <b>${active ? escapeHtml(active.name) : '…'}</b>`, true);
  }
  if (you.role === 'hunter') return duelStatus('mhStatus', `Move <b>agent ${s.hunterPiece + 1}</b> — tap a lit stop`, true);
  return duelStatus('mhStatus', s.surfacesThisTurn
    ? 'You <b>surface this turn</b> — they will see where you land'
    : 'Only your <b>route</b> is announced, not where you go', true);
}

function renderMhActions(s) {
  const area = $('mhActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(duelOver(s, (win, shared, names) => (win ? (shared ? '🤝 Honours even' : '🏆 You outlasted them!') : `${names} outlasted you`),
      [...(s.players || [])].sort((a, b) => (b.survived || 0) - (a.survived || 0))
        .map((p) => ({ seat: p.seat, name: p.name, note: 'as the runner', total: p.survived == null ? '–' : p.survived }))));
    return;
  }
  const you = s.you || {};
  if (you.spectator || !you.isTurn || you.role !== 'runner') return;
  // The route picker doubles as the map legend: each swatch is the line on the map.
  const row = document.createElement('div');
  row.className = 'mh-routes';
  (s.transport || []).forEach((t, i) => {
    const n = (you.moves || []).filter((m) => m.transport === i).length;
    const b = document.createElement('button');
    b.className = `mh-route ${MH_ROUTE[i]}` + (mhTransport === i ? ' on' : '');
    b.innerHTML = `<i class="line"></i>${escapeHtml(t.name)}<span class="n">${n}</span>`;
    b.disabled = n === 0;
    b.onclick = () => { mhTransport = i; render(); };
    row.appendChild(b);
  });
  area.appendChild(row);
}

// ---------------------------------------------------------------------------
// Three Fronts — two-player card duel
// ---------------------------------------------------------------------------

let tfSel = null; // cardId the player has picked up
let tfDown = false; // commit it face-down?

function renderThreeFronts(s) {
  $('tfRoom').textContent = s.room;
  const you = s.you || {};
  const pill = $('tfPhase');
  pill.textContent = s.over ? 'Over' : s.phase === 'result' ? 'Result' : `Battle ${s.battleNo}`;
  pill.className = 'phase-pill';
  $('tfCopy').onclick = copyInvite;
  if (!you.canAct) { tfSel = null; tfDown = false; }
  if (tfSel != null && !(you.hand || []).some((c) => c.cardId === tfSel)) tfSel = null;

  duelRoster('tfPlayers', s, (p) =>
    `<span class="duel-tag${p.fronts >= 2 ? ' on' : ''}">${p.fronts}/3 fronts</span>` +
    `<span>${p.cardsLeft} card${p.cardsLeft === 1 ? '' : 's'}</span>` +
    `<span class="duel-p-num">${p.score}<span class="of">/${s.target}</span></span>`);
  renderTfFronts(s);
  renderTfHand(s);
  renderTfStatus(s);
  renderTfActions(s);
  duelLog('tfLog', s);
}

/** Can the picked card go to front `i` the way it's currently oriented? */
function tfCanPlay(s, i) {
  const you = s.you || {};
  if (!you.canAct || tfSel == null) return false;
  const c = (you.hand || []).find((x) => x.cardId === tfSel);
  if (!c) return false;
  return tfDown ? !(you.blocked || [])[i] : c.theatre === i;
}

function tfCardHtml(p, mySeat) {
  if (p.cardId == null) return '<div class="tf-card down" title="Face-down — counts 2"></div>';
  const cls = 'tf-card' + (p.faceDown ? ' revealed' : '') + (p.seat === mySeat ? ' mine' : '');
  return `<div class="${cls}" title="${escapeHtml(p.label)}${p.faceDown ? ' (was face-down)' : ''}">` +
    `<span class="r">${p.rank}</span>${duelIcon(FRONT_ICON[p.theatre])}</div>`;
}

function renderTfFronts(s) {
  const box = $('tfBoard');
  box.innerHTML = '';
  const mySeat = s.seat;
  const meIdx = (s.players || []).findIndex((p) => p.seat === mySeat);
  (s.board || []).forEach((f, i) => {
    const held = f.control === null ? '' : f.control === mySeat ? ' mine' : ' theirs';
    const col = document.createElement('div');
    col.className = 'tf-front' + held + (tfCanPlay(s, i) ? ' droppable' : '');

    const myStr = meIdx >= 0 ? f.strength[meIdx] : f.strength[0];
    const theirStr = meIdx >= 0 ? f.strength[1 - meIdx] : f.strength[1];
    const theirs = (f.plays || []).filter((p) => p.seat !== mySeat);
    const mine = (f.plays || []).filter((p) => p.seat === mySeat);

    // Every front has exactly one bonus, so name it here whether or not anyone holds it
    // yet — an empty column then teaches what the front does instead of sitting blank.
    // (`blocked` lists whoever is SHUT OUT, so the holder is the other player.)
    const holders = i === 2 ? f.blocked.map((seat) => (seat === mySeat ? 'theirs' : 'mine')) : (i === 0 ? f.recon : f.entrench).map((seat) => (seat === mySeat ? 'mine' : 'theirs'));
    const chips = holders.length
      ? holders.map((who) => `<span class="tf-bchip ${who}">${escapeHtml(f.bonus)}</span>`)
      : [`<span class="tf-bchip idle" title="${escapeHtml(f.blurb)}">${escapeHtml(f.bonus)}</span>`];

    col.innerHTML =
      `<div class="tf-fhead">${duelIcon(FRONT_ICON[i])}${escapeHtml(f.name)}</div>` +
      `<div class="tf-stack theirs">${theirs.map((p) => tfCardHtml(p, mySeat)).join('')}</div>` +
      `<div class="tf-tally"><b class="${theirStr > myStr ? 'lead' : ''}">${theirStr}</b>` +
      `<span class="v">v</span><b class="${myStr > theirStr ? 'lead' : ''}">${myStr}</b></div>` +
      `<div class="tf-stack mine">${mine.map((p) => tfCardHtml(p, mySeat)).join('')}</div>` +
      `<div class="tf-bonus">${chips.join('')}</div>`;

    if (tfCanPlay(s, i)) {
      col.onclick = () => {
        tapAck(col);
        send({ type: 'deploy', cardId: tfSel, front: i, faceDown: tfDown });
        tfSel = null;
        tfDown = false;
      };
    }
    box.appendChild(col);
  });
}

function renderTfHand(s) {
  const box = $('tfHand');
  box.innerHTML = '';
  const you = s.you || {};
  if (you.spectator) return;
  for (const c of you.hand || []) {
    const b = document.createElement('button');
    b.className = 'tf-handcard' + (tfSel === c.cardId ? ' picked' : '');
    b.innerHTML = `<span class="r">${c.rank}</span>${duelIcon(FRONT_ICON[c.theatre])}`;
    b.title = c.label;
    b.disabled = !you.canAct;
    b.onclick = () => {
      tapAck(b);
      tfSel = tfSel === c.cardId ? null : c.cardId;
      render();
    };
    box.appendChild(b);
  }
}

function renderTfStatus(s) {
  const you = s.you || {};
  if (s.over) return duelStatus('tfStatus', 'The war is over', false);
  if (you.spectator) return duelStatus('tfStatus', 'Spectating', false);
  if (s.phase === 'result') {
    const r = s.result || {};
    const who = r.winnerSeat === null ? null : r.winnerSeat === s.seat ? 'You' : (s.players.find((p) => p.seat === r.winnerSeat) || {}).name;
    return duelStatus('tfStatus', who === null
      ? 'Stalemate — <b>no points</b>'
      : `${escapeHtml(who)} take${who === 'You' ? '' : 's'} the battle <b>+${r.points}</b>`, true);
  }
  if (!you.isTurn) {
    const active = (s.players || []).find((p) => p.isTurn);
    return duelStatus('tfStatus', `Waiting for <b>${active ? escapeHtml(active.name) : '…'}</b>`, true);
  }
  if (tfSel == null) return duelStatus('tfStatus', 'Your move — <b>pick a card</b>', true);
  const c = (you.hand || []).find((x) => x.cardId === tfSel);
  return duelStatus('tfStatus', tfDown
    ? 'Tap any front to bury it — it <b>counts 2</b> and stays secret'
    : `Tap <b>${escapeHtml((s.board[c.theatre] || {}).name || '')}</b> — face-up cards go to their own theatre`, true);
}

function renderTfActions(s) {
  const area = $('tfActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(duelOver(s, (win, shared, names) => (win ? '🏆 You win the war!' : `${names} wins the war`),
      [...(s.players || [])].sort((a, b) => b.score - a.score).map((p) => ({ seat: p.seat, name: p.name, total: p.score }))));
    return;
  }
  const you = s.you || {};
  if (you.spectator || !you.isTurn || s.phase === 'result') return;

  // face-up / face-down is the whole decision, so it gets a real control
  const mode = document.createElement('div');
  mode.className = 'tf-mode';
  const upBtn = document.createElement('button');
  upBtn.className = tfDown ? '' : 'on';
  upBtn.textContent = 'Face-up · rank + bonus';
  upBtn.onclick = () => { tfDown = false; render(); };
  const downBtn = document.createElement('button');
  downBtn.className = tfDown ? 'on' : '';
  downBtn.textContent = 'Face-down · 2, secret';
  downBtn.onclick = () => { tfDown = true; render(); };
  mode.append(upBtn, downBtn);
  area.appendChild(mode);

  const cardsLeft = ((s.players || []).find((p) => p.seat === s.seat) || {}).cardsLeft || 0;
  const cost = cardsLeft >= 4 ? 2 : cardsLeft >= 2 ? 3 : 4;
  const wd = document.createElement('button');
  wd.className = 'tf-withdraw';
  wd.innerHTML = `Withdraw — concede this battle for <b>${cost}</b>`;
  wd.onclick = () => send({ type: 'withdraw' });
  area.appendChild(wd);
}

// ---------------------------------------------------------------------------
// Salvo — two-player hidden fleets
// ---------------------------------------------------------------------------

const SV_FILES = 'ABCDEFGH';
let svSel = null; // index of the ship being positioned

/** A hull drawn to span `size` cells. One generator serves both orientations:
 *  points are given along/across the ship and mapped, so the bow stays a bow. */
function svHullSvg(size, horiz) {
  const L = size * 100;
  const pt = (u, v) => (horiz ? [u, v] : [v, L - u]);
  const P = (u, v) => pt(u, v).map((n) => Math.round(n * 10) / 10).join(' ');
  const vb = horiz ? `0 0 ${L} 100` : `0 0 100 ${L}`;
  const hull = `M${P(8, 20)}L${P(L - 46, 20)}Q${P(L - 4, 50)} ${P(L - 46, 80)}L${P(8, 80)}Q${P(0, 50)} ${P(8, 20)}Z`;
  const deck = `M${P(22, 37)}L${P(L - 56, 37)}Q${P(L - 30, 50)} ${P(L - 56, 63)}L${P(22, 63)}Z`;
  const bridge = `M${P(L * 0.34, 28)}L${P(L * 0.48, 28)}L${P(L * 0.48, 72)}L${P(L * 0.34, 72)}Z`;
  const spots = size >= 4 ? [0.17, 0.66] : size >= 3 ? [0.2] : [];
  const turrets = spots.map((f) => {
    const [cx, cy] = pt(L * f, 50);
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="12" class="turret"/>`;
  }).join('');
  return `<svg class="hull" viewBox="${vb}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="body" d="${hull}"/><path class="deck" d="${deck}"/>` +
    `<path class="bridge" d="${bridge}"/>${turrets}</svg>`;
}

function renderSalvo(s) {
  $('svRoom').textContent = s.room;
  const pill = $('svPhase');
  pill.textContent = s.over ? 'Over' : s.phase === 'place' ? 'Placing' : 'At sea';
  pill.className = 'phase-pill';
  $('svCopy').onclick = copyInvite;
  const you = s.you || {};
  if (s.phase !== 'place' || you.ready) svSel = null;

  duelRoster('svPlayers', s, (p) => {
    const total = p.afloat + p.sunkShips.length;
    const pips = (s.fleet || []).map((f, i) => `<i class="sv-pip${i < p.afloat ? '' : ' down'}" style="height:${5 + f.size * 1.6}px"></i>`).join('');
    return `<span class="sv-fleet" title="${p.afloat} of ${total} afloat">${pips}</span>` +
      (s.phase === 'place'
        ? `<span class="duel-tag${p.ready ? ' on' : ''}">${p.ready ? 'ready' : 'placing'}</span>`
        : `<span class="duel-p-num">${p.afloat}<span class="of">/${total}</span></span>`);
  });
  renderSvBoards(s);
  renderSvStatus(s);
  renderSvActions(s);
  duelLog('svLog', s);
}

/** One grid. `mode` is 'enemy' (you fire into it) or 'own' (your waters). */
function svGrid(s, cells, ships, mode) {
  const you = s.you || {};
  const placing = mode === 'own' && s.phase === 'place' && !you.ready && !you.spectator;
  const wrap = document.createElement('div');
  wrap.className = 'sv-grid-wrap' + (mode === 'own' && s.phase !== 'place' ? ' own' : '');
  wrap.innerHTML = `<div class="duel-label">${mode === 'enemy' ? 'Their waters' : 'Your waters'}</div>`;

  const grid = document.createElement('div');
  grid.className = 'sv-grid';
  // EVERY item is placed explicitly. Grid positions explicit items before auto ones,
  // so a single auto-flowed cell would reflow around the hulls and shear the board.
  const place = (el, col, row) => { el.style.gridColumn = String(col); el.style.gridRow = String(row); return el; };
  grid.appendChild(place(document.createElement('span'), 1, 1)); // empty corner
  for (let x = 0; x < s.size; x++) {
    const h = document.createElement('span');
    h.className = 'sv-coord';
    h.textContent = SV_FILES[x];
    grid.appendChild(place(h, x + 2, 1));
  }
  const at = new Map(cells.map((c) => [c.x + ',' + c.y, c]));
  const last = s.last;
  for (let y = 0; y < s.size; y++) {
    const r = document.createElement('span');
    r.className = 'sv-coord';
    r.textContent = y + 1;
    grid.appendChild(place(r, 1, y + 2));
    for (let x = 0; x < s.size; x++) {
      const c = at.get(x + ',' + y) || { x, y, shot: null };
      const cell = document.createElement('button');
      let cls = 'sv-cell';
      if (c.shot === 'hit') cls += ' hit';
      else if (c.shot === 'miss') cls += ' miss';
      if (mode === 'enemy' && c.sunk) cls += ' wreck';
      if (last && last.x === x && last.y === y && (mode === 'enemy') === (last.pid === you.pid)) cls += ' last';
      cell.className = cls;
      cell.title = `${SV_FILES[x]}${y + 1}${c.sunk ? ' · ' + c.sunk : ''}`;
      const fireable = mode === 'enemy' && you.canFire && c.shot === null;
      // While positioning, every square is a drop target for the selected ship.
      const droppable = placing && svSel != null;
      cell.disabled = !fireable && !droppable;
      if (fireable) cell.onclick = () => { tapAck(cell); send({ type: 'fire', x, y }); };
      else if (droppable) {
        cell.classList.add('drop');
        cell.onclick = () => {
          tapAck(cell);
          const sh = (ships || []).find((p) => p.index === svSel);
          send({ type: 'placeShip', index: svSel, x, y, horiz: sh ? sh.horiz : true });
        };
      }
      grid.appendChild(place(cell, x + 2, y + 2));
    }
  }

  // Hulls sit over the water as grid items of their own; hit markers paint above them.
  for (const sh of ships || []) {
    const el = document.createElement(placing ? 'button' : 'div');
    el.className = 'sv-ship' + (sh.sunk ? ' sunk' : '') + (mode === 'enemy' ? ' wreck' : '') + (svSel === sh.index ? ' picked' : '');
    el.style.gridColumn = sh.horiz ? `${sh.x + 2} / span ${sh.size}` : `${sh.x + 2}`;
    el.style.gridRow = sh.horiz ? `${sh.y + 2}` : `${sh.y + 2} / span ${sh.size}`;
    el.title = `${sh.name} · ${sh.size}`;
    el.innerHTML = svHullSvg(sh.size, sh.horiz);
    if (placing) {
      // Only the ship in hand lets taps through to the water beneath it — so you can
      // nudge it one square onto its own tail, while still tapping any OTHER hull to
      // pick that one up instead. (Dropping onto another ship is illegal anyway, so
      // nothing is lost by letting those hulls keep their clicks.)
      if (svSel === sh.index) el.classList.add('pass');
      el.onclick = () => {
        tapAck(el);
        svSel = svSel === sh.index ? null : sh.index;
        render();
      };
    }
    grid.appendChild(el);
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderSvBoards(s) {
  const box = $('svBoards');
  box.innerHTML = '';
  const you = s.you || {};
  if (you.spectator) {
    box.innerHTML = '<div class="duel-label">Both fleets are hidden from the sideline</div>';
    return;
  }
  if (s.phase !== 'place') box.appendChild(svGrid(s, you.enemy || [], you.wrecks || [], 'enemy'));
  box.appendChild(svGrid(s, you.own || [], you.fleet || [], 'own'));
}

function renderSvStatus(s) {
  const you = s.you || {};
  if (s.over) return duelStatus('svStatus', 'All ships accounted for', false);
  if (you.spectator) return duelStatus('svStatus', 'Spectating', false);
  if (s.phase === 'place') {
    if (you.ready) return duelStatus('svStatus', 'Fleet at sea — <b>waiting for them</b>', true);
    const sh = (you.fleet || []).find((p) => p.index === svSel);
    return duelStatus('svStatus', sh
      ? `<b>${escapeHtml(sh.name)}</b> in hand — tap a square to set its bow`
      : 'Tap a ship to move it, or <b>give the order</b>', true);
  }
  if (!you.isTurn) {
    const active = (s.players || []).find((p) => p.isTurn);
    return duelStatus('svStatus', `<b>${active ? escapeHtml(active.name) : '…'}</b> is taking a shot`, true);
  }
  const last = s.last;
  const streak = last && last.pid === you.pid && last.result === 'hit';
  return duelStatus('svStatus', streak
    ? `<b>${last.sunk ? last.sunk + ' sunk!' : 'Hit!'}</b> Fire again`
    : 'Your shot — <b>tap a square in their waters</b>', true);
}

function renderSvActions(s) {
  const area = $('svActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(duelOver(s, (win, shared, names) => (win ? '🏆 Fleet destroyed — you win!' : `${names} sank your fleet`),
      (s.players || []).map((p) => ({ seat: p.seat, name: p.name, note: `${p.sunkShips.length} of ${p.sunkShips.length + p.afloat} sunk`, total: p.afloat }))));
    return;
  }
  const you = s.you || {};
  if (you.spectator || s.phase !== 'place' || you.ready) return;

  // The fleet strip is the ship picker: it names each hull and shows its length,
  // which the silhouettes alone can't say once they're side by side on the water.
  const strip = document.createElement('div');
  strip.className = 'sv-fleetbar';
  for (const sh of you.fleet || []) {
    const b = document.createElement('button');
    b.className = 'sv-shipbtn' + (svSel === sh.index ? ' picked' : '');
    b.innerHTML = `<span class="nm">${escapeHtml(sh.name)}</span><span class="sz">${sh.size}</span>`;
    b.onclick = () => {
      tapAck(b);
      svSel = svSel === sh.index ? null : sh.index;
      render();
    };
    strip.appendChild(b);
  }
  area.appendChild(strip);

  const row = document.createElement('div');
  row.className = 'btn-row';
  const rot = actBtn('Rotate', 'btn btn-ghost btn-lg', () => send({ type: 'rotateShip', index: svSel }));
  rot.disabled = svSel == null;
  row.appendChild(rot);
  row.appendChild(actBtn('Shuffle all', 'btn btn-ghost btn-lg', () => { svSel = null; send({ type: 'shuffleFleet' }); }));
  area.appendChild(row);
  area.appendChild(actBtn('Give the order', 'btn btn-primary btn-lg', () => send({ type: 'ready' })));
}

// ---------------------------------------------------------------------------
// Sealed Bids — two-player blind auction
// ---------------------------------------------------------------------------

let sbPick = null; // card tapped but not yet sealed

function renderSealedBids(s) {
  $('sbRoom').textContent = s.room;
  const pill = $('sbPhase');
  pill.textContent = s.over ? 'Over' : `${s.round}/${s.rounds}`;
  pill.className = 'phase-pill';
  $('sbCopy').onclick = copyInvite;
  const you = s.you || {};
  if (!you.canBid) sbPick = null; // a sealed bid can't be taken back

  duelRoster('sbPlayers', s, (p) =>
    (s.over || s.last ? '' : `<span class="duel-tag${p.committed ? ' on' : ''}">${p.committed ? 'sealed' : 'thinking'}</span>`) +
    `<span>${p.cardsLeft} left</span>` +
    `<span class="duel-p-num">${p.score}</span>`);
  renderSbTable(s);
  renderSbHand(s);
  renderSbStatus(s);
  renderSbActions(s);
  duelLog('sbLog', s);
}

function renderSbTable(s) {
  const box = $('sbTable');
  box.innerHTML = '';
  // Mid-reveal the pot has already been paid out, so show what was just fought over
  // rather than the emptied table.
  const settled = s.last ? s.last.prize : null;
  const pot = settled || s.pot || [];
  const total = pot.reduce((x, y) => x + y, 0);
  if (s.over) {
    // Nothing left to contest — the spent rows below are the interesting artefact.
    const done = document.createElement('div');
    done.className = 'duel-label';
    done.textContent = `All ${s.rounds} prizes settled`;
    box.appendChild(done);
  } else {
  const prize = document.createElement('div');
  prize.className = 'sb-prize' + (pot.length > 1 ? ' carried' : '');
  prize.innerHTML =
    `<span class="cap">${pot.length > 1 ? `${pot.length} prizes` : 'Prize'}</span>` +
    `<span class="val">${total}</span>` +
    `<span class="sub">${settled ? (s.last.winnerSeat === null ? 'carried over' : 'taken') : pot.length > 1 ? pot.join(' + ') : 'points'}</span>`;
  box.appendChild(prize);
  }

  const last = s.last;
  if (last) {
    const duel = document.createElement('div');
    duel.className = 'sb-duel';
    (s.players || []).forEach((p, i) => {
      const won = last.winnerSeat === p.seat;
      const card = document.createElement('div');
      card.className = 'sb-bid' + (won ? ' won' : last.winnerSeat === null ? ' tied' : ' lost');
      card.innerHTML =
        `<span class="who">${p.seat === s.seat ? 'You' : escapeHtml(p.name)}</span>` +
        `<span class="val">${last.bids[i]}</span>` +
        `<span class="tag">${won ? 'takes it' : last.winnerSeat === null ? 'tied' : 'spent'}</span>`;
      duel.appendChild(card);
    });
    box.appendChild(duel);
  }

  // what they've already spent is public, and reading it is the game
  const shown = s.over ? (s.players || []) : (s.players || []).filter((p) => p.seat !== s.seat);
  for (const p of shown) {
    if (!(p.spent || []).length) continue;
    const strip = document.createElement('div');
    strip.innerHTML = `<div class="duel-label">${p.seat === s.seat ? 'You' : escapeHtml(p.name)} spent</div>` +
      `<div class="sb-spent">${p.spent.map((c) => `<i>${c}</i>`).join('')}</div>`;
    box.appendChild(strip);
  }
}

/** All thirteen slots, with the ones you've spent left as dashed ghosts. */
function renderSbHand(s) {
  const box = $('sbHand');
  box.innerHTML = '';
  const you = s.you || {};
  if (you.spectator) return;
  const held = new Set(you.hand || []);
  for (let c = 1; c <= (s.rounds || 13); c++) {
    const b = document.createElement('button');
    const spent = !held.has(c);
    b.className = 'sb-card' + (spent ? ' spent' : '') + (sbPick === c ? ' picked' : '') + (you.bid === c ? ' sealed' : '');
    b.textContent = c;
    b.disabled = spent || !you.canBid;
    if (!spent) {
      b.onclick = () => {
        tapAck(b);
        sbPick = sbPick === c ? null : c;
        render();
      };
    }
    box.appendChild(b);
  }
}

function renderSbStatus(s) {
  const you = s.you || {};
  if (s.over) return duelStatus('sbStatus', 'Every prize is spoken for', false);
  if (you.spectator) return duelStatus('sbStatus', 'Spectating', false);
  if (s.last) {
    return duelStatus('sbStatus', s.last.winnerSeat === null
      ? `Tied — <b>${s.potTotal}</b> rides on the next prize`
      : `${s.last.winnerSeat === s.seat ? 'You take' : escapeHtml((s.players.find((p) => p.seat === s.last.winnerSeat) || {}).name) + ' takes'} <b>${s.last.prize.reduce((a, b) => a + b, 0)}</b>`, true);
  }
  if (you.bid != null) return duelStatus('sbStatus', `Sealed <b>${you.bid}</b> — waiting for them`, true);
  if (!you.canBid) return duelStatus('sbStatus', 'Next prize coming up', true);
  return duelStatus('sbStatus', sbPick == null
    ? `Bidding for <b>${s.potTotal}</b> — pick a card`
    : `Bid <b>${sbPick}</b> for <b>${s.potTotal}</b>?`, true);
}

function renderSbActions(s) {
  const area = $('sbActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(duelOver(s, (win, shared, names) => (win ? (shared ? '🤝 Dead heat!' : '🏆 You win!') : `${names} wins`),
      [...(s.players || [])].sort((a, b) => b.score - a.score).map((p) => ({ seat: p.seat, name: p.name, total: p.score }))));
    return;
  }
  const you = s.you || {};
  if (you.spectator || !you.canBid || sbPick == null) return;
  area.appendChild(actBtn(`Seal your bid of ${sbPick}`, 'btn btn-primary btn-lg', () => {
    send({ type: 'bid', card: sbPick });
    sbPick = null;
  }));
}

// ---------------------------------------------------------------------------
// Memory Match — multilingual concentration
// ---------------------------------------------------------------------------

const MM_LANGS = [
  { code: 'en', label: 'EN', flag: '🇬🇧' },
  { code: 'fr', label: 'FR', flag: '🇫🇷' },
  { code: 'ko', label: 'KO', flag: '🇰🇷' },
];
const mmFlag = (code) => (MM_LANGS.find((l) => l.code === code) || {}).flag || '';

function renderMemoryMatch(s) {
  $('mmRoom').textContent = s.room;
  const active = (s.players || []).find((p) => p.isTurn);
  const pill = $('mmTurn');
  pill.textContent = s.over ? 'Game over' : active ? `${active.seat === s.seat ? 'Your' : escapeHtml(active.name) + '’s'} turn · ${s.pairsLeft} left` : '—';
  pill.className = 'phase-pill';
  $('mmCopy').onclick = copyInvite;
  renderMMPlayers(s);
  renderMMBoard(s);
  renderMMActions(s);
  renderMMLog(s);
}

function renderMMPlayers(s) {
  const box = $('mmPlayers');
  const bots = botSeatSet(s);
  box.innerHTML = '';
  (s.players || []).forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'mm-pchip' + (p.isTurn ? ' acting' : '');
    chip.style.borderColor = seatColor(p.seat);
    chip.innerHTML =
      `<span class="mm-pdot" style="background:${seatColor(p.seat)}"></span>` +
      `<span class="mm-pname">${escapeHtml(p.name)}${bots.has(p.seat) ? ' 🤖' : ''}${p.seat === s.seat ? ' (you)' : ''}</span>` +
      `<span class="mm-plang">${mmFlag(p.lang)}</span>` +
      `<span class="mm-pscore">${p.score}</span>`;
    box.appendChild(chip);
  });
}

function renderMMBoard(s) {
  const box = $('mmBoard');
  box.innerHTML = '';
  const you = s.you || {};
  const canFlip = !s.over && you.canFlip;
  const n = (s.cards || []).length;
  box.style.setProperty('--mm-cols', n <= 16 ? 4 : n <= 24 ? 6 : 8);
  const flipped = new Set(s.flipped || []);
  for (const c of s.cards || []) {
    const el = document.createElement('button');
    el.className = 'mm-card ' + (c.faceUp ? 'up ' + (c.side || '') : 'down');
    if (c.matched) el.classList.add('matched');
    if (c.peek) el.classList.add('miss');
    if (flipped.has(c.cardId)) el.classList.add('sel');
    if (c.matchedBy != null) el.style.borderColor = seatColor(c.matchedBy);
    if (c.faceUp) {
      el.innerHTML = c.side === 'word' ? `<span class="mm-word">${escapeHtml(c.text || '')}</span>` : `<span class="mm-emoji">${c.emoji || ''}</span>`;
    } else {
      // backs are identical — you can't tell a word card from an image card
      el.innerHTML = '<span class="mm-back">?</span>';
    }
    if (canFlip && !c.faceUp) el.onclick = () => { tapAck(el); send({ type: 'flipCard', cardId: c.cardId }); };
    else el.disabled = true;
    box.appendChild(el);
  }
}

function renderMMLangPicker(s) {
  const row = document.createElement('div');
  row.className = 'mm-langrow';
  const lbl = document.createElement('span');
  lbl.className = 'mm-langlbl';
  lbl.textContent = 'Your language:';
  row.appendChild(lbl);
  const mine = (s.you || {}).lang || 'en';
  for (const l of MM_LANGS) {
    row.appendChild(actBtn(`${l.flag} ${l.label}`, 'btn ' + (mine === l.code ? 'btn-gold' : 'btn-neutral') + ' mm-langbtn', () => send({ type: 'setLanguage', lang: l.code })));
  }
  return row;
}

function renderMMActions(s) {
  const area = $('mmActions');
  area.innerHTML = '';
  if (s.over) {
    area.appendChild(renderMMOver(s));
    return;
  }
  const you = s.you || {};
  if (!you.spectator) area.appendChild(renderMMLangPicker(s));
  if (you.spectator) {
    area.appendChild(callout('Spectating this match', true));
    return;
  }
  if (s.phase === 'reveal') {
    area.appendChild(callout('No match — flipping back…', true));
    return;
  }
  if (you.isTurn) {
    const flippedN = (s.flipped || []).length;
    area.appendChild(prompt(flippedN === 1 ? 'Flip a <b>second</b> card to find its match.' : 'Your turn — <b>flip two cards</b> to find a word + its picture.'));
  } else {
    const active = (s.players || []).find((p) => p.isTurn);
    area.appendChild(callout(`Waiting for ${active ? escapeHtml(active.name) : '…'} to flip`, true));
  }
}

function renderMMOver(s) {
  const box = document.createElement('div');
  box.className = 'result';
  const youWin = (s.winners || []).includes(s.seat);
  const shared = (s.winners || []).length > 1;
  const names = (s.winners || []).map((seat) => (seat === s.seat ? 'You' : (s.players.find((p) => p.seat === seat) || {}).name)).join(', ');
  box.appendChild(banner(youWin ? (shared ? '🤝 Shared win!' : '🏆 You win!') : `${escapeHtml(names)} win${shared ? '' : 's'}`, youWin ? 'win' : 'lose'));
  const tbl = document.createElement('div');
  tbl.className = 'li-finals';
  [...(s.players || [])].sort((a, b) => b.score - a.score).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'li-frow' + ((s.winners || []).includes(p.seat) ? ' win' : '');
    row.innerHTML =
      `<span class="mm-pdot" style="background:${seatColor(p.seat)}"></span>` +
      `<span class="li-fname">${p.seat === s.seat ? 'You' : escapeHtml(p.name)} ${mmFlag(p.lang)}</span>` +
      `<span class="li-ftotal">${p.score} pairs</span>`;
    tbl.appendChild(row);
  });
  box.appendChild(tbl);
  appendEndButtons(box, s);
  return box;
}

function renderMMLog(s) {
  const ul = $('mmLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

// Card containers only rebuild (and re-animate) when their contents change.
const cardSig = { you: '', opp: '', shared: '' };

function renderShared(s) {
  const sig = s.shared ? `${s.shared.suit}${s.shared.id}` : 'none';
  if (sig === cardSig.shared) return;
  cardSig.shared = sig;
  let el;
  if (s.shared) {
    el = cardEl(s.shared);
  } else {
    el = document.createElement('div');
    el.className = 'card placeholder';
    el.textContent = '?';
  }
  el.id = 'sharedCard';
  $('sharedCard').replaceWith(el);
}

// Players seated around the oval, with "you" anchored at the bottom.
const SEAT_RX = 47;
const SEAT_RY = 46;
let seatsSig = '';

function buildSeatList(s) {
  const bySeat = {};
  bySeat[s.seat] = { ...s.you, seat: s.seat, isYou: true };
  for (const o of s.others || []) bySeat[o.seat] = { ...o, isYou: false };
  const all = (s.roster || [])
    .map((p) => bySeat[p.seat])
    .filter((p) => p && (p.isYou || !p.eliminated));
  all.sort((a, b) => a.seat - b.seat);
  const yi = all.findIndex((p) => p.isYou);
  return yi < 0 ? all : [...all.slice(yi), ...all.slice(0, yi)];
}

const seatAngle = (i, n) => ((90 + (i * 360) / n) * Math.PI) / 180; // i=0 → bottom (you)
const posAt = (theta, rx, ry) => ({ left: 50 + rx * Math.cos(theta), top: 50 + ry * Math.sin(theta) });

function renderSeats(s) {
  const list = buildSeatList(s);
  const bots = botSeatSet(s);
  const sig =
    list
      .map((p) => {
        const turn = p.isYou ? !!(s.betting && s.betting.yourTurn) : !!p.isTurn;
        return `${p.seat}:${p.chips}:${p.committed || 0}:${p.folded}:${p.allIn}:${turn}:${p.connected}:${bots.has(p.seat)}:${p.isYou ? 'Y' : p.holeCount}:${p.revealedCard ? p.revealedCard.suit + p.revealIndex : '-'}`;
      })
      .join('|') + `|${list.length}`;
  if (sig === seatsSig) return;
  seatsSig = sig;

  const box = $('seats');
  box.innerHTML = '';
  const n = list.length;
  list.forEach((p, i) => {
    const theta = seatAngle(i, n);
    const pos = posAt(theta, SEAT_RX, SEAT_RY);
    const turn = p.isYou ? !!(s.betting && s.betting.yourTurn) : !!p.isTurn;
    const tile = document.createElement('div');
    tile.className = 'pseat' + (p.isYou ? ' is-you' : '');
    if (turn) tile.classList.add('acting');
    if (p.folded || p.eliminated) tile.classList.add('dim');
    tile.style.left = `${pos.left}%`;
    tile.style.top = `${pos.top}%`;

    // Opponents' cards sit toward the centre; your big readable hand is below the table.
    if (!p.isYou) {
      const cards = document.createElement('div');
      cards.className = 'pseat-cards';
      for (let k = 0; k < (p.holeCount || 0); k++) {
        if (p.revealedCard && p.revealIndex === k) {
          const c = cardEl(p.revealedCard);
          c.classList.add('shown'); // revealed cards render larger
          cards.appendChild(c);
        } else {
          cards.appendChild(cardEl(null));
        }
      }
      tile.appendChild(cards);
    }

    const body = document.createElement('div');
    body.className = 'pseat-body';
    body.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(p.seat)}">${initial(p.name)}</span>` +
      `<span class="pseat-meta"><span class="pseat-name">${escapeHtml(p.name)}${bots.has(p.seat) ? ' 🤖' : ''}<i class="dot ${p.connected ? 'on' : ''}"></i></span>` +
      `<span class="pseat-chips">🪙 ${p.chips}</span></span>`;
    tile.appendChild(body);

    const badges = [];
    if (p.allIn) badges.push('<span class="badge b-allin">all-in</span>');
    if (p.folded) badges.push('<span class="badge b-fold">fold</span>');
    if (badges.length) {
      const bd = document.createElement('div');
      bd.className = 'pseat-badges';
      bd.innerHTML = badges.join('');
      tile.appendChild(bd);
    }
    box.appendChild(tile);

    // Bet chip sits on the felt, along the seat's angle toward the pot.
    if (p.committed) {
      const bpos = posAt(theta, SEAT_RX * 0.6, SEAT_RY * 0.58);
      const bet = document.createElement('div');
      bet.className = 'felt-bet';
      bet.innerHTML = `<span class="chip-dot"></span>${p.committed}`;
      bet.style.left = `${bpos.left}%`;
      bet.style.top = `${bpos.top}%`;
      box.appendChild(bet);
    }
  });
}

function renderYourHand(s) {
  const hole = (s.you && s.you.hole) || [];
  const revealing = s.phase === 'reveal' && s.reveal && !s.reveal.youLocked && s.you.inHand;
  const sig = `${hole.map((c) => c.suit).join(',')}|${s.you.revealIndex}|${revealing}|${s.you.folded}`;
  if (sig === cardSig.you) return;
  cardSig.you = sig;

  const box = $('yourCards');
  box.innerHTML = '';
  if (!s.you.hole) return; // spectating / not dealt in
  if (s.you.folded) {
    box.innerHTML = '<span class="folded-note">You folded this round</span>';
    return;
  }
  hole.forEach((card, i) => {
    const el = cardEl(card);
    if (s.you.revealIndex === i) el.classList.add('revealed');
    if (revealing) {
      if (card.suit === 'liar') {
        el.classList.add('disabled');
        el.title = 'You cannot reveal the liar';
      } else {
        el.classList.add('selectable');
        el.onclick = () => { tapAck(el); send({ type: 'reveal', cardIndex: i }); };
      }
    }
    box.appendChild(el);
  });
}

function renderTurnFlag(s) {
  const f = $('turnFlag');
  f.className = 'turn-banner';
  if (s.betting) {
    f.textContent = s.betting.yourTurn ? 'Your turn' : 'Their turn';
    f.classList.add(s.betting.yourTurn ? 'you' : 'wait');
  } else {
    f.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Who Am I? (football 20 questions)
// ---------------------------------------------------------------------------

function renderWhoAmI(s) {
  $('waRoom').textContent = s.room;
  $('waPhase').textContent = s.over ? 'Match over' : s.phase === 'roundOver' ? 'Round over' : `Round ${s.roundNo}/${s.roundsTotal}`;
  $('waCopy').onclick = copyInvite;
  $('waRulesBtn').onclick = () => $('waRulesSheet').classList.remove('hidden');
  renderWaPlayers(s);
  renderWaActions(s);
  renderWaQlog(s);
  const ul = $('waLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

function renderWaPlayers(s) {
  const box = $('waPlayers');
  box.innerHTML = '';
  const bots = botSeatSet(s);
  (s.players || []).forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'wa-pchip' + (p.isTurn ? ' turn' : '') + (p.eliminated ? ' out' : '');
    chip.style.borderColor = p.isTurn ? seatColor(p.seat) : '';
    chip.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(p.seat)}">${initial(p.name)}</span>` +
      `<span class="wa-pname">${escapeHtml(p.name)}${p.seat === s.seat ? ' (you)' : ''}${bots.has(p.seat) ? ' 🤖' : ''}</span>` +
      `<span class="wa-pwins">${'⭐'.repeat(p.roundWins)}<span class="wa-pq">${p.questionsAsked}q</span></span>`;
    box.appendChild(chip);
  });
}

function renderWaActions(s) {
  const area = $('waActions');
  area.innerHTML = '';
  const you = s.you || {};

  if (s.over) {
    const youWin = (s.winners || []).includes(s.seat);
    const tie = (s.winners || []).length > 1;
    area.appendChild(banner((s.winners || []).length === 0 ? 'No winner — nobody guessed enough.' : youWin ? '🏆 You win the match!' : tie ? 'Match over — a tie.' : 'Match over.', youWin ? 'win' : 'lose'));
    if (s.targetCard) { area.appendChild(labeledCard('Last secret player', s.targetCard, { pop: true })); revealWalkout(s, 'final'); }
    else if (s.target) area.appendChild(callout(`Last secret player: <b>${escapeHtml(s.target)}</b>`));
    appendEndButtons(area, s);
    return;
  }

  if (s.phase === 'roundOver') {
    const wonName = s.roundWinner != null ? sgName(s, s.roundWinner) : null;
    area.appendChild(banner(wonName ? `Round ${s.roundNo}: ${wonName} guessed it!` : `Round ${s.roundNo}: nobody got it.`, s.roundWinner === s.seat ? 'win' : ''));
    if (s.targetCard) { area.appendChild(labeledCard('The secret player', s.targetCard, { pop: true })); revealWalkout(s, 'r' + s.roundNo); }
    else area.appendChild(callout(`The player was <b>${escapeHtml(s.target || '?')}</b>.`));
    area.appendChild(actBtn(`Next round (${s.roundNo + 1}/${s.roundsTotal}) ▸`, 'btn btn-primary btn-lg', () => send({ type: 'nextRound' })));
    return;
  }

  // Asking phase
  if (you.spectator) {
    area.appendChild(callout('Spectating this match.', true));
    return;
  }
  if (you.eliminated) {
    area.appendChild(callout("You're out this round — follow the clues until the next one.", true));
    return;
  }
  if (!you.isTurn) {
    const who = s.activeSeat != null ? sgName(s, s.activeSeat) : '';
    area.appendChild(callout(`Waiting for <b>${escapeHtml(who)}</b> to ask or guess`, true));
    area.appendChild(waGiveUpBtn());
    return;
  }
  // It's your turn — build the question menu + a guess box.
  renderWaMenu(area, s);
  area.appendChild(waGiveUpBtn());
}

// Concede the round. The secret player is revealed (with the walkout) once the round ends.
function waGiveUpBtn() {
  return actBtn('🏳️ Give up', 'btn btn-quiet', () => {
    if (confirm('Give up this round? You’ll be out, and the player is revealed when the round ends.')) send({ type: 'giveUp' });
  });
}

function renderWaMenu(area, s) {
  const menu = s.menu || {};
  const asked = new Set((s.questionLog || []).map((e) => e.key));
  area.appendChild(prompt('Your turn — <b>ask a question</b> or <b>guess the player</b>.'));

  const section = (title) => {
    const wrap = document.createElement('div');
    wrap.className = 'wa-qsec';
    wrap.innerHTML = `<div class="wa-qsectitle">${title}</div>`;
    const row = document.createElement('div');
    row.className = 'wa-qrow';
    wrap.appendChild(row);
    area.appendChild(wrap);
    return row;
  };
  const qbtn = (row, label, qtype, param) => {
    const key = `${qtype}:${param}`;
    const b = actBtn(label, 'wa-qbtn', () => { tapAck(b); b.disabled = true; send({ type: 'askQuestion', qtype, param }); });
    if (asked.has(key)) { b.disabled = true; b.classList.add('done'); }
    row.appendChild(b);
  };

  let row = section('Position');
  (menu.posGroups || []).forEach((g) => qbtn(row, capitalize(g.label), 'posGroup', g.param));
  (menu.posCodes || []).forEach((c) => qbtn(row, capitalize(c.label.replace(/^an? /, '')), 'posCode', c.param));

  row = section('Origin');
  (menu.continents || []).forEach((c) => qbtn(row, c, 'continent', c));

  row = section('League');
  (menu.leagues || []).forEach((l) => qbtn(row, l, 'league', l));

  row = section('Value & era');
  (menu.valueThresholds || []).forEach((v) => qbtn(row, `> €${v}m`, 'valueOver', String(v)));
  (menu.eras || []).forEach((e) => qbtn(row, e, 'era', e));
  qbtn(row, 'Retired?', 'retired', '');

  // Nationality search (there are many) — datalist autocomplete.
  const natWrap = document.createElement('div');
  natWrap.className = 'wa-qsec';
  natWrap.innerHTML = '<div class="wa-qsectitle">From a specific country</div>';
  const natForm = document.createElement('form');
  natForm.className = 'sg-clueform';
  natForm.innerHTML =
    `<input id="waNatInput" type="text" placeholder="Country…" autocomplete="off" list="waNatList" />` +
    `<datalist id="waNatList">${(menu.nationalities || []).map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`;
  const natBtn = actBtn('Ask', 'btn btn-neutral', null);
  natBtn.type = 'submit';
  natForm.appendChild(natBtn);
  natForm.onsubmit = (e) => {
    e.preventDefault();
    const val = natForm.querySelector('#waNatInput').value.trim();
    if (val) send({ type: 'askQuestion', qtype: 'nationality', param: val });
  };
  natWrap.appendChild(natForm);
  area.appendChild(natWrap);

  // Guess box
  const guessWrap = document.createElement('div');
  guessWrap.className = 'wa-guess';
  guessWrap.innerHTML = '<div class="wa-qsectitle">…or name the player (a wrong guess knocks you out!)</div>';
  const gForm = document.createElement('form');
  gForm.className = 'sg-clueform';
  gForm.innerHTML =
    `<input id="waGuessInput" type="text" placeholder="Guess a player…" autocomplete="off" list="waGuessList" maxlength="60" />` +
    `<datalist id="waGuessList">${(you_allNames(s)).map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`;
  const gBtn = actBtn('Guess', 'btn btn-gold', null);
  gBtn.type = 'submit';
  gForm.appendChild(gBtn);
  gForm.onsubmit = (e) => {
    e.preventDefault();
    const val = gForm.querySelector('#waGuessInput').value.trim();
    if (val && confirm(`Guess "${val}"? A wrong guess knocks you out for this round.`)) send({ type: 'guessPlayer', name: val });
  };
  guessWrap.appendChild(gForm);
  area.appendChild(guessWrap);
}
function you_allNames(s) { return (s.you && s.you.allNames) || []; }

function renderWaQlog(s) {
  const box = $('waQlog');
  box.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'wa-qsectitle';
  title.textContent = `Questions asked (${(s.questionLog || []).length})`;
  box.appendChild(title);
  if (!(s.questionLog || []).length) {
    box.appendChild(callout('No questions yet — narrow it down!'));
  }
  (s.questionLog || []).forEach((e) => {
    const row = document.createElement('div');
    row.className = 'wa-qa';
    row.innerHTML =
      `<span class="wa-qby" style="color:${seatColor(e.by)}">${escapeHtml(sgName(s, e.by))}</span>` +
      `<span class="wa-qtext">${escapeHtml(e.q)}</span>` +
      `<span class="wa-ans ${e.answer ? 'yes' : 'no'}">${e.answer ? 'YES' : 'no'}</span>`;
    box.appendChild(row);
  });
  (s.guessLog || []).filter((g) => !g.correct).forEach((g) => {
    const row = document.createElement('div');
    row.className = 'wa-qa wa-wrong';
    row.innerHTML = `<span class="wa-qby" style="color:${seatColor(g.by)}">${escapeHtml(sgName(s, g.by))}</span><span class="wa-qtext">guessed ${escapeHtml(g.name)}</span><span class="wa-ans no">✗</span>`;
    box.appendChild(row);
  });
}
function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

// ---------------------------------------------------------------------------
// Guess the Player (Wordle-style football)
// ---------------------------------------------------------------------------

function renderGuessPlayer(s) {
  $('gpRoom').textContent = s.room;
  $('gpPhase').textContent = s.over ? 'Match over' : s.phase === 'roundOver' ? 'Round over' : `Round ${s.roundNo}/${s.roundsTotal}`;
  $('gpCopy').onclick = copyInvite;
  $('gpRulesBtn').onclick = () => $('gpRulesSheet').classList.remove('hidden');
  renderGpOpps(s);
  renderGpActions(s);
  renderGpGrid(s);
  const ul = $('gpLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

function renderGpOpps(s) {
  const box = $('gpOpps');
  box.innerHTML = '';
  const bots = botSeatSet(s);
  const you = s.you || {};
  const mine = {
    seat: s.seat, name: 'You', count: (you.guesses || []).length, solved: you.solved, solvedIn: you.solvedIn, out: you.out, me: true,
  };
  [mine, ...(s.opponents || [])].forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'gp-opp' + (p.solved ? ' solved' : '') + (p.out ? ' out' : '');
    const status = p.solved ? `✓ ${p.solvedIn}` : p.out ? '✗' : `${p.count}`;
    chip.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(p.seat)}">${initial(p.me ? (sgName(s, s.seat) || 'You') : p.name)}</span>` +
      `<span class="gp-oppname">${escapeHtml(p.me ? 'You' : p.name)}${!p.me && bots.has(p.seat) ? ' 🤖' : ''}</span>` +
      `<span class="gp-oppstat">${status}</span>`;
    box.appendChild(chip);
  });
}

// Fire the walkout once per reveal (render*Actions re-runs on every state push). Shared by
// the player-card reveal games (Guess the Player, Who Am I).
function revealWalkout(s, phaseKey) {
  const key = s.room + ':' + phaseKey + ':' + (s.target || (s.targetCard && s.targetCard.name) || '');
  if (_lastWalkoutKey === key) return;
  _lastWalkoutKey = key;
  playerWalkout(s.targetCard);
}

function renderGpActions(s) {
  const area = $('gpActions');
  area.innerHTML = '';
  const you = s.you || {};

  if (s.over) {
    const youWin = (s.winners || []).includes(s.seat);
    area.appendChild(banner((s.winners || []).length === 0 ? 'No winner this match.' : youWin ? '🏆 You win the match!' : 'Match over.', youWin ? 'win' : 'lose'));
    if (s.targetCard) { area.appendChild(labeledCard('The player', s.targetCard, { pop: true })); revealWalkout(s, 'final'); }
    else if (s.target) area.appendChild(callout(`The player was <b>${escapeHtml(s.target)}</b>.`));
    appendEndButtons(area, s);
    return;
  }
  if (s.phase === 'roundOver') {
    const who = s.roundWinner != null ? sgName(s, s.roundWinner) : null;
    area.appendChild(banner(who ? `Round ${s.roundNo}: ${who} won!` : `Round ${s.roundNo}: nobody got it.`, s.roundWinner === s.seat ? 'win' : ''));
    if (s.targetCard) { area.appendChild(labeledCard('The player', s.targetCard, { pop: true })); revealWalkout(s, 'r' + s.roundNo); }
    else area.appendChild(callout(`The player was <b>${escapeHtml(s.target || '?')}</b>.`));
    area.appendChild(actBtn(`Next round (${s.roundNo + 1}/${s.roundsTotal}) ▸`, 'btn btn-primary btn-lg', () => send({ type: 'nextRound' })));
    return;
  }
  if (you.spectator) { area.appendChild(callout('Spectating this match.', true)); return; }
  if (you.solved) { area.appendChild(callout(`✅ Solved in ${you.solvedIn}! Waiting for the others`, true)); return; }
  if (you.out) { area.appendChild(callout("Out this round — you'll be back next round.", true)); return; }

  // Your guess box
  const remain = you.remaining;
  area.appendChild(prompt(`Guess the secret player${remain != null ? ` — <b>${remain}</b> ${remain === 1 ? 'try' : 'tries'} left` : ''}.`));
  const form = document.createElement('form');
  form.className = 'sg-clueform';
  form.innerHTML =
    `<input id="gpGuessInput" type="text" placeholder="Guess a player…" autocomplete="off" list="gpGuessList" maxlength="60" />` +
    `<datalist id="gpGuessList">${(you.allNames || []).map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>`;
  const btn = actBtn('Guess', 'btn btn-gold', null);
  btn.type = 'submit';
  form.appendChild(btn);
  form.onsubmit = (e) => {
    e.preventDefault();
    const val = form.querySelector('#gpGuessInput').value.trim();
    if (val) send({ type: 'submitGuess', name: val });
    form.querySelector('#gpGuessInput').value = '';
  };
  area.appendChild(form);
  area.appendChild(actBtn('Give up', 'btn btn-quiet', () => { if (confirm('Give up this round?')) send({ type: 'giveUp' }); }));
}

// Value cell text + colour. Retired guess (no value) → "—"; otherwise the value with a
// directional arrow toward the target (= same tier). Never an ambiguous "?".
function gpValueCell(g) {
  if (g.marketValue == null) return { text: '—', cls: 'miss' };
  const v = '€' + Math.round(g.marketValue / 1e6) + 'm';
  if (g.fb.value === 'unknown') return { text: v, cls: 'miss' }; // can't compare (shouldn't happen: targets are valued)
  const arrow = { higher: '↑', lower: '↓', equal: '=' }[g.fb.value] || '';
  return { text: `${v} ${arrow}`.trim(), cls: g.fb.value === 'equal' ? 'hit' : 'dir' };
}

function renderGpGrid(s) {
  const box = $('gpGrid');
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'gp-row gp-head';
  ['Player', 'Nat', 'Pos', 'League', 'Value', 'Era', 'Status'].forEach((h) => {
    const c = document.createElement('span');
    c.className = 'gp-cell';
    c.textContent = h;
    head.appendChild(c);
  });
  box.appendChild(head);

  const guesses = (s.you && s.you.guesses) || [];
  if (!guesses.length) {
    box.appendChild(callout('No guesses yet — name a player to get hints.'));
  }
  const lastIdx = guesses.length - 1;
  const animateNew = guesses.length > _lastGpCount; // only the just-added row flips in
  guesses.forEach((g, i) => {
    const row = document.createElement('div');
    row.className = 'gp-row' + (g.fb.exact ? ' solved' : '') + (animateNew && i === lastIdx ? ' reveal' : '');
    const cell = (text, cls) => `<span class="gp-cell ${cls}">${escapeHtml(text)}</span>`;
    const val = gpValueCell(g);
    row.innerHTML =
      cell(g.name, 'gp-name') +
      cell(g.nationality, g.fb.nationality) +
      cell(g.positions.join('/'), g.fb.position) +
      cell(g.leagues.length ? g.leagues.join('/') : '—', g.fb.league) +
      cell(val.text, val.cls) +
      cell(g.eraOfPlay, g.fb.era) +
      cell(g.status, g.fb.status);
    if (animateNew && i === lastIdx) [...row.children].forEach((c, ci) => (c.style.animationDelay = ci * 0.08 + 's'));
    box.appendChild(row);
  });
  _lastGpCount = guesses.length;
}
let _lastGpCount = 0;

// ---------------------------------------------------------------------------
// Arena 3D — the CSS-3D engine shared by the ice games (Penguin Knockout,
// Ice Football). Persistent DOM: each game builds its scene once (slab, pitch,
// scenery), then only element transforms update per frame (no innerHTML churn).
// Camera: tilt = look-down angle (0 = across the ice, 90 = top-down); z = dolly.
// CSS classes keep their historical pk3d- prefix (see style.css).
//
// A game plugs in with a `view` ({cam, mode}) it owns, plus hooks:
//   stageClass        — CSS class for the stage element
//   build(scene)      — populate scene.world; must append scene.arrow where it
//                       should paint relative to the floor
//   canAim()          — a drag in Aim mode should steer the arrow right now
//   hasMe()           — the local player has a piece on the ice
//   onAim(angle, pow) — an aim drag moved: store it, redraw, sync the slider
//   onTap(seat)       — a tap (not a drag) landed on a penguin/piece
//   redraw()          — repaint from live state (mode toggle, name timers)
// ---------------------------------------------------------------------------

function a3dWorldTransform(cam) {
  return `translateZ(${cam.z}px) rotateX(${(cam.tilt - 90).toFixed(2)}deg) rotateY(${cam.yaw.toFixed(2)}deg)`;
}
function a3dApplyCamera(scene, cam) { scene.world.style.transform = a3dWorldTransform(cam); }
// Counter-rotation that makes a flat element face the camera (billboard).
function a3dBillboard(cam) { return `rotateY(${(-cam.yaw).toFixed(1)}deg) rotateX(${(90 - cam.tilt).toFixed(1)}deg)`; }

// Build one cuboid (6 faces) centred on its own origin. `colors` = string or per-face map.
function a3dBox(w, h, d, colors) {
  const box = document.createElement('div');
  box.className = 'pk3d-face';
  const c = typeof colors === 'string' ? { all: colors } : colors;
  const col = (k) => c[k] || c.all || '#888';
  const face = (bg, tf, fw, fh, extra) => {
    const el = document.createElement('div');
    el.style.width = fw + 'px'; el.style.height = fh + 'px'; el.style.background = bg;
    el.style.transform = tf; el.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.10) inset';
    if (extra) el.style.cssText += extra;
    return el;
  };
  box.append(
    face(col('front'), `translate(-50%,-50%) translateZ(${d / 2}px)`, w, h),
    face(col('back'), `translate(-50%,-50%) translateZ(${-d / 2}px) rotateY(180deg)`, w, h),
    face(col('right'), `translate(-50%,-50%) translateX(${w / 2}px) rotateY(90deg)`, d, h),
    face(col('left'), `translate(-50%,-50%) translateX(${-w / 2}px) rotateY(-90deg)`, d, h),
    face(col('top'), `translate(-50%,-50%) translateY(${-h / 2}px) rotateX(90deg)`, w, d),
    face(col('bottom'), `translate(-50%,-50%) translateY(${h / 2}px) rotateX(-90deg)`, w, d),
  );
  return box;
}

// Assemble a blocky penguin (body + belly + head + beak + eyes + feet), origin at the feet.
// The cuboids live in an inner wrapper so it can tumble off the edge while the outer
// element keeps its world position.
function a3dBuildPeng(color) {
  const peng = document.createElement('div');
  peng.className = 'pk3d-obj pk3d-peng';
  const bodyWrap = document.createElement('div'); bodyWrap.className = 'pk3d-pengbody';
  const belly = '#f6fbff', dark = 'rgba(0,0,0,0.18)';
  const put = (el, x, y, z) => { el.style.transform = `translate3d(${x}px,${y}px,${z}px)`; return el; };
  const body = a3dBox(30, 34, 26, { front: belly, back: color, left: color, right: color, top: color, bottom: dark });
  const head = a3dBox(26, 22, 24, { front: color, back: color, left: color, right: color, top: color, bottom: color });
  const beak = a3dBox(9, 6, 8, '#f4b41a');
  const footL = a3dBox(11, 5, 15, '#f4b41a'), footR = a3dBox(11, 5, 15, '#f4b41a');
  const eyeL = a3dBox(4, 6, 2, '#12233a'), eyeR = a3dBox(4, 6, 2, '#12233a');
  bodyWrap.append(
    put(body, 0, -23, 0), put(head, 0, -51, 0), put(beak, 0, -50, 14),
    put(eyeL, -5, -55, 12.5), put(eyeR, 5, -55, 12.5),
    put(footL, -8, -2, 4), put(footR, 8, -2, 4),
  );
  const hi = document.createElement('div'); hi.className = 'pk3d-hi';
  const name = document.createElement('div'); name.className = 'pk3d-name'; name.style.display = 'none';
  peng.append(bodyWrap, hi, name);
  return peng;
}

// While moving, face the direction of travel; when idle (or unknown), face `idleFace`.
function a3dFacing(el, p, moving, idleFace) {
  let face;
  if (moving && el._lastX != null) {
    const dx = p.x - el._lastX, dy = p.y - el._lastY;
    face = Math.hypot(dx, dy) > 0.004 ? Math.atan2(dx, -dy) * 180 / Math.PI : (el._face != null ? el._face : idleFace);
  } else {
    face = idleFace;
  }
  el._lastX = p.x; el._lastY = p.y; el._face = face;
  return face;
}

function a3dEnsureScene(board, key, view, hooks) {
  if (board.__a3d && board.__a3d.key === key) return board.__a3d;
  board.innerHTML = '';
  const stage = document.createElement('div'); stage.className = hooks.stageClass;
  const world = document.createElement('div'); world.className = 'pk3d-world';
  const arrow = document.createElement('div'); arrow.className = 'pk3d-obj pk3d-arrow'; arrow.style.display = 'none';
  stage.appendChild(world);
  const hint = document.createElement('div'); hint.className = 'pk3d-hint'; hint.textContent = 'drag to look around';
  stage.appendChild(hint);
  const lock = document.createElement('button'); lock.className = 'pk3d-lockbtn'; lock.style.display = 'none';
  lock.onpointerdown = (e) => e.stopPropagation(); // don't let the stage grab this as an orbit
  stage.appendChild(lock);
  // Aim / Look mode toggle (mobile): flip whether a drag adjusts your arrow or the camera.
  const modebtn = document.createElement('button'); modebtn.className = 'pk3d-modebtn'; modebtn.style.display = 'none';
  modebtn.onpointerdown = (e) => e.stopPropagation();
  modebtn.onclick = () => { view.mode = view.mode === 'aim' ? 'orbit' : 'aim'; hooks.redraw(); };
  stage.appendChild(modebtn);
  board.appendChild(stage);
  const scene = { key, stage, world, arrow, hint, lock, modebtn, pengs: new Map(), impacts: new Map() };
  board.__a3d = scene;
  hooks.build(scene);
  a3dAttachInput(scene, view, hooks);
  return scene;
}

// Orbit on drag (Look mode), steer your arrow on drag (Aim mode), tap a piece for
// the game's tap action, wheel to dolly the camera.
function a3dAttachInput(scene, view, hooks) {
  const stage = scene.stage;
  let st = null, mode = null, onSeat = null, moved = false;
  stage.style.touchAction = 'none';
  stage.onpointerdown = (e) => {
    st = { x: e.clientX, y: e.clientY, yaw: view.cam.yaw, tilt: view.cam.tilt };
    moved = false;
    const pe = e.target && e.target.closest ? e.target.closest('.pk3d-peng') : null;
    onSeat = pe ? Number(pe.dataset.pseat) : null;
    mode = hooks.canAim() && view.mode === 'aim' ? 'aim' : 'orbit';
    try { stage.setPointerCapture(e.pointerId); } catch { /* ok */ }
  };
  stage.onpointermove = (e) => {
    if (!st) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!moved && Math.hypot(dx, dy) > 5) moved = true;
    if (!moved) return;
    if (mode === 'orbit') {
      view.cam.yaw = st.yaw + dx * 0.4;
      view.cam.tilt = Math.max(8, Math.min(82, st.tilt + dy * 0.3));
      a3dApplyCamera(scene, view.cam);
    } else if (mode === 'aim') {
      if (!hooks.hasMe()) return;
      // rotate the screen drag by the camera yaw so the arrow follows the finger
      const yaw = view.cam.yaw * Math.PI / 180;
      const fx = dx * Math.cos(yaw) + dy * Math.sin(yaw);
      const fz = -dx * Math.sin(yaw) + dy * Math.cos(yaw);
      hooks.onAim(Math.atan2(-fz, fx) * 180 / Math.PI, Math.min(1, Math.hypot(dx, dy) / 150)); // ice y is -z
    }
  };
  stage.onpointerup = () => {
    if (st && !moved && onSeat != null) hooks.onTap(onSeat);
    st = null; mode = null;
  };
  stage.onwheel = (e) => {
    e.preventDefault();
    view.cam.z = Math.max(-260, Math.min(260, view.cam.z + (e.deltaY < 0 ? 28 : -28)));
    a3dApplyCamera(scene, view.cam);
  };
}

// Flat aim arrow on the ice at `me`; length = (base + power · span) world units.
function a3dArrow(scene, me, aim, S, base, span) {
  if (!me || !aim) { scene.arrow.style.display = 'none'; return; }
  const len = (base + aim.power * span) * S;
  scene.arrow.style.display = '';
  scene.arrow.style.width = len.toFixed(0) + 'px';
  scene.arrow.style.transform =
    `translate(0,-50%) translate3d(${(me.x * S).toFixed(1)}px,-2px,${(-me.y * S).toFixed(1)}px) rotateX(90deg) rotateZ(${(-aim.angle).toFixed(1)}deg)`;
}

// Lock-in button, Aim/Look toggle and hint, overlaid on the arena.
function a3dChrome(scene, view, canCommit, inCommitPhase, opts) {
  scene.lock.style.display = canCommit ? '' : 'none';
  scene.modebtn.style.display = canCommit ? '' : 'none';
  if (canCommit) {
    scene.lock.textContent = opts.lockLabel;
    scene.lock.onclick = opts.onLock;
    scene.modebtn.textContent = view.mode === 'aim' ? '🎯 Aim mode' : '🔄 Look mode';
    scene.modebtn.classList.toggle('look', view.mode !== 'aim');
  }
  scene.hint.textContent = canCommit ? (view.mode === 'aim' ? opts.aimHint : 'drag to look around') : 'drag to look around';
  scene.hint.style.display = inCommitPhase ? '' : 'none';
}

// Collision flashes during a replay: billboarded rings that expand and fade over a
// few frames, driven by the sim's impact list ({f, x, y, s} — both games ship it).
const A3D_IMPACT_SPAN = 7;
function a3dImpacts(scene, cam, impacts, frame, S) {
  const seen = new Set();
  if (impacts && frame != null) impacts.forEach((im, idx) => {
    const age = frame - im.f;
    if (age < 0 || age > A3D_IMPACT_SPAN) return;
    seen.add(idx);
    let el = scene.impacts.get(idx);
    if (!el) { el = document.createElement('div'); el.className = 'pk3d-obj pk3d-impact'; scene.world.appendChild(el); scene.impacts.set(idx, el); }
    const k = age / A3D_IMPACT_SPAN;
    const ease = 1 - (1 - k) * (1 - k); // ease-out radius, same curve the old SVG flash used
    const r = (0.03 + 0.085 * im.s) * (0.3 + ease) * S;
    el.style.width = el.style.height = (2 * r).toFixed(0) + 'px';
    el.style.opacity = ((1 - k) * (0.55 + 0.4 * im.s)).toFixed(2);
    el.style.transform = `translate(-50%,-50%) translate3d(${(im.x * S).toFixed(1)}px,-8px,${(-im.y * S).toFixed(1)}px) ${a3dBillboard(cam)}`;
  });
  for (const [idx, el] of scene.impacts) if (!seen.has(idx)) { el.remove(); scene.impacts.delete(idx); }
}

// Play the sim at a watchable ~200ms/tick, floored at 4s so a blink of action still
// reads, capped at 12s, interpolating between ticks so it stays smooth at any speed.
// Kept ≤ the server's resolve hold (see each game's resolveDeadline).
// `draw` gets (ff, i, k): fractional frame for lerping, rounded index for frame-keyed
// effects (impacts), and overall progress 0→1 (reveal arrows fade on it).
function a3dPlayFrames(replay, total, draw, onDone) {
  const REPLAY_MS = Math.min(12000, Math.max(4000, total * 200));
  const start = performance.now();
  const step = (t) => {
    const prog = Math.min(1, (t - start) / REPLAY_MS);
    const ff = prog * (total - 1);
    draw(ff, Math.round(ff), prog);
    if (prog < 1) replay.raf = requestAnimationFrame(step);
    else if (onDone) onDone();
    else replay.raf = 0;
  };
  replay.raf = requestAnimationFrame(step);
}

// Ghost arrows at replay start: everyone's committed launch (the simultaneous reveal),
// drawn at their starting spots in their seat/team colour, fading as the action begins.
// `reveals` = [{id, angle, power}]; `positions` = the replay's frame 0.
const A3D_REVEAL_K = 0.18; // fraction of the replay the ghosts stay visible
function a3dReveal(scene, reveals, k, positions, S, base, span, colorOf) {
  if (!scene.reveals) scene.reveals = new Map();
  const seen = new Set();
  if (reveals && k != null && k < A3D_REVEAL_K && positions) for (const r of reveals) {
    const p = positions.find((q) => q.id === r.id);
    if (!p) continue;
    seen.add(r.id);
    let el = scene.reveals.get(r.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pk3d-obj pk3d-arrow pk3d-ghost';
      el.style.setProperty('--arrow-c', colorOf(r.id));
      scene.world.appendChild(el);
      scene.reveals.set(r.id, el);
    }
    el.style.width = (((base + r.power * span) * S)).toFixed(0) + 'px';
    el.style.opacity = (0.9 * (1 - k / A3D_REVEAL_K)).toFixed(2);
    el.style.transform =
      `translate(0,-50%) translate3d(${(p.x * S).toFixed(1)}px,-2px,${(-p.y * S).toFixed(1)}px) rotateX(90deg) rotateZ(${(-r.angle).toFixed(1)}deg)`;
  }
  for (const [id, el] of scene.reveals) if (!seen.has(id)) { el.remove(); scene.reveals.delete(id); }
}

// A big centred announcement over the arena (goal, last penguin standing), auto-dismissing.
function a3dBanner(scene, text, color) {
  const el = document.createElement('div');
  el.className = 'a3d-banner';
  el.textContent = text;
  if (color) el.style.color = color;
  scene.stage.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

// ---------------------------------------------------------------------------
// Penguin Knockout (simultaneous physics battle)
// ---------------------------------------------------------------------------
let _pkAim = null; // {angle, power} you're aiming this round (pre-commit)
let _pkReplay = { round: -1, raf: 0 }; // active replay animation
let _pkNameShow = null; // seat whose name label is currently shown (tap to reveal)
let _pkNameTimer = 0;

// Blend two ticks for smooth slow-motion playback. ff = fractional frame index.
function pkLerpFrame(frames, ff) {
  const total = frames.length;
  const i = Math.min(total - 1, Math.max(0, Math.floor(ff)));
  const j = Math.min(total - 1, i + 1);
  const fr = ff - i;
  const B = frames[j];
  return frames[i].map((a) => {
    const b = B.find((q) => q.id === a.id) || a;
    return { id: a.id, x: a.x + (b.x - a.x) * fr, y: a.y + (b.y - a.y) * fr, a: a.a };
  });
}

function renderPenguinKnockout(s) {
  $('pkRoom').textContent = s.room;
  $('pkPhase').textContent = s.over ? 'Game over' : s.phase === 'resolve' ? 'Launch!' : `Round ${s.round}`;
  $('pkCopy').onclick = copyInvite;
  $('pkRulesBtn').onclick = () => $('pkRulesSheet').classList.remove('hidden');
  renderPkScores(s);

  if (s.phase === 'resolve' && s.resolution) {
    pkPlayResolution(s); // animate the round
  } else {
    if (_pkReplay.raf) { cancelAnimationFrame(_pkReplay.raf); _pkReplay.raf = 0; }
    if (s.phase !== 'commit') { _pkAim = null; _pkNameShow = null; }
    if (pkCanAim(s) && !_pkAim) { // default: aim toward the centre at half power, in Aim mode
      const me = s.penguins.find((p) => p.seat === s.seat);
      _pkAim = { angle: me ? (Math.atan2(-me.y, -me.x) * 180) / Math.PI : 0, power: 0.5 };
      _pkView.mode = 'aim';
    }
    drawPk3d(s, { radius: s.radius, positions: null, aim: pkCanAim(s) ? _pkAim : null });
  }
  renderPkActions(s);
  const ul = $('pkLog');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => { const li = document.createElement('li'); li.textContent = line; ul.appendChild(li); });
}

function pkCanAim(s) { return s.phase === 'commit' && s.you && s.you.alive && !s.you.committed; }

function renderPkScores(s) {
  const box = $('pkScores');
  box.innerHTML = '';
  const bots = botSeatSet(s);
  (s.penguins || []).forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'pk-chip' + (p.alive ? '' : ' out') + (s.phase === 'commit' && p.committed ? ' ready' : '');
    chip.innerHTML =
      `<span class="pk-dot" style="background:${seatColor(p.seat)}">${p.alive ? '🐧' : '💀'}</span>` +
      `<span class="pk-name">${escapeHtml(p.name)}${bots.has(p.seat) ? ' 🤖' : ''}${p.seat === s.seat ? ' (you)' : ''}</span>` +
      `<span class="pk-ko" title="knockouts">🥊 ${p.knockouts}</span>` +
      (s.phase === 'commit' ? `<span class="pk-tick">${p.alive ? (p.committed ? '✓' : '…') : ''}</span>` : '');
    box.appendChild(chip);
  });
}

// keep the power slider + readout in sync when a drag sets the power
function pkSyncSlider() {
  if (!_pkAim) return;
  const sl = $('pkActions').querySelector('.pk-slider');
  const vl = $('pkActions').querySelector('.pk-powerval');
  const pct = Math.round(_pkAim.power * 100);
  if (sl) sl.value = pct;
  if (vl) vl.textContent = pct + '%';
}

// ── The Penguin Knockout arena, on the shared Arena 3D engine ──────────────────
// Roblox-style square ice floe ringed by icebergs; the slab shrinks each round.
const _pkView = { cam: { yaw: -20, tilt: 30, z: 30 }, mode: 'aim' };
const PK3D = { scale: 165 }; // px per world unit

function pkRedraw() {
  if (state && state.gameId === 'penguin-knockout') drawPk3d(state, { radius: state.radius, positions: null, aim: pkCanAim(state) ? _pkAim : null });
}

// A ring of icy mountains / icebergs around the arena (static 3D scenery).
function pk3dBuildScenery() {
  const scenery = document.createElement('div'); scenery.className = 'pk3d-obj'; scenery.style.transformStyle = 'preserve-3d';
  const N = 18;
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + (rnd() - 0.5) * 0.28;
    const Rm = 290 + rnd() * 120;
    const w = 44 + rnd() * 70, h = 55 + rnd() * 120, d = 44 + rnd() * 60;
    const berg = a3dBox(w, h, d, { top: '#ffffff', front: '#e2eff8', back: '#bcd7ea', left: '#d3e6f3', right: '#c6dcef', bottom: '#9cbdd6' });
    berg.classList.add('pk3d-berg');
    const rx = Math.cos(a) * Rm, rz = Math.sin(a) * Rm;
    berg.style.transform = `translate3d(${rx.toFixed(0)}px,${(-h / 2).toFixed(0)}px,${rz.toFixed(0)}px) rotateY(${(rnd() * 90 - 45).toFixed(0)}deg)`;
    scenery.append(berg);
  }
  return scenery;
}

// Rebuild the thick ice slab only when the arena resizes (once per round).
function pk3dSetSlab(scene, side, T) {
  if (scene.slabSide === side) return;
  scene.slabSide = side;
  if (scene.slab) scene.slab.remove();
  const slab = a3dBox(side, T, side, { all: '#cfe8f7' });
  const f = slab.children; // [front, back, right, left, top, bottom]
  for (let i = 0; i < 4; i++) { f[i].style.background = ''; f[i].classList.add('pk3d-slab-side'); }
  f[4].style.background = ''; f[4].classList.add('pk3d-slab-top');
  f[5].style.background = ''; f[5].classList.add('pk3d-slab-bot');
  slab.style.transform = `translate3d(0px,${(T / 2).toFixed(0)}px,0px)`; // top surface at y = 0
  scene.world.insertBefore(slab, scene.world.firstChild); // behind penguins/arrow
  scene.slab = slab;
}

function pkScene(board) {
  return a3dEnsureScene(board, 'pk', _pkView, {
    stageClass: 'pk3d-stage',
    build(scene) {
      scene.slab = null; scene.slabSide = null;
      scene.world.append(pk3dBuildScenery(), scene.arrow);
    },
    canAim: () => !!(state && state.gameId === 'penguin-knockout' && pkCanAim(state)),
    hasMe: () => !!(state && state.penguins && state.penguins.find((p) => p.seat === state.seat)),
    onAim(angle, power) {
      _pkAim = _pkAim || { angle: 0, power: 0.5 };
      _pkAim.angle = angle; _pkAim.power = power;
      drawPk3d(state, { radius: state.radius, positions: null, aim: _pkAim });
      pkSyncSlider();
    },
    onTap(seat) { // tap → reveal the penguin's name for a moment
      _pkNameShow = seat;
      pkRedraw();
      clearTimeout(_pkNameTimer);
      _pkNameTimer = setTimeout(() => { _pkNameShow = null; if (state && state.phase !== 'resolve') pkRedraw(); }, 2600);
    },
    redraw: pkRedraw,
  });
}

// Place/refresh one penguin at sim (x, y). Real 3D geometry — while moving it faces its
// direction of travel; while idle it faces the arena centre.
function pk3dPeng(scene, p, s, moving) {
  let el = scene.pengs.get(p.id);
  if (!el) { el = a3dBuildPeng(seatColor(p.id)); el.dataset.pseat = p.id; scene.world.appendChild(el); scene.pengs.set(p.id, el); }
  const S = PK3D.scale;
  const wx = (p.x * S), wz = (-p.y * S);
  const face = a3dFacing(el, p, moving, Math.atan2(-p.x, p.y) * 180 / Math.PI); // idle → face centre
  el.style.transform = `translate(-50%,-50%) translate3d(${wx.toFixed(1)}px,0px,${wz.toFixed(1)}px) rotateY(${face.toFixed(1)}deg)`;
  el.classList.toggle('mine', p.id === s.seat);
  el.classList.toggle('out', !p.a);
  const nameEl = el.querySelector('.pk3d-name');
  const show = _pkNameShow === p.id && p.a;
  nameEl.style.display = show ? '' : 'none';
  if (show) {
    const meta = (s.penguins || []).find((q) => q.seat === p.id);
    nameEl.textContent = meta ? meta.name : '';
    // counter the penguin's facing + camera so the label stays readable
    nameEl.style.transform = `translate(-50%,-50%) translate3d(0,-84px,0) rotateY(${(-face - _pkView.cam.yaw).toFixed(1)}deg) rotateX(${(90 - _pkView.cam.tilt).toFixed(1)}deg)`;
  }
}

function drawPk3d(s, opts) {
  const scene = pkScene($('pkBoard'));
  a3dApplyCamera(scene, _pkView.cam);
  const S = PK3D.scale;
  // thick square ice slab sized to the current (shrinking) boundary
  pk3dSetSlab(scene, +(opts.radius * 2 * S).toFixed(1), 72);
  // penguins (from the replay frame if given, else live state)
  const list = opts.positions || (s.penguins || []).map((p) => ({ id: p.seat, x: p.x, y: p.y, a: p.alive }));
  const moving = !!opts.positions; // replay / shrink frames → orient penguins by travel direction
  const seen = new Set();
  for (const p of list) { pk3dPeng(scene, p, s, moving); seen.add(p.id); }
  for (const [id, el] of scene.pengs) if (!seen.has(id)) { el.remove(); scene.pengs.delete(id); }
  a3dImpacts(scene, _pkView.cam, opts.impacts, opts.frame, S);
  a3dReveal(scene, opts.reveal, opts.revealK, opts.revealPos, S, 0.28, 1.05, seatColor);
  const me = list.find((p) => p.id === s.seat && p.a);
  a3dArrow(scene, me, opts.aim, S, 0.28, 1.05);
  const canCommit = s.phase === 'commit' && s.you && s.you.alive && !s.you.committed && !s.you.spectator;
  a3dChrome(scene, _pkView, canCommit, s.phase === 'commit', {
    lockLabel: `🔒 Lock in launch · ${Math.round((_pkAim ? _pkAim.power : 0.5) * 100)}%`,
    onLock: () => { const a = _pkAim || { angle: 0, power: 0.5 }; send({ type: 'commitMove', angle: a.angle, power: a.power }); },
    aimHint: 'drag anywhere to aim your arrow',
  });
}

// Replay the resolution frames, then animate the shrink + melts.
function pkPlayResolution(s) {
  const res = s.resolution;
  if (_pkReplay.round === s.round && _pkReplay.raf) return; // already playing this round
  if (_pkReplay.raf) cancelAnimationFrame(_pkReplay.raf);
  _pkReplay = { round: s.round, raf: 0 };
  _pkNameShow = null; // hide any name tag during the launch
  const frames = res.frames || [];
  const total = frames.length;
  if (total < 2) { drawPk3d(s, { radius: res.radius, positions: frames[0] || [], aim: null }); return; }
  const melted = new Set(res.melted || []);
  a3dPlayFrames(_pkReplay, total,
    (ff, i, k) => drawPk3d(s, { radius: res.radius, positions: pkLerpFrame(frames, ff), aim: null, impacts: res.impacts, frame: i, reveal: res.reveal, revealK: k, revealPos: frames[0] }),
    () => pkAnimateShrink(s, res, melted));
}

function pkAnimateShrink(s, res, melted) {
  const finalFrame = (res.frames && res.frames[res.frames.length - 1]) || [];
  const t0 = performance.now();
  const dur = 600;
  const anim = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const radius = res.radius + (res.radiusAfter - res.radius) * k;
    const pos = finalFrame.map((p) => ({ id: p.id, x: p.x, y: p.y, a: p.a && !(melted.has(p.id) && k > 0.5) }));
    drawPk3d(s, { radius, positions: pos, aim: null });
    if (k < 1) _pkReplay.raf = requestAnimationFrame(anim);
    else { _pkReplay.raf = 0; pkFinalBanner(s, finalFrame, melted); }
  };
  _pkReplay.raf = requestAnimationFrame(anim);
}

// The match-deciding moment, announced in the arena: last penguin standing (or a wipeout).
function pkFinalBanner(s, finalFrame, melted) {
  const alive = finalFrame.filter((p) => p.a && !melted.has(p.id));
  if (alive.length > 1) return; // the match goes on — no moment to land
  const scene = $('pkBoard').__a3d;
  if (!scene) return;
  if (alive.length === 1) {
    const meta = (s.penguins || []).find((q) => q.seat === alive[0].id);
    a3dBanner(scene, `🏆 ${meta ? meta.name : 'Last penguin'} takes the ice!`, seatColor(alive[0].id));
  } else {
    a3dBanner(scene, '💥 Total wipeout!');
  }
}

function renderPkActions(s) {
  const area = $('pkActions');
  area.innerHTML = '';
  const you = s.you || {};
  if (s.over) {
    const youWin = (s.winners || []).includes(s.seat);
    area.appendChild(banner((s.winners || []).length === 0 ? 'Everyone wiped out!' : youWin ? '🏆 You win!' : 'Game over.', youWin ? 'win' : 'lose'));
    appendEndButtons(area, s);
    return;
  }
  if (s.phase === 'resolve') {
    area.appendChild(callout('🐧 Launch! Watch the chaos… (drag to look around)', true));
    return;
  }
  if (you.spectator) { area.appendChild(callout('Spectating this match.', true)); return; }
  if (!you.alive) { area.appendChild(callout("You're out — watch the rest play out.", true)); return; }
  if (you.committed) {
    const left = (s.penguins || []).filter((p) => p.alive && !p.committed).length;
    area.appendChild(callout(`Locked in — waiting for ${left} more`, true));
    return;
  }
  area.appendChild(prompt('Drag from your penguin to <b>aim &amp; power up</b>, then hit <b>Lock in</b> on the arena. <i>(fine-tune power below · tap a penguin to see who it is)</i>'));
  const aim = _pkAim || { angle: 0, power: 0.5 };
  const meter = document.createElement('div');
  meter.className = 'pk-powerbar';
  meter.innerHTML = `<span>Power</span><input type="range" class="pk-slider" min="0" max="100" value="${Math.round(aim.power * 100)}" aria-label="Power"/><b class="pk-powerval">${Math.round(aim.power * 100)}%</b>`;
  const slider = meter.querySelector('.pk-slider');
  const valEl = meter.querySelector('.pk-powerval');
  slider.oninput = () => {
    _pkAim = _pkAim || { angle: 0, power: 0 };
    _pkAim.power = slider.value / 100;
    valEl.textContent = slider.value + '%';
    pkRedraw();
  };
  area.appendChild(meter);
}

// ---------------------------------------------------------------------------
// Ice Football (team physics football)
// ---------------------------------------------------------------------------
const IF_TEAM = { red: '#e8536b', blue: '#4f9bf2' };
const IF_PU_ICON = { powerShot: '💥', bigPiece: '🐘', slick: '🧊', freeze: '❄️', wall: '🧱' };
const IF_PU_NAME = { powerShot: 'Power shot', bigPiece: 'Big body', slick: 'Slick', freeze: 'Freeze', wall: 'Wall' };
let _ifAim = null;       // {angle, power}
let _ifPU = null;        // armed power-up {type, targetId?}
let _ifReplay = { round: -1, raf: 0 };

function renderIceFootball(s) {
  $('ifRoom').textContent = s.room;
  $('ifPhase').textContent = s.over ? 'Full time' : s.phase === 'resolve' ? 'Kick!' : `Round ${s.round}`;
  $('ifCopy').onclick = copyInvite;
  $('ifRulesBtn').onclick = () => $('ifRulesSheet').classList.remove('hidden');
  renderIfScore(s);
  if (s.phase === 'resolve' && s.resolution) {
    ifPlayResolution(s);
  } else {
    if (_ifReplay.raf) { cancelAnimationFrame(_ifReplay.raf); _ifReplay.raf = 0; }
    if (s.phase !== 'commit') { _ifAim = null; _ifPU = null; }
    if (ifCanAim(s) && !_ifAim) {
      const me = s.pieces.find((p) => p.seat === s.seat);
      const goalX = me && me.team === 'red' ? s.pitch.hx : -s.pitch.hx; // face the opponent goal
      _ifAim = { angle: me ? (Math.atan2(s.ball.y - me.y, goalX - me.x) * 180) / Math.PI : 0, power: 0.5 };
      _ifView.mode = 'aim';
    }
    drawIf3d(s, { ball: null, pieces: null, aim: ifCanAim(s) ? _ifAim : null });
  }
  renderIfActions(s);
  const ul = $('ifLog'); ul.innerHTML = '';
  (s.log || []).forEach((line) => { const li = document.createElement('li'); li.textContent = line; ul.appendChild(li); });
}

function ifCanAim(s) { return s.phase === 'commit' && s.you && !s.you.committed; }

function renderIfScore(s) {
  const box = $('ifScore');
  box.innerHTML =
    `<span class="if-team red">🔴 RED</span>` +
    `<span class="if-scoreval">${s.score.red} – ${s.score.blue}</span>` +
    `<span class="if-team blue">BLUE 🔵</span>` +
    `<span class="if-target">to ${s.goalsToWin}</span>`;
}

function ifSyncSlider() {
  if (!_ifAim) return;
  const sl = $('ifActions').querySelector('.pk-slider');
  const vl = $('ifActions').querySelector('.pk-powerval');
  const pct = Math.round(_ifAim.power * 100);
  if (sl) sl.value = pct;
  if (vl) vl.textContent = pct + '%';
}

// ── The Ice Football pitch, on the shared Arena 3D engine ──────────────────────
// Rectangular field with glass walls, goal frames and a stadium bowl. Persistent DOM:
// the pitch, walls, goals and stadium are built once; only pieces/ball update per frame.
const _ifView = { cam: { yaw: -20, tilt: 30, z: 20 }, mode: 'aim' };
const IF3D = { targetHalf: 168, wallH: 46, slabT: 48, goalH: 42 }; // targetHalf = on-screen half-width; the pitch always fits, players shrink as it grows
let _if3dScale = 168; // px per world unit — recomputed per match so a bigger pitch still fits the stage

function ifRedraw() {
  if (state && state.gameId === 'ice-football') drawIf3d(state, { ball: null, pieces: null, aim: ifCanAim(state) ? _ifAim : null });
}

// A vertical wall panel spanning a ground segment (px), standing height H.
function if3dWall(x1, z1, x2, z2, H) {
  const dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz);
  const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2, ang = -Math.atan2(dz, dx) * 180 / Math.PI;
  const el = document.createElement('div'); el.className = 'pk3d-obj if3d-wall';
  el.style.width = L.toFixed(1) + 'px'; el.style.height = H + 'px';
  el.style.transform = `translate(-50%,-50%) translate3d(${mx.toFixed(1)}px,${(-H / 2).toFixed(0)}px,${mz.toFixed(1)}px) rotateY(${ang.toFixed(1)}deg)`;
  return el;
}

// White goal frame (two posts + crossbar) at goal-line x (px), gap width goalW (px).
function if3dGoal(sx, goalW) {
  const g = document.createElement('div'); g.className = 'pk3d-obj'; g.style.transformStyle = 'preserve-3d';
  const H = IF3D.goalH, pw = 5;
  const post = (z) => { const b = a3dBox(pw, H, pw, '#f4f8ff'); b.style.transform = `translate3d(${sx}px,${-H / 2}px,${z}px)`; return b; };
  const bar = a3dBox(pw, pw, goalW, '#f4f8ff'); bar.style.transform = `translate3d(${sx}px,${-H}px,0px)`;
  g.append(post(-goalW / 2), post(goalW / 2), bar);
  return g;
}

// A rectangular stadium bowl around the pitch: four striped stands + corner floodlights.
function if3dBuildStadium(hxp, hyp) {
  const st = document.createElement('div'); st.className = 'pk3d-obj'; st.style.transformStyle = 'preserve-3d';
  const gap = 110, standH = 150, standD = 95;
  const L = 2 * hxp + 2 * gap + standD, D = 2 * hyp + 2 * gap + standD;
  const mk = (w, h, d, x, z) => { const b = a3dBox(w, h, d, { all: '#3a4453' }); for (let i = 0; i < 4; i++) { b.children[i].style.background = ''; b.children[i].classList.add('if3d-stand'); } b.style.transform = `translate3d(${x}px,${-h / 2}px,${z}px)`; return b; };
  st.append(
    mk(L, standH, standD, 0, -(hyp + gap + standD / 2)),
    mk(L, standH, standD, 0, (hyp + gap + standD / 2)),
    mk(standD, standH, D, -(hxp + gap + standD / 2), 0),
    mk(standD, standH, D, (hxp + gap + standD / 2), 0),
  );
  const flood = (x, z) => {
    const g = document.createElement('div'); g.className = 'pk3d-obj'; g.style.transformStyle = 'preserve-3d';
    const ph = 210; const pole = a3dBox(8, ph, 8, '#8893a5'); pole.style.transform = `translate3d(${x}px,${-ph / 2}px,${z}px)`;
    const lamp = a3dBox(48, 16, 22, '#fffbe0'); lamp.style.transform = `translate3d(${x}px,${-ph}px,${z}px)`;
    g.append(pole, lamp); return g;
  };
  const cx = hxp + gap, cz = hyp + gap;
  st.append(flood(-cx, -cz), flood(cx, -cz), flood(-cx, cz), flood(cx, cz));
  return st;
}

function if3dBuildPitch(scene, s) {
  const S = _if3dScale, { hx, hy, goalHy } = s.pitch;
  const w = 2 * hx * S, d = 2 * hy * S, T = IF3D.slabT;
  const hxp = hx * S, hyp = hy * S, gp = goalHy * S, H = IF3D.wallH;
  scene.world.appendChild(if3dBuildStadium(hxp, hyp));
  // pitch slab
  const slab = a3dBox(w, T, d, { all: '#2e7d46' });
  const f = slab.children;
  for (let i = 0; i < 4; i++) { f[i].style.background = ''; f[i].classList.add('if3d-pitch-side'); }
  f[4].style.background = ''; f[4].classList.add('if3d-pitch-top');
  f[5].style.background = ''; f[5].classList.add('if3d-pitch-bot');
  slab.style.transform = `translate3d(0px,${T / 2}px,0px)`;
  const top = f[4];
  const mark = (css) => { const m = document.createElement('div'); m.className = 'if3d-mark'; m.style.cssText = css; top.appendChild(m); };
  mark(`left:50%;top:50%;width:2px;height:100%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.85);`);
  mark(`left:50%;top:50%;width:${(0.34 * d).toFixed(0)}px;height:${(0.34 * d).toFixed(0)}px;transform:translate(-50%,-50%);border:2px solid rgba(255,255,255,0.85);border-radius:50%;`);
  const pbW = (0.15 * w).toFixed(0), pbH = (0.58 * d).toFixed(0);
  mark(`left:0;top:50%;width:${pbW}px;height:${pbH}px;transform:translateY(-50%);border:2px solid rgba(255,255,255,0.8);border-left:none;`);
  mark(`right:0;top:50%;width:${pbW}px;height:${pbH}px;transform:translateY(-50%);border:2px solid rgba(255,255,255,0.8);border-right:none;`);
  scene.world.appendChild(slab);
  // yellow perimeter walls with goal gaps
  const walls = document.createElement('div'); walls.className = 'pk3d-obj'; walls.style.transformStyle = 'preserve-3d';
  walls.append(
    if3dWall(-hxp, -hyp, hxp, -hyp, H), if3dWall(-hxp, hyp, hxp, hyp, H),
    if3dWall(-hxp, -hyp, -hxp, -gp, H), if3dWall(-hxp, gp, -hxp, hyp, H),
    if3dWall(hxp, -hyp, hxp, -gp, H), if3dWall(hxp, gp, hxp, hyp, H),
  );
  scene.world.appendChild(walls);
  scene.world.append(if3dGoal(-hxp, 2 * gp), if3dGoal(hxp, 2 * gp));
}

function ifScene(board, s) {
  // Fit the pitch to the stage: bigger pitch (more players) → smaller scale → players shrink.
  _if3dScale = IF3D.targetHalf / s.pitch.hx;
  return a3dEnsureScene(board, s.pitch.hx.toFixed(3), _ifView, {
    stageClass: 'if3d-stage',
    build(scene) {
      scene.ball = null; scene.ballShadow = null;
      scene.items = new Map(); scene.blockers = new Map();
      if3dBuildPitch(scene, s);
      scene.world.appendChild(scene.arrow); // after the pitch so the aim arrow paints on top of the slab
    },
    canAim: () => !!(state && state.gameId === 'ice-football' && ifCanAim(state)),
    hasMe: () => !!(state && state.pieces && state.pieces.find((p) => p.seat === state.seat)),
    onAim(angle, power) {
      _ifAim = _ifAim || { angle: 0, power: 0.5 };
      _ifAim.angle = angle; _ifAim.power = power;
      drawIf3d(state, { ball: null, pieces: null, aim: _ifAim });
      ifSyncSlider();
    },
    onTap(seat) { // tap an opponent while Freeze is armed = pick the target
      if (!(_ifPU && _ifPU.type === 'freeze')) return;
      const tgt = (state.pieces || []).find((p) => p.seat === seat);
      if (tgt && state.you && tgt.team !== state.you.team) { _ifPU.targetId = tgt.seat; renderIfActions(state); ifRedraw(); }
    },
    redraw: ifRedraw,
  });
}

function if3dBall(scene, ballPos, rb) {
  let b = scene.ball, sh = scene.ballShadow;
  if (!b) {
    sh = document.createElement('div'); sh.className = 'pk3d-obj if3d-ballshadow'; scene.world.appendChild(sh); scene.ballShadow = sh;
    b = document.createElement('div'); b.className = 'pk3d-obj if3d-ball'; scene.world.appendChild(b); scene.ball = b;
  }
  const S = _if3dScale, r = rb * S, x = (ballPos.x * S).toFixed(1), z = (-ballPos.y * S).toFixed(1);
  b.style.width = b.style.height = (2 * r).toFixed(1) + 'px';
  // billboarded so it reads as a sphere from any camera angle (its physics is a circle = a sphere on the plane)
  b.style.transform = `translate(-50%,-50%) translate3d(${x}px,${(-r).toFixed(1)}px,${z}px) ${a3dBillboard(_ifView.cam)}`;
  // a flat contact shadow on the pitch, directly under the ball
  sh.style.width = (2.2 * r).toFixed(1) + 'px'; sh.style.height = (1.1 * r).toFixed(1) + 'px';
  sh.style.transform = `translate(-50%,-50%) translate3d(${x}px,-1px,${z}px) rotateX(90deg)`;
}

function if3dPiece(scene, p, s, moving) {
  let el = scene.pengs.get(p.id);
  if (!el) { const meta = (s.pieces || []).find((q) => q.seat === p.id); el = a3dBuildPeng(IF_TEAM[meta ? meta.team : 'red']); el.dataset.pseat = p.id; scene.world.appendChild(el); scene.pengs.set(p.id, el); }
  const S = _if3dScale, wx = p.x * S, wz = -p.y * S;
  const b = s.ball || { x: 0, y: 0 };
  const face = a3dFacing(el, p, moving, Math.atan2(b.x - p.x, -(b.y - p.y)) * 180 / Math.PI); // idle → face the ball
  const F = (s.pitch.rp * _if3dScale) / 15; // scale the (30px) block so its body edge = the hitbox
  el.style.transform = `translate(-50%,-50%) translate3d(${wx.toFixed(1)}px,0px,${wz.toFixed(1)}px) rotateY(${face.toFixed(1)}deg) scale3d(${F.toFixed(3)},${F.toFixed(3)},${F.toFixed(3)})`;
  el.classList.toggle('mine', p.id === s.seat);
  el.classList.toggle('out', !!p.o);
}

function if3dItems(scene, items) {
  const seen = new Set();
  for (const it of items) {
    let el = scene.items.get(it.id);
    if (!el) { el = document.createElement('div'); el.className = 'pk3d-obj if3d-item'; el.textContent = IF_PU_ICON[it.type] || '★'; scene.world.appendChild(el); scene.items.set(it.id, el); }
    const S = _if3dScale;
    el.style.transform = `translate(-50%,-50%) translate3d(${(it.x * S).toFixed(0)}px,-22px,${(-it.y * S).toFixed(0)}px) ${a3dBillboard(_ifView.cam)}`;
    seen.add(it.id);
  }
  for (const [id, el] of scene.items) if (!seen.has(id)) { el.remove(); scene.items.delete(id); }
}

function if3dBlockers(scene, walls) {
  const seen = new Set();
  walls.forEach((w, idx) => {
    const id = 'b' + idx;
    let el = scene.blockers.get(id);
    if (!el) { el = a3dBox(2 * w.r * _if3dScale, 42, 2 * w.r * _if3dScale, { all: '#c3ccdb' }); scene.world.appendChild(el); scene.blockers.set(id, el); }
    el.style.transform = `translate3d(${(w.x * _if3dScale).toFixed(0)}px,-21px,${(-w.y * _if3dScale).toFixed(0)}px)`;
    seen.add(id);
  });
  for (const [id, el] of scene.blockers) if (!seen.has(id)) { el.remove(); scene.blockers.delete(id); }
}

function drawIf3d(s, opts) {
  const scene = ifScene($('ifBoard'), s);
  a3dApplyCamera(scene, _ifView.cam);
  const S = _if3dScale;
  if3dBall(scene, opts.ball || s.ball, s.pitch.rb);
  const piecePos = opts.pieces;
  const list = piecePos ? piecePos.map((fp) => ({ id: fp.id, x: fp.x, y: fp.y, o: fp.o })) : (s.pieces || []).map((p) => ({ id: p.seat, x: p.x, y: p.y, o: false }));
  const moving = !!piecePos;
  const seen = new Set();
  for (const p of list) { if3dPiece(scene, p, s, moving); seen.add(p.id); }
  for (const [id, el] of scene.pengs) if (!seen.has(id)) { el.remove(); scene.pengs.delete(id); }
  if3dItems(scene, s.items || []);
  if3dBlockers(scene, opts.walls || []);
  a3dImpacts(scene, _ifView.cam, opts.impacts, opts.frame, S);
  const teamColor = (id) => { const meta = (s.pieces || []).find((q) => q.seat === id); return IF_TEAM[meta ? meta.team : 'red']; };
  a3dReveal(scene, opts.reveal, opts.revealK, opts.revealPos, S, 0.26, 1.0, teamColor);
  const me = list.find((p) => p.id === s.seat && !p.o);
  a3dArrow(scene, me, opts.aim, S, 0.26, 1.0);
  const canCommit = s.phase === 'commit' && s.you && !s.you.committed && !s.you.spectator;
  a3dChrome(scene, _ifView, canCommit, s.phase === 'commit', {
    lockLabel: `🔒 Lock in · ${Math.round((_ifAim ? _ifAim.power : 0.5) * 100)}%`,
    onLock: () => {
      if (_ifPU && _ifPU.type === 'freeze' && _ifPU.targetId == null) { toast('Pick an opponent to freeze first.', 'err'); return; }
      const a = _ifAim || { angle: 0, power: 0.5 };
      send({ type: 'commitMove', angle: a.angle, power: a.power, usePowerUp: _ifPU || undefined });
    },
    aimHint: 'drag anywhere to aim',
  });
}

function ifPlayResolution(s) {
  const res = s.resolution;
  if (_ifReplay.round === s.round && _ifReplay.raf) return;
  if (_ifReplay.raf) cancelAnimationFrame(_ifReplay.raf);
  _ifReplay = { round: s.round, raf: 0 };
  const frames = res.frames || [];
  const total = frames.length;
  if (total < 2) { drawIf3d(s, { ball: frames[0] ? frames[0].b : s.ball, pieces: frames[0] ? frames[0].p : null, walls: res.walls }); return; }
  a3dPlayFrames(_ifReplay, total, (ff, i, k) => {
    const f = ifLerpFrame(frames, ff);
    drawIf3d(s, { ball: f.b, pieces: f.p, walls: res.walls, impacts: res.impacts, frame: i, reveal: res.reveal, revealK: k, revealPos: frames[0].p });
  }, () => {
    _ifReplay.raf = 0;
    // land the payoff: the goal gets its own moment, not just a score digit
    if (res.goal) a3dBanner($('ifBoard').__a3d, `⚽ ${res.goal.toUpperCase()} SCORES!`, IF_TEAM[res.goal]);
  });
}

// Blend two ticks (ball + pieces) for smooth slow-motion playback.
function ifLerpFrame(frames, ff) {
  const total = frames.length;
  const i = Math.min(total - 1, Math.max(0, Math.floor(ff)));
  const j = Math.min(total - 1, i + 1);
  const fr = ff - i;
  const A = frames[i], B = frames[j];
  const b = { x: A.b.x + (B.b.x - A.b.x) * fr, y: A.b.y + (B.b.y - A.b.y) * fr };
  const p = A.p.map((a) => { const bb = B.p.find((q) => q.id === a.id) || a; return { id: a.id, x: a.x + (bb.x - a.x) * fr, y: a.y + (bb.y - a.y) * fr, o: a.o }; });
  return { b, p };
}

function renderIfActions(s) {
  const area = $('ifActions');
  area.innerHTML = '';
  const you = s.you || {};
  if (s.over) {
    const youWin = (s.winners || []).includes(s.seat);
    area.appendChild(banner(youWin ? `🏆 ${(s.winningTeam || '').toUpperCase()} wins!` : `${(s.winningTeam || '').toUpperCase()} wins.`, youWin ? 'win' : 'lose'));
    appendEndButtons(area, s);
    return;
  }
  if (s.phase === 'resolve') {
    area.appendChild(callout('⚽ Kick! Watch it play out… (drag to look around)', true));
    return;
  }
  if (you.spectator) { area.appendChild(callout('Spectating this match.', true)); return; }
  if (you.committed) {
    const left = (s.pieces || []).filter((p) => !p.committed).length;
    area.appendChild(callout(`Locked in — waiting for ${left} more`, true));
    return;
  }
  area.appendChild(prompt('Drag on the pitch to <b>aim &amp; power up</b>, then hit <b>Lock in</b> on the pitch. <i>(fine-tune power below)</i>'));
  const redraw3d = () => { if (state && state.gameId === 'ice-football') drawIf3d(state, { ball: null, pieces: null, aim: ifCanAim(state) ? _ifAim : null }); };
  // power-ups you've banked
  if ((you.powerUps || []).length) {
    const purow = document.createElement('div');
    purow.className = 'if-purow';
    const counts = {};
    for (const t of you.powerUps) counts[t] = (counts[t] || 0) + 1;
    Object.keys(counts).forEach((t) => {
      const armed = _ifPU && _ifPU.type === t;
      const b = actBtn(`${IF_PU_ICON[t] || '★'} ${IF_PU_NAME[t] || t}${counts[t] > 1 ? ` ×${counts[t]}` : ''}${armed && t === 'freeze' && _ifPU.targetId != null ? ' ✓' : ''}`, 'if-pubtn' + (armed ? ' on' : ''), () => {
        _ifPU = armed ? null : { type: t };
        renderIfActions(s);
        redraw3d();
      });
      purow.appendChild(b);
    });
    area.appendChild(purow);
    if (_ifPU && _ifPU.type === 'freeze' && _ifPU.targetId == null) area.appendChild(callout('Tap an opponent on the pitch to freeze them.'));
  }
  const aim = _ifAim || { angle: 0, power: 0.5 };
  const meter = document.createElement('div');
  meter.className = 'pk-powerbar';
  meter.innerHTML = `<span>Power</span><input type="range" class="pk-slider" min="0" max="100" value="${Math.round(aim.power * 100)}" aria-label="Power"/><b class="pk-powerval">${Math.round(aim.power * 100)}%</b>`;
  meter.querySelector('.pk-slider').oninput = (e) => {
    _ifAim = _ifAim || { angle: 0, power: 0 };
    _ifAim.power = e.target.value / 100;
    meter.querySelector('.pk-powerval').textContent = e.target.value + '%';
    redraw3d();
  };
  area.appendChild(meter);
}

// ---------------------------------------------------------------------------
// Contextual actions per phase
// ---------------------------------------------------------------------------

function renderActions(s) {
  const area = $('actionArea');
  area.innerHTML = '';

  if (s.matchWinner != null) {
    const win = s.matchWinner === s.seat;
    area.appendChild(banner(win ? '🏆 You win the match!' : 'Match over.', win ? 'win' : 'lose'));
    appendEndButtons(area, s);
    return;
  }

  if (s.you.inMatch === false) {
    area.appendChild(callout('Spectating — you’ll be in the next match', true));
    return;
  }

  if (!s.you.inHand && s.phase !== 'showdown') {
    area.appendChild(callout('You folded — watching the rest of the hand', true));
    return;
  }

  if (s.phase === 'bet1' || s.phase === 'bet2') {
    renderBetting(area, s);
    return;
  }

  if (s.phase === 'reveal') {
    if (s.reveal.youLocked) {
      area.appendChild(callout(s.reveal.waiting ? 'Locked in — waiting for others' : 'Revealing', true));
    } else {
      area.appendChild(prompt('Pick one card to reveal <b>(not the liar)</b> — tap a card.'));
    }
    return;
  }

  if (s.phase === 'discuss') {
    area.appendChild(prompt('Discuss freely — <b>bluff or be honest</b>.'));
    const btn = actBtn(
      s.discuss.youReady ? 'Waiting for others…' : "I'm ready to bet",
      'btn btn-primary btn-lg',
      () => send({ type: 'discussDone' }),
    );
    btn.disabled = s.discuss.youReady;
    area.appendChild(btn);
    return;
  }

  if (s.phase === 'showdown') {
    if (s.liar && s.liar.needsYou) {
      area.appendChild(renderLiarControls(s.liar));
    } else if (s.liar && s.liar.waitingOnOpponent) {
      area.appendChild(callout('Waiting on liar holder(s) to choose', true));
    }
    if (s.result) area.appendChild(renderResult(s));
    return;
  }
}

function renderBetting(area, s) {
  const b = s.betting;
  if (!b.yourTurn) {
    area.appendChild(callout('Waiting for other players to act', true));
    return;
  }
  area.appendChild(
    prompt(b.toCall > 0 ? `To call: <b>${b.toCall}</b>` : 'No bet to you — <b>check or bet</b>.'),
  );

  const row = document.createElement('div');
  row.className = 'btn-row';
  if (b.canCheck) {
    row.appendChild(actBtn('Check', 'btn btn-neutral', () => send({ type: 'action', action: 'check' })));
  } else {
    const callAmt = Math.min(b.toCall, b.yourChips);
    row.appendChild(
      actBtn(callAmt < b.toCall ? `Call ${callAmt} · all-in` : `Call ${b.toCall}`, 'btn btn-good', () =>
        send({ type: 'action', action: 'call' }),
      ),
    );
  }
  row.appendChild(actBtn('Fold', 'btn btn-bad', () => send({ type: 'action', action: 'fold' })));
  area.appendChild(row);

  // Raise slider (amount = chips on top of the call).
  const maxRaise = b.yourChips - b.toCall;
  if (maxRaise >= 1) {
    const controls = document.createElement('div');
    controls.className = 'bet-controls';

    const wrap = document.createElement('div');
    wrap.className = 'slider-row';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '1';
    range.max = String(maxRaise);
    range.value = '1';
    const badge = document.createElement('span');
    badge.className = 'amount-badge';
    badge.textContent = '+1';
    range.oninput = () => (badge.textContent = '+' + range.value);
    const go = actBtn('Raise', 'btn btn-gold', () =>
      send({ type: 'action', action: 'raise', amount: Number(range.value) }),
    );
    wrap.append(range, badge, go);

    const allIn = actBtn(`All-in · ${b.yourChips}`, 'btn btn-gold', () =>
      send({ type: 'action', action: 'raise', amount: maxRaise }),
    );
    controls.append(wrap, allIn);
    area.appendChild(controls);
  }
}

function renderLiarControls(liar) {
  const box = document.createElement('div');
  box.className = 'liar-controls';
  const title = document.createElement('div');
  title.className = 'l-title';
  title.textContent = liar.sharedIsLiar
    ? '🃏 The shared card is the LIAR — set its value'
    : '🃏 You hold the LIAR — set your two hidden cards';
  box.appendChild(title);

  // No auto-suggestion: the player decides each value themselves.
  const picks = liar.wildSlots.map(() => null);
  const lockBtn = actBtn('Lock in', 'btn btn-gold', () => {
    if (picks.every((p) => p !== null)) send({ type: 'liar', values: picks });
  });
  const refreshLock = () => (lockBtn.disabled = !picks.every((p) => p !== null));

  liar.wildSlots.forEach((slot, idx) => {
    const seg = document.createElement('div');
    seg.className = 'seg';
    ['rock', 'paper', 'scissor', 'love'].forEach((suit) => {
      const b = document.createElement('button');
      b.className = 'suit-' + suit;
      b.innerHTML = SUIT_SVG[suit];
      b.title = SUIT_LABEL[suit];
      b.onclick = () => {
        picks[idx] = suit;
        [...seg.children].forEach((c) => c.classList.remove('sel'));
        b.classList.add('sel');
        refreshLock();
      };
      seg.appendChild(b);
    });
    box.appendChild(seg);
  });

  refreshLock();
  box.appendChild(lockBtn);
  return box;
}

function renderResult(s) {
  const r = s.result;
  const box = document.createElement('div');
  box.className = 'result';
  const won = (seat) => (r.awards.find((a) => a.seat === seat)?.amount ?? 0);
  const youWon = won(s.seat);

  const h = document.createElement('h3');
  if (youWon > 0) {
    h.textContent = `🎉 You win ${youWon}`;
    h.className = 'verdict-win';
  } else if (r.kind === 'fold') {
    const w = r.awards[0];
    h.textContent = `${nameOf(s, w.seat)} wins ${w.amount} — everyone folded`;
    h.className = 'verdict-lose';
  } else {
    const winners = r.awards.map((a) => `${nameOf(s, a.seat)} ${a.amount}`).join(' · ');
    h.textContent = winners ? `Pot: ${winners}` : '🤝 Draw — pot carries';
    h.className = r.awards.length > 1 ? 'verdict-draw' : 'verdict-lose';
  }
  box.appendChild(h);
  if (r.carried) box.appendChild(prompt(`<b>${r.carried}</b> carried to next round`));

  if (r.reveals && r.reveals.length) {
    const hands = document.createElement('div');
    hands.className = 'hands';
    r.reveals.forEach((rv) => {
      const col = document.createElement('div');
      col.className = 'hand';
      if (won(rv.seat) > 0) col.classList.add('winner');
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = (rv.seat === s.seat ? 'You' : rv.name) + (won(rv.seat) > 0 ? ` +${won(rv.seat)}` : '');
      const cards = document.createElement('div');
      cards.className = 'cards';
      if (rv.folded) {
        cards.innerHTML = '<span class="folded-note">folded</span>';
      } else {
        rv.cards.forEach((suit) => cards.appendChild(cardEl({ suit }, { win: won(rv.seat) > 0 })));
      }
      const rn = document.createElement('div');
      rn.className = 'rankname';
      rn.textContent = rv.folded ? '' : rankName(rv.rank);
      col.append(who, cards, rn);
      hands.appendChild(col);
    });
    box.appendChild(hands);
  }

  box.appendChild(actBtn('Next round →', 'btn btn-primary btn-lg', () => send({ type: 'nextRound' })));
  return box;
}

function nameOf(s, seat) {
  if (seat === s.seat) return 'You';
  const o = (s.others || []).find((x) => x.seat === seat);
  return o ? o.name : (s.roster?.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`);
}

const RANK_NAMES = {
  1: 'Love Wins All', 2: 'Three Love', 3: 'Four Card', 4: 'Mix',
  5: 'Two Love', 6: 'Two Pair', 7: 'Triple', 8: 'One Pair', 9: 'One Love',
};
function rankName(rank) {
  return `#${rank} ${RANK_NAMES[rank] || ''}`;
}

// ---------------------------------------------------------------------------
// Small UI builders
// ---------------------------------------------------------------------------

function prompt(text) {
  const p = document.createElement('div');
  p.className = 'prompt';
  p.innerHTML = text;
  return p;
}
function callout(text, pulse = false) {
  const c = document.createElement('div');
  c.className = 'callout';
  c.innerHTML = pulse ? `${text}<span class="pulse-dots"></span>` : text;
  return c;
}
function banner(text, variant) {
  const b = document.createElement('div');
  b.className = 'banner ' + (variant || '');
  b.textContent = text;
  return b;
}
function actBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

// Instant tap acknowledgement for board cells/cards. The authoritative result is a network
// round-trip away, so flash the tapped element immediately — the tap never feels dropped.
// The next server render replaces the element with the real outcome.
function tapAck(el) {
  if (!el) return;
  el.classList.remove('tap-ack');
  void el.offsetWidth; // restart the animation if tapped again quickly
  el.classList.add('tap-ack');
}

function renderLog(s) {
  const ul = $('logList');
  ul.innerHTML = '';
  (s.log || []).forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  $('chatInput').value = '';
});

function addChat(msg) {
  const log = $('chatLog');
  const mine = msg.seat === mySeat;
  const div = document.createElement('div');
  div.className = 'msg' + (mine ? ' me' : '');
  if (!mine) div.style.borderLeft = `3px solid ${seatColor(msg.seat)}`;
  const b = document.createElement('b');
  b.style.color = seatColor(msg.seat); // name colour matches the seat's avatar
  b.textContent = (mine ? 'You' : msg.name) + ': ';
  div.appendChild(b);
  div.appendChild(document.createTextNode(msg.text));
  log.appendChild(div);
  while (log.children.length > 60) log.removeChild(log.firstChild); // cap history
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(text, kind = '') {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2400);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function initial(name) {
  return ((name || '?').trim()[0] || '?').toUpperCase();
}

// Tween a numeric readout and flash it green (up) or red (down) on change.
function animateNumber(el, to) {
  const from = el.__val ?? to;
  el.__val = to;
  if (from === to) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now();
  const dur = 450;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = String(to);
  };
  requestAnimationFrame(step);
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // restart the animation
  el.classList.add(to > from ? 'flash-up' : 'flash-down');
}

function showOverlay(msg) {
  $('overlayMsg').textContent = msg;
  $('overlay').classList.remove('hidden');
}
function hideOverlay() {
  $('overlay').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Hand rankings reference (open any time during a game)
// ---------------------------------------------------------------------------

const HAND_GUIDE = [
  { rank: 1, name: 'Love Wins All', desc: 'Four loves', cards: ['love', 'love', 'love', 'love'] },
  { rank: 2, name: 'Three Love', desc: 'Three loves + any card', cards: ['love', 'love', 'love', 'rock'] },
  { rank: 3, name: 'Four Card', desc: 'Four of a kind (non-love)', cards: ['rock', 'rock', 'rock', 'rock'] },
  { rank: 4, name: 'Mix', desc: 'One love + rock + paper + scissor', cards: ['love', 'rock', 'paper', 'scissor'] },
  { rank: 5, name: 'Two Love', desc: 'Two loves + any two cards', cards: ['love', 'love', 'rock', 'scissor'] },
  { rank: 6, name: 'Two Pair', desc: 'Two pairs (non-love)', cards: ['rock', 'rock', 'paper', 'paper'] },
  { rank: 7, name: 'Triple', desc: 'Three of a kind (non-love)', cards: ['rock', 'rock', 'rock', 'paper'] },
  { rank: 8, name: 'One Pair', desc: 'One pair (non-love)', cards: ['rock', 'rock', 'paper', 'scissor'] },
  { rank: 9, name: 'One Love', desc: 'One love + three others — two of these always draw', cards: ['love', 'rock', 'rock', 'scissor'] },
];
let ranksBuilt = false;

function buildRanks() {
  const list = $('ranksList');
  HAND_GUIDE.forEach((h) => {
    const row = document.createElement('div');
    row.className = 'rank-row';
    const badge = document.createElement('div');
    badge.className = 'rank-badge';
    badge.textContent = '#' + h.rank;
    const info = document.createElement('div');
    info.className = 'rank-info';
    info.innerHTML = `<div class="rname">${h.name}</div><div class="rdesc">${h.desc}</div>`;
    const ex = document.createElement('div');
    ex.className = 'ex-cards';
    h.cards.forEach((suit) => ex.appendChild(cardEl({ suit })));
    row.append(badge, info, ex);
    list.appendChild(row);
  });
  ranksBuilt = true;
}

function openRanks() {
  if (!ranksBuilt) buildRanks();
  $('ranksSheet').classList.remove('hidden');
}
function closeRanks() {
  $('ranksSheet').classList.add('hidden');
}
$('ranksBtn').onclick = openRanks;
$('ranksClose').onclick = closeRanks;
$('ranksSheet').addEventListener('click', (e) => {
  if (e.target.id === 'ranksSheet') closeRanks(); // tap the backdrop to dismiss
});

// Players panel — view the roster anywhere; the host can remove players (in-game too).
function renderPlayersSheet() {
  if ($('playersSheet').classList.contains('hidden') || !state) return;
  const s = state;
  const roster = s.roster || [];
  const youAreHost = !!s.youAreHost;
  const inGame = s.phase && s.phase !== 'lobby';
  $('playersSub').textContent = youAreHost
    ? (inGame ? 'Remove a player — a bot finishes their seat.' : 'Remove a player or bot from the room.')
    : 'Everyone currently in this room.';
  const list = $('playersList');
  list.innerHTML = '';
  roster.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'lobby-row';
    li.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(p.seat)}">${initial(p.name)}</span>` +
      `<span class="lobby-name">${escapeHtml(p.name)}${p.seat === s.seat ? ' (you)' : ''}</span>` +
      (p.host ? '<span class="badge b-host">host</span>' : '') +
      (p.bot ? '<span class="badge b-bot">🤖 bot</span>' : '') +
      `<i class="dot ${p.connected ? 'on' : ''}"></i>`;
    // Host can remove others; mid-match only humans (a bot already fills the seat).
    if (youAreHost && !p.host && p.seat !== s.seat && !(inGame && p.bot)) {
      const x = document.createElement('button');
      x.className = 'lobby-kick';
      x.title = `Remove ${p.name}`;
      x.textContent = '✕';
      x.onclick = () => kickSeat(p.seat, p.name);
      li.appendChild(x);
    }
    list.appendChild(li);
  });

  // Turn-alert toggle (sound + vibration when it's your turn).
  const opt = document.createElement('li');
  opt.className = 'lobby-row';
  opt.innerHTML = `<span class="lobby-name">🔔 Turn alerts (sound &amp; buzz)</span>`;
  const tog = document.createElement('button');
  tog.className = 'btn ' + (_soundOff ? 'btn-quiet' : 'btn-good');
  tog.textContent = _soundOff ? 'Off' : 'On';
  tog.style.padding = '6px 16px';
  tog.onclick = () => {
    _soundOff = !_soundOff;
    localStorage.setItem('soundOff', _soundOff ? '1' : '0');
    if (!_soundOff) { unlockAudio(); chime(); }
    renderPlayersSheet();
  };
  opt.appendChild(tog);
  list.appendChild(opt);
}
function openPlayers() { $('playersSheet').classList.remove('hidden'); renderPlayersSheet(); }
function closePlayers() { $('playersSheet').classList.add('hidden'); }
document.querySelectorAll('.players-btn').forEach((b) => (b.onclick = openPlayers));
$('playersClose').onclick = closePlayers;

// Swap the emoji topbar glyphs (⧉ / 👥) for crisp inline SVG icons.
const SVG_PLAYERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.6 19c0-3 2.4-5 5.4-5s5.4 2 5.4 5"/><path d="M16 5.6a3 3 0 0 1 0 5.4"/><path d="M17.6 19c0-2.1-.9-3.6-2.2-4.5"/></svg>';
const SVG_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
document.querySelectorAll('.players-btn').forEach((b) => (b.innerHTML = SVG_PLAYERS));
document.querySelectorAll('.icon-btn[title="Copy invite link"]').forEach((b) => (b.innerHTML = SVG_COPY));
$('playersSheet').addEventListener('click', (e) => {
  if (e.target.id === 'playersSheet') closePlayers();
});

// The lobby's button fully exits the room; in-game buttons return you to this room's lobby.
$('leaveLobbyBtn').onclick = leaveRoom;
$('leaveBtn').onclick = backToLobby;
$('liLeaveBtn').onclick = backToLobby;
$('yzLeaveBtn').onclick = backToLobby;
$('sgLeaveBtn').onclick = backToLobby;
$('cnLeaveBtn').onclick = backToLobby;
$('qrLeaveBtn').onclick = backToLobby;
$('tecLeaveBtn').onclick = backToLobby;
$('mmLeaveBtn').onclick = backToLobby;
$('waLeaveBtn').onclick = backToLobby;
$('gpLeaveBtn').onclick = backToLobby;
$('pkLeaveBtn').onclick = backToLobby;
$('ifLeaveBtn').onclick = backToLobby;
$('sbLeaveBtn').onclick = backToLobby;
$('svLeaveBtn').onclick = backToLobby;
$('tfLeaveBtn').onclick = backToLobby;
$('mhLeaveBtn').onclick = backToLobby;

// Penguin Knockout rules sheet
$('pkRulesClose').onclick = () => $('pkRulesSheet').classList.add('hidden');
$('pkRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'pkRulesSheet') $('pkRulesSheet').classList.add('hidden');
});
// Ice Football rules sheet
$('ifRulesClose').onclick = () => $('ifRulesSheet').classList.add('hidden');
$('ifRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'ifRulesSheet') $('ifRulesSheet').classList.add('hidden');
});

// Who Am I? rules sheet
$('waRulesClose').onclick = () => $('waRulesSheet').classList.add('hidden');
$('waRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'waRulesSheet') $('waRulesSheet').classList.add('hidden');
});

// Guess the Player rules sheet
$('gpRulesClose').onclick = () => $('gpRulesSheet').classList.add('hidden');
$('gpRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'gpRulesSheet') $('gpRulesSheet').classList.add('hidden');
});

// Lock In rules sheet
$('liRulesBtn').onclick = () => $('liRulesSheet').classList.remove('hidden');
$('liRulesClose').onclick = () => $('liRulesSheet').classList.add('hidden');
$('liRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'liRulesSheet') $('liRulesSheet').classList.add('hidden');
});

// Yahtzee rules sheet
$('yzRulesBtn').onclick = () => $('yzRulesSheet').classList.remove('hidden');
$('yzRulesClose').onclick = () => $('yzRulesSheet').classList.add('hidden');
$('yzRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'yzRulesSheet') $('yzRulesSheet').classList.add('hidden');
});

// Spy Game rules sheet
$('sgRulesBtn').onclick = () => $('sgRulesSheet').classList.remove('hidden');
$('sgRulesClose').onclick = () => $('sgRulesSheet').classList.add('hidden');
$('sgRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'sgRulesSheet') $('sgRulesSheet').classList.add('hidden');
});

// Codenames rules sheet
$('cnRulesBtn').onclick = () => $('cnRulesSheet').classList.remove('hidden');
$('cnRulesClose').onclick = () => $('cnRulesSheet').classList.add('hidden');
$('cnRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'cnRulesSheet') $('cnRulesSheet').classList.add('hidden');
});

// Quoridor rules sheet
$('qrRulesBtn').onclick = () => $('qrRulesSheet').classList.remove('hidden');
$('qrRulesClose').onclick = () => $('qrRulesSheet').classList.add('hidden');
$('qrRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'qrRulesSheet') $('qrRulesSheet').classList.add('hidden');
});

// Tectonic Shift rules sheet
$('tecRulesBtn').onclick = () => $('tecRulesSheet').classList.remove('hidden');
$('tecRulesClose').onclick = () => $('tecRulesSheet').classList.add('hidden');
$('tecRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'tecRulesSheet') $('tecRulesSheet').classList.add('hidden');
});

// Manhunt rules sheet
$('mhRulesBtn').onclick = () => $('mhRulesSheet').classList.remove('hidden');
$('mhRulesClose').onclick = () => $('mhRulesSheet').classList.add('hidden');
$('mhRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'mhRulesSheet') $('mhRulesSheet').classList.add('hidden');
});

// Three Fronts rules sheet
$('tfRulesBtn').onclick = () => $('tfRulesSheet').classList.remove('hidden');
$('tfRulesClose').onclick = () => $('tfRulesSheet').classList.add('hidden');
$('tfRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'tfRulesSheet') $('tfRulesSheet').classList.add('hidden');
});

// Salvo rules sheet
$('svRulesBtn').onclick = () => $('svRulesSheet').classList.remove('hidden');
$('svRulesClose').onclick = () => $('svRulesSheet').classList.add('hidden');
$('svRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'svRulesSheet') $('svRulesSheet').classList.add('hidden');
});

// Sealed Bids rules sheet
$('sbRulesBtn').onclick = () => $('sbRulesSheet').classList.remove('hidden');
$('sbRulesClose').onclick = () => $('sbRulesSheet').classList.add('hidden');
$('sbRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'sbRulesSheet') $('sbRulesSheet').classList.add('hidden');
});

// Memory Match rules sheet
$('mmRulesBtn').onclick = () => $('mmRulesSheet').classList.remove('hidden');
$('mmRulesClose').onclick = () => $('mmRulesSheet').classList.add('hidden');
$('mmRulesSheet').addEventListener('click', (e) => {
  if (e.target.id === 'mmRulesSheet') $('mmRulesSheet').classList.add('hidden');
});

// ---------------------------------------------------------------------------
// Round-start announcement (who acts first) + deck-reshuffle notice
// ---------------------------------------------------------------------------

// Pip layout (index 0..8 in a 3×3 grid) per die face.
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function setDie(el, v) {
  el.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const dot = document.createElement('span');
    dot.className = 'pip' + (PIPS[v].includes(i) ? ' on' : '');
    el.appendChild(dot);
  }
}

let roTimer = null;
let roTimeouts = [];
let lastAnte = 0;
function maybeNotify(s) {
  if (!s.roundNo || s.roundNo === lastRoundNo) return;
  const blindsUp = lastAnte && s.ante > lastAnte;
  lastRoundNo = s.roundNo;
  lastAnte = s.ante || lastAnte;
  if (s.phase === 'lobby' || s.phase === 'matchover') return;
  if (s.deckReshuffled) setTimeout(() => toast('🔄 Deck ran out — reshuffled a fresh deck', 'ok'), 1300);
  if (blindsUp) setTimeout(() => toast(`⬆️ Blinds up — ante is now ${s.ante}`, 'ok'), 1300);
  announceRound(s);
}

function nameForSeat(s, seat) {
  if (seat === s.seat) return 'You';
  const p = (s.roster || []).find((x) => x.seat === seat);
  return p ? p.name : `Seat ${seat + 1}`;
}

const TUMBLE_MS = 1800; // how long the dice tumble before settling
const HOLD_MS = 2000; // how long the result is shown after settling

function announceRound(s) {
  clearDiceSplash();

  // Build one die per player who's in this round (those with a roll).
  const dice = s.dice || [];
  const players = (s.roster || [])
    .map((p) => p.seat)
    .filter((seat) => dice[seat] > 0)
    .map((seat) => ({ seat, name: nameForSeat(s, seat), final: dice[seat] }));
  if (!players.length) return;

  $('roTitle').textContent = `Round ${s.roundNo} · Ante ${s.ante || 1} — rolling for first move`;
  $('roFirst').textContent = '';
  const stage = $('roDice');
  stage.innerHTML = '';
  const dieEls = players.map((p) => {
    const wrap = document.createElement('div');
    wrap.className = 'ro-player';
    wrap.dataset.seat = p.seat;
    const die = document.createElement('div');
    die.className = 'ro-die tumble';
    const name = document.createElement('div');
    name.className = 'ro-name';
    name.textContent = p.seat === s.seat ? 'You' : p.name;
    name.style.color = seatColor(p.seat);
    wrap.append(die, name);
    stage.appendChild(wrap);
    return { ...p, die, wrap };
  });
  $('roundOverlay').classList.remove('hidden');

  // All dice tumble simultaneously.
  roTimer = setInterval(() => {
    for (const d of dieEls) setDie(d.die, 1 + Math.floor(Math.random() * 6));
  }, 130);

  roTimeouts.push(
    setTimeout(() => {
      clearInterval(roTimer);
      for (const d of dieEls) {
        d.die.classList.remove('tumble');
        setDie(d.die, d.final); // land on the real roll
        if (d.seat === s.firstActor) d.wrap.classList.add('won');
        else d.wrap.classList.add('lost');
      }
      const first = nameForSeat(s, s.firstActor);
      $('roFirst').textContent = first === 'You' ? '🎉 You act first' : `${first} acts first`;
      roTimeouts.push(setTimeout(() => $('roundOverlay').classList.add('hidden'), HOLD_MS));
    }, TUMBLE_MS),
  );
}

function clearDiceSplash() {
  clearInterval(roTimer);
  roTimeouts.forEach(clearTimeout);
  roTimeouts = [];
}

// Tap to skip the round-start splash (so a first-to-act player isn't blocked).
$('roundOverlay').addEventListener('click', () => {
  clearDiceSplash();
  $('roundOverlay').classList.add('hidden');
});

init();
