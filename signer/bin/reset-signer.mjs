#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseArgs } from 'node:util';
import { ReadStream, WriteStream } from 'node:tty';
import { init, importMnemonic, getAddress, unlock, wipeWallet, signAndSolve, signTransfer, signChallenge, verify } from '../lib/index.mjs';

async function secretPrompt(label, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || !output.isTTY) throw new Error('Set RESET_SIGNER_PASSWORD or use an interactive terminal');
  output.write(label);
  input.setRawMode(true); input.resume(); input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.off('data', onData); input.setRawMode(false); input.pause();
      output.write('\n'); error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      for (const c of chunk) {
        if (c === '\u0003' || c === '\u0004') { finish(new Error('Cancelled')); return; }
        if (c === '\r' || c === '\n') { finish(); return; }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (c >= ' ') value += c;
      }
    };
    input.on('data', onData);
  });
}
async function terminalPassword() {
  // MCP owns stdin/stdout. Prompt only on the controlling terminal, when present.
  let terminal;
  try { terminal = await open('/dev/tty', constants.O_RDWR); }
  catch { throw new Error('Set RESET_SIGNER_PASSWORD locally; no controlling terminal is available for a hidden prompt.'); }
  const input = new ReadStream(terminal.fd, { autoClose: false });
  const output = new WriteStream(terminal.fd);
  try { return await secretPrompt('Keystore password: ', input, output); }
  finally { input.setRawMode(false); input.pause(); input.destroy(); output.destroy(); await terminal.close(); }
}
async function readJSON(path) {
  if (!path) throw new Error('JSON file required');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size > 65536) throw new Error('JSON input must be a regular file of at most 64 KiB');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
