import { randomBytes, createHash } from 'node:crypto';
import { address, exactKeys, challengeMessage, verifySignature } from 'reset-signer/wire';
import { stableStringify } from 'reset-signer/pow';
import { HttpError } from './http.mjs';
const tokenHash = token => createHash('sha256').update(token).digest('hex');

export class Login {
  constructor({ audience, now = Date.now, challengeTtlMs = 60000, sessionTtlMs = 600000, maxEntries = 10000 }) {
    if (!(challengeTtlMs > 0 && challengeTtlMs <= 120000 && sessionTtlMs > 0 && sessionTtlMs <= 600000)) throw new Error('Invalid login TTL');
    Object.assign(this, { audience, now, challengeTtlMs, sessionTtlMs, maxEntries });
    this.challenges = new Map(); this.sessions = new Map();
  }
  prune() {
    for (const map of [this.challenges, this.sessions]) for (const [key, value] of map) if (value.expires_at <= this.now()) map.delete(key);
  }
  challenge(addr, ip) {
    address(addr); this.prune();
    if (this.challenges.size >= this.maxEntries) throw new HttpError(429, 'Too many challenges');
    const now = this.now();
    const challenge = { v: 1, domain: 'reset-mcp-login', audience: this.audience, address: addr,
      nonce: randomBytes(32).toString('hex'), issued_at: now, expires_at: now + this.challengeTtlMs };
    this.challenges.set(challenge.nonce, { challenge, ip, expires_at: challenge.expires_at });
    return challenge;
  }
  login(body, ip) {
    exactKeys(body, ['challenge', 'signature'], 'login');
    this.prune();
    const entry = this.challenges.get(body.challenge?.nonce);
    if (!entry) throw new HttpError(401, 'Invalid or expired challenge');
    // Every attempt consumes the challenge, including forged signatures.
    this.challenges.delete(body.challenge.nonce);
    if (entry.ip !== ip || stableStringify(body.challenge) !== stableStringify(entry.challenge) ||
      !verifySignature(body.signature, challengeMessage(entry.challenge), entry.challenge.address)) throw new HttpError(401, 'Invalid challenge signature');
    if (this.sessions.size >= this.maxEntries) throw new HttpError(429, 'Too many sessions');
    const token = randomBytes(32).toString('hex');
    const expires_at = this.now() + this.sessionTtlMs;
    this.sessions.set(tokenHash(token), { address: entry.challenge.address, expires_at });
    return { token, token_type: 'Bearer', expires_at, address: entry.challenge.address };
  }
  authenticate(header) {
    this.prune();
    if (typeof header !== 'string' || !/^Bearer [0-9a-f]{64}$/.test(header)) throw new HttpError(401, 'Login required');
    const session = this.sessions.get(tokenHash(header.slice(7)));
    if (!session) throw new HttpError(401, 'Session expired or invalid');
    return session.address;
  }
}
