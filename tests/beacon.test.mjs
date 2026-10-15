import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BitcoinBeacon, targetFromBits, bitsFromTarget, retargetBits, REGTEST_PARAMS, parseHeader } from '../contract/beacon/bitcoin.js';
import { addr, mine, checkpoint, beaconOptions, chain } from './helpers/chain.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-retarget.json', import.meta.url)));

test('mainnet full period, exact first difficulty retarget and final six-confirmation count', () => {
  const b=new BitcoinBeacon({checkpoint:fixture.checkpoint}); let count=0; b.onCounted(()=>count++);
  for(let i=1;i<fixture.headers.length;i+=20) assert.equal(b.ingest(fixture.headers.slice(i,i+20),addr(1)).error,undefined);
  assert.equal(b.tip().height,32262);assert.equal(b.countedHeight(),32257);assert.equal(count,2017);
  assert.equal(b.state.records[b.hashAt(32255)].bits,0x1d00ffff); assert.equal(b.state.records[b.hashAt(32256)].bits,0x1d00d86a);
  assert.equal(b.hashAt(30241),parseHeader(fixture.headers[1]).hash);
});
test('compact targets and retarget fourfold clamping use integer arithmetic', () => {
  for(const bits of [0,0x1d80ffff,0x23000001,0x22000100,0x21010000,0x01000001]) assert.equal(targetFromBits(bits),null);
  for(const bits of [0x1d00ffff,0x1d00d86a,0x207fffff,0x03012345]) assert.equal(bitsFromTarget(targetFromBits(bits)),bits);
  assert.equal(retargetBits(0x1c100000,1),bitsFromTarget(targetFromBits(0x1c100000)/4n));
  assert.equal(retargetBits(0x1c100000,99999999),bitsFromTarget(targetFromBits(0x1c100000)*4n));
  assert.equal(retargetBits(0x1d00ffff,99999999),0x1d00ffff);
});
test('invalid proof, bits, parent, median time and mixed batch reject atomically', () => {
  const b=new BitcoinBeacon(beaconOptions); const good=chain(2); const original=b.exportState();
  const badPow=Buffer.from(good[0],'hex');badPow.writeUInt32LE(0x03000001,72);
  for(const [hx,error] of [[badPow.toString('hex'),'header_pow'],[mine(checkpoint.hash,1600,0x203fffff),'header_bits'],
    [mine('f'.repeat(64),1600),'header_parent'],[mine(checkpoint.hash,1000),'header_time']]) {
    assert.equal(b.ingest([hx],addr(1)).error,error);assert.deepEqual(b.exportState(),original);
  }
  assert.ok(b.ingest([good[0],mine('f'.repeat(64),2000)],addr(1)).error); assert.deepEqual(b.exportState(),original);
  assert.equal(b.ingest(Array(21).fill(good[0]),addr(1)).error,'header_batch');
});
test('duplicates preserve first poster; batch of twenty counts each height once', () => {
  const b=new BitcoinBeacon(beaconOptions);const hx=chain(20); const events=[];b.onCounted(r=>events.push(r));
  assert.equal(b.ingest(hx,addr(1)).accepted,20);assert.equal(b.countedHeight(),15);
  assert.equal(b.ingest(hx,addr(2)).accepted,0);assert.equal(events.length,15);
  assert.ok(events.every(r=>r.poster===addr(1)));assert.equal(b.state.records[parseHeader(hx[19]).hash].poster,addr(1));
});
test('median-time-past uses eleven ancestors, not just the immediate parent', () => {
  const b=new BitcoinBeacon(beaconOptions);const hx=chain(11);b.ingest(hx,addr(1));
  const parent=parseHeader(hx.at(-1));const median=4600;
  assert.equal(b.ingest([mine(parent.hash,median)],addr(1)).error,'header_time');
  assert.equal(b.ingest([mine(parent.hash,median+1)],addr(1)).error,undefined);
});
test('pending five-block reorg changes no counted history; counted fork is rejected', () => {
  const b=new BitcoinBeacon(beaconOptions);const hx=chain(10);b.ingest(hx,addr(1));
  const counted=Array.from({length:6},(_,h)=>b.hashAt(h));const common={...parseHeader(hx[4]),height:5};
  const fork=chain(5,common,601,7);b.ingest(fork,addr(2)); assert.equal(b.tip().hash,parseHeader(hx[9]).hash,'equal-work first arrival wins');
  assert.deepEqual(Array.from({length:6},(_,h)=>b.hashAt(h)),counted);
  const extension=chain(1,parseHeader(fork[4]));b.ingest(extension,addr(2));
  assert.equal(b.tip().hash,parseHeader(extension[0]).hash); assert.equal(b.hashAt(6),parseHeader(fork[0]).hash);
  assert.deepEqual(Array.from({length:6},(_,h)=>b.hashAt(h)),counted);
  assert.equal(b.ingest(chain(1,{...parseHeader(hx[3]),height:4},602,8),addr(3)).error,'header_final');
});
test('most cumulative work wins over a longer chain', () => {
  const params={...REGTEST_PARAMS,retarget:true,interval:4,timespan:120};const b=new BitcoinBeacon({checkpoint,params});
  b.ingest(chain(5,checkpoint,400),addr(1));assert.equal(b.tip().height,5);
  const hard=chain(3,checkpoint,1,7);b.ingest(hard,addr(2));
  const tip=parseHeader(hard[2]);const bits=retargetBits(tip.bits,tip.time-checkpoint.time,params);
  const winning=mine(tip.hash,tip.time+1,bits,7);assert.equal(b.ingest([winning],addr(2)).error,undefined);
  assert.equal(b.tip().height,4);assert.equal(b.tip().hash,parseHeader(winning).hash);assert.equal(b.hashAt(5),null);
});
test('pruning bounds full records while retaining final hashes and period metadata', () => {
  const b=new BitcoinBeacon(beaconOptions);const hx=chain(2050);
  b.ingest(hx.slice(0,20),addr(1));
  const branch=chain(1,parseHeader(hx[17]),601,99);
  assert.equal(b.ingest(branch,addr(2)).error,undefined);const branchHash=parseHeader(branch[0]).hash;
  assert.ok(b.state.records[branchHash]);
  for(let i=20;i<hx.length;i+=20)assert.equal(b.ingest(hx.slice(i,i+20),addr(1)).error,undefined);
  assert.equal(b.state.records[branchHash],undefined);
  assert.ok(Object.keys(b.state.records).length<=2016);assert.equal(b.state.records[checkpoint.hash],undefined);
  assert.equal(b.hashAt(1),parseHeader(hx[0]).hash);assert.equal(b.countedHeight(),2045);
  const c=new BitcoinBeacon({params:REGTEST_PARAMS,state:b.exportState({compact:true})});
  assert.equal(c.ingest(chain(1,parseHeader(hx.at(-1))),addr(1)).error,undefined);
});
