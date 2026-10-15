import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bufferToBigInt } from 'trac-msb/src/utils/amountSerialization.js';
import { connectLocal } from '../../signer/test/stdio-client.mjs';
import { TEST_PASSWORD, httpJSON } from '../../scripts/lib/devnet-network.mjs';
import { until } from './local-network.mjs';

// The same stdio client drives the ordinary and Pear network fixtures.
export async function localMcpFlow(network) {
  await network.pauseMining(); await network.sync();
  const { manifest, bus } = network, { alice, bob } = manifest.players;
  const endpoint = manifest.gateways[0];
  const state = () => httpJSON(`${endpoint.gatewayUrl}/v1/state`);
  const account = address => httpJSON(`${endpoint.gatewayUrl}/v1/account/${address}`);
  do { await network.mineOne(); } while (!(await state()).mine.window_open);
  const initial = await account(alice.address), recipient = await account(bob.address);
  const feeBefore = bufferToBigInt((await bus.state.getNodeEntry(alice.msbAddress)).balance);
  const c = await connectLocal({ directory: alice.keystore, password: TEST_PASSWORD, gatewayUrl: endpoint.gatewayUrl,
    contextFile: join(manifest.root, 'context-1.json'), flags: ['--max-attempts', '50000000'] });
  try {
    assert.equal((await c.client.listTools()).tools.length, 9);
    const shown = await c.call('address');
    assert.equal(shown.address, alice.address); assert.match(shown.tnk_address, /^trac1/);
    assert.match(await c.call('rules'), /free|no TNK/);
    const before = await c.call('status'); assert.equal(before.mine.window_open, true);
    assert.equal((await c.call('lock', { amount: '0.00000010' })).ok, true);
    await until(async () => (await account(alice.address)).deposit === (BigInt(initial.deposit) + 10n).toString(), 'local MCP lock applied');
    const current = await state();
    const guess = await c.call('lottery_guess'); assert.equal(guess.target, current.tip.height + 3);
    await until(async () => (await state()).lottery.open_targets.some(x => x.tb === guess.target), 'local MCP guess applied');
    const claim = await c.call('mine_claim'); assert.equal(claim.level, 1000); assert.equal(claim.round, current.mine.r);
    await until(async () => (await account(alice.address)).mine.claim?.q === 1000, 'local MCP claim applied');
    await assert.rejects(c.call('mine_claim', { level: 1001 }), /allow_over/);
    assert.equal((await c.call('unlock', { amount: '0.00000010' })).ok, true);
    await until(async () => (await account(alice.address)).exits.some(e => e.amount === '10'), 'local MCP exit applied');
    await assert.rejects(c.call('withdraw'), /No exits are mature/);
    await network.mineOne();
    await assert.rejects(c.call('withdraw'), /must settle/);
    while ((await state()).counted < Math.max(guess.target, current.mine.end)) await network.mineOne();
    const paid = await account(alice.address);
    assert.equal(paid.mine.last_result.r, current.mine.r);
    assert.ok(BigInt(paid.mine.last_result.amount) > 0n); assert.equal(paid.mine.last_result.penalty, '0');
    const lottery = (await state()).lottery.recent_results.find(x => x.tb === guess.target);
    assert.ok(lottery.winners.some(x => x.address === alice.address && BigInt(x.amount) > 0n));
    assert.equal((await c.call('withdraw')).ok, true);
    await until(async () => (await account(alice.address)).exits.length === 0, 'local MCP withdraw applied');
    const balance = BigInt((await account(alice.address)).balance);
    const transfer = await c.call('transfer', { to: bob.address, amount: '0.00000003' });
    assert.equal(transfer.ok, true); assert.equal(transfer.amount, '0.00000003');
    assert.equal(transfer.fee_address, alice.msbAddress);
    await until(async () => BigInt((await account(alice.address)).balance) === balance - 3n &&
      BigInt((await account(bob.address)).balance) === BigInt(recipient.balance) + 3n, 'local MCP transfer settlement');
    assert.ok(bufferToBigInt((await bus.state.getNodeEntry(alice.msbAddress)).balance) < feeBefore, 'stdio transfer charges real local TNK');
    assert.ok(c.logs.some(x => x.includes('Transfer 0.00000003 RESET') && x.includes('TNK fee')));
    assert.ok(c.progress.length > 0);
    assert.ok(!JSON.stringify([c.logs, c.outputs]).includes(TEST_PASSWORD), 'password never appears in output or logs');
    await network.sync();
    return paid.mine.last_result;
  } finally { await c.close(); }
}
