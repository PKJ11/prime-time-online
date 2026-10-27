/*
 * Prime Time — authoritative game engine (server side).
 * Pure logic: no sockets, no timers. The server calls these methods and broadcasts views.
 */
const R = require('./public/rules.js');

class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Number of SKIP cards is chosen by the host (4–10).
const SKIP_MIN = 4;
const SKIP_MAX = 10;
const clampSkips = (n) => Math.min(SKIP_MAX, Math.max(SKIP_MIN, Math.round(Number(n) || SKIP_MIN)));

// 68 number cards + 2 MAGIC + 4–10 SKIP
function buildDeck(skips = SKIP_MIN) {
  const cards = [];
  for (let n = 1; n <= R.MAX; n++) {
    const k = R.COPIES[n] || 1;
    for (let c = 1; c <= k; c++) cards.push({ id: `n${n}_${c}`, type: 'num', n });
  }
  cards.push({ id: 'magic_1', type: 'magic' }, { id: 'magic_2', type: 'magic' });
  for (let k = 1; k <= skips; k++) cards.push({ id: `skip_${k}`, type: 'skip' });
  return cards;
}

/*
 * Toss: each contender is dealt a random number card (2–60) from the deck.
 * Smallest wins; tied players re-draw until the tie is broken.
 */
function runToss(ids, rng) {
  const rounds = [];
  let contenders = ids.slice();
  for (let guard = 0; guard < 100; guard++) {
    const pool = shuffle(buildDeck().filter((c) => c.type === 'num' && c.n !== 1), rng);
    const draws = {};
    contenders.forEach((id, i) => { draws[id] = pool[i].n; });
    const min = Math.min(...Object.values(draws));
    const tied = contenders.filter((id) => draws[id] === min);
    rounds.push({ draws, min, tied });
    if (tied.length === 1) return { rounds, winnerId: tied[0] };
    contenders = tied;
  }
  return { rounds, winnerId: contenders[0] };
}

class Game {
  /**
   * @param players [{id, name}] in seat (clockwise) order
   *
   * Rulings confirmed by Logicology:
   *  - If you hold a playable card (number, MAGIC or SKIP) you must play one; pass only when nothing fits.
   *  - A real prime card can be placed on top of a MAGIC card standing in for that prime.
   *  - A skipped player plays nothing but still draws a card from the tray.
   *  - Players cannot leave mid-game; if one is removed, their unplayed cards go back into the tray.
   */
  constructor(players, settings = {}, rng = Math.random) {
    if (players.length < 2 || players.length > 6) fail('Prime Time needs 2 to 6 players.');
    this.rng = rng;
    // hints: show players which of their cards can be played; skips: number of SKIP cards in the deck
    this.settings = { hints: false, ...settings };
    this.settings.skips = clampSkips(this.settings.skips);
    this.players = players.map((p) => ({ id: p.id, name: p.name, hand: [], skips: 0, left: false, lastDrawn: null }));
    // card: the slot's occupant; under: a Magic covered by the real card; extra: Magics stacked on top
    this.board = R.buildSlots().map((s) => ({ ...s, card: null, under: null, extra: [] }));
    this.tray = [];
    this.discard = [];
    this.order = [];
    this.turn = 0;
    this.turnNo = 0;
    this.firstMove = true;
    this.log = [];
    this.events = [];
    this.seq = 0;
    this.result = null;
    // For "what did everyone just do?": each player's latest card on the board, and their latest action.
    this.lastPlay = {};   // playerId -> { slot, turn }
    this.lastAction = {}; // playerId -> short text
    this.phase = 'toss';
    this.toss = runToss(this.players.map((p) => p.id), rng);
  }

  player(id) { return this.players.find((p) => p.id === id); }
  get currentId() { return this.order[this.turn]; }
  get current() { return this.player(this.currentId); }

  addLog(text, kind = 'info') {
    this.log.push({ t: Date.now(), text, kind });
    if (this.log.length > 200) this.log.shift();
  }
  emit(ev) {
    // A move made by autoMove for a human (turn timer, dropped out) is marked, so their screen can say so.
    const auto = this.autoFor && ev.playerId === this.autoFor && (ev.type === 'play' || ev.type === 'pass');
    this.events.push({ seq: ++this.seq, ...ev, ...(auto ? { auto: true } : {}) });
    if (this.events.length > 30) this.events.shift();
  }

