// Local client fixture. No player keys; verification is independent of signer code.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import PeerWallet from '../../node_modules/trac-peer/src/wallet.js';
import Protocol from '../../node_modules/trac-peer/src/artifacts/protocol.js';
import { createHash as peerHash } from '../../node_modules/trac-peer/src/utils/types.js';
import { stableStringify, countLeadingZeroBits } from '../../signer/test/fixtures/intercom-pow.mjs';
import { readBody, json } from '../lib/http.mjs';
import { state as initialState, context as initialContext } from '../../signer/test/helpers.mjs';

const hex32 = /^[0-9a-f]{64}$/;
const signatureOkay = (sig, msg, addr) => /^[0-9a-f]{128}$/.test(sig) && hex32.test(addr) && PeerWallet.prototype.verify.call({}, sig, msg, addr);
function must(ok, message) { if (!ok) throw new Error(message); }
function keys(object, expected) { must(object && Object.keys(object).sort().join(',') === [...expected].sort().join(','), 'Unexpected fields'); }
function units(value) { must(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'Invalid amount'); return BigInt(value); }

export async function startFakeGateway({ funded = {}, exitWait = 0, now = Date.now } = {}) {
  const state = structuredClone(initialState); state.params.exit_wait = exitWait;
  const context = structuredClone(initialContext);
  const accounts = new Map(Object.entries(funded).map(([addr, balance]) => [addr, { balance: BigInt(balance), deposit: 0n, exits: [], moves: 0 }]));
  const seen = new Set(), txs = new Set(), requests = [];
  const hashes = new Map([[state.tip.height, state.tip.hash]]);
  const get = addr => {
    must(typeof addr === 'string' && hex32.test(addr), 'Invalid address');
    if (!accounts.has(addr)) accounts.set(addr, { balance: 0n, deposit: 0n, exits: [], moves: 0 });
    return accounts.get(addr);
  };
  const accountJSON = addr => {
    const a = get(addr);
    return { balance: String(a.balance), deposit: String(a.deposit), exits: a.exits.map(e => ({ amount: String(e.amount), release: e.release })), moves_this_height: a.moves };
  };
  async function transaction(command, nonce) {
    return Protocol.prototype.generateTx(context.networkId, context.txv, context.incomingWritingKey,
      await peerHash(Buffer.from(JSON.stringify(command), 'utf8')), context.subnetBootstrap, context.msbBootstrap, nonce);
  }
  const http = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    try {
      if (req.method === 'GET' && req.url === '/v1/state') { json(res, 200, state); return; }
      if (req.method === 'GET' && /^\/v1\/account\/[0-9a-f]{64}$/.test(req.url)) { json(res, 200, accountJSON(req.url.slice('/v1/account/'.length))); return; }
      if (req.method !== 'POST') { json(res, 404, { error: 'Unknown route' }); return; }
      const body = await readBody(req, 16384, 2000);
      if (req.url === '/v1/move') {
        keys(body, ['prepared', 'signature', 'nonce']);
        const { prepared, signature, nonce } = body;
        keys(prepared, ['dispatch']); const d = prepared.dispatch;
        keys(d, ['type', 'msg', 'address', 'attachments', 'deleted_by', 'reply_to', 'pinned', 'pin_id']);
        must(d.type === 'msg' && Array.isArray(d.attachments) && d.attachments.length === 0 && d.deleted_by === null && d.reply_to === null && d.pinned === false && d.pin_id === null, 'Invalid message');
        must(Buffer.byteLength(JSON.stringify(prepared)) <= 8192 && typeof nonce === 'string' && hex32.test(nonce), 'Invalid message size or nonce');
        must(signatureOkay(signature, JSON.stringify(prepared) + nonce, d.address), 'Bad signature');
        must(!seen.has(signature), 'Replay');
        const e = JSON.parse(d.msg); keys(e, ['v', 't', 'b', 'h', 'p', 'w']);
        must(e.v === 1 && Object.hasOwn(state.bits, e.t) && Number.isSafeInteger(e.b) &&
          e.b >= state.tip.height - 2 && e.b <= state.tip.height && hashes.get(e.b) === e.h, 'Stale or foreign envelope');
        must(d.msg === stableStringify(e) && /^[0-9a-f]{1,32}$/.test(e.w), 'Noncanonical envelope');
        const digest = createHash('sha256').update(stableStringify({ a: d.address, b: e.b, h: e.h, p: e.p, t: e.t, v: e.v, w: e.w })).digest('hex');
        must(countLeadingZeroBits(digest) >= state.bits[e.t], 'Bad puzzle');
        const a = get(d.address);
        if (!['header', 'gw_beat'].includes(e.t)) {
          must(state.capacity_left > 0 && a.moves < state.per_address, 'Capacity exhausted');
        }
        if (e.t === 'lock' || e.t === 'unlock') {
          keys(e.p, ['amount']); const n = units(e.p.amount);
          if (e.t === 'lock') { must(a.balance >= n, 'Insufficient balance'); a.balance -= n; a.deposit += n; }
          else { must(a.deposit >= n, 'Insufficient deposit'); a.deposit -= n; a.exits.push({ amount: n, release: state.counted + state.params.exit_wait }); }
        } else if (e.t === 'withdraw') {
          keys(e.p, []);
          const released = a.exits.filter(e => e.release <= state.counted).reduce((sum, e) => sum + e.amount, 0n);
          must(released > 0n, 'No matured exits');
          a.balance += released; a.exits = a.exits.filter(e => e.release > state.counted);
        } else if (e.t === 'gw_beat') {
          keys(e.p, []); must(state.gateways.includes(d.address), 'Unregistered gateway');
        } else throw new Error('Header ingest is outside this client fixture');
        seen.add(signature);
        if (!['header', 'gw_beat'].includes(e.t)) { a.moves++; state.capacity_left--; }
        json(res, 200, { ok: true }); return;
      }
      if (req.url === '/v1/tx/prepare') {
        keys(body, ['address', 'to', 'amount', 'nonce']); get(body.address); get(body.to); units(body.amount);
        must(typeof body.nonce === 'string' && hex32.test(body.nonce), 'Invalid nonce');
        const prepared_command = { type: 'transfer', value: { to: body.to, amount: body.amount } };
        const nonce = body.nonce;
        json(res, 200, { ...body, prepared_command, context: { network_id: context.networkId, txv: context.txv,
          writer: context.incomingWritingKey, content_hash: await peerHash(Buffer.from(JSON.stringify(prepared_command), 'utf8')),
          subnet: context.subnetBootstrap, msb: context.msbBootstrap }, tx: await transaction(prepared_command, nonce) }); return;
      }
      if (req.url === '/v1/tx/submit') {
        keys(body, ['tx', 'prepared_command', 'address', 'signature', 'nonce']);
        const { prepared_command: cmd, tx, nonce, signature, address: addr } = body;
        keys(cmd, ['type', 'value']); keys(cmd.value, ['to', 'amount']);
        must(cmd.type === 'transfer' && hex32.test(tx) && hex32.test(nonce), 'Invalid transaction');
        const n = units(cmd.value.amount), a = get(addr), recipient = get(cmd.value.to);
        must(signatureOkay(signature, Buffer.from(tx, 'hex'), addr), 'Bad transaction signature');
        must(tx === await transaction(cmd, nonce), 'Bad transaction hash');
        must(!txs.has(tx), 'Replay'); must(a.balance >= n, 'Insufficient balance');
        a.balance -= n; recipient.balance += n; txs.add(tx);
        json(res, 200, { ok: true }); return;
      }
      json(res, 404, { error: 'Unknown route' });
    } catch (error) { json(res, 400, { ok: false, error: error.message }); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${http.address().port}`, state, context, requests, account: accountJSON,
    advance(count = 1) {
      for (let i = 0; i < count; i++) {
        state.tip.height++; state.counted++;
        state.tip.hash = createHash('sha256').update(state.tip.hash).digest('hex'); hashes.set(state.tip.height, state.tip.hash);
      }
      state.capacity_left = state.params.capacity;
      for (const a of accounts.values()) a.moves = 0;
    },
    close: async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }
  };
}