// The wallet, gateway and checks every long-running command shares (mcp, agent).
async function openWallet(values) {
  const { createGuard, passwordProbe } = await import('../lib/chat-guard.mjs');
  const { units } = await import('../lib/local-state.mjs');
  // Without explicit settings the local MCP plays on the public RESET mainnet (signer/networks/mainnet.json).
  const mainnet = await readJSON(new URL('../networks/mainnet.json', import.meta.url));
  const contextFile = values.context || process.env.RESET_SIGNER_CONTEXT || undefined;
  const gatewayDefault = values.gateway || process.env.RESET_GATEWAY_URL || ((values['mcp-url'] || process.env.RESET_MCP_URL) ? undefined : mainnet.gatewayUrl);
  const context = contextFile ? await readJSON(contextFile) : (gatewayDefault === mainnet.gatewayUrl ? mainnet.context : undefined);
  let password = process.env.RESET_SIGNER_PASSWORD ?? await terminalPassword();
  const directory = values.directory ?? process.env.RESET_SIGNER_DIRECTORY;
  const wallet = await unlock({ directory, password });
  const guard = createGuard({ wallet, passwordSeen: passwordProbe(password) });
  password = undefined; delete process.env.RESET_SIGNER_PASSWORD; delete process.env.RESET_SIGNER_MNEMONIC;
  const budget = process.env.RESET_TRANSFER_BUDGET;
  return { wallet, guard, directory, options: { wallet, context, gatewayUrl: gatewayDefault, directory, guard,
    mcpUrl: values['mcp-url'] ?? process.env.RESET_MCP_URL,
    headerSourceUrl: values['header-source'] || process.env.RESET_HEADER_SOURCE || undefined,
    transferBudget: budget ? units(budget) : '0', transferToChatAddresses: process.env.RESET_TRANSFER_TO_CHAT_ADDRESSES === 'allow',
    maxAttempts: Number(values['max-attempts'] ?? process.env.RESET_SIGNER_MAX_ATTEMPTS ?? 10000000),
    maxWorkMs: Number(values['max-work-ms'] ?? process.env.RESET_SIGNER_MAX_WORK_MS ?? 90000) } };
}
async function main() {
  if (process.argv[2] === 'dashboard') return (await import('../dashboard/index.mjs')).cli(process.argv.slice(3));
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    directory: { type: 'string' }, state: { type: 'string' }, context: { type: 'string' },
    audience: { type: 'string' }, 'max-attempts': { type: 'string' }, help: { type: 'boolean' },
    gateway: { type: 'string' }, 'mcp-url': { type: 'string' }, 'max-work-ms': { type: 'string' },
    'header-source': { type: 'string' }, role: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
    'base-url': { type: 'string' }, 'api-key-env': { type: 'string' }, persona: { type: 'string' }, 'list-models': { type: 'boolean' }
  } });
  const [command, file] = positionals;
  if (values.help || !command) return { commands: ['init', 'import', 'address', 'sign_and_solve <move.json> --state <state.json>',
    'sign_transfer <prepared.json> --context <trusted-context.json>', 'sign_challenge <challenge.json> --audience <origin>', 'verify <signed.json>',
    'mcp --gateway <trusted-origin> [--mcp-url <hosted-origin>] [--context <trusted-context.json>] [--header-source <bitcoin-api-origin>] [--role mine|chat]',
    'chat off|passive|active|status', 'agent --role chat|mine [--provider openmayhem] [--model <id>] [--base-url <url>] [--api-key-env <NAME>] [--persona <text>] [--list-models]'],
    password: 'RESET_SIGNER_PASSWORD or hidden prompt', mnemonic: 'RESET_SIGNER_MNEMONIC or hidden prompt for import' };
  if (positionals.length > 2) throw new Error('Unexpected arguments');
  if (!['init', 'import', 'address', 'sign_and_solve', 'sign_transfer', 'sign_challenge', 'verify', 'mcp', 'chat', 'agent'].includes(command)) throw new Error('Unknown command');
  if (command === 'chat') {
    // Owner switch for the chat: off, passive (chat only) or active (chat plus notes for the mining side).
    const { setMode, chatStatus } = await import('../lib/chat-mode.mjs');
    const directory = values.directory ?? process.env.RESET_SIGNER_DIRECTORY;
    const result = file === undefined || file === 'status' ? chatStatus(directory) : await setMode(file, { directory });
    if (!result.consistent) process.exitCode = 2;
    return result;
  }
  if (command === 'mcp') {
    if (file || values.state || values.audience) throw new Error('Unexpected MCP arguments');
    const role = values.role ?? 'mine';
    if (!['mine', 'chat'].includes(role)) throw new Error('--role is mine (the game tools) or chat (only the chat tools)');
    const { createLocalMcp } = await import('../lib/local-mcp.mjs');
    const opened = await openWallet(values);
    let service;
    try { service = await createLocalMcp({ ...opened.options, role }); await service.run(); }
    finally { try { await service?.close(); } finally { wipeWallet(opened.wallet); } }
    return;
  }
  if (command === 'agent') {
    const { modelClient, runChatAgent, runMineAgent } = await import('../lib/agent.mjs');
    const model = modelClient({ provider: values.provider ?? 'openmayhem', model: values.model, baseUrl: values['base-url'], apiKeyEnv: values['api-key-env'] });
    if (values['list-models']) return { provider: model.provider, models: await model.listModels() };
    const role = values.role;
    if (!['chat', 'mine'].includes(role)) throw new Error('Choose --role chat (talks in the chat) or --role mine (plays the Mine)');
    const persona = values.persona ?? process.env.RESET_AGENT_PERSONA;
    if (persona !== undefined && (typeof persona !== 'string' || persona.length > 1000)) throw new Error('The persona must be text of at most 1000 characters');
    const opened = await openWallet(values);
    const controller = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
    let closer;
    try {
      if (role === 'chat') {
        // The chat agent gets only the chat: no game tools at all.
        const { localBackend } = await import('../lib/local-backend.mjs');
        const backend = localBackend({ wallet: opened.wallet, gatewayUrl: opened.options.gatewayUrl });
        closer = () => backend.close();
        await runChatAgent({ wallet: opened.wallet, backend, guard: opened.guard, directory: opened.directory, model, persona, signal: controller.signal });
      } else {
        const { createLocalMcp } = await import('../lib/local-mcp.mjs');
        const service = await createLocalMcp({ ...opened.options, role: 'mine', processRole: 'mine-agent' });
        closer = () => service.close();
        await runMineAgent({ service, model, persona, signal: controller.signal });
      }
    } finally { try { await closer?.(); } finally { wipeWallet(opened.wallet); } }
    return;
  }
  const options = { state: values.state ? await readJSON(values.state) : undefined,
    context: values.context ? await readJSON(values.context) : undefined, audience: values.audience,
    maxAttempts: values['max-attempts'] ? Number(values['max-attempts']) : undefined };
  if (command === 'verify') return { valid: verify(await readJSON(file), options) };
  const password = process.env.RESET_SIGNER_PASSWORD ?? await secretPrompt('Keystore password: ');
  const storage = { directory: values.directory, password };
  if (command === 'init') return init(storage);
  if (command === 'import') return importMnemonic({ ...storage, mnemonic: process.env.RESET_SIGNER_MNEMONIC ?? await secretPrompt('Mnemonic: ') });
  if (command === 'address') return getAddress(storage);
  const packet = await readJSON(file);
  const wallet = await unlock(storage);
  try {
    if (command === 'sign_and_solve') return await signAndSolve(wallet, packet, options);
    if (command === 'sign_transfer') return signTransfer(wallet, packet, options);
    return signChallenge(wallet, packet, options);
  } finally { wipeWallet(wallet); }
}
try { const result = await main(); if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n'); }
catch (error) {
  (process.argv.includes('mcp') ? process.stderr : process.stdout).write(JSON.stringify({ error: error.message }) + '\n');
  process.exitCode = 1;
}
