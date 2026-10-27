/*
 * Plays thousands of random bot games against the engine and checks every rule and invariant.
 * Run: npm test
 */
const assert = require('assert');
const R = require('../public/rules.js');
const { Game, GameError, buildDeck } = require('../game.js');

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function totalCards(g) {
  const onBoard = g.board.reduce((n, s) => n + (s.card ? 1 : 0) + (s.under ? 1 : 0) + s.extra.length, 0);
  const inHands = g.players.reduce((s, p) => s + p.hand.length, 0);
  return onBoard + inHands + g.tray.length + g.discard.length;
}

// ---------- deck, board, factors ----------
const deck = buildDeck();
assert.strictEqual(deck.length, 74, 'default deck: 68 numbers + 2 MAGIC + 4 SKIP');
assert.strictEqual(deck.filter((c) => c.type === 'num').length, 68);
for (let k = 4; k <= 10; k++) {
  const d = buildDeck(k);
  assert.strictEqual(d.filter((c) => c.type === 'skip').length, k);
  assert.strictEqual(d.filter((c) => c.type === 'magic').length, 2);
  assert.strictEqual(new Set(d.map((c) => c.id)).size, d.length, 'card ids are unique');
}
// out-of-range requests are clamped to 4..10
assert.strictEqual(new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { skips: 2 }).settings.skips, 4);
assert.strictEqual(new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { skips: 99 }).settings.skips, 10);
assert.strictEqual(R.buildSlots().length, 68, 'board has 68 slots');
assert.deepStrictEqual(R.factorize(58), [2, 29]);
assert.deepStrictEqual(R.factorize(32), [2, 2, 2, 2, 2]);

// Example from the rulebook: board 1,2,2,3,7,13,41,53 -> playable composites
{
  const board = R.buildSlots().map((s) => ({ ...s, card: null }));
  for (const n of [1, 2, 2, 3, 7, 13, 41, 53]) R.freeSlot(board, n).card = { type: 'num', n };
  const ok = [];
  for (let n = 4; n <= 60; n++) if (!R.isPrime(n) && R.checkNumber(board, n, false).ok) ok.push(n);
  assert.deepStrictEqual(ok, [4, 6, 12, 14, 21, 26, 28, 39, 42, 52], 'matches rulebook example');
}

