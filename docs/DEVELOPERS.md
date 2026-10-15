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

Free local reads are `GET /v1/state` and `GET /v1/account/:address`. Players solve puzzles and sign locally; submit
`{prepared,signature,nonce}` to `POST /v1/move`. Transfers use `/v1/tx/prepare` and `/v1/tx/submit`; their exact
signing context is documented in the spec. The gateway owns only its own peer wallet.

The launch checkpoint (Bitcoin block 969696) and coin start (971559) are fixed in `contract/launch.js`. Tests inject
their own regtest checkpoint.

Fixture maintenance is separate from tests: `node scripts/fetch-header-fixture.mjs` explicitly downloads the
historical mainnet fixture from mempool.space, verifies header hashes, and writes `tests/fixtures/mainnet-retarget.json`.
The exact retarget arithmetic follows [Bitcoin Core's proof-of-work implementation](https://github.com/bitcoin/bitcoin/blob/master/src/pow.cpp).
