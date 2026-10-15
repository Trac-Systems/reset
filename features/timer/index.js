import {Feature} from 'trac-peer';

export class Timer extends Feature {

    constructor(peer, options = {}) {
        super(peer, options);
        this.update_interval = options.update_interval !== undefined &&
                                false === isNaN(parseInt(options.update_interval)) &&
                                parseInt(options.update_interval) > 0 ? parseInt(options.update_interval) : 60_000;
    }

    async start(options = {}) {
        while(true){
            await this.append('currentTime', Date.now());
            await this.sleep(this.update_interval);
        }
    }

    async stop(options = {}) { }
}

export default Timer;