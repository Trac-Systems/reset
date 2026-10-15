import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'blind-relay';
import NoiseSecretStream from '@hyperswarm/secret-stream';
import { fixture, until } from './helpers/blind-relay.mjs';
import { relayConfigFromFlags } from '../features/blind-relay/config.js';

const key = (p) => p.swarm.keyPair.publicKey;

test('flags validate exact keys and positive finite limits', () => {
  const relay = 'ab'.repeat(32);
  const config = relayConfigFromFlags({ 'blind-relay': `${relay},${relay.toUpperCase()}`, 'blind-relay-serve': '1', 'blind-relay-max-sessions': '4' });
  assert.deepEqual(config.relays, [relay]);
  assert.equal(config.serve, true);
  assert.equal(config.maxSessions, 4);
  for (const value of ['0', '-1', 'NaN', '2junk', '1.5', 'Infinity']) {
    assert.throws(() => relayConfigFromFlags({ 'blind-relay-max-sessions': value }));
  }
  assert.throws(() => relayConfigFromFlags({ 'blind-relay': 'not-a-key' }));
  assert.throws(() => relayConfigFromFlags({ 'blind-relay-serve': 'yes' }));
});

test('blocked peers replicate admin and writer entries and sidechannels over a real blind relay', { timeout: 35_000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.peer();
  await f.relay(server, { serve: true });
  const admin = await f.peer({ blocked: true });
  const writer = await f.peer({ blocked: true });
  f.block(admin, writer);
  await f.ledger(admin);
  await f.ledger(writer, admin.base.key);
  for (const p of [admin, writer]) await f.relay(p, { relays: [key(server).toString('hex')] });
  await admin.base.append({ writer: writer.base.local.key.toString('hex') });
  await admin.base.append({ key: 'admin-entry', value: 'private-ledger-payload-7ee7315d' });
  admin.swarm.joinPeer(key(writer));
  await until(() => server.relay.stats().active_pairs > 0, 'relay pair');
  await until(async () => {
    await writer.base.update();
    return (await writer.base.view.get('admin-entry'))?.value === 'private-ledger-payload-7ee7315d';
  }, 'admin replication');
  await until(() => writer.base.writable, 'writer admitted');
  await writer.base.append({ key: 'writer-entry', value: 'writer-through-relay' });
  await until(async () => {
    await admin.base.update();
    return (await admin.base.view.get('writer-entry'))?.value === 'writer-through-relay';
  }, 'writer replication');
  await Promise.all([f.sidechannel(admin), f.sidechannel(writer)]);
  await until(() => [...admin.sidechannel.connections.values()].some((map) => map.get('relay-test')?.channel.opened), 'sidechannel open', 3000);
  assert.equal(admin.sidechannel.broadcast('relay-test', 'private-sidechannel-payload-45bc'), true);
  await until(() => writer.messages.includes('private-sidechannel-payload-45bc'), 'sidechannel delivery');
  assert.ok(admin.directPacketsBlocked + writer.directPacketsBlocked > 0);
  server.relay._sweep();
  assert.ok(server.relay.stats().bytes > 0);
  assert.equal(server.relay.stats().peers_relayed, 2);
  assert.equal(admin.relay.stats().client_connections, 1);
  const a = await Array.fromAsync(admin.base.view.createReadStream());
  const b = await Array.fromAsync(writer.base.view.createReadStream());
  assert.deepEqual(a.map(({ key, value }) => ({ key, value })), b.map(({ key, value }) => ({ key, value })));
});

test('relay outage retries, falls back to another relay, and recovers on return', { timeout: 35_000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.peer();
  const backup = await f.peer();
  await f.relay(first, { serve: true });
  await f.relay(backup, { serve: true });
  const a = await f.peer({ blocked: true });
  const b = await f.peer({ blocked: true });
  f.block(a, b);
  await f.ledger(a);
  await f.ledger(b, a.base.key);
  const relays = [key(first).toString('hex'), key(backup).toString('hex')];
  for (const p of [a, b]) await f.relay(p, { relays });
  a.swarm.joinPeer(key(b));
  await until(() => first.relay.stats().active_pairs === 1, 'first relay connected');
  await first.relay.stop();
  await first.swarm.destroy();
  // A write makes the broken path observable even without application traffic.
  await a.base.append({ key: 'outage', value: 'backup' });
  await until(() => backup.relay.stats().active_pairs === 1, 'backup connected', 20_000);
  await until(async () => { await b.base.update(); return (await b.base.view.get('outage'))?.value === 'backup'; }, 'backup replication');
  await backup.relay.stop();
  await backup.swarm.destroy();
  const returned = await f.peer({ keyPair: first.swarm.keyPair });
  await f.relay(returned, { serve: true });
  await a.base.append({ key: 'returned', value: true });
  await until(async () => { await b.base.update(); return (await b.base.view.get('returned'))?.value; }, 'returned relay replication', 20_000);
  assert.ok(returned.relay.stats().active_pairs > 0);
});

