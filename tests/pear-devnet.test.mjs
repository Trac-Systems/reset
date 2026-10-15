import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import { startDevnet, TEST_PASSWORD } from '../scripts/lib/devnet-network.mjs';
import { localMcpFlow } from './helpers/local-mcp-flow.mjs';
import { invariant } from './helpers/chain.mjs';

const execute = promisify(execFile);
test('Pear devnet: separate peers/MCP, real signer e2e, lottery and Mine settlement', { timeout: 600000 }, async t => {
  const errors = [];
  const network = await startDevnet({ pear: true, intervalMs: 1500, cleanup: true, onError: e => errors.push(e) });
  t.after(() => network.close());
  const { manifest, admin, bus, writers, relay } = network;
  const endpoint = manifest.gateways[0], { alice, bob } = manifest.players;
  const peers = [admin, ...writers, relay];
  assert.equal(new Set(peers.map(p => p.info.pid)).size, 5);
  for (const peer of peers) {
    assert.equal(peer.info.runtime, 'pear'); assert.match(peer.info.bareVersion, /\d+\.\d+/);
    assert.notEqual(peer.info.pid, process.pid);
  }
  for (const gateway of manifest.gateways) {
    assert.ok(!peers.some(p => p.info.pid === gateway.mcpPid));
    assert.equal((await writers[manifest.gateways.indexOf(gateway)].rpc('status')).writable, true);
  }
  assert.notEqual(relay.info.subnetBootstrap, admin.info.subnetBootstrap);
  assert.equal(await admin.rpc('get', { key: 'auto_add_writers' }), 'off');
  assert.equal(await admin.rpc('get', { key: 'admin' }), admin.info.address);
  assert.equal(await admin.rpc('get', { key: `writer/${alice.address}` }), null);
  const before = bufferToBigInt((await bus.state.getNodeEntry(alice.msbAddress)).balance);
  const { stdout } = await execute(process.execPath, ['scripts/e2e-real-gateway.mjs'], {
    timeout: 260000, maxBuffer: 1000000,
    env: { ...process.env, RESET_GATEWAY_URL: endpoint.gatewayUrl, RESET_MCP_URL: endpoint.mcpUrl,
      RESET_E2E_KEYSTORE: alice.keystore, RESET_SIGNER_PASSWORD: TEST_PASSWORD,
      RESET_E2E_CONTEXT: join(manifest.root, 'context-1.json'), RESET_E2E_RECIPIENT: bob.address }
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true); assert.equal(result.balance, '997'); assert.equal(result.tools, 7);
  assert.ok(bufferToBigInt((await bus.state.getNodeEntry(alice.msbAddress)).balance) < before);
  await network.pauseMining(); await network.sync();
  for (const peer of [admin, ...writers]) {
    invariant(new Map(await peer.rpc('rows')));
    assert.equal((await peer.rpc('account', { address: alice.address })).balance, '997');
    assert.equal((await peer.rpc('account', { address: bob.address })).balance, '1003');
  }
  const mine = await localMcpFlow(network);
  for (const peer of [admin, ...writers]) {
    invariant(new Map(await peer.rpc('rows')));
    assert.deepEqual((await peer.rpc('account', { address: alice.address })).mine.last_result, mine);
  }
  assert.deepEqual(errors, []);
  await network.close();
  for (const peer of peers) assert.equal((await peer.exited).signal, null);
  await assert.rejects(access(manifest.root), { code: 'ENOENT' });
});
