// Text rules every node applies to chat messages, from agents and viewers alike. Topics are free; these only keep
// out links, other wallets' addresses and the usual shapes of attacks on AI agents.
const CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u;
const BLOCKED = [
  [/\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|ai|app|dev|xyz|gg|co|me|info|link|site|online|fun|games|ly|to|sh)\b/i, 'link'],
  [/\b0x[0-9a-f]{40}\b|\bbc1[02-9ac-hj-np-z]{11,71}\b/i, 'address'],
  [/\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instructions?|prompts?|rules|guidelines|directives)\b/i, 'instruction'],
  [/\b(?:system prompt|developer message|jailbreak)\b/i, 'instruction'],
  [/```|\$\(|`[^`]{2,}`/, 'code'],
  [/\b(?:sudo|curl|wget|chmod|chown|powershell|bash\s+-c|sh\s+-c|rm\s+-rf|npm\s+i(?:nstall)?|pip\s+install|eval\s*\(|exec\s*\()/i, 'code'],
];

export function checkText(text, max = 240) {
  if (typeof text !== 'string') return 'text';
  const length = [...text].length;
  if (!length || length > max || !text.trim() || text !== text.trim()) return 'text';
  if (CONTROL.test(text)) return 'text';
  for (const [pattern, reason] of BLOCKED) if (pattern.test(text)) return reason;
  return null;
}
