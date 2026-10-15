// Generic interpreter: endpoint paths, tool names, signer commands and success
// predicates all come from the recipe in tests/fixtures/client-plan.txt.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const execute = promisify(execFile);
const signer = fileURLToPath(new URL('../../signer/bin/reset-signer.mjs', import.meta.url));

export async function runInstructions({ text, rulesText, inputs, directory, password }) {
  const match = /BEGIN CLIENT PLAN\n([\s\S]*?)\nEND CLIENT PLAN/.exec(text);
  if (!match) throw new Error('Instructions lack the executable client recipe');
  const plan = JSON.parse(match[1]);
  if (plan.v !== 1 || !Array.isArray(plan.steps)) throw new Error('Unsupported instructions recipe');
  if (typeof rulesText !== 'string') throw new Error('Supply the public rules text separately from the executable recipe');
  const variables = { inputs, instructions: rulesText };
  let client, counter = 0;
  function value(x) {
    if (typeof x === 'string' && x.startsWith('$')) {
      let result = variables;
      for (const key of x.slice(1).split('.')) {
        if (!Object.hasOwn(result ?? {}, key)) throw new Error(`Missing instruction variable ${x}`);
        result = result[key];
      }
      return result;
    }
    if (Array.isArray(x)) return x.map(value);
    if (!x || typeof x !== 'object') return x;
    if (x.add) return value(x.add).reduce((a, b) => a + BigInt(b), 0n).toString();
    if (x.subtract) { const [a, b] = value(x.subtract); return (BigInt(a) - BigInt(b)).toString(); }
    if (x.eq) { const [a, b] = value(x.eq); return a === b; }
    if (x.gte) { const [a, b] = value(x.gte); return BigInt(a) >= BigInt(b); }
    if (x.all) return x.all.every(value);
    for (const kind of ['every', 'some']) if (x[kind]) {
      const items = value(x[kind].in);
      return items[kind](item => { variables.item = item; return value(x[kind].where); });
    }
    return Object.fromEntries(Object.entries(x).map(([key, item]) => [key, value(item)]));
  }
  async function step(s) {
    let output;
    if (s.http) {
      const base = new URL(value(s.http.base));
      const target = new URL(s.http.path, base);
      if (target.origin !== base.origin) throw new Error('Instruction HTTP request left the trusted origin');
      const response = await fetch(target, { method: s.http.body ? 'POST' : 'GET', redirect: 'error',
        signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json' },
        body: s.http.body ? JSON.stringify(value(s.http.body)) : undefined });
      output = await response.json();
      if (!response.ok) throw new Error(output.error ?? `HTTP ${response.status}`);
    } else if (s.local) {
      if (!['address', 'sign_challenge', 'sign_and_solve', 'sign_transfer'].includes(s.local.command)) throw new Error('Unsupported local signer command');
      const args = [signer, s.local.command];
      if (s.local.input) {
        const file = join(directory, `packet-${counter++}.json`);
        await writeFile(file, JSON.stringify(value(s.local.input)), { mode: 0o600 }); args.push(file);
      }
      for (const [flag, input] of Object.entries(s.local.flags ?? {})) {
        if (!['state', 'context', 'audience'].includes(flag)) throw new Error('Unsupported local signer flag');
        let resolved = value(input);
        if (flag === 'state') {
          const file = join(directory, `state-${counter++}.json`);
          await writeFile(file, JSON.stringify(resolved), { mode: 0o600 }); resolved = file;
        }
        args.push(`--${flag}`, resolved);
      }
      args.push('--directory', inputs.keystore);
      const { stdout } = await execute(process.execPath, args, {
        env: { ...process.env, RESET_SIGNER_PASSWORD: password }, timeout: 120000 }).catch(error => {
        // The signer emits its public validation error as JSON on stdout.
        let message;
        try { message = JSON.parse(error.stdout).error; } catch {}
        throw new Error(message ?? `Local signer failed: ${s.local.command}`);
      });
      output = JSON.parse(stdout);
    } else if (s.connect) {
      client = new Client({ name: 'reset-instructions-check', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(s.connect.path, inputs.mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${value(s.connect.token)}` } } }));
    } else if (s.tool) {
      const result = await client.callTool({ name: s.tool, arguments: value(s.args ?? {}) });
      if (result.isError) throw new Error(result.content[0].text);
      const text = result.content[0].text;
      output = s.text ? text : JSON.parse(text);
    } else if (s.wait) {
      const end = Date.now() + s.wait.timeoutMs;
      do {
        for (const read of s.wait.reads) await step(read);
        if (value(s.wait.until)) return;
        if (Date.now() >= end) throw new Error(`Instructions timed out: ${s.wait.label}`);
        await delay(s.wait.pollMs);
      } while (true);
    } else if (s.check) {
      if (!value(s.check)) throw new Error(`Instructions check failed: ${s.label}`);
    } else throw new Error('Unrecognized instruction step');
    if (s.save) variables[s.save] = output;
  }
  try {
    for (const instruction of plan.steps) await step(instruction);
    return { ok: true, steps: plan.steps.length, result: value(plan.result) };
  } finally { await client?.close(); }
}