// ---------- random full games ----------
const stats = { games: 0, out: 0, turns: 0, magic: 0, magicStacked: 0, skip: 0, realOnMagic: 0, skippedDraws: 0 };
for (let seed = 1; seed <= 3000; seed++) {
  const rng = mulberry32(seed);
  const n = 2 + (seed % 5);
  const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
  const skips = 4 + (seed % 7);
  const g = new Game(players, { skips }, rng);
  const TOTAL = 70 + skips;

  const last = g.toss.rounds[g.toss.rounds.length - 1];
  assert.strictEqual(last.tied.length, 1);
  for (const r of g.toss.rounds) for (const v of Object.values(r.draws)) assert(v >= 2 && v <= 60);
  g.begin();
  assert.strictEqual(g.currentId, g.toss.winnerId);
  assert(g.current.hand.some((c) => c.n === 1), 'P1 holds the 1');
  for (const p of g.players) assert.strictEqual(p.hand.length, 5);
  assert.strictEqual(g.tray.length, TOTAL - 1 - 4 - 5 * (n - 1), 'tray after the deal');
  assert.strictEqual(totalCards(g), TOTAL);

  const notOne = g.current.hand.find((c) => c.n !== 1);
  assert.throws(() => g.play(g.currentId, notOne.id, {}), GameError, 'must open with 1');
  assert.throws(() => g.pass(g.currentId), GameError, 'cannot pass on the opening move');

  let turns = 0;
  while (g.phase === 'playing') {
    assert(++turns < 5000, 'game terminates');
    const p = g.current;
    const trayBefore = g.tray.length;
    const handBefore = p.hand.length;
    const seqBefore = g.seq;
    const lastPlayBefore = g.lastPlay[p.id] ? { ...g.lastPlay[p.id] } : undefined;
    const others = g.players.filter((q) => q.id !== p.id).map((q) => [q, q.hand.length, q.skips]);
    const can = g.playable(p);
    if (!can.length) {
      g.pass(p.id);
      assert.strictEqual(p.hand.length, handBefore + (trayBefore ? 1 : 0), 'pass then compulsory draw');
    } else {
      assert.throws(() => g.pass(p.id), GameError, 'must play when holding a playable card');
      const c = can[Math.floor(rng() * can.length)];
      const opts = {};
      if (c.type === 'magic') {
        const t = R.magicTargets(g.board); opts.slot = t[Math.floor(rng() * t.length)]; stats.magic++;
        if (g.board[opts.slot].card) {
          stats.magicStacked++;
          assert(g.board.every((sl) => !R.isPrime(sl.n) || sl.card), 'MAGIC stacks only when every prime slot is filled');
        }
      }
      if (c.type === 'skip') { const o = g.order.filter((id) => id !== p.id); opts.target = o[Math.floor(rng() * o.length)]; stats.skip++; }
      const slot = c.type === 'num' ? R.freeSlot(g.board, c.n) : null;
      if (slot && slot.card) stats.realOnMagic++;
      g.play(p.id, c.id, opts);
      assert.strictEqual(p.hand.length, handBefore - 1 + (trayBefore ? 1 : 0), 'play then compulsory draw');
      // "latest card" tracking: a board play points at the slot holding that very card; a SKIP leaves it untouched
      if (c.type === 'skip') {
        assert(g.lastAction[p.id].startsWith('SKIP on '));
        assert.deepStrictEqual(g.lastPlay[p.id], lastPlayBefore, 'SKIP does not move the board marker');
      } else {
        const sl = g.board[g.lastPlay[p.id].slot];
        assert(sl.card.id === c.id || sl.extra.some((m) => m.id === c.id), 'marker is on the card just played');
        const newest = Math.max(...Object.values(g.lastPlay).map((x) => x.turn));
        assert.strictEqual(g.lastPlay[p.id].turn, newest, 'the card just played is the newest marker');
      }
    }
    // A skipped player loses the turn but still draws. Several players can be skipped in one go;
    // they draw in turn order, after the current player, for as long as the tray has cards.
    let remaining = trayBefore > 0 ? trayBefore - 1 : 0;
    const grew = new Map(others.map(([q, h]) => [q.id, q.hand.length - h]));
    for (const ev of g.events.filter((e) => e.seq > seqBefore && e.type === 'skipped')) {
      assert.strictEqual(ev.drew, remaining > 0, 'skipped player draws exactly when the tray has a card');
      if (ev.drew) { remaining--; grew.set(ev.playerId, grew.get(ev.playerId) - 1); stats.skippedDraws++; }
    }
    for (const [id, extra] of grew) assert.strictEqual(extra, 0, `hand of ${id} changed only by its skip draws`);
    assert.strictEqual(totalCards(g), TOTAL, 'no cards lost or duplicated');
    const v = g.viewFor(p.id);
    assert(!('trayMagic' in v) && !('traySkip' in v), 'players are not told how many MAGIC/SKIP cards are in the box');
    const counts = R.primeCounts(g.board);
    for (const s of g.board) {
      if (!s.card) { assert(!s.under); continue; }
      if (s.card.type === 'num') assert.strictEqual(s.card.n, s.n);
      else assert(R.isPrime(s.n));
      if (s.under) assert(s.under.type === 'magic' && s.card.type === 'num');
      for (const m of s.extra) assert(m.type === 'magic' && R.isPrime(s.n));
    }
    for (const s of g.board) if (!s.card) assert.strictEqual(s.extra.length, 0, 'Magic only stacks on an occupied slot');
    for (const s of g.board) if (s.card && s.n > 1 && !R.isPrime(s.n)) {
      const need = {};
      for (const f of R.factorize(s.n)) need[f] = (need[f] || 0) + 1;
      for (const f of Object.keys(need)) assert(counts[f] >= need[f]);
    }
    if (g.tray.length) for (const q of g.players) assert(q.hand.length > 0, 'nobody runs out while the tray has cards');
    // every prime card in any hand always has somewhere to go (empty slot or on top of a Magic)
    for (const q of g.players) for (const c of q.hand) if (c.type === 'num' && R.isPrime(c.n)) assert(R.freeSlot(g.board, c.n), `prime ${c.n} always has a slot`);
  }
  assert.strictEqual(g.phase, 'over');
  const res = g.result;
  if (res.reason === 'out') {
    assert.strictEqual(g.tray.length, 0, 'win only after tray is empty');
    stats.out++;
  } else {
    assert.fail(`game ${seed} ended ${res.reason}: nobody should ever be stuck`);
  }
  for (const p of g.players) assert.strictEqual(res.scores[p.id], p.hand.reduce((s, c) => s + (c.type === 'num' ? c.n : 0), 0));
  stats.games++;
  stats.turns += turns;
}

