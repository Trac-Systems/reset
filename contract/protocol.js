import SidechannelProtocol from '../features/sidechannel/commands.js';
import { StateTransition } from './state.js';
import { parseJSON, exactKeys, parseAmount, ADDRESS, validParam } from './rules/index.js';

export default class CoinProtocol extends SidechannelProtocol {
  async withView(fn) {
    const view = this.base.view.checkout(this.base.view.version);
    const state = new StateTransition(async key => (await view.get(key))?.value ?? null, this.config.beaconOptions);
    try { return await fn(state, view); }
    finally { await view.close(); }
  }
  async extendApi() {
    this.api.coinState = () => this.withView(s => s.state());
    this.api.coinAccount = address => this.withView(s => s.account(address));
    this.api.coinPools = () => this.withView(async s => ({ game: await s.get('pool/game') ?? '0', mine_vein: await s.get('pool/mine_vein') ?? '0', gateway_reserve: await s.get('pool/gwreserve') ?? '0', issued: await s.get('supply/issued') ?? '0' }));
    this.api.coinHashAt = height => this.withView(async s => (await s.beacon()).hashAt(height) ?? await s.get(`hash/${height}`));
  }
  mapTxCommand(command) {
    const value = parseJSON(command, 4096);
    if (!value || typeof value.op !== 'string') return null;
    if (value.op === 'transfer' && exactKeys(value, ['op', 'to', 'amount']) && typeof value.to === 'string' && ADDRESS.test(value.to) && parseAmount(value.amount, true) !== null)
      return { type: 'transfer', value: { to: value.to, amount: value.amount } };
    if (value.op === 'gw_set' && exactKeys(value, ['op', 'addr', 'on']) && typeof value.addr === 'string' && ADDRESS.test(value.addr) && typeof value.on === 'boolean')
      return { type: 'gw_set', value: { addr: value.addr, on: value.on } };
    if (value.op === 'params_set' && exactKeys(value, ['op', 'key', 'value']) && validParam(value.key, value.value))
      return { type: 'params_set', value: { key: value.key, value: value.value } };
    return null;
  }
}
