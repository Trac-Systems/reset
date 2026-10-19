import http from 'http';
import { URLSearchParams } from 'url';
import { Feature } from 'trac-peer';
import { createHash } from 'trac-peer/src/utils/types.js';
import { StateTransition } from '../../contract/state.js';
import { ADDRESS, exactKeys, parseAmount, stableJSON, validatePrepared } from '../../contract/rules/index.js';
import { HeaderSource } from './header-source.js';
import { MineView } from './mine-view.js';
import { tracToHex } from './trac-address.js';

export class Gateway extends Feature {
  constructor(peer, options = {}) {
    super(peer, options);
    this.options = { host: '127.0.0.1', port: 49223, headerSource: 'off', pollMs: 1000, headerDelayMs: 60000,
      ipLimit: 240, addressLimit: 60, rateWindowMs: 60000, maxQueue: 64, ...options };
    this.queue = Promise.resolve(); this.queued = 0; this.limits = new Map(); this.server = null;
    this.source = this.options.headerSource === 'off' ? null : new HeaderSource(this.options.headerSource, options);
    this.closed = false; this.tickPromise = null; this.timer = null;
    this.mineView = new MineView(peer);
  }
  get api() { return this.peer.protocol.instance.api; }
  async withView(fn) {
    const view = this.peer.base.view.checkout(this.peer.base.view.version);
    try { return await fn(new StateTransition(async k => (await view.get(k))?.value ?? null, this.peer.config.beaconOptions)); }
    finally { await view.close(); }
  }
  rate(key, limit) {
    const now = Date.now();
    if (this.limits.size > 10000) for (const [k, v] of this.limits) if (v.until <= now) this.limits.delete(k);
    let item = this.limits.get(key);
    if (!item || item.until <= now) {
      if (this.limits.size >= 20000 && !item) return false;
      item = { until: now + this.options.rateWindowMs, used: 0 }; this.limits.set(key, item);
    }
    return ++item.used <= limit;
  }
  async precheck(body) {
    const error = validatePrepared(body, this.peer.protocol.instance.msgMaxBytes());
    if (error) return { error };
    const { prepared, signature, nonce } = body;
    const address = prepared.dispatch.address;
    if (!this.peer.wallet.verify(signature, JSON.stringify(prepared) + nonce, address)) return { error: 'signature' };
    if (!this.peer.base.writable) return { error: 'writer' };
    return this.withView(async state => {
      if (await state.get(`sh/${signature}`) !== null) return { replay: true };
      if (await state.get('chat_status') !== 'on') return { error: 'chat_disabled' };
      if (await state.get('admin') !== address) {
        if (await state.get(`mtd/${address}`) === true) return { error: 'muted' };
        if (await state.get('wlst') === true && await state.get(`wl/${address}`) !== true) return { error: 'whitelist' };
      }
      return { error: await state.move(prepared.dispatch.msg, address) };
    });
  }
  async submit(body) {
    if (this.closed || this.queued >= this.options.maxQueue) return { ok: false, error: 'busy' };
    this.queued++;
    const run = this.queue.then(async () => {
      const check = await this.precheck(body);
      if (check.error) return { ok: false, error: check.error };
      if (check.replay) return { ok: true };
      await this.api.post(body.prepared, body.signature, body.nonce);
      await this.peer.base.update();
      return { ok: true };
    }).catch(error => ({ ok: false, error: error.message }));
    this.queue = run.then(() => { this.queued--; });
    return run;
  }
  async prepareTransfer(body) {
    if (!exactKeys(body, ['address', 'to', 'amount', 'nonce']) || !ADDRESS.test(body.address) || !ADDRESS.test(body.to) ||
        parseAmount(body.amount, true) === null || typeof body.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(body.nonce)) throw new Error('transfer');
    const prepared_command = this.api.prepareTxCommand(JSON.stringify({ op: 'transfer', to: body.to, amount: body.amount }));
    const content_hash = await createHash(JSON.stringify(prepared_command));
    const context = { network_id: this.peer.msbClient.networkId, txv: await this.peer.msbClient.getTxvHex(),
      writer: this.api.getPeerWriterKey(), content_hash, subnet: this.api.getPeerBootstrap().toString('hex'),
      msb: this.api.getPeerMsbBootstrap() };
    const tx = await this.api.generateTx(body.address, content_hash, body.nonce);
    // If the MSB root advanced between reads, return a consistent retryable error.
    const recomputed = await this.peer.protocol.instance.generateTx(context.network_id, context.txv, context.writer, content_hash, context.subnet, context.msb, body.nonce);
    if (tx !== recomputed) throw new Error('msb_root_changed');
    return { address: body.address, to: body.to, amount: body.amount, prepared_command, tx, nonce: body.nonce, context };
  }
  // Where a submitted transfer stands, so a client knows whether to wait or send again:
  //   applied   - the contract ran it;
  //   queued    - the MSB has it; it is applied once the indexers sign it, however long that takes;
  //   submitted - sent to validators, not yet seen in the MSB;
  //   stranded  - the MSB has it but this gateway no longer tracks it (check again in a minute; an operator looks);
  //   unknown   - never seen here, or dropped before the MSB took it: sending a new transfer is safe.
  async txStatus(hash) {
    const pending = this.peer.txPool?.contains(hash) === true;
    const inMsb = this.options.msb ? (await this.options.msb.state.get(hash)) !== null : false;
    if (await this.peer.protocol.instance.get('tx/' + hash) !== null) return 'applied';
    if (inMsb) return pending ? 'queued' : 'stranded';
    return pending ? 'submitted' : 'unknown';
  }
  async submitTransfer(body) {
    if (!exactKeys(body, ['tx', 'prepared_command', 'address', 'signature', 'nonce']) ||
        !exactKeys(body.prepared_command, ['type', 'value']) || body.prepared_command.type !== 'transfer' ||
        !exactKeys(body.prepared_command.value, ['to', 'amount']) ||
        typeof body.prepared_command.value.to !== 'string' || !ADDRESS.test(body.prepared_command.value.to) ||
        parseAmount(body.prepared_command.value.amount, true) === null) throw new Error('transfer');
    const result = await this.api.tx(body.tx, body.prepared_command, body.address, body.signature, body.nonce);
    return { ok: result !== false, result };
  }
  body(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = []; let failed = false;
      req.on('data', chunk => {
        if (failed) return;
        size += chunk.length;
        if (size > 16384) { failed = true; reject(new Error('body_too_large')); return; }
        chunks.push(chunk);
      });
      req.on('error', reject);
      req.on('end', () => {
        if (failed) return;
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('json')); }
      });
    });
  }
  async handle(req, res) {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (!this.rate(`ip/${this.clientIp(req)}`, this.options.ipLimit)) return send(429, { ok: false, error: 'ip_rate' });
      const path = (req.url || '').split('?')[0];
      if (req.method === 'GET' && path === '/v1/state') {
        const state = await this.api.coinState();
        // Bitcoin's own height as last seen by this gateway's header source (null when the watcher is off).
        return send(200, { ...state, source_height: this.source?.lastHeight ?? null, header_error: this.lastError ?? null });
      }
      if (req.method === 'GET' && path === '/v1/mine/view') {
        const cursors = new URLSearchParams((req.url || '').split('?').slice(1).join('?')).getAll('after');
        if (cursors.length > 1 || (cursors.length && !ADDRESS.test(cursors[0]))) return send(400, { ok: false, error: 'after' });
        const { etag, body } = await this.mineView.get(cursors[0] ?? '');
        const unchanged = String(req.headers['if-none-match'] ?? '').split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag);
        res.writeHead(unchanged ? 304 : 200, { 'content-type': 'application/json', 'cache-control': 'no-cache', etag });
        return res.end(unchanged ? undefined : body);
      }
      if (req.method === 'GET' && path.startsWith('/v1/account/')) {
        // The 64-hex key or its trac address (trac1…): both name the same account.
        const id = path.slice('/v1/account/'.length), key = /^[0-9a-f]{64}$/.test(id) ? id : tracToHex(id);
        if (!key) return send(400, { ok: false, error: 'address' });
        return send(200, await this.api.coinAccount(key));
      }
      if (req.method === 'GET' && /^\/v1\/tx\/[0-9a-f]{64}$/.test(path)) {
        const tx = path.slice('/v1/tx/'.length);
        return send(200, { tx, status: await this.txStatus(tx) });
      }
      if (path === '/v1/chat' || path.startsWith('/v1/chat/')) return this.handleChat(req, path, send);
      if (req.method !== 'POST' || !['/v1/move', '/v1/tx/prepare', '/v1/tx/submit'].includes(path)) return send(404, { ok: false, error: 'not_found' });
      const body = await this.body(req);
      const address = body?.prepared?.dispatch?.address ?? body?.address;
      if (typeof address !== 'string' || !ADDRESS.test(address)) return send(400, { ok: false, error: 'address' });
      if (!this.rate(`address/${address}`, this.options.addressLimit)) return send(429, { ok: false, error: 'address_rate' });
      const result = path === '/v1/move' ? await this.submit(body) : path === '/v1/tx/prepare' ? await this.prepareTransfer(body) : await this.submitTransfer(body);
      send(200, result);
    } catch (error) { send(error.message === 'body_too_large' ? 413 : 400, { ok: false, error: error.message }); }
  }
  // Miners' chat (features/chat): read, an agent's signed message, a viewer message relayed by the game.
  async handleChat(req, path, send) {
    const chat = this.options.chat;
    if (!chat) return send(404, { ok: false, error: 'not_found' });
    if (req.method === 'GET' && path === '/v1/chat') {
      const after = new URLSearchParams((req.url || '').split('?').slice(1).join('?')).getAll('after');
      if (after.length > 1 || (after.length && !/^(0|[1-9][0-9]{0,15})$/.test(after[0]))) return send(400, { ok: false, error: 'after' });
      return send(200, await chat.list(after.length ? Number(after[0]) : null));
    }
    if (req.method === 'POST' && path === '/v1/chat/send') {
      const body = await this.body(req);
      const address = body?.message?.addr;
      if (typeof address !== 'string' || !ADDRESS.test(address)) return send(400, { ok: false, error: 'address' });
      if (!this.rate(`address/${address}`, this.options.addressLimit)) return send(429, { ok: false, error: 'address_rate' });
      return send(200, await chat.postAgent(body));
    }
    if (req.method === 'POST' && path === '/v1/chat/viewer') {
      if (!chat.viewerKeyOk(req.headers.authorization)) return send(401, { ok: false, error: 'unauthorized' });
      return send(200, chat.postViewer(await this.body(req)));
    }
    return send(404, { ok: false, error: 'not_found' });
  }
  async start() {
    if (this.server) return;
    if (!this.api.msgExposed() || !this.api.txExposed()) throw new Error('Gateway requires exposed message and transaction APIs');
    this.closed = false;
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
    this.server.requestTimeout = 10000; this.server.headersTimeout = 10000;
    this.server.setTimeout(10000, socket => socket.destroy());
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.port, this.options.host, resolve); });
    this.url = `http://${this.options.host}:${this.server.address().port}`;
    if (this.options.autoBeat !== false) this.schedule();
  }
  // Behind a local reverse proxy (trustProxy), the proxy appends the real client to X-Forwarded-For.
  clientIp(req) {
    const remote = req.socket.remoteAddress;
    if (!this.options.trustProxy || !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote ?? '')) return remote;
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(x => x.trim()).filter(Boolean);
    return forwarded.at(-1) ?? remote;
  }
  schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.tickPromise = this.tick().then(() => { this.lastError = null; }, error => {
        if (error.message !== this.lastError) console.error('[gateway] tick failed:', error.message);
        this.lastError = error.message;
      }).finally(() => { this.tickPromise = null; this.schedule(); });
    }, this.options.pollMs);
    this.timer.unref?.();
  }
  async ownMove(type, payload) {
    const state = await this.api.coinState();
    const msg = stableJSON({ v: 1, t: type, b: state.tip.height, h: state.tip.hash, p: payload, w: '0' });
    const prepared = this.api.prepareMessage(msg, this.peer.wallet.publicKey);
    const nonce = this.api.generateNonce();
    return this.submit({ prepared, nonce, signature: this.peer.wallet.sign(JSON.stringify(prepared) + nonce) });
  }
  async tick() {
    const state = await this.api.coinState();
    const own = state.gateways.find(g => g.addr === this.peer.wallet.publicKey);
    if (own?.registered && !own.active) await this.ownMove('gw_beat', {});
    if (this.source) {
      const headers = await this.source.next(state, h => this.api.coinHashAt(h));
      if (!headers.length) this.headersWaiting = null;
      else {
        // Agents get the first chance to post a new block; the gateway posts only after headerDelayMs.
        this.headersWaiting ??= Date.now();
        if (Date.now() - this.headersWaiting >= this.options.headerDelayMs) {
          const result = await this.ownMove('header', { hx: headers });
          if (!result.ok) throw new Error(result.error);
          this.headersWaiting = null;
        }
      }
    }
  }
  async stop() {
    this.closed = true; clearTimeout(this.timer);
    if (this.server) { this.server.closeIdleConnections?.(); await new Promise(resolve => this.server.close(resolve)); this.server = null; }
    await this.tickPromise; await this.queue;
  }
}
export default Gateway;
