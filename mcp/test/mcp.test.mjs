import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWallet, importMnemonic, publicAddress, wipeWallet, signChallenge, signAndSolve, signTransfer } from 'reset-signer';
import { temp, password } from '../../signer/test/helpers.mjs';
import { createMcpService } from '../lib/server.mjs';
import { Login } from '../lib/auth.mjs';
import { RateLimit } from '../lib/http.mjs';
import { gatewayClient } from '../lib/gateway.mjs';
import { startFakeGateway } from './fake-gateway.mjs';
import { connectAgent, post } from './client.mjs';
import { runPhaseOne } from './e2e-flow.mjs';

async function setup(t, options = {}) {
  const wallet = await createWallet(); t.after(() => wipeWallet(wallet));
  const addr = publicAddress(wallet);
  const gateway = await startFakeGateway({ funded: { [addr]: '1000' }, ...options.fake });
  t.after(() => gateway.close());
  const service = await createMcpService({ gatewayUrl: gateway.url, ...options.server });
  const url = await service.listen(); t.after(() => service.close());
  return { wallet, addr, gateway, service, url };
}

test('real SDK MCP client performs every tool: lock, unlock, matured withdraw and transfer', async t => {
  const { wallet, gateway, url } = await setup(t, { fake: { exitWait: 2 } });
  const result = await runPhaseOne({ mcpUrl: url, wallet, recipient: 'bb'.repeat(32), context: gateway.context,
    beforeWithdraw: async () => gateway.advance(2) });
  assert.equal(result.balance, '997');
  assert.equal(result.tools, 7);
  assert.ok(gateway.requests.every(r => r.path.startsWith('/v1/')));
});

test('MCP exposes lottery/Mine preparation for the local signer with strict game schemas', async t => {
  const { wallet, gateway, url } = await setup(t);
  gateway.state.bits.guess = 8; gateway.state.bits.claim = 8;
  const agent = await connectAgent(url, wallet); t.after(() => agent.client.close());
  for (const [type, payload] of [['guess', { tb: gateway.state.tip.height + 3, n: '00000000' }], ['claim', { r: 0, q: 1000 }]]) {
    const packet = await agent.call('reset_prepare_move', { t: type, p: payload });
    assert.deepEqual(packet.envelope.p, payload); assert.equal(packet.bits, 8);
    const signed = await signAndSolve(wallet, packet, { state: gateway.state });
    assert.equal(JSON.parse(signed.prepared.dispatch.msg).t, type);
  }
  await assert.rejects(agent.call('reset_prepare_move', { t: 'claim', p: { r: 0, q: 2001 } }), /Invalid claim/);
});

test('real-gateway runner uses the same loop against a configured local fixture URL', async t => {
  const { wallet, gateway } = await setup(t);
  const directory = await temp(t), keystore = join(directory, 'wallet'), contextFile = join(directory, 'context.json');
  await importMnemonic({ directory: keystore, password, mnemonic: wallet.mnemonic });
  await writeFile(contextFile, JSON.stringify(gateway.context));
  const script = new URL('../../scripts/e2e-real-gateway.mjs', import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, [script], { timeout: 20000, env: { ...process.env,
    RESET_GATEWAY_URL: gateway.url, RESET_E2E_KEYSTORE: keystore, RESET_SIGNER_PASSWORD: password,
    RESET_E2E_CONTEXT: contextFile, RESET_E2E_RECIPIENT: 'bb'.repeat(32) } });
  assert.equal(JSON.parse(stdout).ok, true);
  assert.equal(JSON.parse(stdout).balance, '997');
});

