export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function json(res, status, data) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}
export async function readBody(req, maxBytes, timeoutMs) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Use application/json');
  if (Number(req.headers['content-length']) > maxBytes) throw new HttpError(413, 'Body too large');
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { clearTimeout(timer); req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort); };
    const fail = error => { cleanup(); req.pause(); reject(error); };
    const onError = () => fail(new HttpError(400, 'Request interrupted'));
    const onAbort = onError;
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) { fail(new HttpError(413, 'Body too large')); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    };
    const timer = setTimeout(() => fail(new HttpError(408, 'Body timeout')), timeoutMs);
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAbort);
  });
}
export class RateLimit {
  constructor({ limit, windowMs, maxEntries = 10000, now = Date.now }) { Object.assign(this, { limit, windowMs, maxEntries, now }); this.entries = new Map(); }
  take(key) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.expires <= now) {
      for (const [k, value] of this.entries) if (value.expires <= now) this.entries.delete(k);
      if (this.entries.size >= this.maxEntries) throw new HttpError(429, 'Rate limit storage full');
      entry = { count: 0, expires: now + this.windowMs }; this.entries.set(key, entry);
    }
    if (++entry.count > this.limit) throw new HttpError(429, 'Rate limit exceeded');
  }
}
