// Same production index.js/runner, local validator and synthetic header tooling.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import PeerWallet from 'trac-wallet';
import { localNetwork, until } from '../../tests/helpers/local-network.mjs';
import { mine, parseHeader, beaconOptions } from '../../tests/helpers/chain.mjs';
import { startPear, startProcess } from './devnet-process.mjs';
import { DEVNET_DIRECTORY, checkDevnetDirectory } from './devnet-store.mjs';
import { httpJSON, TEST_PASSWORD } from './devnet-network.mjs';

const execute = promisify(execFile);
const signer = fileURLToPath(new URL('../../signer/bin/reset-signer.mjs', import.meta.url));

export async function startPearDevnet({ intervalMs = 10000, cleanup = false,
  onError = error => console.error('[pear devnet]', error.message) } = {}) {
  await checkDevnetDirectory(true);
  const local = await localNetwork({ directory: DEVNET_DIRECTORY, cleanup });
  const children = [];
  let closed = false, timer, mining = Promise.resolve();
  const close = async () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    await mining.catch(() => {});
    for (const child of children.reverse()) await child.close();
    await local.close();
  };
  try {
    const validator = await local.msb();
    const bus = await local.client(validator);
    const common = { environment: 'development', msbBootstrap: validator.config.bootstrap.toString('hex'),
      msbChannel: 'local-foundation-msb', msbDhtBootstrap: local.dhtBootstrap, peerDhtBootstrap: local.dhtBootstrap,
      subnetChannel: 'local-foundation-subnet', subnetBootstrap: null, beaconOptions,
      validatorKey: validator.wallet.publicKey.toString('hex') };
    const launch = async (name, role, options = {}, runtime = {}) => {
      const storeDirectory = join(local.root, name), filename = join(local.root, `${name}.json`);
      await writeFile(filename, JSON.stringify({ ...common, storeDirectory, ...options }), { mode: 0o600 });
      const child = await startPear(filename, role, join(storeDirectory, 'pear'), { onError, ...runtime });
      children.push(child); return child;
    };
    const relay = await launch('relay', 'relay', { subnetChannel: 'relay-local-devnet' });
    const relayKeys = [relay.info.swarmPublicKey];
    let admin = await launch('indexer', 'indexer', { relayKeys });
    const originalIdentity = admin.info;
    // Every gateway runs the miners' chat; the game's relay key is the same throughout this test network.
    const chatViewerKey = 'devnet-viewer-key-' + 'x'.repeat(32), viewerKeyFile = join(local.root, 'chat-viewer.key');
    await writeFile(viewerKeyFile, chatViewerKey + '\n', { mode: 0o600 });
    const writers = [];
    for (let i = 1; i <= 3; i++) writers.push(await launch(`gateway-${i}`, 'gateway', {
      subnetBootstrap: admin.info.subnetBootstrap, relayKeys, gatewayPort: 0, chat: { viewerKeyFile } }));
    for (const peer of [admin, ...writers]) await local.fund(validator, { address: peer.info.msbAddress });
    // Rehearse the exact stopped-service admin flags and reopen the same store.
    const gatewaysFile = join(local.root, 'gateways.json');
    await writeFile(gatewaysFile, JSON.stringify(writers.map(peer => ({
      gatewayWriter: peer.info.writerKey, gatewayAddress: peer.info.address }))), { mode: 0o600 });
    await admin.close();
    for (const adminCommand of ['init-admin', 'deploy-subnet', 'admin-setup']) {
      const command = await launch('indexer', 'indexer', { relayKeys }, { expectExit: true, adminCommand,
        ...(adminCommand === 'admin-setup' ? { gatewaysFile } : {}) });
      const result = await command.exited;
      if (result.code !== 0 || !command.logs().includes(`ADMIN_DONE ${adminCommand}`)) throw new Error(command.logs());
      if (command.info.address !== originalIdentity.address || command.info.subnetBootstrap !== originalIdentity.subnetBootstrap ||
          command.info.writerKey !== originalIdentity.writerKey) throw new Error('Indexer identity changed on restart');
    }
    admin = await launch('indexer', 'indexer', { relayKeys });
    await admin.rpc('params', { key: 'exit_wait', value: 1 });
    await admin.rpc('params', { key: 'min_amount', value: '1' });
    const settled = result => admin.rpc('settled', { result });
    const sync = async () => {
      const { version } = await admin.rpc('status');
      await until(async () => (await Promise.all(writers.map(p => p.rpc('status')))).every(s => s.version >= version),
        'Pear gateway views synchronized', 30000);
    };
    await sync();
    const endpoints = [];
    for (let i = 0; i < writers.length; i++) {
      const peer = writers[i];
      const mcp = await startProcess('mcp/bin/server.mjs', [], { prefix: '', onError,
        env: { RESET_GATEWAY_URL: peer.info.gatewayUrl, RESET_MCP_PORT: '0', RESET_MCP_HOST: '127.0.0.1', RESET_MCP_ORIGIN: '' } });
      children.push(mcp);
      endpoints.push({ name: `gateway-${i + 1}`, ...peer.info, mcpUrl: mcp.info.listening, mcpPid: mcp.child.pid });
    }
    const mineOne = async () => {
      await until(async () => (await httpJSON(`${endpoints[0].gatewayUrl}/v1/state`)).gateways.filter(g => g.active).length === 3,
        'Pear gateway heartbeats', 30000);
      await sync();
      const state = await httpJSON(`${endpoints[0].gatewayUrl}/v1/state`);
      const hx = mine(state.tip.hash, 1000 + (state.tip.height + 1) * 600);
      const packet = await writers[0].rpc('header', { hx });
      await httpJSON(`${endpoints[0].gatewayUrl}/v1/move`, packet);
      await until(async () => (await admin.rpc('status')).state.tip.hash === parseHeader(hx).hash, 'Pear mined header', 30000);
      await sync();
    };
    for (let i = 0; i < 6; i++) await mineOne();
    const gift = async (address, amount = '1000') => { await writers[0].rpc('gift', { address, amount }); await sync(); };
    const players = {};
    for (const name of ['alice', 'bob']) {
      const keystore = join(local.root, 'test-players', name);
      const { stdout } = await execute(process.execPath, [signer, 'init', '--directory', keystore], {
        env: { ...process.env, RESET_SIGNER_PASSWORD: TEST_PASSWORD }, timeout: 15000 });
      const { address } = JSON.parse(stdout);
      const msbAddress = PeerWallet.encodeBech32m('trac', Buffer.from(address, 'hex'));
      await local.fund(validator, { address: msbAddress });
      await until(() => bus.state.getNodeEntry(msbAddress), `${name} TNK replicated`);
      await gift(address);
      players[name] = { address, msbAddress, keystore };
    }
    const manifest = { v: 1, localTestOnly: true, runtime: 'pear', root: local.root, intervalMs,
      dhtBootstrap: local.dhtBootstrap, msbBootstrap: common.msbBootstrap, indexer: admin.info, chatViewerKey,
      relay: { ...relay.info, separateDiscoveryChannel: true }, gateways: endpoints, players };
    await writeFile(join(local.root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    for (let i = 0; i < endpoints.length; i++) await writeFile(join(local.root, `context-${i + 1}.json`),
      JSON.stringify(endpoints[i].context, null, 2) + '\n', { mode: 0o600 });
    const schedule = () => {
      if (closed) return;
      timer = setTimeout(() => { mining = mineOne().catch(onError).finally(schedule); }, intervalMs);
    };
    const pauseMining = async () => { clearTimeout(timer); await mining; clearTimeout(timer); };
    schedule();
    return { local, admin, bus, validator, writers, relay, manifest, gift, settled, sync, close, mineOne, pauseMining };
  } catch (error) { await close(); throw error; }
}
