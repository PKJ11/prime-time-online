/*
 * Admin (teacher) flow: sign up / log in over HTTP (password rule, reset by email), create a room,
 * players join with a grade, the game starts by itself once every seat is taken, the admin watches
 * without a hand, pauses and resumes, a game plays to the end, the table size is enforced, the admin
 * ends a second game early, and closing the room sends everyone home. A second room checks the join
 * time: the teacher is asked when too few joined, adds a minute, and the game starts when it ends.
 * Run: node test/admin.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.PORT = process.env.PORT || '3101';
process.env.BOT_DELAY_MS = '10';
process.env.ADMIN_TRIES_PER_MIN = '100'; // this test signs in far more often than a person would
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-admin-'));
// extra blocked words can be added in DATA_DIR/blocked-words.txt
fs.writeFileSync(path.join(process.env.DATA_DIR, 'blocked-words.txt'), '# added by the school\nprimezilla\n');
const assert = require('assert');
const { io } = require('socket.io-client');
const R = require('../public/rules.js');
require('../server.js');

const URL = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body) => fetch(URL + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
function client() {
  const s = io(URL, { forceNew: true });
  const c = { s, state: null, kicked: null };
  s.on('state', (st) => { c.state = st; });
  s.on('kicked', (k) => { c.kicked = k; });
  c.call = (ev, data) => new Promise((res) => s.emit(ev, data, res));
  return c;
}
async function waitFor(pred, ms = 20000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(20); }
}

(async () => {
  await sleep(300);
  // accounts
  assert.strictEqual((await post('/api/admin/signup', { email: 'bad', password: 'longenough', school: 'S' })).status, 400);
  assert.strictEqual((await post('/api/admin/signup', { email: 't@school.in', password: 'ab1', school: 'S' })).status, 400, 'at least 6 characters');
  assert.strictEqual((await post('/api/admin/signup', { email: 't@school.in', password: 'abcdefgh', school: 'S' })).status, 400, 'at least one number');
  const su = await post('/api/admin/signup', { email: 'T@School.in', password: 'primes123', school: 'Sunrise School', campus: 'North' });
  assert(su.token && su.admin.email === 't@school.in', 'sign-up works and lower-cases the email');
  assert.strictEqual((await post('/api/admin/signup', { email: 't@school.in', password: 'primes123', school: 'S' })).status, 400, 'no duplicate accounts');
  assert.strictEqual((await post('/api/admin/login', { email: 't@school.in', password: 'wrong-one' })).status, 400);
  const li = await post('/api/admin/login', { email: 't@school.in', password: 'primes123' });
  assert(li.token, 'log-in works');
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'admins.json'), 'utf8'));
  assert(!JSON.stringify(stored).includes('primes123'), 'password is not stored in plain text');
  const me = await fetch(`${URL}/api/admin/me`, { headers: { Authorization: `Bearer ${li.token}` } }).then((r) => r.json());
  assert.strictEqual(me.admin.school, 'Sunrise School');

  // with a sign-up code set, only people who know it can register
  const config = () => fetch(`${URL}/api/admin/config`).then((r) => r.json());
  assert.strictEqual((await config()).signupCode, false);
  process.env.ADMIN_SIGNUP_CODE = 'primes-2026';
  assert.strictEqual((await config()).signupCode, true);
  const coded = { email: 'u@school.in', password: 'primes123', school: 'S' };
  assert.strictEqual((await post('/api/admin/signup', coded)).status, 400, 'no code, no account');
  assert.strictEqual((await post('/api/admin/signup', { ...coded, code: 'wrong' })).status, 400, 'wrong code, no account');
  assert((await post('/api/admin/signup', { ...coded, code: ' primes-2026 ' })).token, 'the right code works');
  assert((await post('/api/admin/login', { email: 't@school.in', password: 'primes123' })).token, 'log-in never needs the code');
  delete process.env.ADMIN_SIGNUP_CODE;

  // forgot password: off until email is set up; then a link by email, which works once
  assert.strictEqual((await config()).resetEmail, false);
  assert.strictEqual((await post('/api/admin/forgot', { email: 't@school.in' })).status, 400, 'no email set up: a message instead');
  const outbox = path.join(process.env.DATA_DIR, 'outbox');
  process.env.MAIL_OUTBOX_DIR = outbox;
  process.env.PUBLIC_URL = 'https://primetime.example/';
  assert.strictEqual((await config()).resetEmail, true);
  assert((await post('/api/admin/forgot', { email: 'nobody@school.in' })).ok, 'the same answer for an unknown email');
  assert((await post('/api/admin/forgot', { email: 'T@school.in' })).ok);
  await waitFor(() => fs.existsSync(outbox) && fs.readdirSync(outbox).length === 1);
  const mail = JSON.parse(fs.readFileSync(path.join(outbox, fs.readdirSync(outbox)[0]), 'utf8'));
  assert.strictEqual(mail.to, 't@school.in', 'only the real account gets an email');
  const resetTok = mail.text.match(/\?reset=([\w.-]+)/)[1];
  assert(mail.text.includes('https://primetime.example/?reset='), 'the link uses PUBLIC_URL');
  assert.strictEqual((await post('/api/admin/reset', { token: resetTok, password: 'nonumber' })).status, 400, 'the new password follows the rule');
  assert((await post('/api/admin/reset', { token: resetTok, password: 'newprime7' })).token, 'reset works');
  assert.strictEqual((await post('/api/admin/reset', { token: resetTok, password: 'again99' })).status, 400, 'a link works only once');
  assert.strictEqual((await post('/api/admin/reset', { token: 'x.y', password: 'again99' })).status, 400, 'a forged link is refused');
  assert.strictEqual((await post('/api/admin/login', { email: 't@school.in', password: 'primes123' })).status, 400, 'the old password is gone');
  const li2 = await post('/api/admin/login', { email: 't@school.in', password: 'newprime7' });
  assert(li2.token, 'log-in with the new password');
  delete process.env.MAIL_OUTBOX_DIR; delete process.env.PUBLIC_URL;

  // a room run by the admin
  const admin = client();
  assert((await admin.call('adminCreate', { auth: 'forged.token', settings: {} })).relogin, 'a bad token is refused');
  const made = await admin.call('adminCreate', { auth: li.token, settings: { maxPlayers: 3, grade: 'Grade 5', hints: true, turnTimer: 0, skips: 6, seriesGames: 1 } });
  assert(made.ok && /^\d{6}$/.test(made.code), `6-digit code (${made.code})`);
  await waitFor(() => admin.state);
  assert.strictEqual(admin.state.members.length, 0, 'the admin is not a player');
  assert.strictEqual(admin.state.hostId, admin.state.you);
  assert.deepStrictEqual([admin.state.settings.maxPlayers, admin.state.settings.grade, admin.state.settings.skips], [3, 'Grade 5', 6]);
  const until = admin.state.joinUntil;
  assert(until > Date.now() + 50_000 && until <= Date.now() + 60_000, 'students get a minute to join');

  const a = client(), b = client(), c = client(), d = client();
  assert.strictEqual((await a.call('join', { code: made.code, name: 'Primezilla', grade: '5B' })).error, 'Please choose a different name.', 'words from blocked-words.txt are refused');
  const ja = await a.call('join', { code: made.code, name: 'Asha', grade: '5B' });
  const jb = await b.call('join', { code: made.code, name: 'Bilal', grade: '5A' });
  assert(ja.ok && jb.ok);
  assert((await b.call('start', {})).error, 'a player cannot start the game');
  assert((await b.call('settings', { hints: false })).error, 'a player cannot change settings');
  assert((await b.call('extendJoin', {})).error, 'a player cannot add time');
  assert((await admin.call('extendJoin', {})).ok);
  await waitFor(() => admin.state.joinUntil >= until + 60_000);
  await waitFor(() => a.state.joinUntil === admin.state.joinUntil);
  await waitFor(() => admin.state.members.length === 2);
  assert.strictEqual(admin.state.members[0].grade, '5B', 'grade is shown to the admin');
  assert((await admin.call('settings', { maxPlayers: 1 })).error, 'a table needs 2 players');

  // the admin removes one player and adds a computer player instead
  assert((await admin.call('kick', { id: admin.state.members.find((m) => m.name === 'Bilal').id })).ok);
  await waitFor(() => b.kicked);
  assert((await admin.call('addBot', {})).ok);
  await waitFor(() => admin.state.members.length === 2);
  assert.strictEqual(admin.state.game, null, 'no game until the table is full or the time is up');

  // the last seat is taken: the game starts by itself; nobody else can join now
  assert((await c.call('join', { code: made.code, name: 'Chen', grade: '5C' })).ok);
  await waitFor(() => admin.state.game && admin.state.game.phase === 'playing', 30000);
  assert.strictEqual(admin.state.joinUntil, null, 'the join time is over');
  assert(/started/.test((await d.call('join', { code: made.code, name: 'Dina', grade: '5' })).error || ''), 'no joining a game in progress');
  assert.deepStrictEqual(admin.state.game.hand, [], 'the admin sees no cards');
  assert(admin.state.game.players.every((p) => !('hand' in p)));
  assert((await admin.call('play', { cardId: 'x' })).error, 'the admin cannot play');

  // pause: only the admin can, nobody can move while paused, and the turn clock does not run
  assert((await a.call('pause', { on: true })).error, 'a player cannot pause');
  assert((await admin.call('pause', { on: true })).ok);
  await waitFor(() => a.state.pausedAt && c.state.pausedAt && admin.state.pausedAt);
  const startedAt = admin.state.game.turnStartedAt;
  const mover = [a, c].find((p) => p.state.game.current === p.state.you);
  if (mover) assert(/paused/.test((await mover.call('pass', {})).error || ''), 'no moves while paused');
  await sleep(300);
  assert((await admin.call('pause', { on: false })).ok);
  await waitFor(() => a.state.pausedAt === null && admin.state.pausedAt === null);
  assert(admin.state.game.turnStartedAt >= startedAt + 250, 'the turn clock moves on by the paused time');
  for (let guard = 0; admin.state.game.phase !== 'over'; guard++) {
    assert(guard < 20000, 'game finishes');
    for (const p of [a, c]) {
      const g = p.state.game;
      if (g.phase !== 'playing' || g.current !== p.state.you) continue;
      const card = g.hand.find((x) => x.type === 'num' && R.checkNumber(g.board, x.n, g.firstMove).ok);
      const magic = !g.firstMove && g.hand.find((x) => x.type === 'magic');
      const skip = !g.firstMove && g.hand.find((x) => x.type === 'skip');
      if (card) await p.call('play', { cardId: card.id });
      else if (magic) await p.call('play', { cardId: magic.id, slot: R.magicTargets(g.board)[0] });
      else if (skip) await p.call('play', { cardId: skip.id, target: g.order.find((id) => id !== p.state.you) });
      else await p.call('pass', {});
    }
    await sleep(15);
  }
  const res = admin.state.game.result;
  console.log('admin game over:', res.reason, 'winners', res.winners.map((id) => admin.state.game.players.find((p) => p.id === id).name));

  // back to the waiting room; the admin reconnects from another tab, then closes the room
  assert((await admin.call('lobby', {})).ok);
  await waitFor(() => a.state.game === null);
  assert.strictEqual(admin.state.joinUntil, null, 'no join time before later games');
  assert(/full/.test((await d.call('join', { code: made.code, name: 'Dina', grade: '5' })).error || ''), 'the table size set by the admin is enforced');
  assert((await admin.call('settings', { maxPlayers: 2 })).error, 'cannot shrink the table below the players already in it');

  // the admin ends a game in progress: nobody wins, everyone is back in the waiting room
  assert((await admin.call('start', {})).ok);
  await waitFor(() => a.state.game && a.state.game.phase === 'playing', 30000);
  let notice = null;
  a.s.once('notice', (n) => { notice = n; });
  assert((await a.call('endGame', {})).error, 'a player cannot end the game');
  assert((await admin.call('endGame', {})).ok);
  await waitFor(() => a.state.game === null && admin.state.game === null && notice);
  assert.strictEqual(admin.state.series.games, 0, 'an ended game does not count');
  const admin2 = client();
  assert((await admin2.call('adminJoin', { code: made.code, token: 'wrong' })).error);
  assert((await admin2.call('adminJoin', { code: made.code, token: made.token })).ok, 'the admin can reconnect');
  await waitFor(() => admin.kicked && admin.kicked.otherTab);
  assert((await a.call('closeRoom', {})).error, 'a player cannot close the room');
  assert((await admin2.call('closeRoom', {})).ok);
  await waitFor(() => a.kicked && c.kicked);

  // join time: with too few students the teacher is asked; another minute; then it starts with who came
  process.env.JOIN_WAIT_MS = '700';
  const t2 = client();
  const room2 = await t2.call('adminCreate', { auth: li2.token, settings: { maxPlayers: 4, grade: 'Grade 3' } });
  const e = client(), f = client();
  assert((await e.call('join', { code: room2.code, name: 'Esha', grade: 'Grade 3' })).ok);
  await waitFor(() => t2.state && t2.state.joinTimeUp, 5000);
  assert.strictEqual(t2.state.game, null, 'one student is not enough to start');
  assert((await t2.call('extendJoin', {})).ok);
  await waitFor(() => !t2.state.joinTimeUp && t2.state.joinUntil > Date.now());
  assert((await f.call('join', { code: room2.code, name: 'Farid', grade: 'Grade 3' })).ok);
  await waitFor(() => t2.state.game, 5000);
  assert.strictEqual(t2.state.game.players.length, 2, 'the game starts with the students who joined');
  assert((await t2.call('extendJoin', {})).error, 'no more time once the game has started');
  assert((await t2.call('closeRoom', {})).ok);
  await waitFor(() => e.kicked && f.kicked);
  delete process.env.JOIN_WAIT_MS;
  const health = await fetch(`${URL}/health`).then((r) => r.json());
  assert.strictEqual(health.rooms, 0, 'the room is gone');
  console.log('Admin test passed.');
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