// ---------- targeted rule checks ----------

// "Can't play" wording (hint-off pop-up)
{
  const board = R.buildSlots().map((s) => ({ ...s, card: null }));
  const put = (n) => { R.freeSlot(board, n).card = { type: 'num', n }; };
  put(1); put(2);
  assert.strictEqual(R.checkNumber(board, 60, false).reason,
    'This card can not be played. To play this card another 2, 3 and 5 should be played on the board.');
  assert.strictEqual(R.checkNumber(board, 32, false).reason,
    'This card can not be played. To play this card four more 2s should be played on the board.');
  assert.strictEqual(R.checkNumber(board, 25, false).reason,
    'This card can not be played. To play this card two 5s should be played on the board.');
  assert.strictEqual(R.checkNumber(board, 7, true).reason, 'This card can not be played. The game starts with the 1 card.');
  assert.strictEqual(R.checkCard(board, { type: 'skip' }, true).reason, 'This card can not be played. The game starts with the 1 card.');
}

// Hand order: arrival order, new cards on the right, played card's gap closes; players can rearrange
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {}, mulberry32(21));
  g.begin();
  const [x, y] = g.order;
  const px = g.player(x);
  const before = px.hand.map((c) => c.id);
  const one = px.hand.find((c) => c.n === 1);
  g.play(x, one.id);
  const expect = before.filter((id) => id !== one.id);
  assert.deepStrictEqual(px.hand.slice(0, -1).map((c) => c.id), expect, 'cards right of the played one moved left');
  assert.strictEqual(px.hand[px.hand.length - 1].id, px.lastDrawn, 'the drawn card arrives on the right');
  const reversed = px.hand.map((c) => c.id).reverse();
  g.reorderHand(x, reversed);
  assert.deepStrictEqual(px.hand.map((c) => c.id), reversed, 'player can rearrange their hand');
  assert.throws(() => g.reorderHand(x, reversed.slice(1)), GameError, 'must include every card');
  assert.throws(() => g.reorderHand(x, [...reversed.slice(1), reversed[1]]), GameError, 'no duplicates');
  assert.throws(() => g.reorderHand(x, [...reversed.slice(1), 'n60_1']), GameError, 'cannot add cards');
  g.reorderHand(y, g.player(y).hand.map((c) => c.id).reverse()); // allowed when it's not your turn
}

// Removing a player mid-game keeps the card count intact and hands the 1 on
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], {}, mulberry32(7));
  g.begin();
  g.removePlayer(g.currentId);
  assert.strictEqual(totalCards(g), 74);
  assert(g.current.hand.some((c) => c.n === 1), 'the 1 passes to the new starting player');
  g.removePlayer(g.order[1]);
  assert.strictEqual(g.phase, 'over');
}

// SKIP: target misses exactly one turn but still draws
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], {}, mulberry32(11));
  g.begin();
  const [x, y, z] = g.order;
  g.play(x, g.player(x).hand.find((c) => c.n === 1).id);
  g.player(y).hand.push({ id: 'skip_test', type: 'skip' });
  const zBefore = g.player(z).hand.length;
  g.play(y, 'skip_test', { target: z });
  assert.strictEqual(g.currentId, x, 'z was skipped');
  assert.strictEqual(g.player(z).hand.length, zBefore + 1, 'skipped player still drew a card');
}

