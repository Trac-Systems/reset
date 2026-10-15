import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { WalletProvider } from 'trac-wallet';
import { check, exactKeys, address } from './wire.mjs';

const derive = promisify(scrypt);
const provider = new WalletProvider({ addressPrefix: 'trac' });
export const defaultDirectory = () => join(homedir(), '.reset-signer');
export const publicAddress = wallet => Buffer.from(wallet.publicKey).toString('hex');
export const createWallet = mnemonic => mnemonic === undefined ? provider.generate() : provider.fromMnemonic({ mnemonic });
export const wipeWallet = wallet => wallet.secretKey.fill(0);
function passwordCheck(password) { check(typeof password === 'string' && password.length >= 12, 'Password must have at least 12 characters'); }
async function keyFor(password, salt) {
  passwordCheck(password);
  return derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
async function privateDirectory(directory, create = false) {
  const dir = resolve(directory);
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  check(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0, 'Keystore directory must be private (0700) and not a symlink');
  return dir;
}
export async function init({ directory = defaultDirectory(), password, mnemonic } = {}) {
  passwordCheck(password);
  const dir = await privateDirectory(directory, true);
  const wallet = await createWallet(mnemonic);
  let key;
  let plaintext;
  try {
    const salt = randomBytes(16), iv = randomBytes(12);
    const header = { v: 1, address: publicAddress(wallet), kdf: 'scrypt-32768-8-1', cipher: 'aes-256-gcm',
      salt: salt.toString('hex'), iv: iv.toString('hex') };
    key = await keyFor(password, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    plaintext = Buffer.from(JSON.stringify({ mnemonic: wallet.mnemonic, derivationPath: wallet.derivationPath }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const keystore = join(dir, 'keystore.json');
    const file = await open(keystore, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ ...header, ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') }) + '\n'); await file.sync(); }
    finally { await file.close(); }
    return { address: header.address, keystore };
  } finally { key?.fill(0); plaintext?.fill(0); wipeWallet(wallet); }
}
export async function unlock({ directory = defaultDirectory(), password } = {}) {
  const dir = await privateDirectory(directory);
  const file = await open(join(dir, 'keystore.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let data;
  try {
    const st = await file.stat();
    check(st.isFile() && (st.mode & 0o077) === 0 && st.size <= 16384, 'Keystore must be a private (0600) small regular file');
    data = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  exactKeys(data, ['v', 'address', 'kdf', 'cipher', 'salt', 'iv', 'ciphertext', 'tag'], 'keystore');
  address(data.address);
  check(data.v === 1 && data.kdf === 'scrypt-32768-8-1' && data.cipher === 'aes-256-gcm', 'Unsupported keystore');
  for (const [k, size] of [['salt', 32], ['iv', 24], ['tag', 32]]) check(typeof data[k] === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(data[k]), 'Invalid keystore encoding');
  check(typeof data.ciphertext === 'string' && /^(?:[0-9a-f]{2}){1,4096}$/.test(data.ciphertext), 'Invalid keystore ciphertext');
  const { ciphertext, tag, ...header } = data;
  const key = await keyFor(password, Buffer.from(data.salt, 'hex'));
  let plaintext, wallet;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'hex'));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
    wallet = await provider.fromMnemonic(JSON.parse(plaintext.toString()));
    check(publicAddress(wallet) === data.address, 'Keystore address mismatch');
    return wallet;
  } catch { if (wallet) wipeWallet(wallet); throw new Error('Wrong password or damaged keystore'); }
  finally { key.fill(0); plaintext?.fill(0); }
}
export const importMnemonic = options => { check(typeof options?.mnemonic === 'string' && options.mnemonic.trim().length > 0, 'Mnemonic required'); return init(options); };
export async function getAddress(options) {
  const wallet = await unlock(options);
  try { return { address: publicAddress(wallet) }; } finally { wipeWallet(wallet); }
}
