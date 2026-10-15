import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../../', import.meta.url));

// All children are owned by this fixture, never identified by a saved/reused PID.
export async function startProcess(entry, args, { prefix, env = {}, expectExit = false, onError = () => {} } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.RESET_SIGNER_PASSWORD;
  delete childEnv.RESET_SIGNER_MNEMONIC;
  const child = spawn(process.execPath, [entry, ...args], { cwd,
    env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '', pending = '', nextId = 0, stopping = false, finished = false;
  const requests = new Map();
  let readyResolve, readyReject, exitResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => { exitResolve = resolve; });
  const timer = setTimeout(() => readyReject(new Error(`Startup timed out: ${entry}\n${log}`)), 90000);
  function fail(error) {
    readyReject(error);
    for (const { reject, timer } of requests.values()) { clearTimeout(timer); reject(error); }
    requests.clear();
    if (!stopping) onError(error);
  }
  child.once('error', fail);
  child.once('exit', (code, signal) => {
    finished = true; clearTimeout(timer);
    const error = new Error(`${entry} exited (${code ?? signal})\n${log}`);
    if (expectExit && code === 0) stopping = true;
    fail(error); exitResolve({ code, signal });
  });
  child.stdin.on('error', error => { if (!stopping) fail(error); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-24000); });
  child.stdout.on('data', chunk => {
    log = (log + chunk).slice(-24000); pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (line.startsWith(prefix)) {
        try { clearTimeout(timer); readyResolve(JSON.parse(line.slice(prefix.length))); }
        catch (error) { fail(error); }
      }
      if (line.startsWith('DEVNET_REPLY ')) {
        const reply = JSON.parse(line.slice(13)); const request = requests.get(reply.id);
        if (!request) continue;
        requests.delete(reply.id); clearTimeout(request.timer);
        if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply.value);
      }
    }
  });
  const close = async () => {
    stopping = true;
    if (finished) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 85000);
    try { await exited; } finally { clearTimeout(force); }
  };
  const rpc = (command, args = {}) => new Promise((resolve, reject) => {
    if (finished || stopping) { reject(new Error('Peer process is stopped')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Timed out: ${command}\n${log}`)); }, 95000);
    requests.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, command, args }) + '\n');
  });
  try { return { info: await ready, child, rpc, close, exited, logs: () => log }; }
  catch (error) { await close(); throw error; }
}

export async function startPear(configFile, role, pearDirectory, options = {}) {
  await mkdir(pearDirectory, { recursive: true, mode: 0o700 });
  const args = ['--role', role, '--config', resolve(configFile), '--devnet-control', '1'];
  if (role === 'gateway') args.push('--gateway', '1');
  if (role === 'relay') args.push('--blind-relay-serve', '1');
  if (options.adminCommand) args.push('--admin-command', options.adminCommand);
  if (options.gatewaysFile) args.push('--gateways-file', options.gatewaysFile);
  return startProcess('scripts/pear-runner.mjs', args, { ...options, prefix: 'PEER_READY ',
    env: { HOME: pearDirectory, XDG_CONFIG_HOME: resolve(pearDirectory, 'config'),
      XDG_DATA_HOME: resolve(pearDirectory, 'data'), MAYHEM_INTERCOM_LEGACY_PEAR_RUN: '0' } });
}
