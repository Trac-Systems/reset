import assert from 'node:assert/strict';
import CoinContract from '../../contract/contract.js';
import { StateTransition } from '../../contract/state.js';
import { DEFAULT_PARAMS } from '../../contract/rules/index.js';
import { addr, beaconOptions, chain, solve, invariant } from './chain.mjs';

// Run the actual contract executor. Track all monetary writes so the invariant
// is checked after EVERY operation without rescanning unrelated history keys.
export function gameLedger({ deposits = [], stock = 0n, params = {}, headers = chain(1300), beacon = beaconOptions } = {}) {
  const data = new Map([['admin', addr(1)], ['params/current', { ...DEFAULT_PARAMS, move_bits: 0, guess_bits: 0, ...params }]]);
  let total = stock;
  data.set('pool/game', stock.toString());
  for (const [address, deposit] of deposits) { data.set(`dep/${address}`, deposit.toString()); total += BigInt(deposit); }
  data.set('supply/issued', total.toString());
  const money = (k, v) => /^(bal|dep|pool)\//.test(k) ? BigInt(v ?? '0') :
    k.startsWith('exit/') ? (v ?? []).reduce((sum, x) => sum + BigInt(x.amount), 0n) : 0n;
  let writes = 0;
  const reads = [];
  const storage = {
    get: async key => { reads.push(key); return data.has(key) ? { value: data.get(key) } : null; },
    put: async (key, value) => {
      total += money(key, value) - money(key, data.get(key));
      assert.ok(money(key, value) >= 0n, key);
      if (key.startsWith('exit/')) for (const x of value) assert.ok(BigInt(x.amount) >= 0n);
      data.set(key, structuredClone(value)); writes++;
    },
    del: async key => { total -= money(key, data.get(key)); data.delete(key); writes++; }
  };
  const contract = new CoinContract({}, { beaconOptions: beacon });
  const view = () => new StateTransition(async k => data.get(k) ?? null, beacon);
  const apply = async op => {
    const before = writes, original = structuredClone(op);
    const result = await contract.execute(op, storage);
    assert.deepEqual(op, original, 'immutable operation');
    assert.equal(total, BigInt(data.get('supply/issued')), 'supply after every operation');
    if (result instanceof Error) assert.equal(writes, before, 'rejection writes nothing');
    reads.length = 0;
    return result?.message ?? null;
  };
  const tx = (key, value, address = addr(1)) => apply({ type: 'tx', key: addr(999), value: { dispatch: { type: 'params_set', value: { key, value } }, ipk: address, wp: addr(2) } });
  const move = async (t, p, address = addr(1), text) => {
    const head = await view().head();
    const parameters = await view().params(head.tip.height);
    const bits = data.get(`diff/${t}`) ?? (t === 'guess' ? parameters.guess_bits : ['header', 'gw_beat'].includes(t) ? 0 : parameters.move_bits);
    return apply({ type: 'msg', value: { dispatch: { type: 'msg', address, msg: text ?? solve(t, p, head.tip, address, bits) } } });
  };
  const advance = async target => {
    let tip = (await view().head()).tip.height;
    while (tip < target) {
      const end = Math.min(tip + 20, target);
      assert.equal(await move('header', { hx: headers.slice(tip, end) }), null);
      tip = end;
    }
  };
  return { data, view, contract, storage, apply, move, tx, advance, headers,
    check: () => invariant(data), reads, get total() { return total; } };
}
