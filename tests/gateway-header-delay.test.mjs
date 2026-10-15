import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../features/gateway/index.js';

test('gateway waits headerDelayMs before posting new headers itself and resets once agents posted', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const posted = []; let pending = ['aa'];
  const g = Object.create(Gateway.prototype);
  Object.assign(g, { options: { headerDelayMs: 60000 }, headersWaiting: null, peer: { wallet: { publicKey: 'ab' } },
    source: { next: async () => pending },
    ownMove: async (type, p) => { posted.push(p.hx); return { ok: true }; } });
  Object.defineProperty(g, 'api', { value: { coinState: async () => ({ gateways: [] }), coinHashAt: async () => null } });
  await g.tick(); t.mock.timers.tick(59999); await g.tick();
  assert.equal(posted.length, 0, 'agents get the first minute');
  t.mock.timers.tick(1); await g.tick();
  assert.deepEqual(posted, [['aa']]);
  pending = ['bb']; await g.tick(); t.mock.timers.tick(30000);
  pending = []; await g.tick();
  pending = ['cc']; t.mock.timers.tick(40000); await g.tick();
  assert.equal(posted.length, 1, 'an agent posting restarts the wait for the next block');
});
