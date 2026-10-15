import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HeaderSource } from '../features/gateway/header-source.js';
import { checkpoint,chain,parseHeader } from './helpers/chain.mjs';
const hx=chain(25);const blocks=[checkpoint,...hx.map((h,i)=>({...parseHeader(h),height:i+1}))];
function source(overrides={}) {
  const paths=[];
  const fetchImpl=async url=>{
    const path=new URL(url).pathname;paths.push(path);
    let value;
    if(Object.hasOwn(overrides,path))value=overrides[path];
    else if(path==='/api/blocks/tip/height')value='25';
    else if(path.startsWith('/api/block-height/'))value=blocks[Number(path.split('/').pop())]?.hash;
    else if(path.endsWith('/header'))value=blocks.find(b=>b.hash===path.split('/')[3])?.raw;
    return {ok:value!==undefined,status:value===undefined?404:200,text:async()=>value};
  };
  return {adapter:new HeaderSource('http://127.0.0.1:1234/',{fetchImpl}),paths};
}
test('header REST source uses specified routes, caps batches at twenty, then catches up',async()=>{
  const {adapter,paths}=source();const hashes=h=>blocks[h]?.hash;
  assert.deepEqual(await adapter.next({tip:checkpoint,counted:0},hashes),hx.slice(0,20));
  assert.ok(paths.includes('/api/blocks/tip/height'));assert.ok(paths.includes('/api/block-height/1'));assert.ok(paths.includes(`/api/block/${blocks[1].hash}/header`));
  assert.deepEqual(await adapter.next({tip:{height:20,hash:blocks[20].hash},counted:15},hashes),hx.slice(20));
});
test('source detects pending reorg and refuses to cross counted finality',async()=>{
  const {adapter}=source({'/api/blocks/tip/height':'10'});
  const stale=h=>h>=8?'aa'.repeat(32):blocks[h].hash;
  assert.deepEqual(await adapter.next({tip:{height:10,hash:'aa'.repeat(32)},counted:5},stale),hx.slice(7,10));
  await assert.rejects(()=>adapter.next({tip:{height:10,hash:'aa'.repeat(32)},counted:8},stale),/counted chain/);
});
test('source validates remote responses and errors',async()=>{
  await assert.rejects(()=>source({'/api/blocks/tip/height':'NaN'}).adapter.height(),/height/);
  await assert.rejects(()=>source({'/api/block-height/0':'xyz'}).adapter.hash(0),/hash/);
  await assert.rejects(()=>source({}).adapter.header('ff'.repeat(32)),/404/);
});
test('real HTTP adapter aborts stalled or oversized responses',async t=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/large')res.end('x'.repeat(5000));
    else if(req.url==='/missing'){res.writeHead(404);res.end();}
    // /stall deliberately leaves the response unfinished.
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const adapter=new HeaderSource(`http://127.0.0.1:${server.address().port}`,{timeoutMs:40});
  await assert.rejects(()=>adapter.text('/large'),/too large/);
  await assert.rejects(()=>adapter.text('/missing'),/404/);
  await assert.rejects(()=>adapter.text('/stall'),/timeout/);
});
