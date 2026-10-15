#!/usr/bin/env node
import { readFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { runInstructions } from '../mcp/lib/instructions-client.mjs';
let directory;
try {
  const root = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const inputs = { mcpUrl: process.env.RESET_MCP_URL, gatewayUrl: process.env.RESET_GATEWAY_URL,
    keystore: await realpath(process.env.RESET_E2E_KEYSTORE), contextFile: process.env.RESET_E2E_CONTEXT,
    recipient: process.env.RESET_E2E_RECIPIENT };
  for (const origin of [inputs.mcpUrl, inputs.gatewayUrl]) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.origin !== origin || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Check accepts only local HTTP origins');
  }
  const roots = await Promise.all([root, fileURLToPath(new URL('../.devnet/', import.meta.url))].map(p => realpath(p).catch(() => null)));
  if (!roots.some(p => p && inputs.keystore.startsWith(p + sep))) throw new Error('Use a disposable local test keystore');
  directory = await mkdtemp(join(root, 'instructions-'));
  const text = await readFile(new URL('../tests/fixtures/client-plan.txt', import.meta.url), 'utf8');
  const rulesText = await readFile(new URL('../docs/llms.txt', import.meta.url), 'utf8');
  console.log(JSON.stringify(await runInstructions({ text, rulesText, inputs, directory, password: process.env.RESET_SIGNER_PASSWORD })));
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
finally { if (directory) await rm(directory, { recursive: true, force: true }); }
