import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, chmod, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { init, importMnemonic, getAddress, unlock, createWallet, publicAddress, wipeWallet, signAndSolve, signTransfer, signChallenge, verify } from '../lib/index.mjs';
import { prepareMove, prepareTransfer, verifySignature, transactionHash, challengeMessage } from '../lib/wire.mjs';
import { stableStringify, sha256Hex, countLeadingZeroBits, solve, puzzleBits } from '../lib/pow.mjs';
import { Puzzle, stableStringify as referenceStable } from './fixtures/intercom-pow.mjs';
import { temp, state, context, password } from './helpers.mjs';
const exec = promisify(execFile);
const peerRequire = createRequire(new URL('../../node_modules/trac-peer/package.json', import.meta.url));
const { default: PeerWallet } = await import(new URL('../../node_modules/trac-peer/src/wallet.js', import.meta.url));
const { default: Protocol } = await import(new URL('../../node_modules/trac-peer/src/artifacts/protocol.js', import.meta.url));
const { ProtocolApi } = await import(new URL('../../node_modules/trac-peer/src/api.js', import.meta.url));
const { createHash: peerHash } = await import(new URL('../../node_modules/trac-peer/src/utils/types.js', import.meta.url));

test('lottery and Mine moves prepare, solve, sign and reject malformed payloads locally', async t => {
  const wallet = await createWallet(); t.after(() => wipeWallet(wallet));
  const address = publicAddress(wallet), snapshot = { ...state, bits: { ...state.bits, guess: 8, claim: 8 } };
  for (const [type, payload] of [['guess', { tb: 103, n: 'ffffffff' }], ['claim', { r: 16, q: 1000 }]]) {
    const packet = prepareMove(address, type, payload, snapshot);
    const signed = await signAndSolve(wallet, packet, { state: snapshot });
    assert.equal(verify(signed, { state: snapshot }), true);
    assert.deepEqual(JSON.parse(signed.prepared.dispatch.msg).p, payload);
  }
  for (const [type, payload] of [['guess', { tb: 103, n: 'FFFFFFFF' }], ['claim', { r: 16, q: 2001 }],
    ['claim', { r: 16, q: 1000, extra: true }]]) assert.throws(() => prepareMove(address, type, payload, snapshot));
});

test('init/import/address round trip, encrypted at rest, permissions and wrong password', async t => {
  const root = await temp(t);
  const directory = join(root, 'first');
  const created = await init({ directory, password });
  assert.match(created.address, /^[0-9a-f]{64}$/);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(created.keystore)).mode & 0o777, 0o600);
  const wallet = await unlock({ directory, password }); t.after(() => wipeWallet(wallet));
  const disk = await readFile(created.keystore, 'utf8');
  assert.ok(!disk.includes(wallet.mnemonic) && !disk.includes(Buffer.from(wallet.secretKey).toString('hex')));
  const imported = await importMnemonic({ directory: join(root, 'second'), password, mnemonic: wallet.mnemonic });
  assert.equal(imported.address, created.address);
  assert.deepEqual(await getAddress({ directory, password }), { address: created.address });
  await assert.rejects(unlock({ directory, password: 'wrong-password-long' }), /Wrong password/);
  await assert.rejects(init({ directory, password }), /EEXIST/);
  await assert.rejects(init({ directory: join(root, 'weak'), password: 'weak' }), /12 characters/);
  await assert.rejects(importMnemonic({ directory: join(root, 'invalid'), password, mnemonic: 'invalid mnemonic' }), /Invalid mnemonic/);
  await chmod(created.keystore, 0o644);
  await assert.rejects(unlock({ directory, password }), /0600/);
});

test('all supplied Intercom puzzle vectors match bytes, hashes, bits and verdicts', async () => {
  const { vectors } = JSON.parse(await readFile(new URL('./fixtures/intercom-vectors.json', import.meta.url)));
  const reference = new Puzzle();
  assert.equal(vectors.length, 321);
  for (const v of vectors) {
    const p = v.payload;
    const base = stableStringify({ id: p?.id ?? null, channel: p?.channel ?? null, from: p?.from ?? null,
      origin: p?.origin ?? null, message: p?.message ?? null, ts: p?.ts ?? null, nonce: v.nonce });
    assert.equal(base, v.base); assert.equal(base, reference._powBase(p, v.nonce));
    assert.equal(sha256Hex(base), v.digest); assert.equal(countLeadingZeroBits(v.digest), v.bits);
    for (const [bits, valid] of Object.entries(v.verdicts)) assert.equal(countLeadingZeroBits(v.digest) >= Number(bits), valid);
  }
  assert.equal(stableStringify({ b: undefined, a: ['雪', null, true] }), referenceStable({ b: undefined, a: ['雪', null, true] }));
  assert.equal(countLeadingZeroBits('0'.repeat(64)), 256);
});

