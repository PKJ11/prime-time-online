/*
 * Word filter for player names and chat (owner's request, 2026-10-26).
 * Chat: rude words are replaced by stars. Names: a rude name is refused.
 *
 * Matching works on whole words, so "class", "assess", "Shital" and "cockroach" are fine.
 * It sees through capitals, accents, repeated letters ("fuuuck"), look-alike symbols ("sh1t", "@ss")
 * and spaced letters ("f u c k"). Numbers on their own are left alone ("4 5 5" stays numbers).
 *
 * List syntax (one entry per item or line):
 *   word      the word itself, plus endings like -s, -es, -ed, -er, -ing, -y
 *   word*     any word that starts with it
 *   *word*    any word that contains it
 *   two words a phrase (whole words, in this order)
 * More words can be added without changing code: put them in DATA_DIR/blocked-words.txt,
 * one per line (# starts a comment). The file is read again when it changes.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EXTRA_FILE = path.join(DATA_DIR, 'blocked-words.txt');

const BUILT_IN = [
  // English
  '*fuck*', 'fck', 'fuk', 'fuq', 'wtf', 'stfu', 'shit', 'shitty', 'shithead', 'bullshit', 'bitch*', 'bastard',
  'ass', 'asshole', 'arse', 'arsehole', 'jackass', 'dumbass', 'dick', 'dickhead', 'cock', 'cunt*', 'pussy', 'pussies',
  'twat', 'wanker', 'wank', 'slut', 'whore', 'porn*', 'sex', 'sexy', 'boob*', 'tits', 'titty', 'titties',
  'penis', 'vagina', 'dildo', 'rape', 'rapist', 'nigger', 'nigga', 'fag', 'faggot', 'retard', 'retarded',
  'kys', 'kill yourself', 'motherfucker',
  // Hindi / Hinglish (Latin letters)
  'chutiya', 'chutiye', 'chutia', 'chootiya', 'choot', 'chut', 'madarchod', 'maderchod', 'madarchodd',
  'behenchod', 'bhenchod', 'benchod', 'bhenchodd', 'bsdk', 'bkl', 'mkc', 'bhosdi*', 'bhosda', 'bhosadi*',
  'gaand', 'gandu', 'gaandu', 'lund', 'lauda', 'lavda', 'lawda', 'randi', 'harami', 'haraami', 'haramzada',
  'haramzade', 'haramkhor', 'kamina', 'kamine', 'kaminey', 'kutiya', 'bhadwa', 'bhadwe', 'bhadve', 'jhaant', 'jhatu',
  'teri maa ki',
  // Hindi (Devanagari)
  'चूतिया', 'चुतिया', 'मादरचोद', 'बहनचोद', 'भेनचोद', 'भोसड़ी*', 'गांड', 'गांडू', 'लंड', 'लौड़ा', 'रंडी', 'हरामी', 'हरामज़ादा', 'कमीना', 'कुतिया',
];

// Look-alike symbols and digits, used only inside a word that also has a letter.
const LOOK_ALIKE = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };
const TOKEN_RE = /[\p{L}\p{M}\p{N}@$!]+/gu;
const ENDINGS = '(?:s|es|ed|er|ers|ing|in|y|ie|ies)?';

/** Lower-case, drop accents on Latin letters, and turn look-alikes in a word into letters. */
function normWord(raw) {
  let w = raw.normalize('NFKD').toLowerCase().replace(/([a-z])\p{M}+/gu, '$1');
  w = w.replace(/^!+|!+$/g, '');             // "hi!!" is just "hi"
  if (!/\p{L}/u.test(w)) return /^\p{N}+$/u.test(w) ? w : '';
  return w.replace(/[0134578@$!]/g, (c) => LOOK_ALIKE[c]);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each letter may be repeated ("fuuuck"), but a double letter in the list must stay double ("ass" ≠ "as").
const letters = (w) => [...w].map((c) => `${esc(c)}+`).join('');

function compile(entries) {
  const words = [];   // {re}
  const phrases = []; // {parts: [re, ...]}
  for (let e of entries) {
    e = String(e).trim();
    if (!e || e.startsWith('#')) continue;
    const any = e.startsWith('*') && e.endsWith('*') && e.length > 2;
    const prefix = !any && e.endsWith('*');
    const bare = e.replace(/^\*|\*$/g, '').split(/\s+/).map(normWord);
    if (!bare.length || bare.some((b) => !b)) continue;
    if (bare.length > 1) {
      phrases.push({ parts: bare.map((b) => new RegExp(`^${letters(b)}${ENDINGS}$`, 'u')) });
    } else if (any) words.push(new RegExp(letters(bare[0]), 'u'));
    else if (prefix) words.push(new RegExp(`^${letters(bare[0])}`, 'u'));
    else words.push(new RegExp(`^${letters(bare[0])}${ENDINGS}$`, 'u'));
  }
  return { words, phrases };
}

const builtIn = compile(BUILT_IN);
let extra = { words: [], phrases: [] };
let extraStamp = null;
let extraCheckedAt = 0;
function lists() {
  const now = Date.now();
  if (now - extraCheckedAt > 5000) {
    extraCheckedAt = now;
    let stamp = null;
    try { stamp = fs.statSync(EXTRA_FILE).mtimeMs; } catch { /* no extra file */ }
    if (stamp !== extraStamp) {
      extraStamp = stamp;
      try { extra = stamp === null ? { words: [], phrases: [] } : compile(fs.readFileSync(EXTRA_FILE, 'utf8').split(/\r?\n/)); }
      catch (e) { console.error('blocked-words.txt:', e.message); }
    }
  }
  return [builtIn, extra];
}
const badWord = (w) => lists().some((l) => l.words.some((re) => re.test(w)));

/** [start, end) spans of the original text that hold rude words. */
function findSpans(text) {
  const toks = [];
  for (const m of String(text || '').matchAll(TOKEN_RE)) {
    const w = normWord(m[0]);
    const lead = m[0].length - m[0].replace(/^!+/, '').length;
    const trail = m[0].length - m[0].replace(/!+$/, '').length;
    if (w) toks.push({ w, start: m.index + lead, end: m.index + m[0].length - trail });
  }
  const spans = [];
  for (const t of toks) if (badWord(t.w)) spans.push([t.start, t.end]);
  // Spaced-out letters: "f u c k" or "s.h.i.t" are read as one word.
  for (let i = 0; i < toks.length;) {
    let j = i;
    while (j < toks.length && toks[j].w.length === 1 && /\p{L}/u.test(toks[j].w)) j++;
    if (j - i >= 2 && badWord(toks.slice(i, j).map((t) => t.w).join(''))) spans.push([toks[i].start, toks[j - 1].end]);
    i = Math.max(j, i + 1);
  }
  for (const l of lists()) {
    for (const { parts } of l.phrases) {
      for (let i = 0; i + parts.length <= toks.length; i++) {
        if (parts.every((re, k) => re.test(toks[i + k].w))) spans.push([toks[i].start, toks[i + parts.length - 1].end]);
      }
    }
  }
  return spans;
}

/** True when the text holds a rude word. */
const isRude = (text) => findSpans(text).length > 0;

/** The text with each rude word (or spaced-out letter run) replaced by stars. */
function mask(text) {
  const chars = [...String(text || '')];
  const s = String(text || '');
  const hide = new Array(s.length).fill(false);
  for (const [a, b] of findSpans(s)) for (let k = a; k < b; k++) if (/\S/.test(s[k])) hide[k] = true;
  // Work in UTF-16 indices, then rebuild by code point so stars line up with what people see.
  let out = '';
  let k = 0;
  for (const c of chars) { out += hide[k] ? '*' : c; k += c.length; }
  return out;
}

module.exports = { isRude, mask, EXTRA_FILE };
