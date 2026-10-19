import fs from 'fs';
import path from 'path';
import process from 'process';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { Peer, Wallet, createConfig, ENV } from 'trac-peer';
import { ensureTextCodecs } from 'trac-peer/src/textCodec.js';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as msbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';
import CoinProtocol from '../contract/protocol.js';
import CoinContract from '../contract/contract.js';
import Gateway from '../features/gateway/index.js';
import BlindRelay from '../features/blind-relay/index.js';
import Sidechannel from '../features/sidechannel/index.js';
import { MineChat, CHAT_CHANNEL } from '../features/chat/index.js';
import { relayConfigFromFlags } from '../features/blind-relay/config.js';
import { validateConfig, validateFlags } from './config.js';
import { LAUNCH } from '../contract/launch.js';
import { adminCommand, until } from './admin.js';
import { fanOutValidatorSends } from './fanout.js';

export const MAX_TX_DELAY_SECONDS = 6 * 3600;
export const TX_POOL_MAX_SIZE = 10_000;

async function walletAt(filename, WalletClass, options) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const wallet = new WalletClass(options); await wallet.ready;
  if (fs.existsSync(filename)) wallet.importFromFile(filename, b4a.alloc(0));
  else {
    await wallet.generateKeyPair(null, options.derivationPath);
    wallet.exportToFile(filename, b4a.alloc(0));
    fs.chmodSync(filename, 0o600);
  }
  return wallet;
}

