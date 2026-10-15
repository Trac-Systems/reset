import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { stableStringify, puzzleBits } from './pow.mjs';

export const HEX32 = /^[0-9a-f]{64}$/;
export const HEX64 = /^[0-9a-f]{128}$/;
export const MOVES = ['header', 'lock', 'unlock', 'withdraw', 'gw_beat', 'guess', 'claim'];
export function check(ok, message) { if (!ok) throw new Error(message); }
export function exactKeys(value, keys, label = 'object') {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','), `Invalid ${label} fields`);
}
export function address(value) { check(typeof value === 'string' && HEX32.test(value), 'Invalid address'); return value; }
export function amount(value) {
  check(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'Amount must be positive integer units');
  return value;
}
export function validateEnvelope(e, solved = false) {
  exactKeys(e, solved ? ['v', 't', 'b', 'h', 'p', 'w'] : ['v', 't', 'b', 'h', 'p'], 'envelope');
  check(e.v === 1 && MOVES.includes(e.t), 'Unsupported move');
  check(Number.isSafeInteger(e.b) && e.b >= 0 && typeof e.h === 'string' && HEX32.test(e.h), 'Invalid block');
  if (solved) check(typeof e.w === 'string' && /^[0-9a-f]{1,32}$/.test(e.w), 'Invalid puzzle nonce');
  if (e.t === 'lock' || e.t === 'unlock') { exactKeys(e.p, ['amount'], 'payload'); amount(e.p.amount); }
  else if (e.t === 'header') {
    exactKeys(e.p, ['hx'], 'payload');
    check(Array.isArray(e.p.hx) && e.p.hx.length >= 1 && e.p.hx.length <= 20 &&
      e.p.hx.every(h => typeof h === 'string' && /^[0-9a-f]{160}$/.test(h)), 'Invalid headers');
  } else if (e.t === 'guess') {
    exactKeys(e.p, ['tb', 'n'], 'payload');
    check(Number.isSafeInteger(e.p.tb) && e.p.tb >= 1 && typeof e.p.n === 'string' && /^[0-9a-f]{8}$/.test(e.p.n), 'Invalid guess');
  } else if (e.t === 'claim') {
    exactKeys(e.p, ['r', 'q'], 'payload');
    check(Number.isSafeInteger(e.p.r) && e.p.r >= 0 && Number.isSafeInteger(e.p.q) && e.p.q >= 0 && e.p.q <= 2000, 'Invalid claim');
  } else exactKeys(e.p, [], 'payload');
  return e;
}
export function requiredBits(state, type) {
  const n = state?.bits?.[type];
  check(Number.isInteger(n) && n >= 0 && n <= 32 &&
    (!['header', 'gw_beat'].includes(type) || n === 0), 'Invalid state difficulty');
  return n;
}
export function preparedMessage(msg, addr) {
  return { dispatch: { type: 'msg', msg, address: address(addr), attachments: [],
    deleted_by: null, reply_to: null, pinned: false, pin_id: null } };
}
export function validatePrepared(prepared, addr, envelope) {
  check(stableStringify(prepared) === stableStringify(preparedMessage(stableStringify(envelope), addr)),
    'Foreign or altered prepared message');
  check(Buffer.byteLength(JSON.stringify(prepared)) <= 8192, 'Message too large');
}
export function validateFresh(packet, now = Date.now()) {
  check(Number.isSafeInteger(packet.issued_at) && Number.isSafeInteger(packet.expires_at) &&
    packet.issued_at <= now && packet.expires_at > now && packet.expires_at > packet.issued_at &&
    packet.expires_at - packet.issued_at <= 120_000, 'Stale or invalid preparation');
}
export function prepareMove(addr, t, p, state, now = Date.now()) {
  const envelope = validateEnvelope({ v: 1, t, b: state.tip.height, h: state.tip.hash, p });
  return { envelope, bits: requiredBits(state, t), prepared: preparedMessage(stableStringify(envelope), addr),
    issued_at: now, expires_at: now + 120_000 };
}
export function verifySignature(signature, message, addr) {
  if (typeof signature !== 'string' || !HEX64.test(signature) || typeof addr !== 'string' || !HEX32.test(addr)) return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(addr, 'hex')]), type: 'spki', format: 'der' });
  return cryptoVerify(null, Buffer.isBuffer(message) ? message : Buffer.from(message), key, Buffer.from(signature, 'hex'));
}
export function verifyMove({ prepared, signature, nonce }, { state } = {}) {
  try {
    check(typeof nonce === 'string' && HEX32.test(nonce), 'Invalid signature nonce');
    const addr = address(prepared.dispatch.address);
    const e = validateEnvelope(JSON.parse(prepared.dispatch.msg), true);
    validatePrepared(prepared, addr, e);
    if (state) {
      // A signer only prepares at the latest observed tip. Gateways may accept tip-1/tip-2 too.
      check(e.b === state.tip.height && e.h === state.tip.hash, 'Stale or foreign block');
      check(puzzleBits(addr, e) >= requiredBits(state, e.t), 'Insufficient puzzle');
    }
    return verifySignature(signature, JSON.stringify(prepared) + nonce, addr);
  } catch { return false; }
}
export function transferCommand(to, units) {
  const command = { type: 'transfer', value: { to: address(to), amount: amount(units) } };
  check(Buffer.byteLength(JSON.stringify(command)) <= 4096, 'Transfer command too large');
  return command;
}
export const commandHash = command => Buffer.from(blake3(Buffer.from(JSON.stringify(command)))).toString('hex');
export function validateContext(context) {
  exactKeys(context, ['networkId', 'txv', 'incomingWritingKey', 'subnetBootstrap', 'msbBootstrap'], 'transfer context');
  check(Number.isInteger(context.networkId) && context.networkId >= 1 && context.networkId <= 0xffffffff, 'Invalid networkId');
  for (const k of ['txv', 'incomingWritingKey', 'subnetBootstrap', 'msbBootstrap']) {
    check(typeof context[k] === 'string' && HEX32.test(context[k]), `Invalid ${k}`);
  }
}
export function transactionHash(context, contentHash, nonce) {
  validateContext(context);
  check(typeof nonce === 'string' && HEX32.test(nonce) && typeof contentHash === 'string' && HEX32.test(contentHash), 'Invalid transaction hash inputs');
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
  // trac-msb createMessage / trac-peer Protocol.generateTx, operation TX = 12.
  const bytes = Buffer.concat([u32(context.networkId), ...[context.txv, context.incomingWritingKey,
    contentHash, context.subnetBootstrap, context.msbBootstrap, nonce].map(h => Buffer.from(h, 'hex')), u32(12)]);
  return Buffer.from(blake3(bytes)).toString('hex');
}
export function prepareTransfer({ address: addr, to, amount: units }, context, nonce, now = Date.now()) {
  const prepared_command = transferCommand(to, units);
  const command_hash = commandHash(prepared_command);
  return { address: address(addr), to, amount: units, prepared_command, command_hash, context,
    nonce, tx: transactionHash(context, command_hash, nonce), issued_at: now, expires_at: now + 120_000 };
}
export function validateTransfer(packet, { context, now = Date.now() } = {}) {
  exactKeys(packet, ['address', 'to', 'amount', 'prepared_command', 'command_hash', 'context', 'nonce', 'tx', 'issued_at', 'expires_at'], 'transfer');
  address(packet.address);
  validateFresh(packet, now);
  validateContext(packet.context);
  check(context && ['networkId', 'incomingWritingKey', 'subnetBootstrap', 'msbBootstrap'].every(k =>
    context[k] === packet.context[k]), 'Foreign transfer context; supply locally trusted context');
  const command = transferCommand(packet.to, packet.amount);
  check(JSON.stringify(packet.prepared_command) === JSON.stringify(command), 'Transfer command mismatch');
  const hash = commandHash(command);
  check(hash === packet.command_hash, 'Transfer command hash mismatch');
  check(transactionHash(packet.context, hash, packet.nonce) === packet.tx, 'Transfer transaction hash mismatch');
  return command;
}
export function challengeMessage(challenge) {
  exactKeys(challenge, ['v', 'domain', 'audience', 'address', 'nonce', 'issued_at', 'expires_at'], 'challenge');
  check(challenge.v === 1 && challenge.domain === 'reset-mcp-login', 'Invalid challenge domain');
  address(challenge.address);
  check(typeof challenge.nonce === 'string' && HEX32.test(challenge.nonce), 'Invalid challenge nonce');
  check(typeof challenge.audience === 'string' && challenge.audience.length <= 256 &&
    new URL(challenge.audience).origin === challenge.audience, 'Invalid challenge audience');
  return `RESET MCP LOGIN\n${stableStringify(challenge)}`;
}
