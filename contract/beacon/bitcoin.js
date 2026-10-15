import crypto from 'crypto';
import b4a from 'b4a';

export const MAINNET_PARAMS = Object.freeze({ powLimitBits: 0x1d00ffff, interval: 2016, timespan: 1209600, retarget: true, confirmations: 6, branchDepth: 12 });
export const REGTEST_PARAMS = Object.freeze({ ...MAINNET_PARAMS, powLimitBits: 0x207fffff, retarget: false });
export const GENESIS = Object.freeze({ height: 0, hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', bits: 0x1d00ffff, time: 1231006505, chainwork: '4295032833' });
export function targetFromBits(bits) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) return null;
  const size = bits >>> 24;
  const word = bits & 0x007fffff;
  if (!word || (bits & 0x00800000) || size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32)) return null;
  const target = size <= 3 ? BigInt(word) >> BigInt(8 * (3 - size)) : BigInt(word) << BigInt(8 * (size - 3));
  return target > 0n && target < 1n << 256n ? target : null;
}
export function bitsFromTarget(target) {
  let size = Math.ceil(target.toString(16).length / 2);
  let word = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)));
  if (word & 0x00800000) { word >>= 8; size++; }
  return (size * 0x1000000 + word) >>> 0;
}
export const workFor = bits => (1n << 256n) / (targetFromBits(bits) + 1n);
export function retargetBits(bits, elapsed, params = MAINNET_PARAMS) {
  const span = Math.max(params.timespan / 4, Math.min(params.timespan * 4, elapsed));
  const target = targetFromBits(bits) * BigInt(span) / BigInt(params.timespan);
  const limit = targetFromBits(params.powLimitBits);
  return bitsFromTarget(target > limit ? limit : target);
}
export function parseHeader(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{160}$/.test(hex)) return null;
  const raw = b4a.from(hex, 'hex');
  const digest = crypto.createHash('sha256').update(crypto.createHash('sha256').update(raw).digest()).digest();
  return { hash: b4a.toString(b4a.from(digest).reverse(), 'hex'), prev: b4a.toString(b4a.from(raw.subarray(4, 36)).reverse(), 'hex'),
    time: raw.readUInt32LE(68), bits: raw.readUInt32LE(72), raw: hex };
}

// Slot interface: ingest, tip, hashAt, countedHeight, onCounted.
// All state is JSON serializable. A batch either succeeds completely or changes nothing.
export class BitcoinBeacon {
  constructor({ checkpoint = GENESIS, params = MAINNET_PARAMS, state = null } = {}) {
    this.params = { ...params };
    this.callbacks = [];
    if (state) this.state = JSON.parse(JSON.stringify(state));
    else {
      const record = { ...checkpoint, prev: null, poster: null, periodTime: checkpoint.time,
        times: checkpoint.times ?? [checkpoint.time] };
      this.state = { records: { [record.hash]: record }, best: record.hash,
        counted: record.height, hashes: { [record.height]: record.hash } };
    }
  }
  tip() { const r = this.state.records[this.state.best]; return { height: r.height, hash: r.hash }; }
  hashAt(height) { return this.state.hashes[height] ?? null; }
  countedHeight() { return this.state.counted; }
  onCounted(cb) { this.callbacks.push(cb); return () => { this.callbacks = this.callbacks.filter(x => x !== cb); }; }
  exportState({ compact = false } = {}) {
    const copy = JSON.parse(JSON.stringify(this.state));
    if (compact) for (const h of Object.keys(copy.hashes)) if (Number(h) < this.tip().height - this.params.interval) delete copy.hashes[h];
    return copy;
  }
  ingest(headers, poster) {
    if (!Array.isArray(headers) || headers.length < 1 || headers.length > 20) return { error: 'header_batch' };
    const candidate = new BitcoinBeacon({ params: this.params, state: this.state });
    const counted = [];
    let previous = null;
    let accepted = 0;
    for (const hex of headers) {
      const h = parseHeader(hex);
      if (!h || (previous !== null && h.prev !== previous)) return { error: 'header_link' };
      previous = h.hash;
      if (candidate.state.records[h.hash]) continue;
      const result = candidate.add(h, poster);
      if (result.error) return result;
      accepted++;
      counted.push(...result.counted);
    }
    candidate.prune();
    this.state = candidate.state;
    for (const r of counted) for (const cb of this.callbacks) cb(r);
    return { accepted, counted };
  }
  add(h, poster) {
    const s = this.state;
    const parent = s.records[h.prev];
    if (!parent) return { error: 'header_parent' };
    const height = parent.height + 1;
    // Even a low-work branch may not fork behind the final counted boundary.
    let ancestor = parent;
    while (ancestor && ancestor.height > s.counted) ancestor = s.records[ancestor.prev];
    if (height <= s.counted || !ancestor || ancestor.hash !== s.hashes[s.counted]) return { error: 'header_final' };
    const target = targetFromBits(h.bits);
    if (!target || target > targetFromBits(this.params.powLimitBits) || BigInt(`0x${h.hash}`) > target) return { error: 'header_pow' };
    const boundary = height % this.params.interval === 0;
    const expected = boundary && this.params.retarget ? retargetBits(parent.bits, parent.time - parent.periodTime, this.params) : parent.bits;
    if (h.bits !== expected) return { error: 'header_bits' };
    const times = [...parent.times].sort((a, b) => a - b);
    if (h.time <= times[Math.floor(times.length / 2)]) return { error: 'header_time' };
    const record = { ...h, height, poster, periodTime: boundary ? h.time : parent.periodTime,
      times: [...parent.times, h.time].slice(-11), chainwork: (BigInt(parent.chainwork) + workFor(h.bits)).toString() };
    s.records[h.hash] = record;
    const counted = [];
    if (BigInt(record.chainwork) > BigInt(s.records[s.best].chainwork)) {
      const oldTip = this.tip().height;
      s.best = h.hash;
      let r = record;
      while (r.height > s.counted) { s.hashes[r.height] = r.hash; r = s.records[r.prev]; }
      for (let i = height + 1; i <= oldTip; i++) delete s.hashes[i];
      const next = height - this.params.confirmations + 1;
      while (s.counted < next) { s.counted++; counted.push({ ...s.records[s.hashes[s.counted]] }); }
    }
    return { counted };
  }
  prune() {
    const tip = this.tip().height;
    const window = Math.max(this.params.interval, this.params.branchDepth, this.params.confirmations);
    for (const [hash, r] of Object.entries(this.state.records)) {
      if (r.height <= tip - window ||
          (this.state.hashes[r.height] !== hash && r.height < tip - this.params.branchDepth)) delete this.state.records[hash];
    }
  }
}
