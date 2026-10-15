import { randomBytes } from 'node:crypto';
import { publicAddress } from './keystore.mjs';
import { stableStringify, solve } from './pow.mjs';
import { check, exactKeys, validateEnvelope, validateFresh, validatePrepared, requiredBits,
  preparedMessage, validateTransfer, challengeMessage, verifySignature, verifyMove } from './wire.mjs';
export { init, importMnemonic, getAddress, unlock, createWallet, publicAddress, wipeWallet, defaultDirectory } from './keystore.mjs';
export { verifyMove, verifySignature } from './wire.mjs';

export async function signAndSolve(wallet, packet, { state, now = Date.now, maxAttempts, signal, onProgress, refreshState } = {}) {
  // Clone before yielding to prevent concurrent caller mutation during puzzle work.
  packet = structuredClone(packet); state = structuredClone(state);
  exactKeys(packet, ['envelope', 'bits', 'prepared', 'issued_at', 'expires_at'], 'move preparation');
  validateFresh(packet, now());
  const e = validateEnvelope(packet.envelope);
  check(state && e.b === state.tip?.height && e.h === state.tip?.hash, 'Stale or foreign block; supply a current state snapshot');
  check(packet.bits === requiredBits(state, e.t), 'Puzzle difficulty mismatch');
  const addr = publicAddress(wallet);
  validatePrepared(packet.prepared, addr, e);
  const solved = await solve(addr, e, packet.bits, { maxAttempts, signal, onProgress });
  if (refreshState) {
    const current = await refreshState();
    check(current?.tip?.height === e.b && current?.tip?.hash === e.h && requiredBits(current, e.t) === packet.bits,
      'State changed during puzzle work; try again with fresh state');
  }
  signal?.throwIfAborted();
  validateFresh(packet, now());
  const prepared = preparedMessage(stableStringify(solved), addr);
  validatePrepared(prepared, addr, solved);
  const nonce = randomBytes(32).toString('hex');
  const signature = Buffer.from(wallet.sign(Buffer.from(JSON.stringify(prepared) + nonce))).toString('hex');
  return { prepared, signature, nonce };
}
export function signTransfer(wallet, packet, options) {
  const prepared_command = validateTransfer(packet, options);
  const addr = publicAddress(wallet);
  check(packet.address === addr, 'Foreign transfer address');
  const signature = Buffer.from(wallet.sign(Buffer.from(packet.tx, 'hex'))).toString('hex');
  return { tx: packet.tx, prepared_command, address: addr, signature, nonce: packet.nonce };
}
export function signChallenge(wallet, challenge, { audience, now = Date.now() } = {}) {
  const message = challengeMessage(challenge);
  validateFresh(challenge, now);
  check(challenge.address === publicAddress(wallet) && challenge.audience === audience, 'Foreign login challenge');
  return { challenge, signature: Buffer.from(wallet.sign(Buffer.from(message))).toString('hex') };
}
export function verify(input, options = {}) {
  if (input.prepared) return verifyMove(input, options);
  if (input.challenge) {
    try {
      validateFresh(input.challenge, options.now);
      check(input.challenge.audience === options.audience, 'Foreign login challenge');
      return verifySignature(input.signature, challengeMessage(input.challenge), input.challenge.address);
    } catch { return false; }
  }
  if (input.transfer) {
    try {
      validateTransfer(input.transfer, options);
      return verifySignature(input.signature, Buffer.from(input.transfer.tx, 'hex'), input.transfer.address);
    } catch { return false; }
  }
  return false;
}