  /* Deal after the toss: P1 gets the 1 card + 4 random, everybody else 5 random. */
  begin() {
    if (this.phase !== 'toss') return;
    const ids = this.players.map((p) => p.id);
    const w = ids.indexOf(this.toss.winnerId);
    this.order = ids.slice(w).concat(ids.slice(0, w));

    const deck = buildDeck(this.settings.skips);
    const one = deck.find((c) => c.type === 'num' && c.n === 1);
    this.tray = shuffle(deck.filter((c) => c !== one), this.rng);
    for (const id of this.order) {
      const p = this.player(id);
      if (id === this.toss.winnerId) {
        p.hand.push(one);
        for (let k = 0; k < 4; k++) p.hand.push(this.tray.pop());
      } else {
        for (let k = 0; k < 5; k++) p.hand.push(this.tray.pop());
      }
    }
    this.phase = 'playing';
    this.turn = 0;
    this.turnNo = 1;
    this.turnStartedAt = Date.now();
    const p1 = this.player(this.toss.winnerId);
    this.addLog(`${p1.name} won the toss and starts with the 1 card.`, 'big');
    this.emit({ type: 'start', playerId: p1.id });
  }

  /* ---------- actions ---------- */

  assertTurn(pid) {
    if (this.phase !== 'playing') fail('The game is not in progress.');
    if (pid !== this.currentId) fail("It's not your turn.");
  }

  playable(p) {
    return R.playableCards(this.board, p.hand, this.firstMove, this.order.length > 1);
  }

  play(pid, cardId, opts = {}) {
    this.assertTurn(pid);
    const p = this.player(pid);
    const card = p.hand.find((c) => c.id === cardId);
    if (!card) fail('That card is not in your hand.');
    if (this.firstMove && !(card.type === 'num' && card.n === 1)) fail('Your first move must be the 1 card.');

    let slotIndex = null;
    let text;
    if (card.type === 'num') {
      const chk = R.checkNumber(this.board, card.n, this.firstMove);
      if (!chk.ok) fail(chk.reason);
      let slot = opts.slot != null ? this.board[opts.slot] : null;
      const fits = slot && slot.n === card.n && (!slot.card || slot.card.type === 'magic');
      if (!fits) slot = chk.slot;
      const onMagic = slot.card && slot.card.type === 'magic' ? slot.card : null;
      if (onMagic) slot.under = onMagic; // the real card sits on top of the Magic
      slot.card = { id: card.id, type: 'num', n: card.n, by: pid };
      slotIndex = slot.i;
      text = onMagic ? `${p.name} put a real ${card.n} on top of the MAGIC card.`
        : card.n === 1 ? `${p.name} played the 1. The game has started!`
        : R.isPrime(card.n) ? `${p.name} played ${card.n} (prime).`
        : `${p.name} played ${card.n} (${R.factorize(card.n).join(' × ')}).`;
    } else if (card.type === 'magic') {
      const slot = this.board[opts.slot];
      if (!slot || !R.isPrime(slot.n)) fail('Pick a PRIME slot for your Magic card.');
      if (!R.magicTargets(this.board).includes(slot.i)) fail(R.MAGIC_NEEDS_VACANT);
      const magic = { id: card.id, type: 'magic', as: slot.n, by: pid };
      if (slot.card) {
        slot.extra.push(magic);
        text = `${p.name} played MAGIC on top of ${slot.n}. It counts as one more ${slot.n}.`;
      } else {
        slot.card = magic;
        text = `${p.name} played MAGIC as ${slot.n}.`;
      }
      slotIndex = slot.i;
    } else if (card.type === 'skip') {
      const t = this.player(opts.target);
      if (!t || t.id === pid || t.left || !this.order.includes(t.id)) fail('Choose another player to skip.');
      t.skips++;
      this.discard.push(card);
      text = `${p.name} played SKIP on ${t.name}. ${t.name} misses a turn.`;
    } else fail('Unknown card.');

    p.hand = p.hand.filter((c) => c !== card);
    this.firstMove = false;
    this.addLog(text, card.type === 'num' ? 'play' : card.type);
    this.emit({ type: 'play', playerId: pid, card: { ...card }, slot: slotIndex, target: opts.target || null });
    if (slotIndex != null) this.lastPlay[pid] = { slot: slotIndex, turn: this.turnNo };
    this.lastAction[pid] = card.type === 'num' ? `played ${card.n}`
      : card.type === 'magic' ? `MAGIC as ${this.board[slotIndex].n}`
      : `SKIP on ${this.player(opts.target).name}`;
    this.endTurn(p);
  }

