import { createServer } from 'node:http';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { temp, password, context } from './helpers.mjs';
import { init } from '../lib/index.mjs';
import { prepareTransfer, verifyMove, verifySignature } from '../lib/wire.mjs';
import { gameLedger } from '../../tests/helpers/games.mjs';
import { chain } from '../../tests/helpers/chain.mjs';
import { connectLocal } from './stdio-client.mjs';

export async function localFixture(t) {
  const root = await temp(t), directory = join(root, 'wallet'), contextFile = join(root, 'context.json');
  const { address } = await init({ directory, password });
  await writeFile(contextFile, JSON.stringify(context));
  const ledger = gameLedger({ deposits: [[address, 1000000000n]], headers: chain(100), params: { exit_wait: 1 } });
  await ledger.move('unlock', { amount: '1000000000' }, address);
  await ledger.advance(7); await ledger.move('withdraw', {}, address);
  const control = { state: s => s, account: a => a, transfer: p => p, submit: undefined, response: undefined, requests: [], submissions: [] };
  const http = createServer(async (req, res) => {
    if (control.response) { control.response(req, res); return; }
    let body = '';
    for await (const c of req) body += c;
    const args = body ? JSON.parse(body) : undefined;
    control.requests.push({ url: req.url, args });
    let output;
    try {
      if (req.url === '/v1/state') output = control.state(await ledger.view().state());
      else if (req.url.startsWith('/v1/account/')) output = control.account(await ledger.view().account(req.url.slice(12)));
      else if (req.url === '/v1/move') {
        control.submissions.push(args);
        if (control.submit) output = control.submit(args);
        else {
          if (!verifyMove(args, { state: await ledger.view().state() })) throw new Error('signature');
          const e = JSON.parse(args.prepared.dispatch.msg);
          const error = await ledger.move(e.t, e.p, address, args.prepared.dispatch.msg);
          output = error ? { ok: false, error } : { ok: true };
        }
      } else if (req.url === '/v1/tx/prepare') {
        const p = prepareTransfer(args, context, args.nonce);
        output = control.transfer({ address: p.address, to: p.to, amount: p.amount, nonce: p.nonce,
          tx: p.tx, prepared_command: p.prepared_command, context: { network_id: context.networkId, txv: context.txv,
            writer: context.incomingWritingKey, content_hash: p.command_hash, subnet: context.subnetBootstrap, msb: context.msbBootstrap } });
      } else if (req.url === '/v1/tx/submit') {
        control.submissions.push(args);
        if (!verifySignature(args.signature, Buffer.from(args.tx, 'hex'), address)) throw new Error('signature');
        const error = await ledger.apply({ type: 'tx', key: args.tx, value: { dispatch: args.prepared_command, ipk: address, wp: context.incomingWritingKey } });
        output = error ? { ok: false, error } : { ok: true };
      } else throw new Error('route');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(output));
    } catch { res.writeHead(400); res.end('{"ok":false,"error":"invalid"}'); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  const gatewayUrl = `http://127.0.0.1:${http.address().port}`;
  return { address, directory, contextFile, ledger, control, gatewayUrl,
    async connect(options = {}) {
      const client = await connectLocal({ directory, password, gatewayUrl, contextFile, ...options });
      t.after(() => client.close()); return client;
    } };
}
