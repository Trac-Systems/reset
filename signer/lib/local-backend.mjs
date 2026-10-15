import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { publicAddress, signChallenge } from './index.mjs';
import { check, exactKeys, prepareMove, validateTransfer } from './wire.mjs';

const reasons = {
  balance: 'There are not enough spendable coins.', deposit: 'There are not enough deposited coins.',
  capacity: 'This block has no move capacity left. Wait for the next block.',
  rate: 'Your move allowance for this block is used. Wait for the next block.',
  address_rate: 'Your request limit is reached. Wait before trying again.', ip_rate: 'The request limit is reached. Wait before trying again.',
  stale: 'The block changed. Read status before trying again.', block: 'The block is no longer current.',
  puzzle: 'The puzzle no longer meets the required difficulty.', difficulty: 'The puzzle difficulty changed.',
  claim_pending: 'Your Mine claim must settle before you can withdraw.',
  exit_capacity: 'You have too many exits. Withdraw mature exits first.',
  lottery_pending: 'A lottery setting change is pending. Wait for it to take effect.',
  lottery_window: 'That target is outside the lottery window.', guess_late: 'That lottery target is too close or has passed.',
  lottery_capacity: 'That lottery target has no space for more guesses. Choose another eligible target.',
  guess_duplicate: 'You already guessed for that target.', claim_duplicate: 'You already claimed in this Mine round.',
  claim_window: 'The Mine claim window is closed.', claim_deposit: 'Lock a positive deposit before claiming.',
  already_guessed: 'You already guessed for that target.', already_claimed: 'You already claimed in this Mine round.',
  mine_round: 'The Mine round changed. Read status before trying again.',
  exit_wait: 'No exits are mature yet. Wait until their release height is counted.',
  busy: 'The gateway is busy. Wait before trying again.', msb_root_changed: 'The settlement state changed. Prepare the transfer again.',
  writer: 'The gateway is not an active writer.', chat_disabled: 'Mining messages are disabled.',
  signature: 'The gateway rejected the signature.', muted: 'This address cannot submit moves.', whitelist: 'This address is not admitted.'
};
export function rejection(code) {
  return reasons[code] ?? 'The gateway rejected the request. Check status and the game rules before trying again.';
}

function origin(value, label) {
  const url = new URL(value);
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === '/', `${label} must be an HTTP(S) origin`);
  check(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    `${label} must use HTTPS outside this machine`);
  return url.origin;
}

// Also used by the SDK transport: fixed origin, no redirects, bounded response and time.
function boundedFetch(base) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    check(url.origin === base && /^\/(?:auth\/(?:challenge|login)|mcp|v1\/(?:state|account\/[0-9a-f]{64}|move|tx\/(?:prepare|submit)))$/.test(url.pathname) &&
      !url.search && !url.hash, 'Unexpected service route');
    try {
      const response = await fetch(input, { ...init, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init.signal ? [init.signal] : [])]) });
      let length = 0; const chunks = [];
      for await (const chunk of response.body ?? []) {
        length += chunk.length;
        check(length <= 262144, 'Service response is too large'); chunks.push(chunk);
      }
      return new Response(length ? Buffer.concat(chunks) : null, {
        status: response.status, statusText: response.statusText, headers: response.headers });
    } catch { throw new Error('Service unavailable or invalid response. Check the configured connection.'); }
  };
}

export function localBackend({ wallet, gatewayUrl, mcpUrl }) {
  check(gatewayUrl || mcpUrl, 'Configure --gateway or --mcp-url');
  const gateway = gatewayUrl && origin(gatewayUrl, 'Gateway URL');
  const hosted = mcpUrl && origin(mcpUrl, 'Hosted MCP URL');
  const addr = publicAddress(wallet);
  const gatewayFetch = gateway && boundedFetch(gateway), hostedFetch = hosted && boundedFetch(hosted);
  let client, expires = 0;
  async function json(base, request, path, body) {
    const response = await request(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let result;
    try { result = await response.json(); } catch { throw new Error('Service returned invalid JSON.'); }
    check(result && typeof result === 'object' && !Array.isArray(result), 'Service returned an invalid response.');
    if (!response.ok) {
      if (['/v1/move', '/v1/tx/submit'].includes(path) && response.status >= 400 && response.status < 500 && result.ok === false) return result;
      throw new Error(rejection(result.error));
    }
    return result;
  }
  const direct = (path, body) => json(gateway, gatewayFetch, path, body);
  async function login() {
    if (client && expires > Date.now() + 10000) return;
    await client?.close(); client = undefined;
    const challenge = await json(hosted, hostedFetch, '/auth/challenge', { address: addr });
    const session = await json(hosted, hostedFetch, '/auth/login', signChallenge(wallet, challenge, { audience: hosted }));
    check(session.address === addr && typeof session.token === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(session.token) &&
      Number.isSafeInteger(session.expires_at) && session.expires_at > Date.now(), 'Invalid login response');
    const next = new Client({ name: 'reset-local-signer', version: '0.1.0' });
    try {
      await next.connect(new StreamableHTTPClientTransport(new URL('/mcp', hosted), {
        fetch: hostedFetch, requestInit: { headers: { authorization: `Bearer ${session.token}` } }
      }));
    } catch { await next.close(); throw new Error('Cannot connect to the hosted MCP service.'); }
    client = next; expires = session.expires_at;
  }
  async function tool(name, args = {}) {
    await login();
    let result;
    try { result = await client.callTool({ name, arguments: args }); }
    catch { throw new Error('Hosted MCP request failed. Check status before trying again.'); }
    check(!result.isError, 'Hosted MCP refused the request. Check status and the game rules.');
    try { return JSON.parse(result.content[0].text); } catch { throw new Error('Invalid hosted MCP response'); }
  }
  return {
    state: () => gateway ? direct('/v1/state') : tool('reset_state'),
    account: () => gateway ? direct(`/v1/account/${addr}`) : tool('reset_account'),
    prepareMove: (t, p, state) => hosted ? tool('reset_prepare_move', { t, p }) : prepareMove(addr, t, p, state),
    submitMove: signed => hosted ? tool('reset_submit_move', signed) : direct('/v1/move', signed),
    async prepareTransfer(to, amount) {
      if (hosted) return tool('reset_prepare_transfer', { to, amount });
      const nonce = randomBytes(32).toString('hex');
      const raw = await direct('/v1/tx/prepare', { address: addr, to, amount, nonce });
      exactKeys(raw, ['address', 'to', 'amount', 'prepared_command', 'tx', 'nonce', 'context'], 'gateway transfer');
      exactKeys(raw.context, ['network_id', 'txv', 'writer', 'content_hash', 'subnet', 'msb'], 'gateway context');
      check(raw.address === addr && raw.to === to && raw.amount === amount && raw.nonce === nonce, 'Gateway transfer fields mismatch');
      const issued_at = Date.now();
      const packet = { address: addr, to, amount, nonce, tx: raw.tx, prepared_command: raw.prepared_command,
        command_hash: raw.context.content_hash, context: { networkId: raw.context.network_id, txv: raw.context.txv,
          incomingWritingKey: raw.context.writer, subnetBootstrap: raw.context.subnet, msbBootstrap: raw.context.msb },
        issued_at, expires_at: issued_at + 120000 };
      validateTransfer(packet, { context: packet.context });
      return packet;
    },
    submitTransfer: signed => hosted ? tool('reset_submit_transfer', signed) : direct('/v1/tx/submit', signed),
    close: () => client?.close()
  };
}
