import crypto from 'crypto';
import b4a from 'b4a';
import { stableJSON, parseJSON } from './json.js';
import { MINE_DEFAULTS, LOTTERY_DEFAULTS, validGameParam } from './games.js';
export * from './games.js';
export { stableJSON, stableStringify, parseJSON } from './json.js';

export const ADDRESS = /^[0-9a-f]{64}$/;
export const TYPES = ['header', 'lock', 'unlock', 'withdraw', 'gw_beat', 'guess', 'claim'];
export const PUZZLE_TYPES = ['lock', 'unlock', 'withdraw', 'guess', 'claim'];
export const DEFAULT_PARAMS = Object.freeze({ move_bits: 12, capacity: 600, per_address: 6, exit_wait: 144, ...LOTTERY_DEFAULTS, ...MINE_DEFAULTS });
export const minimumBits = (t, params) => t === 'guess' ? params.guess_bits : params.move_bits;
export const MAX_AMOUNT_LENGTH = 78;
export const MAX_EXIT_RECORDS = 256;
export const ISSUANCE = 312500000n;
export const GATEWAY_SHARE = 3125000n;
export const sha256Hex = input => crypto.createHash('sha256').update(input).digest('hex');
export function countLeadingZeroBits(hex) {
  let bits = 0;
  for (const c of hex) {
    const n = Number.parseInt(c, 16);
    if (n === 0) { bits += 4; continue; }
    for (let mask = 8; mask > 0; mask >>= 1) {
      if (n & mask) return bits;
      bits++;
    }
  }
  return bits;
}
export const exactKeys = (obj, keys) => obj !== null && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(k => Object.hasOwn(obj, k));
export function parseAmount(s, positive = false) {
  if (typeof s !== 'string' || s.length > MAX_AMOUNT_LENGTH || !/^(0|[1-9][0-9]*)$/.test(s)) return null;
  const n = BigInt(s);
  return positive && n === 0n ? null : n;
}
export function parseCoins(s) {
  if (typeof s !== 'string' || s.length > MAX_AMOUNT_LENGTH || !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(s)) return null;
  const [whole, fraction = ''] = s.split('.');
  return parseAmount((BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))).toString());
}
export const formatCoins = n => `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, '0')}`;
export function parseEnvelope(text) {
  const e = parseJSON(text);
  if (!exactKeys(e, ['v', 't', 'b', 'h', 'p', 'w']) || e.v !== 1 || !TYPES.includes(e.t) ||
      !Number.isSafeInteger(e.b) || e.b < 0 || typeof e.h !== 'string' || !ADDRESS.test(e.h) ||
      typeof e.w !== 'string' || !/^[0-9a-f]{1,32}$/.test(e.w)) return { error: 'envelope' };
  if (e.t === 'header') {
    if (!exactKeys(e.p, ['hx']) || !Array.isArray(e.p.hx) || e.p.hx.length < 1 || e.p.hx.length > 20 ||
        !e.p.hx.every(h => typeof h === 'string' && /^[0-9a-f]{160}$/.test(h))) return { error: 'payload' };
  } else if (e.t === 'lock' || e.t === 'unlock') {
    if (!exactKeys(e.p, ['amount']) || parseAmount(e.p.amount, true) === null) return { error: 'amount' };
  } else if (e.t === 'guess') {
    if (!exactKeys(e.p, ['tb', 'n']) || !Number.isSafeInteger(e.p.tb) || e.p.tb < 1 ||
        typeof e.p.n !== 'string' || !/^[0-9a-f]{8}$/.test(e.p.n)) return { error: 'payload' };
  } else if (e.t === 'claim') {
    if (!exactKeys(e.p, ['r', 'q']) || !Number.isSafeInteger(e.p.r) || e.p.r < 0 ||
        !Number.isSafeInteger(e.p.q) || e.p.q < 0 || e.p.q > 2000) return { error: 'payload' };
  } else if (!exactKeys(e.p, [])) return { error: 'payload' };
  if (text !== stableJSON(e)) return { error: 'canonical' };
  return { envelope: e };
}
export const puzzleHash = (a, e) => sha256Hex(stableJSON({ a, b: e.b, h: e.h, p: e.p, t: e.t, v: e.v, w: e.w }));
export const checkPuzzle = (a, e, bits) => countLeadingZeroBits(puzzleHash(a, e)) >= bits;
export const fresh = (e, tip, hash) => e.b <= tip && e.b >= tip - 2 && e.h === hash;
export const adjustDifficulty = (current, minimum, moves, capacity) =>
  Math.max(minimum, Math.min(32, current + (moves * 2 > capacity ? 1 : moves * 8 < capacity ? -1 : 0)));
