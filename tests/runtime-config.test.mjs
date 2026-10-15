import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validateFlags } from '../runtime/config.js';
import { StateTransition } from '../contract/state.js';
import { LAUNCH } from '../contract/launch.js';

const valid = { environment: 'development', msbBootstrap: 'aa'.repeat(32), msbChannel: 'local-msb',
  msbDhtBootstrap: ['127.0.0.1:1234'], peerDhtBootstrap: ['127.0.0.1:1234'],
  subnetBootstrap: null, subnetChannel: 'app', storeDirectory: '/srv/reset/indexer' };

test('configured peer validation fails before implicit networks, roles or test beacon can be used', () => {
  assert.equal(validateConfig('indexer', valid), valid);
  for (const key of ['environment', 'msbBootstrap', 'msbChannel', 'msbDhtBootstrap',
    'peerDhtBootstrap', 'subnetBootstrap', 'subnetChannel', 'storeDirectory']) {
    const config = { ...valid }; delete config[key];
    assert.throws(() => validateConfig('indexer', config), key);
  }
  for (const change of [{ beaconOptions: {} }, { validatorKey: 'bb'.repeat(32) },
    { mcpOrigin: 'http://127.0.0.1:3100' }, { gatewayPort: 0 },
    { msbDhtBootstrap: ['127.0.0.1:99999'] }, { storeDirectory: '/srv/reset/indexer/../gateway' }]) {
    assert.throws(() => validateConfig('indexer', { ...valid, ...change }));
  }
  assert.throws(() => validateConfig('gateway', { ...valid, storeDirectory: '/srv/reset/gateway' }));
  assert.throws(() => validateConfig('relay', { ...valid, storeDirectory: '/srv/reset/relay' }));
  assert.throws(() => validateConfig('indexer', valid, { devnet: true }));
  assert.throws(() => validateFlags({ role: 'gateway', config: 'x.json' }));
  assert.throws(() => validateFlags({ role: 'relay', config: 'x.json' }));
  assert.throws(() => validateFlags({ role: 'gateway', config: 'x.json', gateway: '1', 'admin-command': 'init-admin' }));
  validateFlags({ role: 'gateway', config: 'x.json', gateway: '1' });
  validateFlags({ role: 'relay', config: 'x.json', 'blind-relay-serve': '1' });
});

test('a peer without test overrides reads the committed launch checkpoint and issuance start', async () => {
  const state = await new StateTransition(async () => null).state();
  assert.equal(state.tip.height, LAUNCH.checkpoint.height);
  assert.equal(state.tip.hash, LAUNCH.checkpoint.hash);
  assert.equal(state.lottery.start, LAUNCH.coinStart);
});
