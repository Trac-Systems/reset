#!/usr/bin/env node
import { open, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startDevnet } from './lib/devnet-network.mjs';
import { DEVNET_DIRECTORY, checkDevnetDirectory as checkRoot } from './lib/devnet-store.mjs';

const root = DEVNET_DIRECTORY.replace(/\/$/, '');
const lockPath = join(root, 'run.lock');
const socketPath = join(root, 'control.sock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function readLock() {
  return JSON.parse(await readFile(lockPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return 'null'; throw e; }));
}
async function stop() {
  if (!await checkRoot()) return;
  const lock = await readLock();
  if (!lock || !alive(lock.pid)) return;
  await new Promise((resolve, reject) => {
    // Each independent Pear MSB client drains on shutdown; allow the complete
    // network the same stop budget as a supervised production peer.
    const req = request({ socketPath, path: '/stop', method: 'POST', timeout: 90000 }, res => {
      res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`Stop HTTP ${res.statusCode}`)));
    });
    req.on('timeout', () => req.destroy(new Error('Stop timed out')));
    req.on('error', reject); req.end();
  });
}
async function main() {
  const { values } = parseArgs({ options: { pear: { type: 'boolean' }, stop: { type: 'boolean' }, reset: { type: 'boolean' },
    'interval-ms': { type: 'string', default: '10000' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('node scripts/devnet.mjs [--pear] [--interval-ms 10000] | --stop | --reset\nStarts local test peers; Ctrl-C stops. --reset stops and deletes exactly this repo’s .devnet/.');
    return;
  }
  if (values.stop || values.reset) {
    await stop();
    if (values.reset && await checkRoot()) {
      const lock = await readLock();
      if (lock && alive(lock.pid)) throw new Error('Devnet still running; refusing reset');
      await rm(root, { recursive: true, force: true });
    }
    console.log(values.reset ? 'Devnet reset.' : 'Devnet stopped.'); return;
  }
  await checkRoot(true);
  const existing = await readLock();
  if (existing && alive(existing.pid)) throw new Error('Devnet already running (or PID reused); use --stop');
  if (existing) await unlink(lockPath);
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  let network, control, stopping, startup;
  const shutdown = () => stopping ??= (async () => {
    await startup?.catch(() => {});
    await network?.close();
    await unlink(lockPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
  })();
  const onSignal = () => void shutdown().then(() => control?.close()).catch(error => { console.error(error.message); process.exitCode = 1; });
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
    control = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/stop') { res.writeHead(404); res.end(); return; }
      void shutdown().then(() => { res.end('stopped\n'); control.close(); }).catch(error => {
        res.writeHead(500); res.end(error.message); control.close(); process.exitCode = 1;
      });
    });
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(socketPath, resolve); });
    if (stopping) { control.close(); return; }
    startup = startDevnet({ pear: values.pear, intervalMs: Number(values['interval-ms']) }).then(value => { network = value; });
    await startup;
    if (!stopping) {
      await writeFile(join(root, 'manifest.json'), JSON.stringify(network.manifest, null, 2) + '\n', { mode: 0o600 });
      console.log('\nDEVNET_READY ' + JSON.stringify(network.manifest, null, 2));
      console.log('Local disposable keys only. Instructions: docs/DEVNET.md. Stop: node scripts/devnet.mjs --stop');
    }
  } catch (error) { await shutdown(); control?.close(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
