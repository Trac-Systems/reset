import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalHandlers } from 'trac-peer/src/terminal/handlers.js';
import { applyStateMessageFactory } from 'trac-msb/src/messages/state/applyStateMessageFactory.js';
import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import CoinContract from '../contract/contract.js';
import Gateway from '../features/gateway/index.js';
import { localNetwork, until } from './helpers/local-network.mjs';
import { chain, solve, invariant, addr } from './helpers/chain.mjs';
import { stableJSON } from '../contract/rules/index.js';
import { setupAdmin } from '../scripts/admin-setup.mjs';
import c from 'compact-encoding';

async function entries(peer) {
  const values=new Map();for await(const row of peer.base.view.createReadStream())values.set(row.key,row.value);invariant(values);return values;
}
async function request(gateway,path,body) {
  const res=await fetch(`${gateway.url}${path}`,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  return {status:res.status,body:await res.json()};
}

test('local DHT peers and real MSB: non-writer mining, censorship, replay, limits, parity, fees', {timeout:150000}, async t=>{
  const local=await localNetwork();const gateways=[];
  t.after(async()=>{for(const g of gateways)await g.stop();await local.close();});
  const msb=await local.msb();const client=await local.client(msb);
  const admin=await local.peer('admin',client);
  const g1=await local.peer('gateway-1',client,admin.base.key);
  const g2=await local.peer('gateway-2',client,admin.base.key);
  const reader=await local.peer('reader',client,admin.base.key);
  const player=await local.wallet('player');const other=await local.wallet('other');const poor=await local.wallet('no-fees');
  const commands=new TerminalHandlers(admin);
  await commands.addAdmin(`/add_admin --address ${admin.wallet.publicKey}`);await entries(admin);
  await local.fund(msb,admin.wallet);await local.fund(msb,player);await local.fund(msb,other);
  await until(()=>client.state.getNodeEntry(admin.wallet.address),'funded admin replicated');
  const deployment=await applyStateMessageFactory(admin.wallet,client.config).buildPartialBootstrapDeploymentMessage(admin.wallet.address,admin.base.key,admin.config.channel,await client.state.getIndexerSequenceState(),'json');
  assert.equal(await client.network.validatorMessageOrchestrator.send(deployment),true);
  await until(()=>client.state.getRegisteredBootstrapEntry(admin.base.key.toString('hex')),'real subnet deployment');
  const settled=async payload=>{
    const tx=payload.txo.tx;const row=await until(async()=>{const marker=await admin.base.view.get(`tx/${tx}`);return marker?await admin.base.view.get(`txi/${marker.value}`):null;},'coin transaction settled',20000);
    await entries(admin);return row.value;
  };
  const adminTx=async(op,value)=>{const p=await admin.protocol.instance.tx({command:JSON.stringify({op,...value})});const row=await settled(p);assert.equal(row.err,null);return row;};
  await settled(await setupAdmin(admin,{gatewayWriter:g1.writerLocalKey,gatewayAddress:g1.wallet.publicKey}));
  await settled(await setupAdmin(admin,{gatewayWriter:g2.writerLocalKey,gatewayAddress:g2.wallet.publicKey}));
  await until(()=>g1.base.writable && g2.base.writable,'gateway membership');
  await adminTx('gw_set',{addr:admin.wallet.publicKey,on:true});
  await adminTx('params_set',{key:'move_bits',value:0});
  await adminTx('params_set',{key:'capacity',value:8});
  await adminTx('params_set',{key:'per_address',value:4});
  const sync=async()=>{
    const version=admin.base.view.version;
    await until(async()=>{await Promise.all([g1.base.update(),g2.base.update(),reader.base.update()]);return [g1,g2,reader].every(p=>p.base.view.version>=version);},'subnet reader synchronization');
  };
  await sync();
  for(const p of [g1,g2]){const g=new Gateway(p,{port:0,autoBeat:false,ipLimit:10000,addressLimit:10000});await g.start();gateways.push(g);}
  const [one,two]=gateways;
  const signed=async(g,w,type,payload,text)=>{
    const state=(await request(g,'/v1/state')).body;
    const prepared=g.api.prepareMessage(text??solve(type,payload,state.tip,w.publicKey,state.bits[type]),w.publicKey);
    const nonce=g.api.generateNonce();return {prepared,signature:w.sign(JSON.stringify(prepared)+nonce),nonce};
  };
  const post=async(g,w,type,payload)=>{
    const body=await signed(g,w,type,payload);const response=await request(g,'/v1/move',body);assert.equal(response.body.ok,true,JSON.stringify(response.body));
    await until(()=>admin.base.view.get(`sh/${body.signature}`),'message applied');await entries(admin);await sync();return body;
  };
  const hx=chain(60);let posted=0;
  const headers=async(n)=>{const body=await post(one,player,'header',{hx:hx.slice(posted,posted+n)});posted+=n;return body;};
  for(const w of [admin.wallet,g1.wallet,g2.wallet])await post(one,w,'gw_beat',{});
  await headers(6);
  assert.equal(reader.base.writable,false);assert.equal(await admin.base.view.get('auto_add_writers').then(x=>x.value),'off');
  const playerWriter=(await admin.base.view.get(`writer/${player.publicKey}`));assert.equal(playerWriter,null);
  await t.test('real issuance and reader account API; player key is not a writer',async()=>{
    assert.equal((await reader.protocol.instance.api.coinPools()).issued,'312500000');
    assert.equal((await request(one,`/v1/account/${player.publicKey}`)).body.balance,'312500');
    assert.equal((await reader.protocol.instance.api.coinAccount(player.publicKey)).balance,'312500');await entries(reader);
  });
  await t.test('same signed non-writer move through two gateways applies once',async()=>{
    const body=await signed(one,player,'lock',{amount:'100'});
    const before=BigInt((await one.api.coinAccount(player.publicKey)).deposit);
    const replies=await Promise.all([request(one,'/v1/move',body),request(two,'/v1/move',body)]);
    assert.ok(replies.every(r=>r.body.ok));await until(()=>admin.base.view.get(`sh/${body.signature}`),'duplicate message');await sync();
    assert.equal((await reader.protocol.instance.api.coinAccount(player.publicKey)).deposit,(before+100n).toString());await entries(reader);
    const length=g2.base.local.length;assert.equal((await request(two,'/v1/move',body)).body.ok,true);assert.equal(g2.base.local.length,length);
  });
  await t.test('a censoring gateway can be bypassed using another writer',async()=>{
    const body=await signed(two,player,'unlock',{amount:'50'});const before=one.submit;
    one.submit=async()=>({ok:false,error:'censored'});
    try {assert.equal((await request(one,'/v1/move',body)).body.error,'censored');assert.equal((await request(two,'/v1/move',body)).body.ok,true);}
    finally {one.submit=before;}
    await until(()=>admin.base.view.get(`sh/${body.signature}`),'uncensored move');await sync();await entries(reader);
    assert.equal((await two.api.coinAccount(player.publicKey)).deposit,'50');
  });
  await t.test('forgery, stale envelope, malformed/oversized bodies never append',async()=>{
    const body=await signed(one,player,'lock',{amount:'1'});body.signature='00'.repeat(64);
    let len=g1.base.local.length;assert.equal((await request(one,'/v1/move',body)).body.error,'signature');assert.equal(g1.base.local.length,len);
    const state=await one.api.coinState();const stale=JSON.parse(body.prepared.dispatch.msg);stale.b=0;
    const bad=await signed(one,player,'lock',{},stableJSON(stale));
    assert.equal((await request(one,'/v1/move',bad)).body.error,'stale');assert.equal(g1.base.local.length,len);
    const res=await fetch(`${one.url}/v1/move`,{method:'POST',body:'x'.repeat(17000)});assert.equal(res.status,413);
    assert.equal(g1.base.local.length,len);await entries(g1);
  });
  await t.test('one thousand deterministic random valid/invalid moves agree with actual contract execution',async()=>{
    const snapshot=await entries(g1);const state=await one.api.coinState();const contract=new CoinContract({},g1.config);
    let seed=0x51a7;let accepted=0;let rejected=0;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
    for(let i=0;i<1000;i++){
      const type=['lock','unlock','withdraw','gw_beat','header'][random()%5];
      const payload=type==='header'?{hx:[hx[posted-1]]}:type==='lock'||type==='unlock'?{amount:String(1+random()%1000000)}:{};
      let e=JSON.parse(solve(type,payload,state.tip,player.publicKey,state.bits[type]));
      switch(random()%8){case 0:e.b-=4;break;case 1:e.h='00'.repeat(32);break;case 2:e.p.extra=true;break;case 3:e.v=2;break;case 4:if(type==='lock')e.p.amount='-1';break;}
      const body=await signed(one,player,type,payload,stableJSON(e));
      const pre=await one.precheck(body);const copy=structuredClone(snapshot);
      const storage={get:async k=>copy.has(k)?{value:copy.get(k)}:null,put:async(k,v)=>copy.set(k,v),del:async k=>copy.delete(k)};
      const result=await contract.execute({type:'msg',value:body.prepared},storage);
      assert.equal(pre.error??null,result?.message??null,`move ${i}`);invariant(copy);
      if(result){rejected++;assert.deepEqual(copy,snapshot);}else accepted++;
    }
    assert.ok(accepted>0);assert.ok(rejected>0);console.log('parity samples', {accepted,rejected});
  });
  await t.test('real MSB transfer: player signs locally and pays fee; recipient gets coin',async()=>{
    const before=bufferToBigInt((await client.state.getNodeEntry(player.address)).balance);
    const prepared=(await request(one,'/v1/tx/prepare',{address:player.publicKey,to:other.publicKey,amount:'1000',nonce:one.api.generateNonce()})).body;
    assert.equal(prepared.prepared_command.type,'transfer');
    const signature=player.sign(Buffer.from(prepared.tx,'hex'));
    const response=await request(one,'/v1/tx/submit',{tx:prepared.tx,prepared_command:prepared.prepared_command,address:player.publicKey,signature,nonce:prepared.nonce});
    assert.equal(response.body.ok,true,JSON.stringify(response.body));
    assert.equal((await settled(response.body.result)).err,null);await sync();
    assert.equal((await two.api.coinAccount(other.publicKey)).balance,'1000');
    const after=bufferToBigInt((await client.state.getNodeEntry(player.address)).balance);assert.ok(after<before);await entries(reader);
  });
  const transfer=async(w,to,amount)=>{
    const prep=(await request(one,'/v1/tx/prepare',{address:w.publicKey,to,amount,nonce:one.api.generateNonce()})).body;
    return request(one,'/v1/tx/submit',{tx:prep.tx,prepared_command:prep.prepared_command,address:w.publicKey,signature:w.sign(Buffer.from(prep.tx,'hex')),nonce:prep.nonce});
  };
  await t.test('insufficient coin balance settles as a contract error without coin changes',async()=>{
    const before=await one.api.coinAccount(other.publicKey);const response=await transfer(other,player.publicKey,'1001');
    assert.equal(response.body.ok,true);assert.equal((await settled(response.body.result)).err,'balance');await sync();
    assert.deepEqual(await two.api.coinAccount(other.publicKey),before);await entries(reader);
  });
  await t.test('a sender without any TNK cannot transfer; coin and subnet log unchanged',async()=>{
    const gift=await transfer(player,poor.publicKey,'10');assert.equal((await settled(gift.body.result)).err,null);await sync();
    const before=await entries(g1);const length=g1.base.local.length;const reply=await transfer(poor,other.publicKey,'1');
    assert.equal(reply.body.ok,false);assert.match(reply.body.error,/balance|Requester address/i);
    assert.equal(g1.base.local.length,length);assert.deepEqual(await entries(g1),before);assert.equal(await client.state.getNodeEntry(poor.address),null);
  });
  await t.test('lottery and Mine settle through real writer HTTP and replicate to the reader',async()=>{
    const target=posted+3;
    await post(one,player,'guess',{tb:target,n:'ffffffff'});
    assert.equal((await request(two,'/v1/state')).body.lottery.open_targets.find(x=>x.tb===target).guesses,1);
    const duplicate=await signed(two,player,'guess',{tb:target,n:'00000000'});
    assert.equal((await request(two,'/v1/move',duplicate)).body.error,'already_guessed');
    await headers(target+5-posted);
    const result=(await request(two,'/v1/state')).body.lottery.recent_results.find(x=>x.tb===target);
    assert.equal(result.winners.length,1);assert.equal(result.winners[0].address,player.publicKey);assert.equal(result.paid,'30937500');
    let state=(await request(one,'/v1/state')).body;
    if(!state.mine.window_open){await headers(state.mine.end+1-posted);state=(await request(one,'/v1/state')).body;}
    const round=state.mine.r, before=await one.api.coinAccount(player.publicKey);
    await post(two,player,'claim',{r:round,q:1000});
    const account=(await request(one,`/v1/account/${player.publicKey}`)).body;
    assert.equal(account.mine.claim.q,1000);assert.equal(account.mine.claim.d,before.deposit);
    assert.ok(BigInt(account.mine.fair_share_estimate)>0n);
    await headers(state.mine.end+5-posted);
    const after=(await request(two,`/v1/account/${player.publicKey}`)).body;
    assert.equal(after.mine.last_result.r,round);assert.equal(after.mine.last_result.penalty,'0');
    assert.equal(after.deposit,before.deposit);assert.ok(BigInt(after.balance)>BigInt(before.balance));
    assert.equal((await reader.protocol.instance.api.coinAccount(player.publicKey)).mine.last_result.r,round);
    assert.equal(await admin.base.view.get(`mine/round/${round}`),null);
    assert.equal(await admin.base.view.get(`lottery/target/${target}`),null);
    await entries(reader);
  });
  await t.test('spam burst enforces global capacity and per-address rate before local append',async()=>{
    await headers(1);await adminTx('params_set',{key:'move_bits',value:0});await headers(1);
    const wallets=[player,other];const bodies=[];
    for(let i=0;i<30;i++)bodies.push(await signed(one,wallets[i%2],'lock',{amount:'1'}));
    const length=g1.base.local.length;const results=await Promise.all(bodies.map(b=>request(one,'/v1/move',b)));
    assert.equal(results.filter(r=>r.body.ok).length,8);
    assert.ok(results.filter(r=>!r.body.ok).every(r=>['capacity','rate'].includes(r.body.error)));
    // Autobase may append null acknowledgements; only count signed message ops.
    let messages=0;
    for(let i=length;i<g1.base.local.length;i++) {
      const raw=(await g1.base.local.get(i))?.node?.value;
      if(raw && c.decode(g1.base.valueEncoding,raw)?.type==='msg')messages++;
    }
    assert.equal(messages,8);await until(async()=>((await admin.protocol.instance.api.coinState()).capacity_left===0),'burst replicated');await sync();
    assert.equal((await one.api.coinAccount(player.publicKey)).moves_this_height,4);assert.equal((await one.api.coinAccount(other.publicKey)).moves_this_height,4);
    await entries(reader);
  });
  await t.test('automatic registered heartbeat and in-memory HTTP rate limits',async()=>{
    await one.tick();await until(async()=>((await one.api.coinState()).gateways.find(g=>g.addr===g1.wallet.publicKey).active),'automatic beat');
    const length=g1.base.local.length;await one.tick();assert.equal(g1.base.local.length,length);
    one.limits.clear();one.options.ipLimit=1;
    assert.equal((await request(one,'/v1/state')).status,200);assert.equal((await request(one,'/v1/state')).status,429);
    one.options.ipLimit=10000;one.limits.clear();one.options.addressLimit=1;
    const body=await signed(one,player,'lock',{amount:'1'});
    assert.equal((await request(one,'/v1/move',body)).status,200);assert.equal((await request(one,'/v1/move',body)).status,429);
    one.options.addressLimit=10000;one.limits.clear();await entries(g1);
  });
});
