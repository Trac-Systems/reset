// Explicit maintenance command; never imported by the test suite.
import fs from 'node:fs/promises';
import { parseHeader, workFor } from '../contract/beacon/bitcoin.js';
const start = 30240;
const end = 32262;
const blocks = new Map();
const pending = Array.from({ length: Math.ceil((end - start + 11) / 10) }, (_, i) => end - i * 10);
await Promise.all(Array.from({ length: 4 }, async () => {
  while (pending.length) {
    const height = pending.shift();
    let rows;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(`https://mempool.space/api/blocks/${height}`, { signal: AbortSignal.timeout(20000) });
      if (response.ok) { rows = await response.json(); break; }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!rows) throw new Error(`Could not fetch ${height}`);
    for (const b of rows) blocks.set(b.height, b);
    if (pending.length % 20 === 0) console.log(`Remaining pages: ${pending.length}`);
  }
}));
const rows = [...blocks.values()].filter(b => b.height >= start && b.height <= end).sort((a, b) => a.height - b.height);
if (rows.length !== end - start + 1) throw new Error('Incomplete fixture');
const headers = rows.map(b => {
  const raw = Buffer.alloc(80);
  raw.writeInt32LE(b.version, 0);
  Buffer.from(b.previousblockhash, 'hex').reverse().copy(raw, 4);
  Buffer.from(b.merkle_root, 'hex').reverse().copy(raw, 36);
  raw.writeUInt32LE(b.timestamp, 68); raw.writeUInt32LE(b.bits, 72); raw.writeUInt32LE(b.nonce, 76);
  const hx = raw.toString('hex');
  if (parseHeader(hx).hash !== b.id) throw new Error(`Hash mismatch at ${b.height}`);
  return hx;
});
// Cross-check the serialized boundary against the raw-header REST endpoint.
const boundary = rows.find(b => b.height === 32256);
const response = await fetch(`https://mempool.space/api/block/${boundary.id}/header`);
if (!response.ok || (await response.text()).trim() !== headers[32256 - start]) throw new Error('Raw header mismatch');
const first = rows[0];
const fixture = { source: 'https://mempool.space/api/blocks/:height (header fields); boundary cross-checked with /api/block/:hash/header',
  checkpoint: { height: start, hash: first.id, time: first.timestamp, bits: first.bits,
    chainwork: (workFor(first.bits) * BigInt(start + 1)).toString() }, headers };
await fs.writeFile(new URL('../tests/fixtures/mainnet-retarget.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
console.log(`Saved ${headers.length} verified mainnet headers`);
