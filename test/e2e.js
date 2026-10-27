/*
 * End-to-end test: starts the server on a spare port, connects 4 socket clients,
 * plays two full games (a series) and checks scores, reconnection and privacy.
 * Run: node test/e2e.js
 */
process.env.PORT = process.env.PORT || '3100';
process.env.BOT_DELAY_MS = process.env.BOT_DELAY_MS || '20'; // fast computer players for the test
const assert = require('assert');
const { io } = require('socket.io-client');
const R = require('../public/rules.js');
const words = require('../wordfilter.js');
require('../server.js');

const URL = `http://localhost:${process.env.PORT}`;
const call = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const s = io(URL, { forceNew: true });
  const c = { s, name, state: null, id: null, token: null };
  s.on('state', (st) => { c.state = st; });
  return c;
}

async function waitFor(pred, ms = 20000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await sleep(20);
  }
}

async function playOut(clients) {
  let moves = 0;
  for (;;) {
    const g = clients[0].state.game;
    if (g.phase === 'over') return moves;
    const cur = clients.find((c) => c.id === g.current);
    await waitFor(() => cur.state.game.current === cur.id && cur.state.game.phase === 'playing');
    const cg = cur.state.game;
    // privacy: nobody can see another player's hand
    for (const c of clients) assert(c.state.game.players.every((p) => !('hand' in p)), 'no other hands leak');
    const nums = cg.hand.filter((c) => c.type === 'num' && R.checkNumber(cg.board, c.n, cg.firstMove).ok);
    const seq = cg.events.length ? cg.events[cg.events.length - 1].seq : 0;
    let res;
    if (nums.length) res = await call(cur.s, 'play', { cardId: nums[0].id });
    else if (!cg.firstMove && cg.hand.find((c) => c.type === 'magic') && R.magicTargets(cg.board).length) {
      res = await call(cur.s, 'play', { cardId: cg.hand.find((c) => c.type === 'magic').id, slot: R.magicTargets(cg.board)[0] });
    } else if (!cg.firstMove && cg.hand.find((c) => c.type === 'skip')) {
      res = await call(cur.s, 'play', { cardId: cg.hand.find((c) => c.type === 'skip').id, target: cg.order.find((id) => id !== cur.id) });
    } else res = await call(cur.s, 'pass', {});
    assert(!res.error, res.error);
    moves++;
    await waitFor(() => clients.every((c) => {
      const e = c.state.game.events;
      return e.length && e[e.length - 1].seq > seq;
    }));
  }
}

