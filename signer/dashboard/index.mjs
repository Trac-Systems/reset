// Local, read-only earnings dashboard. It never opens the wallet: it knows only a public address and a gateway URL,
// and it never signs or submits anything.
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { History } from './history.mjs';
import { renderPage, renderMain } from './render.mjs';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4747;
export const INTERVAL = 15000;
const ADDRESS = /^[0-9a-f]{64}$/;
const MAX_RESPONSE = 2 * 1024 * 1024;

// Only the public `address` field of the keystore is read; the encrypted part is never used.
export async function keystoreAddress(directory) {
  let file;
  try { file = await open(join(directory, 'keystore.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size > 16384) throw new Error('Keystore is not a small regular file');
    const { address } = JSON.parse(await file.readFile('utf8'));
    return ADDRESS.test(address) ? address : null;
  } finally { await file.close(); }
}

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Gateway answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_RESPONSE) throw new Error('Gateway response too large');
  return JSON.parse(text);
}

function gatewayOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('RESET_GATEWAY_URL must be an http(s) URL');
  return url.href.replace(/\/+$/, '');
}

export async function startDashboard({ port = DEFAULT_PORT, address, directory, gateway, env = process.env,
  interval = INTERVAL, now = Date.now, maxSamples } = {}) {
  const dir = resolve(directory ?? join(homedir(), '.reset-signer'));
  const addr = address || env.RESET_ADDRESS || await keystoreAddress(dir);
  if (addr != null && !ADDRESS.test(addr)) throw new Error('Address must be a 64-character lowercase hex public key');
  // Default: the public RESET mainnet gateway from signer/networks/mainnet.json.
  const mainnet = JSON.parse(await readFile(new URL('../networks/mainnet.json', import.meta.url), 'utf8'));
  const snap = { address: addr ?? null, gateway: gatewayOrigin(gateway || env.RESET_GATEWAY_URL || mainnet.gatewayUrl), state: null, account: null,
    error: null, updatedAt: null, lastBlockAt: null, counted: null, history: null, historyError: null };
  if (snap.address) snap.history = await History.load(dir, snap.address, { maxSamples });

  let running = null;
  async function poll() {
    if (!snap.address || !snap.gateway) return;
    try {
      const [state, account] = await Promise.all([getJSON(`${snap.gateway}/v1/state`), getJSON(`${snap.gateway}/v1/account/${snap.address}`)]);
      if (!Number.isSafeInteger(state?.counted) || !Number.isSafeInteger(state?.tip?.height) || typeof account !== 'object' || !account) {
        throw new Error('Gateway sent an unexpected answer');
      }
      const t = now();
      if (snap.counted === null) {
        const last = snap.history.last;
        snap.lastBlockAt = last && last.h === state.counted ? last.t : null;
      } else if (state.counted > snap.counted) snap.lastBlockAt = t;
      snap.counted = state.counted;
      Object.assign(snap, { state, account, error: null, updatedAt: t });
      if (snap.history.observe({ state, account, now: t })) {
        try { await snap.history.save(); snap.historyError = null; } catch (error) { snap.historyError = error.message; }
      }
    } catch (error) {
      snap.error = error.name === 'TimeoutError' ? 'Gateway timed out' : error.message;
    }
  }
  const refresh = () => (running ??= poll().finally(() => { running = null; }));

  const server = createServer((req, res) => {
    const actual = server.address().port;
    if (![`${HOST}:${actual}`, `localhost:${actual}`].includes(req.headers.host)) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    const path = new URL(req.url, `http://${HOST}`).pathname;
    const nonce = randomBytes(16).toString('base64');
    let body;
    if (path === '/') body = renderPage(snap, nonce, now());
    else if (path === '/fragment') body = renderMain(snap, now());
    else { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await refresh();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, HOST, () => { server.off('error', fail); ok(); }); });
  const timer = setInterval(refresh, interval);
  const url = `http://${HOST}:${server.address().port}`;
  return { url, server, snapshot: () => snap, refresh,
    close: async () => { clearInterval(timer); await running; await new Promise(ok => server.close(ok)); } };
}

export async function cli(args) {
  const { values } = parseArgs({ args, options: { port: { type: 'string' }, address: { type: 'string' },
    directory: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) return { usage: 'dashboard [--port 4747] [--address <public key>] [--directory <dir>]',
    gateway: 'RESET_GATEWAY_URL', address: '--address, RESET_ADDRESS or the keystore address' };
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1..65535');
  const dashboard = await startDashboard({ port, address: values.address, directory: values.directory });
  const snap = dashboard.snapshot();
  return { dashboard: dashboard.url, address: snap.address, gateway: snap.gateway };
}