  pass(pid) {
    this.assertTurn(pid);
    const p = this.player(pid);
    if (this.firstMove) fail('You must start the game by placing the 1 card.');
    const can = this.playable(p);
    if (can.length) {
      if (!this.settings.hints) fail("You can't pass — at least one of your cards can be played. Look again!");
      const c = can[0];
      const what = c.type === 'num' ? String(c.n) : c.type === 'magic' ? 'your MAGIC card' : 'your SKIP card';
      fail(`You can play ${what} — if you have a playable card you must play it.`);
    }
    this.addLog(`${p.name} could not play and passed.`, 'pass');
    this.emit({ type: 'pass', playerId: pid });
    this.lastAction[pid] = 'passed';
    this.endTurn(p);
  }

  /*
   * Automatic move (computer players, turn timer, dropped-out players), obeying the must-play rule:
   * plays the biggest playable number, else MAGIC (as a prime that unlocks one of the player's own
   * cards if possible), else SKIP on the opponent with the fewest cards, else passes.
   */
  autoMove(pid) {
    this.autoFor = pid;
    try { return this.pickMove(pid); } finally { this.autoFor = null; }
  }

  pickMove(pid) {
    const p = this.player(pid);
    const can = this.playable(p);
    const nums = can.filter((c) => c.type === 'num').sort((a, b) => b.n - a.n);
    if (nums.length) return this.play(pid, nums[0].id);
    const magic = can.find((c) => c.type === 'magic');
    if (magic) {
      // prefer a prime that unlocks one of the player's own cards, and an empty slot over a covered one
      const targets = R.magicTargets(this.board).sort((a, b) => !!this.board[a].card - !!this.board[b].card);
      const want = p.hand.filter((c) => c.type === 'num').flatMap((c) => R.checkNumber(this.board, c.n, false).missing);
      const slot = targets.find((i) => want.includes(this.board[i].n)) ?? targets[0];
      return this.play(pid, magic.id, { slot });
    }
    const skip = can.find((c) => c.type === 'skip');
    if (skip) {
      // skip whoever is closest to winning (fewest cards); ties go to the next player in turn order
      const others = [];
      for (let k = 1; k < this.order.length; k++) others.push(this.player(this.order[(this.turn + k) % this.order.length]));
      const target = others.reduce((best, q) => (q.hand.length < best.hand.length ? q : best));
      return this.play(pid, skip.id, { target: target.id });
    }
    return this.pass(pid);
  }

  draw(p) {
    p.lastDrawn = null;
    if (!this.tray.length) return;
    const c = this.tray.pop();
    p.hand.push(c);
    p.lastDrawn = c.id;
    this.emit({ type: 'draw', playerId: p.id });
    if (this.tray.length === 0) this.addLog('The box is empty! The first player with no cards wins.', 'big');
  }

  /* Every turn ends with a compulsory draw from the tray (while it has cards). */
  endTurn(p) {
    this.draw(p);
    if (p.hand.length === 0) return this.finish('out', p.id);
    this.advance();
  }

  advance() {
    for (let guard = 0; guard < 200; guard++) {
      if (this.checkBlocked()) return;
      this.turn = (this.turn + 1) % this.order.length;
      const np = this.current;
      if (np.skips > 0) {
        // A skipped player loses the turn but still has to pick up a card.
        np.skips--;
        this.addLog(`${np.name} missed a turn${this.tray.length ? ' and took a card' : ''}.`, 'skip');
        this.emit({ type: 'skipped', playerId: np.id, drew: this.tray.length > 0 });
        this.lastAction[np.id] = 'was skipped';
        this.draw(np);
        continue;
      }
      break;
    }
    this.turnNo++;
    this.turnStartedAt = Date.now();
  }

  /*
   * Safety net only. Under these rules somebody can always play (primes always have a slot,
   * MAGIC can go on any prime, SKIP needs just one opponent), so this should never trigger.
   * If it ever did, the game would end and the lowest total win.
   */
  checkBlocked() {
    if (this.phase !== 'playing' || this.tray.length) return false;
    if (this.order.some((id) => this.playable(this.player(id)).length)) return false;
    this.finish('blocked');
    return true;
  }

