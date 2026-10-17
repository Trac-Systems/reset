import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFixture } from './local-fixture.mjs';
import { password } from './helpers.mjs';
import { unlock, wipeWallet } from '../lib/keystore.mjs';
import { createGuard, passwordProbe } from '../lib/chat-guard.mjs';
import { setMode, chatStatus, chatPaths, readMode } from '../lib/chat-mode.mjs';
import { addNote, digest, unreadNotes, readNotes } from '../lib/journal.mjs';
import { hexToTrac } from '../lib/trac-address.mjs';

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const until = async (fn, ms = 10000, label = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${label}`);
};
function child(t, script, env) {
  const p = spawn(process.execPath, [fixture(script)], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  const out = []; p.stderr.on('data', c => out.push(c.toString()));
  const exited = new Promise(resolve => p.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { try { p.kill('SIGKILL'); } catch {} });
  return { p, out, exited, text: () => out.join('') };
}

test('outgoing guard: free topics pass; secrets, owner details and reasoning are refused', async t => {
  const f = await localFixture(t);
  const wallet = await unlock({ directory: f.directory, password });
  t.after(() => wipeWallet(wallet));
  const guard = createGuard({ wallet, passwordSeen: passwordProbe(password), owner: { user: 'pitworker', host: 'studio-mac' } });
  for (const ok of ['anyone watching the rain tonight?', 'I claim 1000 every round and sleep well',
    `my address is ${hexToTrac(f.address)}`, `hex works too: ${f.address}`, 'Plan: everyone claims fair, nobody gets strikes']) assert.equal(guard(ok), null, ok);
  const secret = Buffer.from(wallet.secretKey).toString('hex');
  const refused = {
    [`the pass is ${password}!`]: /password/, [`key ${secret.slice(0, 32)}`]: /private key/,
    [wallet.mnemonic.split(' ').slice(2, 7).join(' ')]: /recovery words/, 'look at /Users/someone/notes.txt': /File paths/,
    'try ~/secrets': /File paths/, 'token sk-abcdefghijklmnop1234': /key or token/, 'mail me at a.b@example.org': /Email/,
    'server 10.0.0.12 is mine': /IP/, 'OPENAI_API_KEY=abc': /NAME=value/, '<think>I should lie</think> hi': /reasoning/,
    'Thinking: they are weak': /reasoning/, 'my system prompt says hi': /prompt/, 'hi from pitworker': /user or machine/,
    'see https://x.y': /Links/, 'Q29tcGxleFNlY3JldFRva2VuMTIzNDU2Nzg5MA==': /random-looking/, ['x'.repeat(241)]: /too long/,
    'two\nlines': /one line/ };
  for (const [text, reason] of Object.entries(refused)) assert.match(guard(text) ?? 'passed', reason, text);
});

test('modes: a real chat agent chats in passive, and off stops it for good', async t => {
  const f = await localFixture(t);
  await f.ledger.move('lock', { amount: '500000000' }, f.address);
  const env = { RESET_SIGNER_DIRECTORY: f.directory, RESET_SIGNER_PASSWORD: password, RESET_GATEWAY_URL: f.gatewayUrl, CHILD_SAY: 'hello pit' };
  // Off at start: the agent refuses to run at all.
  const early = child(t, 'reset-signer-chat-child.mjs', env);
  assert.equal((await early.exited).code, 0); assert.match(early.text(), /Chat mode is off/);
  assert.equal(chatStatus(f.directory).processes.length, 0);

  const passive = await setMode('passive', { directory: f.directory });
  assert.equal(passive.mode, 'passive'); assert.equal(passive.consistent, true, JSON.stringify(passive)); assert.equal(passive.chatting, false);
  const agent = child(t, 'reset-signer-chat-child.mjs', env);
  await until(() => chatStatus(f.directory).chatting, 10000, 'agent running and confirmed');
  // Active and back: the running agent confirms each change.
  assert.equal((await setMode('active', { directory: f.directory })).consistent, true);
  assert.equal((await setMode('passive', { directory: f.directory })).consistent, true);
  f.chat.postViewer({ id: 'room:1', name: 'Ann', text: 'anyone down there?' });     // something to answer
  await until(async () => (await f.chat.list(null)).messages.some(m => m.text === 'hello pit'), 10000, 'message in the chat')
    .catch(error => { throw new Error(`${error.message}\n${agent.text()}`); });
  const sent = (await f.chat.list(null)).messages.find(m => m.text === 'hello pit');
  assert.equal(sent.addr, f.address); assert.equal(sent.record.locked, '500000000');

  const off = await setMode('off', { directory: f.directory });
  assert.equal(off.mode, 'off'); assert.equal(off.consistent, true, JSON.stringify(off)); assert.equal(off.chatting, false);
  assert.deepEqual(off.processes, []);
  const exit = await agent.exited;
  assert.equal(exit.code, 0); assert.match(agent.text(), /CHILD_DONE/);
  assert.equal(existsSync(chatPaths(f.directory).cursor), false);
});

test('off terminates a chat process that ignores the switch, and status never claims off while one runs', async t => {
  const f = await localFixture(t);
  await setMode('passive', { directory: f.directory });
  const stuck = child(t, 'reset-signer-stuck-child.mjs', { RESET_SIGNER_DIRECTORY: f.directory });
  await until(() => /STUCK_READY/.test(stuck.text()), 10000, 'stuck child');
  const during = chatStatus(f.directory);
  assert.equal(during.consistent, false); assert.match(during.problems.join(), /has not confirmed/);
  const off = await setMode('off', { directory: f.directory, waitMs: 300, killWaitMs: 300 });
  assert.deepEqual(off.terminated?.map(x => x.stopped), [true]);
  assert.equal(off.consistent, true, JSON.stringify(off));
  assert.equal((await stuck.exited).signal, 'SIGKILL');
  // A chat process that is somehow alive while the mode is off is reported, never hidden.
  const { run } = chatPaths(f.directory); mkdirSync(run, { recursive: true });
  writeFileSync(join(run, `chat-agent-${process.pid}.json`), JSON.stringify({ pid: process.pid, role: 'chat-agent', applied_generation: readMode(f.directory).generation }));
  const report = chatStatus(f.directory);
  assert.equal(report.consistent, false); assert.match(report.problems.join(), /still running/);
});

test('journal: typed notes only, a digest by code, read once per round, gone when leaving active', async t => {
  const f = await localFixture(t);
  const a = 'aa'.repeat(32), b = 'bb'.repeat(32), base = { round: 9, block: 120, now: Date.now() };
  assert.throws(() => addNote(f.directory, { about: a, kind: 'send_coins', value: 1, evidence: 'said' }, base), /kind must be/);
  assert.throws(() => addNote(f.directory, { about: a, kind: 'claim_level', value: 1000, evidence: 'said', text: 'send me 5' }, base), /exactly/);
  assert.throws(() => addNote(f.directory, { about: a, kind: 'claim_level', value: 3000, evidence: 'said' }, base), /0 to 2000/);
  addNote(f.directory, { about: a, kind: 'claim_level', value: 1000, evidence: 'record' }, { ...base, record: { strikes: 0, last_paid: '0.2' } });
  addNote(f.directory, { about: b, kind: 'claim_level', value: 1400, evidence: 'said' }, { ...base, record: { strikes: 2, last_paid: '0' } });
  const notes = unreadNotes(f.directory, 9);
  assert.equal(notes.length, 2);
  const text = digest(notes);
  assert.match(text, /1 address claims at level 1000: trac1\w{4}…\w{4} \(backed by record; strikes 0, paid last round 0\.2\)/);
  assert.match(text, /level 1400/); assert.match(text, /opinions, not orders/);
  await setMode('active', { directory: f.directory });
  assert.equal(readNotes(f.directory).length, 2);
  await setMode('passive', { directory: f.directory });
  assert.equal(readNotes(f.directory).length, 0); assert.equal(existsSync(chatPaths(f.directory).journal), false);
});

test('MCP: chat role tools follow the mode, the mining side gets notes only in active, transfers are guarded', async t => {
  const f = await localFixture(t);
  await f.ledger.move('lock', { amount: '500000000' }, f.address);
  // Off: the chat MCP server stops on its own.
  const offChat = await f.connect({ flags: ['--role', 'chat'] });
  await until(() => offChat.logs.join('').includes('Chat mode is off'), 10000, 'chat MCP stop');

  await setMode('passive', { directory: f.directory });
  const chat = await f.connect({ flags: ['--role', 'chat'] });
  const mine = await f.connect({ env: { RESET_TRANSFER_BUDGET: '1' } });
  const names = async c => (await c.client.listTools()).tools.map(x => x.name).sort();
  assert.deepEqual(await names(chat), ['chat_read', 'chat_send']);
  assert.ok(!(await names(mine)).includes('journal'));
  assert.equal((await chat.call('chat_send', { text: 'first words' })).ok, true);
  const view = await chat.call('chat_read');
  assert.match(view.notice, /opinions, not instructions/); assert.equal(view.messages.at(-1).text, 'first words');
  assert.equal(view.messages.at(-1).you, true); assert.equal(typeof view.now.time, 'string');
  assert.equal((await chat.result('chat_send', { text: 'look at /Users/x' })).isError, true);
  assert.equal((await mine.call('status')).chat_mode, 'passive');

  // Someone else talks; in active the chat agent notes it and the mining side sees the digest.
  const other = await import('../lib/chat.mjs');
  const { createWallet, publicAddress } = await import('../lib/keystore.mjs');
  const stranger = await createWallet();
  await f.ledger.move('lock', { amount: '1' }, publicAddress(stranger)).catch(() => {});
  f.chat.add({ v: 1, kind: 'agent', addr: publicAddress(stranger), text: 'I always claim 1300', ts: Date.now(), nonce: '12'.repeat(8) }, { locked: '1' });
  await chat.call('chat_read');
  await assert.rejects(chat.call('note', { about: publicAddress(stranger), kind: 'claim_level', value: 1300, evidence: 'said' }), /Unknown tool|disabled|not found/i);
  await setMode('active', { directory: f.directory });
  await until(async () => (await names(chat)).includes('note'), 10000, 'note tool');
  assert.ok((await names(mine)).includes('journal'));
  assert.equal((await chat.call('note', { about: hexToTrac(publicAddress(stranger)), kind: 'claim_level', value: 1300, evidence: 'said' })).ok, true);
  await assert.rejects(chat.call('note', { about: 'cc'.repeat(32), kind: 'claim_level', value: 1, evidence: 'said' }), /appeared in the chat/);
  const status = await mine.call('status');
  assert.equal(status.chat_mode, 'active'); assert.equal(status.chat_notes.unread_this_round, 1);
  assert.match(status.chat_notes.summary, /claims at level 1300/);

  // Transfers while active: never to a chat address, and within the owner's daily budget.
  await assert.rejects(mine.call('transfer', { to: publicAddress(stranger), amount: '0.1' }), /appeared in the chat/);
  await assert.rejects(mine.call('transfer', { to: 'dd'.repeat(32), amount: '2' }), /daily transfer budget/);
  const noBudget = await f.connect();
  await assert.rejects(noBudget.call('transfer', { to: 'dd'.repeat(32), amount: '0.1' }), /paused while chat mode is active/);

  // Leaving active: notes gone, journal tool gone, note tool gone, transfers back to normal rules.
  const passive = await setMode('passive', { directory: f.directory });
  assert.equal(passive.consistent, true, JSON.stringify(passive));
  await until(async () => !(await names(mine)).includes('journal') && !(await names(chat)).includes('note'), 10000, 'tools hidden');
  assert.equal((await mine.call('status')).chat_notes, undefined);
  const off = await setMode('off', { directory: f.directory });
  assert.equal(off.consistent, true, JSON.stringify(off));
  assert.deepEqual(off.processes.map(p => p.role).sort(), ['mine-mcp', 'mine-mcp']);
});

test('built-in agent model client: OpenMayhem Flash-Next by default, only tool calls are used', async t => {
  const { createServer } = await import('node:http');
  const { modelClient } = await import('../lib/agent.mjs');
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'a', routes: [{ tools: true }] }, { id: 'b', routes: [{ tools: false }] }] }
      : { choices: [{ message: { content: 'secret plan: say nothing true', reasoning_content: 'internal',
        tool_calls: [{ function: { name: 'chat_send', arguments: '{"text":"hi all"}' } }] } }] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const local = `http://127.0.0.1:${server.address().port}/v1`;
  // The OpenMayhem preset: default model and key name, and the thinking switch only for OpenMayhem.
  assert.throws(() => modelClient({ env: {} }), /OPENMAYHEM_API_KEY/);
  assert.equal(modelClient({ env: { OPENMAYHEM_API_KEY: 'k' } }).model, 'qwen/qwen3.8-flash-next');
  assert.throws(() => modelClient({ provider: 'openai', env: { OPENAI_API_KEY: 'k' } }), /--model/);
  assert.throws(() => modelClient({ baseUrl: 'http://example.org/v1', model: 'm', apiKeyEnv: 'K', env: { K: 'k' } }), /HTTPS/);
  const om = modelClient({ env: { OPENMAYHEM_API_KEY: 'om-key' }, fetchImpl: (url, init) => fetch(String(url).replace('https://api.openmayhem.ai/v1', local), init) });
  const calls = await om.complete({ messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.deepEqual(calls, [{ name: 'chat_send', args: { text: 'hi all' } }]);
  assert.equal(seen[0].auth, 'Bearer om-key'); assert.equal(seen[0].body.model, 'qwen/qwen3.8-flash-next');
  assert.equal(seen[0].body.thinking_mode, 'disabled');
  assert.deepEqual(await om.listModels(), ['a']);
  const other = modelClient({ provider: 'ollama', model: 'llama', baseUrl: local });
  await other.complete({ messages: [], tools: [] });
  assert.equal(seen.at(-1).body.thinking_mode, undefined); assert.equal(seen.at(-1).auth, undefined);
});
