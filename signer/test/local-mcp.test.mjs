import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localFixture } from './local-fixture.mjs';
import { password } from './helpers.mjs';
import { units, coins } from '../lib/local-state.mjs';
import { transactionHash } from '../lib/wire.mjs';
import { context } from './helpers.mjs';
import { createMcpService } from '../../mcp/lib/server.mjs';
import { createServer } from 'node:http';
import { chain, parseHeader } from '../../tests/helpers/chain.mjs';

// A Bitcoin source with the mempool.space REST shape, serving `headers` as heights 1..n.
async function bitcoinSource(t, headers, alter = {}) {
  const byHash = new Map(headers.map(hx => [parseHeader(hx).hash, hx]));
  const http = createServer((req, res) => {
    let m, body = null;
    if (req.url === '/api/blocks/tip/height') body = String(headers.length);
    else if ((m = /^\/api\/block-height\/(\d+)$/.exec(req.url)) && headers[m[1] - 1]) body = parseHeader(headers[m[1] - 1]).hash;
    else if ((m = /^\/api\/block\/([0-9a-f]{64})\/header$/.exec(req.url)) && byHash.has(m[1])) body = alter.header?.(byHash.get(m[1])) ?? byHash.get(m[1]);
    res.writeHead(body === null ? 404 : 200); res.end(body ?? 'not found');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  return `http://127.0.0.1:${http.address().port}`;
}

test('coin amounts use exact eight-decimal integer arithmetic', () => {
  for (const [input, value] of [['0.00000001', '1'], ['3.125', '312500000'], ['9007199254740993.12345678', '900719925474099312345678']]) {
    assert.equal(units(input), value); assert.equal(units(coins(value)), value);
  }
  for (const bad of ['0', '0.00000000', '-1', '1e8', '01', '.1', '1.', '1.000000001', '9'.repeat(79), 1]) assert.throws(() => units(bad));
});

test('stdio tools play through the contract, preserve secrets, report work and show transfer review', async t => {
  const f = await localFixture(t), c = await f.connect();
  const names = (await c.client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(names, ['address', 'lock', 'lottery_guess', 'mine_claim', 'post_headers', 'rules', 'status', 'transfer', 'unlock', 'withdraw']);
  const shown = await c.call('address');
  assert.equal(shown.address, f.address);
  assert.match(shown.tnk_address, /^trac1[02-9ac-hj-np-z]{58}$/);
  assert.match(await c.call('rules'), /RESET/);
  assert.equal((await c.call('status')).balance, '10.00000000');
  assert.equal((await c.call('lock', { amount: '0.00000010' })).ok, true);
  const guess = await c.call('lottery_guess'); assert.equal(guess.target, 10); assert.match(guess.guess, /^[0-9a-f]{8}$/);
  const claim = await c.call('mine_claim'); assert.equal(claim.level, 1000); assert.equal(claim.round, 1);
  assert.equal((await c.call('unlock', { amount: '0.00000010' })).ok, true);
  await assert.rejects(c.call('withdraw'), /No exits are mature/);
  await f.ledger.advance(8);
  await assert.rejects(c.call('withdraw'), /must settle/);
  await f.ledger.advance(17);
  assert.equal((await c.call('withdraw')).ok, true);
  const transfer = await c.call('transfer', { to: 'bb'.repeat(32), amount: '0.00000003' });
  assert.equal(transfer.ok, true); assert.equal(transfer.amount, '0.00000003');
  assert.ok(c.logs.some(x => x.includes('Transfer 0.00000003 RESET') && x.includes('TNK fee')));
  assert.ok(c.progress.length > 0);
  assert.ok(c.outputs.some(x => x.content[0].text.includes('puzzle_ms')));
  assert.equal(JSON.stringify([c.outputs, c.logs, f.control.requests]).includes(password), false);
  assert.equal(JSON.stringify(c.outputs).includes('signature'), false);
  f.ledger.check();
});

test('post_headers brings new Bitcoin headers in batches, then reports nothing new', async t => {
  const f = await localFixture(t);
  const c = await f.connect({ headerSource: await bitcoinSource(t, f.ledger.headers.slice(0, 40)) });
  const tip = (await c.call('status')).tip;
  const first = await c.call('post_headers');
  assert.equal(first.ok, true); assert.equal(first.from_height, tip + 1); assert.equal(first.headers, 20); assert.equal(first.source_height, 40);
  assert.equal((await c.call('status')).tip, tip + 20);
  const second = await c.call('post_headers');
  assert.equal(second.to_height, 40);
  const none = await c.call('post_headers');
  assert.equal(none.outcome, 'nothing_new'); assert.equal((await c.call('status')).tip, 40);
  f.ledger.check();
});

test('post_headers refuses a source whose headers do not match and reports a foreign chain as rejected', async t => {
  const f = await localFixture(t);
  const forged = await f.connect({ headerSource: await bitcoinSource(t, f.ledger.headers.slice(0, 40), { header: hx => hx.slice(0, 150) + 'ffffffffff' }) });
  await assert.rejects(forged.call('post_headers'), /do not fit together/);
  assert.equal(f.control.submissions.length, 0);
  const foreign = await f.connect({ headerSource: await bitcoinSource(t, chain(40, undefined, 600, 7)) });
  const result = JSON.parse((await foreign.result('post_headers')).content[0].text);
  assert.equal(result.outcome, 'rejected'); assert.match(result.message, /do not connect/);
  const down = await f.connect({ headerSource: 'http://127.0.0.1:9' });
  await assert.rejects(down.call('post_headers'), /unavailable/);
});

test('stdio refuses overclaims unless explicit and rejects unsafe schemas and unknown signing tools', async t => {
  const f = await localFixture(t), c = await f.connect();
  await assert.rejects(c.call('mine_claim', { level: 1001 }), /allow_over.*strike/);
  await assert.rejects(c.call('mine_claim'), /positive deposit/);
  for (const [name, args] of [['lock', { amount: 1 }], ['lock', { amount: '0' }], ['status', { password: 'not-an-input' }],
    ['lottery_guess', { guess: 'FFFFFFFF' }], ['mine_claim', { level: 2001 }], ['sign', { data: 'data' }], ['export_key', {}]]) {
    assert.equal((await c.result(name, args)).isError, true);
  }
  assert.equal(f.control.submissions.length, 0);
  await c.call('lock', { amount: '1' });
  const claim = await c.call('mine_claim', { level: 1001, allow_over: true });
  assert.equal(claim.level, 1001); assert.match(claim.warning, /excess.*strike/);
  await assert.rejects(c.call('mine_claim'), /already claimed/);
});

test('inconsistent state, changing tips, capacity, balances and expired lottery all refuse before submission', async t => {
  const f = await localFixture(t), c = await f.connect();
  for (const alter of [s => ({ ...s, counted: s.tip.height + 1 }), s => ({ ...s, mine: { ...s.mine, window_open: false } }),
    s => ({ ...s, bits: { ...s.bits, lock: 33 } }), s => ({ ...s, capacity_left: s.params.capacity + 1 })]) {
    f.control.state = alter; await assert.rejects(c.call('lock', { amount: '1' }), /inconsistent/);
  }
  let count = 0;
  f.control.state = s => ({ ...s, tip: { ...s.tip, hash: (++count).toString(16).padStart(64, '0') } });
  await assert.rejects(c.call('lock', { amount: '1' }), /changed between reads/);
  f.control.state = s => ({ ...s, capacity_left: 0 });
  await assert.rejects(c.call('lock', { amount: '1' }), /capacity/);
  f.control.state = s => s;
  await assert.rejects(c.call('lock', { amount: '11' }), /not enough/);
  await assert.rejects(c.call('lottery_guess', { target: 145 }), /eligible lottery/);
  assert.equal(f.control.submissions.length, 0);
});

test('default lottery target skips this session guesses and full targets; explicit guesses are preserved', async t => {
  const f = await localFixture(t), c = await f.connect();
  assert.equal((await c.call('lottery_guess', { guess: '0123abcd' })).guess, '0123abcd');
  f.control.state = s => ({ ...s, lottery: { ...s.lottery, open_targets: [...s.lottery.open_targets,
    { tb: 11, guesses: 1800, capacity_left: 0, accepting: true }] } });
  assert.equal((await c.call('lottery_guess')).target, 12);
  await assert.rejects(c.call('lottery_guess', { target: 10, guess: '00000000' }), /already guessed/);
});

test('local connection refuses redirects, oversized and malformed responses; explicit HTTP refusal stays rejected', async t => {
  const f = await localFixture(t), c = await f.connect();
  f.control.response = (_, res) => { res.writeHead(302, { location: f.gatewayUrl + '/v1/state' }); res.end(); };
  await assert.rejects(c.call('status'), /unavailable or invalid/);
  f.control.response = (_, res) => { res.writeHead(200); res.end('x'.repeat(262145)); };
  await assert.rejects(c.call('status'), /unavailable or invalid/);
  f.control.response = (_, res) => { res.writeHead(200); res.end('not-json'); };
  await assert.rejects(c.call('status'), /invalid JSON/);
  f.control.response = undefined;
  const handler = f.control.state;
  let reads = 0;
  f.control.state = s => {
    if (++reads === 4) f.control.response = (_, res) => { res.writeHead(429); res.end('{"ok":false,"error":"address_rate"}'); };
    return handler(s);
  };
  const result = JSON.parse((await c.result('lock', { amount: '1' })).content[0].text);
  assert.equal(result.outcome, 'rejected'); assert.match(result.message, /request limit/);
});

test('post-puzzle state refresh, work limits and cancellation prevent signing/submission', async t => {
  const f = await localFixture(t);
  let count = 0;
  f.control.state = s => { count++; return count >= 4 ? { ...s, tip: { ...s.tip, hash: 'ef'.repeat(32) } } : s; };
  const c = await f.connect();
  await assert.rejects(c.call('lock', { amount: '1' }), /State changed during puzzle/);
  f.control.state = s => ({ ...s, bits: { ...s.bits, lock: 32 } });
  const bounded = await f.connect({ flags: ['--max-attempts', '1'] });
  await assert.rejects(bounded.call('lock', { amount: '1' }), /attempt limit/);
  const timed = await f.connect({ flags: ['--max-work-ms', '1'] });
  await assert.rejects(timed.call('lock', { amount: '1' }), /time limit|cancelled/);
  assert.equal(f.control.submissions.length, 0);
});

test('transfer tampering and missing context refuse; uncertain submissions are never retried', async t => {
  const f = await localFixture(t), c = await f.connect();
  for (const attack of [p => ({ ...p, amount: '2' }), p => ({ ...p, tx: 'ff'.repeat(32) }),
    p => ({ ...p, context: { ...p.context, writer: 'ef'.repeat(32) } }),
    p => ({ ...p, prepared_command: { type: 'gw_set', value: {} } })]) {
    f.control.transfer = attack; await assert.rejects(c.call('transfer', { to: 'bb'.repeat(32), amount: '0.00000003' }), /mismatch/);
  }
  const noContext = await f.connect({ contextFile: undefined });
  await assert.rejects(noContext.call('transfer', { to: 'bb'.repeat(32), amount: '1' }), /independently trusted/);
  assert.equal(f.control.submissions.length, 0);
  f.control.transfer = p => {
    const foreign = { ...context, incomingWritingKey: 'ef'.repeat(32) };
    return { ...p, tx: transactionHash(foreign, p.context.content_hash, p.nonce),
      context: { ...p.context, writer: foreign.incomingWritingKey } };
  };
  await assert.rejects(c.call('transfer', { to: 'bb'.repeat(32), amount: '0.00000003' }), /Foreign transfer context/);
  f.control.submit = () => ({ ok: false, error: 'already_guessed' });
  await assert.rejects(c.call('lottery_guess'), /already guessed/);
  f.control.submit = () => ({ invalid: true });
  const uncertain = await c.result('lock', { amount: '1' });
  assert.equal(JSON.parse(uncertain.content[0].text).outcome, 'unknown');
  assert.equal(f.control.submissions.length, 2);
});

test('hosted-only stdio mode logs in locally and trusted gateway detects altered preparations', async t => {
  const f = await localFixture(t);
  const hosted = await createMcpService({ gatewayUrl: f.gatewayUrl });
  const mcpUrl = await hosted.listen(); t.after(() => hosted.close());
  const c = await f.connect({ gatewayUrl: undefined, mcpUrl });
  assert.equal((await c.call('status')).balance, '10.00000000');
  assert.equal((await c.call('lock', { amount: '0.00000010' })).ok, true);
  assert.equal((await c.call('transfer', { to: 'bb'.repeat(32), amount: '0.00000003' })).ok, true);
  assert.equal(JSON.stringify([c.outputs, c.logs, f.control.requests]).includes(password), false);
  const checked = await f.connect({ mcpUrl });
  let reads = 0;
  f.control.state = s => ++reads === 4 ? { ...s, tip: { ...s.tip, hash: 'ef'.repeat(32) } } : s;
  const before = f.control.submissions.length;
  await assert.rejects(checked.call('lock', { amount: '0.00000001' }), /Stale or foreign block/);
  assert.equal(f.control.submissions.length, before);
});

test('bundled rules match the short public instructions and recipe remains separate', async () => {
  const rules = await readFile(new URL('../lib/rules.txt', import.meta.url), 'utf8');
  assert.equal(rules, await readFile(new URL('../../docs/llms.txt', import.meta.url), 'utf8'));
  assert.equal(rules.includes('BEGIN CLIENT PLAN'), false);
  assert.match(await readFile(new URL('../../tests/fixtures/client-plan.txt', import.meta.url), 'utf8'), /BEGIN CLIENT PLAN/);
});

test('MCP startup errors stay off stdout and do not expose the password', async t => {
  const f = await localFixture(t);
  await assert.rejects(promisify(execFile)(process.execPath, [new URL('../bin/reset-signer.mjs', import.meta.url).pathname,
    'mcp', '--directory', f.directory], { env: { ...process.env, RESET_SIGNER_PASSWORD: password + '-wrong' } }), error => {
    assert.equal(error.stdout, ''); assert.match(error.stderr, /Wrong password/); assert.ok(!error.stderr.includes(password)); return true;
  });
});
