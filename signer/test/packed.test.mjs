import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp, password } from './helpers.mjs';
import { connectLocal } from './stdio-client.mjs';
const exec = promisify(execFile);

test('packed tarball runs through npx with an isolated cache and keystore', { timeout: 90000 }, async t => {
  const directory = await temp(t);
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const cache = fileURLToPath(new URL('../../.npm-cache', import.meta.url));
  const env = { ...process.env, npm_config_userconfig: '/dev/null', npm_config_cache: process.env.npm_config_cache ?? cache,
    npm_config_prefer_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', RESET_SIGNER_PASSWORD: password };
  const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd, env })).stdout);
  assert.ok(packed[0].files.every(f => !f.path.includes('test/') && !f.path.includes('node_modules') && !f.path.endsWith('keystore.json')));
  const archive = join(directory, packed[0].filename);
  const run = async (...args) => JSON.parse((await exec('npx', ['--yes', '--ignore-scripts', '--package', archive, 'reset-signer', ...args,
    '--directory', join(directory, 'wallet')], { cwd: directory, env, timeout: 60000 })).stdout);
  const initialized = await run('init');
  assert.deepEqual(await run('address'), { address: initialized.address });
  assert.ok((await run('--help')).commands.includes('init'));
  const local = await connectLocal({ command: 'npx', args: ['--yes', '--ignore-scripts', '--package', archive, 'reset-signer', 'mcp'],
    directory: join(directory, 'wallet'), password, gatewayUrl: 'http://127.0.0.1:9' });
  try {
    const shown = await local.call('address');
    assert.equal(shown.address, initialized.address); assert.match(shown.tnk_address, /^trac1/);
    assert.match(await local.call('rules'), /fair share/);
    assert.equal((await local.client.listTools()).tools.length, 9);
    assert.ok(!JSON.stringify([local.logs, local.outputs]).includes(password));
  } finally { await local.close(); }
  assert.match((await run('dashboard', '--help')).usage, /^dashboard /);
});
