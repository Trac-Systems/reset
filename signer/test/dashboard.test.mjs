import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboard, keystoreAddress } from '../dashboard/index.mjs';
import { History, HISTORY_FILE, ARCHIVE_FILE } from '../dashboard/history.mjs';
import { coins, blocksTime } from '../dashboard/format.mjs';
import { temp } from './helpers.mjs';

const ME = 'a1'.repeat(32), OTHER = 'b2'.repeat(32), GW = 'c3'.repeat(32);
const T0 = Date.UTC(2026, 9, 15, 12);

function state({ counted = 971790, lottery = {}, mine = {} } = {}) {
  return { tip: { height: counted + 2, hash: 'ab'.repeat(32) }, counted,
    bits: { header: 0, gw_beat: 0, lock: 12, unlock: 12, withdraw: 12, guess: 20, claim: 12 }, capacity_left: 590, per_address: 6,
    params: { move_bits: 12, capacity: 600, per_address: 6, exit_wait: 144 },
    gateways: [{ addr: GW, registered: true, last_beat: counted + 2, active: true }, { addr: OTHER, registered: true, last_beat: 1, active: false }],
    lottery: { start: 971712, end: 971856, blocks: 144, winners: 10, locked: true, open_targets: [], recent_results: [], ...lottery },
    mine: { r: 351, start: 971803, claim_end: 971805, end: 971808, window_open: true, S: '1200000000000', C: '44550000000',
      vein_buffer: '0', last_guideline: '1856250000', claim_count: 3, claim_deposit: '30000000000',
      params: { mine_capacity: '44550000000', mine_bonus_per_mille: 100, mine_clean_rounds: 24, mine_max_strikes: 4 },
      last_result: null, last_vein: null, ...mine } };
}
function account({ balance = '0', deposit = '0', exits = [], mine = {} } = {}) {
  return { balance, deposit, exits, moves_this_height: 0,
    mine: { r: 351, claim: null, fair_share_estimate: '0', strikes: 0, clean: 0, last_result: null, ...mine } };
}

async function fakeGateway(t, initial) {
  let current = initial;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const body = req.url === '/v1/state' ? current.state : req.url === `/v1/account/${ME}` ? current.account : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? { error: 'not found' }));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const close = () => new Promise(ok => { server.closeAllConnections(); server.close(ok); });
  t.after(() => server.listening && close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests, set: next => { current = next; }, close };
}

async function dashboard(t, options) {
  const clock = { now: T0 };
  const d = await startDashboard({ port: 0, env: {}, interval: 3600000, now: () => clock.now, ...options });
  t.after(() => d.close());
  const page = async () => (await fetch(`${d.url}/`)).text();
  return { ...d, clock, page };
}

async function view(t, s, a) {
  const gw = await fakeGateway(t, { state: s, account: a });
  const d = await dashboard(t, { gateway: gw.url, address: ME, directory: await temp(t) });
  return d.page();
}
const text = html => html.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('coin amounts use at most eight decimals, trimmed, and never show raw units', () => {
  assert.equal(coins('312500000'), '3.125');
  assert.equal(coins('0'), '0');
  assert.equal(coins('1'), '0.00000001');
  assert.equal(coins('123456789000000'), '1,234,567.89');
  assert.equal(coins(-150000000n), '−1.5');
  assert.equal(coins('100000000', { sign: true }), '+1');
  assert.equal(coins('not a number'), '0');
  assert.equal(blocksTime(3), 'about 30 min');
  assert.equal(blocksTime(144), 'about 24 h');
});

