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
  if (lob.matchInProgress) {
    // You stepped out and are waiting in the lobby while the others finish the match.
    start.style.display = 'none';
    $('lobbyMsg').textContent = 'A match is in progress — you’ll rejoin the lobby when it ends.';
  } else if (s.youAreHost) {
    const need = (lob.minPlayers ?? 2);
    const short = s.roster.length < need;
    start.style.display = '';
    start.disabled = short;
    start.textContent = short ? 'Waiting for players…' : `Start game (${s.roster.length})`;
    start.onclick = () => send({ type: 'start' });
    $('lobbyMsg').textContent = short ? (need <= 1 ? 'Add players, or start solo.' : 'Share the invite link to add players.') : '';
  } else {
    start.style.display = 'none';
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
      const b = actBtn('', 'btn btn-neutral li-pick', () => send({ type: 'pick', target: v }));
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
      die.onclick = () => send({ type: 'hold', index: i });
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
            c.onclick = () => send({ type: 'score', category: row.cat });
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
      const b = actBtn('', 'sg-votebtn', () => send({ type: 'castVote', target: o.seat }));
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
      el.onclick = () => send({ type: 'guessCard', cardIndex: i });
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
        cell.onclick = () => send({ type: 'movePawn', toCell: [r, c] });
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

  let svg = `<svg viewBox="${vb}" class="tec-svg" preserveAspectRatio="xMidYMid meet">`;
  for (const h of present) {
    const key = h.q + ',' + h.r;
    const pawn = pawnByHex[key];
    const isDest = dest.has(key);
    const cls = 'tec-hex' + (isDest ? ' dest' : '') + (selPawn && selPawn.q === h.q && selPawn.r === h.r ? ' selhex' : '');
    svg += `<polygon points="${tecPoints(h._x, h._y, sz)}" class="${cls}" data-q="${h.q}" data-r="${h.r}"/>`;
    if (pawn) {
      const mine = pawn.owner === s.seat;
      svg += `<circle cx="${h._x}" cy="${h._y}" r="${sz * 0.52}" class="tec-pawn${pawn.alive ? '' : ' dead'}${tecSel === pawn.id ? ' sel' : ''}${mine ? ' mine' : ''}" fill="${seatColor(pawn.owner)}" data-q="${h.q}" data-r="${h.r}"/>`;
    } else if (isDest) {
      svg += `<circle cx="${h._x}" cy="${h._y}" r="${sz * 0.28}" class="tec-destdot" data-q="${h.q}" data-r="${h.r}"/>`;
    } else {
      svg += `<text x="${h._x}" y="${h._y}" class="tec-val" fill="${TEC_VAL_COLORS[h.value] || '#888'}" data-q="${h.q}" data-r="${h.r}">${h.value}</text>`;
    }
  }
  svg += '</svg>';
  board.innerHTML = svg;
  const svgEl = board.querySelector('svg');
  svgEl.onclick = (e) => {
    const q = e.target.getAttribute && e.target.getAttribute('data-q');
    if (q == null) return;
    onTecClick(s, Number(q), Number(e.target.getAttribute('data-r')));
  };
}

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
    if (canFlip && !c.faceUp) el.onclick = () => send({ type: 'flipCard', cardId: c.cardId });
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
        el.onclick = () => send({ type: 'reveal', cardIndex: i });
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
    if (s.targetCard) area.appendChild(labeledCard('Last secret player', s.targetCard, { pop: true }));
    else if (s.target) area.appendChild(callout(`Last secret player: <b>${escapeHtml(s.target)}</b>`));
    appendEndButtons(area, s);
    return;
  }

  if (s.phase === 'roundOver') {
    const wonName = s.roundWinner != null ? sgName(s, s.roundWinner) : null;
    area.appendChild(banner(wonName ? `Round ${s.roundNo}: ${wonName} guessed it!` : `Round ${s.roundNo}: nobody got it.`, s.roundWinner === s.seat ? 'win' : ''));
    if (s.targetCard) area.appendChild(labeledCard('The secret player', s.targetCard, { pop: true }));
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
    return;
  }
  // It's your turn — build the question menu + a guess box.
  renderWaMenu(area, s);
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
    const b = actBtn(label, 'wa-qbtn', () => send({ type: 'askQuestion', qtype, param }));
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

function renderGpActions(s) {
  const area = $('gpActions');
  area.innerHTML = '';
  const you = s.you || {};

  if (s.over) {
    const youWin = (s.winners || []).includes(s.seat);
    area.appendChild(banner((s.winners || []).length === 0 ? 'No winner this match.' : youWin ? '🏆 You win the match!' : 'Match over.', youWin ? 'win' : 'lose'));
    if (s.targetCard) area.appendChild(labeledCard('The player', s.targetCard, { pop: true }));
    else if (s.target) area.appendChild(callout(`The player was <b>${escapeHtml(s.target)}</b>.`));
    appendEndButtons(area, s);
    return;
  }
  if (s.phase === 'roundOver') {
    const who = s.roundWinner != null ? sgName(s, s.roundWinner) : null;
    area.appendChild(banner(who ? `Round ${s.roundNo}: ${who} won!` : `Round ${s.roundNo}: nobody got it.`, s.roundWinner === s.seat ? 'win' : ''));
    if (s.targetCard) area.appendChild(labeledCard('The player', s.targetCard, { pop: true }));
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
