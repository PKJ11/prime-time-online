/*
 * Prime Time Online — multiplayer server.
 * Express serves the client; Socket.IO carries game traffic. All game state lives here.
 */
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game, GameError, SKIP_MIN, SKIP_MAX } = require('./game');
const accounts = require('./accounts');
const words = require('./wordfilter');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const DISCONNECT_AUTOPASS_MS = 20_000;   // a disconnected player's turn is auto-passed after this
const LOBBY_DROP_MS = 120_000;           // disconnected players are dropped from a lobby after this
const HOST_GRACE_MS = 30_000;            // host role moves to someone else after this long offline
// School games wait this long for students to join, then start with those who came (owner, 2026-10-13).
// The teacher can add another minute. JOIN_WAIT_MS shortens it for the tests.
const joinWaitMs = () => Number(process.env.JOIN_WAIT_MS) || 60_000;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;  // rooms are deleted after 6h of inactivity

const app = express();
// Behind a reverse proxy (nginx, Render…) set TRUST_PROXY=1 so the log-in limit counts each visitor's
// own address, not the proxy's (which would make every teacher share one limit).
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8kb' }));

// Fingerprint of the artwork. Clients add it to image URLs (?v=…), so replacing any board or card
// image can never leave an open page showing a stale copy from its cache.
const ASSET_VERSION = (() => {
  const dir = path.join(__dirname, 'public', 'assets');
  const files = ['board.webp', ...['cards', 'ui'].flatMap((d) => fs.readdirSync(path.join(dir, d)).sort().map((f) => path.join(d, f)))];
  const h = crypto.createHash('sha1');
  for (const f of files) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex').slice(0, 10);
})();
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ---------- admin (teacher) accounts ---------- */
// A few attempts per minute per address, so passwords can't be guessed by brute force (10; the tests allow more).
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > (Number(process.env.ADMIN_TRIES_PER_MIN) || 10);
}
function accountRoute(fn) {
  return (req, res) => {
    if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    try { res.json(fn(req.body || {})); } catch (e) {
      if (e instanceof accounts.AccountError) return res.status(400).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  };
}
app.post('/api/admin/signup', accountRoute((b) => accounts.signup(b)));
// Tells the sign-up form whether to ask for the sign-up code (never the code itself).
app.get('/api/admin/config', (_req, res) => res.json({ signupCode: accounts.needsSignupCode(), resetEmail: mailReady() }));
app.post('/api/admin/login', accountRoute((b) => accounts.login(b)));

/* ---------- "Forgot password?": a reset link by email ----------
 * Works once the server has SMTP_HOST and PUBLIC_URL (see DEPLOY.md); until then the form shows a
 * message instead. MAIL_OUTBOX_DIR writes the emails to a folder instead of sending them (for testing).
 * The settings are read on every call, so changing them needs no code change.
 */
let mailer = null, mailerKey = '';
const mailReady = () => !!((process.env.SMTP_HOST || process.env.MAIL_OUTBOX_DIR) && process.env.PUBLIC_URL);
function sendMail(msg) {
  const env = process.env;
  if (env.MAIL_OUTBOX_DIR) {
    fs.mkdirSync(env.MAIL_OUTBOX_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.MAIL_OUTBOX_DIR, `${Date.now()}-${rid(3)}.json`), JSON.stringify(msg, null, 2));
    return Promise.resolve();
  }
  const key = [env.SMTP_HOST, env.SMTP_PORT, env.SMTP_SECURE, env.SMTP_USER, env.SMTP_PASS].join('|');
  if (!mailer || key !== mailerKey) {
    const port = Number(env.SMTP_PORT) || 587;
    mailer = require('nodemailer').createTransport({
      host: env.SMTP_HOST, port, secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    mailerKey = key;
  }
  return mailer.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, ...msg });
}
const lastReset = new Map(); // email -> time of its last reset email (at most one every 2 minutes)
app.post('/api/admin/forgot', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
  if (!mailReady()) return res.status(400).json({ error: 'Password reset by email is not set up yet. Please ask the person who runs this site.' });
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter your email first.' });
  // The answer is the same whether or not the account exists, so the form can't be used to find accounts.
  res.json({ ok: true });
  const token = accounts.resetToken(email);
  if (!token || Date.now() - (lastReset.get(email) || 0) < 120_000) return;
  lastReset.set(email, Date.now());
  const link = `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/?reset=${token}`;
  const mins = accounts.RESET_MINUTES;
  sendMail({
    to: email,
    subject: 'Reset your Prime Time password',
    text: `Hello,\n\nSomeone asked to reset the password of your Prime Time teacher account (${email}).\n\n`
      + `To choose a new password, open this link within ${mins} minutes:\n${link}\n\n`
      + 'If you did not ask for this, you can ignore this email. Your password stays the same.\n',
    html: `<p>Hello,</p><p>Someone asked to reset the password of your Prime Time teacher account (${email}).</p>`
      + `<p><a href="${link}">Choose a new password</a> (the link works for ${mins} minutes).</p>`
      + '<p>If you did not ask for this, you can ignore this email. Your password stays the same.</p>',
  }).catch((e) => console.error('Reset email failed:', e.message));
});
app.post('/api/admin/reset', accountRoute((b) => accounts.resetPassword(b)));
app.get('/api/admin/me', (req, res) => {
  const a = accounts.verify(String(req.get('authorization') || '').replace(/^Bearer /, ''));
  if (!a) return res.status(401).json({ error: 'Please log in again.' });
  res.json({ admin: a });
});
const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, any>} */
const rooms = new Map();

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
// Classic rooms get 5 letters; rooms an admin creates get 6 digits (easy to type on a tablet).
function newCode(digits = false) {
  const A = digits ? '0123456789' : 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < (digits ? 6 : 5); i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c) && !words.isRude(c)) return c;
  }
}
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';
const NAME_REFUSED = 'Please choose a different name.';
const cleanGrade = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 12);

