// trac1… addresses (bech32m, prefix "trac", 32-byte key) ↔ the 64-hex key RESET uses.
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
const hrpExpand = () => { const h = [...HRP].map(c => c.charCodeAt(0)); return [...h.map(c => c >> 5), 0, ...h.map(c => c & 31)]; };

export function tracToHex(text) {
  if (typeof text !== 'string' || text.length > 90) return null;
  const s = text === text.toUpperCase() ? text.toLowerCase() : text;
  if (s !== s.toLowerCase() || s.lastIndexOf('1') !== HRP.length || !s.startsWith(HRP)) return null;
  const data = [];
  for (const ch of s.slice(HRP.length + 1)) { const v = CHARSET.indexOf(ch); if (v < 0) return null; data.push(v); }
  if (data.length < 7 || polymod([...hrpExpand(), ...data]) !== BECH32M) return null;
  let acc = 0, bits = 0; const bytes = [];
  for (const v of data.slice(0, -6)) { acc = ((acc << 5) | v) & 0xfff; bits += 5; while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0 || bytes.length !== 32) return null;
  return Buffer.from(bytes).toString('hex');
}
export function hexToTrac(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) return null;
  const data = []; let acc = 0, bits = 0;
  for (const byte of Buffer.from(hex, 'hex')) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const mod = polymod([...hrpExpand(), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M;
  const checksum = [0, 1, 2, 3, 4, 5].map(i => (mod >>> (5 * (5 - i))) & 31);
  return HRP + '1' + [...data, ...checksum].map(v => CHARSET[v]).join('');
}
// The short label the game shows: trac1 + 4 … last 4.
export const shortTrac = hex => { const t = hexToTrac(hex); return t ? `${t.slice(0, 9)}…${t.slice(-4)}` : hex.slice(0, 8); };
