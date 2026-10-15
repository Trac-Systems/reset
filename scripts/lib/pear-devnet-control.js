// Private stdin fixture control, imported only after --devnet-control validation.
// No socket, arbitrary evaluation, key export or player signing commands.
import process from 'process';
import { stableJSON } from '../../contract/rules/index.js';
import { adminCommand, settled } from '../../runtime/admin.js';

export function startControl({ peer, bus, relay, close }) {
  const api = peer.protocol.instance.api;
  const commands = {
    admin: ({ command, gateways }) => adminCommand(peer, bus, command, gateways).then(() => true),
    params: async ({ key, value }) => settled(peer, await peer.protocol.instance.tx({ command: JSON.stringify({ op: 'params_set', key, value }) })),
    get: async ({ key }) => (await peer.base.view.get(key))?.value ?? null,
    rows: async () => {
      const rows = []; for await (const { key, value } of peer.base.view.createReadStream()) rows.push([key, value]);
      return rows;
    },
    status: async () => {
      await peer.base.update();
      return { version: peer.base.view.version, writable: peer.base.writable, indexer: peer.base.isIndexer,
        state: await api.coinState(), relay: relay?.stats() ?? null };
    },
    account: ({ address }) => api.coinAccount(address),
    settled: ({ result }) => settled(peer, result),
    // Only the gateway's own operator wallet signs fixture headers/gifts.
    header: async ({ hx }) => {
      const state = await api.coinState();
      const prepared = api.prepareMessage(stableJSON({ b: state.tip.height, h: state.tip.hash,
        p: { hx: [hx] }, t: 'header', v: 1, w: '0' }), peer.wallet.publicKey);
      const nonce = api.generateNonce();
      return { prepared, nonce, signature: peer.wallet.sign(JSON.stringify(prepared) + nonce) };
    },
    gift: async ({ address, amount }) => settled(peer, await peer.protocol.instance.tx({ command: JSON.stringify({ op: 'transfer', to: address, amount }) })),
    close: async () => { await close(); return true; },
  };
  let pending = '', queue = Promise.resolve();
  const onData = chunk => {
    pending += chunk.toString();
    if (pending.length > 65536) { void close(); return; }
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      queue = queue.then(async () => {
        let id;
        try {
          const request = JSON.parse(line); id = request.id;
          if (!Object.hasOwn(commands, request.command)) throw new Error('Unknown fixture command');
          const value = await commands[request.command](request.args ?? {});
          console.log('DEVNET_REPLY ' + JSON.stringify({ id, value }));
        } catch (error) { console.log('DEVNET_REPLY ' + JSON.stringify({ id, error: error.message })); }
      });
    }
  };
  const onEnd = () => void close();
  process.stdin.on('data', onData); process.stdin.once('end', onEnd);
  return { stop() { process.stdin.removeListener('data', onData); process.stdin.removeListener('end', onEnd); process.stdin.pause(); } };
}
