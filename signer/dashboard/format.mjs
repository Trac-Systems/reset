// Display helpers. Amounts stay BigInt; only chart geometry uses Number.
const UNIT = 100000000n;

export const units = value => typeof value === 'string' && /^[0-9]{1,78}$/.test(value) ? BigInt(value) : 0n;
export const int = value => Number.isSafeInteger(value) ? value : null;
export const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Coins with at most eight decimals, trailing zeros trimmed, thousands grouped.
export function coins(amount, { sign = false } = {}) {
  let v = typeof amount === 'bigint' ? amount : units(amount);
  const negative = v < 0n;
  if (negative) v = -v;
  const whole = (v / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (v % UNIT).toString().padStart(8, '0').replace(/0+$/, '');
  const prefix = negative ? '−' : sign && v > 0n ? '+' : '';
  return prefix + whole + (fraction ? '.' + fraction : '');
}

// Bitcoin blocks arrive about every ten minutes.
export function blocksTime(blocks) {
  if (blocks <= 0) return 'now';
  const minutes = blocks * 10;
  if (minutes < 60) return `about ${minutes} min`;
  if (minutes < 48 * 60) return `about ${Math.round(minutes / 60)} h`;
  return `about ${Math.round(minutes / 1440)} days`;
}

export function ago(ms) {
  if (ms < 45000) return 'just now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const when = t => new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export const shortAddress = a => `${a.slice(0, 8)}…${a.slice(-6)}`;
