import { createHash } from 'node:crypto';
import { check } from './wire.mjs';

// Any Bitcoin source with the mempool.space REST shape works. The network checks proof of work itself.
export const DEFAULT_HEADER_SOURCE = 'https://mempool.space';
const MAX_BATCH = 20;
const sha256 = data => createHash('sha256').update(data).digest();
export const headerHash = hex => Buffer.from(sha256(sha256(Buffer.from(hex, 'hex')))).reverse().toString('hex');
export const headerPrev = hex => Buffer.from(hex.slice(8, 72), 'hex').reverse().toString('hex');

export function headerSource(url, { timeoutMs = 5000 } = {}) {
  const base = new URL(url);
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password &&
    !base.search && !base.hash && base.pathname === '/', 'Header source must be an HTTP(S) origin');
  check(base.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname),
    'Header source must use HTTPS outside this machine');
  async function text(path, pattern) {
    let value;
    try {
      const response = await fetch(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      check(response.ok, 'status');
      let length = 0; const chunks = [];
      for await (const chunk of response.body ?? []) {
        length += chunk.length; check(length <= 4096, 'size'); chunks.push(chunk);
      }
      value = Buffer.concat(chunks).toString('utf8').trim();
    } catch { throw new Error(`The Bitcoin header source ${base.origin} is unavailable. Try again later or set another source.`); }
    check(pattern.test(value), `The Bitcoin header source ${base.origin} returned an invalid answer.`);
    return value;
  }
  return { origin: base.origin,
    height: async () => Number(await text('/api/blocks/tip/height', /^(0|[1-9][0-9]{0,8})$/)),
    hash: height => text(`/api/block-height/${height}`, /^[0-9a-f]{64}$/),
    header: hash => text(`/api/block/${hash}/header`, /^[0-9a-f]{160}$/) };
}

// Headers after the network's tip. If the source disagrees with that tip, start after the last counted
// (final) height so the batch links to a header the network already has.
export async function newHeaders(source, state) {
  const remote = await source.height();
  if (remote < state.tip.height) return { remote, start: null, headers: [] };
  const start = await source.hash(state.tip.height) === state.tip.hash ? state.tip.height + 1 : state.counted + 1;
  const headers = [];
  let previous = null;
  for (let height = start; height <= Math.min(remote, start + MAX_BATCH - 1); height++) {
    const hash = await source.hash(height), hx = await source.header(hash);
    check(headerHash(hx) === hash && (previous === null || headerPrev(hx) === previous),
      'The Bitcoin header source returned headers that do not fit together. Try again later.');
    headers.push(hx); previous = hash;
  }
  return { remote, start, headers };
}