export function validParam(key, value) {
  if (validGameParam(key, value)) return true;
  if (!Number.isSafeInteger(value)) return false;
  return key === 'move_bits' ? value >= 0 && value <= 32 :
    key === 'capacity' ? value >= 1 && value <= 100000 :
    key === 'per_address' ? value >= 1 && value <= 100000 :
    key === 'exit_wait' ? value >= 1 && value <= 1000000 : false;
}
export function checkMove(e, address, view) {
  if (typeof address !== 'string' || !ADDRESS.test(address)) return 'address';
  if (!fresh(e, view.tip, view.hash)) return 'stale';
  if (e.t === 'header') return null;
  if (e.t === 'gw_beat') return !view.gateway?.registered ? 'gateway' :
    view.gateway.last_beat === view.tip ? 'already_beaten' : null;
  if (!checkPuzzle(address, e, view.bits)) return 'puzzle';
  if (view.load >= view.params.capacity) return 'capacity';
  if (view.addressLoad >= view.params.per_address) return 'rate';
  if (e.t === 'lock' && BigInt(view.balance) < BigInt(e.p.amount)) return 'balance';
  if (e.t === 'unlock' && BigInt(view.deposit) < BigInt(e.p.amount)) return 'deposit';
  if (e.t === 'unlock' && view.exits.length >= MAX_EXIT_RECORDS &&
      !view.exits.some(x => x.release === view.counted + view.params.exit_wait)) return 'exit_capacity';
  if (e.t === 'claim' && view.exits.length > MAX_EXIT_RECORDS) return 'exit_capacity';
  if (e.t === 'withdraw' && !view.exits.some(x => x.release <= view.counted)) return 'exit_wait';
  return null;
}
export function payout(reserve, gateways, poster) {
  const active = [...new Set(gateways)].sort();
  let game = ISSUANCE - GATEWAY_SHARE;
  let nextReserve = reserve;
  const credits = {};
  let released = 0n;
  if (active.length < 3) nextReserve += GATEWAY_SHARE;
  else {
    const n = BigInt(active.length);
    const each = 2812500n / n;
    game += 2812500n % n;
    const available = reserve < GATEWAY_SHARE ? reserve : GATEWAY_SHARE;
    const eachRelease = available / n;
    released = eachRelease * n;
    nextReserve -= released;
    for (const a of active) credits[a] = (each + eachRelease).toString();
    credits[poster] = (BigInt(credits[poster] ?? '0') + 312500n).toString();
  }
  return { game: game.toString(), reserve: nextReserve.toString(), released: released.toString(), credits };
}
export function validatePrepared(body, maxBytes = 8192) {
  if (!exactKeys(body, ['prepared', 'signature', 'nonce']) || !exactKeys(body.prepared, ['dispatch'])) return 'prepared';
  const d = body.prepared.dispatch;
  if (!exactKeys(d, ['type', 'msg', 'address', 'attachments', 'deleted_by', 'reply_to', 'pinned', 'pin_id']) ||
      d.type !== 'msg' || typeof d.msg !== 'string' || typeof d.address !== 'string' || !ADDRESS.test(d.address) ||
      !Array.isArray(d.attachments) || d.attachments.length !== 0 || d.deleted_by !== null || d.reply_to !== null ||
      d.pinned !== false || d.pin_id !== null) return 'prepared';
  if (typeof body.signature !== 'string' || !/^[0-9a-f]{128}$/.test(body.signature) ||
      typeof body.nonce !== 'string' || !/^(?:[0-9a-f]{2}){1,128}$/.test(body.nonce)) return 'signature';
  const op = { type: 'msg', value: body.prepared, hash: body.signature, nonce: body.nonce };
  return b4a.byteLength(JSON.stringify(op)) > maxBytes ? 'size' : null;
}