test('keystore authentication rejects tampering; symlink targets are never followed', async t => {
  const root = await temp(t), directory = join(root, 'wallet');
  const result = await init({ directory, password });
  const original = JSON.parse(await readFile(result.keystore, 'utf8'));
  for (const field of ['address', 'ciphertext', 'tag']) {
    const changed = structuredClone(original);
    changed[field] = (changed[field][0] === '0' ? '1' : '0') + changed[field].slice(1);
    await writeFile(result.keystore, JSON.stringify(changed));
    await assert.rejects(unlock({ directory, password }), /Wrong password/);
  }
  const linked = join(root, 'linked'); await symlink(directory, linked);
  await assert.rejects(unlock({ directory: linked, password }), /symlink/);
  const fileLinkDirectory = join(root, 'file-link'); await mkdir(fileLinkDirectory, { mode: 0o700 });
  await symlink(result.keystore, join(fileLinkDirectory, 'keystore.json'));
  await assert.rejects(unlock({ directory: fileLinkDirectory, password }), /ELOOP/);
});

test('trac-wallet 2.1.0 signatures and 64-hex address interoperate with trac-peer 0.4.9 wallet and API.post', async t => {
  const wallet = await createWallet(); t.after(() => wipeWallet(wallet));
  assert.equal(peerRequire('trac-wallet/package.json').version, '1.0.4');
  const addr = publicAddress(wallet);
  const packet = prepareMove(addr, 'lock', { amount: '100' }, state);
  const signed = await signAndSolve(wallet, packet, { state });
  const peerWallet = Object.create(PeerWallet.prototype);
  assert.ok(peerWallet.verify(signed.signature, JSON.stringify(signed.prepared) + signed.nonce, addr));
  assert.ok(verify(signed, { state }));
  assert.equal(puzzleBits(addr, JSON.parse(signed.prepared.dispatch.msg)) >= state.bits.lock, true);
  const appended = [];
  const peer = { wallet: peerWallet, base: { writable: true, append: async v => appended.push(v) },
    protocol: { instance: { msgMaxBytes: () => 8192 } } };
  const api = new ProtocolApi(peer, { apiMsgExposed: true });
  assert.deepEqual(packet.prepared, api.prepareMessage(stableStringify(packet.envelope), addr));
  await api.post(signed.prepared, signed.signature, signed.nonce);
  assert.equal(appended.length, 1);
  signed.prepared.dispatch.msg = signed.prepared.dispatch.msg.replace('100', '101');
  assert.equal(verify(signed, { state }), false);
});

