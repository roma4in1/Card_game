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

let shownScreen = null;
function ensureScreen(id) {
  if (shownScreen !== id) {
    showScreen(id);
    shownScreen = id;
  }
}

function render() {
  if (!state) return;
  const s = state;
  if (s.phase === 'lobby') {
    ensureScreen('lobby');
    renderLobby(s);
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
  const list = $('lobbyList');
  list.innerHTML = '';
  s.roster.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'lobby-row';
    li.innerHTML =
      `<span class="avatar sm" style="background:${seatColor(p.seat)}">${initial(p.name)}</span>` +
      `<span class="lobby-name">${escapeHtml(p.name)}${p.seat === s.seat ? ' (you)' : ''}</span>` +
      (p.host ? '<span class="badge b-host">host</span>' : '') +
      `<i class="dot ${p.connected ? 'on' : ''}"></i>`;
    list.appendChild(li);
  });
  const start = $('startBtn');
  if (s.youAreHost) {
    start.style.display = '';
    start.disabled = s.roster.length < 2;
    start.textContent = s.roster.length < 2 ? 'Waiting for players…' : `Start game (${s.roster.length})`;
    start.onclick = () => send({ type: 'start' });
    $('lobbyMsg').textContent = s.roster.length < 2 ? 'Share the invite link to add players.' : '';
  } else {
    start.style.display = 'none';
    $('lobbyMsg').textContent = 'Waiting for the host to start…';
  }
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
  const sig =
    list
      .map((p) => {
        const turn = p.isYou ? !!(s.betting && s.betting.yourTurn) : !!p.isTurn;
        return `${p.seat}:${p.chips}:${p.committed || 0}:${p.folded}:${p.allIn}:${turn}:${s.dealer === p.seat}:${p.connected}:${p.isYou ? 'Y' : p.holeCount}:${p.revealedCard ? p.revealedCard.suit + p.revealIndex : '-'}`;
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
      `<span class="pseat-meta"><span class="pseat-name">${escapeHtml(p.name)}<i class="dot ${p.connected ? 'on' : ''}"></i></span>` +
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

    // Dealer button + bet chip sit on the felt, along the seat's angle toward the pot.
    if (s.dealer === p.seat) {
      const dpos = posAt(theta, SEAT_RX * 0.74, SEAT_RY * 0.72);
      const d = document.createElement('span');
      d.className = 'felt-dealer';
      d.textContent = 'D';
      d.style.left = `${dpos.left}%`;
      d.style.top = `${dpos.top}%`;
      box.appendChild(d);
    }
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
// Contextual actions per phase
// ---------------------------------------------------------------------------

function renderActions(s) {
  const area = $('actionArea');
  area.innerHTML = '';

  if (s.matchWinner != null) {
    const win = s.matchWinner === s.seat;
    area.appendChild(banner(win ? '🏆 You win the match!' : 'Match over.', win ? 'win' : 'lose'));
    const rm = s.rematch || { youReady: false };
    const btn = actBtn(
      rm.youReady ? 'Waiting for others…' : 'Rematch',
      'btn btn-primary btn-lg',
      () => send({ type: 'rematch' }),
    );
    btn.disabled = rm.youReady;
    area.appendChild(btn);
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
function maybeNotify(s) {
  if (!s.roundNo || s.roundNo === lastRoundNo) return;
  lastRoundNo = s.roundNo;
  if (s.phase === 'lobby' || s.phase === 'matchover') return;
  if (s.deckReshuffled) setTimeout(() => toast('🔄 Deck ran out — reshuffled a fresh deck', 'ok'), 1300);
  announceRound(s);
}

function nameForSeat(s, seat) {
  if (seat === s.seat) return 'You';
  const p = (s.roster || []).find((x) => x.seat === seat);
  return p ? p.name : `Seat ${seat + 1}`;
}

function announceRound(s) {
  clearInterval(roTimer);
  roTimeouts.forEach(clearTimeout);
  roTimeouts = [];

  const die = $('roDie');
  const dealerName = nameForSeat(s, s.dealer);
  const firstSeat = s.firstActor;
  $('roTitle').textContent = `Round ${s.roundNo}`;
  $('roSub').innerHTML = `<span class="dealer-chip">D</span>${escapeHtml(dealerName)} deals`;
  $('roFirst').textContent = '';
  die.classList.add('tumble');
  $('roundOverlay').classList.remove('hidden');

  roTimer = setInterval(() => setDie(die, 1 + Math.floor(Math.random() * 6)), 100);
  roTimeouts.push(
    setTimeout(() => {
      clearInterval(roTimer);
      die.classList.remove('tumble');
      setDie(die, 1 + Math.floor(Math.random() * 6));
      if (firstSeat == null || firstSeat < 0) {
        $('roFirst').textContent = 'All-in — straight to showdown';
      } else {
        const first = nameForSeat(s, firstSeat);
        $('roFirst').textContent = first === 'You' ? 'You act first' : `${first} acts first`;
      }
      roTimeouts.push(setTimeout(() => $('roundOverlay').classList.add('hidden'), 1400));
    }, 900),
  );
}

// Tap to skip the round-start splash (so a first-to-act player isn't blocked).
$('roundOverlay').addEventListener('click', () => {
  clearInterval(roTimer);
  roTimeouts.forEach(clearTimeout);
  roTimeouts = [];
  $('roundOverlay').classList.add('hidden');
});

init();