(async () => {
  const names = ['Host', 'Bea', 'Cal', 'Dev'];
  const cs = names.map(client);
  const created = await call(cs[0].s, 'create', { name: 'Host' });
  Object.assign(cs[0], { id: created.id, token: created.token });
  for (const c of cs.slice(1)) {
    const r = await call(c.s, 'join', { code: created.code, name: c.name });
    assert(!r.error, r.error);
    Object.assign(c, { id: r.id, token: r.token });
  }
  // word filter: whole words only, sees through tricks, leaves maths alone
  for (const t of ['fuuuck', 'sh1t', '@ss', 'f u c k', 's.h.i.t', 'BigFuck', 'chutiya', 'tu gandu hai', 'kill yourself', 'Peñis']) {
    assert(words.isRude(t), `rude: ${t}`);
  }
  for (const t of ['class', 'assess', 'Shital', 'Sheetal', 'cockroach', 'Scunthorpe', 'Essex', 'chutney', 'pass the 5', '4 5 5', 'I a m', 'Abdul Kalam', 'लड़ना']) {
    assert(!words.isRude(t), `not rude: ${t}`);
  }
  assert.strictEqual(words.mask('what an ass!'), 'what an ***!');
  assert.strictEqual(words.mask('Play the 2 and 3 first'), 'Play the 2 and 3 first');
  // a rude name is refused (create and join); chat keeps the message but hides the word
  const rude = client('rude');
  const refused = await call(rude.s, 'create', { name: 'Sh1t' });
  assert(refused.error === 'Please choose a different name.' && refused.badName);
  assert.strictEqual((await call(rude.s, 'join', { code: created.code, name: 'B1tch' })).error, 'Please choose a different name.');
  rude.s.close();
  assert((await call(cs[1].s, 'chat', { text: 'you are a sh1t' })).ok);
  await waitFor(() => cs[0].state.chat.length && cs[0].state.chat[cs[0].state.chat.length - 1].text === 'you are a ****');
  assert((await call(cs[2].s, 'chat', { text: 'Class 5 has 12 = 2 x 2 x 3' })).ok);
  await waitFor(() => cs[0].state.chat[cs[0].state.chat.length - 1].text === 'Class 5 has 12 = 2 x 2 x 3');
  // non-host cannot start
  assert((await call(cs[1].s, 'start', {})).error);
  // series length: host only, 1-9
  assert((await call(cs[1].s, 'settings', { seriesGames: 2 })).error, 'only the host sets the series length');
  assert((await call(cs[0].s, 'settings', { seriesGames: 0 })).error);
  assert((await call(cs[0].s, 'settings', { seriesGames: 10 })).error, 'more than 9 games is refused');
  assert((await call(cs[0].s, 'settings', { seriesGames: 9 })).ok, '9 games is allowed');
  assert((await call(cs[0].s, 'settings', { seriesGames: 2 })).ok);
  await waitFor(() => cs[0].state.series.target === 2);
  assert(!(await call(cs[0].s, 'start', {})).error);
  // 5th and 6th players can't join a running game
  const late = client('Late');
  assert((await call(late.s, 'join', { code: created.code, name: 'Late' })).error);
  late.s.close();

  await waitFor(() => cs.every((c) => c.state.game && c.state.game.phase === 'playing'));
  const g0 = cs[0].state.game;
  assert.strictEqual(g0.order[0], g0.toss.winnerId);
  const p1 = cs.find((c) => c.id === g0.toss.winnerId);
  assert(p1.state.game.hand.some((c) => c.n === 1), 'P1 holds 1');
  for (const c of cs) assert.strictEqual(c.state.game.hand.length, 5);
  assert.strictEqual(g0.trayCount, 73 - 19, 'tray = 73 cards (74 minus the 1) minus 19 dealt');
  assert(!('trayMagic' in g0) && !('traySkip' in g0), 'MAGIC/SKIP left in the box stay hidden');
  // host can pick 4-10 SKIP cards; other values are refused
  assert((await call(cs[0].s, 'settings', { skips: 7 })).ok);
  await waitFor(() => cs[0].state.settings.skips === 7);
  await call(cs[0].s, 'settings', { skips: 3 });   // out of range: ignored
  await call(cs[0].s, 'settings', { skips: 11 });  // out of range: ignored
  await sleep(100);
  assert.strictEqual(cs[0].state.settings.skips, 7, 'skips stays within 4-10');

  // leaving mid-game is not allowed; host can't remove a connected player mid-game
  assert((await call(cs[1].s, 'leave', {})).error, 'cannot leave mid-game');
  assert((await call(cs[0].s, 'kick', { id: cs[1].id })).error, 'cannot remove a connected player mid-game');

  // rearranging your hand: saved on the server, visible only to you
  {
    const me = cs[1];
    const ids = me.state.game.hand.map((c) => c.id).reverse();
    assert(!(await call(me.s, 'reorder', { ids })).error);
    await waitFor(() => me.state.game.hand.map((c) => c.id).join() === ids.join());
    assert((await call(me.s, 'reorder', { ids: ids.slice(1) })).error, 'bad order refused');
  }

  // playing out of turn is rejected
  const notCur = cs.find((c) => c.id !== g0.current);
  assert((await call(notCur.s, 'pass', {})).error);

  // reconnect mid-game with the same token keeps the hand
  const victim = cs[2];
  const handBefore = victim.state.game.hand.map((c) => c.id).sort().join();
  victim.s.close();
  const again = client(victim.name);
  const rj = await call(again.s, 'join', { code: created.code, token: victim.token });
  assert(rj.rejoined && rj.id === victim.id);
  Object.assign(again, { id: victim.id, token: victim.token });
  cs[2] = again;
  await waitFor(() => again.state && again.state.game);
  assert.strictEqual(again.state.game.hand.map((c) => c.id).sort().join(), handBefore);

  const moves1 = await playOut(cs);
  const r1 = cs[0].state.game.result;
  console.log(`game 1: ${moves1} moves, ${r1.reason}, winners ${r1.winners.map((id) => cs.find((c) => c.id === id).name)}, scores`, Object.fromEntries(cs.map((c) => [c.name, r1.scores[c.id]])));
  await waitFor(() => cs[0].state.series.games === 1);
  // between games of a running series the set of players is fixed
  assert(cs[0].state.series.running && !cs[0].state.series.done);
  {
    const outsider = client('Outsider');
    const r = await call(outsider.s, 'join', { code: created.code, name: 'Outsider' });
    assert(r.error && /series is in progress/.test(r.error), 'nobody new joins mid-series');
    outsider.s.close();
    assert((await call(cs[0].s, 'addBot', {})).error, 'no bots added mid-series');
    assert((await call(cs[0].s, 'settings', { seriesGames: 5 })).error, 'series length is fixed once started');
  }

  assert(!(await call(cs[0].s, 'start', {})).error, 'host starts game 2');
  await waitFor(() => cs.every((c) => c.state.game && c.state.game.phase === 'playing'));
  {
    const g2 = cs[0].state.game;
    assert.strictEqual(g2.settings.skips, 7, 'game 2 uses the 7 SKIP cards chosen in the lobby');
    assert.strictEqual(g2.trayCount, 76 - 19, 'tray = 76 cards (77 minus the 1) minus 19 dealt');
  }
  const moves2 = await playOut(cs);
  const r2 = cs[0].state.game.result;
  await waitFor(() => cs[0].state.series.games === 2);
  for (const c of cs) assert.strictEqual(cs[0].state.series.totals[c.id], r1.scores[c.id] + r2.scores[c.id]);
  {
    const ser = cs[0].state.series;
    assert(ser.done && !ser.running, 'series is complete after 2 of 2 games');
    assert.strictEqual(ser.history.length, 2);
    // ranking: ascending totals; winner = lowest, loser = highest
    const ranked = cs.map((c) => ({ name: c.name, total: ser.totals[c.id] })).sort((a, b) => a.total - b.total);
    console.log('series ranking:', ranked.map((r, i) => `${i + 1}. ${r.name} (${r.total})`).join('  '), '| winner', ranked[0].name, '| loser', ranked[ranked.length - 1].name);
  }
  console.log(`game 2: ${moves2} moves, ${r2.reason}. Series totals`, Object.fromEntries(cs.map((c) => [c.name, cs[0].state.series.totals[c.id]])));

  // back to lobby, a player leaves, host hands over
  assert(!(await call(cs[0].s, 'lobby', {})).error);
  await call(cs[3].s, 'leave', {});
  await waitFor(() => cs[0].state.members.length === 3);
  // Computer players: host adds bots, only the host plays; bots must take their own turns
  {
    const solo = client('Solo');
    const r = await call(solo.s, 'create', { name: 'Solo' });
    solo.id = r.id;
    for (let k = 0; k < 2; k++) assert(!(await call(solo.s, 'addBot', {})).error, 'host adds a bot');
    await waitFor(() => solo.state && solo.state.members.filter((m) => m.bot).length === 2);
    assert(!(await call(solo.s, 'start', {})).error);
    await waitFor(() => solo.state.game && solo.state.game.phase === 'playing');
    assert((await call(solo.s, 'addBot', {})).error, 'no bots added mid-game');
    let botPlays = 0;
    while (solo.state.game.phase !== 'over') {
      const g = solo.state.game;
      if (g.current === solo.id) {
        const can = R.playableCards(g.board, g.hand, g.firstMove, g.order.length > 1);
        const c = can.find((x) => x.type === 'num') || can[0];
        const res = !c ? await call(solo.s, 'pass', {})
          : await call(solo.s, 'play', { cardId: c.id, slot: c.type === 'magic' ? R.magicTargets(g.board)[0] : undefined, target: c.type === 'skip' ? g.order.find((id) => id !== solo.id) : undefined });
        assert(!res.error, res.error);
      }
      await sleep(15);
      const botNames = solo.state.members.filter((m) => m.bot).map((m) => m.name);
      botPlays = solo.state.game.log.filter((l) => botNames.some((n) => l.text.includes(n))).length;
    }
    assert(botPlays > 10, 'bots played their turns');
    console.log(`bots: game finished, winners ${solo.state.game.result.winners.map((id) => solo.state.members.find((m) => m.id === id).name)}`);
    await call(solo.s, 'leave', {});
    solo.s.close();
  }

  // after a finished series, the next start begins a fresh series with scores cleared
  {
    assert(!(await call(cs[0].s, 'settings', { seriesGames: 3 })).error, 'length can change once the series is over');
    assert(!(await call(cs[0].s, 'start', {})).error);
    await waitFor(() => cs[0].state.game && cs[0].state.game.phase !== 'over');
    const ser = cs[0].state.series;
    assert.strictEqual(ser.games, 0);
    assert.strictEqual(ser.target, 3);
    assert.deepStrictEqual(ser.totals, {});
  }

  console.log('E2E passed.');
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
