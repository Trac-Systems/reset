import test from 'node:test';
import assert from 'node:assert/strict';
import { gameLedger } from './helpers/games.mjs';
import { addr, chain, beaconOptions } from './helpers/chain.mjs';
import { GAME_INFLOW, MINE_DEFAULTS } from '../contract/rules/index.js';

// Strategy scenarios for the Mine rules in docs/SPEC.md §10, run through the real contract.
const ROUNDS = 240, INITIAL = 10000000000n, headers = chain(ROUNDS * 6 + 5);
const strategies = (type, count) => Array.from({ length: 100 }, (_, i) => i < count ? type : 'moderate');
async function simulate(types, { participation = 100, stock = 22275000000n, split = false, vein = false, collapse = false } = {}) {
  const agents = types.map((type, i) => ({ address: addr(i + 10), type, initial: INITIAL }));
  if (split) {
    agents.shift();
    for (let i = 0; i < 10; i++) agents.push({ address: addr(1000 + i), type: 'split', initial: INITIAL / 10n });
  }
  // Retarget is off in regtest. A shorter retention interval avoids repeatedly
  // copying 1440 irrelevant old headers; finality and real proof checks stay on.
  const beacon = { ...beaconOptions, params: { ...beaconOptions.params, interval: 12 } };
  const l = gameLedger({ headers, stock, deposits: agents.map(a => [a.address, a.initial]), beacon });
  let found = false, collapsed = false;
  for (let r = 0; r < ROUNDS; r++) {
    await l.advance(r * 6 + 1);
    if (collapse && r === 0) assert.equal(await l.tx('mine_capacity', '10000000000000'), null);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.type === 'exitraid') {
        const counted = (await l.view().head()).counted;
        if ((l.data.get(`exit/${a.address}`) ?? []).some(x => x.release <= counted)) {
          assert.equal(await l.move('withdraw', {}, a.address), null);
          const balance = l.data.get(`bal/${a.address}`) ?? '0';
          if (BigInt(balance) > 0n) assert.equal(await l.move('lock', { amount: balance }, a.address), null);
        }
      }
      if (BigInt(l.data.get(`dep/${a.address}`) ?? '0') === 0n) continue;
      // Deterministic rotating attendance, independent of strategy/claim level.
      if ((i + r * 37) % 100 >= participation || (a.type === 'absent' && r % 2) || (vein && r < 120)) continue;
      const q = ['greedy', 'cartel', 'exitraid'].includes(a.type) ? 2000 : a.type === 'timid' ? 800 : 1000;
      assert.equal(await l.move('claim', { r, q }, a.address), null);
      if (a.type === 'exitraid') assert.equal(await l.move('unlock', { amount: l.data.get(`dep/${a.address}`) }, a.address), null);
    }
    const lastVein = l.data.get('mine/last_vein');
    if (lastVein && BigInt(lastVein.amount) > 0n) found = true;
    if (l.data.get('mine/last')?.collapse) collapsed = true;
    for (const a of agents.filter(a => a.type === 'moderate' || a.type === 'split'))
      assert.equal(l.data.get(`dep/${a.address}`), a.initial.toString(), 'moderates never lose deposit');
    l.check();
  }
  await l.advance(ROUNDS * 6 + 5); l.check();
  const earnings = new Map();
  for (const a of agents) {
    const balance = BigInt(l.data.get(`bal/${a.address}`) ?? '0'), deposit = BigInt(l.data.get(`dep/${a.address}`) ?? '0');
    const exits = (l.data.get(`exit/${a.address}`) ?? []).reduce((s, x) => s + BigInt(x.amount), 0n);
    const net = balance + deposit + exits - a.initial;
    const group = earnings.get(a.type) ?? { net: 0n, count: 0 };
    group.net += net; group.count++; earnings.set(a.type, group);
    if (a.type === 'moderate' || a.type === 'split') assert.equal(deposit, a.initial);
  }
  const moderate = earnings.get('moderate');
  for (const [type, group] of earnings) if (type !== 'moderate' && type !== 'split')
    assert.ok(group.net * BigInt(moderate.count) < moderate.net * BigInt(group.count), `${type} earns less than moderation`);
  if (vein) assert.equal(found, true, 'real counted header releases a nonempty vein');
  if (collapse) assert.equal(collapsed, true);
  return { l, earnings };
}

for (const [name, types, options] of [
  ['all moderate', strategies('moderate', 100), {}],
  ['10% greedy', strategies('greedy', 10), {}],
  ['50% greedy', strategies('greedy', 50), {}],
  ['30% cartel', strategies('cartel', 30), {}],
  ['10% timid', strategies('timid', 10), {}],
  ['10% absent (no withheld-reveal rule)', strategies('absent', 10), {}],
  ['50% participation', strategies('moderate', 100), { participation: 50 }],
  ['30% participation', strategies('moderate', 100), { participation: 30 }],
  ['10% greedy, 50% participation', strategies('greedy', 10), { participation: 50 }],
  ['overclaim then unlock', strategies('exitraid', 10), {}],
  ['vein found with buffered inflow', strategies('moderate', 100), { stock: BigInt(MINE_DEFAULTS.mine_capacity), vein: true }],
  ['forced collapse via next-round params', strategies('moderate', 100), { collapse: true }]
]) test(`Mine contract simulation: ${name}, 100 addresses, ${ROUNDS} rounds`, { timeout: 90000 }, async t => {
  const { earnings } = await simulate(types, options);
  t.diagnostic([...earnings].map(([type, x]) => `${type}: average net ${x.net / BigInt(x.count)} units`).join('; '));
});

test(`Mine split identities: one deposit split ten ways earns exactly the same over ${ROUNDS} rounds`, { timeout: 90000 }, async () => {
  const whole = await simulate(strategies('moderate', 100), { stock: 0n });
  const split = await simulate(strategies('moderate', 100), { stock: 0n, split: true });
  const expected = BigInt(whole.l.data.get(`bal/${addr(10)}`));
  assert.equal(split.earnings.get('split').net, expected);
  assert.equal(expected, GAME_INFLOW * 6n * BigInt(ROUNDS) / 100n);
  assert.equal(split.l.data.get('supply/issued'), whole.l.data.get('supply/issued'));
});
