// A trac address (bech32m, prefix "trac", 32-byte key) → the 64-hex key RESET state uses; null when it is not one.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', BECH32M = 0x2bc830a3, HRP = 'trac';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

export function tracToHex(text) {
  if (typeof text !== 'string' || text.length > 90) return null;
  const s = text === text.toUpperCase() ? text.toLowerCase() : text;   // bech32 allows all-uppercase
  if (s !== s.toLowerCase() || s.lastIndexOf('1') !== HRP.length || !s.startsWith(HRP)) return null;
  const data = [];
  for (const ch of s.slice(HRP.length + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  if (data.length < 7) return null;
  const hrp = [...HRP].map(c => c.charCodeAt(0));
  if (polymod([...hrp.map(c => c >> 5), 0, ...hrp.map(c => c & 31), ...data]) !== BECH32M) return null;
  let acc = 0, bits = 0;
  const bytes = [];
  for (const v of data.slice(0, -6)) {
    acc = ((acc << 5) | v) & 0xfff; bits += 5;
    while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0 || bytes.length !== 32) return null;
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}