test('HTTP login rejects forged, replayed, foreign, expired challenges; sessions expire', async t => {
  let now = Date.now();
  const { wallet, addr, url } = await setup(t, { server: { now: () => now, sessionTtlMs: 1000 } });
  const challenge = await (await post(`${url}/auth/challenge`, { address: addr })).json();
  const signed = signChallenge(wallet, challenge, { audience: url, now });
  const logged = await post(`${url}/auth/login`, signed);
  assert.equal(logged.status, 200); const { token } = await logged.json();
  assert.equal((await post(`${url}/auth/login`, signed)).status, 401);
  const forged = await (await post(`${url}/auth/challenge`, { address: addr })).json();
  assert.equal((await post(`${url}/auth/login`, { challenge: forged, signature: '00'.repeat(64) })).status, 401);
  assert.equal((await post(`${url}/auth/login`, signChallenge(wallet, forged, { audience: url, now }))).status, 401);
  const foreign = await (await post(`${url}/auth/challenge`, { address: addr })).json();
  foreign.audience = 'http://foreign.test';
  assert.equal((await post(`${url}/auth/login`, signChallenge(wallet, foreign, { audience: foreign.audience, now }))).status, 401);
  const expired = await (await post(`${url}/auth/challenge`, { address: addr })).json();
  const expiredSigned = signChallenge(wallet, expired, { audience: url, now });
  now += 60001;
  assert.equal((await post(`${url}/auth/login`, expiredSigned)).status, 401);
  assert.equal((await post(`${url}/mcp`, {}, { authorization: `Bearer ${token}` })).status, 401);
  assert.equal((await post(`${url}/mcp`, {})).status, 401);
});

test('login is IP-bound; bounded challenge/session stores; address rate limit is independent of IP', async t => {
  const wallet = await createWallet(); t.after(() => wipeWallet(wallet));
  const addr = publicAddress(wallet), audience = 'http://localhost:3100';
  let now = 1000;
  const auth = new Login({ audience, now: () => now, maxEntries: 1 });
  const challenge = auth.challenge(addr, 'ip-a');
  assert.throws(() => auth.challenge(addr, 'ip-b'), /Too many/);
  const signed = signChallenge(wallet, challenge, { audience, now });
  assert.throws(() => auth.login(signed, 'ip-b'), /Invalid/);
  const next = auth.challenge(addr, 'ip-a');
  auth.login(signChallenge(wallet, next, { audience, now }), 'ip-a');
  const third = auth.challenge(addr, 'ip-a');
  assert.throws(() => auth.login(signChallenge(wallet, third, { audience, now }), 'ip-a'), /Too many sessions/);
  now += 600001;
  assert.ok(auth.challenge(addr, 'ip-a'));
  const limit = new RateLimit({ limit: 1, windowMs: 1000, now: () => now, maxEntries: 1 });
  limit.take(addr); assert.throws(() => limit.take(addr), /Rate limit/);
  assert.throws(() => limit.take('another'), /storage full/);
  now += 1000; assert.doesNotThrow(() => limit.take('another'));
});

test('HTTP rate limits per address and per IP, including challenge requests', async t => {
  const byAddress = await setup(t, { server: { addressLimit: 2, ipLimit: 100 } });
  for (let i = 0; i < 2; i++) assert.equal((await post(`${byAddress.url}/auth/challenge`, { address: byAddress.addr })).status, 200);
  assert.equal((await post(`${byAddress.url}/auth/challenge`, { address: byAddress.addr })).status, 429);
  assert.equal((await post(`${byAddress.url}/auth/challenge`, { address: 'aa'.repeat(32) })).status, 200);
  const byIp = await setup(t, { server: { ipLimit: 1, addressLimit: 100 } });
  assert.equal((await post(`${byIp.url}/auth/challenge`, { address: byIp.addr })).status, 200);
  assert.equal((await post(`${byIp.url}/auth/challenge`, { address: 'bb'.repeat(32) }, { 'x-forwarded-for': 'fake' })).status, 429);
});

