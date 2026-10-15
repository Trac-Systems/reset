import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { gameLedger } from './helpers/games.mjs';
import { addr, chain, solve, parseHeader, checkpoint, beaconOptions } from './helpers/chain.mjs';
import { GAME_INFLOW, MINE_DEFAULTS, stableJSON, parseEnvelope, circularDistance, lotteryPayout,
  minePayout, mineGuideline, addMineInflow, validParam, checkPuzzle } from '../contract/rules/index.js';

const headers = chain(1400);
const funded = n => Array.from({ length: n }, (_, i) => [addr(i + 10), 10000000000n]);

test('guess/claim exact schemas, integer bounds and all game knob validators', () => {
  for (const [t, p] of [['guess', { tb: 8, n: 'ffffffff' }], ['claim', { r: 0, q: 0 }], ['claim', { r: 0, q: 2000 }]])
    assert.ok(parseEnvelope(solve(t, p, checkpoint, addr(1))).envelope);
  for (const [t, p] of [['guess', { tb: -1, n: 'ffffffff' }], ['guess', { tb: 1, n: 'FFFFFFFF' }],
    ['guess', { tb: 1, n: '0' }], ['claim', { r: 0, q: 2001 }], ['claim', { r: 0, q: -1 }],
    ['claim', { r: 0, q: 1.1 }], ['claim', { r: '0', q: 1000 }], ['claim', { r: 0, q: 1000, extra: 0 }]])
    assert.equal(parseEnvelope(solve(t, p, checkpoint, addr(1))).error, 'payload');
  for (const [key, value] of Object.entries(MINE_DEFAULTS)) assert.ok(validParam(key, value));
  for (const value of ['0', '3', '01', '1.0', 100, '9'.repeat(79)]) assert.equal(validParam('mine_capacity', value), false);
  assert.equal(validParam('lottery_blocks', 2017), false);
});

test('lottery circular distance, closest ten, ties at cut and integer dust', () => {
  assert.equal(circularDistance('ffffffff', '0'.repeat(64)), 1);
  assert.equal(circularDistance('80000000', '0'.repeat(64)), 2147483648);
  const guesses = Array.from({ length: 9 }, (_, i) => ({ address: addr(i + 1), n: i.toString(16).padStart(8, '0') }));
  guesses.push({ address: addr(10), n: '00000009' }, { address: addr(11), n: 'fffffff7' });
  const result = lotteryPayout(guesses, '0'.repeat(64), 10);
  assert.equal(result.winners.length, 11);
  assert.deepEqual(result.winners.slice(-2).map(w => w.amount), ['15468750', '15468750']);
  assert.equal(result.paid, GAME_INFLOW.toString());
  const dust = lotteryPayout(Array.from({ length: 11 }, (_, i) => ({ address: addr(i + 1), n: '00000000' })), '0'.repeat(64), 10);
  assert.equal(BigInt(dust.paid) + BigInt(dust.to_mine), GAME_INFLOW);
  assert.ok(BigInt(dust.to_mine) < 11n);
});

test('lottery contract: cutoff, per-target address limit, payouts, pruning and one-time settlement', async () => {
  const l = gameLedger({ headers });
  await l.advance(1);
  const hash = parseHeader(headers[9]).hash, n = Number.parseInt(hash.slice(-8), 16);
  for (let i = 0; i < 12; i++) {
    const offset = i < 9 ? i : i < 11 ? (i === 9 ? 9 : -9) : 10;
    assert.equal(await l.move('guess', { tb: 10, n: ((n + offset) >>> 0).toString(16).padStart(8, '0') }, addr(i + 10)), null);
  }
  assert.equal(await l.move('guess', { tb: 10, n: '00000000' }, addr(10)), 'already_guessed');
  assert.equal(await l.tx('lottery_winners', 2), 'lottery_locked');
  assert.equal(await l.move('guess', { tb: 145, n: '00000000' }, addr(30)), 'lottery_window');
  await l.advance(7);
  assert.equal(await l.move('guess', { tb: 10, n: '00000000' }, addr(31)), null, 'cutoff inclusive');
  await l.advance(8);
  assert.equal(await l.move('guess', { tb: 10, n: '00000000' }, addr(32)), 'guess_late');
  await l.advance(15);
  const result = l.data.get('lottery/result/10');
  assert.equal(result.hash, hash); assert.equal(result.winners.length, 11); assert.equal(result.paid, GAME_INFLOW.toString());
  assert.equal(l.data.get(`bal/${addr(10)}`), '30937500');
  assert.equal(l.data.get(`bal/${addr(19)}`), '15468750');
  assert.equal(l.data.get(`bal/${addr(20)}`), '15468750');
  for (const key of l.data.keys()) assert.ok(!/^lottery\/(guess|seen|target)\/10(?:\/|$)/.test(key), key);
  assert.equal((await l.view().state()).lottery.open_targets.length, 0);
  const publicResult = (await l.view().state()).lottery.recent_results.find(x => x.tb === 10);
  assert.equal(publicResult.winner_count, 11); assert.equal(publicResult.winners.length, 10); assert.equal(publicResult.winners_truncated, true);
  const issued = l.data.get('supply/issued');
  assert.equal(await l.move('header', { hx: [headers[14]] }), 'header_known');
  assert.equal(l.data.get('supply/issued'), issued); l.check();
});

