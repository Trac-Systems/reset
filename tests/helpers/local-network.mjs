import fs from 'node:fs/promises';
import path from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';
import { Config as MsbConfig } from 'trac-msb/src/config/config.js';
import { applyStateMessageFactory } from 'trac-msb/src/messages/state/applyStateMessageFactory.js';
import { safeEncodeApplyOperation } from 'trac-msb/src/utils/protobuf/operationHelpers.js';
import { bigIntTo16ByteBuffer } from 'trac-msb/src/utils/amountSerialization.js';
import { Peer, Wallet, createConfig, ENV } from 'trac-peer';
import PeerWallet from 'trac-wallet';
import CoinProtocol from '../../contract/protocol.js';
import CoinContract from '../../contract/contract.js';
import { beaconOptions } from './chain.mjs';

export const sleep = ms => new Promise(r=>setTimeout(r,ms));
export async function until(fn, label, timeout=15000) {
  const end=Date.now()+timeout;
  do { const result=await fn(); if(result)return result; await sleep(20); } while(Date.now()<end);
  throw new Error(`Timed out: ${label}`);
}
export async function localNetwork({ directory = path.resolve('.test-tmp'), cleanup = true } = {}) {
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  const root=await fs.mkdtemp(path.join(directory,'network-'));
  const net=await createTestnet(3); const peers=[]; const buses=[];
  const dhtBootstrap=net.bootstrap.map(x=>`${x.host}:${x.port}`);
  const close=async()=>{
    for(const p of peers.reverse()) { await p.close(); await p.store.close(); }
    for(const b of buses.reverse()) await b.close();
    await net.destroy(); if (cleanup) await fs.rm(root,{recursive:true,force:true});
  };
  async function wallet(name, raw = false) {
    const w=raw ? new PeerWallet() : new Wallet();await w.ready;await w.generateKeyPair();
    const filename=path.join(root,name,'db/keypair.json');await fs.mkdir(path.dirname(filename),{recursive:true});
    w.exportToFile(filename,Buffer.alloc(0));await fs.chmod(filename,0o600);return w;
  }
  async function msb() {
    const w=await wallet('msb-admin', true);
    const options={storeName:'msb-admin',storesDirectory:path.join(root,'bus-admin'),bootstrap:'aa'.repeat(32),channel:'local-foundation-msb',dhtBootstrap,
      enableInteractiveMode:false,enableWallet:true,enableValidatorObserver:false,enableRoleRequester:false,enableErrorApplyLogs:true,enableTxApplyLogs:false};
    const config = () => new MsbConfig(options, createMsbConfig(MSB_ENV.DEVELOPMENT));
    let b=new MainSettlementBus(config(),w);buses.push(b);await b.ready();
    options.bootstrap=b.state.writingKey.toString('hex');await b.close();buses.pop();
    b=new MainSettlementBus(config(),w);buses.push(b);await b.ready();
    await b.state.append(null);
    const msg=await applyStateMessageFactory(w,b.config).buildCompleteAddAdminMessage(w.address,b.state.writingKey,await b.state.getIndexerSequenceState());
    await b.state.append(safeEncodeApplyOperation(msg));
    await until(()=>b.state.getAdminEntry(),'MSB admin');
    return b;
  }
  async function fund(b,w,units=1000000000000000000000n) {
    const msg=await applyStateMessageFactory(b.wallet,b.config).buildCompleteBalanceInitializationMessage(b.wallet.address,w.address,bigIntTo16ByteBuffer(units),await b.state.getIndexerSequenceState());
    await b.state.append(safeEncodeApplyOperation(msg));
    return until(()=>b.state.getNodeEntry(w.address),'MSB funded account');
  }
  async function client(b) {
    const w=await wallet('msb-client',true);
    const config=new MsbConfig({storeName:'msb-client',storesDirectory:path.join(root,'bus-client'),bootstrap:b.config.bootstrap,
      channel:'local-foundation-msb',dhtBootstrap,enableInteractiveMode:false,enableWallet:true,enableValidatorObserver:false,enableRoleRequester:false}, createMsbConfig(MSB_ENV.DEVELOPMENT));
    const c=new MainSettlementBus(config,w);buses.push(c);await c.ready();
    await c.network.tryConnect(b.wallet.publicKey.toString('hex'),'validator');
    await until(()=>c.state.getAdminEntry(),'MSB client sync');
    await until(()=>c.network.validatorConnectionManager.connectionCount()>0,'MSB validator connection');
    return c;
  }
  async function peer(name,b,bootstrap=null, options={}) {
    const w=await wallet(name);
    const config=createConfig(ENV.DEVELOPMENT,{txContentHash:'utf8-strict',storeName:name,storesDirectory:root,bootstrap,channel:'local-foundation-subnet',dhtBootstrap,
      replicate:true,enableUpdater:true,enableBackgroundTasks:true,apiMsgExposed:true,apiTxExposed:true,enableTxlogs:false,...options});
    config.beaconOptions=beaconOptions;
    const p=new Peer({config,msb:b,wallet:w,protocol:CoinProtocol,contract:CoinContract});peers.push(p);await p.ready();return p;
  }
  return {root,net,dhtBootstrap,peers,buses,close,wallet,msb,client,fund,peer};
}