test('oversized/chunked bodies, malformed JSON, host/origin checks, methods and body timeout', async t => {
  const { addr, url } = await setup(t, { server: { maxBodyBytes: 1024, bodyTimeoutMs: 100 } });
  assert.equal((await post(`${url}/auth/challenge`, { address: addr, padding: 'x'.repeat(1100) })).status, 413);
  assert.equal((await post(`${url}/auth/challenge`, { address: addr }, { origin: 'http://foreign.test' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(`${url}/auth/challenge`, { method: 'POST', headers: { host: 'foreign.test', 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(JSON.stringify({ address: addr }));
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${url}/mcp`)).status, 405);
  assert.equal((await post(`${url}/unknown`, {})).status, 404);
  assert.equal((await fetch(`${url}/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${url}/auth/challenge`, { method: 'POST', body: '{}' })).status, 415);
  const raw = chunk => new Promise((resolve, reject) => {
    const req = request(`${url}/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.resume(); res.once('end', () => { req.destroy(); resolve(res.statusCode); });
    });
    req.on('error', reject); req.write(chunk);
  });
  assert.equal(await raw('x'.repeat(2048)), 413);
  assert.equal(await raw('{'), 408);
});

test('MCP tool schemas and signatures reject invalid or foreign submissions before reaching gateway', async t => {
  const { wallet, gateway, url } = await setup(t);
  const agent = await connectAgent(url, wallet); t.after(() => agent.client.close());
  await assert.rejects(agent.call('reset_prepare_move', { t: 'lock', p: { amount: '1.5' } }), /integer units/);
  await assert.rejects(agent.call('reset_prepare_transfer', { to: 'bad', amount: '3' }));
  await assert.rejects(agent.call('reset_state', { url: 'http://untrusted.test' }));
  const packet = await agent.call('reset_prepare_move', { t: 'lock', p: { amount: '10' } });
  const signed = await signAndSolve(wallet, packet, { state: gateway.state });
  const before = gateway.requests.length;
  await assert.rejects(agent.call('reset_submit_move', { ...signed, signature: '00'.repeat(64) }), /Invalid signed/);
  const foreign = structuredClone(signed); foreign.prepared.dispatch.address = 'cc'.repeat(32);
  await assert.rejects(agent.call('reset_submit_move', foreign), /differs from login/);
  assert.equal(gateway.requests.length, before);
  const transfer = await agent.call('reset_prepare_transfer', { to: 'bb'.repeat(32), amount: '3' });
  const tx = signTransfer(wallet, transfer, { context: gateway.context });
  await assert.rejects(agent.call('reset_submit_transfer', { ...tx, address: 'cc'.repeat(32) }), /differs from login/);
  await assert.rejects(agent.call('reset_submit_transfer', { ...tx, signature: '00'.repeat(64) }), /Invalid transfer signature/);
});

test('fake gateway rejects bad puzzle, replay, stale/foreign block, capacity and immature exits', async t => {
  const { wallet, addr, gateway, url } = await setup(t, { fake: { exitWait: 2 } });
  const agent = await connectAgent(url, wallet); t.after(() => agent.client.close());
  const move = async (type, p) => signAndSolve(wallet, await agent.call('reset_prepare_move', { t: type, p }), { state: gateway.state });
  const lock = await move('lock', { amount: '10' });
  // Deliberately invalid proof: raise difficulty after solving, retaining a valid signature.
  gateway.state.bits.lock = 32;
  assert.equal((await post(`${gateway.url}/v1/move`, lock)).status, 400);
  gateway.state.bits.lock = 8;
  assert.equal((await agent.call('reset_submit_move', lock)).ok, true);
  await assert.rejects(agent.call('reset_submit_move', lock), /Gateway rejected/);
  await agent.call('reset_submit_move', await move('unlock', { amount: '10' }));
  await assert.rejects(agent.call('reset_submit_move', await move('withdraw', {})), /Gateway rejected/);
  gateway.state.capacity_left = 0;
  await assert.rejects(agent.call('reset_submit_move', await move('lock', { amount: '1' })), /Gateway rejected/);
  const stale = await move('lock', { amount: '1' }); gateway.advance(3);
  await assert.rejects(agent.call('reset_submit_move', stale), /Gateway rejected/);
  assert.equal(gateway.account(addr).deposit, '0');
});

test('gateway down surfaces a tool error; rules remain available', async t => {
  const { wallet, gateway, url } = await setup(t);
  const agent = await connectAgent(url, wallet); t.after(() => agent.client.close());
  await gateway.close();
  await assert.rejects(agent.call('reset_state'), /Gateway unavailable/);
  assert.match(await agent.call('reset_rules'), /RESET/);
});

test('gateway timeout, oversized/invalid response and redirects are bounded and refused', async t => {
  let mode = 'timeout';
  const server = createServer((req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://foreign.test' }); res.end(); return; }
    res.end(mode === 'oversize' ? 'x'.repeat(2048) : 'not json');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const gateway = gatewayClient(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 50, maxBytes: 1024 });
  for (mode of ['timeout', 'redirect', 'oversize', 'invalid']) await assert.rejects(gateway('/v1/state'), /Gateway unavailable/);
  await assert.rejects(gateway('http://foreign.test'), /Invalid gateway route/);
});