test('lottery fewer guesses, empty slots and post-window inflow stay exactly conserved', async () => {
  const l = gameLedger({ headers, params: { lottery_start_block: 4, lottery_blocks: 1 } });
  assert.equal(await l.move('guess', { tb: 4, n: '00000000' }, addr(10)), null);
  assert.equal(await l.move('guess', { tb: 4, n: 'ffffffff' }, addr(11)), null);
  await l.advance(10);
  const result = l.data.get('lottery/result/4');
  assert.equal(result.paid, '61875000'); assert.equal(result.to_mine, '247500000');
  // Heights before lottery_start_block (the coin start) mint nothing: only heights 4 and 5 are counted here.
  assert.equal(l.data.get('pool/game'), (GAME_INFLOW * 2n - 61875000n).toString());
  assert.equal(l.data.get('cnt/3').minted, '0');
  assert.equal(l.data.get('lottery/result/5'), undefined); l.check();
});

test('guess puzzle has independent floor/demand adjustment; target capacity and pending config', async () => {
  const l = gameLedger({ headers, params: { guess_bits: 8, capacity: 2, per_address: 1 } });
  const e = JSON.parse(solve('guess', { tb: 20, n: '00000000' }, checkpoint, addr(10)));
  while (checkPuzzle(addr(10), e, 8)) e.w = (BigInt(`0x${e.w}`) + 1n).toString(16);
  assert.equal(await l.move('guess', e.p, addr(10), stableJSON(e)), 'puzzle');
  assert.equal(await l.tx('lottery_start_block', 2), null);
  assert.equal(await l.move('guess', e.p, addr(10)), 'lottery_pending');
  await l.advance(6);
  for (let h = 6; h < 9; h++) {
    for (let j = 0; j < 2; j++) assert.equal(await l.move('guess', e.p, addr(h * 10 + j)), null);
    if (h === 6) {
      assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(99)), 'capacity');
    }
    await l.advance(h + 1);
  }
  assert.equal(await l.move('guess', e.p, addr(99)), 'lottery_capacity');
  const state = await l.view().state(); assert.ok(state.bits.guess > 8); assert.ok(state.bits.claim < state.bits.guess);
  l.check();
});

test('mine claims use snapshots, closed windows and round identity; fair share pays before greedy excess', async () => {
  const l = gameLedger({ headers, deposits: funded(3), stock: 22275000000n });
  assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(10)), 'claim_window');
  await l.advance(1);
  assert.equal(await l.move('claim', { r: 1, q: 1000 }, addr(10)), 'mine_round');
  assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(50)), 'deposit');
  assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(10)), null);
  assert.equal(await l.move('claim', { r: 0, q: 2000 }, addr(10)), 'already_claimed');
  assert.equal(await l.move('claim', { r: 0, q: 2000 }, addr(11)), null);
  assert.equal(await l.move('unlock', { amount: '5000000000' }, addr(10)), null);
  assert.equal((await l.view().account(addr(10))).mine.claim.d, '10000000000');
  await l.advance(3);
  assert.equal(await l.move('claim', { r: 0, q: 0 }, addr(12)), null);
  await l.advance(4);
  assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(13)), 'claim_window');
  await l.advance(11);
  const moderate = l.data.get(`mine/result/${addr(10)}`), greedy = l.data.get(`mine/result/${addr(11)}`);
  assert.equal(moderate.amount, moderate.fair); assert.equal(moderate.fair, greedy.fair);
  assert.ok(BigInt(greedy.amount) - BigInt(greedy.penalty) <= BigInt(moderate.amount));
  assert.equal(l.data.get(`dep/${addr(10)}`), '5000000000');
  assert.equal(l.data.get('mine/round/0'), undefined);
  for (const key of l.data.keys()) assert.ok(!/^mine\/(claim|seen)\/0\//.test(key));
  l.check();
});