export async function runConfiguredPeer(flags) {
  if (!globalThis.Bare) throw new Error('Configured peers require the Pear runner');
  validateFlags(flags);
  const role = flags.role, devnet = flags['devnet-control'] === '1';
  const config = JSON.parse(fs.readFileSync(flags.config, 'utf8'));
  if (flags['gateway-port'] !== undefined) config.gatewayPort = Number(flags['gateway-port']);
  if (flags['gateway-header-source'] !== undefined) config.headerSource = flags['gateway-header-source'];
  validateConfig(role, config, { devnet });
  const relayConfig = relayConfigFromFlags({ ...flags,
    'blind-relay': flags['blind-relay'] ?? config.relayKeys?.join(',') });
  const gateways = flags['gateways-file'] ? JSON.parse(fs.readFileSync(flags['gateways-file'], 'utf8')) : [];
  let bus, peer, gateway, relay, control, closing, sidechannel;
  let finish;
  const lifetime = new Promise(resolve => { finish = resolve; });
  const close = () => closing ??= (async () => {
    control?.stop();
    // Close every resource even if a preceding close failed.
    let failure;
    for (const stop of [() => gateway?.stop(), () => sidechannel?.stop(), () => relay?.stop(), () => peer?.close(),
      () => peer?.store.close(), () => bus?.close()]) {
      try { await stop(); } catch (error) { failure ??= error; }
    }
    finish();
    if (failure) throw failure;
  })();
  const shutdown = () => void close().then(() => process.exit(0), error => {
    console.error(error.message); process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, shutdown);
  globalThis.Pear?.teardown?.(shutdown);
  try {
    await ensureTextCodecs();
    const mc = msbConfig(MSB_ENV[config.environment.toUpperCase()], {
      bootstrap: config.msbBootstrap, channel: config.msbChannel, dhtBootstrap: config.msbDhtBootstrap,
      storesDirectory: config.storeDirectory, storeName: 'msb', enableInteractiveMode: false,
      enableWallet: true, enableRoleRequester: false, enableValidatorObserver: !devnet, enableTxApplyLogs: false });
    const options = { networkPrefix: mc.addressPrefix, derivationPath: mc.derivationPath };
    bus = new MainSettlementBus(mc, await walletAt(mc.keyPairPath, PeerWallet, options)); await bus.ready();
    fanOutValidatorSends(bus.network);
    if (devnet) {
      await bus.network.tryConnect(config.validatorKey, 'validator');
      await until(() => bus.state.getAdminEntry(), 'local MSB synchronized');
      await until(() => bus.network.validatorConnectionManager.connectionCount() > 0, 'local MSB validator connection');
    }
    const bootstrapFile = path.join(config.storeDirectory, 'subnet-bootstrap.hex');
    let bootstrap = config.subnetBootstrap;
    const persisted = fs.existsSync(bootstrapFile) ? fs.readFileSync(bootstrapFile, 'utf8').trim() : null;
    if (persisted && !/^[0-9a-f]{64}$/.test(persisted)) throw new Error('Invalid persisted subnet bootstrap');
    if (bootstrap && persisted && bootstrap !== persisted) throw new Error('Configured subnet differs from this store');
    bootstrap ??= persisted;
    const pc = createConfig(ENV[config.environment.toUpperCase()], {
      storesDirectory: config.storeDirectory, storeName: 'peer', bootstrap, channel: config.subnetChannel,
      dhtBootstrap: config.peerDhtBootstrap, txContentHash: 'utf8-strict', enableInteractiveMode: false,
      replicate: true, enableUpdater: true, enableBackgroundTasks: true, enableTxlogs: false,
      apiMsgExposed: role === 'gateway', apiTxExposed: role === 'gateway',
      // Indexers can hold transactions back for hours while they sign a backlog (3 h seen); trac-peer's default 60 s
      // dropped transfers that the MSB then appended late, so they were never applied here. A full pool would stop
      // tracking new transfers, so it grows with the longer wait.
      maxTxDelay: MAX_TX_DELAY_SECONDS, txPoolMaxSize: TX_POOL_MAX_SIZE });
    // Without this explicit local-test option StateTransition uses contract/launch.js.
    if (devnet) pc.beaconOptions = config.beaconOptions;
    else if (config.rehearsal) pc.beaconOptions = { ...LAUNCH, coinStart: config.rehearsal.coinStart, lotteryBlocks: config.rehearsal.lotteryBlocks };
    peer = new Peer({ config: pc, msb: bus, wallet: await walletAt(pc.keyPairPath, Wallet, options),
      protocol: CoinProtocol, contract: CoinContract }); await peer.ready();
    if (!persisted) fs.writeFileSync(bootstrapFile, peer.base.key.toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    if (relayConfig.serve || relayConfig.relays.length) {
      relay = new BlindRelay(peer, relayConfig); await relay.start(); peer.blindRelay = relay;
      console.log('[blind-relay]', JSON.stringify(relay.stats()));
    }
    let chat = null;
    if (role === 'gateway' && config.chat) {
      // Miners' chat: an open p2p sidechannel; the gateway also serves it over HTTP (features/chat).
      const viewerKeys = config.chat.viewerKeyFile ? [fs.readFileSync(config.chat.viewerKeyFile, 'utf8').trim()] : [];
      chat = new MineChat(peer, { viewerKeys });
      sidechannel = new Sidechannel(peer, { channels: [CHAT_CHANNEL], openChannels: [CHAT_CHANNEL], powEnabled: false,
        onMessage: (channel, payload) => { if (channel === CHAT_CHANNEL) void chat.receive(payload); } });
      chat.sidechannel = sidechannel;
      peer.sidechannel = sidechannel;
      await sidechannel.start();
    }
    if (role === 'gateway') {
      gateway = new Gateway(peer, { chat, msb: bus, port: config.gatewayPort ?? 49223, headerSource: config.headerSource ?? 'off', trustProxy: config.trustProxy === true,
        ...(config.headerDelayMs !== undefined ? { headerDelayMs: config.headerDelayMs } : {}),
        ...(devnet ? { pollMs: 100, ipLimit: 10000, addressLimit: 10000 } : {}) });
      await peer.protocol.instance.addFeature('gateway', gateway); await gateway.start();
    }
    if (devnet) {
      const { startControl } = await import('../scripts/lib/pear-devnet-control.js');
      control = startControl({ peer, bus, relay, close });
    }
    const info = { role, runtime: 'pear', bareVersion: Bare.version, pid: process.pid,
      address: peer.wallet.publicKey, msbAddress: peer.wallet.address, writerKey: peer.writerLocalKey,
      subnetBootstrap: peer.base.key.toString('hex'), swarmPublicKey: peer.swarm.keyPair.publicKey.toString('hex'),
      gatewayUrl: gateway?.url ?? null, context: { networkId: peer.msbClient.networkId,
        incomingWritingKey: peer.writerLocalKey, subnetBootstrap: peer.base.key.toString('hex'),
        msbBootstrap: peer.protocol.instance.api.getPeerMsbBootstrap() } };
    console.log('PEER_READY ' + JSON.stringify(info));
    if (flags['admin-command']) {
      await adminCommand(peer, bus, flags['admin-command'], gateways);
      console.log('ADMIN_DONE ' + flags['admin-command']);
      await close();
      process.exit(0);
    } else await lifetime;
  } catch (error) {
    await close(); throw error;
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, shutdown);
  }
}
