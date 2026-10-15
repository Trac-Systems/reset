import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import Protomux from 'protomux';
import BlindRelay from '../../features/blind-relay/index.js';
import Sidechannel from '../../features/sidechannel/index.js';

// Exercise precisely the transport and ledger versions used by trac-peer.
const requirePeer = createRequire(import.meta.resolve('trac-peer'));
export const Hyperswarm = requirePeer('hyperswarm');
const Autobase = requirePeer('autobase');
const Corestore = requirePeer('corestore');
const Hyperbee = requirePeer('hyperbee');

export async function until(check, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function fixture(t) {
  const root = path.resolve('.test-tmp');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'relay-'));
  const net = await createTestnet(3);
  const peers = [];
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const peer of peers) await peer.relay?.stop();
    for (const peer of peers) await peer.sidechannel?.stop();
    for (const peer of peers) await peer.swarm.destroy();
    for (const peer of peers) await peer.base?.close();
    for (const peer of peers) await peer.store?.close();
    await net.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  async function peer(options = {}) {
    const dht = net.createNode({ firewalled: !!options.blocked });
    await dht.fullyBootstrapped();
    const keyPair = options.keyPair || DHT.keyPair(Buffer.alloc(32, peers.length + 1));
    const swarm = new Hyperswarm({ dht, keyPair, backoffs: [50, 100, 150, 200], jitter: 0 });
    const p = { swarm, wallet: { publicKey: keyPair.publicKey.toString('hex') }, messages: [] };
    peers.push(p);
    swarm.on('connection', (connection) => {
      connection.on('error', () => {});
      connection.userData = Protomux.from(connection);
      if (p.store) p.store.replicate(connection).on('error', () => {});
    });
    if (options.blocked) {
      // Advertise neither an open address nor LAN candidates. Never holepunch.
      // A raw-stream firewall independently prevents any direct UDX packets.
      dht.remoteAddress = () => null;
      swarm.server._shareLocalAddress = false;
      swarm.server._neverPunch = true;
      const original = dht.createRawStream;
      dht.createRawStream = function (opts = {}) {
        const originalFirewall = opts.firewall;
        const blockedOptions = { ...opts, firewall(socket, port, host) {
          if (p.blockedPorts?.has(port)) { p.directPacketsBlocked++; return true; }
          return originalFirewall ? originalFirewall(socket, port, host) : false;
        } };
        return original.call(this, blockedOptions);
      };
      p.blockedPorts = new Set();
      p.directPacketsBlocked = 0;
      const connect = dht.connect;
      dht.connect = function (remote, opts = {}) {
        return connect.call(this, remote, { ...opts, localConnection: false });
      };
    }
    await swarm.listen();
    return p;
  }
  async function relay(p, options) {
    p.relay = new BlindRelay(p, { directTimeoutMs: 250, relayTimeoutMs: 2500, ...options });
    await p.relay.start();
    return p.relay;
  }
  function block(a, b) {
    a.blockedPorts.add(b.swarm.dht.address().port);
    b.blockedPorts.add(a.swarm.dht.address().port);
    for (const [local, remote] of [[a, b], [b, a]]) {
      const firewall = local.swarm.server.firewall;
      local.swarm.server.firewall = (key, payload, addr) => {
        if (key.equals(remote.swarm.keyPair.publicKey) && !payload?.relayThrough) {
          local.directPacketsBlocked++;
          return true;
        }
        return firewall.call(local.swarm.server, key, payload, addr);
      };
    }
  }
  async function ledger(p, bootstrap = null) {
    p.store = new Corestore(path.join(dir, String(peers.indexOf(p))));
    p.base = new Autobase(p.store, bootstrap, {
      valueEncoding: 'json', ackInterval: 50,
      open: (store) => new Hyperbee(store.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json' }),
      apply: async (nodes, view, host) => {
        for (const { value } of nodes) {
          if (!value) continue;
          if (value.writer) await host.addWriter(Buffer.from(value.writer, 'hex'), { indexer: false });
          else await view.put(value.key, value.value);
        }
      },
    });
    await p.base.ready();
    return p.base;
  }
  async function sidechannel(p) {
    p.sidechannel = new Sidechannel(p, { channels: ['relay-test'], entryChannel: 'relay-test',
      powEnabled: false, welcomeRequired: false, inviteRequired: false,
      onMessage: (_channel, payload) => p.messages.push(payload.message) });
    await p.sidechannel.start();
  }
  function connect(p, remote, options = {}) {
    const socket = p.swarm.dht.connect(remote, options);
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  }
  return { peer, relay, block, ledger, sidechannel, connect, net, peers, track: (socket) => sockets.add(socket) };
}
