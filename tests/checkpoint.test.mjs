import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fetchCheckpoint, assembleCheckpoint, constantBlock } from '../scripts/checkpoint.mjs';
import { parseHeader, workFor, GENESIS, BitcoinBeacon } from '../contract/beacon/bitcoin.js';
const genesisRaw = '01000000' + '00'.repeat(32) + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' + '29ab5f49ffff001d1dac2b7c';

test('checkpoint REST uses raw proof, mainnet genesis and exact inclusive chainwork', async t => {
  let mode = 'valid', reads = 0;
  const server = createServer((req, res) => {
    if (mode === 'failed') { res.writeHead(503); res.end('no'); return; }
    if (req.url === '/api/block-height/0') {
      reads++;
      res.end(mode === 'reorg' && reads > 1 ? 'ff'.repeat(32) : GENESIS.hash);
    } else if (req.url === `/api/block/${GENESIS.hash}/header`) res.end(mode === 'bad' ? '00'.repeat(80) : mode === 'large' ? 'a'.repeat(17000) : genesisRaw);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const source = `http://127.0.0.1:${server.address().port}/api`;
  assert.deepEqual(await fetchCheckpoint(0, { source }), { ...GENESIS, times: [GENESIS.time] });
  for (const [next, error] of [['bad', /Invalid header/], ['large', /Oversized/], ['failed', /503/], ['reorg', /Chain changed/]]) {
    mode = next; reads = 0; await assert.rejects(fetchCheckpoint(0, { source }), error);
  }
  for (const height of [-2016, 1, 2016.5, NaN]) await assert.rejects(fetchCheckpoint(height, { source }), /multiple of 2016/);
});

test('checkpoint sums changing period work and supplies eleven rolling MTP times to the beacon', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/mainnet-retarget.json', import.meta.url), 'utf8'));
  const first = parseHeader(fixture.headers[0]);
  const boundary = parseHeader(fixture.headers[2016]);
  // Mainnet's first 16 periods all used 0x1d00ffff; the fixture crosses the first change.
  const periods = [...Array(16).fill(first), boundary];
  const context = fixture.headers.slice(2006, 2017).map(parseHeader);
  const checkpoint = assembleCheckpoint(32256, periods, context);
  assert.equal(checkpoint.chainwork, (32256n * workFor(first.bits) + workFor(boundary.bits)).toString());
  assert.deepEqual(checkpoint.times, context.map(h => h.time));
  const beacon = new BitcoinBeacon({ checkpoint });
  assert.equal(beacon.ingest([fixture.headers[2017]], 'aa'.repeat(32)).accepted, 1);
  assert.equal(beacon.exportState().records[boundary.hash].times.length, 11);
  const constant = constantBlock(checkpoint);
  assert.match(constant, /bits: 0x1d00d86a/);
  const imported = await import('data:text/javascript,' + encodeURIComponent(constant));
  assert.deepEqual(imported.CHECKPOINT, checkpoint);
  const broken = structuredClone(context); broken[1].prev = 'ff'.repeat(32);
  assert.throws(() => assembleCheckpoint(32256, periods, broken), /Disconnected/);
  assert.throws(() => assembleCheckpoint(32256, periods.slice(1), context), /Incomplete/);
});