/*
 * A series is a fixed number of games played by the same set of people. Scores add up; the lowest
 * total wins and the highest total comes last. `target` is fixed when the first game starts.
 */
const SERIES_MAX = 9;
const newSeries = (target = 1) => ({ games: 0, target, totals: {}, history: [], names: {} });
const seriesRunning = (room) => room.series.games > 0 && room.series.games < room.series.target;
const seriesDone = (room) => room.series.games > 0 && room.series.games >= room.series.target;

/*
 * Two kinds of room:
 *  - classic: the host is one of the players (created from /classic).
 *  - admin: a signed-in admin (e.g. a teacher) creates the room and runs it without playing;
 *    `room.admin` holds that connection and `hostId` points at it. Players join with name, grade and code.
 */
function createRoom({ admin = null } = {}) {
  const room = {
    code: newCode(!!admin),
    hostId: null,
    admin,                             // {id, token, name, email, school, socketId, connected, lastSeen} or null
    players: [],                       // {id, token, name, grade, socketId, connected, lastSeen}
    settings: { hints: false, turnTimer: 0, skips: SKIP_MIN, seriesGames: 1, maxPlayers: MAX_PLAYERS, grade: '' },
    game: null,
    gameNo: 0,
    series: newSeries(1),
    chat: [],
    lastActive: Date.now(),
  };
  if (admin) room.hostId = admin.id;
  rooms.set(room.code, room);
  return room;
}

function lobbyPlayer(room, p) {
  return { id: p.id, name: p.name, grade: p.grade || '', connected: p.connected, isHost: p.id === room.hostId, bot: !!p.bot };
}
const tableSize = (room) => (room.admin ? room.settings.maxPlayers : MAX_PLAYERS);

/* ---------- computer players ----------
 * Bots live on the server: always "connected", no socket. On a bot's turn it waits a moment
 * (so humans can follow along) and then makes the engine's rule-abiding automatic move.
 */
// Names for computer players, picked at random (owner's list, 2026-10-12).
const BOT_NAMES = ['Ross', 'Rachel', 'Joey', 'Phoebe', 'Sheldon', 'Penny', 'Monica', 'Rajesh', 'Amy', 'Bernadette', 'Howard',
  'Abdul Kalam', 'Siraj', 'Narendra', 'Shubman', 'Jaspreet', 'Surya', 'Girish', 'Leonard', 'Roger', 'Serena'];
