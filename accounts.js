/*
 * Admin (teacher) accounts for the tablet layout. Stored in a JSON file (no database):
 * passwords are salted and hashed with scrypt; sign-in tokens are HMAC-signed, so they survive a restart.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'admins.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const TOKEN_DAYS = 30;
const PASSWORD_MIN = 6;  // owner's rule (2026-10-13): at least 6 characters with at least one digit
const PASSWORD_MAX = 64;
const RESET_MINUTES = 60;

class AccountError extends Error {}

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

let secret = process.env.ADMIN_SECRET || null;
function getSecret() {
  if (secret) return secret;
  ensureDir();
  if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  return secret;
}

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function save(all) {
  ensureDir();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, FILE);
}

const cleanText = (s, max) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const normEmail = (s) => String(s || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const pub = (a) => ({ email: a.email, school: a.school, campus: a.campus });

function sign(email) {
  const body = Buffer.from(JSON.stringify({ e: email, x: Date.now() + TOKEN_DAYS * 864e5 })).toString('base64url');
  const mac = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The admin a token belongs to, or null. */
function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!data || data.x < Date.now()) return null;
  const a = load()[data.e];
  return a ? pub(a) : null;
}

// When ADMIN_SIGNUP_CODE is set, only people who know it can sign up as an admin (read on every
// call, so changing it needs no code change).
const signupCode = () => String(process.env.ADMIN_SIGNUP_CODE || '').trim();
function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) throw new AccountError(`The password needs at least ${PASSWORD_MIN} characters.`);
  if (password.length > PASSWORD_MAX) throw new AccountError(`The password can have at most ${PASSWORD_MAX} characters.`);
  if (!/\d/.test(password)) throw new AccountError('The password needs at least one number.');
}

function signup({ email, password, school, campus, code }) {
  const need = signupCode();
  if (need && !sameText(String(code || '').trim(), need)) {
    throw new AccountError('That sign-up code is not right. Ask the person who runs this site for the code.');
  }
  const e = normEmail(email);
  if (!EMAIL_RE.test(e) || e.length > 120) throw new AccountError('Please enter a valid email address.');
  checkPassword(password);
  const sc = cleanText(school, 80);
  if (!sc) throw new AccountError('Please enter your school.');
  const all = load();
  if (all[e]) throw new AccountError('An admin with this email already exists. Please log in.');
  const salt = crypto.randomBytes(16).toString('hex');
  all[e] = { email: e, salt, hash: hash(password, salt), school: sc, campus: cleanText(campus, 80), createdAt: new Date().toISOString() };
  save(all);
  return { token: sign(e), admin: pub(all[e]) };
}

function login({ email, password }) {
  const e = normEmail(email);
  const a = load()[e];
  const ok = a && typeof password === 'string'
    && crypto.timingSafeEqual(Buffer.from(hash(password, a.salt), 'hex'), Buffer.from(a.hash, 'hex'));
  if (!ok) throw new AccountError('Wrong email or password.');
  return { token: sign(e), admin: pub(a) };
}

/*
 * Password reset. The link carries a signed token that names the account, expires after an hour and
 * is tied to the current password: once the password changes, the link no longer works.
 */
const resetMac = (body, a) => crypto.createHmac('sha256', getSecret()).update(`reset.${body}.${a.hash}`).digest('base64url');

/** A reset token for this email, or null when there is no such account. */
function resetToken(email) {
  const e = normEmail(email);
  const a = load()[e];
  if (!a) return null;
  const body = Buffer.from(JSON.stringify({ e, x: Date.now() + RESET_MINUTES * 60e3 })).toString('base64url');
  return `${body}.${resetMac(body, a)}`;
}

function resetPassword({ token, password }) {
  const bad = () => new AccountError('This reset link has expired or was already used. Ask for a new one.');
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) throw bad();
  let data;
  try { data = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw bad(); }
  const all = load();
  const a = data && all[data.e];
  if (!a || !(data.x > Date.now())) throw bad();
  const want = resetMac(body, a);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) throw bad();
  checkPassword(password);
  a.salt = crypto.randomBytes(16).toString('hex');
  a.hash = hash(password, a.salt);
  save(all);
  return { token: sign(a.email), admin: pub(a) };
}

module.exports = {
  signup, login, verify, resetToken, resetPassword, AccountError, PASSWORD_MIN, PASSWORD_MAX, RESET_MINUTES,
  needsSignupCode: () => !!signupCode(),
};