test('direct connections remain direct; stop restores all client hooks and restart is safe', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.peer();
  await f.relay(server, { serve: true });
  const a = await f.peer();
  const b = await f.peer();
  const originals = [a.swarm.dht.connect, a.swarm.relayThrough, a.swarm.server.firewall, a.swarm.server._relayConnection];
  await f.relay(a, { relays: [key(server).toString('hex')] });
  a.swarm.joinPeer(key(b));
  await until(() => a.swarm.connections.size === 1, 'direct connection');
  assert.equal(a.relay.stats().relay_attempts, 0);
  assert.equal(server.relay.stats().active_pairs, 0);
  await a.relay.stop();
  assert.deepEqual([a.swarm.dht.connect, a.swarm.relayThrough, a.swarm.server.firewall, a.swarm.server._relayConnection], originals);
  await a.relay.start();
  await a.relay.start();
  assert.equal(a.swarm.listeners('connection').filter((fn) => fn === a.relay.onConnection).length, 1);
});

test('relay handler buffers contain ciphertext, while endpoints receive the known payload', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.peer();
  const captured = [];
  // Production UDX relayTo bypasses JS entirely. For this audit only, forward
  // raw bytes through JS so the exact buffers can be inspected. The other
  // integration tests cover native forwarding with HyperDHT and Autobase.
  const createRawStream = server.swarm.dht.createRawStream;
  server.swarm.dht.createRawStream = function (options) {
    const stream = createRawStream.call(this, options);
    stream.relayTo = (destination) => {
      stream.on('data', (chunk) => {
        captured.push(Buffer.from(chunk));
        if (destination.connected) destination.write(chunk);
        else destination.once('connect', () => destination.write(chunk));
      });
      return stream;
    };
    return stream;
  };
  server.swarm.on('connection', (connection) => {
    connection.on('data', (chunk) => captured.push(Buffer.from(chunk)));
  });
  await f.relay(server, { serve: true });
  const a = await f.peer();
  const b = await f.peer();
  const ca = await control(f, a, server);
  const cb = await control(f, b, server);
  const ar = pair(ca, 8, true);
  const br = pair(cb, 8, false);
  await until(() => ar.connected && br.connected, 'audit pair connected');
  await Promise.all([ar.send(Buffer.alloc(1)), br.send(Buffer.alloc(1))]);
  await until(() => [...server.relay.streams.keys()].every(stream => stream.connected), 'audit ingress learned');
  // Same Noise implementation as HyperDHT, with fresh local test identities.
  const left = new NoiseSecretStream(true, ar);
  const right = new NoiseSecretStream(false, br);
  left.on('error', () => {});
  right.on('error', () => {});
  f.track(left);
  f.track(right);
  const received = [[], []];
  left.on('data', (chunk) => received[0].push(Buffer.from(chunk)));
  right.on('data', (chunk) => received[1].push(Buffer.from(chunk)));
  const payload = Buffer.from('known-private-message-f8051f784f64450f' + 'a'.repeat(5000));
  left.write(payload);
  right.write(payload);
  await until(() => received.every((chunks) => Buffer.concat(chunks).equals(payload)), 'private payload delivered', 3000);
  const wire = Buffer.concat(captured);
  assert.ok(wire.length > payload.length * 2, 'captured real forwarding buffers');
  assert.equal(wire.includes(payload.subarray(0, 40)), false);
  assert.equal(wire.includes(Buffer.from('a'.repeat(100))), false);
  assert.equal(server.relay.stats().active_pairs, 1);
});

async function control(f, p, server) {
  const socket = f.connect(p, key(server));
  const client = Client.from(socket, { id: socket.publicKey });
  client.on('error', () => {});
  await until(() => [...server.relay.sessions.values()].some((s) => s.peer === socket.publicKey.toString('hex')), 'control accepted');
  return { socket, client, p };
}

function pair(control, token, initiator) {
  const raw = control.p.swarm.dht.createRawStream();
  raw.on('error', () => {});
  const close = () => raw.destroy();
  control.socket.once('close', close);
  raw.once('close', () => control.socket.off('close', close));
  const request = control.client.pair(initiator, Buffer.alloc(32, token), raw);
  request.on('error', () => raw.destroy());
  request.on('data', (remoteId) => {
    const { socket, remotePort, remoteHost } = control.socket.rawStream;
    raw.connect(socket, remoteId, remotePort, remoteHost);
  });
  return raw;
}