test('penalties reach exiting collateral; short exit wait cannot escape unsettled snapshots', async () => {
  const l = gameLedger({ headers, deposits: funded(2), stock: 22275000000n, params: { exit_wait: 1 } });
  await l.advance(1);
  for (let i = 0; i < 2; i++) assert.equal(await l.move('claim', { r: 0, q: i ? 1000 : 2000 }, addr(10 + i)), null);
  assert.equal(await l.move('unlock', { amount: '10000000000' }, addr(10)), null);
  await l.advance(6);
  assert.equal(await l.move('withdraw', {}, addr(10)), 'claim_pending');
  await l.advance(11);
  const penalty = BigInt(l.data.get(`mine/result/${addr(10)}`).penalty);
  assert.ok(penalty > 0n); assert.equal(l.data.get(`exit/${addr(10)}`)[0].amount, (10000000000n - penalty).toString());
  assert.equal(await l.move('withdraw', {}, addr(10)), null); l.check();
});

test('exiting record bound keeps penalty work bounded, coalesces releases and recovers after withdrawal', async () => {
  const l = gameLedger({ headers, deposits: funded(1) });
  for (let i = 0; i < 256; i++) {
    await l.advance(6 + i);
    assert.equal(await l.move('unlock', { amount: '1' }, addr(10)), null);
  }
  assert.equal(l.data.get(`exit/${addr(10)}`).length, 256);
  assert.equal(await l.move('unlock', { amount: '1' }, addr(10)), null, 'existing release coalesces at the bound');
  await l.advance(262);
  assert.equal(await l.move('unlock', { amount: '1' }, addr(10)), 'exit_capacity');
  assert.equal(await l.move('withdraw', {}, addr(10)), null);
  assert.equal(await l.move('unlock', { amount: '1' }, addr(10)), null);
  assert.ok(l.data.get(`exit/${addr(10)}`).length < 256); l.check();
});

test('tiny/unbacked collateral cannot profit from overclaim; exact forgivable graduated strikes', () => {
  const claims = [{ address: addr(1), d: '1', q: 2000, collateral: '1', strikes: 0, clean: 0 },
    { address: addr(2), d: '1', q: 1000, collateral: '1' }];
  const result = minePayout(claims, 10000000000n, 44550000000n, MINE_DEFAULTS);
  assert.ok(BigInt(result.results[0].amount) - BigInt(result.results[0].penalty) <= BigInt(result.results[0].fair));
  let row = { ...claims[0], collateral: '100000000000' };
  for (let i = 1; i <= 6; i++) { const r = minePayout([row], 10000000000n, 44550000000n, MINE_DEFAULTS).results[0]; assert.equal(r.strikes, Math.min(i, 4)); row = { ...row, ...r }; }
  row.q = 1000;
  for (let i = 1; i <= 24; i++) { const r = minePayout([row], 10000000000n, 44550000000n, MINE_DEFAULTS).results[0]; assert.equal(r.strikes, i < 24 ? 4 : 3); row = { ...row, ...r }; }
  const limited = minePayout([2000, 1500, 1000, 0].map((q, i) => ({ address: addr(i), d: '1', q, collateral: '1000' })), 100n, 100n, MINE_DEFAULTS);
  assert.deepEqual(limited.results.map(x => x.amount), ['41', '33', '25', '0']);
  assert.equal(limited.paid, '99'); assert.equal(limited.penalties, '37'); assert.equal(limited.stock, '38');
});

test('contract forgives a strike only after 24 clean settled participations', async () => {
  const l = gameLedger({ headers, deposits: [[addr(10), 100000000000n], [addr(11), 100000000000n]], stock: 22275000000n });
  for (let r = 0; r < 28; r++) {
    await l.advance(r * 6 + 1);
    assert.equal(await l.move('claim', { r, q: r < 4 ? 2000 : 1000 }, addr(10)), null);
    assert.equal(await l.move('claim', { r, q: 1000 }, addr(11)), null);
  }
  await l.advance(28 * 6 - 1);
  assert.deepEqual(l.data.get(`mine/strikes/${addr(10)}`), { strikes: 4, clean: 23 });
  await l.advance(28 * 6 + 5);
  assert.deepEqual(l.data.get(`mine/strikes/${addr(10)}`), { strikes: 3, clean: 0 });
  assert.equal(l.data.get(`dep/${addr(11)}`), '100000000000'); l.check();
});

