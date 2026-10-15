import { TerminalHandlers } from 'trac-peer/src/terminal/handlers.js';
import { ADDRESS } from '../contract/rules/index.js';

// Run inside the local admin peer, using its own wallet and MSB connection.
// No remote credentials or player keys are loaded by this script.
export async function setupAdmin(peer, { gatewayWriter, gatewayAddress }) {
  if (!ADDRESS.test(gatewayWriter) || !ADDRESS.test(gatewayAddress)) throw new Error('Expected gateway writer and public address as hex32');
  const admin = (await peer.base.view.get('admin'))?.value;
  if (admin !== peer.wallet.publicKey) throw new Error('Run from the existing admin peer');
  const commands = new TerminalHandlers(peer);
  await commands.setChatStatus('/chat_status --enabled 1');
  await commands.enableTransactions('/enable_transactions --enabled 1');
  await commands.enableWhitelist('/enable_whitelist --enabled 0');
  await commands.setAutoAddWriters('/auto_add_writers --enabled 0');
  await commands.addWriter(`/add_writer --key ${gatewayWriter}`);
  return peer.protocol.instance.tx({ command: JSON.stringify({ op: 'gw_set', addr: gatewayAddress, on: true }) });
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log('Import setupAdmin(peer, { gatewayWriter, gatewayAddress }) inside the local admin peer. It uses the existing admin wallet and submits gw_set through MSB.');
}
