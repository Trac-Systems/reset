import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startDevnet, TEST_PASSWORD, httpJSON } from '../scripts/lib/devnet-network.mjs';
import { connectLocal } from '../signer/test/stdio-client.mjs';
import { setMode } from '../signer/lib/chat-mode.mjs';
import { until } from './helpers/local-network.mjs';

test('Pear devnet: the miners\' chat travels p2p between gateways; viewers come in with the game\'s key', { timeout: 600000 }, async t => {
  const errors = [];
  const network = await startDevnet({ pear: true, intervalMs: 1500, cleanup: true, onError: e => errors.push(e) });
  t.after(() => network.close());
  await network.pauseMining(); await network.sync();
  const { manifest } = network, [g1, g2, g3] = manifest.gateways, { alice } = manifest.players;
  const chatAt = g => httpJSON(`${g.gatewayUrl}/v1/chat`);
  const connect = flags => connectLocal({ directory: alice.keystore, password: TEST_PASSWORD, gatewayUrl: g1.gatewayUrl,
    contextFile: join(manifest.root, 'context-1.json'), flags: ['--max-attempts', '50000000', ...flags] });

  const mine = await connect([]);
  t.after(() => mine.close());
  assert.equal((await mine.call('lock', { amount: '0.00000010' })).ok, true);
  await until(async () => (await httpJSON(`${g1.gatewayUrl}/v1/account/${alice.address}`)).deposit !== '0', 'lock applied', 60000);
  await network.sync();

  await setMode('passive', { directory: alice.keystore });
  const chat = await connect(['--role', 'chat']);
  t.after(() => chat.close());
  assert.equal((await chat.call('chat_send', { text: 'hello from gateway one' })).ok, true);
  for (const g of [g2, g3]) await until(async () => (await chatAt(g)).messages.some(m => m.text === 'hello from gateway one' &&
    m.addr === alice.address && m.record.locked === '10'), `p2p delivery to ${g.name}`, 60000);

  const viewer = (key, body) => fetch(`${g3.gatewayUrl}/v1/chat/viewer`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  assert.equal((await viewer('wrong-key-' + 'y'.repeat(32), { id: 'room:1', name: 'Ann', text: 'hi' })).status, 401);
  assert.deepEqual(await (await viewer(manifest.chatViewerKey, { id: 'room:1', name: 'Ann', text: 'hi agents' })).json(), { ok: true, seq: 2 });
  await until(async () => (await chat.call('chat_read')).messages.some(m => m.from === 'viewer' && m.who === 'Ann' && m.text === 'hi agents'),
    'viewer message reaches the agent through gateway one', 60000);

  const forged = { message: { v: 1, kind: 'agent', addr: alice.address, text: 'not really alice', ts: Date.now(), nonce: '00'.repeat(8), sig: '11'.repeat(64) } };
  await assert.rejects(httpJSON(`${g2.gatewayUrl}/v1/chat/send`, forged), /signature/);

  const off = await setMode('off', { directory: alice.keystore });
  assert.equal(off.consistent, true, JSON.stringify(off));
  assert.deepEqual(off.processes.map(p => p.role), ['mine-mcp']);
  assert.deepEqual(errors, []);
});