test('vein, overflow, sustained bonus and collapse use exact BigInts', () => {
  const flow = addMineInflow(100n, 50n, 100n, 20n, '0'.repeat(61) + 'aaa');
  assert.deepEqual(flow, { stock: 170n, vein: 0n, found: true, released: 70n });
  assert.equal(addMineInflow(flow.stock, 0n, 100n, 20n, '0'.repeat(61) + 'abc').stock, 170n, 'vein not swept back next block');
  let cap = 44550000000n;
  for (let i = 0; i < 100; i++) {
    const g = mineGuideline(1n, cap, MINE_DEFAULTS);
    assert.equal(g.collapse, true); assert.equal(g.guideline, 1n); assert.ok(g.capacity <= cap); cap = g.capacity;
  }
  assert.equal(cap, 11137500000n);
});

test('admin mine settings apply next tip round, retain old snapshots and force collapse at settlement', async () => {
  // A full Mine arms the collapse safety; the raised capacity then forces it.
  const l = gameLedger({ headers, deposits: funded(1), stock: BigInt(MINE_DEFAULTS.mine_capacity) });
  await l.advance(1);
  for (const [key, value] of Object.entries({ ...MINE_DEFAULTS, mine_capacity: '1000000000000' })) assert.equal(await l.tx(key, value), null);
  assert.equal((await l.view().state()).params.mine_capacity, MINE_DEFAULTS.mine_capacity);
  assert.equal(await l.tx('mine_bonus_per_mille', 200, addr(2)), 'admin');
  assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(10)), null);
  await l.advance(7);
  assert.equal((await l.view().state()).params.mine_capacity, '1000000000000');
  assert.equal(await l.move('claim', { r: 1, q: 1000 }, addr(10)), null);
  await l.advance(11);
  assert.equal(l.data.get('mine/last').r, 0);
  assert.ok(BigInt(l.data.get('mine/capacity')) <= BigInt(MINE_DEFAULTS.mine_capacity));
  await l.advance(17);
  assert.equal(l.data.get('mine/armed'), true);
  assert.equal(l.data.get('mine/last').r, 1); assert.equal(l.data.get('mine/last').collapse, true);
  assert.equal(l.data.get('mine/capacity'), '950000000000'); l.check();
});

test('full capacity: 1800 claims, bounded settlement touches no dormant deposits', async t => {
  const deposits = funded(1800);
  for (let i = 10000; i < 11000; i++) deposits.push([addr(i), 10000000000n]);
  const l = gameLedger({ headers, deposits, stock: 22275000000n });
  for (let h = 1; h <= 3; h++) {
    await l.advance(h);
    for (let i = 0; i < 600; i++) assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(10 + (h - 1) * 600 + i)), null);
    assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(10000)), 'capacity');
  }
  await l.advance(10);
  const reads = [], originalGet = l.storage.get;
  l.storage.get = async key => { reads.push(key); return originalGet(key); };
  const start = performance.now(); await l.advance(11); const elapsed = performance.now() - start;
  assert.equal(l.data.get('mine/last').claims, 1800);
  assert.equal(reads.filter(k => k.startsWith('mine/claim/0/')).length, 1800);
  assert.ok(!reads.some(k => /^dep\//.test(k) && BigInt(`0x${k.slice(4)}`) >= 10000n));
  assert.ok(elapsed < 5000);
  t.diagnostic(`Full-capacity header apply including 1800-claim settlement: ${elapsed.toFixed(3)} ms; ${reads.length} storage reads.`);
  l.check();
});

test('collapse safety stays off until the Mine has been half full', async () => {
  const l = gameLedger({ headers, deposits: funded(1) });
  await l.advance(1);
  assert.notEqual(l.data.get('mine/armed'), true);
  assert.equal(await l.move('claim', { r: 0, q: 1000 }, addr(10)), null);
  await l.advance(12);
  assert.equal(l.data.get('mine/last').r, 0);
  assert.equal(l.data.get('mine/last').collapse, false, 'an empty launch Mine is not a collapse');
  assert.equal(l.data.get('mine/capacity'), MINE_DEFAULTS.mine_capacity); l.check();
});
