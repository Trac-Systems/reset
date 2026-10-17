import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway } from '../features/gateway/index.js';
import { tracToHex } from '../features/gateway/trac-address.js';

const HEX = 'fe947e14ea4d8a1ebc6084a9d9f7d59a39d69391def69e539d2c10c808d4c1ef';
const TRAC = 'trac1l628u982fk9pa0rqsj5ana74nguadyu3mmmfu5ua9sgvszx5c8hsg9exft';

test('trac addresses decode to the 64-hex key', () => {
  assert.equal(tracToHex(TRAC), HEX);
  assert.equal(tracToHex(TRAC.toUpperCase()), HEX);
  assert.equal(tracToHex(TRAC.slice(0, -1) + 'q'), null);                   // checksum
  assert.equal(tracToHex('tnk1' + TRAC.slice(5)), null);                   // other prefix
  assert.equal(tracToHex(TRAC.slice(0, 10) + TRAC.slice(10).toUpperCase()), null);  // mixed case
  assert.equal(tracToHex('trac1qqqqqqqqqqqqqq'), null);
  assert.equal(tracToHex(HEX), null);
  assert.equal(tracToHex(''), null);
});

async function get(path) {
  const seen = [];
  const self = { options: {}, rate: () => true, clientIp: () => '127.0.0.1', api: { coinAccount: async key => { seen.push(key); return { balance: '0' }; } } };
  const res = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  await Gateway.prototype.handle.call(self, { method: 'GET', url: path, headers: {} }, res);
  return { status: res.status, body: JSON.parse(res.body), seen };
}

test('GET /v1/account takes the hex key or the trac address', async () => {
  for (const id of [HEX, TRAC]) {
    const r = await get('/v1/account/' + id);
    assert.equal(r.status, 200); assert.deepEqual(r.seen, [HEX]);
  }
  const bad = await get('/v1/account/' + TRAC.slice(0, -1) + 'q');
  assert.equal(bad.status, 400); assert.deepEqual(bad.body, { ok: false, error: 'address' }); assert.deepEqual(bad.seen, []);
});
