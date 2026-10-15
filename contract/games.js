import { MINE_DEFAULTS, LOTTERY_WINDOW_KEYS, CLAIM_BLOCKS, min,
  roundAt, roundWindow, lotteryWindow, checkGuess, checkClaim, lotteryPayout,
  addMineInflow, mineGuideline, minePayout, mineArmed } from './rules/games.js';

// Storage orchestration only; the decisions and arithmetic live in rules/.
export class GameState {
  constructor(state) { this.s = state; }
  get checkpoint() { return this.s.beaconOptions.checkpoint?.height ?? 0; }
  async config(r) {
    let params = MINE_DEFAULTS;
    for (const entry of await this.s.get('mine/configs') ?? []) if (entry.r <= r) params = entry.params;
    return { ...params };
  }
  async schedule(key, value, tip) {
    const r = roundAt(tip, this.checkpoint) + 1;
    const entries = (await this.s.get('mine/configs') ?? []).map(x => ({ r: x.r, params: { ...x.params } }));
    let next = entries.find(x => x.r === r);
    if (!next) { next = { r, params: await this.config(r) }; entries.push(next); }
    next.params[key] = value;
    entries.sort((a, b) => a.r - b.r);
    this.s.put('mine/configs', entries);
  }
  async guess(p, address, tip, params) {
    const s = this.s, key = `lottery/target/${p.tb}`;
    const target = await s.get(key) ?? { count: 0, limit: params.capacity * CLAIM_BLOCKS };
    const pending = await s.get('params/pending');
    const error = checkGuess(p, tip, params, await s.get(`lottery/seen/${p.tb}/${address}`), target.count, target.limit,
      LOTTERY_WINDOW_KEYS.some(k => pending && Object.hasOwn(pending, k)));
    if (error) return error;
    s.put(`lottery/guess/${p.tb}/${target.count}`, { address, n: p.n });
    s.put(`lottery/seen/${p.tb}/${address}`, true);
    s.put(key, { ...target, count: target.count + 1 });
    s.put('lottery/targets', [...new Set([...(await s.get('lottery/targets') ?? []), p.tb])].sort((a, b) => a - b));
    s.put('lottery/locked', true);
    return null;
  }
  async claim(p, address, tip, deposit) {
    const s = this.s, seen = `mine/seen/${p.r}/${address}`;
    const error = checkClaim(p, tip, this.checkpoint, deposit, await s.get(seen));
    if (error) return error;
    const key = `mine/round/${p.r}`;
    const round = await s.get(key) ?? { count: 0, deposit: '0' };
    s.put(`mine/claim/${p.r}/${round.count}`, { address, d: deposit, q: p.q });
    s.put(seen, { d: deposit, q: p.q });
    s.put(key, { count: round.count + 1, deposit: (BigInt(round.deposit) + BigInt(deposit)).toString() });
    s.put(`mine/last_claim/${address}`, p.r);
    return null;
  }
  async pendingClaim(address, counted) {
    const r = await this.s.get(`mine/last_claim/${address}`);
    return r != null && roundWindow(r, this.checkpoint).end > counted;
  }
  async count(block, params, inflow) {
    const s = this.s, window = lotteryWindow(params);
    let toMine = inflow;
    if (block.height >= window.start) s.put('lottery/locked', true);
    if (block.height >= window.start && block.height < window.end) {
      const key = `lottery/target/${block.height}`;
      const target = await s.get(key);
      const guesses = [];
      for (let i = 0; i < (target?.count ?? 0); i++) {
        const g = await s.get(`lottery/guess/${block.height}/${i}`);
        guesses.push(g);
        s.del(`lottery/guess/${block.height}/${i}`); s.del(`lottery/seen/${block.height}/${g.address}`);
      }
      const result = lotteryPayout(guesses, block.hash, params.lottery_winners);
      for (const winner of result.winners) await s.add(`bal/${winner.address}`, BigInt(winner.amount));
      toMine -= BigInt(result.paid);
      const record = { tb: block.height, hash: block.hash, ...result };
      s.put(`lottery/result/${block.height}`, record);
      s.put('lottery/recent', [...await s.get('lottery/recent') ?? [], block.height].slice(-12));
      s.put('lottery/targets', (await s.get('lottery/targets') ?? []).filter(h => h !== block.height));
      s.del(key);
    }
    const r = roundAt(block.height, this.checkpoint), config = await this.config(r);
    let capacity = BigInt(await s.get('mine/capacity') ?? config.mine_capacity);
    if (await s.get('mine/capacity_setting') !== config.mine_capacity) {
      capacity = BigInt(config.mine_capacity);
      s.put('mine/capacity_setting', config.mine_capacity);
    }
    const flow = addMineInflow(BigInt(await s.get('pool/game') ?? '0'), BigInt(await s.get('pool/mine_vein') ?? '0'), capacity, toMine, block.hash);
    s.put('pool/game', flow.stock.toString()); s.put('pool/mine_vein', flow.vein.toString());
    s.put('mine/capacity', capacity.toString());
    if (flow.found) s.put('mine/last_vein', { height: block.height, hash: block.hash, amount: flow.released.toString() });
    if (await s.get('mine/armed') !== true && mineArmed(false, flow.stock, capacity)) s.put('mine/armed', true);
    if (block.height === roundWindow(r, this.checkpoint).end) await this.settle(r, block.hash, config, flow.stock, capacity);
  }
  async settle(r, hash, config, stock, capacity) {
    const s = this.s, round = await s.get(`mine/round/${r}`) ?? { count: 0, deposit: '0' };
    const claims = [];
    // No global account/deposit scan: only the records admitted in this round.
    for (let i = 0; i < round.count; i++) {
      const claim = await s.get(`mine/claim/${r}/${i}`);
      const deposit = BigInt(await s.get(`dep/${claim.address}`) ?? '0');
      const exits = await s.get(`exit/${claim.address}`) ?? [];
      const status = await s.get(`mine/strikes/${claim.address}`) ?? { strikes: 0, clean: 0 };
      claims.push({ ...claim, ...status, collateral: (deposit + exits.reduce((sum, x) => sum + BigInt(x.amount), 0n)).toString(), deposit, exits });
    }
    const result = minePayout(claims, stock, capacity, config, await s.get('mine/armed') === true);
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i], row = result.results[i];
      await s.add(`bal/${row.address}`, BigInt(row.amount));
      let remaining = BigInt(row.penalty);
      const fromDeposit = min(remaining, claim.deposit); remaining -= fromDeposit;
      if (fromDeposit > 0n) await s.add(`dep/${row.address}`, -fromDeposit);
      if (remaining > 0n) {
        const exits = [];
        for (const exit of claim.exits) {
          const amount = BigInt(exit.amount), taken = min(amount, remaining); remaining -= taken;
          if (amount > taken) exits.push({ ...exit, amount: (amount - taken).toString() });
        }
        s.put(`exit/${row.address}`, exits);
      }
      s.put(`mine/strikes/${row.address}`, { strikes: row.strikes, clean: row.clean });
      s.put(`mine/result/${row.address}`, { r, ...row });
      s.del(`mine/claim/${r}/${i}`); s.del(`mine/seen/${r}/${row.address}`);
    }
    s.put('pool/game', result.stock); s.put('mine/capacity', result.capacity);
    const { results, ...summary } = result;
    s.put('mine/last', { r, hash, claims: round.count, deposit: round.deposit, ...summary });
    s.del(`mine/round/${r}`);
    const configs = await s.get('mine/configs') ?? [];
    const past = configs.filter(x => x.r <= r + 1);
    if (configs.length) s.put('mine/configs', [...past.slice(-1), ...configs.filter(x => x.r > r + 1)]);
  }
  async state(tip, params) {
    const s = this.s, r = roundAt(tip, this.checkpoint), window = roundWindow(r, this.checkpoint);
    const config = await this.config(r), round = await s.get(`mine/round/${r}`);
    const targets = [];
    for (const tb of await s.get('lottery/targets') ?? []) {
      const target = await s.get(`lottery/target/${tb}`);
      targets.push({ tb, guesses: target.count, accepting: tip <= tb - 3, capacity_left: target.limit - target.count });
    }
    const recent = [];
    for (const tb of await s.get('lottery/recent') ?? []) {
      const record = await s.get(`lottery/result/${tb}`);
      recent.push({ ...record, winner_count: record.winners.length, winners: record.winners.slice(0, 10), winners_truncated: record.winners.length > 10 });
    }
    return {
      lottery: { ...lotteryWindow(params), blocks: params.lottery_blocks, winners: params.lottery_winners,
        locked: !!await s.get('lottery/locked'), open_targets: targets, recent_results: recent },
      mine: { ...window, window_open: tip >= window.start && tip <= window.claim_end,
        S: await s.get('pool/game') ?? '0', C: await s.get('mine/capacity') ?? config.mine_capacity,
        vein_buffer: await s.get('pool/mine_vein') ?? '0', last_guideline: (await s.get('mine/last'))?.guideline ?? '0',
        claim_count: round?.count ?? 0, claim_deposit: round?.deposit ?? '0', params: config,
        last_result: await s.get('mine/last') ?? null, last_vein: await s.get('mine/last_vein') ?? null }
    };
  }
  async account(address, tip, deposit) {
    const s = this.s, r = roundAt(tip, this.checkpoint), config = await this.config(r);
    const claim = await s.get(`mine/seen/${r}/${address}`), round = await s.get(`mine/round/${r}`);
    const d = BigInt(claim?.d ?? deposit), total = BigInt(round?.deposit ?? '0') + (claim ? 0n : d);
    const { guideline } = mineGuideline(BigInt(await s.get('pool/game') ?? '0'), BigInt(await s.get('mine/capacity') ?? config.mine_capacity), config, await s.get('mine/armed') === true);
    return { r, claim: claim ?? null, fair_share_estimate: (total === 0n ? 0n : guideline * d / total).toString(),
      ...await s.get(`mine/strikes/${address}`) ?? { strikes: 0, clean: 0 },
      last_result: await s.get(`mine/result/${address}`) ?? null };
  }
}
