/* Prime Time: tablet layout (browser client). The rules engine is on the server; this file draws
   the screens from the owner's designs and sends the player's moves. */
(() => {
  const R = window.PTRules;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SEAT_COLORS = ['#c9541c', '#1a7fb0', '#1f7f47', '#8a3cc4', '#b02a5b', '#8f6a00'];

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  /* ================= stage: the 1024-wide design, scaled to the screen ================= */
  // The hand is a grid in landscape (3 columns) and on tall phones (5 columns); one row otherwise.
  const gridHand = () => stage.classList.contains('land') || stage.classList.contains('tall');
  // Portrait uses the designs' 1024 × 1366 stage. Landscape uses 1366 × 1024, so a 1024 × 768 iPad gets the
  // same 0.75 scale; the game screen then has its own side-by-side layout (`#stage.land` in app.css).
  const DESIGN_W = 1024, DESIGN_H = 1366;
  // A portrait screen whose stage comes out at least this tall (a phone) gets the bigger game layout (`.tall`).
  const TALL_H = 1640;
  // On a phone held upright (narrower than PHONE_MAX CSS px) every screen but the game uses a stage only
  // PHONE_W design px wide, so its text and buttons come out about half as big again (`.narrow` in app.css).
  // The game keeps the 1024 width, because the board needs it.
  const PHONE_W = 680, PHONE_MAX = 600;
  const stage = $('#stage');
  let lastW = 0, lastGame = null, wasLand = null, wasTall = null;
  function fit() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const inGame = !$('#scr-game').hidden;
    // The on-screen keyboard shrinks the window height; keep the layout still while typing.
    const typing = document.activeElement && document.activeElement.matches('input, select');
    if (typing && vw === lastW && inGame === lastGame) return;
    lastW = vw;
    lastGame = inGame;
    const land = vw > vh;
    const full = land ? Math.min(vw / DESIGN_H, vh / DESIGN_W) : Math.min(vw / DESIGN_W, vh / DESIGN_H);
    const tall = !land && vh / full >= TALL_H;
    const narrow = !land && !inGame && vw < PHONE_MAX;
    const s = narrow ? vw / PHONE_W : full;
    stage.classList.toggle('land', land);
    stage.classList.toggle('tall', tall);
    stage.classList.toggle('narrow', narrow);
    stage.style.transform = `scale(${s})`;
    stage.style.width = `${vw / s}px`;
    stage.style.height = `${vh / s}px`;
    // Turning the tablet re-lays out the hand (not on the very first call: nothing is drawn yet).
    if (wasLand !== null && (wasLand !== land || wasTall !== tall)) render();
    wasLand = land;
    wasTall = tall;
  }
  window.addEventListener('resize', () => { closeZoom(); fit(); });
  const turned = window.matchMedia('(orientation: landscape)');
  if (turned.addEventListener) turned.addEventListener('change', () => fit()); else turned.addListener(() => fit());
  fit();

  const DECOR = {
    login: ['assets/ui/decor-login-top.png', 'assets/ui/decor-login-bottom.png'],
    admin: ['assets/ui/decor-admin-top.png', 'assets/ui/decor-admin-bottom.png'],
    game: [null, 'assets/ui/decor-game-bottom.png'],
  };
  const SCREENS = ['loading', 'choose', 'individual', 'login', 'admin-login', 'admin-signup', 'reset', 'admin-control', 'waiting', 'game', 'results'];
  let screen = 'loading';
  function show(name) {
    screen = name;
    for (const s of SCREENS) $(`#scr-${s}`).hidden = s !== name;
    fit(); // phones: the game and the other screens use different stage widths
    if (name !== 'game') closeZoom();
    const kind = $(`#scr-${name}`).dataset.decor;
    const [top, bottom] = DECOR[kind];
    const t = $('#decor-top'), b = $('#decor-bottom');
    if (top) { if (t.getAttribute('src') !== top) t.src = top; } else t.removeAttribute('src');
    if (b.getAttribute('src') !== bottom) b.src = bottom;
    $('#decor').className = `decor ${kind}`;
    $('#toasts').classList.toggle('in-game', name === 'game');
  }

  /* ================= sound ================= */
  // Until the player chooses, sound starts off in class games (a room full of tablets) and on at home.
  let soundPref = store.get('pt_sound');
  const soundOn = () => (soundPref === null ? store.get('pt_mode') === 'individual' : soundPref);
  let actx = null;
  function tone(freqs, dur = 0.1, type = 'triangle', vol = 0.07) {
    if (!soundOn()) return;
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
  // "Wah-wah-wah-waaah": four falling notes, the last one long with a wobble.
  function sadTrombone() {
    if (!soundOn()) return;
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
  const SOUND_ON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
  const SOUND_OFF = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>';
  function paintSound() {
    $('#btn-sound').innerHTML = soundOn() ? SOUND_ON : SOUND_OFF;
    $('#btn-sound').setAttribute('aria-pressed', String(soundOn()));
  }
  $('#btn-sound').onclick = () => { soundPref = !soundOn(); store.set('pt_sound', soundPref); paintSound(); if (soundPref) sfx.play(); };
  paintSound();

  /* ================= toasts, confetti, confirm ================= */
  // ms = 0 keeps the message up until it is removed (used while the connection is lost).
  function toast(msg, kind = '', ms = 2600) {
    const el = document.createElement('div');
    el.className = `toast ${kind}${ms ? '' : ' stay'}`;
    el.innerHTML = msg;
    $('#toasts').appendChild(el);
    const extra = $$('#toasts .toast:not(.stay)');
    const keep = screen === 'game' ? 1 : 3;
    while (extra.length > keep) extra.shift().remove();
    if (ms) setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 350); }, ms);
    return el;
  }
  function confetti() {
    for (let i = 0; i < 90; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = SEAT_COLORS[i % SEAT_COLORS.length];
      c.style.animationDuration = 2 + Math.random() * 2.5 + 's';
      c.style.animationDelay = Math.random() * 0.8 + 's';
      c.style.borderRadius = Math.random() < 0.5 ? '50%' : '2px';
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 5500);
    }
  }
  // A styled yes/no pop-up (the browser's own confirm() looks out of place on a tablet).
  function ask(title, msg, yes = 'Yes') {
    return new Promise((resolve) => {
      $('#confirm-title').textContent = title;
      $('#confirm-msg').textContent = msg;
      $('#btn-confirm-yes').textContent = yes;
      $('#confirm-overlay').hidden = false;
      const done = (v) => { $('#confirm-overlay').hidden = true; resolve(v); };
      $('#btn-confirm-yes').onclick = () => done(true);
      $('#btn-confirm-no').onclick = () => done(false);
    });
  }

  /* ================= pop-ups: focus, the screen behind, Esc ================= */
  // Pop-ups open and close by toggling `hidden` in many places, so watch that attribute: while one
  // is open the screens behind it are inert, focus moves into it, and it comes back when it closes.
  const overlays = $$('.overlay');
  const ESC_CLOSE = { 'rules-overlay': '[data-close]', 'skip-overlay': '#btn-skip-cancel', 'confirm-overlay': '#btn-confirm-no', 'nope-overlay': '#btn-nope-ok',
    'chat-overlay': '[data-close]', 'timeup-overlay': '#btn-timeup-wait' };
  let focusBack = null;
  function syncOverlays(changed) {
    const open = overlays.filter((o) => !o.hidden);
    for (const el of $$('.screen')) el.inert = open.length > 0;
    if (changed && !changed.hidden) {
      if (!focusBack) focusBack = document.activeElement;
      const first = $('.modal button:not([hidden]):not([disabled])', changed) || $('.modal', changed);
      if (first) first.focus({ preventScroll: true });
    } else if (!open.length && focusBack) {
      if (focusBack.isConnected && !focusBack.closest('[inert]')) focusBack.focus({ preventScroll: true });
      focusBack = null;
    }
  }
  const overlayWatch = new MutationObserver((list) => list.forEach((m) => syncOverlays(m.target)));
  overlays.forEach((o) => overlayWatch.observe(o, { attributes: true, attributeFilter: ['hidden'] }));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = overlays.filter((o) => !o.hidden).pop();
    const btn = top && ESC_CLOSE[top.id] && $(ESC_CLOSE[top.id], top);
    if (btn) { e.preventDefault(); btn.click(); }
  });

  /* ================= server connection ================= */
  const socket = io();
  let S = null;                                   // latest state from the server
  let session = store.get('pt_session');          // player seat: {code, token, name, grade}
  let adminRoom = store.get('pt_admin_room');     // admin's room: {code, token}
  let adminAuth = store.get('pt_admin');          // admin sign-in: {token, email, school}
  const call = (ev, data) => new Promise((res) => socket.emit(ev, data, (r) => res(r || {})));
  function ack(res) { if (res && res.error) { toast(esc(res.error), 'err'); sfx.err(); } }

  const amAdmin = () => !!(S && S.admin && S.admin.id === S.you);
  const isHost = () => S && S.hostId === S.you;
  const gameRunning = () => !!(S && S.game && S.game.phase !== 'over');
  const myTurn = () => !!(S && S.game && S.game.phase === 'playing' && S.game.current === S.you);
  const hints = () => !!(S && S.game && S.game.settings && S.game.settings.hints);
  const isBot = (id) => !!(S && S.members.some((m) => m.id === id && m.bot));
  const colorOf = (id) => {
    const idx = S ? S.members.findIndex((m) => m.id === id) : 0;
    return SEAT_COLORS[(idx < 0 ? 0 : idx) % SEAT_COLORS.length];
  };
  const nameOf = (id) => {
    const g = S && S.game;
    const p = (g && g.players.find((x) => x.id === id)) || (S && S.members.find((x) => x.id === id));
    return p ? p.name : 'Someone';
  };
  // Each player's letter(s) on the board and in the players strip; two letters when names share the first one.
  function initialOf(id) {
    const g = S && S.game;
    const people = [...(S ? S.members : []), ...(g ? g.players : [])];
    const first = (n) => (n || '?').trim().charAt(0).toUpperCase();
    const name = nameOf(id);
    const clash = people.some((p) => p.id !== id && p.name !== name && first(p.name) === first(name));
    const two = name.trim().replace(/\s+/g, '').slice(0, 2);
    return esc(clash && two.length > 1 ? two.charAt(0).toUpperCase() + two.charAt(1).toLowerCase() : first(name));
  }

  /* ================= card art ================= */
  let assetV = '';
  const withV = (url) => (assetV ? `${url}?v=${assetV}` : url);
  const cardSrc = (card) => withV(`assets/cards/${card.type === 'num' ? card.n : card.type}.png`);
  const cardAlt = (card) => (card.type === 'num'
    ? `${card.n}${card.n === 1 ? ' (unique)' : R.isPrime(card.n) ? ' (prime)' : ' = ' + R.factorize(card.n).join(' × ')}`
    : card.type === 'magic' ? 'MAGIC card' : card.type === 'skip' ? 'SKIP card' : 'Card back');
  function cardHTML(card, { tag = 'div', cls = '', attrs = '' } = {}) {
    return `<${tag} class="card ${card.type} ${cls}" ${attrs}><img src="${cardSrc(card)}" alt="${esc(cardAlt(card))}" draggable="false"></${tag}>`;
  }
  const BACK = { type: 'back' };
  function useAssetVersion(v) {
    if (!v || v === assetV) return;
    assetV = v;
    $('#board-wrap').style.setProperty('--board-img', `url(${withV('assets/ui/board-cut.webp')})`);
    for (const img of $$('#board .placed')) img.removeAttribute('src');
    for (let n = 1; n <= 60; n++) new Image().src = cardSrc({ type: 'num', n });
    for (const t of ['magic', 'skip', 'back']) new Image().src = cardSrc({ type: t });
  }
  const checkCard = (card) => R.checkCard(S.game.board, card, S.game.firstMove, S.game.order.length > 1);

  /* ================= user login ================= */
  const params = new URLSearchParams(location.search);
  const urlCode = (params.get('code') || params.get('room') || '').trim();
  const resetToken = params.get('reset');
  const saved = store.get('pt_player') || {};
  if (saved.name) $('#in-name').value = saved.name;
  // Students pick their grade from the same list the teacher uses (an old typed "4" becomes "Grade 4").
  for (let n = 1; n <= 12; n++) $('#in-grade').insertAdjacentHTML('beforeend', `<option value="Grade ${n}">Grade ${n}</option>`);
  if (saved.grade) $('#in-grade').value = /^\d+$/.test(saved.grade) ? `Grade ${saved.grade}` : saved.grade;
  if (saved.name) $('#ind-name').value = saved.name;
  // A 6-digit code is a school game; a 5-letter code is an Individual game (the classic invite link).
  const urlIsSchool = /^\d{6}$/.test(urlCode);
  if (urlCode) $(urlIsSchool ? '#in-code' : '#ind-code').value = urlCode.toUpperCase();
  // Individual or School, chosen on the first screen; decides where "home" is after a game.
  let mode = store.get('pt_mode') || 'school';
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    store.set('pt_mode', mode);
    goTo(mode === 'individual' ? 'individual' : 'login');
  }));

  $$('[data-go]').forEach((b) => b.addEventListener('click', () => goTo(b.dataset.go)));
  // An error message goes away as soon as the person starts fixing the form.
  document.addEventListener('input', (e) => {
    const form = e.target.closest('form');
    if (form) for (const el of $$('.form-error', form)) el.textContent = '';
  });
  function goTo(name) {
    for (const e of $$('.form-error')) e.textContent = '';
    if (name === 'admin-login' && adminAuth) name = 'admin-control';
    if (name === 'admin-control') fillControl();
    show(name);
  }

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    const name = $('#in-name').value.trim();
    const grade = $('#in-grade').value.trim();
    const code = $('#in-code').value.trim().toUpperCase();
    if (!name) { err.textContent = 'Please enter your name.'; $('#in-name').focus(); return; }
    if (!grade) { err.textContent = 'Please choose your grade.'; $('#in-grade').focus(); return; }
    if (!code) { err.textContent = 'Please enter the game code.'; $('#in-code').focus(); return; }
    if (code.length < 5) { err.textContent = 'That code is too short. Check it with your teacher.'; $('#in-code').focus(); return; }
    store.set('pt_player', { name, grade });
    const token = session && session.code === code ? session.token : undefined;
    document.activeElement.blur();
    const res = await call('join', { code, name, grade, token });
    if (res.error) {
      err.textContent = res.error; sfx.err();
      if (res.badName) { store.set('pt_player', { grade }); $('#in-name').select(); }
      return;
    }
    session = { code: res.code, token: res.token, name, grade };
    store.set('pt_session', session);
    adminRoom = null; store.del('pt_admin_room');
    history.replaceState(null, '', `?code=${res.code}`);
  });

  /* ================= Individual: the classic game (the host plays too) ================= */
  function indName() {
    const n = $('#ind-name').value.trim();
    if (!n) { $('#ind-error').textContent = 'Please enter your name first.'; $('#ind-name').focus(); return null; }
    store.set('pt_player', { ...(store.get('pt_player') || {}), name: n });
    return n;
  }
  function joinedIndividual(res, name) {
    if (res.error) {
      $('#ind-error').textContent = res.error; sfx.err();
      if (res.badName) { store.set('pt_player', { ...(store.get('pt_player') || {}), name: '' }); $('#ind-name').select(); }
      return false;
    }
    session = { code: res.code, token: res.token, name };
    store.set('pt_session', session);
    adminRoom = null; store.del('pt_admin_room');
    history.replaceState(null, '', `?room=${res.code}`);
    return true;
  }
  $('#btn-create').onclick = async () => {
    const name = indName(); if (!name) return;
    joinedIndividual(await call('create', { name }), name);
  };
  // Practice: a private table with one computer player already seated.
  $('#btn-vs-bot').onclick = async () => {
    const name = indName(); if (!name) return;
    if (joinedIndividual(await call('create', { name }), name)) socket.emit('addBot', {}, ack);
  };
  $('#form-individual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = indName(); if (!name) return;
    const code = $('#ind-code').value.trim().toUpperCase();
    if (!code) { $('#ind-error').textContent = 'Enter the game code your friend sent you.'; $('#ind-code').focus(); return; }
    if (code.length < 5) { $('#ind-error').textContent = 'That code is too short. It has 5 letters.'; $('#ind-code').focus(); return; }
    const token = session && session.code === code ? session.token : undefined;
    document.activeElement.blur();
    joinedIndividual(await call('join', { code, name, token }), name);
  });

  /* ================= admin: log in, sign up ================= */
  async function api(path, body) {
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch { return { error: 'Could not reach the server. Check your connection.' }; }
  }
  $$('[data-eye]').forEach((b) => b.onclick = () => {
    const input = $(`#${b.dataset.eye}`);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.classList.toggle('on', show);
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  function signedIn(res) {
    adminAuth = { token: res.token, email: res.admin.email, school: res.admin.school };
    store.set('pt_admin', adminAuth);
    goTo('admin-control');
  }
  $('#form-admin-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#al-email').value.trim();
    const password = $('#al-pass').value;
    if (!email || !password) { $('#al-error').textContent = 'Please enter your email and password.'; return; }
    const res = await api('/api/admin/login', { email, password });
    if (res.error) { $('#al-error').textContent = res.error; sfx.err(); return; }
    $('#al-pass').value = '';
    signedIn(res);
  });
  // "Forgot password?" sends a reset link when the site has email set up; otherwise it explains.
  let resetByEmail = false;
  $('#btn-forgot').onclick = async () => {
    const err = $('#al-error');
    err.classList.remove('ok');
    if (!resetByEmail) { err.textContent = 'Password reset by email is not set up yet. Please ask the person who runs this site.'; return; }
    const email = $('#al-email').value.trim();
    if (!email) { err.textContent = 'Type your email first. Then tap Forgot password.'; $('#al-email').focus(); return; }
    const res = await api('/api/admin/forgot', { email });
    if (res.error) { err.textContent = res.error; return; }
    err.textContent = 'If this email has a teacher account, we sent a link. Check your inbox.';
    err.classList.add('ok');
  };
  document.addEventListener('input', () => $('#al-error').classList.remove('ok'));
  // Some sites ask for a sign-up code before anyone can register as an admin.
  fetch('/api/admin/config').then((r) => r.json()).then((c) => {
    $('#su-code').hidden = !c.signupCode;
    $('#form-signup').classList.toggle('with-code', !!c.signupCode);
    resetByEmail = !!c.resetEmail;
  }).catch(() => {});
  $('#form-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#rs-error');
    const password = $('#rs-pass').value;
    if (!password) { err.textContent = 'Please type a new password.'; return; }
    if (password !== $('#rs-pass2').value) { err.textContent = 'The two passwords are different.'; return; }
    const res = await api('/api/admin/reset', { token: resetToken, password });
    if (res.error) { err.textContent = res.error; sfx.err(); return; }
    $('#rs-pass').value = $('#rs-pass2').value = '';
    history.replaceState(null, '', location.pathname);
    signedIn(res);
  });
  $('#form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#su-error');
    const email = $('#su-email').value.trim();
    const password = $('#su-pass').value;
    if (password !== $('#su-pass2').value) { err.textContent = 'The two passwords are different.'; return; }
    const res = await api('/api/admin/signup', { email, password, school: $('#su-school').value, campus: $('#su-campus').value, code: $('#su-code').value });
    if (res.error) { err.textContent = res.error; sfx.err(); return; }
    $('#su-pass').value = $('#su-pass2').value = '';
    signedIn(res);
  });
  // While editing a room's settings this link goes back to the waiting room instead.
  $('#btn-logout').onclick = () => {
    if (editingRoom && S) { show('waiting'); render(); return; }
    adminAuth = null; store.del('pt_admin'); goTo('admin-login');
  };

  /* ================= admin control: choose the settings and create the game ================= */
  {
    const sel = $('#ac-grade');
    for (let g = 1; g <= 12; g++) sel.insertAdjacentHTML('beforeend', `<option value="Grade ${g}">Grade ${g}</option>`);
    sel.insertAdjacentHTML('beforeend', '<option value="Mixed grades">Mixed grades</option>');
  }
  function setToggle(el, on) { el.setAttribute('aria-checked', String(!!on)); }
  const toggleOn = (el) => el.getAttribute('aria-checked') === 'true';
  $$('.toggle').forEach((t) => t.addEventListener('click', () => { setToggle(t, !toggleOn(t)); syncTimer(); }));
  function syncTimer() {
    const on = toggleOn($('#ac-timer'));
    const lim = $('#ac-limit');
    lim.disabled = !on;
    if (on && !lim.value) lim.value = '60';
    if (!on) lim.value = '';
  }
  // When the admin returns here from a waiting room, the form shows that room's settings and saves them.
  let editingRoom = false;
  function fillControl() {
    editingRoom = !!(S && isHost() && !gameRunning());
    // An Individual host edits the same settings, minus the school-only ones.
    const individual = editingRoom && !S.admin;
    for (const el of $$('#form-control .school-only')) el.hidden = individual;
    $('#ac-title').textContent = individual ? 'Game Settings' : 'Admin Control';
    $('#ac-who').textContent = adminAuth && !individual ? `Signed in as ${adminAuth.email}` : '';
    if (editingRoom) {
      const st = S.settings;
      $('#ac-players').value = String(st.maxPlayers);
      $('#ac-grade').value = st.grade || '';
      setToggle($('#ac-hints'), st.hints);
      setToggle($('#ac-timer'), st.turnTimer > 0);
      $('#ac-limit').value = st.turnTimer ? String(st.turnTimer) : '';
      $('#ac-skips').value = String(st.skips);
      $('#ac-series').value = String(st.seriesGames);
      $('#ac-series').disabled = S.series.running;
    } else $('#ac-series').disabled = false;
    $('#ac-limit').disabled = !toggleOn($('#ac-timer'));
    $('#ac-submit').textContent = editingRoom ? 'Save settings' : 'Create game';
    // While editing a room, the back arrow returns to the waiting room and Log out is not offered.
    $('#ac-back').hidden = !editingRoom;
    $('#btn-logout').hidden = editingRoom;
  }
  $('#ac-back').onclick = () => { if (S) { show('waiting'); render(); } };
  $('#form-control').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#ac-error');
    const individual = editingRoom && !S.admin;
    const maxPlayers = Number($('#ac-players').value);
    const grade = $('#ac-grade').value;
    if (!individual && !maxPlayers) { err.textContent = 'Please select the number of players.'; return; }
    if (!individual && !grade) { err.textContent = 'Please select the grade of the players.'; return; }
    const settings = {
      ...(individual ? {} : { maxPlayers, grade }),
      hints: toggleOn($('#ac-hints')),
      turnTimer: toggleOn($('#ac-timer')) ? Number($('#ac-limit').value || 60) : 0,
      skips: Number($('#ac-skips').value),
    };
    if (!(editingRoom && S.series.running)) settings.seriesGames = Number($('#ac-series').value);
    if (editingRoom) {
      const res = await call('settings', settings);
      if (res.error) { err.textContent = res.error; return; }
      show('waiting');
      render();
      return;
    }
    if (!adminAuth) return goTo('admin-login');
    const res = await call('adminCreate', { auth: adminAuth.token, settings });
    if (res.error) {
      err.textContent = res.error;
      if (res.relogin) { adminAuth = null; store.del('pt_admin'); setTimeout(() => goTo('admin-login'), 1200); }
      return;
    }
    adminRoom = { code: res.code, token: res.token };
    store.set('pt_admin_room', adminRoom);
    session = null; store.del('pt_session');
    history.replaceState(null, '', location.pathname);
  });

  /* ================= connecting & rejoining ================= */
  function goHome(msg, { keepSaved = false, first = false } = {}) {
    S = null;
    if (!keepSaved) { session = null; store.del('pt_session'); adminRoom = null; store.del('pt_admin_room'); }
    history.replaceState(null, '', location.pathname);
    for (const o of $$('.overlay')) o.hidden = true;
    if (first) goTo('choose');
    else if (mode === 'individual') { goTo('individual'); if (msg) $('#ind-error').textContent = msg; }
    else if (adminAuth) { goTo('admin-control'); if (msg) $('#ac-error').textContent = msg; }
    else { goTo('login'); if (msg) $('#login-error').textContent = msg; }
  }
  const willRejoinPlayer = () => session && session.token && (!urlCode || urlCode.toUpperCase() === session.code);
  function startScreen() {
    if (S) return;
    if (resetToken) return show('reset');
    if (adminRoom || willRejoinPlayer()) return show('loading');
    // An invite link goes straight to the matching screen; otherwise start with the choice.
    if (urlCode) { mode = urlIsSchool ? 'school' : 'individual'; store.set('pt_mode', mode); }
    goTo(!urlCode ? 'choose' : urlIsSchool ? 'login' : 'individual');
  }
  startScreen();
  setTimeout(() => {
    if (!S && screen === 'loading') goHome('Could not reconnect. Check your connection and try again.', { keepSaved: true });
  }, 8000);
  socket.on('connect', async () => {
    if (adminRoom) {
      const res = await call('adminJoin', adminRoom);
      if (res.error) goHome(res.error);
    } else if (willRejoinPlayer()) {
      const res = await call('join', { code: session.code, token: session.token, name: session.name, grade: session.grade });
      if (res.error) goHome(res.error === 'No game found with that code.' ? 'That game has ended.' : res.error);
    } else if (screen === 'loading') startScreen();
  });
  // The note stays until the connection is back; Play and Pass are off meanwhile (see renderControls).
  let offlineNote = null;
  socket.on('disconnect', () => {
    if (!S || offlineNote) return;
    offlineNote = toast('No connection. Trying again…', 'warn', 0);
    if (screen === 'game') renderControls();
  });
  socket.on('connect', () => {
    if (!offlineNote) return;
    offlineNote.remove(); offlineNote = null;
    toast('Back online.', 'good', 1800);
    if (S && screen === 'game') renderControls();
  });
  socket.on('kicked', ({ reason, otherTab }) => goHome(reason, { keepSaved: !!otherTab }));

  /* ================= waiting room ================= */
  const codeBoxes = (code) => String(code).split('').map((c) => `<b>${esc(c)}</b>`).join('');
  function namePill(name, extraCls = '') {
    const cls = name.length > 13 ? 'xlong' : name.length > 9 ? 'long' : '';
    return `<div class="nm ${cls} ${extraCls}">${esc(name)}</div>`;
  }
  function renderWaiting() {
    show('waiting');
    $('#wait-code').innerHTML = codeBoxes(S.code);
    const admin = amAdmin();
    const host = isHost();
    const size = S.admin ? S.settings.maxPlayers : 6;
    const joined = S.members.length;
    $('#wait-title').textContent = S.series.running ? `Game ${S.series.games + 1} of ${S.series.target} is next`
      : joined >= size ? 'Everyone is here!' : 'Waiting for players';
    $('#wait-sub').innerHTML = S.admin ? `${joined} of ${size} players joined${S.settings.grade ? ` · ${esc(S.settings.grade)}` : ''}`
      : `${joined} player${joined === 1 ? '' : 's'} at the table · up to 6 can play`;
    $('#wait-hint').textContent = S.series.running ? ''
      : S.admin ? 'Students type this code on the login screen.' : 'Friends type this code to join you.';
    renderJoinClock();
    const tiles = S.members.map((m) => `
      <div class="pp ${m.id === S.you ? 'me' : ''} ${m.connected ? '' : 'off'} ${m.bot ? 'bot' : ''}">
        ${host && m.id !== S.you && !S.series.running ? `<button class="x" data-kick="${m.id}" aria-label="Remove ${esc(m.name)}">×</button>` : ''}
        ${namePill(m.name)}
        <div class="sc">${m.bot ? 'Computer' : m.grade ? esc(m.grade) : m.isHost ? 'Host' : 'Player'}</div>
        ${S.series.target > 1 && S.series.games ? `<div class="tot">Total ${S.series.totals[m.id] ?? 0}</div>` : ''}
      </div>`);
    for (let i = joined; i < size; i++) tiles.push(`<div class="pp empty"><div class="nm">${S.admin ? 'Waiting…' : 'Open seat'}</div><div class="sc">&nbsp;</div></div>`);
    $('#wait-players').innerHTML = tiles.join('');

    // Individual games: friends join with the code or an invite link.
    const inviteLink = `${location.origin}${location.pathname}?room=${S.code}`;
    const invite = !S.admin && joined < size && !S.series.running
      ? '<button class="btn secondary" id="btn-invite">Invite a friend</button>' : '';
    const st = S.settings;
    const chips = `<div class="settings-chips">
      <span>Hints ${st.hints ? 'on' : 'off'}</span>
      <span>${st.turnTimer ? `${st.turnTimer} s per turn` : 'No timer'}</span>
      <span>${st.skips} SKIP cards</span>
      <span>${S.series.target > 1 ? `Series of ${S.series.target} games` : '1 game'}</span></div>`;
    // School games, before the first game: the teacher can give students another minute.
    const more = admin && !S.gameNo && (S.joinUntil || S.joinTimeUp) ? '<button class="btn secondary" id="btn-more-time">Add 1 minute</button>' : '';
    let actions;
    if (host) {
      const startLabel = S.series.running ? `Start game ${S.series.games + 1} of ${S.series.target}` : 'Start game';
      actions = `
        <button class="btn" id="btn-start" ${joined < 2 ? 'disabled' : ''}>${startLabel}</button>
        ${joined < size && !S.series.running ? `<div class="btn-pair"><button class="btn secondary" id="btn-add-bot">Add computer player</button>${invite}${more}</div>` : ''}
        ${chips}
        <div class="link-row center">
          ${S.series.running ? '' : '<button class="link" id="btn-edit">Change settings</button>'}
          ${admin ? '<button class="link" id="btn-close">Close the game</button>' : '<button class="link" id="btn-leave">Leave</button>'}
        </div>`;
    } else {
      const waitFor = S.series.running ? 'The next game will start soon.'
        : S.admin ? (S.joinUntil ? 'The game starts when everyone is here, or when the time is up.' : 'The game will start soon.')
        : `Waiting for ${esc(nameOf(S.hostId))} to start the game.`;
      actions = `<p class="wait-msg">${waitFor}</p>${invite}${chips}
        ${S.series.running ? '' : '<div class="link-row center"><button class="link" id="btn-leave">Leave</button></div>'}`;
    }
    $('#wait-actions').innerHTML = actions;
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('#btn-start', async () => {
      if (S.admin && joined < size && !S.series.running && !(await ask('Start now?', `Only ${joined} of ${size} players have joined.`, 'Start the game'))) return;
      const res = await call('start', {});
      if (res.error) $('#wait-error').textContent = res.error;
    });
    on('#btn-add-bot', () => socket.emit('addBot', {}, ack));
    on('#btn-more-time', () => socket.emit('extendJoin', {}, ack));
    on('#btn-invite', async () => {
      const text = `Play Prime Time with me! Game code ${S.code}`;
      try {
        if (navigator.share) { await navigator.share({ title: 'Prime Time', text, url: inviteLink }); return; }
        await navigator.clipboard.writeText(`${text}: ${inviteLink}`);
        toast('Invite link copied. Paste it in a message to your friend.', 'good');
      } catch (e) {
        if (e && e.name === 'AbortError') return; // the share sheet was closed
        ask('Invite a friend', `Send this link: ${inviteLink}`, 'OK');
      }
    });
    on('#btn-edit', () => goTo('admin-control'));
    on('#btn-close', async () => {
      if (!(await ask('Close the game?', 'Everyone will leave this game.', 'Close the game'))) return;
      await call('closeRoom', {});
      goHome();
    });
    on('#btn-leave', async () => {
      if (!(await ask('Leave this game?', 'You can join again with the code.', 'Leave'))) return;
      const res = await call('leave', {});
      if (res.error) return ack(res);
      goHome();
    });
  }
  // "The game starts in 0:42": updated every second while the join time runs.
  function renderJoinClock() {
    const el = $('#join-clock');
    const left = S && S.joinUntil && !S.game ? Math.max(0, Math.ceil((S.joinUntil - Date.now() - clockOffset) / 1000)) : null;
    el.hidden = left == null && !(S && S.joinTimeUp && amAdmin());
    if (el.hidden) return;
    const html = left != null ? `The game starts in <b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b>`
      : 'Time is up. Start when you are ready.';
    if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
    renderTimeUp();
  }
  // The join time ended with fewer than 2 players: the teacher chooses what happens.
  let timeUpDismissed = false;
  function renderTimeUp() {
    const ov = $('#timeup-overlay');
    if (!S || !S.joinTimeUp) timeUpDismissed = false;
    const showIt = !!(S && S.joinTimeUp && amAdmin() && !S.game && screen === 'waiting' && !timeUpDismissed);
    if (ov.hidden !== !showIt) ov.hidden = !showIt;
    if (!showIt) return;
    const n = S.members.length;
    $('#timeup-msg').textContent = n === 0 ? 'No students have joined yet.'
      : n === 1 ? `Only ${S.members[0].name} has joined. A game needs 2 players.` : `${n} players have joined.`;
    const start = $('#btn-timeup-start');
    start.hidden = n === 0;
    start.textContent = n === 1 ? 'Start with a computer player' : 'Start the game';
  }
  $('#btn-timeup-more').onclick = () => socket.emit('extendJoin', {}, ack);
  $('#btn-timeup-wait').onclick = () => { timeUpDismissed = true; renderTimeUp(); };
  $('#btn-timeup-start').onclick = async () => {
    if (S.members.length < 2) {
      const res = await call('addBot', {});
      if (res.error) return ack(res);
    }
    if (!S.game) socket.emit('start', {}, ack);
  };

  $('#wait-players').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-kick]');
    if (!b) return;
    if (await ask(`Remove ${nameOf(b.dataset.kick)}?`, 'They will leave this game.', 'Remove')) socket.emit('kick', { id: b.dataset.kick }, ack);
  });

  /* ================= board ================= */
  // Slot geometry of the printed board (2000×1611): tiles 153×175 px, first tile at (136,127),
  // column pitch 175 px, row pitch 196.67 px, 10 per row.
  const BOARD_W = 2000, BOARD_H = 1611;
  const TILE = { x0: 136, y0: 127, w: 153, h: 175, dx: 175, dy: 196.67 };
  let selected = null;
  function buildBoard() {
    const board = $('#board');
    if (board.dataset.built) return;
    board.dataset.built = '1';
    board.innerHTML = R.buildSlots().map((s) => {
      const r = Math.floor(s.i / 10), c = s.i % 10;
      const style = `left:${((TILE.x0 + c * TILE.dx) / BOARD_W) * 100}%;top:${((TILE.y0 + r * TILE.dy) / BOARD_H) * 100}%;`
        + `width:${(TILE.w / BOARD_W) * 100}%;height:${(TILE.h / BOARD_H) * 100}%`;
      return `<div class="slot" data-i="${s.i}" style="${style}"><img class="placed" alt="" draggable="false" hidden><span class="asnum" hidden></span><span class="mbadge" hidden></span><span class="lastmark" hidden></span></div>`;
    }).join('');
  }

  function selectionPlan() {
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

  const freshUntil = {};
  function renderBoard() {
    buildBoard();
    const g = S.game;
    const plan = selectionPlan();
    const now = Date.now();
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
      // A glowing MAGIC target is a button; every other slot is read out as a picture.
      const target = plan.targets.has(i);
      if (el.getAttribute('role') !== (target ? 'button' : 'img')) {
        el.setAttribute('role', target ? 'button' : 'img');
        if (target) el.tabIndex = 0; else el.removeAttribute('tabindex');
      }
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
      const extra = s.extra ? s.extra.length : 0;
      const badge = $('.mbadge', el);
      const btxt = extra ? `+${extra}✦` : s.under ? '✦' : '';
      badge.hidden = !btxt;
      if (badge.textContent !== btxt) badge.textContent = btxt;
      const lm = $('.lastmark', el);
      const marks = lastBySlot.get(i);
      if (marks) {
        el.style.setProperty('--pc', colorOf(marks[marks.length - 1].id));
        const html = marks.map((m) => `<i style="background:${colorOf(m.id)}">${initialOf(m.id)}</i>`).join('');
        if (lm.innerHTML !== html) lm.innerHTML = html;
        lm.hidden = false;
      } else if (!lm.hidden) { lm.hidden = true; lm.innerHTML = ''; }
      const who = s.card && s.card.by ? `, played by ${nameOf(s.card.by)}` : '';
      const label = `${cardAlt({ type: 'num', n: s.n })}${s.card ? (standing ? ', MAGIC card standing in' : '') : ', empty'}${extra ? `, ${extra} MAGIC on top` : ''}${who}${target ? '. Put MAGIC here' : ''}`;
      if (el.title !== label) { el.title = label; el.setAttribute('aria-label', label); }
    }
    syncZoom();
  }
  $('#board').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.slot.target')) { e.preventDefault(); e.target.click(); }
  });
  // A tap on a slot: a glowing MAGIC target takes the selected MAGIC; another prime slot explains where it
  // can go. Returns true when the tap was used.
  function slotTap(el) {
    const card = el && selected && S.game && S.game.hand.find((c) => c.id === selected);
    if (!card) return false;
    const i = Number(el.dataset.i);
    if (el.classList.contains('target')) { closeZoom(); playCard(card, { slot: i }); return true; }
    if (card.type === 'magic' && myTurn() && !S.game.firstMove && R.isPrime(S.game.board[i].n)) { notPlayable(card, R.MAGIC_NEEDS_VACANT); return true; }
    return false;
  }
  $('#board').addEventListener('click', (e) => {
    const el = e.target.closest('.slot');
    if (el && el.classList.contains('target')) { slotTap(el); return; }
    // On a small screen (a phone) the slots are tiny: a tap anywhere else opens the zoomed board there.
    if (smallBoard()) { openZoom(e); return; }
    if (el) slotTap(el);
  });

  /* ================= zoomed board (small screens) ================= */
  const ZOOM = 2.5;
  const smallBoard = () => $('#board-wrap').getBoundingClientRect().width < 520;
  function closeZoom() {
    const z = document.getElementById('board-zoom');
    if (z) z.hidden = true;
  }
  // The zoomed board is a copy of the board's slots, kept up to date while it is open.
  function syncZoom() {
    const z = $('#board-zoom');
    if (z.hidden) return;
    const html = $('#board').innerHTML;
    const slots = $('#board-zoom-slots');
    if (slots.dataset.src === html) return;
    slots.dataset.src = html;
    slots.innerHTML = html;
    for (const el of $$('[tabindex]', slots)) el.removeAttribute('tabindex');
  }
  function openZoom(e) {
    const r = $('#board').getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    $('#board-zoom').hidden = false;
    syncZoom();
    // Start with the tapped spot in the middle.
    const sc = $('#board-zoom-scroll');
    sc.scrollLeft = fx * sc.scrollWidth - sc.clientWidth / 2;
    sc.scrollTop = fy * sc.scrollHeight - sc.clientHeight / 2;
  }
  $('#board-zoom').style.setProperty('--zoom', ZOOM);
  $('#board-zoom').addEventListener('click', (e) => {
    if (slotTap(e.target.closest('.slot'))) return;
    closeZoom();
  });

  /* ================= moves ================= */
  function playCard(card, extra = {}) {
    if (!myTurn()) return;
    const chk = checkCard(card);
    if (!chk.ok) return notPlayable(card, chk.reason);
    if (card.type === 'skip' && !extra.target) return openSkip(card);
    if (card.type === 'magic' && extra.slot == null) {
      toast('Now tap a glowing prime slot on the board.', 'warn');
      renderBoard();
      for (const el of $$('#board .slot.target')) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
      return;
    }
    socket.emit('play', { cardId: card.id, ...extra }, (res) => {
      if (res && res.error) { toast(esc(res.error), 'err'); sfx.err(); } else { selected = null; render(); }
    });
  }
  function openSkip(card) {
    const others = S.game.order.filter((id) => id !== S.you).map((id) => S.game.players.find((p) => p.id === id)).filter(Boolean);
    // With one other player there is nothing to choose.
    if (others.length === 1) return playCard(card, { target: others[0].id });
    $('#skip-targets').innerHTML = others.map((p) => `<button data-target="${p.id}">${esc(p.name)}
      <small>${p.count} card${p.count === 1 ? '' : 's'}${p.skips ? ` · already skipped ×${p.skips}` : ''}</small></button>`).join('');
    $('#skip-overlay').hidden = false;
    $('#skip-targets').onclick = (e) => {
      const b = e.target.closest('[data-target]');
      if (!b) return;
      $('#skip-overlay').hidden = true;
      playCard(card, { target: b.dataset.target });
    };
  }
  $('#btn-skip-cancel').onclick = () => { $('#skip-overlay').hidden = true; };

  function notPlayable(card, message) {
    sfx.nope();
    $('#nope-card').innerHTML = card ? cardHTML(card) : '';
    $('#nope-msg').textContent = message;
    $('#nope-overlay').hidden = false;
  }
  $('#btn-nope-ok').onclick = () => { $('#nope-overlay').hidden = true; };

  // One tap selects a card (or unselects it); a second tap on the same card soon after plays it, just as
  // Play would (owner, 2026-10-26).
  const DOUBLE_TAP_MS = 450;
  let lastTap = { id: null, t: 0 };
  $('#hand').addEventListener('click', (e) => {
    if (suppressClick) return;
    const el = e.target.closest('.card[data-id]');
    if (!el) return;
    const card = S.game.hand.find((c) => c.id === el.dataset.id);
    if (!card) return;
    const now = Date.now();
    const twice = lastTap.id === card.id && now - lastTap.t < DOUBLE_TAP_MS;
    lastTap = twice ? { id: null, t: 0 } : { id: card.id, t: now };
    selected = twice || selected !== card.id ? card.id : null;
    render();
    if (twice) playCard(card);
  });
  $('#btn-play').onclick = () => {
    const card = selected && S.game.hand.find((c) => c.id === selected);
    if (card) playCard(card);
  };
  $('#btn-pass').onclick = () => {
    socket.emit('pass', {}, (res) => {
      if (res && res.error) notPlayable(null, res.error);
      else selected = null;
    });
  };

  /* ================= players strip ================= */
  const SILHOUETTE = '<svg viewBox="0 0 50 52" aria-hidden="true"><path d="M25 3c-7.3 0-12 5.2-12 12.6 0 4.6 1.9 8.6 4.8 11-6.9 2.2-12.8 7.6-13.8 16.4L4 52h42l-.1-9c-1-8.8-6.9-14.2-13.8-16.4 2.9-2.4 4.8-6.4 4.8-11C36.9 8.2 32.3 3 25 3z"/></svg>';
  function timerLeft() {
    const g = S.game;
    if (!S.settings.turnTimer || g.phase !== 'playing' || !g.turnStartedAt) return null;
    const now = S.pausedAt || Date.now() + clockOffset; // the clock stands still while the game is paused
    const ms = S.settings.turnTimer * 1000 - (now - g.turnStartedAt);
    return Math.max(0, Math.ceil(ms / 1000));
  }
  function renderOpponents() {
    const g = S.game;
    const ids = g.order.length ? g.order : g.players.map((p) => p.id);
    const conn = Object.fromEntries(S.members.map((m) => [m.id, m.connected]));
    // Players see everyone else, starting with the next player after them; the admin sees everyone.
    let list = ids.map((id) => g.players.find((p) => p.id === id)).filter(Boolean);
    const k = list.findIndex((p) => p.id === S.you);
    if (k >= 0) list = [...list.slice(k + 1), ...list.slice(0, k)];
    const t = timerLeft();
    const el = $('#opponents');
    el.classList.toggle('empty', !list.length);
    el.innerHTML = list.map((p) => {
      const turn = g.current === p.id;
      const off = conn[p.id] === false;
      // The host can remove a dropped player: the whole tile is the button, so it is easy to hit.
      const removable = off && isHost() && gameRunning();
      const btn = removable ? ` role="button" tabindex="0" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}. They are offline."` : '';
      return `<div class="opp ${turn ? 'turn' : ''} ${off ? 'off' : ''} ${removable ? 'removable' : ''}"${btn}>
        <div class="on">${esc(p.name)}${isBot(p.id) ? ' 🤖' : ''}${turn && t != null ? ` · ${t}s` : ''}</div>
        <div class="row"><span class="av">${SILHOUETTE}<i class="dot" style="background:${colorOf(p.id)}">${initialOf(p.id)}</i></span>
          <span class="pill">${p.count} Card${p.count === 1 ? '' : 's'} Left</span></div>
        ${turn && t != null ? `<i class="tbar${t <= 10 ? ' hurry' : ''}" style="--left:${Math.max(0, Math.min(1, t / S.settings.turnTimer))}" aria-hidden="true"></i>` : ''}
        ${p.skips ? `<span class="badge">Skips next${p.skips > 1 ? ' ×' + p.skips : ''}</span>` : off ? '<span class="badge off">Offline</span>' : ''}
        ${removable ? '<span class="rm" aria-hidden="true">Remove</span>' : ''}
      </div>`;
    }).join('') || 'Waiting for the toss…';
  }
  async function removeDropped(e) {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    if (await ask(`Remove ${nameOf(b.dataset.remove)}?`, 'They have dropped out. Their unplayed cards go back into the box.', 'Remove')) {
      socket.emit('kick', { id: b.dataset.remove }, ack);
    }
  }
  $('#opponents').addEventListener('click', removeDropped);
  $('#opponents').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-remove]')) { e.preventDefault(); removeDropped(e); }
  });
  $('#admin-panel').addEventListener('click', removeDropped);
  // The teacher pauses, resumes or ends the game in progress.
  $('#admin-panel').addEventListener('click', async (e) => {
    if (e.target.closest('#btn-pause')) socket.emit('pause', { on: !S.pausedAt }, ack);
    if (e.target.closest('#btn-end') && await ask('End this game?', 'Nobody wins. Everyone goes back to the waiting room.', 'End the game')) {
      socket.emit('endGame', {}, ack);
    }
  });
  socket.on('notice', ({ text }) => toast(esc(text), 'warn', 4000));

  function renderTray() {
    const g = S.game;
    $('#tray-count').textContent = g.trayCount;
    const st = $('#series-tag');
    st.hidden = S.series.target <= 1;
    st.textContent = `Game ${g.phase === 'over' ? S.series.games : S.series.games + 1} of ${S.series.target}`;
  }

  /* ================= hand (arrival order; press and hold, then drag, to rearrange) ================= */
  const handSeen = new Set();
  let localOrder = null;
  function orderedHand() {
    const hand = S.game.hand;
    if (!localOrder) return hand;
    const byId = new Map(hand.map((c) => [c.id, c]));
    const out = localOrder.filter((id) => byId.has(id)).map((id) => byId.get(id));
    for (const c of hand) if (!localOrder.includes(c.id)) out.push(c);
    return out;
  }
  function renderHand() {
    if (drag) { handDirty = true; return; }
    const g = S.game;
    const hand = orderedHand();
    if (selected && !hand.some((c) => c.id === selected)) selected = null;
    const track = $('#hand');
    layoutHand(track, hand.length);
    if (!hand.length) {
      const inGame = g.players.some((p) => p.id === S.you);
      track.innerHTML = `<div class="empty-hand">${inGame ? (g.phase === 'over' ? 'No cards left!' : 'Dealing…') : 'You are watching this game.'}</div>`;
      updateArrows();
      return;
    }
    const newCards = hand.filter((c) => !handSeen.has(c.id)).map((c) => c.id);
    track.innerHTML = hand.map((c) => {
      const chk = checkCard(c);
      const cls = hints() && g.phase === 'playing' ? [chk.ok ? 'playable' : 'blocked'] : [];
      if (c.id === selected) cls.push('selected');
      if (c.id === g.lastDrawn && g.phase === 'playing') cls.push('new');
      if (newCards.includes(c.id)) cls.push('enter');
      return cardHTML(c, { tag: 'button', cls: cls.join(' '), attrs: `data-id="${c.id}" aria-label="${esc(cardAlt(c))}" aria-pressed="${c.id === selected}"` });
    }).join('');
    hand.forEach((c) => handSeen.add(c.id));
    // Bring a newly drawn card into view (not on the deal, so the first cards stay in sight).
    if (newCards.length === 1 && !track.classList.contains('fits')) {
      const el = $(`#hand .card[data-id="${newCards[newCards.length - 1]}"]`);
      if (el && gridHand()) track.scrollTop = el.offsetTop - track.offsetTop - 8;
      else if (el) track.scrollLeft = el.offsetLeft;
    }
    updateArrows();
  }
  // Up to 4 cards: the design's big cards with wide gaps. More: the gaps close, then the cards get
  // smaller (down to the card art's own size), then they overlap a little. Up to 10 cards fit; more scroll.
  const HAND = { room: 740, w: 130, gap: 71, minW: 100, minGap: 12, minStep: 65 };
  let handStep = HAND.w + HAND.gap;
  function layoutHand(track, n) {
    // Landscape: a grid of three columns (app.css); nine cards show at once, more scroll.
    if (stage.classList.contains('land')) { track.classList.toggle('fits', n <= 9); return; }
    // Tall phone: five columns; two rows always show, a third if there is room.
    if (stage.classList.contains('tall')) { track.classList.toggle('fits', n <= 10); return; }
    let w = HAND.w, step = HAND.w + HAND.gap;
    if (n > 4) {
      w = Math.min(HAND.w, Math.max(HAND.minW, (HAND.room - HAND.minGap * (n - 1)) / n));
      step = Math.max(HAND.minStep, Math.min(w + HAND.minGap, (HAND.room - w) / (n - 1)));
    }
    handStep = step;
    track.style.setProperty('--cw', `${w.toFixed(1)}px`);
    track.style.setProperty('--gap', `${(step - w).toFixed(1)}px`);
    track.classList.toggle('fits', w + (n - 1) * step <= HAND.room + 1);
  }
  function updateArrows() {
    const t = $('#hand');
    $('#hand-left').disabled = t.scrollLeft <= 2;
    $('#hand-right').disabled = t.scrollLeft + t.clientWidth >= t.scrollWidth - 2;
  }
  $('#hand').addEventListener('scroll', updateArrows, { passive: true });
  $('#hand-left').onclick = () => $('#hand').scrollBy({ left: -3 * handStep });
  $('#hand-right').onclick = () => $('#hand').scrollBy({ left: 3 * handStep });

  function sendOrder(ids) {
    if (ids.join() === S.game.hand.map((c) => c.id).join()) { localOrder = null; return; }
    localOrder = ids;
    socket.emit('reorder', { ids }, (res) => {
      if (res && res.error) toast(esc(res.error), 'err');
      localOrder = null;
      render();
    });
  }
  let drag = null, pending = null, handDirty = false, suppressClick = false;
  function cancelPending() { if (pending && pending.timer) clearTimeout(pending.timer); pending = null; }
  function beginDrag(x, y) {
    const src = $(`#hand .card[data-id="${pending.id}"]`);
    const touch = pending.touch;
    cancelPending();
    if (!src) return;
    const r = src.getBoundingClientRect();
    const ghost = src.cloneNode(true);
    ghost.classList.remove('enter', 'selected', 'new');
    ghost.classList.add('drag-ghost');
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    document.body.appendChild(ghost);
    src.classList.add('drag-source');
    $('#hand').style.scrollSnapType = 'none';
    drag = { src, ghost, dx: x - r.left, dy: y - r.top };
    if (touch && navigator.vibrate) navigator.vibrate(15);
    moveDrag(x, y);
  }
  function moveDrag(x, y) {
    const { src, ghost, dx, dy } = drag;
    ghost.style.left = `${x - dx}px`;
    ghost.style.top = `${y - dy}px`;
    const track = $('#hand');
    const others = $$('#hand .card[data-id]').filter((el) => el !== src);
    // One row (portrait): the first card whose middle is right of the finger. Grid (landscape, phone): reading order.
    const grid = gridHand();
    const before = others.find((el) => {
      const r = el.getBoundingClientRect();
      return grid ? y < r.top || (y < r.bottom && x < r.left + r.width / 2) : x < r.left + r.width / 2;
    });
    if (before ? src.nextElementSibling !== before : track.lastElementChild !== src) track.insertBefore(src, before || null);
    const hr = track.getBoundingClientRect();
    if (grid) {
      if (y < hr.top + 40) track.scrollTop -= 12;
      else if (y > hr.bottom - 40) track.scrollTop += 12;
    } else if (x < hr.left + 40) track.scrollLeft -= 12;
    else if (x > hr.right - 40) track.scrollLeft += 12;
  }
  function endDrag() {
    if (!drag) { cancelPending(); return; }
    const ids = $$('#hand .card[data-id]').map((el) => el.dataset.id);
    drag.ghost.remove();
    drag.src.classList.remove('drag-source');
    $('#hand').style.scrollSnapType = '';
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
    pending = { id: el.dataset.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: e.pointerType !== 'mouse', timer: null };
    if (pending.touch) pending.timer = setTimeout(() => { if (pending) beginDrag(pending.x, pending.y); }, 350);
  });
  window.addEventListener('pointermove', (e) => {
    if (drag) { e.preventDefault(); moveDrag(e.clientX, e.clientY); return; }
    if (!pending || e.pointerId !== pending.pointerId) return;
    const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (pending.touch) { if (dist > 10) cancelPending(); return; }
    if (dist > 6) beginDrag(e.clientX, e.clientY);
  }, { passive: false });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  $('#hand').addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  $('#hand').addEventListener('contextmenu', (e) => { if (e.target.closest('.card')) e.preventDefault(); });

  /* ================= the bottom of the game screen ================= */
  let hurryWarned = null;
  function renderControls() {
    const g = S.game;
    const admin = amAdmin();
    $('#hand-panel').hidden = admin;
    $('#admin-panel').hidden = !admin;
    const mine = myTurn();
    const t = timerLeft();
    const you = $('#you-label');
    you.parentElement.classList.toggle('turn', mine);
    const n = g.hand.length;
    const count = g.players.some((p) => p.id === S.you) && g.phase !== 'toss' ? ` · ${n} card${n === 1 ? '' : 's'}` : '';
    you.textContent = admin ? 'Admin view' : mine ? `Your turn!${count}${t != null ? ` · ${t}s` : ''}` : `You${count}`;
    you.style.color = '';
    // Turn timer: the lines beside "Your turn!" run down; orange and one warning for the last 10 seconds.
    const row = you.parentElement;
    const timed = mine && t != null;
    row.classList.toggle('timed', timed);
    row.classList.toggle('hurry', timed && t <= 10);
    if (timed) {
      row.style.setProperty('--left', String(Math.max(0, Math.min(1, t / S.settings.turnTimer))));
      const turnKey = `${S.gameNo}:${g.turnStartedAt}`;
      if (t <= 10 && t > 0 && hurryWarned !== turnKey) {
        hurryWarned = turnKey;
        toast('10 seconds left! Then a card is played for you.', 'warn', 3000);
      }
    }

    const play = $('#btn-play'), pass = $('#btn-pass'), res = $('#btn-show-results');
    const over = g.phase === 'over';
    res.hidden = !over;
    play.hidden = over || admin;
    pass.hidden = over || admin || !mine || g.firstMove;
    const card = selected && g.hand.find((c) => c.id === selected);

    if (admin) {
      const off = g.players.filter((p) => S.members.some((m) => m.id === p.id && !m.connected));
      const offRow = off.length && !over
        ? `<div class="row"><p>Offline:</p>${off.map((p) => `<button class="btn secondary" data-remove="${p.id}">Remove ${esc(p.name)}</button>`).join('')}</div>`
        : `<p>${off.length ? `Offline: ${off.map((p) => esc(p.name)).join(', ')}.` : 'Everyone is connected.'}</p>`;
      const paused = !!S.pausedAt;
      const title = over ? 'The game is over' : g.phase === 'toss' ? 'Tossing for the first turn…'
        : paused ? 'The game is paused' : `${esc(nameOf(g.current))} is playing`;
      const ctl = over ? '' : `${g.phase === 'playing' ? `<button class="btn secondary" id="btn-pause">${paused ? 'Resume' : 'Pause'}</button>` : ''}
        <button class="btn danger" id="btn-end">End the game</button>`;
      const html = `
        <div class="row head"><h3>${title}</h3>${ctl}</div>
        <p>Game code <b>${esc(S.code)}</b> · ${g.players.length} players · hints ${S.settings.hints ? 'on' : 'off'} · ${S.settings.turnTimer ? `${S.settings.turnTimer} s per turn` : 'no timer'}</p>
        ${offRow}`;
      // Rebuilt every second while a timer runs; only touch the DOM when something changed.
      if ($('#admin-panel').dataset.html !== html) { $('#admin-panel').dataset.html = html; $('#admin-panel').innerHTML = html; }
      setStatus('');
      return;
    }
    const canPlay = g.hand.some((c) => checkCard(c).ok);
    const online = socket.connected && !S.pausedAt;
    pass.disabled = !online || !mine || (hints() && canPlay);

    let msg = '';
    let playable = false;
    if (card) {
      const chk = checkCard(card);
      if (card.type === 'num') {
        const n = card.n;
        const what = n === 1 ? '<b>1</b> is the UNIQUE card. It starts the game.'
          : R.isPrime(n) ? `<b>${n}</b> is a prime number.` : `<b>${n} = ${chk.factors.join(' × ')}</b>`;
        if (!hints()) msg = what;
        else msg = chk.ok ? `${what} <span class="ok">It can be played.</span>`
          : chk.missing && chk.missing.length ? `${what} <span class="no">It still needs ${chk.missing.join(', ')} on the board.</span>` : `<span class="no">${esc(chk.reason)}</span>`;
        playable = mine && (chk.ok || !hints());
      } else if (card.type === 'magic') {
        msg = !chk.ok ? `<span class="no">${esc(chk.reason)}</span>`
          : mine ? '<b>MAGIC</b>: tap a <span class="ok">glowing</span> prime slot on the board.' : '<b>MAGIC</b> counts as any prime. It goes on an empty prime slot.';
        playable = mine;
      } else {
        msg = '<b>SKIP</b> makes a player miss their next turn. They still draw a card.';
        playable = mine && (chk.ok || !hints());
      }
      if (!mine) msg += ' Wait for your turn.';
    } else if (g.phase === 'toss') msg = 'Tossing to see who goes first…';
    else if (over) msg = 'The game is over.';
    else if (mine) msg = g.firstMove ? '<b>You won the toss!</b> Tap your <b>1</b> card twice to play it.'
      : hints() && !canPlay ? 'None of your cards can be played. Tap <b>Pass</b>.'
      : 'Tap a card twice to play it. Pass only if no card can be played.';
    else msg = `Waiting for <b>${esc(nameOf(g.current))}</b>…`;
    play.disabled = !playable || !online;
    play.textContent = card && card.type === 'skip' && playable && g.order.length > 2 ? 'Skip…' : 'Play';
    setStatus(mine && !card ? `<span class="sr">Your turn. </span>${msg}` : msg);
  }
  // The status line is read out by screen readers, so only change it when the words change
  // (the controls are redrawn every second while a turn timer runs).
  function setStatus(html) {
    const el = $('#status');
    if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
  }
  $('#btn-show-results').onclick = () => { viewBoardFor = null; render(); };

  /* ================= events → animations & sounds ================= */
  let seenGameNo = null, lastSeq = 0, prevCurrent = null, clockOffset = 0;
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
          say(onTop ? `✦ ${who} played MAGIC on top of <b>${sl.n}</b>` : `✦ ${who} played MAGIC as <b>${sl.n}</b>`);
        } else if (ev.card.type === 'skip') {
          sfx.skip();
          if (ev.target === S.you) say(`${who} played SKIP on you. You miss your next turn.`, 'warn', 3500);
          else say(`${who} played SKIP on <b>${esc(nameOf(ev.target))}</b>`, 'warn');
        } else {
          sfx.play();
          if (ev.playerId !== S.you) say(`${who} played <b>${ev.card.n}</b>`, '', 1600);
        }
        if (ev.auto && ev.playerId === S.you) say('Time is up. A card was played for you.', 'warn', 3500);
      }
      if (ev.type === 'draw') {
        const t = $('#tray-count');
        t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump');
        if (ev.playerId === S.you) sfx.draw();
      }
      if (ev.type === 'pass' && ev.playerId !== S.you) say(`${who} passed`, '', 1400);
      if (ev.type === 'pass' && ev.auto && ev.playerId === S.you) say('Time is up. You had no card to play, so you passed.', 'warn', 3500);
      if (ev.type === 'skipped') say(`${ev.playerId === S.you ? 'Your' : esc(nameOf(ev.playerId)) + "'s"} turn was skipped`, 'warn');
      if (ev.type === 'over') {
        if (ev.winners.includes(S.you)) { sfx.win(); confetti(); } else sfx.lose();
      }
    }
    if (g.current !== prevCurrent) {
      prevCurrent = g.current;
      if (myTurn()) sfx.turn();
    }
    setTimeout(() => S && S.game && screen === 'game' && renderBoard(), 950);
  }

  /* ================= toss ================= */
  let tossShownFor = null;
  function runToss() {
    const g = S.game;
    if (tossShownFor === S.gameNo) return;
    tossShownFor = S.gameNo;
    $('#toss-overlay').hidden = false;
    const grid = $('#toss-grid');
    grid.innerHTML = g.players.map((p) => `
      <div class="toss-p" data-p="${p.id}">
        <div class="flip"><div class="flip-inner"><div class="face back">${cardHTML(BACK)}</div><div class="face front"></div></div></div>
        <div class="nm">${esc(p.id === S.you ? 'You' : p.name)}</div>
      </div>`).join('');
    $('#toss-result').textContent = '';
    $('#toss-sub').textContent = 'Everyone draws a card. The smallest number goes first!';
    const tile = (id) => grid.querySelector(`[data-p="${id}"]`);
    g.toss.rounds.forEach((r, ri) => {
      setTimeout(() => {
        const ids = Object.keys(r.draws);
        if (ri > 0) {
          $('#toss-sub').textContent = `Tie! ${ids.map((id) => nameOf(id)).join(' & ')} draw again.`;
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
            if (tile(w)) tile(w).classList.add('win');
            $('#toss-result').textContent = `${w === S.you ? 'You drew' : nameOf(w) + ' drew'} the smallest card (${r.min}) and ${w === S.you ? 'get' : 'gets'} the 1!`;
            sfx.win();
          }
        }, 500 + ids.length * 260 + 900);
      }, ri * 3200);
    });
  }

  /* ================= results ================= */
  let viewBoardFor = null;      // the player chose "View the final board" for this game
  let resView = { gameNo: null, view: 'game' };
  let seriesCheered = null;
  const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4) % 4]}`;
  function standings() {
    const ser = S.series;
    const rows = Object.keys(ser.totals).map((id) => {
      const m = S.members.find((x) => x.id === id);
      return { id, name: m ? m.name : `${ser.names[id] || 'Player'} (left)`, total: ser.totals[id] };
    }).sort((a, b) => a.total - b.total || a.name.localeCompare(b.name));
    rows.forEach((r, i) => { r.rank = i > 0 && r.total === rows[i - 1].total ? rows[i - 1].rank : i + 1; });
    // Only the winner gets a tag; everyone else just has their rank (the owner dropped "Loser", 2026-10-12).
    if (rows.length) rows.forEach((r) => { r.winner = r.total === rows[0].total; });
    return rows;
  }
  function renderResults() {
    show('results');
    const g = S.game;
    const ser = S.series;
    const multi = ser.target > 1;
    const final = multi && ser.done;
    if (resView.gameNo !== S.gameNo) resView = { gameNo: S.gameNo, view: final ? 'series' : 'game' };
    if (!final) resView.view = 'game';
    const seriesView = resView.view === 'series';
    $('#res-code').innerHTML = codeBoxes(S.code);
    const label = (id, name) => (id === S.you ? `${name} (you)` : name);

    if (!seriesView) {
      const res = g.result;
      const iWon = res.winners.includes(S.you);
      const names = res.winners.map((id) => nameOf(id));
      $('#res-title').textContent = iWon ? (res.winners.length > 1 ? 'Congrats! You share the win!' : 'Congrats! You won!') : `${names.join(' & ')} won!`;
      const why = res.reason === 'out' ? `${iWon ? 'You' : names.join(' & ')} played every card first.`
        : res.reason === 'blocked' ? 'Nobody could play, so the lowest score wins.' : 'Everyone else left the game.';
      $('#res-sub').textContent = `${multi ? `Game ${ser.games} of ${ser.target}. ` : ''}${why}${iWon ? '' : ' Lower score is better.'}`;
      // The winner comes first, with a tag; then everyone else, lowest score first.
      const score = (p) => res.scores[p.id] ?? 0;
      const rows = [
        ...g.players.filter((p) => res.winners.includes(p.id)).map((p) => ({ p, s: score(p), win: true })),
        ...g.players.filter((p) => !res.winners.includes(p.id)).map((p) => ({ p, s: score(p) })).sort((a, b) => a.s - b.s),
      ];
      $('#res-players').innerHTML = rows.map(({ p, s, win }) => `
        <div class="pp ${p.id === S.you ? 'me' : ''}">${win ? '<span class="tag win">🏆 Winner</span>' : ''}${namePill(label(p.id, p.name))}<div class="sc">${s}</div>
          ${multi ? `<div class="tot">Total ${ser.totals[p.id] ?? s}</div>` : ''}</div>`).join('');
    } else {
      const st = standings();
      const champs = st.filter((r) => r.winner);
      const iChamp = champs.some((r) => r.id === S.you);
      $('#res-title').textContent = iChamp ? (champs.length > 1 ? 'Congrats! You share the series!' : 'Congrats! You won the series!')
        : `${champs.map((r) => r.name).join(' & ')} won the series!`;
      $('#res-sub').textContent = `${ser.target} games played. Scores added up; the lowest total wins.`;
      $('#res-players').innerHTML = st.map((r) => `
        <div class="pp ${r.id === S.you ? 'me' : ''}">
          <span class="tag ${r.winner ? 'win' : ''}">${r.winner ? '🏆 ' : ''}${ordinal(r.rank)}</span>
          ${namePill(label(r.id, r.name))}<div class="sc">${r.total}</div></div>`).join('');
      if (seriesCheered !== S.gameNo) { seriesCheered = S.gameNo; if (iChamp) { sfx.win(); confetti(); } }
    }
    // Three rows of players: a tighter sheet, so the buttons stay on the screen.
    $('#scr-results').classList.toggle('many', $('#res-players').children.length > 4);

    let actions;
    if (isHost()) {
      const next = multi && !ser.done ? `Start game ${ser.games + 1} of ${ser.target}` : multi ? 'Start a new series' : 'Play again';
      actions = `<button class="btn" id="btn-again">${next}</button><button class="btn secondary" id="btn-home">Home</button>`;
    } else if (multi && !ser.done) {
      // Between the games of a series the players stay (the set of players is fixed).
      actions = `<p class="wait-msg">Game ${ser.games + 1} of ${ser.target} will start soon.</p>`;
    } else {
      actions = '<button class="btn" id="btn-home">Home</button>';
    }
    $('#res-actions').innerHTML = actions;
    const again = $('#btn-again');
    if (again) again.onclick = () => socket.emit('start', {}, ack);
    // Home: the teacher or host goes back to the waiting room (the same code can be used again);
    // a player leaves the game and goes to the first screen (owner, 2026-10-13).
    $('#btn-home').onclick = async () => {
      if (isHost()) return socket.emit('lobby', {}, ack);
      const res = await call('leave', {});
      if (res.error) return ack(res);
      goHome('', { first: true });
    };
    const toggle = $('#btn-res-toggle');
    toggle.hidden = !final;
    toggle.textContent = seriesView ? `See game ${ser.games}` : 'See the series result';
  }
  $('#btn-res-toggle').onclick = () => { resView.view = resView.view === 'series' ? 'game' : 'series'; render(); };
  $('#btn-view-board').onclick = () => { viewBoardFor = S.gameNo; render(); };

  /* ================= rules pop-up ================= */
  $$('[data-open-rules]').forEach((b) => b.onclick = () => { $('#rules-overlay').hidden = false; });
  let rulesShown = false;
  function firstGameRules() {
    if (rulesShown || amAdmin() || store.get('pt_rules_seen') || S.game.phase !== 'playing') return;
    rulesShown = true;
    store.set('pt_rules_seen', true);
    $('#rules-overlay').hidden = false;
  }
  $('#rules-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'rules-overlay' || e.target.closest('[data-close]')) $('#rules-overlay').hidden = true;
  });

  /* ================= chat and moves ================= */
  let chatSeen = null, chatTab = 'chat';
  const chatName = (m) => (S.admin && m.id === S.admin.id ? 'Teacher' : m.name);
  function renderChat() {
    if (!S) return;
    const last = S.chat.length ? S.chat[S.chat.length - 1].t : 0;
    if (chatSeen === null) chatSeen = last; // messages from before you arrived are not "new"
    const open = !$('#chat-overlay').hidden;
    if (open && chatTab === 'chat') chatSeen = last;
    const unread = S.chat.filter((m) => m.t > chatSeen && m.id !== S.you).length;
    for (const b of $$('.chat-badge')) { b.hidden = !unread; b.textContent = unread > 9 ? '9+' : unread; }
    for (const b of $$('[data-open-chat]')) b.setAttribute('aria-label', `Chat${S.game ? ' and moves' : ''}${unread ? `, ${unread} new` : ''}`);
    $('#tab-log').hidden = !S.game;
    if (!open) return;
    const list = $('#chat-list');
    const html = S.chat.map((m) => `<li class="${m.id === S.you ? 'me' : ''}"><b>${esc(m.id === S.you ? 'You' : chatName(m))}:</b> ${esc(m.text)}</li>`).join('')
      || '<li class="muted">No messages yet. Say hello!</li>';
    if (list.dataset.html !== html) { list.dataset.html = html; list.innerHTML = html; list.scrollTop = list.scrollHeight; }
    const log = $('#log-list');
    const lhtml = S.game ? S.game.log.map((l) => `<li class="${esc(l.kind)}">${esc(l.text)}</li>`).join('') : '';
    if (log.dataset.html !== lhtml) { log.dataset.html = lhtml; log.innerHTML = lhtml || '<li class="muted">No moves yet.</li>'; log.scrollTop = log.scrollHeight; }
  }
  function chatShowTab(tab) {
    chatTab = tab === 'log' && S && S.game ? 'log' : 'chat';
    for (const t of $$('#chat-overlay [role=tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === chatTab));
    $('#pane-chat').hidden = chatTab !== 'chat';
    $('#pane-log').hidden = chatTab !== 'log';
    renderChat();
  }
  $$('[data-open-chat]').forEach((b) => b.onclick = () => {
    $('#chat-overlay').hidden = false;
    chatShowTab(chatTab);
    if (chatTab === 'chat') $('#chat-input').focus({ preventScroll: true });
  });
  $$('#chat-overlay [role=tab]').forEach((t) => t.onclick = () => chatShowTab(t.dataset.tab));
  $('#chat-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'chat-overlay' || e.target.closest('[data-close]')) { $('#chat-overlay').hidden = true; renderChat(); }
  });
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text) return;
    socket.emit('chat', { text }, ack);
    $('#chat-input').value = '';
  });

  /* ================= main render ================= */
  function render() {
    if (!S) return;
    const g = S.game;
    renderChat();
    if (!g) {
      $('#toss-overlay').hidden = true;
      $('#pause-overlay').hidden = true;
      if (screen === 'admin-control') return; // the admin is editing the settings
      renderWaiting();
      return;
    }
    $('#timeup-overlay').hidden = true;
    if (g.phase === 'over' && viewBoardFor !== S.gameNo) { $('#toss-overlay').hidden = true; $('#pause-overlay').hidden = true; renderResults(); return; }
    show('game');
    if (g.phase === 'toss') runToss(); else $('#toss-overlay').hidden = true;
    $('#pause-overlay').hidden = !(S.pausedAt && g.phase === 'playing' && !amAdmin());
    paintSound();
    renderTray();
    renderOpponents();
    renderBoard();
    if (!amAdmin()) renderHand();
    renderControls();
    firstGameRules();
  }

  socket.on('state', (state) => {
    clockOffset = state.now - Date.now();
    const first = !S;
    useAssetVersion(state.assetV);
    const prevGame = S && S.gameNo;
    S = state;
    if (S.game) processEvents();
    if (prevGame !== S.gameNo) viewBoardFor = null;
    if (first) for (const e of $$('.form-error')) e.textContent = '';
    // A new state while the admin edits settings must not pull them off the form,
    // unless a game has started.
    if (first && screen === 'admin-control') show('waiting');
    render();
  });

  setInterval(() => {
    if (S && S.game && S.settings.turnTimer && screen === 'game') { renderOpponents(); renderControls(); }
    if (S && screen === 'waiting') renderJoinClock();
  }, 1000);
})();
