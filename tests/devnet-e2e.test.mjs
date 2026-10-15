import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import { startDevnet, TEST_PASSWORD } from '../scripts/lib/devnet-network.mjs';
import { invariant } from './helpers/chain.mjs';
import { localMcpFlow } from './helpers/local-mcp-flow.mjs';

const execute = promisify(execFile);
test('complete local devnet: real MCP, local signer, payout funding, maturity, MSB fee, and instructions', { timeout: 300000 }, async t => {
  const errors = [];
  const network = await startDevnet({ intervalMs: 1500, cleanup: true, onError: e => errors.push(e) });
  t.after(() => network.close());
  const { manifest, admin, bus, writers, relay } = network;
  const endpoint = manifest.gateways[0];
  const { alice, bob } = manifest.players;
  assert.equal(writers.length, 3);
  assert.ok(writers.every(peer => peer.base.writable && !peer.base.isIndexer));
  assert.equal(relay.started, true);
  assert.notEqual(relay.peer.config.channel.toString('hex'), admin.config.channel.toString('hex'));
  assert.ok(manifest.dhtBootstrap.every(address => address.startsWith('127.0.0.1:')));
  assert.equal((await admin.base.view.get('auto_add_writers')).value, 'off');
  assert.equal((await admin.base.view.get('admin')).value, admin.wallet.publicKey);
  assert.equal(await admin.base.view.get(`writer/${alice.address}`), null);
  assert.equal((await admin.protocol.instance.api.coinState()).params.exit_wait, 1);
  const before = bufferToBigInt((await bus.state.getNodeEntry(alice.msbAddress)).balance);
  const { stdout } = await execute(process.execPath, ['scripts/e2e-real-gateway.mjs'], {
    timeout: 260000, maxBuffer: 1000000,
    env: { ...process.env, RESET_GATEWAY_URL: endpoint.gatewayUrl, RESET_MCP_URL: endpoint.mcpUrl,
      RESET_E2E_KEYSTORE: alice.keystore, RESET_SIGNER_PASSWORD: TEST_PASSWORD,
      RESET_E2E_CONTEXT: join(manifest.root, 'context-1.json'), RESET_E2E_RECIPIENT: bob.address }
  });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true); assert.equal(result.balance, '997'); assert.equal(result.tools, 7);
  const after = bufferToBigInt((await bus.state.getNodeEntry(alice.msbAddress)).balance);
  assert.ok(after < before, 'real validator charged the player TNK');
  await network.sync();
  for (const peer of [admin, ...writers]) {
    const rows = new Map(); for await (const row of peer.base.view.createReadStream()) rows.set(row.key, row.value);
    invariant(rows);
    assert.equal((await peer.protocol.instance.api.coinAccount(alice.address)).balance, '997');
    assert.equal((await peer.protocol.instance.api.coinAccount(bob.address)).balance, '1003');
  }
  // A separate interpreter executes only the plan in tests/fixtures/client-plan.txt.
  const checked = await execute(process.execPath, ['scripts/llms-check.mjs'], {
    timeout: 260000, maxBuffer: 1000000,
    env: { ...process.env, RESET_GATEWAY_URL: endpoint.gatewayUrl, RESET_MCP_URL: endpoint.mcpUrl,
      RESET_E2E_KEYSTORE: bob.keystore, RESET_SIGNER_PASSWORD: TEST_PASSWORD,
      RESET_E2E_CONTEXT: join(manifest.root, 'context-1.json'), RESET_E2E_RECIPIENT: alice.address }
  });
  assert.equal(JSON.parse(checked.stdout).ok, true);
  assert.equal((await admin.protocol.instance.api.coinAccount(bob.address)).balance, '1000');
  await localMcpFlow(network);
  for (const peer of [admin, ...writers]) {
    const rows = new Map(); for await (const row of peer.base.view.createReadStream()) rows.set(row.key, row.value);
    invariant(rows);
  }
  assert.deepEqual(errors, []);
  await network.close();
  await assert.rejects(access(manifest.root), { code: 'ENOENT' });
});
