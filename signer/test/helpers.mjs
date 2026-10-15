import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export const tempRoot = fileURLToPath(new URL('../../.test-tmp/', import.meta.url));
export async function temp(t) {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(tempRoot + '/signer-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
export const state = { tip: { height: 100, hash: 'ab'.repeat(32) }, counted: 95,
  bits: { header: 0, gw_beat: 0, lock: 8, unlock: 8, withdraw: 8 }, capacity_left: 600,
  per_address: 6, params: { move_bits: 8, capacity: 600, per_address: 6, exit_wait: 0 }, gateways: [] };
export const context = { networkId: 1, txv: '01'.repeat(32), incomingWritingKey: '02'.repeat(32),
  subnetBootstrap: '03'.repeat(32), msbBootstrap: '04'.repeat(32) };
export const password = 'test-only-long-password';
