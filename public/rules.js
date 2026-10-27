/*
 * Prime Time — shared rules (used by both the server and the browser).
 * Board = 68 slots: numbers 1–60, with 5×2, 3×3, 2×5 and 2×7.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PTRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX = 60;
  const COPIES = { 2: 5, 3: 3, 5: 2, 7: 2 };

  function isPrime(n) {
    if (n < 2) return false;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
    return true;
  }

  // 12 -> [2, 2, 3]
  function factorize(n) {
    const out = [];
    let m = n;
    for (let d = 2; d * d <= m; d++) while (m % d === 0) { out.push(d); m /= d; }
    if (m > 1) out.push(m);
    return out;
  }

  const PRIME_COLORS = {
    2: '#f08a4b', 3: '#5aaee0', 5: '#ec5f7e', 7: '#f2b632', 11: '#9ccc3c',
    13: '#3fc1b5', 17: '#c75fd6', 19: '#b04a7f', 23: '#4caf7a', 29: '#7d6fe0',
  };
  const BIG_PRIME = '#9a86e8';  // 31–59 share one colour (no multiples ≤ 60)
  const COMPOSITE = '#5b82ad';
  const UNIQUE = '#9aa3ad';

  function colorFor(n) {
    if (n === 1) return UNIQUE;
    if (isPrime(n)) return PRIME_COLORS[n] || BIG_PRIME;
    return COMPOSITE;
  }

  function buildSlots() {
    const slots = [];
    for (let n = 1; n <= MAX; n++) {
      const k = COPIES[n] || 1;
      for (let c = 0; c < k; c++) slots.push({ i: slots.length, n });
    }
    return slots;
  }

  /*
   * How many copies of each prime are on the board. Each occupied slot counts once (a Magic standing
   * in, or a real card — even one placed on top of a Magic), and every Magic stacked on top of an
   * occupied slot counts as one more copy of that prime.
   */
  function primeCounts(board) {
    const counts = {};
    for (const s of board) {
      if (!s.card || !isPrime(s.n)) continue;
      counts[s.n] = (counts[s.n] || 0) + 1 + (s.extra ? s.extra.length : 0);
    }
    return counts;
  }

  // A slot the real card n can go on: an empty one, or one where a MAGIC card stands in for n
  // (the real card is placed on top of the Magic).
  function freeSlot(board, n) {
    return board.find((s) => s.n === n && !s.card)
      || board.find((s) => s.n === n && s.card && s.card.type === 'magic')
      || null;
  }

  /*
   * Words for the missing factors, e.g. one 2 already on the board and 60 selected:
   * missing [2, 3, 5] -> "another 2, 3 and 5".
   */
  const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five'];
  function missingPhrase(missing, have) {
    const counts = new Map();
    for (const p of missing) counts.set(p, (counts.get(p) || 0) + 1);
    const parts = [...counts].map(([p, k]) => (have[p]
      ? (k === 1 ? `another ${p}` : `${COUNT_WORDS[k]} more ${p}s`)
      : (k === 1 ? `${p}` : `${COUNT_WORDS[k]} ${p}s`)));
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  }
  const NOT_PLAYABLE = 'This card can not be played.';

  /**
   * Can a number card be played right now?
   * Returns { ok, reason, factors, missing, slot }.
   */
  function checkNumber(board, n, firstMove) {
    const factors = n === 1 ? [] : factorize(n);
    const res = { ok: false, reason: '', factors, missing: [], slot: null };
    if (firstMove) {
      if (n === 1) { res.ok = true; res.slot = freeSlot(board, 1); }
      else res.reason = `${NOT_PLAYABLE} The game starts with the 1 card.`;
      return res;
    }
    if (n === 1) { res.reason = `${NOT_PLAYABLE} 1 has already been played.`; return res; }
    const slot = freeSlot(board, n);
    if (!slot) {
      res.reason = `${NOT_PLAYABLE} ${COPIES[n] ? `All ${COPIES[n]} slots for ${n} are already filled.` : `${n} is already on the board.`}`;
      return res;
    }
    res.slot = slot;
    if (isPrime(n)) { res.ok = true; return res; }
    const need = {};
    for (const p of factors) need[p] = (need[p] || 0) + 1;
    const have = primeCounts(board);
    for (const p of Object.keys(need)) {
      const short = need[p] - (have[p] || 0);
      for (let k = 0; k < short; k++) res.missing.push(Number(p));
    }
    res.missing.sort((a, b) => a - b);
    if (res.missing.length) {
      res.reason = `${NOT_PLAYABLE} To play this card ${missingPhrase(res.missing, have)} should be played on the board.`;
      return res;
    }
    res.ok = true;
    return res;
  }

  /*
   * Where a MAGIC card may go. While any prime slot is still empty it must go on an empty prime
   * slot (where it stands in for that prime). Only once every prime slot is filled may it be put
   * on top of a prime already on the board, where it counts as one more copy of that prime.
   * Either way there is always somewhere to put it.
   */
  function magicTargets(board) {
    const primeSlots = board.filter((s) => isPrime(s.n));
    const vacant = primeSlots.filter((s) => !s.card);
    return (vacant.length ? vacant : primeSlots).map((s) => s.i);
  }
  const MAGIC_NEEDS_VACANT = 'Put MAGIC on an empty prime slot. It can go on top of a card only when all prime slots are full.';

  /**
   * Is this card playable right now? Works for number, MAGIC and SKIP cards.
   * canSkip: whether there is another player to target.
   */
  function checkCard(board, card, firstMove, canSkip = true) {
    if (card.type === 'num') return checkNumber(board, card.n, firstMove);
    if (firstMove) return { ok: false, reason: `${NOT_PLAYABLE} The game starts with the 1 card.` };
    if (card.type === 'magic') {
      return { ok: true };
    }
    if (card.type === 'skip') return canSkip ? { ok: true } : { ok: false, reason: 'There is nobody else to skip.' };
    return { ok: false, reason: 'Unknown card.' };
  }

  function playableCards(board, hand, firstMove, canSkip = true) {
    return hand.filter((c) => checkCard(board, c, firstMove, canSkip).ok);
  }

  function cardValue(card) {
    return card.type === 'num' ? card.n : 0;
  }

  return {
    MAX, COPIES, isPrime, factorize, colorFor, PRIME_COLORS, BIG_PRIME, COMPOSITE, UNIQUE,
    buildSlots, primeCounts, missingPhrase, MAGIC_NEEDS_VACANT, freeSlot, checkNumber, checkCard, playableCards, magicTargets, cardValue,
  };
});
