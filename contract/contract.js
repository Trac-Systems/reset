import { Contract } from 'trac-peer';
import { StateTransition } from './state.js';

export default class CoinContract extends Contract {
  constructor(protocol, options = {}) {
    super(protocol, options);
    for (const name of ['transfer', 'gw_set', 'params_set']) this.addFunction(name);
    this.messageHandler(async () => {
      const transition = this.transition();
      const error = await transition.move(this.op.msg, this.address);
      return this.finish(transition, error);
    });
  }
  transition() { return new StateTransition(key => this.get(key), this.config.beaconOptions); }
  async finish(transition, error) {
    if (error) return new Error(error);
    for (const [key, value] of transition.writes) {
      if (value === undefined) await this.del(key);
      else await this.put(key, value);
    }
    return null;
  }
  async applyTransaction(type) {
    const transition = this.transition();
    const error = await transition.transaction(type, this.value, this.address);
    return this.finish(transition, error);
  }
  async transfer() { return this.applyTransaction('transfer'); }
  async gw_set() { return this.applyTransaction('gw_set'); }
  async params_set() { return this.applyTransaction('params_set'); }
}
