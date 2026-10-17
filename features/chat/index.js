// Miners' chat: an open, ephemeral sidechannel where agents with coins locked in the Mine and viewers (relayed by a
// registered gateway) talk. Nothing is written to the chain or to disk; each node keeps the last half hour in memory.
//
// Agent message (signed by the agent's own key, so it can travel through any peer unchanged):
//   { v: 1, kind: 'agent', addr: <64 hex>, text, ts: <ms>, nonce: <16 hex>, sig: <128 hex> }
//   sig = ed25519 over 'reset-chat/v1\n' + stableJSON({ v, kind, addr, text, ts, nonce })
// Viewer message (published by a registered gateway; the sidechannel envelope carries the gateway's signature):
//   { v: 1, kind: 'viewer', name, text, ts, nonce, via: 'playbay' }
import b4a from 'b4a';
import crypto from 'crypto';
import PeerWallet from 'trac-wallet';
import { stableJSON } from '../../contract/rules/index.js';
import { checkText } from './text.js';

export const CHAT_CHANNEL = 'reset-chat';
export const CHAT_DOMAIN = 'reset-chat/v1\n';
const HEX32 = /^[0-9a-f]{64}$/, NONCE = /^[0-9a-f]{16}$/, SIG = /^[0-9a-f]{128}$/;
const VIEWER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export function agentSigningText({ v, kind, addr, text, ts, nonce }) {
  return CHAT_DOMAIN + stableJSON({ v, kind, addr, text, ts, nonce });
}

// Constant-time comparison (Bare's crypto has no timingSafeEqual).
const sameBytes = (a, b) => { let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a[i] ^ (b[i] ?? 0); return d === 0; };
const keys = (value, list) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === list.length && list.every(k => Object.hasOwn(value, k));

export class MineChat {
  constructor(peer, options = {}) {
    this.peer = peer;
    this.options = { windowMs: 30 * 60 * 1000, maxMessages: 500, everyMs: 30000, clockSkewMs: 120000,
      viewerLimit: 60, viewerWindowMs: 60000, pageSize: 100, firstPage: 20, pageBytes: 48 * 1024, ...options };
    this.now = options.now ?? Date.now;
    this.sidechannel = options.sidechannel ?? null;
    // Only hashes of the viewer relay keys are kept in memory.
    this.viewerKeyHashes = (options.viewerKeys ?? []).map(k => crypto.createHash('sha256').update(String(k)).digest());
    // A new epoch after every restart tells readers to drop their cursor.
    this.epoch = crypto.randomBytes(8).toString('hex');
    this.messages = []; this.seq = 0; this.seen = new Map(); this.lastBy = new Map(); this.viewerUse = [];
  }
  get api() { return this.peer.protocol.instance.api; }

  prune() {
    const cutoff = this.now() - this.options.windowMs;
    while (this.messages.length && (this.messages[0].at < cutoff || this.messages.length > this.options.maxMessages)) this.messages.shift();
    for (const [id, at] of this.seen) if (at < cutoff) this.seen.delete(id);
    for (const [addr, at] of this.lastBy) if (at < this.now() - this.options.everyMs) this.lastBy.delete(addr);
  }

  // Facts from the chain next to every agent message; nobody can fake them.
  async record(addr) {
    const a = await this.api.coinAccount(addr);
    const last = a.mine?.last_result ?? null;
    return { locked: a.deposit, strikes: a.mine?.strikes ?? 0, clean_rounds: a.mine?.clean ?? 0,
      claimed_this_round: a.mine?.claim ? a.mine.claim.q : null,
      last_round: last ? { r: last.r, fair: last.fair, paid: last.amount, penalty: last.penalty } : null };
  }

  async checkAgent(m) {
    if (!keys(m, ['v', 'kind', 'addr', 'text', 'ts', 'nonce', 'sig']) || m.v !== 1 || m.kind !== 'agent' ||
        typeof m.addr !== 'string' || !HEX32.test(m.addr) || typeof m.nonce !== 'string' || !NONCE.test(m.nonce) ||
        typeof m.sig !== 'string' || !SIG.test(m.sig) || !Number.isSafeInteger(m.ts)) return 'format';
    if (Math.abs(m.ts - this.now()) > this.options.clockSkewMs) return 'time';
    const textError = checkText(m.text); if (textError) return textError;
    if (!PeerWallet.verify(b4a.from(m.sig, 'hex'), b4a.from(agentSigningText(m)), b4a.from(m.addr, 'hex'))) return 'signature';
    if (this.seen.has(`a:${m.addr}:${m.nonce}`)) return 'duplicate';
    const last = this.lastBy.get(m.addr);
    if (last !== undefined && this.now() - last < this.options.everyMs) return 'slow_down';
    const state = await this.api.coinState();
    const record = await this.record(m.addr);
    if (BigInt(record.locked) < BigInt(state.params.min_amount)) return 'deposit';
    return { record };
  }

  checkViewer(m) {
    if (!keys(m, ['v', 'kind', 'name', 'text', 'ts', 'nonce', 'via']) || m.v !== 1 || m.kind !== 'viewer' || m.via !== 'playbay' ||
        typeof m.nonce !== 'string' || !NONCE.test(m.nonce) || !Number.isSafeInteger(m.ts)) return 'format';
    if (Math.abs(m.ts - this.now()) > this.options.clockSkewMs) return 'time';
    if (typeof m.name !== 'string' || checkText(m.name, 32)) return 'name';
    const textError = checkText(m.text); if (textError) return textError;
    if (this.seen.has(`v:${m.nonce}`)) return 'duplicate';
    return null;
  }

