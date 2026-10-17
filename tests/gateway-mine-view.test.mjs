import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../features/gateway/index.js';
import CoinProtocol from '../contract/protocol.js';
import { MINE_DEFAULTS } from '../contract/rules/index.js';
import { gameLedger } from './helpers/games.mjs';
import { addr, beaconOptions, chain, checkpoint, mine, parseHeader } from './helpers/chain.mjs';

const requirePeer = createRequire(import.meta.resolve('trac-peer'));
const Corestore = requirePeer('corestore'), Hyperbee = requirePeer('hyperbee');

async function fixture(t, data = new Map(), options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'reset-mine-view-'));
  const store = new Corestore(directory);
  const bee = new Hyperbee(store.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json' });
  t.after(async () => { await bee.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  await bee.ready();
  let keys = new Set();
  const sync = async entries => {
    const batch = bee.batch();
    for (const key of keys) if (!entries.has(key)) await batch.del(key);
    for (const [key, value] of entries) await batch.put(key, value);
    await batch.flush(); keys = new Set(entries.keys());
  };
  await sync(data);
  const stats = { checkouts: [], gets: [], scans: [], closed: 0, beforeRead: null, failScan: false };
  const checkout = bee.checkout.bind(bee);
  bee.checkout = version => {
    stats.checkouts.push(version);
    const view = checkout(version), get = view.get.bind(view), scan = view.createReadStream.bind(view), close = view.close.bind(view);
    view.get = async key => {
      stats.gets.push(key);
      if (stats.beforeRead) { const before = stats.beforeRead; stats.beforeRead = null; await before(); }
      return get(key);
    };
    view.createReadStream = range => {
      stats.scans.push(range);
      if (stats.failScan) throw new Error('scan_failed');
      return scan(range);
    };
    view.close = async () => { stats.closed++; await close(); };
    return view;
  };
  const peer = { base: { view: bee }, config: { beaconOptions }, protocol: { instance: { api: {} } } };
  Object.assign(peer.protocol.instance.api, { msgExposed: () => true, txExposed: () => true,
    coinState: () => CoinProtocol.prototype.withView.call(peer, s => s.state()) });
  const gateway = new Gateway(peer, { autoBeat: false, port: 0, ...options });
  const request = async (url = '/v1/mine/view', headers = {}, ip = '127.0.0.1') => {
    const response = {};
    await gateway.handle({ method: 'GET', url, headers, socket: { remoteAddress: ip } }, {
      writeHead: (status, headers) => Object.assign(response, { status, headers }),
      end: body => { response.body = body ?? ''; }
    });
    if (response.body) response.json = JSON.parse(response.body);
    return response;
  };
  return { gateway, bee, sync, stats, request };
}

function agrees(page, state, armed) {
  const m = state.mine, last = m.last_result, vein = m.last_vein;
  assert.deepEqual(page.tip, state.tip); assert.equal(page.counted, state.counted);
  assert.deepEqual(page.round, { r: m.r, start: m.start, claim_end: m.claim_end, end: m.end,
    window_open: m.window_open, claims: m.claim_count, deposit: Number(m.claim_deposit) });
  assert.deepEqual(page.mine, { stock: Number(m.S), capacity: Number(m.C), vein: Number(m.vein_buffer),
    armed, guideline: Number(m.last_guideline), params: { mine_max_strikes: m.params.mine_max_strikes,
      mine_clean_rounds: m.params.mine_clean_rounds, mine_collapse_threshold_per_mille: m.params.mine_collapse_threshold_per_mille } });
  assert.deepEqual(page.last, last && { ...last, deposit: Number(last.deposit), guideline: Number(last.guideline),
    capacity: Number(last.capacity), paid: Number(last.paid), penalties: Number(last.penalties), stock: Number(last.stock) });
  assert.deepEqual(page.last_vein, vein && { ...vein, amount: Number(vein.amount) });
}

test('Mine HTTP view follows locks, claims, penalties, exits and a counted vein', async t => {
  let hx, first;
  for (let tag = 0; ; tag++) {
    hx = mine(checkpoint.hash, checkpoint.time + 600, checkpoint.bits, tag); first = parseHeader(hx);
    if (first.hash.slice(-3) === first.hash.slice(-1).repeat(3)) break;
  }
  const headers = [hx, ...chain(170, first)];
  const ledger = gameLedger({ headers, stock: BigInt(MINE_DEFAULTS.mine_capacity) + 30000000000n });
  await ledger.storage.put('pool/game', MINE_DEFAULTS.mine_capacity);
  for (const n of [10, 11, 12]) await ledger.storage.put(`bal/${addr(n)}`, '10000000000');
  ledger.check();
  const f = await fixture(t, ledger.data);
  await f.gateway.start(); t.after(() => f.gateway.stop());
  const empty = await fetch(`${f.gateway.url}/v1/mine/view`);
  assert.equal(empty.status, 200); assert.equal(empty.headers.get('content-type'), 'application/json');
  const initial = await empty.json();
  assert.equal(initial.v, 1); assert.deepEqual(initial.miners, []); assert.equal(initial.total, 0); assert.equal(initial.next, null);
  agrees(initial, (await f.request('/v1/state')).json, false);
  for (const n of [10, 11, 12]) assert.equal(await ledger.move('lock', { amount: '10000000000' }, addr(n)), null);
  await ledger.advance(1);
  for (const [n, q] of [[10, 1000], [11, 2000], [12, 0]]) assert.equal(await ledger.move('claim', { r: 0, q }, addr(n)), null);
  assert.equal(await ledger.move('unlock', { amount: '5000000000' }, addr(12)), null);
  await f.sync(ledger.data);
  const claimed = (await f.request()).json;
  assert.equal(claimed.round.window_open, true); assert.deepEqual(claimed.miners.map(row => row[5]), [1, 1, 1]);
  await ledger.advance(7);
  for (const [n, q] of [[10, 1000], [11, 2000]]) assert.equal(await ledger.move('claim', { r: 1, q }, addr(n)), null);
  assert.equal(await ledger.move('unlock', { amount: '5000000000' }, addr(12)), null);
  await ledger.advance(13);
  assert.equal(await ledger.move('claim', { r: 2, q: 1000 }, addr(10)), null);
  await ledger.advance(17); await f.sync(ledger.data);
  const response = await fetch(`${f.gateway.url}/v1/mine/view`), page = await response.json();
  agrees(page, (await f.request('/v1/state')).json, true);
  assert.equal(page.total, 3); assert.equal(page.next, null); assert.equal(page.last.r, 1);
  assert.ok(page.last.penalties > 0); assert.ok(page.last_vein.amount > 0); assert.equal(page.round.window_open, false);
  for (const row of page.miners) {
    const [address] = row, status = ledger.data.get(`mine/strikes/${address}`), result = ledger.data.get(`mine/result/${address}`);
    assert.deepEqual(row, [address, Number(ledger.data.get(`dep/${address}`)),
      Number((ledger.data.get(`exit/${address}`) ?? []).reduce((sum, exit) => sum + BigInt(exit.amount), 0n)),
      status.strikes, status.clean, address === addr(10) ? 1 : 0, result.r, Number(result.amount), Number(result.penalty)]);
    assert.ok(row.slice(1).every(Number.isSafeInteger));
  }
  assert.equal(page.miners[1][3], 2); assert.equal(page.miners[2][1], 0); assert.equal(page.miners[2][2], 10000000000);
  assert.equal(ledger.data.get(`exit/${addr(12)}`).length, 2);
  assert.ok(!JSON.stringify(page).includes('"q"'));
  assert.ok(!f.stats.gets.some(key => key.startsWith('mine/claim/') || key.startsWith('mine/seen/')));
  const unchanged = await fetch(`${f.gateway.url}/v1/mine/view`, { headers: { 'if-none-match': response.headers.get('etag') } });
  assert.equal(unchanged.status, 304); assert.equal(await unchanged.text(), '');
  await ledger.advance(160);
  assert.equal(await ledger.move('withdraw', {}, addr(12)), null);
  await f.sync(ledger.data);
  assert.deepEqual((await f.request()).json.miners.map(row => row[0]), [addr(10), addr(11)]);
  ledger.check(); t.diagnostic(`Mine snapshot: ${JSON.stringify(page)}`);
});

function populated(count, value = '99999999999') {
  const data = new Map();
  for (let n = count; n > 0; n--) {
    const a = addr(n);
    data.set(`dep/${a}`, value); data.set(`exit/${a}`, [{ amount: value, release: 1 }]);
    data.set(`mine/seen/0/${a}`, { d: value, q: 2000 });
    data.set(`mine/strikes/${a}`, { strikes: 4, clean: 23 });
    data.set(`mine/result/${a}`, { r: 123456, amount: value, penalty: value, q: 2000, fair: value });
  }
  return data;
}

test('Mine pages sort and deduplicate 805 full rows, include exit/claim-only rows and stay within 56 KiB', async t => {
  const data = populated(805);
  data.set(`dep/${addr(806)}`, '0'); data.set(`exit/${addr(806)}`, [{ amount: '2', release: 0 }, { amount: '3', release: 20 }]);
  data.set(`mine/seen/0/${addr(807)}`, { d: '10', q: 0 });
  data.set(`dep/${addr(808)}`, '0'); data.set(`exit/${addr(809)}`, []);
  data.set(`mine/seen/1/${addr(810)}`, { d: '10', q: 1000 });
  data.set(`mine/result/${addr(811)}`, { r: 1, amount: '10', penalty: '0' });
  data.set(`dep0/${addr(812)}`, '100'); data.set(`mine/seen/00/${addr(813)}`, { d: '10', q: 1000 });
  const f = await fixture(t, data), rows = [], tags = [];
  let after = '';
  do {
    const response = await f.request(`/v1/mine/view${after ? `?after=${after}` : ''}`), page = response.json;
    assert.equal(response.status, 200); assert.equal(page.total, 807);
    assert.ok(Buffer.byteLength(response.body) <= 56 * 1024);
    if (!rows.length) t.diagnostic(`400 full miner rows: ${Buffer.byteLength(response.body)} bytes`);
    if (rows.length < 800) assert.equal(page.miners.length, 400);
    assert.equal(page.next, rows.length < 800 ? page.miners.at(-1)[0] : null);
    rows.push(...page.miners); tags.push(response.headers.etag); after = page.next;
  } while (after);
  assert.deepEqual(rows.map(row => row[0]), Array.from({ length: 807 }, (_, i) => addr(i + 1)));
  assert.deepEqual(rows[805], [addr(806), 0, 5, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(rows[806], [addr(807), 0, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(new Set(tags).size, 3);
  assert.deepEqual(f.stats.scans.slice(0, 3), [{ gt: 'dep/', lt: 'dep0' }, { gt: 'exit/', lt: 'exit0' }, { gt: 'mine/seen/0/', lt: 'mine/seen/00' }]);
  assert.equal(f.stats.checkouts.length, 3); assert.equal(f.stats.closed, 3);
  assert.equal(f.stats.gets.filter(key => key.startsWith('mine/result/')).length, 807);
  const beyond = (await f.request(`/v1/mine/view?after=${'f'.repeat(64)}`)).json;
  assert.deepEqual(beyond.miners, []); assert.equal(beyond.next, null); assert.equal(beyond.total, 807);
});

test('Mine page byte limit also bounds large integer rows', async t => {
  const f = await fixture(t, populated(400, String(Number.MAX_SAFE_INTEGER)));
  const first = await f.request();
  assert.equal(first.status, 200); assert.ok(Buffer.byteLength(first.body) <= 56 * 1024);
  assert.ok(first.json.miners.length > 0 && first.json.miners.length < 400);
  const second = await f.request(`/v1/mine/view?after=${first.json.next}`);
  assert.equal(second.status, 200); assert.ok(Buffer.byteLength(second.body) <= 56 * 1024);
  assert.equal(first.json.miners.length + second.json.miners.length, 400); assert.equal(second.json.next, null);
});

test('Mine validates exclusive cursors and shares the state IP limit, including cached and conditional reads', async t => {
  const f = await fixture(t, new Map([[`dep/${addr(10)}`, '1']]), { ipLimit: 30, trustProxy: true });
  for (const suffix of ['', 'a', 'g'.repeat(64), 'A'.repeat(64), '0'.repeat(63), '0'.repeat(65), '%00', `${addr(1)}%0a`, `${addr(1)}&after=${addr(2)}`]) {
    const response = await f.request(`/v1/mine/view?after=${suffix}`);
    assert.equal(response.status, 400); assert.deepEqual(response.json, { ok: false, error: 'after' });
  }
  assert.equal(f.stats.checkouts.length, 0);
  assert.equal((await f.request(`/v1/mine/view?after=${addr(9)}`)).json.miners.length, 1);
  assert.equal((await f.request(`/v1/mine/view?after=${addr(10)}`)).json.miners.length, 0);
  f.gateway.options.ipLimit = 2; f.gateway.limits.clear();
  const first = await f.request('/v1/mine/view', { 'x-forwarded-for': '192.0.2.1' });
  assert.equal((await f.request('/v1/state', { 'x-forwarded-for': '192.0.2.1' })).status, 200);
  assert.equal((await f.request('/v1/mine/view', { 'x-forwarded-for': '192.0.2.1', 'if-none-match': first.headers.etag })).status, 429);
  assert.equal((await f.request('/v1/mine/view', { 'x-forwarded-for': '192.0.2.2', 'if-none-match': first.headers.etag })).status, 304);
});

test('Mine caches by version and cursor, honours ETag lists and evicts the least recently used page', async t => {
  const data = populated(1), f = await fixture(t, data);
  const [first, concurrent] = await Promise.all([f.request(), f.request()]);
  assert.equal(first.body, concurrent.body); assert.equal(f.stats.checkouts.length, 1);
  for (const value of [first.headers.etag, `W/${first.headers.etag}`, `"other", W/${first.headers.etag}`, '*']) {
    const response = await f.request('/v1/mine/view', { 'if-none-match': value });
    assert.equal(response.status, 304); assert.equal(response.body, ''); assert.equal(response.headers.etag, first.headers.etag);
  }
  assert.equal((await f.request('/v1/mine/view', { 'if-none-match': '"stale"' })).status, 200);
  assert.equal(f.stats.checkouts.length, 1);
  for (let n = 1; n <= 31; n++) await f.request(`/v1/mine/view?after=${addr(n)}`);
  await f.request(); await f.request(`/v1/mine/view?after=${addr(32)}`);
  assert.equal(f.gateway.mineView.cache.size, 32);
  const before = f.stats.checkouts.length;
  await f.request(); assert.equal(f.stats.checkouts.length, before, 'recently used first page retained');
  await f.request(`/v1/mine/view?after=${addr(1)}`); assert.equal(f.stats.checkouts.length, before + 1, 'oldest page evicted');
  data.set(`dep/${addr(1)}`, '42'); await f.sync(data);
  const changed = await f.request('/v1/mine/view', { 'if-none-match': first.headers.etag });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.etag, first.headers.etag); assert.equal(changed.json.miners[0][1], 42);
});

test('Mine uses one fixed checkout while the view advances, closes failures and never accesses the move queue', async t => {
  const data = new Map([[`dep/${addr(1)}`, '10']]), f = await fixture(t, data);
  for (const key of ['queue', 'queued']) Object.defineProperty(f.gateway, key, { get() { throw new Error('queue_access'); }, set() { throw new Error('queue_access'); } });
  const version = f.bee.version;
  f.stats.beforeRead = async () => { data.set(`dep/${addr(1)}`, '20'); data.set(`dep/${addr(2)}`, '30'); data.set('pool/game', '40'); await f.sync(data); };
  const old = await f.request();
  assert.equal(old.status, 200); assert.deepEqual(f.stats.checkouts, [version]); assert.equal(f.stats.closed, 1);
  assert.equal(old.json.total, 1); assert.equal(old.json.miners[0][1], 10); assert.equal(old.json.mine.stock, 0);
  const fresh = await f.request();
  assert.equal(fresh.status, 200); assert.equal(fresh.json.total, 2); assert.equal(fresh.json.mine.stock, 40);
  f.stats.failScan = true;
  const failed = await f.request(`/v1/mine/view?after=${addr(1)}`);
  assert.equal(failed.status, 400); assert.equal(f.stats.closed, 3);
  f.stats.failScan = false;
  assert.equal((await f.request(`/v1/mine/view?after=${addr(1)}`)).status, 200);
  assert.equal(f.stats.checkouts.length, 4); assert.equal(f.stats.closed, 4);
});

test('Mine refuses amounts that cannot be represented as exact JSON integers', async t => {
  const f = await fixture(t, new Map([[`dep/${addr(1)}`, '9007199254740993']]));
  const response = await f.request();
  assert.equal(response.status, 400); assert.equal(response.json.error, 'mine_amount');
  assert.equal(f.stats.closed, 1); assert.equal(f.gateway.mineView.cache.size, 0);
});
