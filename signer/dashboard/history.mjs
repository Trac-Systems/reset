// Local earnings history. The gateway only reports current state, so the dashboard records one sample per newly
// counted block and adds up Mine payouts, lottery wins and penalties as they appear.
import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { units, int } from './format.mjs';

export const HISTORY_FILE = 'dashboard-history.json';
export const ARCHIVE_FILE = 'dashboard-history.1.json';
export const MAX_SAMPLES = 4032;
const MAX_BYTES = 4 * 1024 * 1024;
const SEEN_TARGETS = 64;

const amount = v => typeof v === 'string' && /^[0-9]{1,78}$/.test(v);
const fresh = address => ({ v: 1, address, started: null, seen: { mine_r: null, lottery: [] },
  totals: { mine: '0', lottery: '0', penalties: '0' }, samples: [] });

function valid(data, address) {
  return data && data.v === 1 && data.address === address && Array.isArray(data.samples) &&
    (data.started === null || (int(data.started?.h) !== null && int(data.started?.t) !== null)) &&
    data.seen && (data.seen.mine_r === null || int(data.seen.mine_r) !== null) && Array.isArray(data.seen.lottery) &&
    data.totals && ['mine', 'lottery', 'penalties'].every(k => amount(data.totals[k])) &&
    data.samples.every(s => int(s?.h) !== null && int(s?.t) !== null && ['mine', 'lottery', 'penalties', 'holdings'].every(k => amount(s[k])));
}

async function readFile(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const st = await file.stat();
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    try { return JSON.parse(await file.readFile('utf8')); } catch { return null; }
  } finally { await file.close(); }
}

async function writeFile(path, data) {
  const temp = `${path}.tmp`;
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(data) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
}

export class History {
  constructor(directory, data, maxSamples) { this.directory = directory; this.data = data; this.maxSamples = maxSamples; }

  static async load(directory, address, { maxSamples = MAX_SAMPLES } = {}) {
    const path = join(directory, HISTORY_FILE);
    const data = await readFile(path);
    if (data === undefined) return new History(directory, fresh(address), maxSamples);
    if (valid(data, address)) return new History(directory, data, maxSamples);
    // Keep whatever was there: another address's history or an unreadable file is moved aside, never overwritten.
    const aside = data && typeof data.address === 'string' && /^[0-9a-f]{64}$/.test(data.address) && data.address !== address
      ? `dashboard-history-${data.address.slice(0, 16)}.json` : `dashboard-history.unreadable-${Date.now()}.json`;
    await rename(path, join(directory, aside));
    return new History(directory, fresh(address), maxSamples);
  }

  get started() { return this.data.started; }
  get totals() { return this.data.totals; }
  get samples() { return this.data.samples; }
  get last() { return this.data.samples.at(-1) ?? null; }

  // Returns true when a new counted block was recorded.
  observe({ state, account, now }) {
    const counted = int(state?.counted);
    const last = this.last;
    if (counted === null || (last && counted <= last.h)) return false;
    const d = this.data, address = d.address;
    let mine = units(d.totals.mine), lottery = units(d.totals.lottery), penalties = units(d.totals.penalties);
    const result = account?.mine?.last_result;
    if (result && int(result.r) !== null && (d.seen.mine_r === null || result.r > d.seen.mine_r)) {
      mine += units(result.amount);
      penalties += units(result.penalty);
      d.seen.mine_r = result.r;
    }
    for (const record of Array.isArray(state?.lottery?.recent_results) ? state.lottery.recent_results : []) {
      if (int(record?.tb) === null || d.seen.lottery.includes(record.tb)) continue;
      d.seen.lottery.push(record.tb);
      for (const winner of Array.isArray(record.winners) ? record.winners : []) if (winner?.address === address) lottery += units(winner.amount);
    }
    // Targets settle in increasing order, so anything older than the kept tail has also left recent_results.
    d.seen.lottery = d.seen.lottery.slice(-SEEN_TARGETS);
    d.totals = { mine: mine.toString(), lottery: lottery.toString(), penalties: penalties.toString() };
    const exiting = (Array.isArray(account?.exits) ? account.exits : []).reduce((sum, e) => sum + units(e?.amount), 0n);
    const holdings = units(account?.balance) + units(account?.deposit) + exiting;
    d.started ??= { h: counted, t: now };
    d.samples.push({ h: counted, t: now, ...d.totals, holdings: holdings.toString() });
    return true;
  }

  // Appends are bounded: past maxSamples the oldest half moves to one archive file, replacing the previous archive.
  async save() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const d = this.data;
    if (d.samples.length > this.maxSamples) {
      const archived = d.samples.splice(0, d.samples.length - Math.floor(this.maxSamples / 2));
      await writeFile(join(this.directory, ARCHIVE_FILE), { v: 1, address: d.address, samples: archived });
    }
    await writeFile(join(this.directory, HISTORY_FILE), d);
  }
}
