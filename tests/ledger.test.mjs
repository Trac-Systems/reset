import test from 'node:test';
import assert from 'node:assert/strict';
import CoinContract from '../contract/contract.js';
import { StateTransition } from '../contract/state.js';
import { addr, checkpoint, beaconOptions, chain, solve, invariant, parseHeader } from './helpers/chain.mjs';

function ledger() {
  const data=new Map([['admin',addr(1)]]);
  const storage={ get:async k=>data.has(k)?{value:structuredClone(data.get(k))}:null,
    put:async(k,v)=>data.set(k,structuredClone(v)), del:async k=>data.delete(k) };
  const contract=new CoinContract({}, {beaconOptions});
  const view=()=>new StateTransition(async k=>data.get(k)??null,beaconOptions);
  const apply=async op=>{ const original=structuredClone(op);const before=structuredClone(data);const result=await contract.execute(op,storage);
    assert.deepEqual(op,original,'input immutable');invariant(data);if(result instanceof Error)assert.deepEqual(data,before,'reject has no writes');return result?.message??null; };
  const tx=(type,value,address=addr(1))=>apply({type:'tx',key:addr(100),value:{dispatch:{type,value},ipk:address,wp:addr(2)}});
  const move=async(t,p,address=addr(1),text)=>{const s=await view().state();return apply({type:'msg',value:{dispatch:{type:'msg',address,msg:text??solve(t,p,s.tip,address,s.bits[t])}}});};
  const headers=chain(180);
  const post=async(start,end,address=addr(1))=>move('header',{hx:headers.slice(start,end)},address);
  return {data,view,tx,move,post,headers};
}
test('issuance starts after checkpoint, reserve locked with one/two gateways, active three releases and poster credit',async()=>{
  const l=ledger();
  for(let i=1;i<=2;i++){assert.equal(await l.tx('gw_set',{addr:addr(i),on:true}),null);assert.equal(await l.move('gw_beat',{},addr(i)),null);}
  assert.equal(await l.post(0,5),null);assert.equal(l.data.get('supply/issued'),undefined);
  assert.equal(await l.post(5,6),null);assert.equal(l.data.get('supply/issued'),'312500000');assert.equal(l.data.get('pool/game'),'309375000');assert.equal(l.data.get('pool/gwreserve'),'3125000');
  assert.equal(await l.tx('gw_set',{addr:addr(3),on:true}),null);
  for(let i=1;i<=3;i++)assert.equal(await l.move('gw_beat',{},addr(i)),null);
  assert.equal(await l.post(6,7,addr(9)),null);
  assert.equal(l.data.get('pool/gwreserve'),'2');assert.equal(l.data.get(`bal/${addr(1)}`),'2291666');
  assert.equal(l.data.get(`bal/${addr(2)}`),'1979166');assert.equal(l.data.get(`cnt/2`).poster,addr(1));
  assert.equal(l.data.get(`bal/${addr(9)}`),undefined,'poster of newly counted original header earns share');
  const supply=l.data.get('supply/issued');assert.equal(await l.move('header',{hx:[l.headers[6]]}),'header_known');assert.equal(l.data.get('supply/issued'),supply);
});
test('lock, unlock, counted-height exit wait, withdraw, transfers and every failure conserve supply',async()=>{
  const l=ledger();
  for(let i=1;i<=3;i++){await l.tx('gw_set',{addr:addr(i),on:true});await l.move('gw_beat',{},addr(i));}
  assert.equal(await l.tx('params_set',{key:'min_amount',value:'1'}),null);
  assert.equal(await l.tx('params_set',{key:'exit_wait',value:2}),null);assert.equal((await l.view().state()).params.exit_wait,144);
  await l.post(0,6);assert.equal((await l.view().state()).params.exit_wait,2);
  assert.equal(await l.tx('transfer',{to:addr(10),amount:'1000000'}),null);
  assert.equal(await l.move('lock',{amount:'900000'},addr(10)),null);
  assert.equal(await l.move('lock',{amount:'100001'},addr(10)),'balance');
  assert.equal(await l.move('unlock',{amount:'900001'},addr(10)),'deposit');
  assert.equal(await l.move('unlock',{amount:'400000'},addr(10)),null);
  assert.deepEqual(l.data.get(`exit/${addr(10)}`),[{amount:'400000',release:3}]);
  assert.equal(await l.move('withdraw',{},addr(10)),'exit_wait');
  await l.post(6,7);assert.equal(await l.move('withdraw',{},addr(10)),'exit_wait');
  await l.post(7,8);assert.equal(await l.move('withdraw',{},addr(10)),null);
  assert.deepEqual(await l.view().account(addr(10),false),{balance:'500000',deposit:'500000',exits:[],moves_this_height:1});
  assert.equal(await l.tx('transfer',{to:addr(11),amount:'500001'},addr(10)),'balance');
  assert.equal(await l.tx('transfer',{to:addr(10),amount:'500000'},addr(10)),null);assert.equal(l.data.get(`bal/${addr(10)}`),'500000');
  assert.equal(await l.tx('transfer',{to:addr(11),amount:'500000'},addr(10)),null);assert.equal(l.data.get(`bal/${addr(11)}`),'500000');
});
test('admin registry, delayed knobs, fresh puzzles and capacity/rate gate all writes',async()=>{
  const l=ledger();
  assert.equal(await l.tx('gw_set',{addr:addr(2),on:true},addr(2)),'admin');
  assert.equal(await l.tx('params_set',{key:'capacity',value:0}),'param');
  assert.equal(await l.move('gw_beat',{},addr(2)),'gateway');
  await l.tx('params_set',{key:'min_amount',value:'1'});
  await l.tx('params_set',{key:'move_bits',value:0});await l.tx('params_set',{key:'capacity',value:3});await l.tx('params_set',{key:'per_address',value:2});
  for(let i=1;i<=3;i++){await l.tx('gw_set',{addr:addr(i),on:true});await l.move('gw_beat',{},addr(i));}
  await l.post(0,6);
  assert.equal(await l.move('lock',{amount:'1'},addr(1)),null);assert.equal(await l.move('lock',{amount:'1'},addr(1)),null);
  assert.equal(await l.move('lock',{amount:'1'},addr(1)),'rate');assert.equal(await l.move('lock',{amount:'1'},addr(2)),null);
  assert.equal(await l.move('lock',{amount:'1'},addr(3)),'capacity');
  // Moves that need coins keep the fixed floor; only lottery guesses follow demand.
  const before=(await l.view().state()).bits.lock;await l.post(6,7);assert.equal((await l.view().state()).bits.lock,before);
  assert.equal(await l.move('lock',{},addr(1),solve('lock',{amount:'1'},checkpoint,addr(1))),'stale');
  assert.equal(await l.move('gw_beat',{},addr(1)),null);assert.equal(await l.move('gw_beat',{},addr(1)),'already_beaten');
  await l.tx('gw_set',{addr:addr(1),on:false});await l.tx('gw_set',{addr:addr(1),on:true});assert.equal((await l.view().state()).gateways[0].active,false);
});