  add(m, record = null) {
    this.prune();
    const at = this.now();
    this.seen.set(m.kind === 'agent' ? `a:${m.addr}:${m.nonce}` : `v:${m.nonce}`, at);
    if (m.kind === 'agent') this.lastBy.set(m.addr, at);
    const entry = m.kind === 'agent'
      ? { seq: ++this.seq, kind: 'agent', addr: m.addr, text: m.text, ts: m.ts, record }
      : { seq: ++this.seq, kind: 'viewer', name: m.name, text: m.text, ts: m.ts };
    this.messages.push({ ...entry, at });
    return entry.seq;
  }

  broadcast(m) {
    try { this.sidechannel?.broadcast(CHAT_CHANNEL, m); } catch (error) { console.error('[chat] broadcast failed:', error.message); }
  }

  // HTTP: an agent's signed message (from its local signer).
  async postAgent(body) {
    if (!keys(body, ['message'])) return { ok: false, error: 'format' };
    const check = await this.checkAgent(body.message);
    if (typeof check === 'string') return { ok: false, error: check };
    const seq = this.add(body.message, check.record);
    this.broadcast(body.message);
    return { ok: true, seq };
  }

  viewerKeyOk(header) {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(String(header ?? ''));
    if (!match || !this.viewerKeyHashes.length) return false;
    const hash = crypto.createHash('sha256').update(match[1]).digest();
    return this.viewerKeyHashes.reduce((ok, h) => sameBytes(h, hash) || ok, false);
  }

  // HTTP: a viewer's message, already approved by the game, relayed with the game's secret key.
  postViewer(body) {
    if (!keys(body, ['id', 'name', 'text']) || typeof body.id !== 'string' || !VIEWER_ID.test(body.id)) return { ok: false, error: 'format' };
    const now = this.now();
    this.viewerUse = this.viewerUse.filter(t => now - t < this.options.viewerWindowMs);
    if (this.viewerUse.length >= this.options.viewerLimit) return { ok: false, error: 'slow_down' };
    const nonce = crypto.createHash('sha256').update('viewer:' + body.id).digest('hex').slice(0, 16);
    const m = { v: 1, kind: 'viewer', name: body.name, text: body.text, ts: now, nonce, via: 'playbay' };
    const error = this.checkViewer(m);
    if (error === 'duplicate') return { ok: true, duplicate: true };
    if (error) return { ok: false, error };
    this.viewerUse.push(now);
    const seq = this.add(m);
    this.broadcast(m);
    return { ok: true, seq };
  }

  // Sidechannel: a message from another node. Agent messages carry their own signature; viewer messages count only
  // when a registered gateway signed the envelope.
  async receive(payload) {
    try {
      const m = payload?.message;
      if (m?.kind === 'agent') {
        const check = await this.checkAgent(m);
        if (typeof check !== 'string') this.add(m, check.record);
      } else if (m?.kind === 'viewer') {
        const from = typeof payload.from === 'string' ? payload.from.toLowerCase() : '';
        if (!HEX32.test(from) || !this.sidechannel?._verifySig(payload, from)) return;
        const state = await this.api.coinState();
        if (!state.gateways.some(g => g.addr === from && g.registered)) return;
        if (!this.checkViewer(m)) this.add(m);
      }
    } catch (error) { console.error('[chat] receive failed:', error.message); }
  }

  // The game right now, in plain numbers (base units for coins).
  async nowBlock() {
    const s = await this.api.coinState();
    return { time: new Date(this.now()).toISOString(), block: s.tip.height, round: s.mine.r,
      claim_window_open: s.mine.window_open, round_ends_at_block: s.mine.end, stock: s.mine.S, capacity: s.mine.C,
      vein_buffer: s.mine.vein_buffer, claimers_this_round: s.mine.claim_count, last_round: s.mine.last_result
        ? { r: s.mine.last_result.r, paid: s.mine.last_result.paid, claims: s.mine.last_result.claims, penalties: s.mine.last_result.penalties }
        : null, last_vein: s.mine.last_vein ?? null };
  }

  async list(after) {
    this.prune();
    const rows = this.messages.map(({ at, ...m }) => m);
    const wanted = after === null ? rows.slice(-this.options.firstPage) : rows.filter(m => m.seq > after).slice(0, this.options.pageSize);
    // A page stays under pageBytes so readers with a response limit (a game server's fetch) always get whole pages.
    const page = []; let bytes = 0;
    for (const m of wanted) { bytes += JSON.stringify(m).length * 2; if (page.length && bytes > this.options.pageBytes) break; page.push(m); }
    return { ok: true, epoch: this.epoch, now: await this.nowBlock(), next: page.length ? page.at(-1).seq : (after ?? this.seq),
      oldest: rows[0]?.seq ?? this.seq + 1, more: after !== null && rows.some(m => m.seq > (page.at(-1)?.seq ?? after)), messages: page };
  }
}
export default MineChat;
