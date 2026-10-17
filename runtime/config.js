// Shared validation; runs before a configured peer opens stores or the network.
import path from 'path';
import { LAUNCH } from '../contract/launch.js';

const hex = /^[0-9a-f]{64}$/;
const fields = new Set(['environment', 'msbBootstrap', 'msbChannel', 'msbDhtBootstrap',
  'peerDhtBootstrap', 'subnetBootstrap', 'subnetChannel', 'relayKeys', 'gatewayPort',
  'headerSource', 'storeDirectory', 'beaconOptions', 'validatorKey', 'rehearsal', 'trustProxy', 'headerDelayMs', 'chat']);

export function validateConfig(role, config, { devnet = false } = {}) {
  if (!['indexer', 'gateway', 'relay'].includes(role)) throw new Error('role must be indexer, gateway or relay');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a peer configuration object');
  for (const key of Object.keys(config)) if (!fields.has(key)) throw new Error(`Unknown peer config field: ${key}`);
  if (!['development', 'testnet1', 'mainnet'].includes(config.environment)) throw new Error('Set an explicit environment');
  if (!hex.test(config.msbBootstrap ?? '')) throw new Error('Explicit MSB bootstrap required');
  for (const key of ['msbChannel', 'subnetChannel']) {
    if (typeof config[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(config[key])) throw new Error(`Explicit ${key} (1–32 ASCII characters) required`);
  }
  for (const key of ['msbDhtBootstrap', 'peerDhtBootstrap']) {
    if (!Array.isArray(config[key]) || !config[key].length || config[key].some(x => {
      if (typeof x !== 'string' || !/^[a-zA-Z0-9.\[\]:-]+:\d+$/.test(x)) return true;
      const port = Number(x.slice(x.lastIndexOf(':') + 1));
      return port < 1 || port > 65535;
    })) throw new Error(`Explicit ${key} required`);
  }
  if (config.subnetBootstrap !== null && !hex.test(config.subnetBootstrap ?? '')) throw new Error('subnetBootstrap must be hex32 or explicit null');
  if (config.subnetBootstrap === config.msbBootstrap) throw new Error('Subnet bootstrap cannot equal MSB bootstrap');
  if (role === 'gateway' && !hex.test(config.subnetBootstrap ?? '')) throw new Error('Gateway requires the indexer subnet bootstrap');
  if (role === 'relay' && (config.subnetBootstrap !== null || !config.subnetChannel.startsWith('relay-'))) throw new Error('Transport relay requires its own relay- channel and subnet');
  if (config.relayKeys !== undefined && (!Array.isArray(config.relayKeys) || config.relayKeys.some(x => !hex.test(x)))) throw new Error('Invalid relay keys');
  if (config.gatewayPort !== undefined && (!Number.isInteger(config.gatewayPort) || config.gatewayPort < (devnet ? 0 : 1024) || config.gatewayPort > 65535)) throw new Error('Invalid gateway port');
  if (config.trustProxy !== undefined && (typeof config.trustProxy !== 'boolean' || role !== 'gateway')) throw new Error('trustProxy is a gateway boolean');
  if (config.headerDelayMs !== undefined && (!Number.isSafeInteger(config.headerDelayMs) || config.headerDelayMs < 0 ||
    config.headerDelayMs > 600000 || role !== 'gateway')) throw new Error('headerDelayMs is a gateway delay of 0..600000 ms');
  if (config.chat !== undefined) {
    const c = config.chat;
    if (role !== 'gateway' || !c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some(k => k !== 'viewerKeyFile') ||
        (c.viewerKeyFile !== undefined && (typeof c.viewerKeyFile !== 'string' || !path.isAbsolute(c.viewerKeyFile))))
      throw new Error('chat is a gateway object with an optional absolute viewerKeyFile');
  }
  if (config.headerSource !== undefined && config.headerSource !== 'off' && !/^https?:\/\//.test(config.headerSource)) throw new Error('Invalid header source');
  if (!path.isAbsolute(config.storeDirectory ?? '') || path.resolve(config.storeDirectory) !== config.storeDirectory) throw new Error('Explicit absolute storeDirectory required');
  if (devnet) {
    if (config.environment !== 'development' || !hex.test(config.validatorKey ?? '') ||
        [...config.msbDhtBootstrap, ...config.peerDhtBootstrap].some(x => !/^127\.0\.0\.1:\d+$/.test(x)) ||
        !config.beaconOptions?.checkpoint || config.beaconOptions.checkpoint.height !== 0 ||
        config.beaconOptions.params?.powLimitBits !== 0x207fffff ||
        !config.storeDirectory.startsWith(path.resolve('.devnet') + path.sep)) {
      throw new Error('Devnet control requires disposable .devnet stores, development, loopback bootstrap and test beacon');
    }
    if (config.headerSource && config.headerSource !== 'off') throw new Error('Devnet header source must be off');
  } else {
    if (config.beaconOptions !== undefined || config.validatorKey !== undefined) throw new Error('Test beacon/validator options require --devnet-control 1');
    if (config.rehearsal !== undefined) validateRehearsal(role, config);
    else if (!new RegExp(`^/srv/reset/${role}(?:-[a-z0-9-]+)?$`).test(config.storeDirectory)) throw new Error('Store must be a role directory under /srv/reset');
  }
  return config;
}

// A rehearsal is a throwaway subnet on mainnet with its own coin start and a shorter lottery.
// Its stores live in .rehearsal/ next to the code; it never uses the launch subnet's stores.
function validateRehearsal(role, config) {
  const r = config.rehearsal;
  if (!r || typeof r !== 'object' || Object.keys(r).some(k => !['coinStart', 'lotteryBlocks'].includes(k))) throw new Error('rehearsal takes coinStart and lotteryBlocks');
  if (config.environment !== 'mainnet') throw new Error('A rehearsal runs on mainnet');
  if (!Number.isSafeInteger(r.coinStart) || r.coinStart <= LAUNCH.checkpoint.height) throw new Error('rehearsal.coinStart must be after the checkpoint');
  if (!Number.isSafeInteger(r.lotteryBlocks) || r.lotteryBlocks < 1 || r.lotteryBlocks > 144) throw new Error('rehearsal.lotteryBlocks must be 1–144');
  if (!config.storeDirectory.startsWith(path.resolve('.rehearsal') + path.sep)) throw new Error('Rehearsal stores must live under .rehearsal/');
}

export function validateFlags(flags) {
  if (typeof flags.config !== 'string') throw new Error('Supply --config <file.json>');
  if (flags['devnet-control'] !== undefined && flags['devnet-control'] !== '1') throw new Error('Use --devnet-control 1');
  if (flags.role === 'gateway' && flags.gateway !== '1') throw new Error('Gateway requires --gateway 1');
  if (flags.role !== 'gateway' && flags.gateway !== undefined) throw new Error('--gateway requires the gateway role');
  if (flags.role === 'relay' && flags['blind-relay-serve'] !== '1') throw new Error('Relay requires --blind-relay-serve 1');
  if (flags.role !== 'relay' && flags['blind-relay-serve'] !== undefined) throw new Error('--blind-relay-serve requires the relay role');
  if (flags['admin-command'] !== undefined && (flags.role !== 'indexer' ||
      !['init-admin', 'deploy-subnet', 'admin-setup'].includes(flags['admin-command']))) throw new Error('Invalid indexer admin command');
}
