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
    <text x="50" y="70" text-anchor="middle" font-size="64" font-weight="900">?</text>
  </g></svg>`,
};
const SUIT_LABEL = {
  rock: 'Rock',
  paper: 'Paper',
  scissor: 'Scissor',
  love: 'Love',
  liar: 'Liar',
};
const PHASE_LABEL = {
  waiting: 'Waiting for opponent',
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
    showScreen('game');
    connect(code, name);
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
      break;
    case 'full':
      hideOverlay();
      showScreen('gate');
      $('gateMsg').textContent = msg.message;
      break;
  }
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

function render() {
  if (!state) return;
  const s = state;
  $('roomCode').textContent = s.room;
  $('phaseChip').textContent = PHASE_LABEL[s.phase] || s.phase;
  $('copyLink2').onclick = copyInvite;

  // Names / chips / connection / avatars
  $('youName').textContent = s.you.name + (s.seat === mySeat ? ' (you)' : '');
  $('youAvatar').textContent = initial(s.you.name);
  animateNumber($('youChips'), s.you.chips);
  $('youConn').className = 'dot ' + (s.you.connected ? 'on' : '');
  if (s.opp) {
    $('oppName').textContent = s.opp.name;
    $('oppAvatar').textContent = initial(s.opp.name);
    animateNumber($('oppChips'), s.opp.chips);
    $('oppConn').className = 'dot ' + (s.opp.connected ? 'on' : '');
  } else {
    $('oppName').textContent = 'Waiting…';
    $('oppAvatar').textContent = '·';
    animateNumber($('oppChips'), 0);
    $('oppConn').className = 'dot';
  }

  animateNumber($('pot'), s.pot);
  $('carry').textContent = s.carry ? `+${s.carry} carried` : '';

  // Highlight the whole table when it's your move.
  document.body.classList.toggle('your-turn', !!(s.betting && s.betting.yourTurn));

  renderShared(s);
  renderOppCards(s);
  renderYourCards(s);
  renderTurnFlag(s);
  renderActions(s);
  renderLog(s);
}

// Card containers are only rebuilt (and re-animated) when their contents change,
// so chip/chat updates don't make every card flicker.
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

function renderOppCards(s) {
  const count = s.opp && s.opp.holeCount != null ? s.opp.holeCount : 0;
  const rev = s.opp && s.opp.revealedCard ? `${s.opp.revealIndex}:${s.opp.revealedCard.suit}` : '-';
  const sig = `${count}|${rev}`;
  if (sig === cardSig.opp) return;
  cardSig.opp = sig;

  const box = $('oppCards');
  box.innerHTML = '';
  for (let i = 0; i < count; i++) {
    // The opponent's one revealed card shows face-up; the rest stay face-down.
    if (s.opp.revealedCard && s.opp.revealIndex === i) box.appendChild(cardEl(s.opp.revealedCard));
    else box.appendChild(cardEl(null));
  }
}

function renderYourCards(s) {
  const hole = s.you.hole || [];
  const revealing = s.phase === 'reveal' && s.reveal && !s.reveal.youLocked;
  const sig = `${hole.map((c) => c.suit).join(',')}|${s.you.revealIndex}|${revealing}`;
  if (sig === cardSig.you) return;
  cardSig.you = sig;

  const box = $('yourCards');
  box.innerHTML = '';
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
// Contextual actions per phase
// ---------------------------------------------------------------------------

function renderActions(s) {
  const area = $('actionArea');
  area.innerHTML = '';

  if (s.matchWinner != null) {
    const win = s.matchWinner === s.seat;
    area.appendChild(banner(win ? '🏆 You win the match!' : 'You lost the match.', win ? 'win' : 'lose'));
    return;
  }

  if (s.phase === 'waiting') {
    const c = callout('Waiting for your opponent to join', true);
    const invite = actBtn('Copy invite link', 'btn btn-ghost btn-lg', copyInvite);
    area.appendChild(c);
    area.appendChild(invite);
    return;
  }

  if (s.phase === 'bet1' || s.phase === 'bet2') {
    renderBetting(area, s);
    return;
  }

  if (s.phase === 'reveal') {
    if (s.reveal.youLocked) {
      area.appendChild(callout(s.reveal.oppLocked ? 'Revealing' : 'Locked in — waiting for opponent', true));
    } else {
      area.appendChild(prompt('Pick one card to reveal <b>(not the liar)</b> — tap a card.'));
    }
    return;
  }

  if (s.phase === 'discuss') {
    area.appendChild(prompt('Discuss freely — <b>bluff or be honest</b>.'));
    const btn = actBtn(
      s.discuss.youReady ? 'Waiting for opponent…' : "I'm ready to bet",
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
      area.appendChild(callout('Waiting on opponent to resolve their liar', true));
    }
    if (s.result) area.appendChild(renderResult(s));
    return;
  }
}

function renderBetting(area, s) {
  const b = s.betting;
  if (!b.yourTurn) {
    area.appendChild(callout('Waiting for opponent to act', true));
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

  const picks = liar.suggestion.slice(); // prefilled with the best auto-pick
  liar.wildSlots.forEach((slot, idx) => {
    const seg = document.createElement('div');
    seg.className = 'seg';
    ['rock', 'paper', 'scissor', 'love'].forEach((suit) => {
      const b = document.createElement('button');
      b.className = 'suit-' + suit;
      b.innerHTML = SUIT_SVG[suit];
      b.title = SUIT_LABEL[suit];
      if (picks[idx] === suit) b.classList.add('sel');
      b.onclick = () => {
        picks[idx] = suit;
        [...seg.children].forEach((c) => c.classList.remove('sel'));
        b.classList.add('sel');
      };
      seg.appendChild(b);
    });
    box.appendChild(seg);
  });

  const row = document.createElement('div');
  row.className = 'btn-row';
  row.appendChild(actBtn('Use best hand', 'btn btn-neutral', () => send({ type: 'liar', auto: true })));
  row.appendChild(actBtn('Lock in', 'btn btn-gold', () => send({ type: 'liar', values: picks })));
  box.appendChild(row);
  return box;
}

function renderResult(s) {
  const r = s.result;
  const box = document.createElement('div');
  box.className = 'result';
  const h = document.createElement('h3');
  if (r.kind === 'draw') {
    h.textContent = '🤝 Draw — pot carries over';
    h.className = 'verdict-draw';
  } else if (r.winner === s.seat) {
    h.textContent = `🎉 You win ${r.potAwarded}`;
    h.className = 'verdict-win';
  } else {
    h.textContent = `${r.names[r.winner]} wins ${r.potAwarded}`;
    h.className = 'verdict-lose';
  }
  box.appendChild(h);

  if (r.hands) {
    const hands = document.createElement('div');
    hands.className = 'hands';
    [0, 1].forEach((seat) => {
      const col = document.createElement('div');
      col.className = 'hand';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = seat === s.seat ? 'You' : r.names[seat];
      const cards = document.createElement('div');
      cards.className = 'cards';
      r.hands[seat].forEach((suit) => cards.appendChild(cardEl({ suit }, { win: r.winner === seat })));
      const rn = document.createElement('div');
      rn.className = 'rankname';
      rn.textContent = rankName(r.ranks[seat]);
      col.append(who, cards, rn);
      hands.appendChild(col);
    });
    box.appendChild(hands);
  } else if (r.kind === 'fold') {
    box.appendChild(prompt(r.winner === s.seat ? 'Opponent folded.' : 'You folded.'));
  }

  box.appendChild(actBtn('Next round →', 'btn btn-primary btn-lg', () => send({ type: 'nextRound' })));
  return box;
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
  const div = document.createElement('div');
  div.className = 'msg' + (msg.seat === mySeat ? ' me' : '');
  const b = document.createElement('b');
  b.textContent = (msg.seat === mySeat ? 'You' : msg.name) + ': ';
  div.appendChild(b);
  div.appendChild(document.createTextNode(msg.text));
  log.appendChild(div);
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

init();
