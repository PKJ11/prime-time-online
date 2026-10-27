/*
 * Test bot: joins a room and plays automatically (useful for trying the game alone).
 * Usage: node test/bot.js <ROOMCODE> [name] [serverUrl] [delayMs]
 */
const { io } = require('socket.io-client');
const R = require('../public/rules.js');

const [code, name = 'Bot', url = 'http://localhost:3000', delayArg] = process.argv.slice(2);
const delay = Number(delayArg) || 900;
if (!code) { console.log('Usage: node test/bot.js <ROOMCODE> [name] [serverUrl]'); process.exit(1); }

const socket = io(url);
let me = null;
let thinking = false;

socket.on('connect', () => {
  socket.emit('join', { code, name }, (res) => {
    if (res.error) { console.error(res.error); process.exit(1); }
    me = res.id;
    console.log(`${name} joined ${res.code}`);
  });
});

socket.on('state', (s) => {
  const g = s.game;
  if (!g || g.phase !== 'playing' || g.current !== me || thinking) return;
  thinking = true;
  setTimeout(() => { thinking = false; move(g); }, delay + Math.random() * delay);
});

function move(g) {
  const hand = g.hand;
  const nums = hand.filter((c) => c.type === 'num' && R.checkNumber(g.board, c.n, g.firstMove).ok)
    .sort((a, b) => b.n - a.n); // dump the biggest playable number first
  if (nums.length) return socket.emit('play', { cardId: nums[0].id }, log);
  if (g.firstMove) return;
  const magic = hand.find((c) => c.type === 'magic');
  const targets = R.magicTargets(g.board);
  if (magic && targets.length) {
    // prefer a prime that unlocks one of our composites
    const want = hand.filter((c) => c.type === 'num').flatMap((c) => R.checkNumber(g.board, c.n, false).missing);
    const slot = targets.find((i) => want.includes(g.board[i].n)) ?? targets[0];
    return socket.emit('play', { cardId: magic.id, slot }, log);
  }
  const skip = hand.find((c) => c.type === 'skip');
  if (skip) {
    const others = g.players.filter((p) => p.id !== me).sort((a, b) => a.count - b.count);
    return socket.emit('play', { cardId: skip.id, target: others[0].id }, log);
  }
  socket.emit('pass', {}, log);
}

function log(res) { if (res && res.error) console.log('error:', res.error); }
