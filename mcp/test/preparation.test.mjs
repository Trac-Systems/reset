import test from 'node:test';
import assert from 'node:assert/strict';
import { coherentPreparation } from './e2e-flow.mjs';

test('client refreshes a preparation if a header lands between public reads', async () => {
  let reads = 0;
  const result = await coherentPreparation(async () => ({ envelope: { b: ++reads, h: String(reads) } }),
    async () => ({ tip: { height: 2, hash: '2' } }));
  assert.equal(reads, 2); assert.equal(result.packet.envelope.b, result.state.tip.height);
  await assert.rejects(coherentPreparation(async () => ({ envelope: { b: 1, h: 'a' } }),
    async () => ({ tip: { height: 1, hash: 'b' } })), /same tip/);
});
