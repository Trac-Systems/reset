import test from 'node:test';
import assert from 'node:assert/strict';
import Runtime from 'pear-runtime';
import {fileURLToPath} from 'node:url';

test('Pear runner runtime loads the contract and serves gateway/header-source HTTP', {timeout:15000}, async()=>{
  const worker=Runtime.run(fileURLToPath(new URL('./helpers/pear-gateway.mjs',import.meta.url)));
  let stderr='';worker.stderr.on('data',chunk=>stderr+=chunk);
  const exit=new Promise((resolve,reject)=>{worker.once('exit',code=>code===0?resolve():reject(new Error(stderr||`runtime exit ${code}`)));worker.once('error',reject);});
  let text='';
  const ready=new Promise((resolve,reject)=>{
    worker.stdout.on('data',chunk=>{text+=chunk;const line=text.split('\n').find(x=>x.startsWith('{"url"'));if(line)resolve(JSON.parse(line));});
    worker.once('exit',()=>reject(new Error(stderr||'Runtime exited before HTTP was ready')));
  });
  try {
    const {url}=await Promise.race([ready,exit]);
    const state=await fetch(`${url}/v1/state`).then(r=>r.json());assert.equal(state.tip.height,0);
    const invalid=await fetch(`${url}/v1/move`,{method:'POST',body:'{}'});assert.equal(invalid.status,400);assert.equal((await invalid.json()).error,'address');
    await exit;
  } finally {if(!worker.destroyed)worker.destroy();}
});
