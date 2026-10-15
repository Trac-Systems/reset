import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export const DEVNET_DIRECTORY = fileURLToPath(new URL('../../.devnet', import.meta.url));
const markerPath = join(DEVNET_DIRECTORY, 'owned-by-devnet');
const marker = 'RESET disposable local devnet v1\n';
export async function checkDevnetDirectory(create = false) {
  if (create) await mkdir(DEVNET_DIRECTORY, { recursive: true, mode: 0o700 });
  const stat = await lstat(DEVNET_DIRECTORY).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing symlink/non-directory .devnet');
  if (create) await writeFile(markerPath, marker, { flag: 'wx', mode: 0o600 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  if (await readFile(markerPath, 'utf8') !== marker) throw new Error('Unrecognized .devnet ownership marker');
  return true;
}
