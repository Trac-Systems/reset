#!/usr/bin/env node
// Explicit read-only REST utility; never used by runtime peers or automatic tests.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseHeader, targetFromBits, workFor, GENESIS, MAINNET_PARAMS } from '../contract/beacon/bitcoin.js';

const PERIOD = 2016;
export function validateHeight(height) {
  if (!Number.isSafeInteger(height) || height < 0 || height > 0x7fffffff || height % PERIOD !== 0) {
    throw new Error('height must be a nonnegative integer multiple of 2016');
  }
}
export function assembleCheckpoint(height, periods, context) {
  validateHeight(height);
  if (periods.length !== height / PERIOD + 1 || context.length !== Math.min(height + 1, 11)) throw new Error('Incomplete checkpoint context');
  const last = periods.at(-1);
  if (context.at(-1).hash !== last.hash) throw new Error('Checkpoint/context hash mismatch');
  for (let i = 1; i < context.length; i++) if (context[i].prev !== context[i - 1].hash) throw new Error('Disconnected MTP context');
  // Mainnet has fixed difficulty inside each complete period. Esplora has no
  // chainwork field: sum work for EVERY period, including the checkpoint itself.
  let work = 0n;
  for (let i = 0; i < periods.length; i++) work += workFor(periods[i].bits) * (i === periods.length - 1 ? 1n : BigInt(PERIOD));
  return { height, hash: last.hash, bits: last.bits, time: last.time,
    chainwork: work.toString(), times: context.map(header => header.time) };
}
export async function fetchCheckpoint(height, { source = 'https://mempool.space/api', fetchImpl = fetch } = {}) {
  validateHeight(height);
  const base = new URL(source.endsWith('/') ? source : source + '/');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid REST source');
  if (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Remote REST source requires HTTPS');
  async function read(path) {
    const response = await fetchImpl(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`REST ${response.status} at ${path}`);
    let length = 0; const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 16384) throw new Error('Oversized REST response');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const cache = new Map();
  async function at(h) {
    if (cache.has(h)) return cache.get(h);
    const hash = await read(`block-height/${h}`);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid block hash at ${h}`);
    const header = parseHeader(await read(`block/${hash}/header`));
    const target = header && targetFromBits(header.bits);
    if (!header || header.hash !== hash || !target || target > targetFromBits(MAINNET_PARAMS.powLimitBits) || BigInt(`0x${hash}`) > target) throw new Error(`Invalid header/hash/proof at ${h}`);
    if (h === 0 && hash !== GENESIS.hash) throw new Error('Source is not Bitcoin mainnet history');
    cache.set(h, header); return header;
  }
  const checkpoint = await at(height);
  const periods = [];
  // Deliberately sequential, bounded requests. ~2 requests per past period.
  for (let h = 0; h <= height; h += PERIOD) periods.push(await at(h));
  const context = [];
  for (let h = Math.max(0, height - 10); h <= height; h++) context.push(await at(h));
  if (await read(`block-height/${height}`) !== checkpoint.hash) throw new Error('Chain changed during fetch; retry');
  return assembleCheckpoint(height, periods, context);
}
export function constantBlock(checkpoint) {
  const { height, hash, bits, time, chainwork, times } = checkpoint;
  return `export const CHECKPOINT = Object.freeze({\n  height: ${height},\n  hash: '${hash}',\n  bits: 0x${bits.toString(16).padStart(8, '0')},\n  time: ${time},\n  chainwork: '${chainwork}',\n  times: ${JSON.stringify(times)},\n});\n`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { height: { type: 'string' }, source: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('node scripts/checkpoint.mjs --height <multiple-of-2016> [--source https://mempool.space/api]\nPrints a reviewed launch constant; never writes the contract. Reads all difficulty-period starts to compute exact cumulative work.');
    else {
      if (!/^(0|[1-9][0-9]*)$/.test(values.height ?? '')) throw new Error('Provide --height as a canonical integer');
      const checkpoint = await fetchCheckpoint(Number(values.height), { source: values.source });
      process.stdout.write(constantBlock(checkpoint));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