  score(p) { return p.hand.reduce((s, c) => s + R.cardValue(c), 0); }

  finish(reason, winnerId = null) {
    this.phase = 'over';
    const active = this.players.filter((p) => !p.left);
    const scores = {};
    for (const p of active) scores[p.id] = this.score(p);
    let winners;
    if (winnerId) winners = [winnerId];
    else {
      const best = Math.min(...active.map((p) => scores[p.id]));
      winners = active.filter((p) => scores[p.id] === best).map((p) => p.id);
    }
    const hands = {};
    for (const p of active) hands[p.id] = p.hand.slice();
    this.result = { reason, winners, scores, hands };
    const names = winners.map((id) => this.player(id).name).join(' & ');
    this.addLog(reason === 'out' ? `${names} played every card and won!`
      : reason === 'blocked' ? `Nobody could play. ${names} had the lowest score and won.`
      : `${names} won. Everyone else left.`, 'big');
    this.emit({ type: 'over', winners });
  }

  /* A player is removed mid-game (dropped out for good): their unplayed cards go back into the tray. */
  removePlayer(pid) {
    const p = this.player(pid);
    if (!p || p.left) return;
    p.left = true;
    delete this.lastPlay[pid];
    delete this.lastAction[pid];
    if (this.phase === 'toss') {
      this.players = this.players.filter((x) => x.id !== pid);
      this.toss = runToss(this.players.map((x) => x.id), this.rng);
      return;
    }
    if (this.phase !== 'playing') return;
    const idx = this.order.indexOf(pid);
    const one = p.hand.find((c) => c.type === 'num' && c.n === 1);
    const rest = p.hand.filter((c) => c !== one);
    this.tray = shuffle(this.tray.concat(rest), this.rng);
    p.hand = [];
    const wasCurrent = idx === this.turn;
    this.order.splice(idx, 1);
    this.addLog(`${p.name} was removed. Their cards went back into the box.`, 'info');
    if (this.order.length < 2) return this.finish('forfeit', this.order[0]);
    if (idx < this.turn) this.turn--;
    else if (wasCurrent) {
      this.turn = (idx - 1 + this.order.length) % this.order.length;
      this.advance();
    }
    if (one) this.current.hand.push(one); // the opening 1 card passes to whoever starts now
  }

  /*
   * A player rearranges their own hand. Hands are kept in arrival order (new cards go on the
   * right, played cards leave a gap that closes up); this lets the player choose any order.
   */
  reorderHand(pid, ids) {
    if (this.phase !== 'playing' && this.phase !== 'over') fail('There is no hand to arrange yet.');
    const p = this.player(pid);
    if (!p || p.left) fail('You are not in this game.');
    if (!Array.isArray(ids) || ids.length !== p.hand.length) fail('That order does not match your hand.');
    const byId = new Map(p.hand.map((c) => [c.id, c]));
    if (new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) fail('That order does not match your hand.');
    p.hand = ids.map((id) => byId.get(id));
  }

  /* ---------- views ---------- */

  viewFor(pid) {
    const me = this.player(pid);
    const pub = (p) => ({ id: p.id, name: p.name, count: p.hand.length, skips: p.skips, left: p.left });
    return {
      phase: this.phase,
      toss: this.toss,
      order: this.order,
      current: this.phase === 'playing' ? this.currentId : null,
      turnNo: this.turnNo,
      turnStartedAt: this.turnStartedAt || null,
      firstMove: this.firstMove,
      trayCount: this.tray.length,
      // No MAGIC/SKIP counts: as in the real game, players don't know what is left in the box (owner, 2026-10-13).
      lastPlay: this.lastPlay,
      lastAction: this.lastAction,
      discard: this.discard.map((c) => c.type),
      board: this.board.map((s) => ({ i: s.i, n: s.n, card: s.card, under: s.under, extra: s.extra })),
      players: this.players.filter((p) => !p.left).map(pub),
      hand: me && !me.left ? me.hand : [],
      lastDrawn: me ? me.lastDrawn : null,
      log: this.log.slice(-60),
      events: this.events.slice(-10),
      result: this.result,
      settings: this.settings,
    };
  }
}

module.exports = { Game, GameError, buildDeck, runToss, shuffle, SKIP_MIN, SKIP_MAX };
