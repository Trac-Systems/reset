# RESET — developer notes

A Bitcoin-header-clocked coin on the pinned Intercom/trac-peer stack: signed mining moves, final header counting,
issuance, gateway payouts, deposits, the bootstrap lottery, the Mine and MSB-settled transfers. The Intercom runner,
sidechannels and authenticated SC-Bridge remain available. Sample contract functions and the timer are detached.

The technical specification is [SPEC.md](SPEC.md). The local network and MCP/signer acceptance commands are in
[DEVNET.md](DEVNET.md); the server kit is in [deploy/RUNBOOK.md](../deploy/RUNBOOK.md).

Use Node **23.11.0**:

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
npm ci
npm ci --prefix signer
npm ci --prefix mcp
npm test
npm test --prefix signer
npm test --prefix mcp
```

The complete suite uses committed Bitcoin/Intercom fixtures, local DHT bootstrap, temporary wallets under
`.test-tmp/` and `.devnet/`, real subnet peers and a real local MSB validator/client. Tests never contact public networks.
The local MSB diagnostic can also run independently:

```sh
node scripts/probe-local-msb.mjs
```

For an already configured **local** writer peer, add these flags to its existing runner command:

```text
--gateway 1 --gateway-port 49223 --gateway-header-source off
```

`npm start -- <peer flags>` preserves the Intercom Pear v2/v3 runner and its historical default network settings.
For an isolated local run use `node scripts/devnet.mjs`, which explicitly creates a local MSB and DHT. The HTTP API binds `127.0.0.1`; message and transaction APIs
are exposed only when `--gateway 1` is present. An optional header source accepts a mempool-compatible HTTP(S) base
URL. It can later point to an owned-node adapter with the same three REST endpoints.

From the initialized local admin peer, run the setup helper using its existing wallet:

```js
import { setupAdmin } from './scripts/admin-setup.mjs';
await setupAdmin(peer, { gatewayWriter: '<writer hex32>', gatewayAddress: '<public address hex32>' });
```

This enables chat/transactions, disables the whitelist and automatic writer enrollment, adds the gateway writer,
and submits its registry transaction through MSB. The admin key is retained. The returned MSB transaction still
needs to settle; inspect the transaction through the peer API before relying on registration.

Free local reads are `GET /v1/state` and `GET /v1/account/:address` (the 64-hex key or its `trac1…` address). Players solve puzzles and sign locally; submit
`{prepared,signature,nonce}` to `POST /v1/move`. Transfers use `/v1/tx/prepare` and `/v1/tx/submit`; their exact
signing context is documented in the spec. `GET /v1/tx/:hash` tells whether a submitted transfer is applied, still queued
(wait, even for hours) or unknown (only then is sending it again safe). The gateway owns only its own peer wallet.

`GET /v1/mine/view?after=<64 lowercase hex address>` returns a read-only Mine snapshot with integer base-unit
amounts, round and settlement summaries, and up to 400 sorted miner rows within 56 KiB. Each row is
`[address, deposit, leaving, strikes, clean, claimed, last_round, last_amount, last_penalty]`; membership includes
positive deposits, unwithdrawn exits and current-round claims. Omit `after` for the first page; pass `next` as the
exclusive cursor until it is `null`, and use `total` for the full count. Pages share the state route's IP limit,
are cached by view version and cursor, and support `ETag`/`If-None-Match` with an empty 304 response.

Miners' chat (`features/chat/`, enabled by `"chat": { "viewerKeyFile": "/abs/path" }` in a gateway's config): the
gateway joins the open sidechannel `reset-chat`, keeps the last 30 minutes in memory and serves
`GET /v1/chat?after=<seq>` (`{epoch, now, next, oldest, messages}`; a new `epoch` after a restart means "drop your
cursor"), `POST /v1/chat/send {message}` for agent messages signed by their own key, and `POST /v1/chat/viewer`
`{id, name, text}` with `Authorization: Bearer <viewer key>` for messages a game has already approved. Every node
checks agent messages itself (signature, clock within two minutes, at least `min_amount` locked, one per 30 seconds
per address, text rules in `features/chat/text.js`) and accepts viewer messages only from a registered gateway's
signed envelope. Nothing is written to the chain or to disk.

The launch checkpoint (Bitcoin block 969696) and coin start (971559) are fixed in `contract/launch.js`. Tests inject
their own regtest checkpoint.

Fixture maintenance is separate from tests: `node scripts/fetch-header-fixture.mjs` explicitly downloads the
historical mainnet fixture from mempool.space, verifies header hashes, and writes `tests/fixtures/mainnet-retarget.json`.
The exact retarget arithmetic follows [Bitcoin Core's proof-of-work implementation](https://github.com/bitcoin/bitcoin/blob/master/src/pow.cpp).
