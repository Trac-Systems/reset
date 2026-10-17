import { StateTransition } from '../../contract/state.js';

const PAGE_ROWS = 400, PAGE_BYTES = 56 * 1024, CACHE_PAGES = 32;
const amount = value => {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('mine_amount');
  return n;
};

async function page(view, beaconOptions, after) {
  const state = new StateTransition(async key => (await view.get(key))?.value ?? null, beaconOptions);
  const { tip, counted, mine } = await state.state();
  const last = mine.last_result, vein = mine.last_vein, params = mine.params;
  const result = { v: 1, tip, counted,
    round: { r: mine.r, start: mine.start, claim_end: mine.claim_end, end: mine.end, window_open: mine.window_open,
      claims: mine.claim_count, deposit: amount(mine.claim_deposit) },
    mine: { stock: amount(mine.S), capacity: amount(mine.C), vein: amount(mine.vein_buffer),
      armed: await state.get('mine/armed') === true, guideline: amount(mine.last_guideline),
      params: { mine_max_strikes: params.mine_max_strikes, mine_clean_rounds: params.mine_clean_rounds,
        mine_collapse_threshold_per_mille: params.mine_collapse_threshold_per_mille } },
    last: last ? { r: last.r, hash: last.hash, claims: last.claims, deposit: amount(last.deposit),
      guideline: amount(last.guideline), capacity: amount(last.capacity), collapse: last.collapse,
      paid: amount(last.paid), penalties: amount(last.penalties), stock: amount(last.stock) } : null,
    last_vein: vein ? { height: vein.height, hash: vein.hash, amount: amount(vein.amount) } : null,
    miners: [], total: 0, next: null };
  const miners = new Map();
  const row = address => {
    if (!miners.has(address)) miners.set(address, [address, 0, 0, 0, 0, 0, 0, 0, 0]);
    return miners.get(address);
  };
  for (const prefix of ['dep/', 'exit/', `mine/seen/${mine.r}/`]) {
    for await (const { key, value } of view.createReadStream({ gt: prefix, lt: prefix.slice(0, -1) + '0' })) {
      const address = key.slice(prefix.length);
      if (prefix === 'dep/') {
        const deposit = amount(value);
        if (deposit > 0) row(address)[1] = deposit;
      } else if (prefix === 'exit/') {
        const leaving = amount(value.reduce((sum, exit) => sum + BigInt(exit.amount), 0n));
        if (leaving > 0) row(address)[2] = leaving;
      } else row(address)[5] = 1;
    }
  }
  result.total = miners.size;
  const addresses = [...miners.keys()].sort().filter(address => address > after);
  // Reserve the cursor's full length before adding rows.
  let bytes = Buffer.byteLength(JSON.stringify(result)) + 62;
  for (const address of addresses.slice(0, PAGE_ROWS)) {
    const entry = miners.get(address);
    const [status, settled] = await Promise.all([state.get(`mine/strikes/${address}`), state.get(`mine/result/${address}`)]);
    entry[3] = status?.strikes ?? 0; entry[4] = status?.clean ?? 0;
    entry[6] = settled?.r ?? 0; entry[7] = amount(settled?.amount); entry[8] = amount(settled?.penalty);
    const size = Buffer.byteLength(JSON.stringify(entry)) + (result.miners.length ? 1 : 0);
    if (bytes + size > PAGE_BYTES) break;
    result.miners.push(entry); bytes += size;
  }
  if (result.miners.length < addresses.length) result.next = result.miners.at(-1)[0];
  return JSON.stringify(result);
}

export class MineView {
  constructor(peer) { this.peer = peer; this.cache = new Map(); }
  get(after = '') {
    const base = this.peer.base.view, version = base.version, key = `${version}/${after}`;
    if (this.cache.has(key)) {
      const cached = this.cache.get(key); this.cache.delete(key); this.cache.set(key, cached); return cached;
    }
    const pending = this.read(base, version, after);
    this.cache.set(key, pending);
    if (this.cache.size > CACHE_PAGES) this.cache.delete(this.cache.keys().next().value);
    pending.catch(() => { if (this.cache.get(key) === pending) this.cache.delete(key); });
    return pending;
  }
  async read(base, version, after) {
    const view = base.checkout(version);
    try { return { etag: `"mine-v1-${version}-${after || 'first'}"`, body: await page(view, this.peer.config.beaconOptions, after) }; }
    finally { await view.close(); }
  }
}