for (const [name, options] of [
  ['per-peer pending quota', { maxSessionsPerPeer: 1 }],
  ['global pending quota', { maxPending: 1 }],
]) {
  test(`relay enforces ${name} before allocating another token`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    const server = await f.peer();
    await f.relay(server, { serve: true, ...options });
    const p = await f.peer();
    const c = await control(f, p, server);
    pair(c, 1, true);
    await until(() => server.relay.stats().pending_pairs === 1, 'first token');
    pair(c, 2, true);
    await until(() => server.relay.stats().pairs_rejected === 1, 'token rejected');
    await until(() => server.relay.stats().pending_pairs === 0, 'rejected session cleaned');
  });
}

test('relay caps control sessions and active pairs', { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.peer();
  await f.relay(server, { serve: true, maxClients: 2, maxSessions: 1 });
  const a = await f.peer();
  const b = await f.peer();
  const c = await f.peer();
  const ca = await control(f, a, server);
  const cb = await control(f, b, server);
  const rejected = f.connect(c, key(server));
  Client.from(rejected, { id: rejected.publicKey }).on('error', () => {});
  await until(() => server.relay.stats().sessions_rejected === 1, 'third session rejected');
  assert.equal(server.relay.stats().sessions, 2);
  pair(ca, 3, true);
  pair(cb, 3, false);
  await until(() => server.relay.stats().active_pairs === 1, 'first pair');
  let maximum = 0;
  for (const { session } of server.relay.sessions.values()) {
    session.on('pair', () => { maximum = Math.max(maximum, server.relay.stats().active_pairs); });
  }
  pair(ca, 4, true);
  pair(cb, 4, false);
  await until(() => server.relay.stats().pairs_rejected === 1, 'second pair rejected');
  assert.ok(maximum <= 1);
});

test('idle pending tokens, idle active pairs and control sessions expire', { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.peer();
  await f.relay(server, { serve: true, idleTimeoutMs: 200, sweepIntervalMs: 20 });
  const a = await f.peer();
  const b = await f.peer();
  const ca = await control(f, a, server);
  const cb = await control(f, b, server);
  pair(ca, 5, true);
  pair(cb, 5, false);
  pair(ca, 6, true);
  await until(() => server.relay.stats().active_pairs === 1, 'idle pair established');
  await until(() => server.relay.stats().sessions === 0, 'idle resources reclaimed');
  assert.equal(server.relay.stats().active_pairs, 0);
  assert.equal(server.relay.stats().pending_pairs, 0);
  assert.ok(server.relay.stats().idle_closed >= 2);
});

test('aggregate byte-rate budget closes a busy relay pair', { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.peer();
  await f.relay(server, { serve: true, rateBytesPerSecond: 1, rateBurstBytes: 4096, sweepIntervalMs: 20 });
  const a = await f.peer();
  const b = await f.peer();
  const ca = await control(f, a, server);
  const cb = await control(f, b, server);
  const ar = pair(ca, 7, true);
  const br = pair(cb, 7, false);
  ar.on('data', () => {});
  br.on('data', () => {});
  await until(() => ar.connected && br.connected, 'raw pair connected');
  ar.write(Buffer.alloc(64 * 1024, 17));
  await until(() => server.relay.stats().rate_limited > 0, 'rate cutoff');
  await until(() => server.relay.stats().active_pairs === 0, 'rate limited pair closed');
  assert.ok(server.relay.stats().bytes >= 4096);
});

test('cancelled token bookkeeping stays bounded and the existing firewall is preserved', { timeout: 6000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.peer();
  await f.relay(server, { serve: true, maxPending: 2 });
  const a = await f.peer();
  const c = await control(f, a, server);
  for (let token = 30; token < 40; token++) {
    const raw = pair(c, token, true);
    await until(() => server.relay.stats().pending_pairs === 1, 'token added');
    c.client.unpair(Buffer.alloc(32, token));
    raw.destroy();
    await until(() => server.relay.stats().pending_pairs === 0, 'token cancelled');
    assert.equal([...server.relay.sessions.values()][0].pending.size, 0);
  }
  a.swarm.server.firewall = () => true;
  await f.relay(a, { relays: [key(server).toString('hex')] });
  assert.equal(await a.swarm.server.firewall(key(server), { relayThrough: { publicKey: key(server) } }), true);
});
