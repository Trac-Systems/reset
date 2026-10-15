#!/usr/bin/env node
// Uses exactly the fake-gateway test's client loop; only RESET_GATEWAY_URL changes transport.
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { unlock, wipeWallet } from '../signer/lib/index.mjs';
import { createMcpService } from '../mcp/lib/server.mjs';
import { runPhaseOne } from '../mcp/test/e2e-flow.mjs';

let service, wallet;
try {
  const gatewayUrl = process.env.RESET_GATEWAY_URL;
  const url = new URL(gatewayUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('E2E accepts only a local HTTP test gateway');
  const root = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
  const directory = await realpath(process.env.RESET_E2E_KEYSTORE ?? resolve(root, 'real-wallet'));
  const roots = await Promise.all(['../.test-tmp/', '../.devnet/'].map(async path =>
    realpath(fileURLToPath(new URL(path, import.meta.url))).catch(() => null)));
  if (!roots.some(path => path && directory.startsWith(path + sep))) throw new Error('Use a disposable test keystore under .test-tmp/ or .devnet/');
  const context = JSON.parse(await readFile(process.env.RESET_E2E_CONTEXT, 'utf8'));
  const recipient = process.env.RESET_E2E_RECIPIENT;
  if (!/^[0-9a-f]{64}$/.test(recipient ?? '')) throw new Error('Set RESET_E2E_RECIPIENT to a local test recipient');
  const stateResponse = await fetch(new URL('/v1/state', url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!stateResponse.ok) throw new Error('Cannot read test gateway state');
  const state = await stateResponse.json();
  if (!Number.isSafeInteger(state.params?.exit_wait) || state.params.exit_wait < 0) throw new Error('Missing exit maturity setting');
  wallet = await unlock({ directory, password: process.env.RESET_SIGNER_PASSWORD });
  let mcpUrl = process.env.RESET_MCP_URL;
  if (mcpUrl) {
    const mcp = new URL(mcpUrl);
    if (mcp.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(mcp.hostname) || mcp.origin !== mcpUrl) throw new Error('MCP must be a local HTTP origin');
  } else { service = await createMcpService({ gatewayUrl }); mcpUrl = await service.listen(); }
  const result = await runPhaseOne({ mcpUrl, wallet, recipient, context,
    trustedState: async () => {
      const response = await fetch(new URL('/v1/state', url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Cannot read trusted gateway state');
      return response.json();
    },
    beforeWithdraw: async call => {
      const deadline = Date.now() + 240000;
      const account = await call('reset_account');
      const release = Math.max(...account.exits.map(exit => exit.release));
      while ((await call('reset_state')).counted < release) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for counted-height exit maturity');
        await delay(3000);
      }
    },
    waitForState: async (step, call, initial) => {
      const deadline = Date.now() + 20000;
      do {
        const account = await call('reset_account');
        if (step === 'lock' && account.deposit === String(BigInt(initial.deposit) + 10n)) return;
        if (step === 'unlock' && account.exits.some(e => e.amount === '10')) return;
        if (step === 'withdraw' && account.exits.length === 0 && account.balance === initial.balance) return;
        if (step === 'transfer' && account.balance === String(BigInt(initial.balance) - 3n)) return;
        await delay(2000);
      } while (Date.now() < deadline);
      throw new Error(`Timed out waiting for ${step} to apply`);
    }
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
finally { if (wallet) wipeWallet(wallet); if (service) await service.close(); }
