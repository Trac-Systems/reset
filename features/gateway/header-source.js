import http from 'http';
import https from 'https';

// Node and Pear share the pinned HTTP wrappers. Bare has no global fetch or
// AbortSignal, so the real adapter explicitly bounds and aborts each request.
export function requestText(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, text) => {
      if (done) return;
      done = true; clearTimeout(timer);
      // On Bare, aborting an in-flight HTTPS request on a timeout can crash the runtime; let it close on its own.
      if (error) { if (!error.timeout || !globalThis.Bare) request.destroy(); reject(error); } else resolve(text);
    };
    const request = (url.startsWith('https:') ? https : http).request(url, { method: 'GET', agent: false }, response => {
      if (response.statusCode !== 200) return finish(new Error(`Header source HTTP ${response.statusCode}`));
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4096) return finish(new Error('Header source response too large'));
        if (done) return;
        chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    });
    const timer = setTimeout(() => finish(Object.assign(new Error('Header source timeout'), { timeout: true })), timeoutMs);
    request.on('error', error => finish(error));
    request.end();
  });
}

// Adapter boundary: an owned node can implement the same REST shape later.
export class HeaderSource {
  constructor(url, { fetchImpl = null, timeoutMs = 10000 } = {}) {
    if (!/^https?:\/\//.test(url)) throw new Error('Header source requires an HTTP(S) URL');
    this.url = String(url).replace(/\/$/, ''); this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async text(path) {
    if (!this.fetch) return (await requestText(`${this.url}${path}`, this.timeoutMs)).trim();
    const response = await this.fetch(`${this.url}${path}`);
    if (!response.ok) throw new Error(`Header source HTTP ${response.status}`);
    return (await response.text()).trim();
  }
  async height() {
    const s = await this.text('/api/blocks/tip/height');
    if (!/^(0|[1-9][0-9]*)$/.test(s) || !Number.isSafeInteger(Number(s))) throw new Error('Invalid source height');
    return Number(s);
  }
  async hash(height) {
    const hash = await this.text(`/api/block-height/${height}`);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid source hash');
    return hash;
  }
  async header(hash) {
    const hx = await this.text(`/api/block/${hash}/header`);
    if (!/^[0-9a-f]{160}$/.test(hx)) throw new Error('Invalid source header');
    return hx;
  }
  async next(state, hashAt) {
    const remote = await this.height();
    this.lastHeight = remote;
    let height = Math.min(remote, state.tip.height);
    // A shallow source reorg can replace pending headers; never chase finality.
    while (height > state.counted && await this.hash(height) !== await hashAt(height)) height--;
    if (await this.hash(height) !== await hashAt(height)) throw new Error('Header source conflicts with counted chain');
    const headers = [];
    for (let h = height + 1; h <= Math.min(remote, height + 20); h++) headers.push(await this.header(await this.hash(h)));
    return headers;
  }
}
