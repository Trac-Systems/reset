// Local-only fixture. All bootstrap addresses come from HyperDHT's loopback testnet.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import PeerWallet from 'trac-wallet';
import { TerminalHandlers } from 'trac-peer/src/terminal/handlers.js';
import { applyStateMessageFactory } from 'trac-msb/src/messages/state/applyStateMessageFactory.js';
import { localNetwork, until } from '../../tests/helpers/local-network.mjs';
import { mine, parseHeader } from '../../tests/helpers/chain.mjs';
import Gateway from '../../features/gateway/index.js';
import BlindRelay from '../../features/blind-relay/index.js';
import { createMcpService } from '../../mcp/lib/server.mjs';
import { connectAgent } from '../../mcp/test/client.mjs';
import { createWallet, publicAddress, signTransfer, wipeWallet } from '../../signer/lib/index.mjs';
import { setupAdmin } from '../admin-setup.mjs';
import { DEVNET_DIRECTORY, checkDevnetDirectory } from './devnet-store.mjs';

const execute = promisify(execFile);
export { DEVNET_DIRECTORY } from './devnet-store.mjs';
export const TEST_PASSWORD = 'local-disposable-devnet-only';
const signer = fileURLToPath(new URL('../../signer/bin/reset-signer.mjs', import.meta.url));
export async function httpJSON(url, body) {
  const res = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function startDevnet({ intervalMs = 10000, cleanup = false, pear = false,
  onError = error => console.error('[miner]', error.message) } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) throw new Error('interval-ms must be an integer >= 100');
  const installed = JSON.parse(await readFile(new URL('../../node_modules/trac-peer/package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const pinned = lock.packages?.['node_modules/trac-peer']?.version;
  if (installed.version !== pinned) throw new Error(`Install the committed lockfile with npm ci: devnet requires trac-peer ${pinned}, found ${installed.version}`);
  if (pear) {
    const { startPearDevnet } = await import('./pear-devnet.mjs');
    return startPearDevnet({ intervalMs, cleanup, onError });
  }
  await checkDevnetDirectory(true);
  const local = await localNetwork({ directory: DEVNET_DIRECTORY, cleanup });
  const gateways = [], services = [], relays = [];
  let timer, mining = Promise.resolve(), closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    await mining.catch(() => {});
    for (const service of services.reverse()) await service.close();
    for (const gateway of gateways.reverse()) await gateway.stop();
    for (const relay of relays.reverse()) await relay.stop();
    await local.close();
  };
  try {
    const validator = await local.msb();
    const bus = await local.client(validator);
    const admin = await local.peer('indexer', bus);
    const writers = [];
    for (let i = 1; i <= 3; i++) writers.push(await local.peer(`gateway-${i}`, bus, admin.base.key));
    const relayPeer = await local.peer('relay', bus, null, { channel: 'local-devnet-relay-only' });
    const relay = new BlindRelay(relayPeer, { serve: true });
    await relay.start(); relays.push(relay);
    const relayKey = relayPeer.swarm.keyPair.publicKey.toString('hex');
    for (const peer of [admin, ...writers]) {
      const client = new BlindRelay(peer, { relays: [relayKey] });
      await client.start(); relays.push(client);
    }
    const commands = new TerminalHandlers(admin);
    await commands.addAdmin(`/add_admin --address ${admin.wallet.publicKey}`);
    for (const wallet of [admin.wallet, ...writers.map(p => p.wallet)]) await local.fund(validator, wallet);
    await until(() => bus.state.getNodeEntry(admin.wallet.address), 'admin TNK replicated');
    const deployment = await applyStateMessageFactory(admin.wallet, bus.config).buildPartialBootstrapDeploymentMessage(
      admin.wallet.address, admin.base.key, admin.config.channel, await bus.state.getIndexerSequenceState(), 'json');
    if (!await bus.network.validatorMessageOrchestrator.send(deployment)) throw new Error('Subnet deployment rejected');
    await until(() => bus.state.getRegisteredBootstrapEntry(admin.base.key.toString('hex')), 'subnet deployment');
    const settled = async result => {
      const tx = result?.txo?.tx;
      if (!tx) throw new Error('Missing submitted transaction');
      const row = await until(async () => {
        const marker = await admin.base.view.get(`tx/${tx}`);
        return marker && admin.base.view.get(`txi/${marker.value}`);
      }, 'MSB transaction settlement', 30000);
      if (row.value.err) throw new Error(`Contract rejected transaction: ${row.value.err}`);
      return row.value;
    };
    for (const peer of writers) await settled(await setupAdmin(admin, {
      gatewayWriter: peer.writerLocalKey, gatewayAddress: peer.wallet.publicKey }));
    await settled(await admin.protocol.instance.tx({ command: JSON.stringify({ op: 'params_set', key: 'exit_wait', value: 1 }) }));
    await until(() => writers.every(p => p.base.writable), 'three admitted writers');
    const sync = async () => {
      const version = admin.base.view.version;
      await until(async () => {
        await Promise.all(writers.map(p => p.base.update()));
        return writers.every(p => p.base.view.version >= version);
      }, 'gateway views synchronized');
    };
    await sync();
    const endpoints = [];
    for (const peer of writers) {
      const gateway = new Gateway(peer, { port: 0, pollMs: 100, ipLimit: 10000, addressLimit: 10000 });
      gateways.push(gateway); await gateway.start();
      const service = await createMcpService({ gatewayUrl: gateway.url });
      services.push(service);
      const mcpUrl = await service.listen();
      const context = { networkId: peer.msbClient.networkId, incomingWritingKey: peer.writerLocalKey,
        subnetBootstrap: admin.base.key.toString('hex'), msbBootstrap: peer.protocol.instance.api.getPeerMsbBootstrap() };
      endpoints.push({ name: peer.config.storeName, gatewayUrl: gateway.url, mcpUrl,
        address: peer.wallet.publicKey, msbAddress: peer.wallet.address, writerKey: peer.writerLocalKey, context });
    }
    const mineOne = async () => {
      await until(async () => {
        const state = await admin.protocol.instance.api.coinState();
        return state.gateways.filter(g => g.active).length === 3;
      }, 'all three gateway heartbeats');
      await sync();
      const state = await gateways[0].api.coinState();
      const beacon = (await admin.base.view.get('beacon/state'))?.value;
      const parent = beacon?.records[state.tip.hash];
      // The test checkpoint is time=1000. Synthetic time advances by 600 per block.
      const hx = mine(state.tip.hash, (parent?.time ?? 1000) + 600);
      const prepared = gateways[0].api.prepareMessage(JSON.stringify({ b: state.tip.height, h: state.tip.hash,
        p: { hx: [hx] }, t: 'header', v: 1, w: '0' }), writers[0].wallet.publicKey);
      const nonce = gateways[0].api.generateNonce();
      await httpJSON(`${gateways[0].url}/v1/move`, {
        prepared, nonce, signature: writers[0].wallet.sign(JSON.stringify(prepared) + nonce) });
      await until(async () => (await admin.protocol.instance.api.coinState()).tip.hash === parseHeader(hx).hash, 'mined header applied');
      await sync();
    };
    // Six confirmations produce the first real gateway payout and activate exit_wait=1.
    for (let i = 0; i < 6; i++) await mineOne();
    const gift = async (address, amount = '1000') => {
      const endpoint = endpoints[0];
      // Only the gateway's OWN operator key is used for gifts. Player keys
      // remain in their local signer keystores. Funding also exercises MCP.
      const wallet = await createWallet(writers[0].wallet.mnemonic);
      let agent;
      try {
        if (publicAddress(wallet) !== endpoint.address) throw new Error('Gateway signer derivation mismatch');
        agent = await connectAgent(endpoint.mcpUrl, wallet);
        const packet = await agent.call('reset_prepare_transfer', { to: address, amount });
        if (packet.to !== address || packet.amount !== amount) throw new Error('Gift preparation mismatch');
        const submitted = await agent.call('reset_submit_transfer', signTransfer(wallet, packet, { context: endpoint.context }));
        if (!submitted.ok) throw new Error(submitted.error ?? 'Gift submission failed');
        await settled(submitted.result); await sync();
      } finally { await agent?.client.close(); wipeWallet(wallet); }
    };
    const players = {};
    for (const name of ['alice', 'bob']) {
      const keystore = join(local.root, 'test-players', name);
      // Separate local CLI owns the player key. Neither gateway nor MCP loads it.
      const { stdout } = await execute(process.execPath, [signer, 'init', '--directory', keystore], {
        env: { ...process.env, RESET_SIGNER_PASSWORD: TEST_PASSWORD }, timeout: 15000 });
      const { address } = JSON.parse(stdout);
      const msbAddress = PeerWallet.encodeBech32m('trac', Buffer.from(address, 'hex'));
      await local.fund(validator, { address: msbAddress });
      await until(() => bus.state.getNodeEntry(msbAddress), `${name} TNK replicated`);
      await gift(address);
      players[name] = { address, msbAddress, keystore };
    }
    const manifest = { v: 1, localTestOnly: true, root: local.root, intervalMs,
      dhtBootstrap: local.dhtBootstrap, msbBootstrap: bus.config.bootstrap.toString('hex'),
      indexer: { address: admin.wallet.publicKey, msbAddress: admin.wallet.address, writerKey: admin.writerLocalKey,
        subnetBootstrap: admin.base.key.toString('hex') },
      relay: { swarmPublicKey: relayKey, separateDiscoveryChannel: true }, gateways: endpoints, players };
    await writeFile(join(local.root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    for (let i = 0; i < endpoints.length; i++) await writeFile(join(local.root, `context-${i + 1}.json`),
      JSON.stringify(endpoints[i].context, null, 2) + '\n', { mode: 0o600 });
    const schedule = () => {
      if (closed) return;
      timer = setTimeout(() => {
        mining = mineOne().catch(onError).finally(schedule);
      }, intervalMs);
    };
    const pauseMining = async () => { clearTimeout(timer); await mining; clearTimeout(timer); };
    schedule();
    return { local, admin, bus, validator, writers, gateways, relay, manifest, gift, settled, sync, close, mineOne, pauseMining };
  } catch (error) { await close(); throw error; }
}
