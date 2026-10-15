import assert from 'node:assert/strict';
import { publicAddress, signAndSolve, signTransfer } from 'reset-signer';
import { connectAgent } from './client.mjs';

export async function coherentPreparation(prepare, readState) {
  // Refresh only public reads, before signing/submitting anything. A new header
  // between HTTP responses must not make a legitimate local smoke run flaky.
  for (let attempt = 0; attempt < 5; attempt++) {
    const packet = await prepare(), state = await readState();
    if (packet.envelope.b === state.tip.height && packet.envelope.h === state.tip.hash) return { packet, state };
  }
  throw new Error('Could not obtain preparation and trusted state at the same tip');
}

// The identical loop is used with the fake gateway and a configured local real gateway.
export async function runPhaseOne({ mcpUrl, wallet, recipient, context, beforeWithdraw = async () => {}, waitForState = async () => {}, trustedState }) {
  const agent = await connectAgent(mcpUrl, wallet);
  try {
    const tools = (await agent.client.listTools()).tools.map(t => t.name);
    assert.deepEqual(tools.sort(), ['reset_account', 'reset_prepare_move', 'reset_prepare_transfer', 'reset_rules', 'reset_state', 'reset_submit_move', 'reset_submit_transfer'].sort());
    assert.match(await agent.call('reset_rules'), /TNK/);
    const initial = await agent.call('reset_account');
    const recipientInitial = await agent.call('reset_account', { address: recipient });
    assert.ok(BigInt(initial.balance) >= 13n, 'Fixture needs at least 13 spendable units');
    assert.equal(initial.exits.length, 0, 'Use a fresh test address without existing exits');
    for (const t of ['lock', 'unlock', 'withdraw']) {
      if (t === 'withdraw') await beforeWithdraw(agent.call);
      const { packet, state } = await coherentPreparation(
        () => agent.call('reset_prepare_move', { t, p: t === 'withdraw' ? {} : { amount: '10' } }),
        () => trustedState ? trustedState() : agent.call('reset_state'));
      assert.equal(packet.envelope.t, t);
      assert.deepEqual(packet.envelope.p, t === 'withdraw' ? {} : { amount: '10' });
      const signed = await signAndSolve(wallet, packet, { state });
      const result = await agent.call('reset_submit_move', signed);
      assert.equal(result.ok, true, result.error);
      await waitForState(t, agent.call, initial);
      const account = await agent.call('reset_account');
      if (t === 'lock') assert.equal(account.deposit, String(BigInt(initial.deposit) + 10n));
      if (t === 'unlock') assert.ok(account.exits.some(e => e.amount === '10'));
      if (t === 'withdraw') { assert.equal(account.balance, initial.balance); assert.equal(account.exits.length, 0); }
    }
    const packet = await agent.call('reset_prepare_transfer', { to: recipient, amount: '3' });
    assert.equal(packet.address, publicAddress(wallet));
    assert.equal(packet.to, recipient);
    assert.equal(packet.amount, '3');
    const signed = signTransfer(wallet, packet, { context });
    const result = await agent.call('reset_submit_transfer', signed);
    assert.equal(result.ok, true, result.error);
    await waitForState('transfer', agent.call, initial);
    const account = await agent.call('reset_account');
    const other = await agent.call('reset_account', { address: recipient });
    assert.equal(account.balance, String(BigInt(initial.balance) - 3n));
    assert.equal(other.balance, String(BigInt(recipientInitial.balance) + 3n));
    return { tools: tools.length, moves: ['lock', 'unlock', 'withdraw'], transfer: '3', address: publicAddress(wallet), balance: account.balance };
  } finally { await agent.client.close(); }
}
