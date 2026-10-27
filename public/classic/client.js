/* Prime Time Online — browser client */
(() => {
  const R = window.PTRules;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SEAT_COLORS = ['#f47b3b', '#2aa7e1', '#22a565', '#a34ce0', '#e0444c', '#d49a00'];

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const socket = io();
  let S = null;                 // latest server state
  let session = store.get('pt_session'); // {code, token, name}
  let selected = null;          // selected card id
  let lastSeq = 0;
  let seenGameNo = null;
  let tossShownFor = null;
  let overHiddenFor = null;
  let prevCurrent = null;
  let chatSeen = 0;
  let clockOffset = 0;
  let soundOn = store.get('pt_sound') !== false;
  const freshUntil = {};        // slot index -> timestamp
  const handSeen = new Set();   // card ids already shown in hand (for deal animation)

  /* ================= sound ================= */
  let actx = null;
  function tone(freqs, dur = 0.1, type = 'triangle', vol = 0.07) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = actx.currentTime;
      freqs.forEach((f, i) => {
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = type; o.frequency.value = f;
        const st = t0 + i * dur;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(vol, st + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, st + dur + 0.08);
        o.connect(g).connect(actx.destination);
        o.start(st); o.stop(st + dur + 0.1);
      });
    } catch {}
  }
  const sfx = {
    play: () => tone([523, 784], 0.07),
    draw: () => tone([392], 0.06, 'sine', 0.05),
    turn: () => tone([660, 880, 1175], 0.09),
    skip: () => tone([330, 220], 0.12, 'sawtooth', 0.035),
    magic: () => tone([784, 988, 1319, 1568], 0.06, 'sine', 0.06),
    win: () => tone([523, 659, 784, 1047], 0.14),
    lose: () => tone([392, 330, 262], 0.16, 'sine', 0.06),
    flip: () => tone([520], 0.04, 'square', 0.025),
    err: () => tone([180], 0.14, 'square', 0.035),
    nope: sadTrombone,
  };
  // "Wah-wah-wah-waaah": four falling notes, the last one long with a wobble.
  function sadTrombone() {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = actx.currentTime + 0.02;
      const o = actx.createOscillator();
      const filter = actx.createBiquadFilter();
      const g = actx.createGain();
      o.type = 'sawtooth';
      filter.type = 'lowpass'; filter.frequency.value = 1000;
      g.gain.setValueAtTime(0.0001, t0);
      o.connect(filter).connect(g).connect(actx.destination);
      let t = t0;
      for (const [f, d] of [[392, 0.3], [370, 0.3], [349, 0.3], [330, 1.0]]) {
        o.frequency.setValueAtTime(f, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.1, t + 0.04);
        g.gain.setValueAtTime(0.1, t + d - 0.08);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d - 0.01);
        t += d;
      }
      const lfo = actx.createOscillator();
      const depth = actx.createGain();
      lfo.frequency.value = 6; depth.gain.value = 10;
      lfo.connect(depth).connect(o.frequency);
      lfo.start(t - 1.0); lfo.stop(t);
      o.start(t0); o.stop(t + 0.05);
    } catch {}
  }

  /* ================= toasts ================= */
  function toast(msg, kind = '', ms = 2600) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = msg;
    $('#toasts').appendChild(el);
    while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
    setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 350); }, ms);
  }
  function confetti() {
    const colors = ['#f47b3b', '#2aa7e1', '#22a565', '#a34ce0', '#f2b01e', '#e0444c'];
    for (let i = 0; i < 90; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 2 + Math.random() * 2.5 + 's';
      c.style.animationDelay = Math.random() * 0.8 + 's';
      c.style.borderRadius = Math.random() < 0.5 ? '50%' : '2px';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 5500);
    }
  }

  /* ================= helpers ================= */
  function show(screen) {
    for (const s of ['loading', 'home', 'lobby', 'game']) $(`#screen-${s}`).hidden = s !== screen;
  }
  const colorOf = (id) => {
    const idx = S ? S.members.findIndex((m) => m.id === id) : 0;
    return SEAT_COLORS[(idx < 0 ? 0 : idx) % SEAT_COLORS.length];
  };
  const nameOf = (id) => {
    const g = S && S.game;
    const p = (g && g.players.find((x) => x.id === id)) || (S && S.members.find((x) => x.id === id));
    return p ? p.name : 'Someone';
  };
  const initial = (n) => esc((n || '?').trim().charAt(0).toUpperCase());
  const avatar = (id, name) => `<span class="avatar" style="background:${colorOf(id)}">${initial(name)}</span>`;
  const isHost = () => S && S.hostId === S.you;
  /*
   * Series standings: every player who scored, lowest total first. Equal totals share a rank.
   * winner = lowest total; loser = highest total (when it differs from the lowest).
   */
  function standings() {
    const ser = S.series;
    const rows = Object.keys(ser.totals).map((id) => {
      const m = S.members.find((x) => x.id === id);
      return { id, name: m ? m.name : `${ser.names[id] || 'Player'} (left)`, total: ser.totals[id], games: ser.history.map((h) => h.scores[id]) };
    }).sort((a, b) => a.total - b.total || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.rank = i > 0 && r.total === rows[i - 1].total ? rows[i - 1].rank : i + 1; });
    if (rows.length) {
      const min = rows[0].total, max = rows[rows.length - 1].total;
      rows.forEach((r) => { r.winner = r.total === min; r.loser = max !== min && r.total === max; });
    }
    return rows;
  }
  const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4]}`;
  // Hint mode (table setting): when off, nobody is shown which cards can or can't be played.
  const hints = () => !!(S && S.game && S.game.settings && S.game.settings.hints);
  const isBot = (id) => !!(S && S.members.some((m) => m.id === id && m.bot));
  const myTurn = () => S && S.game && S.game.phase === 'playing' && S.game.current === S.you;

  // Card faces are Logicology's card artwork: assets/cards/<n>.png, magic.png, skip.png, back.png
  // assetV is the server's artwork fingerprint; it busts the browser cache whenever an image file changes.
  let assetV = '';
  const withV = (url) => (assetV ? `${url}?v=${assetV}` : url);
  const cardSrc = (card) => withV(`/assets/cards/${card.type === 'num' ? card.n : card.type}.png`);
  const cardAlt = (card) => (card.type === 'num'
    ? `${card.n}${card.n === 1 ? ' (unique)' : R.isPrime(card.n) ? ' (prime)' : ' = ' + R.factorize(card.n).join(' × ')}`
    : card.type === 'magic' ? 'MAGIC card' : card.type === 'skip' ? 'SKIP card' : 'Card back');
  function cardHTML(card, { tag = 'div', cls = '', attrs = '' } = {}) {
    return `<${tag} class="card ${card.type} ${cls}" ${attrs}><img src="${cardSrc(card)}" alt="${esc(cardAlt(card))}" draggable="false"></${tag}>`;
  }
  const BACK = { type: 'back' };
  // Warm the cache so cards appear instantly when dealt or played.
  function useAssetVersion(v) {
    if (!v || v === assetV) return;
    assetV = v;
    $('#board-frame').style.backgroundImage = `url(${withV("/assets/board.webp")})`;
    for (const img of $$('#tray img.back')) img.src = cardSrc(BACK);
    for (const img of $$('#board .placed')) img.removeAttribute('src'); // re-set on next render
    for (let n = 1; n <= 60; n++) new Image().src = cardSrc({ type: 'num', n });
    for (const t of ['magic', 'skip', 'back']) new Image().src = cardSrc({ type: t });
  }

  function sortHand(hand) {
    const rank = (c) => (c.type === 'num' ? c.n : c.type === 'magic' ? 100 : 101);
    return hand.slice().sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }

  function checkCard(card) {
    const g = S.game;
    return R.checkCard(g.board, card, g.firstMove, g.order.length > 1);
  }
  const gameRunning = () => S && S.game && S.game.phase !== 'over';

  /* ================= home ================= */
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();
  const savedName = store.get('pt_name');
  if (savedName) $('#home-name').value = savedName;
  if (urlRoom) {
    $('#home-code').value = urlRoom;
    $('#btn-join').classList.replace('secondary', 'primary');
    $('#btn-create').classList.replace('primary', 'ghost');
  }

  function getName() {
    const n = $('#home-name').value.trim();
    if (!n) { $('#home-error').textContent = 'Please enter your name first.'; $('#home-name').focus(); return null; }
    store.set('pt_name', n);
    return n;
  }
  function onJoined(res, name) {
    if (res.error) {
      $('#home-error').textContent = res.error;
      sfx.err();
      if (res.badName) { store.del('pt_name'); $('#home-name').select(); }
      return false;
    }
    session = { code: res.code, token: res.token, name };
    store.set('pt_session', session);
    history.replaceState(null, '', `?room=${res.code}`);
    return true;
  }
  $('#btn-create').onclick = () => {
    const name = getName(); if (!name) return;
    socket.emit('create', { name }, (res) => onJoined(res, name));
  };
  // Practice: create a private table with one computer player already seated.
  $('#btn-vs-bot').onclick = () => {
    const name = getName(); if (!name) return;
    socket.emit('create', { name }, (res) => {
      if (onJoined(res, name)) socket.emit('addBot', {}, ack);
    });
  };
  $('#btn-join').onclick = () => {
    const name = getName(); if (!name) return;
    const code = $('#home-code').value.trim().toUpperCase();
    if (code.length < 4) { $('#home-error').textContent = 'Enter the 5-letter game code.'; return; }
    const token = session && session.code === code ? session.token : undefined;
    socket.emit('join', { code, name, token }, (res) => onJoined(res, name));
  };
  $('#home-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#home-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') (urlRoom ? $('#btn-join') : $('#btn-create')).click(); });

  function goHome(msg, { keepSaved = false } = {}) {
    S = null; session = null;
    if (!keepSaved) store.del('pt_session'); // the saved seat is shared with other tabs
    history.replaceState(null, '', location.pathname);
    for (const o of $$('.overlay')) o.hidden = true;
    show('home');
    if (msg) $('#home-error').textContent = msg;
  }

  const willRejoin = () => session && session.token && (!urlRoom || urlRoom === session.code);
  if (willRejoin()) {
    show('loading');
    setTimeout(() => { if (!S && !$('#screen-loading').hidden) { show('home'); $('#home-error').textContent = 'Could not reconnect to the server. Check your connection and try again.'; } }, 8000);
  }
  socket.on('connect', () => {
    if (willRejoin()) {
      socket.emit('join', { code: session.code, token: session.token, name: session.name }, (res) => {
        if (res.error) goHome(res.error === 'No game found with that code.' ? 'That game has ended.' : res.error);
      });
    }
  });
  socket.on('disconnect', () => { if (S) toast('Connection lost — reconnecting…', 'warn', 4000); });
  // When the same seat is opened in another tab, that tab now owns the saved seat: don't erase it.
  socket.on('kicked', ({ reason, otherTab }) => goHome(reason, { keepSaved: !!otherTab }));

  /* ================= lobby ================= */
  $('#btn-copy').onclick = async () => {
    const link = $('#lobby-link').value;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied!', 'good'); }
    catch { $('#lobby-link').select(); document.execCommand('copy'); toast('Invite link copied!', 'good'); }
  };
  $('#set-hints').onchange = (e) => socket.emit('settings', { hints: e.target.checked }, ack);
  $('#set-series').onchange = (e) => {
    const n = Math.min(9, Math.max(1, Math.round(Number(e.target.value) || 1)));
    e.target.value = n;
    socket.emit('settings', { seriesGames: n }, ack);
  };
  $('#set-skips').onchange = (e) => socket.emit('settings', { skips: Number(e.target.value) }, ack);
  $('#set-timer').onchange = (e) => socket.emit('settings', { turnTimer: Number(e.target.value) }, ack);
  $('#btn-start').onclick = () => socket.emit('start', {}, (res) => { if (res && res.error) $('#lobby-error').textContent = res.error; });
  function leave() {
    if (!confirm('Leave this game? Your cards will be shuffled back into the tray.')) return;
    socket.emit('leave', {}, () => goHome());
  }
  $('#btn-leave-lobby').onclick = leave;
  $('#btn-leave-game').onclick = () => {
    if (gameRunning()) { toast('You can’t leave in the middle of a game.', 'warn'); return; }
    leave();
  };
  $('#seat-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const name = nameOf(b.dataset.remove);
    if (confirm(`${name} has dropped out. Remove them? Their unplayed cards go back into the tray.`)) socket.emit('kick', { id: b.dataset.remove }, ack);
  });

  function ack(res) { if (res && res.error) { toast(esc(res.error), 'err'); sfx.err(); } }

  function renderLobby() {
    show('lobby');
    $('#lobby-code').textContent = S.code;
    $('#lobby-link').value = `${location.origin}${location.pathname}?room=${S.code}`;
    $('#lobby-count').textContent = `${S.members.length} / 6`;
    const rows = S.members.map((m) => `
      <li class="${m.connected ? '' : 'off'}">${avatar(m.id, m.name)}
        <span>${esc(m.name)}</span>
        ${m.bot ? '<span class="tag-bot" title="Computer player">🤖 bot</span>' : ''}
        ${m.id === S.you ? '<span class="tag-you">you</span>' : ''}
        ${m.isHost ? '<span class="crown" title="Host">👑</span>' : ''}
        ${m.connected ? '' : '<span class="badge-off">offline</span>'}
        ${isHost() && m.id !== S.you ? `<button class="kick" data-kick="${m.id}" title="Remove">×</button>` : ''}
      </li>`);
    for (let i = S.members.length; i < 6; i++) {
      rows.push(`<li class="empty">${i < 2 ? 'Waiting for a player…' : 'Open seat'}
        ${isHost() && i === S.members.length ? '<button class="btn ghost sm add-bot" data-add-bot>🤖 Add a bot</button>' : ''}</li>`);
    }
    $('#lobby-players').innerHTML = rows.join('');
    $('#set-timer').value = String(S.settings.turnTimer);
    const serEl = $('#set-series');
    if (document.activeElement !== serEl) serEl.value = String(S.settings.seriesGames);
    serEl.disabled = !isHost() || S.series.running;
    serEl.title = S.series.running ? 'Fixed until this series ends' : '';
    $('#set-skips').value = String(S.settings.skips);
    $('#set-skips').disabled = !isHost();
    $('#set-hints').checked = !!S.settings.hints;
    $('#set-timer').disabled = $('#set-hints').disabled = !isHost();
    $('#settings-note').textContent = isHost() ? '' : 'Only the host can change the settings.';
    const canStart = isHost() && S.members.length >= 2;
    $('#btn-start').hidden = !isHost();
    $('#btn-start').disabled = !canStart;
    $('#btn-start').textContent = S.series.running ? `Start game ${S.series.games + 1} of ${S.series.target}`
      : S.settings.seriesGames > 1 ? `Start series (${S.settings.seriesGames} games)` : 'Start game';
    $('#lobby-wait').textContent = !isHost()
      ? `Waiting for ${esc(nameOf(S.hostId))} (host) to start…`
      : S.members.length < 2 ? 'Invite a friend, or add a bot to play against the computer.' : '';
    if (S.series.games) {
      const head = S.series.running ? `Series: ${S.series.games} of ${S.series.target} games played`
        : S.series.target > 1 ? `Series finished (${S.series.target} games)` : 'Last game';
      $('#lobby-series').innerHTML = `<b>${head}</b> (lowest total wins)
        <table>${standings().map((r) => `<tr><td>${ordinal(r.rank)} · ${esc(r.name)}${S.series.done && r.winner ? ' 🏆' : ''}</td><td>${r.total}</td></tr>`).join('')}</table>
        ${S.series.running ? '<p class="small">The players are fixed until the series ends.</p>' : ''}
        ${isHost() ? `<button class="link" id="btn-reset-series">${S.series.running ? 'Abandon this series' : 'Clear scores'}</button>` : ''}`;
      const rb = $('#btn-reset-series');
      if (rb) rb.onclick = () => confirm(S.series.running ? 'Abandon this series? All its scores will be cleared.' : 'Clear the scores?') && socket.emit('resetSeries', {}, ack);
    } else $('#lobby-series').innerHTML = '';
  }
  $('#lobby-players').addEventListener('click', (e) => {
    if (e.target.closest('[data-add-bot]')) { socket.emit('addBot', {}, ack); return; }
    const b = e.target.closest('[data-kick]');
    if (b && confirm(`Remove ${nameOf(b.dataset.kick)} from the table?`)) socket.emit('kick', { id: b.dataset.kick }, ack);
  });

  /* ================= board ================= */
  // Slot geometry measured from assets/board.webp (2000×1611): tiles are 153×175 px,
  // first tile at (136,127), column pitch 175 px, row pitch 196.67 px, 10 per row.
  const BOARD_W = 2000, BOARD_H = 1611;
  const TILE = { x0: 136, y0: 127, w: 153, h: 175, dx: 175, dy: 196.67 };
  function buildBoard() {
    const board = $('#board');
    if (board.dataset.built) return;
    board.dataset.built = '1';
    board.innerHTML = R.buildSlots().map((s) => {
      const r = Math.floor(s.i / 10), c = s.i % 10;
      const style = [
        `left:${((TILE.x0 + c * TILE.dx) / BOARD_W) * 100}%`,
        `top:${((TILE.y0 + r * TILE.dy) / BOARD_H) * 100}%`,
        `width:${(TILE.w / BOARD_W) * 100}%`,
        `height:${(TILE.h / BOARD_H) * 100}%`,
      ].join(';');
      return `<div class="slot" data-i="${s.i}" style="${style}"><img class="placed" alt="" draggable="false" hidden><span class="asnum" hidden></span><span class="mbadge" hidden></span><span class="lastmark" hidden></span></div>`;
    }).join('');
  }

  function selectionPlan() {
    // Returns { targets:Set, support:Set, missing:Set } for board highlighting.
    const out = { targets: new Set(), support: new Set(), missing: new Set() };
    const g = S.game;
    if (!selected || !g || g.phase !== 'playing') return out;
    const card = g.hand.find((c) => c.id === selected);
    if (!card) return out;
    const mine = myTurn();
    if (card.type === 'magic') {
      if (mine && !g.firstMove) R.magicTargets(g.board).forEach((i) => out.targets.add(i));
      return out;
    }
    if (card.type !== 'num' || !hints()) return out;
    const chk = R.checkNumber(g.board, card.n, g.firstMove);
    if (chk.ok && mine && chk.slot) out.targets.add(chk.slot.i);
    if (card.n > 1 && !R.isPrime(card.n) && chk.slot) {
      const need = {};
      for (const p of chk.factors) need[p] = (need[p] || 0) + 1;
      const have = R.primeCounts(g.board);
      for (const [p, k] of Object.entries(need)) {
        // highlight occupied slots until k copies are covered (a slot with stacked Magics counts more than once)
        let covered = 0;
        for (const s of g.board.filter((x) => x.n === Number(p) && x.card)) {
          if (covered >= k) break;
          out.support.add(s.i);
          covered += 1 + (s.extra ? s.extra.length : 0);
        }
        const short = Math.max(0, k - (have[p] || 0));
        g.board.filter((s) => s.n === Number(p) && !s.card).slice(0, short).forEach((s) => out.missing.add(s.i));
      }
    }
    return out;
  }

  function renderBoard() {
    buildBoard();
    const g = S.game;
    const plan = selectionPlan();
    const now = Date.now();
    // slot -> players whose latest board card is there (oldest first); and the newest play overall
    const lastBySlot = new Map();
    let latestSlot = -1, latestTurn = -1;
    for (const [id, lp] of Object.entries(g.lastPlay || {}).sort((a, b) => a[1].turn - b[1].turn)) {
      if (!lastBySlot.has(lp.slot)) lastBySlot.set(lp.slot, []);
      lastBySlot.get(lp.slot).push({ id, turn: lp.turn });
      if (lp.turn > latestTurn) { latestTurn = lp.turn; latestSlot = lp.slot; }
    }
    for (const el of $$('#board .slot[data-i]')) {
      const i = Number(el.dataset.i);
      const s = g.board[i];
      const cls = ['slot'];
      if (s.card) cls.push('filled');
      if (s.card && s.card.type === 'magic') cls.push('magic');
      if (plan.targets.has(i)) cls.push('target');
      if (plan.support.has(i)) cls.push('support');
      if (plan.missing.has(i)) cls.push('missing');
      if (freshUntil[i] > now) cls.push('fresh');
      if (lastBySlot.has(i)) cls.push('last');
      if (i === latestSlot) cls.push('latest');
      const c = cls.join(' ');
      if (el.className !== c) el.className = c;
      const img = $('.placed', el);
      if (s.card) {
        const src = cardSrc(s.card.type === 'magic' ? { type: 'magic' } : { type: 'num', n: s.card.n });
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
        img.hidden = false;
      } else img.hidden = true;
      const asnum = $('.asnum', el);
      const standing = s.card && s.card.type === 'magic';
      asnum.hidden = !standing;
      if (standing) asnum.textContent = `= ${s.n}`;
      // purple badge: ✦ = a MAGIC card lies under the real card; +k✦ = k Magics stacked on top (each one more copy)
      const extra = s.extra ? s.extra.length : 0;
      const badge = $('.mbadge', el);
      const btxt = extra ? `+${extra}✦` : s.under ? '✦' : '';
      badge.hidden = !btxt;
      if (badge.textContent !== btxt) badge.textContent = btxt;
      // Latest card of each player: a frame in that player's colour plus their initial.
      const lm = $('.lastmark', el);
      const marks = lastBySlot.get(i);
      if (marks) {
        const newest = marks[marks.length - 1];
        el.style.setProperty('--pc', colorOf(newest.id));
        const html = marks.map((m) => `<i style="background:${colorOf(m.id)}">${initial(nameOf(m.id))}</i>`).join('');
        if (lm.innerHTML !== html) lm.innerHTML = html;
        lm.hidden = false;
        lm.title = marks.map((m) => `${m.id === S.you ? 'Your' : nameOf(m.id) + "'s"} latest card`).join(', ');
      } else if (!lm.hidden) { lm.hidden = true; lm.innerHTML = ''; }
      const who = s.card && s.card.by ? ` — played by ${nameOf(s.card.by)}` : '';
      const notes = [];
      if (s.card && s.card.type === 'magic') notes.push('MAGIC card standing in');
      if (s.under) notes.push('real card on top of a MAGIC card');
      if (extra) notes.push(`${extra} MAGIC card${extra > 1 ? 's' : ''} on top — counts as ${1 + extra} × ${s.n}`);
      el.title = `${cardAlt({ type: 'num', n: s.n })}${notes.length ? ' (' + notes.join('; ') + ')' : ''}${who}`;
    }
  }

  /* Board zoom: clicking the board opens it large; clicking again (or Esc / ×) closes it.
   * The same board element is moved into the zoom layer, so cards can still be placed while zoomed. */
  let zoomed = false;
  function setZoom(on) {
    if (zoomed === on) return;
    zoomed = on;
    const frame = $('#board-frame');
    if (on) $('#board-zoom').appendChild(frame);
    else $('.board-area').appendChild(frame);
    $('#board-zoom').hidden = !on;
    frame.title = on ? 'Click to close the zoom' : 'Click the board to zoom';
  }
  $('#btn-zoom-close').onclick = () => setZoom(false);
  $('#board-zoom').addEventListener('click', (e) => { if (e.target.id === 'board-zoom') setZoom(false); });

  $('#board-frame').addEventListener('click', (e) => {
    const el = e.target.closest('.slot');
    const card = el && selected && S.game && S.game.hand.find((c) => c.id === selected);
    if (card) {
      const i = Number(el.dataset.i);
      if (el.classList.contains('target')) { playCard(card, { slot: i }); setZoom(false); return; }
      // MAGIC tapped onto a filled prime slot while empty ones remain: explain the rule.
      if (card.type === 'magic' && myTurn() && !S.game.firstMove && R.isPrime(S.game.board[i].n)) {
        notPlayable(card, R.MAGIC_NEEDS_VACANT);
        return;
      }
    }
    setZoom(!zoomed);
  });

  /* ================= actions ================= */
  function playCard(card, extra = {}) {
    if (!myTurn()) return;
    const chk = checkCard(card);
    if (!chk.ok) return notPlayable(card, chk.reason);
    if (card.type === 'skip' && !extra.target) return openSkip(card);
    if (card.type === 'magic' && extra.slot == null) { toast('Tap a glowing prime slot on the board for your Magic card.', 'warn'); return; }
    socket.emit('play', { cardId: card.id, ...extra }, (res) => {
      if (res && res.error) { toast(esc(res.error), 'err'); sfx.err(); }
      else { selected = null; render(); }
    });
  }
  function openSkip(card) {
    const others = S.game.order.filter((id) => id !== S.you).map((id) => S.game.players.find((p) => p.id === id)).filter(Boolean);
    $('#skip-targets').innerHTML = others.map((p) => `
      <button data-target="${p.id}">${avatar(p.id, p.name)} ${esc(p.name)}
        <span class="sub">${p.count} card${p.count === 1 ? '' : 's'}${p.skips ? ` · already skipped ×${p.skips}` : ''}</span></button>`).join('');
    $('#skip-overlay').hidden = false;
    $('#skip-targets').onclick = (e) => {
      const b = e.target.closest('[data-target]');
      if (!b) return;
      $('#skip-overlay').hidden = true;
      playCard(card, { target: b.dataset.target });
    };
  }
  $('#btn-skip-cancel').onclick = () => { $('#skip-overlay').hidden = true; };

  // Pop-up shown when a player tries a card (or a pass) the rules don't allow.
  function notPlayable(card, message) {
    sfx.nope();
    $('#nope-card').innerHTML = card ? cardHTML(card) : '';
    $('#nope-msg').textContent = message;
    $('#nope-overlay').hidden = false;
    $('#btn-nope-ok').focus();
  }
  const closeNope = () => { $('#nope-overlay').hidden = true; };
  $('#btn-nope-ok').onclick = closeNope;
  $('#nope-overlay').addEventListener('click', (e) => { if (e.target.id === 'nope-overlay') closeNope(); });

  $('#hand').addEventListener('click', (e) => {
    if (suppressClick) return;
    const el = e.target.closest('.card[data-id]');
    if (!el) return;
    const id = el.dataset.id;
    const card = S.game.hand.find((c) => c.id === id);
    if (!card) return;
    if (selected === id && myTurn() && card.type !== 'magic' && (checkCard(card).ok || !hints())) { playCard(card); return; }
    selected = selected === id ? null : id;
    if (selected && myTurn() && card.type === 'skip' && checkCard(card).ok) { openSkip(card); }
    render();
  });
  $('#btn-play').onclick = () => {
    const card = S.game.hand.find((c) => c.id === selected);
    if (card) playCard(card);
  };
  $('#btn-pass').onclick = () => {
    if (S.game && S.game.phase === 'over') { overHiddenFor = null; render(); return; }
    socket.emit('pass', {}, (res) => {
      if (res && res.error) notPlayable(null, res.error);
      else { selected = null; }
    });
  };
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape' && zoomed) { setZoom(false); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selected && S && S.game) {
      e.preventDefault();
      nudgeSelected(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (e.key === 'Escape') { selected = null; $('#skip-overlay').hidden = true; $('#rules-overlay').hidden = true; closeNope(); if (S && S.game) render(); }
  });

  /* ================= game render ================= */
  function renderPlayers() {
    const g = S.game;
    const ids = g.order.length ? g.order : g.players.map((p) => p.id);
    const conn = Object.fromEntries(S.members.map((m) => [m.id, m.connected]));
    const list = ids.map((id) => g.players.find((p) => p.id === id)).filter(Boolean);
    $('#seat-list').innerHTML = list.map((p, k) => {
      const turn = g.current === p.id;
      const off = conn[p.id] === false;
      const total = S.series.totals[p.id];
      return `<li class="seat ${turn ? 'turn' : ''} ${off ? 'off' : ''}">
        <span class="arrow">${turn ? '▶' : ''}</span>${avatar(p.id, p.name)}
        <div class="who"><div class="nm">${esc(p.name)} ${isBot(p.id) ? '<span class="tag-bot" title="Computer player">🤖</span>' : ''} ${p.id === S.you ? '<span class="tag-you">you</span>' : ''} ${p.id === S.hostId ? '<span class="crown" title="Host">👑</span>' : ''}</div>
          <div class="sub">${k === 0 && g.order.length ? 'P1 · ' : ''}${S.series.games ? `series ${total || 0}` : `seat ${k + 1}`}
          ${g.lastAction && g.lastAction[p.id] ? `<span class="last-act" title="Latest move">· ${esc(g.lastAction[p.id])}</span>` : ''}
          ${p.skips ? `<span class="badge-skip">skips next${p.skips > 1 ? ' ×' + p.skips : ''}</span>` : ''}
          ${off ? '<span class="badge-off">offline</span>' : ''}
          ${off && isHost() && gameRunning() ? `<button class="link tiny" data-remove="${p.id}">remove</button>` : ''}</div></div>
        <div class="cnt" title="${p.count} cards in hand"><span class="mb"></span>${p.count}</div></li>`;
    }).join('');
    $('#players-strip').innerHTML = list.map((p) => `
      <div class="chip ${g.current === p.id ? 'turn' : ''} ${conn[p.id] === false ? 'off' : ''}">${avatar(p.id, p.name)}
        ${esc(p.id === S.you ? 'You' : p.name)}${isBot(p.id) ? ' 🤖' : ''} <span class="n">${p.count}</span>${p.skips ? ' <span class="badge-skip">⏭</span>' : ''}</div>`).join('');
  }

  function timerLeft() {
    const g = S.game;
    if (!S.settings.turnTimer || g.phase !== 'playing' || !g.turnStartedAt) return null;
    const ms = S.settings.turnTimer * 1000 - (Date.now() + clockOffset - g.turnStartedAt);
    return Math.max(0, Math.ceil(ms / 1000));
  }

  function renderBanner() {
    const g = S.game;
    const b = $('#turn-banner');
    b.classList.toggle('mine', myTurn());
    const t = timerLeft();
    const tt = t != null ? ` · ${t}s` : '';
    if (g.phase === 'toss') b.textContent = 'Tossing for first turn…';
    else if (g.phase === 'over') b.textContent = 'Game over';
    else if (myTurn()) b.textContent = `Your turn!${tt}`;
    else b.textContent = `${nameOf(g.current)}'s turn${tt}`;
  }

  function renderPiles() {
    const g = S.game;
    $('#tray-count').textContent = g.trayCount;
    $('#tray').classList.toggle('empty', g.trayCount === 0);
  }

  /*
   * The hand is shown in the order the cards arrived (new cards on the right; when a card is played
   * the ones to its right close the gap). Players can drag cards into any order. There are always
   * 8 slots; a 9th, 10th… appear only when a player holds that many cards.
   */
  const HAND_SLOTS = 8;
  let localOrder = null; // an order the player just chose, shown until the server confirms it
  function orderedHand() {
    const hand = S.game.hand;
    if (!localOrder) return hand;
    const byId = new Map(hand.map((c) => [c.id, c]));
    const out = localOrder.filter((id) => byId.has(id)).map((id) => byId.get(id));
    for (const c of hand) if (!localOrder.includes(c.id)) out.push(c); // e.g. a card drawn meanwhile
    return out;
  }

  function renderHand() {
    if (drag) { handDirty = true; return; } // never pull the cards out from under a drag
    const g = S.game;
    const hand = orderedHand();
    if (selected && !hand.some((c) => c.id === selected)) selected = null;
    const inGame = g.players.some((p) => p.id === S.you);
    if (!hand.length) {
      $('#hand').innerHTML = `<div class="empty-hand">${inGame ? (g.phase === 'over' ? 'No cards left!' : 'Dealing…') : 'You are watching this game. You can join the next one.'}</div>`;
      return;
    }
    const empties = Array.from({ length: Math.max(0, HAND_SLOTS - hand.length) }, () => '<div class="hand-slot" aria-hidden="true"></div>');
    $('#hand').innerHTML = hand.map((c) => {
      const chk = checkCard(c);
      const cls = hints() ? [chk.ok ? 'playable' : 'blocked'] : [];
      if (c.id === selected) cls.push('selected');
      if (c.id === g.lastDrawn && g.phase === 'playing') cls.push('new');
      if (!handSeen.has(c.id)) cls.push('enter');
      const title = c.type === 'num' ? (hints() ? (chk.ok ? `${c.n} can be played` : chk.reason) : cardAlt(c))
        : c.type === 'magic' ? 'MAGIC: counts as any prime you choose' : 'SKIP: make a player miss their next turn';
      return cardHTML(c, { tag: 'button', cls: cls.join(' '), attrs: `data-id="${c.id}" title="${esc(title)}"` });
    }).join('') + empties.join('');
    hand.forEach((c) => handSeen.add(c.id));
  }

  function sendOrder(ids) {
    if (ids.join() === S.game.hand.map((c) => c.id).join()) { localOrder = null; return; }
    localOrder = ids;
    socket.emit('reorder', { ids }, (res) => {
      if (res && res.error) toast(esc(res.error), 'err');
      localOrder = null; // the server's state now carries the order
      render();
    });
  }

  /* ---------- drag to rearrange (mouse: just drag; touch: press and hold, then drag) ---------- */
  let drag = null;       // active drag
  let pending = null;    // pointer is down on a card, drag not started yet
  let handDirty = false; // a render was skipped during the drag
  let suppressClick = false;

  function cancelPending() {
    if (pending && pending.timer) clearTimeout(pending.timer);
    pending = null;
  }
  function beginDrag(x, y) {
    const src = $(`#hand .card[data-id="${pending.id}"]`);
    const touch = pending.touch;
    cancelPending();
    if (!src) return;
    const r = src.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.classList.remove('enter', 'selected');
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${r.width}px`;
    document.body.appendChild(ghost);
    src.classList.add('drag-source');
    drag = { src, ghost, dx: x - r.left, dy: y - r.top };
    if (touch && navigator.vibrate) navigator.vibrate(15);
    moveDrag(x, y);
  }
  function moveDrag(x, y) {
    const { src, ghost, dx, dy } = drag;
    ghost.style.left = `${x - dx}px`;
    ghost.style.top = `${y - dy}px`;
    const hand = $('#hand');
    // insert the dragged card before the first card whose centre is to the right of the pointer
    const others = $$('#hand .card[data-id]').filter((el) => el !== src);
    const before = others.find((el) => { const r = el.getBoundingClientRect(); return x < r.left + r.width / 2; });
    const anchor = before || $('#hand .hand-slot') || null;
    if (src.nextElementSibling !== anchor || (!anchor && hand.lastElementChild !== src)) hand.insertBefore(src, anchor);
    // scroll the hand when dragging near its edges (phones)
    const hr = hand.getBoundingClientRect();
    if (x < hr.left + 30) hand.scrollLeft -= 10;
    else if (x > hr.right - 30) hand.scrollLeft += 10;
  }
  function endDrag() {
    if (!drag) { cancelPending(); return; }
    const ids = $$('#hand .card[data-id]').map((el) => el.dataset.id);
    drag.ghost.remove();
    drag.src.classList.remove('drag-source');
    drag = null;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    sendOrder(ids);
    handDirty = false;
    render();
  }
  $('#hand').addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.card[data-id]');
    if (!el || e.button > 0 || drag) return;
    cancelPending();
    pending = { id: el.dataset.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: e.pointerType === 'touch', timer: null };
    if (pending.touch) pending.timer = setTimeout(() => { if (pending) beginDrag(pending.x, pending.y); }, 350);
  });
  window.addEventListener('pointermove', (e) => {
    if (drag) { e.preventDefault(); moveDrag(e.clientX, e.clientY); return; }
    if (!pending || e.pointerId !== pending.pointerId) return;
    const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (pending.touch) { if (dist > 10) cancelPending(); return; } // finger moved first: it's a scroll
    if (dist > 6) beginDrag(e.clientX, e.clientY);
  }, { passive: false });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  // once a touch drag has started, stop the page/hand from scrolling instead
  $('#hand').addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  $('#hand').addEventListener('contextmenu', (e) => { if (e.target.closest('.card')) e.preventDefault(); });

  // Keyboard: with a card selected, ← / → move it along the hand.
  function nudgeSelected(delta) {
    const ids = orderedHand().map((c) => c.id);
    const i = ids.indexOf(selected);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    sendOrder(ids);
    render();
  }

  function renderDock() {
    const g = S.game;
    const mine = myTurn();
    $('#dock').classList.toggle('myturn', mine);
    const card = selected && g.hand.find((c) => c.id === selected);
    const playBtn = $('#btn-play');
    const passBtn = $('#btn-pass');
    let msg = '';
    playBtn.hidden = true;

    if (g.phase === 'over') {
      msg = '<b>Game over.</b> Look over the final board.';
      passBtn.textContent = 'Show results';
      passBtn.disabled = false;
      passBtn.hidden = overHiddenFor !== S.gameNo;
      $('#status').innerHTML = msg;
      return;
    }
    passBtn.hidden = false;
    passBtn.textContent = g.trayCount ? 'Pass & draw' : 'Pass';
    const canPlay = g.hand.some((c) => checkCard(c).ok);
    // Without hints the Pass button must not give away whether a card fits: the server checks instead.
    const passBlocked = g.firstMove || (hints() && canPlay);
    passBtn.disabled = !mine || passBlocked;
    const emphasise = hints() && mine && !passBlocked;
    passBtn.classList.toggle('primary', emphasise);
    passBtn.classList.toggle('secondary', !emphasise);
    passBtn.title = g.firstMove ? 'You must place the 1 card first' : passBlocked ? 'You have a playable card — you must play it' : '';

    if (card) {
      const chk = checkCard(card);
      if (card.type === 'num' && !hints()) {
        const n = card.n;
        msg = n === 1 ? '<b>1</b> is the <b>UNIQUE</b> card — it starts the game.'
          : R.isPrime(n) ? `<b>${n}</b> is a <b>prime</b> number.`
          : `<b>${n} = ${chk.factors.join(' × ')}</b>`;
        if (mine) { playBtn.hidden = false; playBtn.textContent = `Play ${n}`; }
      } else if (card.type === 'num') {
        const n = card.n;
        if (n === 1) msg = `<b>1</b> is the <b>UNIQUE</b> card — it starts the game.`;
        else if (R.isPrime(n)) msg = !chk.ok ? `<b>${n}</b> is prime, but <span class="no">${esc(chk.reason)}</span>`
          : chk.slot && chk.slot.card ? `<b>${n}</b> is <b>prime</b> — it goes <span class="ok">on top of the MAGIC card</span> standing in for ${n}.`
          : `<b>${n}</b> is <b>prime</b> — primes can always be played. <span class="ok">Ready!</span>`;
        else msg = chk.ok
          ? `<b>${n} = ${chk.factors.join(' × ')}</b> — <span class="ok">all its factors are on the board!</span>`
          : chk.missing.length ? `<b>${n} = ${chk.factors.join(' × ')}</b> — <span class="no">still needs ${chk.missing.join(', ')} on the board</span>` : `<span class="no">${esc(chk.reason)}</span>`;
        if (mine && chk.ok) { playBtn.hidden = false; playBtn.textContent = `Play ${n}`; }
      } else if (card.type === 'magic') {
        const allFilled = !g.board.some((s) => R.isPrime(s.n) && !s.card);
        msg = !chk.ok ? `<span class="no">${esc(chk.reason)}</span>`
          : !mine ? '<b>MAGIC</b> counts as any prime you choose. It goes on an empty prime slot; only when every prime slot is filled can it go on top of a card.'
          : allFilled ? '<b>MAGIC</b> — every prime slot is filled, so tap any <span class="ok">glowing prime</span> to put it on top. It counts as <b>one more</b> of that prime.'
          : '<b>MAGIC</b> — tap a <span class="ok">glowing empty prime slot</span>. It will stand in for that prime.';
      } else {
        msg = mine && chk.ok ? '<b>SKIP</b> — choose a player to miss their next turn (they still draw a card).' : '<b>SKIP</b> makes another player miss their next turn — they still draw a card.';
        if (mine && (chk.ok || !hints())) { playBtn.hidden = false; playBtn.textContent = 'Choose player…'; }
      }
      if (!mine) msg += ` <span class="muted">(wait for your turn)</span>`;
    } else if (g.phase === 'toss') {
      msg = 'Tossing to see who goes first…';
    } else if (mine) {
      if (g.firstMove) msg = '<b>You won the toss!</b> Tap your <b>1</b> card to start the game.';
      else {
        const draw = g.trayCount ? 'You\'ll then draw a card from the tray.' : '<b>The tray is empty</b> — get rid of all your cards to win!';
        const pass = `<b>${g.trayCount ? 'Pass &amp; draw' : 'Pass'}</b>`;
        msg = !hints()
          ? `<b>Your turn!</b> Tap a card and <b>Play</b> it. If none of your cards can be played, tap ${pass}. ${draw}`
          : canPlay
            ? `<b>Your turn!</b> You must play one of your ✓ cards. ${draw}`
            : `<b>Your turn!</b> None of your cards can be played — tap ${pass}.${g.trayCount ? '' : ' ' + draw}`;
      }
    } else {
      msg = `Waiting for <b>${esc(nameOf(g.current))}</b>… Tap your cards to see their factors.`;
    }
    $('#status').innerHTML = msg;
  }

  function renderLog() {
    const g = S.game;
    const el = $('#log');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = g.log.map((l) => `<li class="${l.kind}">${esc(l.text)}</li>`).join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function renderChat() {
    const el = $('#chat-list');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = S.chat.map((m) => `<li><b>${esc(m.name)}:</b> ${esc(m.text)}</li>`).join('') || '<li class="muted">No messages yet. Say hi!</li>';
    if (atBottom) el.scrollTop = el.scrollHeight;
    const chatOpen = !$('.chat').hidden;
    const last = S.chat.length ? S.chat[S.chat.length - 1].t : 0;
    if (chatOpen) chatSeen = last;
    const unread = S.chat.filter((m) => m.t > chatSeen && m.id !== S.you).length;
    $('#chat-badge').hidden = !unread;
    $('#chat-badge').textContent = unread;
  }
  $$('.tab').forEach((t) => t.onclick = () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $('#log').hidden = t.dataset.tab !== 'log';
    $('.chat').hidden = t.dataset.tab !== 'chat';
    if (S) renderChat();
    if (t.dataset.tab === 'chat') $('#chat-input').focus();
  });
  $('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text) return;
    socket.emit('chat', { text }, ack);
    $('#chat-input').value = '';
  };
  $$('[data-emoji]').forEach((b) => b.onclick = () => socket.emit('chat', { text: b.dataset.emoji }, ack));

  /* ---------- events → animations & sounds ---------- */
  function processEvents() {
    const g = S.game;
    if (seenGameNo !== S.gameNo) {
      seenGameNo = S.gameNo;
      lastSeq = g.events.length ? g.events[g.events.length - 1].seq : 0;
      handSeen.clear();
      g.hand.forEach((c) => handSeen.add(c.id));
      prevCurrent = g.current;
      selected = null;
      return;
    }
    // When the game ends, skip the play-by-play pop-ups so they don't cover the results.
    const ending = g.events.some((ev) => ev.seq > lastSeq && ev.type === 'over');
    if (ending) $('#toasts').innerHTML = '';
    const say = ending ? () => {} : toast;
    for (const ev of g.events) {
      if (ev.seq <= lastSeq) continue;
      lastSeq = ev.seq;
      const who = ev.playerId === S.you ? 'You' : esc(nameOf(ev.playerId));
      if (ev.type === 'start') { handSeen.clear(); sfx.turn(); }
      if (ev.type === 'play') {
        if (ev.slot != null) freshUntil[ev.slot] = Date.now() + 900;
        if (ev.card.type === 'magic') {
          sfx.magic();
          const sl = g.board[ev.slot];
          const onTop = !(sl.card && sl.card.id === ev.card.id);
          say(onTop ? `✦ ${who} played MAGIC on top of <b>${sl.n}</b> — one more ${sl.n}` : `✦ ${who} played MAGIC as <b>${sl.n}</b>`, '');
        }
        else if (ev.card.type === 'skip') {
          sfx.skip();
          if (ev.target === S.you) say(`⏭ ${who} played SKIP on you — you miss your next turn!`, 'err', 3500);
          else say(`⏭ ${who} played SKIP on <b>${esc(nameOf(ev.target))}</b>`, 'warn');
        } else {
          sfx.play();
          if (ev.playerId !== S.you) say(`${who} played <b>${ev.card.n}</b>`, '', 1600);
        }
      }
      if (ev.type === 'draw') {
        const t = $('#tray');
        t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump');
        if (ev.playerId === S.you) sfx.draw();
      }
      if (ev.type === 'pass' && ev.playerId !== S.you) say(`${who} passed`, '', 1400);
      if (ev.type === 'skipped') say(`⏭ ${ev.playerId === S.you ? 'Your' : esc(nameOf(ev.playerId)) + "'s"} turn was skipped${ev.drew ? ' — drew a card' : ''}`, 'warn');
      if (ev.type === 'over') {
        if (ev.winners.includes(S.you)) { sfx.win(); confetti(); } else sfx.lose();
      }
    }
    if (g.current !== prevCurrent) {
      prevCurrent = g.current;
      if (myTurn()) { sfx.turn(); flashTitle(); }
    }
    setTimeout(() => S && S.game && renderBoard(), 950);
  }

  let titleTimer = null;
  function flashTitle() {
    if (!document.hidden) return;
    clearInterval(titleTimer);
    let on = false;
    titleTimer = setInterval(() => {
      document.title = (on = !on) ? '🔔 Your turn!' : 'Prime Time Online';
      if (!document.hidden) { clearInterval(titleTimer); document.title = 'Prime Time Online'; }
    }, 900);
  }

  /* ---------- toss overlay ---------- */
  function runToss() {
    const g = S.game;
    if (tossShownFor === S.gameNo) return;
    tossShownFor = S.gameNo;
    const ov = $('#toss-overlay');
    ov.hidden = false;
    const grid = $('#toss-grid');
    grid.innerHTML = g.players.map((p) => `
      <div class="toss-p" data-p="${p.id}">
        <div class="flip"><div class="flip-inner">
          <div class="face back">${cardHTML(BACK)}</div>
          <div class="face front"></div>
        </div></div>
        <div class="nm">${esc(p.id === S.you ? 'You' : p.name)}</div>
      </div>`).join('');
    $('#toss-result').textContent = '';
    $('#toss-sub').textContent = 'Everyone draws a card. The smallest number goes first!';
    const tile = (id) => grid.querySelector(`[data-p="${id}"]`);
    const rounds = g.toss.rounds;
    rounds.forEach((r, ri) => {
      setTimeout(() => {
        const ids = Object.keys(r.draws);
        if (ri > 0) {
          $('#toss-sub').textContent = `Tie-breaker round ${ri + 1}: ${ids.map((id) => nameOf(id)).join(' & ')} draw again.`;
          $('#toss-result').textContent = '';
        }
        for (const p of g.players) {
          const t = tile(p.id);
          if (!t) continue;
          t.classList.remove('win');
          if (!ids.includes(p.id)) { t.classList.add('out'); continue; }
          t.classList.remove('out');
          $('.flip', t).classList.remove('shown');
        }
        ids.forEach((id, k) => {
          const t = tile(id);
          if (!t) return;
          setTimeout(() => { $('.face.front', t).innerHTML = cardHTML({ type: 'num', n: r.draws[id] }); }, 250);
          setTimeout(() => { $('.flip', t).classList.add('shown'); sfx.flip(); }, 500 + k * 260);
        });
        setTimeout(() => {
          if (r.tied.length > 1) {
            $('#toss-result').textContent = `Tie! ${r.tied.map((id) => nameOf(id)).join(' & ')} all drew ${r.min}.`;
            ids.filter((id) => !r.tied.includes(id)).forEach((id) => tile(id) && tile(id).classList.add('out'));
          } else {
            const w = r.tied[0];
            ids.filter((id) => id !== w).forEach((id) => tile(id) && tile(id).classList.add('out'));
            tile(w) && tile(w).classList.add('win');
            $('#toss-result').textContent = `${w === S.you ? 'You drew' : nameOf(w) + ' drew'} the smallest card (${r.min}) and ${w === S.you ? 'get' : 'gets'} the 1 card!`;
            sfx.win();
          }
        }, 500 + ids.length * 260 + 900);
      }, ri * 3200);
    });
  }

  /* ---------- game over overlay ---------- */
  let overView = { gameNo: null, view: 'game' }; // which panel of the results pop-up is showing
  let seriesCheered = null;
  function renderOver() {
    const g = S.game;
    const ov = $('#over-overlay');
    if (g.phase !== 'over' || overHiddenFor === S.gameNo) { ov.hidden = true; return; }
    ov.hidden = false;
    const ser = S.series;
    const multi = ser.target > 1;
    const final = multi && ser.done;
    // When the last game of a series ends, open on the final standings.
    if (overView.gameNo !== S.gameNo) overView = { gameNo: S.gameNo, view: final ? 'series' : 'game' };
    if (!final) overView.view = 'game';
    const showSeries = overView.view === 'series';
    $('#over-game').hidden = showSeries;
    $('#over-series').hidden = !showSeries;

    // ----- this game's result -----
    const res = g.result;
    const iWon = res.winners.includes(S.you);
    const names = res.winners.map((id) => (id === S.you ? 'You' : nameOf(id)));
    $('#over-title').textContent = iWon ? (res.winners.length > 1 ? `It's a tie — you share the win!` : 'You win! 🎉') : `${names.join(' & ')} ${names.length > 1 ? 'win' : 'wins'}!`;
    const why = res.reason === 'out' ? `${names.join(' & ')} got rid of every card after the tray ran out.`
      : res.reason === 'blocked' ? 'Nobody could play, so the lowest total wins.'
      : 'Everyone else left the table.';
    $('#over-sub').textContent = multi ? `Game ${ser.games} of ${ser.target}. ${why}` : why;
    $('#over-table').classList.toggle('no-series', !multi);
    const rows = g.players.map((p) => ({ p, s: res.scores[p.id] ?? 0 })).sort((a, b) => a.s - b.s);
    $('#over-body').innerHTML = rows.map(({ p, s }) => `
      <tr class="${res.winners.includes(p.id) ? 'win' : ''}">
        <td><div class="nmcell">${avatar(p.id, p.name)} ${esc(p.id === S.you ? 'You' : p.name)}</div></td>
        <td><div class="cards">${sortHand(res.hands[p.id] || []).map((c) => cardHTML(c, { cls: 'mini' })).join('') || '—'}</div></td>
        <td class="num">${s}</td>
        <td class="num">${ser.totals[p.id] ?? s}</td>
      </tr>`).join('');

    // ----- final series standings -----
    if (final) {
      const st = standings();
      const champs = st.filter((r) => r.winner);
      const champNames = champs.map((r) => (r.id === S.you ? 'You' : r.name));
      const iChamp = champs.some((r) => r.id === S.you);
      $('#series-title').textContent = champs.length > 1 ? `${champNames.join(' & ')} share the series win!`
        : iChamp ? 'You win the series! 🎉' : `${champNames[0]} wins the series!`;
      $('#series-sub').textContent = `${ser.target} games played · lowest total wins`;
      $('#series-table').innerHTML = `
        <thead><tr><th>Rank</th><th>Player</th>${ser.history.map((_, k) => `<th class="g">G${k + 1}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${st.map((r) => `
          <tr class="${r.winner ? 'win' : r.loser ? 'lose' : ''}">
            <td class="rank">${r.winner ? '🏆' : ''} ${ordinal(r.rank)}</td>
            <td><div class="nmcell">${avatar(r.id, r.name)} ${esc(r.id === S.you ? 'You' : r.name)}${r.loser ? ' <span class="tag-loser">Loser</span>' : ''}</div></td>
            ${r.games.map((v) => `<td class="g">${v ?? '–'}</td>`).join('')}
            <td class="num">${r.total}</td>
          </tr>`).join('')}</tbody>`;
      if (showSeries && seriesCheered !== S.gameNo) {
        seriesCheered = S.gameNo;
        if (iChamp) { sfx.win(); confetti(); }
      }
    }

    // ----- actions -----
    const host = nameOf(S.hostId);
    let actions;
    if (final) {
      actions = isHost()
        ? `<button class="btn primary lg" id="btn-again">Start a new series</button><button class="btn ghost lg" id="btn-lobby">Back to lobby</button>`
        : `<p class="muted">The series is over. Waiting for ${esc(host)} (host)…</p>`;
    } else if (multi) {
      actions = isHost()
        ? `<button class="btn primary lg" id="btn-again">Play game ${ser.games + 1} of ${ser.target}</button><button class="btn ghost lg" id="btn-lobby">Back to lobby</button>`
        : `<p class="muted">Waiting for ${esc(host)} (host) to start game ${ser.games + 1} of ${ser.target}…</p>`;
    } else {
      actions = isHost()
        ? `<button class="btn primary lg" id="btn-again">Play again</button><button class="btn ghost lg" id="btn-lobby">Back to lobby</button>`
        : `<p class="muted">Waiting for ${esc(host)} (host) to start the next game…</p>`;
    }
    $('#over-actions').innerHTML = actions;
    const again = $('#btn-again');
    if (again) again.onclick = () => socket.emit('start', {}, ack);
    const lob = $('#btn-lobby');
    if (lob) lob.onclick = () => socket.emit('lobby', {}, ack);
    const toggle = $('#btn-over-toggle');
    toggle.hidden = !final;
    toggle.textContent = showSeries ? `See the result of game ${ser.games}` : 'See the final series standings';
  }
  $('#btn-over-toggle').onclick = () => { overView.view = overView.view === 'series' ? 'game' : 'series'; render(); };
  $('#btn-view-board').onclick = () => { overHiddenFor = S.gameNo; render(); };

  /* ---------- rules modal ---------- */
  $$('[data-open-rules]').forEach((b) => b.onclick = () => { $('#rules-overlay').hidden = false; });
  $('#rules-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'rules-overlay' || e.target.closest('[data-close]')) $('#rules-overlay').hidden = true;
  });

  $('#btn-sound').onclick = () => {
    soundOn = !soundOn;
    store.set('pt_sound', soundOn);
    $('#btn-sound').textContent = soundOn ? '🔊' : '🔇';
    if (soundOn) sfx.play();
  };
  $('#btn-sound').textContent = soundOn ? '🔊' : '🔇';

  /* ================= main render ================= */
  function render() {
    if (!S) return;
    if (!S.game) {
      setZoom(false);
      $('#toss-overlay').hidden = true;
      $('#over-overlay').hidden = true;
      renderLobby();
      return;
    }
    show('game');
    const g = S.game;
    $('#game-code').textContent = S.code;
    const st = $('#series-tag');
    st.hidden = S.series.target <= 1;
    // series.games counts finished games: during play the current one is games + 1
    st.textContent = `Game ${g.phase === 'over' ? S.series.games : S.series.games + 1} of ${S.series.target}`;
    $('#btn-leave-game').hidden = gameRunning();
    if (g.phase === 'toss') runToss(); else $('#toss-overlay').hidden = true;
    renderBanner();
    renderPlayers();
    renderPiles();
    renderBoard();
    renderHand();
    renderDock();
    renderLog();
    renderChat();
    renderOver();
  }

  socket.on('state', (state) => {
    clockOffset = state.now - Date.now();
    const first = !S;
    useAssetVersion(state.assetV);
    S = state;
    if (S.game) processEvents();
    if (first) $('#home-error').textContent = '';
    render();
  });

  setInterval(() => { if (S && S.game && S.settings.turnTimer) renderBanner(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Prime Time Online'; });
})();
