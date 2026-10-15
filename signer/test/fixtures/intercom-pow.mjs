// Extracted verbatim from the repository's Intercom reference.
import crypto from 'node:crypto';

const stableStringify = (value) => {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const sha256Hex = (input) => crypto.createHash('sha256').update(input).digest('hex');

const countLeadingZeroBits = (hex) => {
  let bits = 0;
  for (let i = 0; i < hex.length; i += 1) {
    const nibble = Number.parseInt(hex[i], 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    // Count leading zeros in this nibble.
    for (let mask = 8; mask > 0; mask >>= 1) {
      if (nibble & mask) return bits;
      bits += 1;
    }
  }
  return bits;
};

class Puzzle {
  _powBase(payload, nonce) {
    return stableStringify({
      id: payload?.id ?? null,
      channel: payload?.channel ?? null,
      from: payload?.from ?? null,
      origin: payload?.origin ?? null,
      message: payload?.message ?? null,
      ts: payload?.ts ?? null,
      nonce,
    });
  }
}

export { stableStringify, sha256Hex, countLeadingZeroBits, Puzzle };