const BOT_DELAY_MS = process.env.BOT_DELAY_MS ? [0, Number(process.env.BOT_DELAY_MS)] : [1200, 2200]; // think time
const humans = (room) => room.players.filter((p) => !p.bot);

function addBot(room) {
  const used = new Set(room.players.map((p) => p.name));
  const free = BOT_NAMES.filter((n) => !used.has(n));
  const name = free.length ? free[Math.floor(Math.random() * free.length)] : `Bot ${room.players.length + 1}`;
  const bot = { id: rid(4), token: null, name, connected: true, bot: true };
  room.players.push(bot);
  return bot;
}

function scheduleBot(room) {
  const g = room.game;
  if (!g || g.phase !== 'playing' || room.botTimer || room.paused) return;
  const cur = room.players.find((p) => p.id === g.currentId);
  if (!cur || !cur.bot) return;
  const turnNo = g.turnNo;
  const [lo, hi] = BOT_DELAY_MS;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.game !== g || g.phase !== 'playing' || g.turnNo !== turnNo || g.currentId !== cur.id) return;
    try { g.autoMove(cur.id); recordResult(room); } catch (e) { console.error(e); }
    broadcast(room);
  }, lo + Math.random() * (hi - lo));
}

function viewFor(room, p) {
  return {
    code: room.code,
    you: p.id,
    hostId: room.hostId,
    // In an admin room the admin watches and runs the table; they are never one of the players.
    admin: room.admin ? { id: room.admin.id, school: room.admin.school, connected: room.admin.connected } : null,
    settings: room.settings,
    members: room.players.map((x) => lobbyPlayer(room, x)),
    series: { ...room.series, running: seriesRunning(room), done: seriesDone(room) },
    chat: room.chat.slice(-50),
    game: room.game ? room.game.viewFor(p.id) : null,
    gameNo: room.gameNo,
    pausedAt: room.paused ? room.paused.at : null,
    joinUntil: room.joinUntil || null,   // school games: when the join time ends (see checkJoinTime)
    joinTimeUp: !!room.joinTimeUp,       // it ended with fewer than 2 players; the teacher decides
    assetV: ASSET_VERSION,
    now: Date.now(),
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', viewFor(room, p));
  }
  if (room.admin && room.admin.socketId) io.to(room.admin.socketId).emit('state', viewFor(room, room.admin));
  scheduleBot(room);
}

function recordResult(room) {
  const g = room.game;
  if (!g || g.phase !== 'over' || g._recorded) return;
  g._recorded = true;
  room.series.games++;
  for (const [id, s] of Object.entries(g.result.scores)) {
    room.series.totals[id] = (room.series.totals[id] || 0) + s;
    room.series.names[id] = g.player(id).name; // so someone removed later still shows in the standings
  }
  room.series.history.push({ scores: g.result.scores, winners: g.result.winners });
}

function ensureHost(room) {
  if (room.admin || room.players.some((p) => p.id === room.hostId)) return;
  const next = humans(room).find((p) => p.connected) || humans(room)[0];
  room.hostId = next ? next.id : null;
}

function removeMember(room, pid) {
  room.players = room.players.filter((p) => p.id !== pid);
  if (room.game && room.game.phase !== 'over') {
    room.game.removePlayer(pid);
    recordResult(room);
  }
  ensureHost(room);
  if (!keepsAlive(room)) deleteRoom(room); // bots never keep a room alive on their own
}
// A room stays open while it has a human player, or an admin running it.
const keepsAlive = (room) => !!room.admin || humans(room).length > 0;

function deleteRoom(room) {
  clearTimeout(room.botTimer);
  rooms.delete(room.code);
}

const gameRunning = (room) => !!(room.game && room.game.phase !== 'over');

/* ---------- pause (admin rooms) ----------
 * While paused nobody can move, computer players wait and turn timers stop. On resume the turn
 * clock moves forward by the paused time, so the player gets the rest of their turn.
 */