// Must play: a SKIP or MAGIC in hand forbids passing
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {}, mulberry32(5));
  g.begin();
  const [x, y] = g.order;
  g.play(x, g.player(x).hand.find((c) => c.n === 1).id);
  g.player(y).hand = [{ id: 'n60_1', type: 'num', n: 60 }, { id: 'skip_x', type: 'skip' }];
  assert.throws(() => g.pass(y), /can't pass/, 'hints off: refusal does not name the card');
  assert.throws(() => g.pass(y), (e) => !/SKIP|skip/.test(e.message));
  g.player(y).hand = [{ id: 'n60_1', type: 'num', n: 60 }, { id: 'magic_x', type: 'magic' }];
  assert.throws(() => g.pass(y), /can't pass/);
  g.settings.hints = true;
  assert.throws(() => g.pass(y), /You can play your MAGIC card/, 'hints on: refusal names the card');
  g.settings.hints = false;
  g.player(y).hand = [{ id: 'n60_1', type: 'num', n: 60 }];
  g.pass(y); // nothing fits -> pass is allowed
}

// Real card goes on top of a MAGIC standing in for it
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {}, mulberry32(3));
  g.begin();
  const [x, y] = g.order;
  g.play(x, g.player(x).hand.find((c) => c.n === 1).id);
  g.player(y).hand.push({ id: 'magic_t', type: 'magic' });
  const slot13 = R.freeSlot(g.board, 13).i;
  g.play(y, 'magic_t', { slot: slot13 });
  g.player(x).hand.push({ id: 'real13', type: 'num', n: 13 });
  g.play(x, 'real13');
  assert.strictEqual(g.board[slot13].card.id, 'real13');
  assert.strictEqual(g.board[slot13].under.id, 'magic_t');
  assert.strictEqual(R.primeCounts(g.board)[13], 1, 'still counts as a single 13');
}

// MAGIC must go on an empty prime slot while any exist; only when all are filled may it stack
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {}, mulberry32(4));
  g.begin();
  const [x, y] = g.order;
  g.play(x, g.player(x).hand.find((c) => c.n === 1).id);
  g.player(y).hand.push({ id: 'n13_x', type: 'num', n: 13 });
  g.play(y, 'n13_x');
  const slot13 = g.board.find((s) => s.n === 13).i;
  g.player(x).hand.push({ id: 'magic_s', type: 'magic' });
  assert.throws(() => g.play(x, 'magic_s', { slot: slot13 }), /empty prime slot/, 'no stacking while empty prime slots remain');
  assert(!R.magicTargets(g.board).includes(slot13), 'occupied slots are not offered while vacancies exist');
  assert(R.magicTargets(g.board).every((i) => !g.board[i].card), 'only vacant prime slots offered');
  // fill every prime slot: now MAGIC may go on top, and counts as one more copy
  for (const s of g.board) if (R.isPrime(s.n) && !s.card) s.card = { id: 'fill' + s.i, type: 'num', n: s.n };
  assert(R.checkCard(g.board, { type: 'magic' }, false).ok, 'Magic always playable');
  assert(R.magicTargets(g.board).includes(slot13));
  g.play(x, 'magic_s', { slot: slot13 });
  assert.strictEqual(g.board[slot13].extra.length, 1);
  assert.strictEqual(R.primeCounts(g.board)[13], 2, 'Magic on top of 13 = two 13s');
}

// The old 2-player dead end (both hold only MAGIC, every prime slot full) can no longer happen
for (let seed = 1; seed <= 4000; seed++) {
  const rng = mulberry32(100000 + seed);
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {}, rng);
  g.begin();
  while (g.phase === 'playing') {
    const p = g.current;
    const can = g.playable(p);
    if (!can.length) { g.pass(p.id); continue; }
    const nonMagic = can.filter((c) => c.type !== 'magic'); // hoard MAGIC until the very end
    const c = (nonMagic.length ? nonMagic : can)[Math.floor(rng() * (nonMagic.length || can.length))];
    const opts = {};
    if (c.type === 'magic') { const t = R.magicTargets(g.board); opts.slot = t[Math.floor(rng() * t.length)]; }
    if (c.type === 'skip') opts.target = g.order.find((id) => id !== p.id);
    g.play(p.id, c.id, opts);
  }
  assert.strictEqual(g.result.reason, 'out', 'hoarding MAGIC never deadlocks a 2-player game');
}

// autoMove obeys must-play
{
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {}, mulberry32(9));
  g.begin();
  const [x, y] = g.order;
  g.autoMove(x);
  assert(g.board[0].card && g.board[0].card.n === 1, 'autoMove opens with 1');
  g.player(y).hand = [{ id: 'n60_1', type: 'num', n: 60 }, { id: 'n2_9', type: 'num', n: 2 }];
  g.autoMove(y);
  assert(g.player(y).hand.every((c) => c.id !== 'n2_9'), 'autoMove played the playable 2');
  assert(g.events.find((e) => e.type === 'play' && e.playerId === y).auto, 'a move made for the player is marked');
  assert(!g.events.some((e) => e.type === 'draw' && e.auto) && !g.autoFor, 'only the move itself is marked');
}

console.log('All checks passed.', { ...stats, avgTurns: Math.round(stats.turns / stats.games) });