test('offline, unset and connecting states are explained in plain words', async t => {
  const dir = await temp(t);
  // Without a configured gateway the dashboard follows the public network file (not contacted in tests).
  const mainnet = JSON.parse(await readFile(new URL('../networks/mainnet.json', import.meta.url), 'utf8'));
  assert.match(mainnet.gatewayUrl, /^https:\/\//);
  const noAddress = await dashboard(t, { gateway: 'http://127.0.0.1:9', directory: join(dir, 'empty') });
  assert.match(await noAddress.page(), /No address yet/);
  const gw = await fakeGateway(t, { state: state(), account: account() });
  await gw.close();
  const offline = await dashboard(t, { gateway: gw.url, address: ME, directory: dir });
  const html = await offline.page();
  assert.match(html, /Gateway not reachable/);
  assert.match(html, /Retrying every 15 seconds/);
});

test('a gateway that goes away keeps the last data with a clear banner', async t => {
  const gw = await fakeGateway(t, { state: state(), account: account({ balance: '500000000' }) });
  const d = await dashboard(t, { gateway: gw.url, address: ME, directory: await temp(t) });
  assert.doesNotMatch(await d.page(), /not reachable/);
  await gw.close();
  d.clock.now += 5 * 60000;
  await d.refresh();
  const html = text(await d.page());
  assert.match(html, /Gateway not reachable\. Showing data from 5 min ago/);
  assert.match(html, /5 in total/);
});

test('no coins and the lottery start are shown before anything happened', async t => {
  const html = text(await view(t, state({ counted: 971700 }), account()));
  assert.match(html, /No coins yet/);
  assert.match(html, /Lottery starts at block 971712/);
  assert.match(html, /about 2 h from now/);
  assert.match(html, /Lock coins to take part/);
  assert.match(html, /Gateways active 1 of 2/);
});

test('open lottery shows window, targets, my wins and recent results', async t => {
  const results = [
    { tb: 971780, hash: 'cd'.repeat(32), winners: [{ address: OTHER, n: '00000001', distance: 3, amount: '309375000' }], paid: '309375000', to_mine: '0', winner_count: 1, winners_truncated: false },
    { tb: 971781, hash: 'ef'.repeat(32), winners: [{ address: ME, n: 'abcdef01', distance: 12, amount: '154687500' }, { address: OTHER, n: '00000002', distance: 40, amount: '154687500' }], paid: '309375000', to_mine: '0', winner_count: 2, winners_truncated: false }];
  const html = text(await view(t, state({ lottery: { open_targets: [{ tb: 971795, guesses: 7, accepting: true, capacity_left: 1793 }, { tb: 971792, guesses: 3, accepting: false, capacity_left: 1797 }], recent_results: results } }),
    account({ balance: '154687500' })));
  assert.match(html, /Lottery open/);
  assert.match(html, /Blocks done 79 of 144/);
  assert.match(html, /1 block taking guesses, 10 guesses so far/);
  assert.match(html, /Block 971781 won 1.546875 off by 12/);
  assert.match(html, /won 1.546875/);
  assert.match(html, /1.546875 in total/);
});

test('the lottery card disappears after the lottery unless my wins are recent', async t => {
  const win = { tb: 971855, hash: 'cd'.repeat(32), winners: [{ address: ME, n: '00000001', distance: 1, amount: '30937500' }], paid: '309375000', to_mine: '0', winner_count: 10, winners_truncated: false };
  const recent = text(await view(t, state({ counted: 971900, lottery: { recent_results: [win] } }), account({ balance: '30937500' })));
  assert.match(recent, /Lottery over/);
  assert.match(recent, /Block 971855 won 0.309375/);
  const later = await view(t, state({ counted: 972100, lottery: { recent_results: [win] } }), account({ balance: '30937500' }));
  assert.doesNotMatch(later, /id="lottery"/);
  const nobody = await view(t, state({ counted: 971900 }), account());
  assert.doesNotMatch(nobody, /id="lottery"/);
});

test('Mine shows round, window, fair share, last claim, strikes, stock and vein', async t => {
  const html = text(await view(t,
    state({ mine: { window_open: false, vein_buffer: '250000000', last_vein: { height: 971777, hash: '00'.repeat(31) + '0fff', amount: '1250000000' } } }),
    account({ balance: '100000000', deposit: '1000000000', exits: [{ amount: '200000000', release: 971700 }, { amount: '300000000', release: 971934 }],
      mine: { claim: { d: '1000000000', q: 1500 }, fair_share_estimate: '61875000', strikes: 2, clean: 5,
        last_result: { r: 350, address: ME, fair: '61875000', amount: '80000000', penalty: '36250000', strikes: 2, clean: 0 } } })));
  assert.match(html, /round 351/);
  assert.match(html, /Claim window closed next opens at block 971809/);
  assert.match(html, /My fair share now 0.61875/);
  assert.match(html, /You claimed 150% of your fair share/);
  assert.match(html, /Round 350: received 0.8 of a fair share of 0.61875 penalty 0.3625/);
  assert.match(html, /2 of 4 strikes 5 of 24 clean rounds until one is forgiven/);
  assert.match(html, /Coins in the Mine 12,000 of 445.5 max/);
  assert.match(html, /Vein buffer 2.5/);
  assert.match(html, /Block 971777: 12.5 released/);
  assert.match(html, /16 in total/);
  assert.match(html, /2 ready to withdraw/);
  assert.match(html, /3 releases at block 971934 \(about 24 h\)/);
  assert.doesNotMatch(html, /\b1000000000\b|units/);
});

test('history samples once per counted block, counts each result once and stays bounded', async t => {
  const dir = await temp(t);
  const history = await History.load(dir, ME, { maxSamples: 10 });
  const win = { tb: 971790, winners: [{ address: ME, amount: '100000000' }, { address: OTHER, amount: '5' }] };
  const result = { r: 1, amount: '50000000', penalty: '0' };
  const s = counted => state({ counted, lottery: { recent_results: [win] } });
  assert.equal(history.observe({ state: s(971790), account: account({ mine: { last_result: result } }), now: T0 }), true);
  assert.equal(history.observe({ state: s(971790), account: account({ mine: { last_result: result } }), now: T0 + 1 }), false);
  assert.equal(history.observe({ state: s(971791), account: account({ mine: { last_result: result } }), now: T0 + 2 }), true);
  assert.deepEqual(history.totals, { mine: '50000000', lottery: '100000000', penalties: '0' });
  history.observe({ state: s(971797), account: account({ balance: '7', mine: { last_result: { r: 2, amount: '10', penalty: '4' } } }), now: T0 + 3 });
  assert.deepEqual(history.totals, { mine: '50000010', lottery: '100000000', penalties: '4' });
  assert.equal(history.last.holdings, '7');
  await history.save();
  assert.equal((await stat(join(dir, HISTORY_FILE))).mode & 0o777, 0o600);
  const reloaded = await History.load(dir, ME, { maxSamples: 10 });
  assert.deepEqual(reloaded.started, { h: 971790, t: T0 });
  for (let h = 971798; h < 971830; h++) { reloaded.observe({ state: state({ counted: h }), account: account(), now: T0 + h }); await reloaded.save(); }
  const main = JSON.parse(await readFile(join(dir, HISTORY_FILE), 'utf8'));
  const archive = JSON.parse(await readFile(join(dir, ARCHIVE_FILE), 'utf8'));
  assert.ok(main.samples.length <= 10 && archive.samples.length <= 10);
  assert.equal(main.samples.at(-1).h, 971829);
  assert.deepEqual(main.started, { h: 971790, t: T0 });
  assert.deepEqual(main.totals, { mine: '50000010', lottery: '100000000', penalties: '4' });
  // Another address's history is moved aside, never overwritten.
  const other = await History.load(dir, OTHER);
  assert.equal(other.samples.length, 0);
  assert.ok((await readdir(dir)).includes(`dashboard-history-${ME.slice(0, 16)}.json`));
});

test('the dashboard records history from the gateway and shows the chart', async t => {
  const dir = await temp(t);
  const gw = await fakeGateway(t, { state: state(), account: account({ deposit: '1000000000' }) });
  const d = await dashboard(t, { gateway: gw.url, address: ME, directory: dir });
  assert.match(text(await d.page()), /The chart fills in as new blocks are counted/);
  gw.set({ state: state({ counted: 971796 }), account: account({ deposit: '1000000000', mine: { last_result: { r: 351, fair: '61875000', amount: '61875000', penalty: '0', strikes: 0, clean: 1 } } }) });
  d.clock.now += 3600000;
  await d.refresh();
  const html = await d.page();
  assert.match(html, /data-chart/);
  assert.match(text(html), /\+0.61875 earned since block 971790/);
  assert.match(text(html), /Last new block just now/);
  assert.equal(JSON.parse(await readFile(join(dir, HISTORY_FILE), 'utf8')).samples.length, 2);
  assert.ok(gw.requests.every(r => r.method === 'GET'));
});

test('binds 127.0.0.1 only, refuses foreign hosts and writes, and sets a strict policy', async t => {
  const gw = await fakeGateway(t, { state: state(), account: account() });
  const d = await dashboard(t, { gateway: gw.url, address: ME, directory: await temp(t) });
  assert.equal(d.server.address().address, '127.0.0.1');
  const port = d.server.address().port;
  const res = await fetch(`${d.url}/`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'; script-src 'nonce-/);
  assert.doesNotMatch(await res.text(), /https?:\/\/(?!127\.0\.0\.1)[a-z]/i, 'no external resources');
  assert.equal((await fetch(`${d.url}/`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${d.url}/nope`)).status, 404);
  const foreign = await new Promise((ok, fail) =>
    request({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, r => ok(r.statusCode)).on('error', fail).end());
  assert.equal(foreign, 403);
});

test('never touches the wallet: only the public keystore address is read', async t => {
  const dir = await temp(t);
  await chmod(dir, 0o700);
  await writeFile(join(dir, 'keystore.json'), JSON.stringify({ v: 1, address: ME, kdf: 'x', cipher: 'x', salt: 'x', iv: 'x', ciphertext: 'not-decryptable', tag: 'x' }), { mode: 0o600 });
  assert.equal(await keystoreAddress(dir), ME);
  const gw = await fakeGateway(t, { state: state(), account: account() });
  const d = await dashboard(t, { gateway: gw.url, directory: dir });
  assert.equal(d.snapshot().address, ME);
  // With an explicit address the keystore is not opened at all.
  await chmod(join(dir, 'keystore.json'), 0o000);
  const explicit = await dashboard(t, { gateway: gw.url, address: ME, directory: dir });
  assert.equal(explicit.snapshot().address, ME);
  await chmod(join(dir, 'keystore.json'), 0o600);
  const source = (await Promise.all(['index.mjs', 'history.mjs', 'render.mjs', 'format.mjs'].map(f =>
    readFile(new URL(`../dashboard/${f}`, import.meta.url), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /lib\/|trac-wallet|keystore\.mjs|unlock\(|PASSWORD|MNEMONIC|signAndSolve|sign_and_solve|\/v1\/move|\/v1\/tx|method: 'POST'/);
});

test('the CLI starts the dashboard on the requested loopback port', { timeout: 20000 }, async t => {
  const dir = await temp(t);
  const gw = await fakeGateway(t, { state: state(), account: account() });
  const free = await new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  const bin = fileURLToPath(new URL('../bin/reset-signer.mjs', import.meta.url));
  const child = spawn(process.execPath, [bin, 'dashboard', '--port', String(free), '--address', ME, '--directory', dir],
    { env: { ...process.env, RESET_GATEWAY_URL: gw.url, RESET_ADDRESS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const line = await new Promise((ok, fail) => {
    let out = '';
    child.stdout.on('data', c => { out += c; if (out.includes('\n')) ok(out.split('\n')[0]); });
    child.on('exit', code => fail(new Error(`exited ${code}`)));
  });
  assert.deepEqual(JSON.parse(line), { dashboard: `http://127.0.0.1:${free}`, address: ME, gateway: gw.url });
  assert.match(await (await fetch(`http://127.0.0.1:${free}/`)).text(), /My coins/);
});
