import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { address, check, exactKeys, prepareMove, verifyMove, transferCommand, validateTransfer, verifySignature } from 'reset-signer/wire';
import { Login } from './auth.mjs';
import { RateLimit, HttpError, json, readBody } from './http.mjs';
import { gatewayClient } from './gateway.mjs';

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const hex64 = z.string().regex(/^[0-9a-f]{128}$/);
const units = z.string().regex(/^[1-9][0-9]*$/);
const commandSchema = z.object({ type: z.literal('transfer'), value: z.object({ to: hex32, amount: units }).strict() }).strict();

function toolsFor(addr, gateway, rules, now) {
  const server = new McpServer({ name: 'reset-mcp', version: '0.1.0' });
  const register = (name, description, schema, run, readOnly = true) => server.registerTool(name, {
    description, inputSchema: z.object(schema).strict(), annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true }
  }, async args => {
    try {
      const data = await run(args);
      return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  register('reset_state', 'Read the current block, difficulty, capacity and gateways.', {}, () => gateway('/v1/state'));
  register('reset_account', 'Read balances, deposits and exits. Defaults to the logged-in address.', { address: hex32.optional() },
    args => gateway(`/v1/account/${args.address ?? addr}`));
  register('reset_prepare_move', 'Prepare a free mining move for local puzzle solving and signing.', {
    t: z.enum(['header', 'lock', 'unlock', 'withdraw', 'gw_beat', 'guess', 'claim']), p: z.record(z.string(), z.unknown())
  }, async ({ t, p }) => prepareMove(addr, t, p, await gateway('/v1/state'), now()));
  register('reset_submit_move', 'Submit a locally signed move. Requires a valid puzzle and remaining capacity.', {
    prepared: z.record(z.string(), z.unknown()), signature: hex64, nonce: hex32
  }, async signed => {
    check(signed.prepared?.dispatch?.address === addr, 'Move address differs from login');
    check(verifyMove(signed), 'Invalid signed move');
    return gateway('/v1/move', signed);
  }, false);
  register('reset_prepare_transfer', 'Prepare a transfer; its TNK fee is charged to your own MSB address.', { to: hex32, amount: units }, async args => {
    const nonce = randomBytes(32).toString('hex');
    const raw = await gateway('/v1/tx/prepare', { address: addr, ...args, nonce });
    exactKeys(raw, ['address', 'to', 'amount', 'prepared_command', 'tx', 'nonce', 'context'], 'gateway transfer');
    exactKeys(raw.context, ['network_id', 'txv', 'writer', 'content_hash', 'subnet', 'msb'], 'gateway context');
    check(raw.nonce === nonce, 'Gateway nonce mismatch');
    const issued_at = now();
    const packet = { address: raw.address, to: raw.to, amount: raw.amount, prepared_command: raw.prepared_command,
      tx: raw.tx, nonce, command_hash: raw.context.content_hash,
      context: { networkId: raw.context.network_id, txv: raw.context.txv, incomingWritingKey: raw.context.writer,
        subnetBootstrap: raw.context.subnet, msbBootstrap: raw.context.msb }, issued_at, expires_at: issued_at + 120000 };
    check(packet.address === addr && packet.to === args.to && packet.amount === args.amount, 'Gateway transfer fields mismatch');
    validateTransfer(packet, { context: packet.context, now: now() });
    return packet;
  });
  register('reset_submit_transfer', 'Submit a locally checked and signed transfer, paying TNK from your address.', {
    tx: hex32, prepared_command: commandSchema, address: hex32, signature: hex64, nonce: hex32
  }, async signed => {
    check(signed.address === addr, 'Transfer address differs from login');
    check(JSON.stringify(signed.prepared_command) === JSON.stringify(transferCommand(signed.prepared_command.value.to, signed.prepared_command.value.amount)), 'Invalid transfer command');
    check(verifySignature(signed.signature, Buffer.from(signed.tx, 'hex'), addr), 'Invalid transfer signature');
    return gateway('/v1/tx/submit', signed);
  }, false);
  register('reset_rules', 'Read the plain-language RESET rules and local signing instructions.', {}, () => rules);
  return server;
}

export async function createMcpService({ gatewayUrl, publicOrigin, now = Date.now, maxBodyBytes = 16384,
  bodyTimeoutMs = 10000, gatewayTimeoutMs = 5000, ipLimit = 120, addressLimit = 60, windowMs = 60000,
  maxEntries = 10000, challengeTtlMs = 60000, sessionTtlMs = 600000 } = {}) {
  const gateway = gatewayClient(gatewayUrl, { timeoutMs: gatewayTimeoutMs });
  const rules = await readFile(new URL('../../docs/llms.txt', import.meta.url), 'utf8');
  const ipRates = new RateLimit({ limit: ipLimit, windowMs, maxEntries, now });
  const addressRates = new RateLimit({ limit: addressLimit, windowMs, maxEntries, now });
  let login;
  const active = new Set();
  const http = createServer(async (req, res) => {
    try {
      if (!login || req.headers.host !== new URL(login.audience).host) throw new HttpError(403, 'Unrecognized Host');
      if (req.headers.origin && req.headers.origin !== login.audience) throw new HttpError(403, 'Unrecognized Origin');
      const ip = req.socket.remoteAddress;
      ipRates.take(ip);
      if (!['/auth/challenge', '/auth/login', '/mcp'].includes(req.url)) throw new HttpError(404, 'Not found');
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
      let addr;
      if (req.url === '/mcp') { addr = login.authenticate(req.headers.authorization); addressRates.take(addr); }
      const body = await readBody(req, maxBodyBytes, bodyTimeoutMs);
      if (req.url === '/auth/challenge') {
        exactKeys(body, ['address'], 'challenge request'); address(body.address); addressRates.take(body.address);
        json(res, 200, login.challenge(body.address, ip)); return;
      }
      if (req.url === '/auth/login') {
        address(body?.challenge?.address); addressRates.take(body.challenge.address);
        json(res, 200, login.login(body, ip)); return;
      }
      const server = toolsFor(addr, gateway, rules, now);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      active.add(server);
      res.once('close', () => { active.delete(server); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      if (status === 413 || status === 408) res.setHeader('connection', 'close');
      json(res, status, { error: error.message });
    }
  });
  http.requestTimeout = bodyTimeoutMs + gatewayTimeoutMs + 1000;
  http.headersTimeout = Math.min(10000, http.requestTimeout);
  http.setTimeout(bodyTimeoutMs + gatewayTimeoutMs + 1000, socket => socket.destroy());
  http.keepAliveTimeout = 5000;
  return {
    http,
    async listen({ host = '127.0.0.1', port = 0 } = {}) {
      if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !publicOrigin) throw new Error('Public bind requires publicOrigin');
      if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !['http:', 'https:'].includes(new URL(publicOrigin).protocol))) throw new Error('Invalid publicOrigin');
      await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); });
      const url = `http://${host === '::1' ? '[::1]' : host}:${http.address().port}`;
      login = new Login({ audience: publicOrigin ?? url, now, challengeTtlMs, sessionTtlMs, maxEntries });
      return url;
    },
    async close() {
      await Promise.all([...active].map(server => server.close()));
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
    }
  };
}
