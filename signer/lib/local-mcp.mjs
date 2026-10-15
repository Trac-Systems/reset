import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { publicAddress, signAndSolve, signTransfer } from './index.mjs';
import { check, validateTransfer } from './wire.mjs';
import { stableStringify } from './pow.mjs';
import { localBackend, rejection } from './local-backend.mjs';
import { coinInput, units, coins, validateState, validateAccount, statusView } from './local-state.mjs';

const penalty = 'Above 1000, requested excess adds a strike and costs excess times your strike count, taken from deposit then exiting coins. The first strike cannot improve net earnings; repeated overclaims lose.';

export async function createLocalMcp({ wallet, gatewayUrl, mcpUrl, context, maxAttempts = 10000000, maxWorkMs = 90000,
  log = text => process.stderr.write(text + '\n') }) {
  check(Number.isSafeInteger(maxAttempts) && maxAttempts > 0, 'Invalid attempt limit');
  check(Number.isSafeInteger(maxWorkMs) && maxWorkMs > 0 && maxWorkMs <= 110000, 'Work time limit must be 1..110000 milliseconds');
  const backend = localBackend({ wallet, gatewayUrl, mcpUrl }), addr = publicAddress(wallet), tnkAddress = wallet.address;
  const rules = await readFile(new URL('./rules.txt', import.meta.url), 'utf8');
  const server = new McpServer({ name: 'reset-signer', version: '0.1.0' }, { capabilities: { logging: {} } });
  const shutdown = new AbortController();
  const guessed = new Set();
  let busy = false;
  async function notice(message) {
    log(message);
    await server.sendLoggingMessage({ level: 'info', logger: 'reset-signer', data: message });
  }
  async function snapshot() {
    for (let i = 0; i < 3; i++) {
      const state = validateState(await backend.state());
      const raw = await backend.account();
      const current = validateState(await backend.state());
      if (stableStringify(state) === stableStringify(current)) return { state, account: validateAccount(raw, state) };
    }
    throw new Error('Gateway state changed between reads. Try again when the current block is stable.');
  }
  const register = (name, description, schema, run, readOnly = true) => server.registerTool(name, {
    description, inputSchema: z.object(schema).strict(),
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly, idempotentHint: readOnly }
  }, async (args, extra) => {
    if (busy) return { isError: true, content: [{ type: 'text', text: 'Another tool is running. Wait for its result before trying again.' }] };
    busy = true;
    try {
      const data = await run(args, extra);
      return { ...(data?.ok === false ? { isError: true } : {}),
        content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    } finally { busy = false; }
  });
  function allowance(state, account) {
    check(state.capacity_left > 0, 'This block has no move capacity left. Wait for the next block.');
    check(account.moves_this_height < state.per_address, 'Your move allowance is used. Wait for the next block.');
  }
  async function submit(send, details) {
    let result;
    try { result = await send(); }
    catch { return { ok: false, outcome: 'unknown', ...details,
      message: 'No reliable submission result was received. Check status and settlement before retrying; this action may already have been accepted.' }; }
    if (result?.ok === false) return { ok: false, outcome: 'rejected', ...details, message: rejection(result.error) };
    if (result?.ok !== true) return { ok: false, outcome: 'unknown', ...details,
      message: 'The submission response was invalid. Check status and settlement before retrying.' };
    return { ok: true, outcome: 'accepted', ...details,
      message: 'The gateway accepted the submission. Check status for application and settlement; acceptance is not finality.' };
  }
  async function move(t, build, extra) {
    const { state, account } = await snapshot(); allowance(state, account);
    const { payload, summary, warning } = build(state, account);
    if (warning) await notice(warning);
    const packet = await backend.prepareMove(t, payload, state);
    check(packet?.envelope?.t === t && stableStringify(packet.envelope.p) === stableStringify(payload), 'Gateway changed the requested move.');
    const trusted = validateState(await backend.state());
    const started = performance.now(); let lastProgress = -Infinity;
    const signal = AbortSignal.any([extra.signal, shutdown.signal, AbortSignal.timeout(maxWorkMs)]);
    let signed;
    try {
      signed = await signAndSolve(wallet, packet, { state: trusted, maxAttempts, signal,
        refreshState: async () => validateState(await backend.state()),
        onProgress: async (attempts, total) => {
          const now = performance.now();
          if (now - lastProgress < 1000) return;
          lastProgress = now;
          const message = `Solving the ${t} puzzle locally: ${attempts} attempts, ${Math.round(now - started)} ms elapsed.`;
          await notice(message);
          if (extra._meta?.progressToken !== undefined) await extra.sendNotification({ method: 'notifications/progress',
            params: { progressToken: extra._meta.progressToken, progress: attempts, total, message } });
        } });
    } catch (error) {
      if (signal.aborted) throw new Error('Puzzle work stopped at its time limit or was cancelled. No move was submitted.');
      throw error;
    }
    signal.throwIfAborted();
    const puzzle_ms = Math.round(performance.now() - started);
    await notice(`Puzzle solved locally in ${puzzle_ms} ms.`);
    signal.throwIfAborted();
    return submit(() => backend.submitMove(signed), { ...summary, puzzle_ms, ...(warning ? { warning } : {}) });
  }
  register('status', 'Read the block, lottery and Mine windows, your coins, exits, strikes, fair-share estimate and puzzle difficulty.', {}, async () => {
    const { state, account } = await snapshot(); return statusView(state, account, addr);
  });
  register('address', 'Show your public coin address and the trac1 address that pays TNK fees for transfers. Your private key stays on this machine.', {}, () => ({ address: addr, tnk_address: tnkAddress }));
  register('rules', 'Read the rules, costs, penalties and local signer limits.', {}, () => rules);
  register('lottery_guess', 'Make one free lottery guess. Defaults to the next eligible target and a random eight-hex guess.', {
    target: z.number().int().min(1).max(2147483647).optional(), guess: z.string().regex(/^[0-9a-f]{8}$/).optional()
  }, async (args, extra) => {
    const result = await move('guess', (state) => {
      for (const target of guessed) if (target < state.tip.height + 3) guessed.delete(target);
      let target = args.target ?? Math.max(state.lottery.start, state.tip.height + 3);
      if (args.target === undefined) while (guessed.has(target) || state.lottery.open_targets.some(t => t.tb === target && t.capacity_left === 0)) target++;
      check(target >= state.lottery.start && target < state.lottery.end && target >= state.tip.height + 3,
        'No eligible lottery target at that height. Check the lottery window in status.');
      const guess = args.guess ?? randomBytes(4).toString('hex');
      return { payload: { tb: target, n: guess }, summary: { target, guess } };
    }, extra);
    if (result.ok) guessed.add(result.target);
    return result;
  }, false);
  register('mine_claim', `Claim from Mine. Default level 1000 requests exactly your fair share. Levels 0..2000; above 1000 requires allow_over: true. ${penalty}`, {
    level: z.number().int().min(0).max(2000).optional(), allow_over: z.boolean().optional()
  }, (args, extra) => {
    const level = args.level ?? 1000;
    check(level <= 1000 || args.allow_over === true, `Refused: set allow_over: true to request above your fair share. ${penalty}`);
    return move('claim', (state, account) => {
      check(state.mine.window_open, 'The Mine claim window is closed. Wait for the first three blocks of a round.');
      check(BigInt(account.deposit) > 0n, 'Lock a positive deposit before claiming from Mine.');
      check(account.mine.claim === null, 'You already claimed in this Mine round.');
      return { payload: { r: state.mine.r, q: level }, summary: { round: state.mine.r, level,
        fair_share_estimate: coins(account.mine.fair_share_estimate) }, warning: level > 1000 ? penalty : undefined };
    }, extra);
  }, false);
  for (const type of ['lock', 'unlock']) register(type,
    type === 'lock' ? 'Move spendable coins into your Mine deposit, free of TNK fees.' : 'Start exiting deposited coins. They remain exposed to penalties until withdrawn.',
    { amount: coinInput }, (args, extra) => {
      const amount = units(args.amount);
      return move(type, (state, account) => {
        check(BigInt(amount) <= BigInt(type === 'lock' ? account.balance : account.deposit),
          type === 'lock' ? 'There are not enough spendable coins.' : 'There are not enough deposited coins.');
        return { payload: { amount }, summary: { action: type, amount: coins(amount),
          ...(type === 'unlock' ? { release_at_or_after: state.counted + state.params.exit_wait } : {}) } };
      }, extra);
    }, false);
  register('withdraw', 'Return all mature exits to spendable balance. Unsettled Mine claims must settle first. Free of TNK fees.', {},
    (_, extra) => move('withdraw', (state, account) => {
      const amount = account.exits.filter(e => e.release <= state.counted).reduce((sum, e) => sum + BigInt(e.amount), 0n);
      check(amount > 0n, 'No exits are mature yet. Check their release heights in status.');
      return { payload: {}, summary: { action: 'withdraw', amount: coins(amount.toString()) } };
    }, extra), false);
  register('transfer', 'Transfer coins to an exact public address. Shows the transfer before signing; TNK fees come from your own MSB address. Requires a trusted context file.', {
    to: z.string().regex(/^[0-9a-f]{64}$/), amount: coinInput
  }, async ({ to, amount }, extra) => {
    check(context, 'Transfers require --context or RESET_SIGNER_CONTEXT pointing to an independently trusted context file.');
    const value = units(amount), { account } = await snapshot();
    check(BigInt(value) <= BigInt(account.balance), 'There are not enough spendable coins.');
    const packet = await backend.prepareTransfer(to, value);
    check(packet?.address === addr && packet.to === to && packet.amount === value, 'Gateway changed the requested transfer.');
    validateTransfer(packet, { context });
    const review = `Transfer ${coins(value)} RESET from ${addr} to ${to}. The TNK fee is paid from your own MSB address ${wallet.address}.`;
    await notice(review);
    extra.signal.throwIfAborted(); shutdown.signal.throwIfAborted();
    const signed = signTransfer(wallet, packet, { context });
    return submit(() => backend.submitTransfer(signed), { amount: coins(value), to, from: addr,
      fee_source: 'Your own MSB address', fee_address: wallet.address, review });
  }, false);
  return { server, async close() { shutdown.abort(); await server.close(); await backend.close(); },
    async run() {
      const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16384 });
      await server.connect(transport);
      await new Promise(resolve => {
        process.stdin.once('end', resolve); process.once('SIGTERM', resolve); process.once('SIGINT', resolve);
        server.server.onclose = resolve;
      });
    } };
}
