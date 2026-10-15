import { BitcoinBeacon, GENESIS } from './beacon/bitcoin.js';
import { GameState } from './games.js';
import { LAUNCH } from './launch.js';
import { DEFAULT_PARAMS, TYPES, PUZZLE_TYPES, ADDRESS, ISSUANCE, parseAmount, parseEnvelope,
  checkMove, payout, adjustDifficulty, validParam, exactKeys, minimumBits, MINE_DEFAULTS,
  LOTTERY_WINDOW_KEYS, roundAt } from './rules/index.js';

// Read returns values, not Hyperbee entries. Flush the write set only on success.
export class StateTransition {
  constructor(read, beaconOptions = {}) { this.read = read; this.beaconOptions = beaconOptions?.checkpoint ? beaconOptions : { ...beaconOptions, ...LAUNCH }; this.writes = new Map(); this.games = new GameState(this); }
  async get(key) { return this.writes.has(key) ? this.writes.get(key) : await this.read(key); }
  put(key, value) { this.writes.set(key, value); }
  del(key) { this.writes.set(key, undefined); }
  async add(key, amount) { this.put(key, (BigInt(await this.get(key) ?? '0') + amount).toString()); }
  async beacon() { return new BitcoinBeacon({ ...this.beaconOptions, state: await this.get('beacon/state') }); }
  async head() {
    const state = await this.get('beacon/state');
    const checkpoint = this.beaconOptions.checkpoint ?? GENESIS;
    const record = state ? state.records[state.best] : checkpoint;
    return { tip: { height: record.height, hash: record.hash }, counted: state?.counted ?? checkpoint.height,
      hashAt: height => state ? state.hashes[height] : height === checkpoint.height ? checkpoint.hash : null };
  }
  async params(tip) {
    tip ??= (await this.head()).tip.height;
    return { ...DEFAULT_PARAMS, lottery_start_block: this.beaconOptions.coinStart ?? this.games.checkpoint + 1,
      ...(this.beaconOptions.lotteryBlocks ? { lottery_blocks: this.beaconOptions.lotteryBlocks } : {}), ...await this.get('params/current'),
      ...await this.games.config(roundAt(tip, this.games.checkpoint)) };
  }
  async gateways() {
    const out = [];
    for (const addr of await this.get('gw/list') ?? []) out.push({ addr, ...await this.get(`gw/${addr}`) });
    return out;
  }
  async account(address, includeGames = true, tip) {
    tip ??= (await this.head()).tip.height;
    const account = { balance: await this.get(`bal/${address}`) ?? '0', deposit: await this.get(`dep/${address}`) ?? '0',
      exits: await this.get(`exit/${address}`) ?? [], moves_this_height: await this.get(`rate/${tip}/${address}`) ?? 0 };
    if (includeGames) account.mine = await this.games.account(address, tip, account.deposit);
    return account;
  }
  async state() {
    const head = await this.head();
    const params = await this.params(head.tip.height);
    const bits = {};
    for (const t of TYPES) bits[t] = PUZZLE_TYPES.includes(t) ? await this.get(`diff/${t}`) ?? minimumBits(t, params) : 0;
    const tip = head.tip;
    const capacityByType = {};
    for (const t of PUZZLE_TYPES) capacityByType[t] = Math.max(0, params.capacity - (await this.get(`load/${tip.height}/${t}`) ?? 0));
    return { tip, counted: head.counted, bits, capacity_left: Math.max(...Object.values(capacityByType)), capacity_by_type: capacityByType,
      per_address: params.per_address, params, gateways: (await this.gateways()).map(g => ({ ...g, active: g.registered && g.last_beat === tip.height })),
      ...await this.games.state(tip.height, params) };
  }
  async move(text, address) {
    const parsed = parseEnvelope(text);
    if (parsed.error) return parsed.error;
    const e = parsed.envelope;
    const head = await this.head();
    const tip = head.tip.height;
    const params = await this.params(tip);
    const account = await this.account(address, false, tip);
    const load = await this.get(`load/${tip}/${e.t}`) ?? 0;
    const error = checkMove(e, address, { tip, hash: head.hashAt(e.b), params, balance: account.balance, deposit: account.deposit,
      exits: account.exits, counted: head.counted, addressLoad: account.moves_this_height, load,
      bits: await this.get(`diff/${e.t}`) ?? minimumBits(e.t, params), gateway: await this.get(`gw/${address}`) });
    if (error) return error;
    if (e.t === 'header') {
      const beacon = await this.beacon();
      const result = beacon.ingest(e.p.hx, address);
      if (result.error) return result.error;
      if (result.accepted === 0) return 'header_known';
      // Activity/demand are frozen at the pre-message tip for the whole batch.
      const active = (await this.gateways()).filter(g => g.registered && g.last_beat === tip).map(g => g.addr);
      const guessLoad = await this.get(`load/${tip}/guess`) ?? 0;
      for (const block of result.counted) await this.count(block, active, guessLoad);
      this.put('beacon/state', beacon.exportState({ compact: true }));
      for (const block of result.counted) this.put(`hash/${block.height}`, block.hash);
      const checkpoint = this.beaconOptions.checkpoint ?? GENESIS;
      this.put(`hash/${checkpoint.height}`, checkpoint.hash);
    } else if (e.t === 'gw_beat') this.put(`gw/${address}`, { registered: true, last_beat: tip });
    else {
      if (e.t === 'lock') {
        const amount = BigInt(e.p.amount);
        await this.add(`bal/${address}`, -amount); await this.add(`dep/${address}`, amount);
      } else if (e.t === 'unlock') {
        const amount = BigInt(e.p.amount);
        await this.add(`dep/${address}`, -amount);
        const release = head.counted + params.exit_wait;
        const exits = account.exits.map(x => ({ ...x }));
        const existing = exits.find(x => x.release === release);
        if (existing) existing.amount = (BigInt(existing.amount) + amount).toString();
        else exits.push({ amount: amount.toString(), release });
        this.put(`exit/${address}`, exits);
      } else if (e.t === 'guess') {
        const error = await this.games.guess(e.p, address, tip, params); if (error) return error;
      } else if (e.t === 'claim') {
        const error = await this.games.claim(e.p, address, tip, account.deposit, params); if (error) return error;
      } else {
        if (await this.games.pendingClaim(address, head.counted)) return 'claim_pending';
        const released = account.exits.filter(x => x.release <= head.counted);
        await this.add(`bal/${address}`, released.reduce((sum, x) => sum + BigInt(x.amount), 0n));
        this.put(`exit/${address}`, account.exits.filter(x => x.release > head.counted));
      }
      this.put(`load/${tip}/${e.t}`, load + 1);
      this.put(`rate/${tip}/${address}`, account.moves_this_height + 1);
    }
    return null;
  }
  async count(block, active, demand) {
    if (await this.get(`cnt/${block.height}`)) return;
    const current = await this.params();
    const pending = await this.get('params/pending');
    const params = { ...current, ...pending };
    if (pending) { this.put('params/current', params); this.put('params/pending', null); }
    // Only lottery guesses (open to any address) follow demand. Moves that need coins keep the fixed floor.
    for (const t of PUZZLE_TYPES) this.put(`diff/${t}`, t === 'guess'
      ? adjustDifficulty(await this.get(`diff/${t}`) ?? minimumBits(t, current), minimumBits(t, params), demand, params.capacity)
      : minimumBits(t, params));
    if (block.height < params.lottery_start_block) {
      // Before the coin starts the clock runs but nothing is minted.
      this.put(`cnt/${block.height}`, { hash: block.hash, poster: block.poster, minted: '0' });
      return;
    }
    const result = payout(BigInt(await this.get('pool/gwreserve') ?? '0'), active, block.poster);
    await this.add('supply/issued', ISSUANCE);
    await this.games.count(block, params, BigInt(result.game));
    this.put('pool/gwreserve', result.reserve);
    for (const [addr, amount] of Object.entries(result.credits)) await this.add(`bal/${addr}`, BigInt(amount));
    this.put(`cnt/${block.height}`, { hash: block.hash, poster: block.poster, ...result });
  }
  async transaction(type, value, address) {
    if (typeof address !== 'string' || !ADDRESS.test(address)) return 'address';
    if (type === 'transfer') {
      if (!exactKeys(value, ['to', 'amount']) || typeof value.to !== 'string' || !ADDRESS.test(value.to) || parseAmount(value.amount, true) === null) return 'transfer';
      const amount = BigInt(value.amount);
      if (BigInt(await this.get(`bal/${address}`) ?? '0') < amount) return 'balance';
      await this.add(`bal/${address}`, -amount); await this.add(`bal/${value.to}`, amount);
    } else if (type === 'gw_set' || type === 'params_set') {
      if (await this.get('admin') !== address) return 'admin';
      if (type === 'gw_set') {
        if (!exactKeys(value, ['addr', 'on']) || typeof value.addr !== 'string' || !ADDRESS.test(value.addr) || typeof value.on !== 'boolean') return 'gateway';
        const list = await this.get('gw/list') ?? [];
        const previous = await this.get(`gw/${value.addr}`);
        this.put('gw/list', [...new Set([...list, value.addr])].sort());
        this.put(`gw/${value.addr}`, { registered: value.on, last_beat: value.on && previous?.registered ? previous.last_beat : -1 });
      } else {
        if (!exactKeys(value, ['key', 'value']) || !validParam(value.key, value.value)) return 'param';
        if (Object.hasOwn(MINE_DEFAULTS, value.key)) await this.games.schedule(value.key, value.value, (await this.head()).tip.height);
        else {
          if (LOTTERY_WINDOW_KEYS.includes(value.key) && await this.get('lottery/locked')) return 'lottery_locked';
          this.put('params/pending', { ...await this.get('params/pending'), [value.key]: value.value });
        }
      }
    } else return 'transaction';
    return null;
  }
}
