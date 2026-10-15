import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { puzzleBase, sha256Hex, countLeadingZeroBits } from '../lib/pow.mjs';
const addr = 'ab'.repeat(32);
const envelope = { v: 1, t: 'lock', b: 100, h: 'cd'.repeat(32), p: { amount: '100' } };
const count = 200000;
function run(n) {
  let checksum = 0;
  for (let i = 0; i < n; i++) checksum += countLeadingZeroBits(sha256Hex(puzzleBase(addr, { ...envelope, w: i.toString(16) })));
  return checksum;
}
run(10000);
const start = performance.now(); const checksum = run(count); const elapsed = performance.now() - start;
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0].model, attempts: count, elapsed_ms: Math.round(elapsed), hashes_per_second: Math.round(count * 1000 / elapsed), checksum }));