function setPaused(room, on) {
  const g = room.game;
  if (on && !room.paused) {
    room.paused = { at: Date.now() };
    clearTimeout(room.botTimer);
    room.botTimer = null;
  } else if (!on && room.paused) {
    // (a turn that began during the pause, e.g. after a removal, starts fresh rather than in the future)
    if (g && g.turnStartedAt) g.turnStartedAt = Math.min(Date.now(), g.turnStartedAt + Date.now() - room.paused.at);
    room.paused = null;
  }
}

function startGame(room) {
  // First game, or the previous series is complete: begin a fresh series with the chosen length.
  if (room.series.games === 0 || seriesDone(room)) room.series = newSeries(room.settings.seriesGames);
  const players = room.players.map((p) => ({ id: p.id, name: p.name }));
  room.game = new Game(players, { hints: room.settings.hints, skips: room.settings.skips });
  room.gameNo++;
  room.paused = null;
  room.joinUntil = null;
  room.joinTimeUp = false;
  const rounds = room.game.toss.rounds.length;
  const g = room.game;
  // Give clients time to animate the toss, then deal.
  setTimeout(() => {
    if (room.game !== g || g.phase !== 'toss') return;
    g.begin();
    broadcast(room);
  }, rounds * 3200 + 3400);
}

/*
 * School games: the first game starts by itself when every seat is taken, or when the join time
 * ends with 2 or more players. With fewer, the teacher is asked what to do (add a minute, or add
 * a computer player). Returns true when it started the game.
 */
function checkJoinTime(room, now = Date.now()) {
  if (!room.admin || room.game || room.gameNo || !(room.joinUntil || room.joinTimeUp)) return false;
  const n = room.players.length;
  if (n >= 2 && (n >= room.settings.maxPlayers || (room.joinUntil && now >= room.joinUntil))) {
    startGame(room);
    broadcast(room);
    return true;
  }
  if (room.joinUntil && now >= room.joinUntil) {
    room.joinUntil = null;
    room.joinTimeUp = true;
    broadcast(room);
  }
  return false;
}

