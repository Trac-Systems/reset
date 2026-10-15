import { TerminalHandlers } from 'trac-peer/src/terminal/handlers.js';
import { applyStateMessageFactory } from 'trac-msb/src/messages/state/applyStateMessageFactory.js';
import { setupAdmin } from '../scripts/admin-setup.mjs';

export async function until(fn, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

export async function settled(peer, result) {
  const tx = result?.txo?.tx;
  if (!tx) throw new Error('Transaction not submitted');
  const row = await until(async () => {
    const marker = await peer.base.view.get(`tx/${tx}`);
    return marker && peer.base.view.get(`txi/${marker.value}`);
  }, 'MSB transaction settlement');
  if (row.value.err) throw new Error(row.value.err);
  return row.value;
}

// Runs in the owning Pear peer. Never exports keys or exposes an admin HTTP API.
export async function adminCommand(peer, bus, command, gateways = []) {
  const admin = (await peer.base.view.get('admin'))?.value;
  if (command === 'init-admin') {
    if (admin || !peer.base.isIndexer) throw new Error('Initialization requires a fresh indexer with no admin');
    await new TerminalHandlers(peer).addAdmin(`/add_admin --address ${peer.wallet.publicKey}`);
    await until(async () => (await peer.base.view.get('admin'))?.value === peer.wallet.publicKey, 'admin initialization');
    return;
  }
  if (admin !== peer.wallet.publicKey) throw new Error('This peer does not own the admin key');
  if (command === 'deploy-subnet') {
    const bootstrap = peer.base.key.toString('hex');
    // Wait for the local MSB view before checking an uncertain prior deployment.
    await until(() => bus.state.getNodeEntry(peer.wallet.address), 'admin TNK replicated');
    if (await bus.state.getRegisteredBootstrapEntry(bootstrap)) throw new Error('Subnet already deployed');
    const msg = await applyStateMessageFactory(peer.wallet, bus.config).buildPartialBootstrapDeploymentMessage(
      peer.wallet.address, peer.base.key, peer.config.channel, await bus.state.getIndexerSequenceState(), 'json');
    if (!await bus.network.validatorMessageOrchestrator.send(msg)) throw new Error('Subnet deployment rejected');
    await until(() => bus.state.getRegisteredBootstrapEntry(bootstrap), 'subnet deployment');
  } else if (command === 'admin-setup') {
    if (!Array.isArray(gateways) || !gateways.length) throw new Error('Supply gateway writer keys and public addresses');
    for (const entry of gateways) await settled(peer, await setupAdmin(peer, entry));
  } else throw new Error('Unknown admin command');
}