test('move signer refuses stale, foreign, malformed, mismatched and unsupported envelopes', async t => {
  const wallet = await createWallet(); t.after(() => wipeWallet(wallet));
  const base = prepareMove(publicAddress(wallet), 'lock', { amount: '100' }, state, 1000);
  const attempts = [p => { p.expires_at = 1000; }, p => { p.envelope.h = 'ff'.repeat(32); },
    p => { p.envelope.b--; }, p => { p.bits = 0; }, p => { p.prepared.dispatch.address = 'ff'.repeat(32); },
    p => { p.prepared.dispatch.type = 'tx'; }, p => { p.envelope.p.amount = '1.5'; },
    p => { p.envelope.t = 'guess'; }, p => { p.prepared.dispatch.attachments = ['x']; },
    p => { p.envelope.p.extra = 1; }, p => { p.issued_at = 3000; }];
  for (const mutate of attempts) { const packet = structuredClone(base); mutate(packet); await assert.rejects(signAndSolve(wallet, packet, { state, now: () => 2000 })); }
  await assert.rejects(signAndSolve(wallet, base, { now: () => 2000 }), /snapshot/);
  await assert.rejects(solve(publicAddress(wallet), base.envelope, 32, { maxAttempts: 1 }), /attempt limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(solve(publicAddress(wallet), base.envelope, 8, { signal: controller.signal }), /abort/i);
});

test('transfer rebuild matches Protocol.generateTx and api.tx accepts the UTF-8 hash', async t => {
  const wallet = await createWallet(); t.after(() => wipeWallet(wallet));
  const addr = publicAddress(wallet);
  const packet = prepareTransfer({ address: addr, to: 'aa'.repeat(32), amount: '9007199254740993' }, context, '05'.repeat(32), 1000);
  assert.equal(packet.tx, await Protocol.prototype.generateTx(context.networkId, context.txv, context.incomingWritingKey,
    packet.command_hash, context.subnetBootstrap, context.msbBootstrap, packet.nonce));
  const signed = signTransfer(wallet, packet, { context, now: 2000 });
  assert.ok(PeerWallet.prototype.verify.call({}, signed.signature, Buffer.from(signed.tx, 'hex'), addr));
  assert.ok(verify({ transfer: packet, signature: signed.signature }, { context, now: 2000 }));
  const peer = { wallet: Object.create(PeerWallet.prototype), base: { writable: true }, config: { txContentHash: 'utf8-strict' },
    protocol: { instance: {
      txMaxBytes: () => 4096, safeJsonStringify: JSON.stringify, broadcastTransaction: async (_, __, surrogate) => surrogate
    } } };
  const api = new ProtocolApi(peer, { apiTxExposed: true });
  api.generateTx = async (_, hash, nonce) => transactionHash(context, hash, nonce);
  const accepted = await api.tx(signed.tx, signed.prepared_command, addr, signed.signature, signed.nonce);
  assert.equal(accepted.address, addr);
  assert.equal(accepted.ch, packet.command_hash);
  const attacks = [p => { p.to = 'bb'.repeat(32); }, p => { p.amount = '4'; }, p => { p.command_hash = '00'.repeat(32); },
    p => { p.tx = '00'.repeat(32); }, p => { p.prepared_command.type = 'gw_set'; },
    p => { p.prepared_command.value.amount = '4'; }, p => { p.context.networkId++; },
    p => { p.context.subnetBootstrap = 'ff'.repeat(32); }, p => { p.address = 'cc'.repeat(32); },
    p => { p.prepared_command.extra = 'hidden'; }, p => { p.expires_at = 1500; }];
  for (const attack of attacks) { const p = structuredClone(packet); attack(p); assert.throws(() => signTransfer(wallet, p, { context, now: 2000 })); }
  assert.throws(() => signTransfer(wallet, packet, { now: 2000 }), /trusted context/);
});

test('command hashes are BLAKE3 over UTF-8 bytes', async () => {
  const a = { type: 'transfer', value: { to: 'aa'.repeat(32), amount: '3' } };
  const b = { type: 'transfer', value: { to: 'bb'.repeat(32), amount: '3' } };
  assert.notEqual(await peerHash(JSON.stringify(a)), await peerHash(JSON.stringify(b)));
  assert.equal(await peerHash(JSON.stringify(a)), await peerHash(Buffer.from(JSON.stringify(a))));
  assert.notEqual(await peerHash(Buffer.from(JSON.stringify(a))), await peerHash(Buffer.from(JSON.stringify(b))));
});

test('domain-bound login signing and verification', async t => {
  const wallet = await createWallet(); t.after(() => wipeWallet(wallet));
  const challenge = { v: 1, domain: 'reset-mcp-login', audience: 'http://localhost:3100', address: publicAddress(wallet), nonce: 'ad'.repeat(32), issued_at: 1000, expires_at: 61000 };
  const signed = signChallenge(wallet, challenge, { audience: challenge.audience, now: 2000 });
  assert.ok(verify(signed, { audience: challenge.audience, now: 2000 }));
  assert.ok(verifySignature(signed.signature, challengeMessage(challenge), challenge.address));
  assert.throws(() => signChallenge(wallet, challenge, { audience: 'http://foreign.test', now: 2000 }), /Foreign/);
  assert.throws(() => signChallenge(wallet, challenge, { audience: challenge.audience, now: 61000 }), /Stale/);
});

test('CLI JSON init/import/address/sign/verify/errors without leaking secrets', async t => {
  const root = await temp(t), directory = join(root, 'cli');
  const cli = new URL('../bin/reset-signer.mjs', import.meta.url).pathname;
  const env = { ...process.env, RESET_SIGNER_PASSWORD: password };
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args, '--directory', directory], { env })).stdout);
  const created = await run('init');
  assert.deepEqual(await run('address'), { address: created.address });
  const wallet = await unlock({ directory, password }); t.after(() => wipeWallet(wallet));
  const imported = JSON.parse((await exec(process.execPath, [cli, 'import', '--directory', join(root, 'imported')], { env: { ...env, RESET_SIGNER_MNEMONIC: wallet.mnemonic } })).stdout);
  assert.equal(imported.address, created.address);
  const packetFile = join(root, 'move.json'), stateFile = join(root, 'state.json'), signedFile = join(root, 'signed.json');
  await writeFile(packetFile, JSON.stringify(prepareMove(created.address, 'withdraw', {}, state)));
  await writeFile(stateFile, JSON.stringify(state));
  const signed = await run('sign_and_solve', packetFile, '--state', stateFile);
  await writeFile(signedFile, JSON.stringify(signed));
  assert.deepEqual(await run('verify', signedFile, '--state', stateFile), { valid: true });
  const txFile = join(root, 'transfer.json'), contextFile = join(root, 'context.json');
  const tx = prepareTransfer({ address: created.address, to: 'aa'.repeat(32), amount: '3' }, context, '05'.repeat(32));
  await writeFile(txFile, JSON.stringify(tx)); await writeFile(contextFile, JSON.stringify(context));
  const transfer = await run('sign_transfer', txFile, '--context', contextFile);
  assert.ok(verifySignature(transfer.signature, Buffer.from(tx.tx, 'hex'), created.address));
  const challengeFile = join(root, 'challenge.json');
  const challenge = { v: 1, domain: 'reset-mcp-login', audience: 'http://localhost:3100', address: created.address,
    nonce: 'ab'.repeat(32), issued_at: Date.now(), expires_at: Date.now() + 60000 };
  await writeFile(challengeFile, JSON.stringify(challenge));
  assert.ok(verify(await run('sign_challenge', challengeFile, '--audience', challenge.audience), { audience: challenge.audience }));
  await assert.rejects(run('unknown'), error => JSON.parse(error.stdout).error === 'Unknown command');
});