/** Applies host/admin settings. Returns an error message, or null when everything was accepted. */
function applySettings(room, s) {
  if ([0, 30, 60, 90].includes(s.turnTimer)) room.settings.turnTimer = s.turnTimer;
  if (Number.isInteger(s.skips) && s.skips >= SKIP_MIN && s.skips <= SKIP_MAX) room.settings.skips = s.skips;
  if (typeof s.hints === 'boolean') room.settings.hints = s.hints;
  if (room.admin && s.grade !== undefined) room.settings.grade = cleanGrade(s.grade);
  if (room.admin && s.maxPlayers !== undefined) {
    if (!Number.isInteger(s.maxPlayers) || s.maxPlayers < 2 || s.maxPlayers > MAX_PLAYERS) return `Choose 2 to ${MAX_PLAYERS} players.`;
    if (s.maxPlayers < room.players.length) return `${room.players.length} players have already joined.`;
    if (gameRunning(room) || seriesRunning(room)) return 'The players are fixed until this series ends.';
    room.settings.maxPlayers = s.maxPlayers;
  }
  if (s.seriesGames !== undefined) {
    if (!Number.isInteger(s.seriesGames) || s.seriesGames < 1 || s.seriesGames > SERIES_MAX) {
      return `A series can have 1 to ${SERIES_MAX} games.`;
    }
    if (gameRunning(room) || seriesRunning(room)) {
      return 'The number of games is fixed once the series has started.';
    }
    room.settings.seriesGames = s.seriesGames;
    if (room.series.games === 0) room.series.target = s.seriesGames;
  }
  return null;
}

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };
  const guard = (fn) => (data, ack) => {
    try {
      fn(data || {}, ack);
    } catch (e) {
      if (e instanceof GameError) reply(ack, { error: e.message });
      else { console.error(e); reply(ack, { error: 'Something went wrong.' }); }
    }
  };

  function attach(r, p) {
    room = r; me = p;
    p.socketId = socket.id;
    p.connected = true;
    p.lastSeen = Date.now();
    socket.join(r.code);
  }

  socket.on('create', guard(({ name }, ack) => {
    if (words.isRude(cleanName(name))) return reply(ack, { error: NAME_REFUSED, badName: true });
    const r = createRoom();
    const p = { id: rid(4), token: rid(16), name: cleanName(name), connected: true };
    r.players.push(p);
    r.hostId = p.id;
    attach(r, p);
    reply(ack, { ok: true, code: r.code, token: p.token, id: p.id });
    broadcast(r);
  }));

  // An admin creates a room they run without playing. `auth` is the sign-in token from /api/admin/login.
  socket.on('adminCreate', guard(({ auth, settings }, ack) => {
    const a = accounts.verify(auth);
    if (!a) return reply(ack, { error: 'Please log in again.', relogin: true });
    const admin = { id: `A${rid(4)}`, token: rid(16), name: 'Admin', email: a.email, school: a.school, connected: true, isAdmin: true };
    const r = createRoom({ admin });
    const err = applySettings(r, settings || {});
    if (err) { deleteRoom(r); return reply(ack, { error: err }); }
    r.joinUntil = Date.now() + joinWaitMs();
    attach(r, admin);
    reply(ack, { ok: true, code: r.code, token: admin.token });
    broadcast(r);
  }));

  socket.on('adminJoin', guard(({ code, token }, ack) => {
    const r = rooms.get(String(code || '').trim());
    if (!r || !r.admin || !token || r.admin.token !== token) return reply(ack, { error: 'That game has ended.' });
    if (r.admin.socketId && r.admin.socketId !== socket.id) {
      io.to(r.admin.socketId).emit('kicked', { reason: 'You opened this game in another tab.', otherTab: true });
    }
    attach(r, r.admin);
    reply(ack, { ok: true, code: r.code, token: r.admin.token });
    broadcast(r);
  }));

  // The admin ends the room for everyone.
  socket.on('closeRoom', guard((_d, ack) => {
    if (!room || !room.admin || me !== room.admin) return reply(ack, { error: 'Only the admin can close this game.' });
    const r = room;
    for (const p of r.players) if (p.socketId) io.to(p.socketId).emit('kicked', { reason: 'The game was closed.' });
    deleteRoom(r);
    room = null; me = null;
    reply(ack, { ok: true });
  }));

  // The admin gives students another minute to join (before the first game).
  socket.on('extendJoin', guard((_d, ack) => {
    if (!room || !room.admin || me !== room.admin) return reply(ack, { error: 'Only the teacher can do that.' });
    if (room.game || room.gameNo) return reply(ack, { error: 'The game has already started.' });
    room.joinUntil = Math.max(Date.now(), room.joinUntil || 0) + joinWaitMs();
    room.joinTimeUp = false;
    reply(ack, { ok: true });
    broadcast(room);
  }));

  // The admin pauses or resumes the game in progress.
  socket.on('pause', guard(({ on }, ack) => {
    if (!room || !room.admin || me !== room.admin) return reply(ack, { error: 'Only the admin can pause the game.' });
    if (!room.game || room.game.phase !== 'playing') return reply(ack, { error: 'There is no game to pause.' });
    setPaused(room, !!on);
    reply(ack, { ok: true });
    broadcast(room);
  }));

  // The admin stops the game in progress. Nobody wins and it does not count in a series;
  // everyone goes back to the waiting room.
  socket.on('endGame', guard((_d, ack) => {
    if (!room || !room.admin || me !== room.admin) return reply(ack, { error: 'Only the admin can end the game.' });
    if (!gameRunning(room)) return reply(ack, { error: 'There is no game to end.' });
    setPaused(room, false);
    clearTimeout(room.botTimer);
    room.botTimer = null;
    room.game = null;
    reply(ack, { ok: true });
    io.to(room.code).emit('notice', { text: 'Your teacher ended the game.' });
    broadcast(room);
  }));

  socket.on('join', guard(({ code, name, token, grade }, ack) => {
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return reply(ack, { error: 'No game found with that code.' });
    const existing = token && r.players.find((p) => p.token === token);
    if (existing) {
      if (existing.socketId && existing.socketId !== socket.id) {
        io.to(existing.socketId).emit('kicked', { reason: 'You opened this game in another tab.', otherTab: true });
      }
      attach(r, existing);
      reply(ack, { ok: true, code: r.code, token: existing.token, id: existing.id, rejoined: true });
      return broadcast(r);
    }
    if (r.game && r.game.phase !== 'over') return reply(ack, { error: 'That game has already started. Ask the host to add you for the next game.' });
    if (seriesRunning(r)) {
      return reply(ack, { error: `A series is in progress (${r.series.games} of ${r.series.target} games played) with a fixed set of players. You can join when it ends.` });
    }
    if (r.players.length >= tableSize(r)) return reply(ack, { error: `That table is full (${tableSize(r)} players).` });
    let nm = cleanName(name);
    if (words.isRude(nm)) return reply(ack, { error: NAME_REFUSED, badName: true });
    if (r.players.some((p) => p.name.toLowerCase() === nm.toLowerCase())) nm = `${nm.slice(0, 13)} ${r.players.length + 1}`;
    const p = { id: rid(4), token: rid(16), name: nm, grade: cleanGrade(grade), connected: true };
    r.players.push(p);
    attach(r, p);
    reply(ack, { ok: true, code: r.code, token: p.token, id: p.id });
    if (!checkJoinTime(r)) broadcast(r);
  }));

  socket.on('settings', guard((s, ack) => {
    if (!room || me.id !== room.hostId) return reply(ack, { error: 'Only the host can change settings.' });
    const err = applySettings(room, s);
    if (err) return reply(ack, { error: err });
    reply(ack, { ok: true });
    if (!checkJoinTime(room)) broadcast(room);
  }));

  socket.on('addBot', guard((_d, ack) => {
    if (!room || me.id !== room.hostId) return reply(ack, { error: 'Only the host can add computer players.' });
    if (gameRunning(room)) return reply(ack, { error: 'Bots can join once this game is over.' });
    if (seriesRunning(room)) return reply(ack, { error: 'The players are fixed until this series ends.' });
    if (room.players.length >= tableSize(room)) return reply(ack, { error: `The table is full (${tableSize(room)} players).` });
    const bot = addBot(room);
    reply(ack, { ok: true, id: bot.id });
    if (!checkJoinTime(room)) broadcast(room);
  }));

  socket.on('start', guard((_d, ack) => {
    if (!room || me.id !== room.hostId) return reply(ack, { error: 'Only the host can start the game.' });
    if (room.game && room.game.phase !== 'over') return reply(ack, { error: 'A game is already running.' });
    if (room.players.length < 2) return reply(ack, { error: 'You need at least 2 players.' });
    startGame(room);
    reply(ack, { ok: true });
    broadcast(room);
  }));

  socket.on('lobby', guard((_d, ack) => {
    if (!room || me.id !== room.hostId) return reply(ack, { error: 'Only the host can do that.' });
    if (room.game && room.game.phase !== 'over') return reply(ack, { error: 'Finish the current game first.' });
    room.game = null;
    reply(ack, { ok: true });
    broadcast(room);
  }));

  socket.on('resetSeries', guard((_d, ack) => {
    if (!room || me.id !== room.hostId) return reply(ack, { error: 'Only the host can do that.' });
    if (gameRunning(room)) return reply(ack, { error: 'Finish the current game first.' });
    room.series = newSeries(room.settings.seriesGames);
    reply(ack, { ok: true });
    broadcast(room);
  }));

  socket.on('play', guard(({ cardId, slot, target }, ack) => {
    if (!room || !room.game) return reply(ack, { error: 'No game running.' });
    if (room.paused) return reply(ack, { error: 'The game is paused.' });
    if (process.env.DEBUG) console.log(`[${room.code}] play ${me.name} ${cardId} socket=${socket.id}`);
    room.game.play(me.id, cardId, { slot, target });
    recordResult(room);
    reply(ack, { ok: true });
    broadcast(room);
  }));

  socket.on('pass', guard((_d, ack) => {
    if (!room || !room.game) return reply(ack, { error: 'No game running.' });
    if (room.paused) return reply(ack, { error: 'The game is paused.' });
    room.game.pass(me.id);
    recordResult(room);
    reply(ack, { ok: true });
    broadcast(room);
  }));

  // Rearranging your own hand only changes your own view, so only you get the update.
  socket.on('reorder', guard(({ ids }, ack) => {
    if (!room || !room.game) return reply(ack, { error: 'No game running.' });
    room.game.reorderHand(me.id, ids);
    reply(ack, { ok: true });
    if (me.socketId) io.to(me.socketId).emit('state', viewFor(room, me));
  }));

  socket.on('chat', guard(({ text }, ack) => {
    if (!room) return;
    const t = words.mask(String(text || '').trim().slice(0, 200)); // rude words become stars
    if (!t) return;
    room.chat.push({ id: me.id, name: me.name, text: t, t: Date.now() });
    if (room.chat.length > 100) room.chat.shift();
    reply(ack, { ok: true });
    broadcast(room);
  }));

  socket.on('kick', guard(({ id }, ack) => {
    if (!room || me.id !== room.hostId) return reply(ack, { error: 'Only the host can remove players.' });
    if (id === me.id) return reply(ack, { error: "You can't remove yourself." });
    const target = room.players.find((p) => p.id === id);
    if (!target) return;
    if (gameRunning(room) && target.connected) {
      return reply(ack, { error: `${target.name} is still connected. During a game you can only remove a player who has dropped out.` });
    }
    if (target.socketId) io.to(target.socketId).emit('kicked', { reason: 'The host removed you from the game.' });
    removeMember(room, id);
    reply(ack, { ok: true });
    broadcast(room);
  }));

  socket.on('leave', guard((_d, ack) => {
    if (!room) return;
    if (me === room.admin) return reply(ack, { error: 'Close the game instead.' });
    if (gameRunning(room)) return reply(ack, { error: 'You can’t leave in the middle of a game. Finish this game first.' });
    const r = room;
    socket.leave(r.code);
    removeMember(r, me.id);
    room = null; me = null;
    reply(ack, { ok: true });
    if (rooms.has(r.code)) broadcast(r);
  }));

  socket.on('disconnect', () => {
    if (!room || !me || me.socketId !== socket.id) return;
    me.connected = false;
    me.socketId = null;
    me.lastSeen = Date.now();
    broadcast(room);
  });
});

