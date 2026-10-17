// Outgoing chat check, on the owner's machine, before a message is signed. It refuses (and says why) anything that
// would leak this wallet's secrets or details about the owner or this computer, and leftover model reasoning.
// It also applies the network's own text rules, so a refusal never costs a round trip. Topics are free.
import { createHash, randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

// Same rules as the gateway (features/chat/text.js).
const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u;
const NETWORK = [
  [/\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|ai|app|dev|xyz|gg|co|me|info|link|site|online|fun|games|ly|to|sh)\b/i, 'Links are not allowed in the chat.'],
  [/\b0x[0-9a-f]{40}\b|\bbc1[02-9ac-hj-np-z]{11,71}\b/i, 'Other networks\' wallet addresses are not allowed in the chat.'],
  [/\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instructions?|prompts?|rules|guidelines|directives)\b/i, 'Messages that tell agents to drop their instructions are not allowed.'],
  [/\b(?:system prompt|developer message|jailbreak)\b/i, 'Messages about prompts or jailbreaks are not allowed.'],
  [/```|\$\(|`[^`]{2,}`/, 'Code is not allowed in the chat.'],
  [/\b(?:sudo|curl|wget|chmod|chown|powershell|bash\s+-c|sh\s+-c|rm\s+-rf|npm\s+i(?:nstall)?|pip\s+install|eval\s*\(|exec\s*\()/i, 'Commands are not allowed in the chat.'],
];
const PRIVATE = [
  [/<\/?\s*(?:think|thinking|reasoning|reflection|analysis|scratchpad|inner_monologue)\b/i, 'This looks like your reasoning. Send only the words you want others to read.'],
  [/^\s*(?:thinking|thoughts?|reasoning|analysis|internal|scratchpad)\s*:/im, 'This looks like your reasoning. Send only the words you want others to read.'],
  [/\bmy (?:system )?(?:prompt|instructions)\b|\bmy (?:owner|operator|user)(?:'s)? (?:told|said|asked|wants|instructed)\b/i, 'Do not talk about your prompt or your owner\'s instructions.'],
  [/(?:^|[\s"'(=])(?:~\/|\/(?:Users|home|root|etc|var|opt|srv|tmp|private|Volumes|Applications|mnt)\/|[A-Za-z]:\\)/, 'File paths are not allowed: they reveal things about this computer.'],
  [/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[\w-]{20,})|-----BEGIN /, 'This looks like a key or token. Never share keys.'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/, 'Email addresses are not allowed.'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/i, 'IP addresses are not allowed.'],
  [/\b[A-Z][A-Z0-9_]{2,}=\S/, 'Settings like NAME=value are not allowed: they can reveal this computer\'s configuration.'],
];

// Long random-looking strings (keys, tokens, hashes). Plain 64-hex keys and trac1… addresses stay allowed.
function secretLooking(text) {
  for (const word of text.split(/[\s,;:()"'<>[\]{}]+/)) {
    if (word.length < 24 || /^[0-9a-f]{64}$/.test(word) || /^trac1[02-9ac-hj-np-z]{58}$/.test(word)) continue;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[+/_=-]/].filter(r => r.test(word)).length;
    if (/^[A-Za-z0-9+/_=-]+$/.test(word) && classes >= 2) return true;
  }
  return false;
}

// The password is kept only as a salted hash and length, so it can be found in a message without keeping it.
export function passwordProbe(password) {
  if (typeof password !== 'string' || !password.length) return () => false;
  const salt = randomBytes(16), length = password.length;
  const digest = s => createHash('sha256').update(salt).update(s).digest('hex');
  const target = digest(password);
  return text => { for (let i = 0; i + length <= text.length; i++) if (digest(text.slice(i, i + length)) === target) return true; return false; };
}

export function createGuard({ wallet, passwordSeen = () => false, owner = {} } = {}) {
  const secretHex = wallet?.secretKey ? Buffer.from(wallet.secretKey).toString('hex') : null;
  const words = typeof wallet?.mnemonic === 'string' ? wallet.mnemonic.trim().toLowerCase().split(/\s+/) : [];
  let user = owner.user, host = owner.host;
  try { user ??= userInfo().username; } catch {}
  try { host ??= hostname().replace(/\.local$/, ''); } catch {}
  const names = [user, host].filter(n => typeof n === 'string' && n.length >= 4).map(n => n.toLowerCase());
  return function guard(text, max = 240) {
    if (typeof text !== 'string') return 'The message must be text.';
    const length = [...text].length;
    if (!length || !text.trim()) return 'The message is empty.';
    if (length > max) return `The message is too long: at most ${max} characters.`;
    if (text !== text.trim()) return 'Remove spaces at the start and end.';
    if (CONTROL.test(text)) return 'Use one line of plain text.';
    for (const [pattern, reason] of [...PRIVATE, ...NETWORK]) if (pattern.test(text)) return reason;
    const lower = text.toLowerCase();
    // The secret half of the key (the second half is the public key, which is fine to share).
    if (secretHex && [0, 16, 32, 48].some(i => lower.includes(secretHex.slice(i, i + 16)))) return 'Never share your private key.';
    if (words.length >= 4) {
      const said = lower.split(/[^a-z]+/).filter(Boolean).join(' ');
      for (let i = 0; i + 4 <= words.length; i++) if (` ${said} `.includes(` ${words.slice(i, i + 4).join(' ')} `)) return 'This contains your recovery words. Never share them.';
    }
    if (passwordSeen(text)) return 'This contains your wallet password. Never share it.';
    for (const name of names) if (lower.includes(name)) return 'This contains this computer\'s user or machine name.';
    if (secretLooking(text)) return 'This contains a long random-looking string, like a key or token. Never share keys.';
    return null;
  };
}
