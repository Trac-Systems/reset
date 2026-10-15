import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as r from '../contract/rules/index.js';
import { addr, checkpoint, solve } from './helpers/chain.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/intercom-vectors.json', import.meta.url)));

test(`Intercom compatibility: all ${fixture.vectors.length} stable JSON/hash/zero-bit vectors`, () => {
  for (const v of fixture.vectors) {
    const p = v.payload;
    const base = r.stableJSON({ id: p?.id ?? null, channel: p?.channel ?? null, from: p?.from ?? null,
      origin: p?.origin ?? null, message: p?.message ?? null, ts: p?.ts ?? null, nonce: v.nonce });
    assert.equal(base, v.base); assert.equal(r.sha256Hex(base), v.digest); assert.equal(r.countLeadingZeroBits(v.digest), v.bits);
    for (const [bits, expected] of Object.entries(v.verdicts)) assert.equal(v.bits >= Number(bits), expected);
  }
});
test('amounts: integer units, eight decimals, strict syntax and bound', () => {
  for (const s of ['', '-1', '+1', '01', '1.0', '1e8', ' 1', '1\n', 1, null, '9'.repeat(79)]) assert.equal(r.parseAmount(s), null, String(s));
  assert.equal(r.parseAmount('0'), 0n); assert.equal(r.parseAmount('0', true), null);
  assert.equal(r.parseAmount('9'.repeat(78)), BigInt('9'.repeat(78)));
  assert.equal(r.parseCoins('3.125'), 312500000n); assert.equal(r.parseCoins('0.00000001'), 1n);
  for (const s of ['.1', '1.', '-0', '+0', '1.000000001', '01.1', 3.125]) assert.equal(r.parseCoins(s), null);
  assert.equal(r.formatCoins(312500000n), '3.12500000');
});
test('envelopes: canonical exact schema, payloads, bounded parser, Unicode and duplicate keys', () => {
  const good = solve('lock', { amount: '1' }, checkpoint, addr(1)); const e = JSON.parse(good);
  assert.ok(r.parseEnvelope(good).envelope);
  for (const text of ['{', good+' ', good.replace('"v":1','"v":1,"v":1'), good.replace('"v":1','"v":1,"\\u0076":1'),
    ...[{ ...e, extra: true }, { ...e, v: 2 }, { ...e, t: 'transfer' }, { ...e, b: -1 }, { ...e, b: 1.2 },
      { ...e, h: 'f'.repeat(63) }, { ...e, w: 'G' }, { ...e, w: '' }, { ...e, p: { amount: '0' } },
      { ...e, t: 'withdraw' }, { ...e, p: { amount: '1', extra: 1 } }, { ...e, p: [] }].map(r.stableJSON)]) assert.ok(r.parseEnvelope(text).error, text);
  for (const bad of ['{"a":}', '[1,]', '"\\x00"', '"\n"', '1e999', '01', '[', '[[[[[[[[[[[[[[[[[[0]]]]]]]]]]]]]]]]]]']) assert.equal(r.parseJSON(bad), undefined, bad);
  assert.equal(r.stableJSON(r.parseJSON('{"__proto__":{"x":1},"snow":"\\u96ea"}')), '{"__proto__":{"x":1},"snow":"雪"}');
});
test('puzzles bind every field and signer; freshness, capacity/rate and difficulty thresholds', () => {
  const text = solve('lock', { amount: '1' }, checkpoint, addr(1), 12); const e = r.parseEnvelope(text).envelope;
  assert.ok(r.checkPuzzle(addr(1), e, 12)); assert.notEqual(r.puzzleHash(addr(1), e), r.puzzleHash(addr(2), e));
  for (const key of ['v','t','b','h','p','w']) assert.notEqual(r.puzzleHash(addr(1), e), r.puzzleHash(addr(1), { ...e, [key]: 'changed' }));
  assert.ok(r.fresh(e, 2, e.h)); assert.ok(!r.fresh(e, 3, e.h)); assert.ok(!r.fresh(e, -1, e.h));
  for (const [current,min,moves,cap,expected] of [[12,12,301,600,13],[12,12,300,600,12],[14,12,74,600,13],[14,12,75,600,14],[12,12,0,600,12],[32,12,600,600,32],[12,20,600,600,20]])
    assert.equal(r.adjustDifficulty(current,min,moves,cap),expected);
});
for (const n of [0,1,2,3,7]) test(`payout conservation and remainders with ${n} gateways`, () => {
  const reserve = 10000001n; const gateways = Array.from({length:n}, (_,i)=>addr(i+1));
  const p = r.payout(reserve, gateways, addr(9));
  const credited = Object.values(p.credits).reduce((s,n)=>s+BigInt(n),0n);
  assert.equal(BigInt(p.game)+BigInt(p.reserve)+credited, reserve+r.ISSUANCE);
  if(n<3){assert.equal(p.game,'309375000');assert.equal(p.reserve,(reserve+r.GATEWAY_SHARE).toString());assert.deepEqual(p.credits,{});}
  else {assert.equal(p.credits[addr(9)],'312500');assert.equal(BigInt(p.released),r.GATEWAY_SHARE-r.GATEWAY_SHARE%BigInt(n));}
  const final=r.payout(2n,gateways,addr(1));
  assert.equal(BigInt(final.game)+BigInt(final.reserve)+Object.values(final.credits).reduce((s,n)=>s+BigInt(n),0n),2n+r.ISSUANCE);
});