// If the host has been gone a while, hand hosting to someone who's still here.
function ensureHostConnected(room, now) {
  if (room.admin) return false; // the admin stays in charge, even while offline
  const host = room.players.find((p) => p.id === room.hostId);
  if (host && (host.connected || now - (host.lastSeen || 0) < HOST_GRACE_MS)) return false;
  const next = humans(room).find((p) => p.connected);
  if (!next || next.id === room.hostId) return false;
  room.hostId = next.id;
  return true;
}

// Housekeeping: auto-pass for disconnected/timed-out players, drop stale lobby members, delete idle rooms.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (ensureHostConnected(room, now)) broadcast(room);
    checkJoinTime(room, now);
    const g = room.game;
    if (g && g.phase === 'playing' && !room.paused) {
      const cur = room.players.find((p) => p.id === g.currentId);
      const elapsed = now - g.turnStartedAt;
      const timer = room.settings.turnTimer * 1000;
      if ((cur && !cur.connected && elapsed > DISCONNECT_AUTOPASS_MS) || (timer && elapsed > timer)) {
        if (process.env.DEBUG) console.log(`[${room.code}] autoMove ${cur && cur.name}`);
        try { g.autoMove(g.currentId); recordResult(room); broadcast(room); } catch (e) { console.error(e); }
      }
    }
    // Between games of a running series the set of players is fixed, so nobody is dropped for being offline.
    if ((!g || g.phase === 'over') && !seriesRunning(room)) {
      const stale = room.players.filter((p) => !p.connected && now - (p.lastSeen || 0) > LOBBY_DROP_MS);
      if (stale.length) {
        for (const p of stale) removeMember(room, p.id);
        if (rooms.has(room.code)) broadcast(room);
      }
    }
    if (now - room.lastActive > ROOM_IDLE_MS || !keepsAlive(room)) deleteRoom(room);
  }
}, 1000);

// A plain explanation instead of a stack trace when the port is taken (common on players' own computers).
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already being used by another program.`);
    console.error('Close that program, or start Prime Time on a different port (see START HERE.txt).\n');
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`Prime Time Online running at http://localhost:${PORT}`);
});
