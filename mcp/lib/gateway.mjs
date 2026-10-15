import { HttpError } from './http.mjs';
export function gatewayClient(gatewayUrl, { timeoutMs = 5000, maxBytes = 262144 } = {}) {
  const base = new URL(gatewayUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Gateway URL must be an HTTP(S) origin');
  return async (path, body) => {
    // Paths are constants or a validated address; callers cannot supply another destination.
    if (!/^\/v1\/(state|account\/[0-9a-f]{64}|move|tx\/(prepare|submit))$/.test(path)) throw new Error('Invalid gateway route');
    try {
      const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'Gateway rejected request'); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maxBytes) throw new Error('Gateway response too large');
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid gateway response');
      return data;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'Gateway unavailable or invalid response');
    }
  };
}
