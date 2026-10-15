import { createHash } from 'node:crypto';

// Byte-for-byte semantics of reference/intercom-pow.mjs (including UTF-16 key sort).
export const stableStringify = (value) => {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};
export const sha256Hex = input => createHash('sha256').update(input).digest('hex');
export function countLeadingZeroBits(hex) {
  let bits = 0;
  for (let i = 0; i < hex.length; i += 1) {
    const nibble = Number.parseInt(hex[i], 16);
    if (nibble === 0) { bits += 4; continue; }
    for (let mask = 8; mask > 0; mask >>= 1) {
      if (nibble & mask) return bits;
      bits += 1;
    }
  }
  return bits;
}
export const puzzleBase = (address, { b, h, p, t, v, w }) =>
  stableStringify({ a: address, b, h, p, t, v, w });
export const puzzleBits = (address, envelope) => countLeadingZeroBits(sha256Hex(puzzleBase(address, envelope)));

export async function solve(address, envelope, bits, { maxAttempts = 10_000_000, signal, onProgress } = {}) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error('Invalid puzzle bits');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid attempt limit');
  for (let i = 0; i < maxAttempts; i++) {
    if (i % 4096 === 0) {
      signal?.throwIfAborted();
      await onProgress?.(i, maxAttempts);
      await new Promise(resolve => setImmediate(resolve));
      signal?.throwIfAborted();
    }
    const solved = { ...envelope, w: i.toString(16) };
    if (puzzleBits(address, solved) >= bits) return solved;
  }
  throw new Error('Puzzle attempt limit reached; prepare again or raise maxAttempts');
}
