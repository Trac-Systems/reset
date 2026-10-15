# Local devnet

Everything runs on this machine: three local HyperDHT bootstrap nodes, a real
MSB validator and client, an admin/indexer, three registered gateway writers,
three MCP services, a transport-only blind relay on its own discovery channel,
and a JS regtest-header miner. No public DHT/bootstrap or real funds are used.
The admin key remains owned and players are never writers. With `--pear`, the
indexer, three gateways and relay each run through `scripts/pear-runner.mjs` →
`index.js` in their own Pear/Bare process. Each has a distinct peer/MSB store
and Pear HOME/XDG directories beneath the fresh run folder. MCP runs in three
separate Node processes through its production entry point, communicating only
with local gateway HTTP. The validator, DHT bootstrap and miner remain Node
test tooling. `node scripts/devnet.mjs` without `--pear` retains the existing
in-process regression fixture; use `--pear` for the production runtime path.

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
export npm_config_userconfig=/dev/null
export npm_config_cache="$PWD/.npm-cache"
npm ci
npm ci --prefix signer
npm ci --prefix mcp
node scripts/devnet.mjs --pear
```

Wait for `DEVNET_READY`. The public manifest is `.devnet/manifest.json`; the same
manifest and separately trusted transfer contexts live in the printed run folder.
Ports are dynamically assigned on 127.0.0.1. Each invocation creates a fresh
`.devnet/network-*` folder; stopped runs are preserved for inspection, not resumed.
Stores and disposable player keystores remain private (0700/0600). Test passwords
are intentionally known constants, only for this local fixture. Never reuse its
keys for anything real. Neither gateway nor MCP loads a player's keystore: the
local signer CLI creates them and the validator receives public fee addresses.

Startup registers all three gateways, waits for heartbeats, mines six headers,
then transfers 1000 coin units from gateway 1's earned balance to Alice and Bob
through MCP and the local signer library in the in-process fixture. The Pear
fixture gifts through the gateway’s own in-process operator transaction path;
its keys never leave that Pear process. Player actions in the acceptance test
still go through separate MCP and the local signer.
Both players and operator peers receive local TNK. Mining then runs at a default
interval of 10000 ms, configurable with `--interval-ms 1500` (minimum 100). Each
header waits for all three heartbeats before posting over gateway HTTP. Six-deep
counting and the actual contract rules remain in effect. An MSB admin transaction
sets the local fixture's exit_wait to **1**, taking effect on the first counted
block; it never uses the invalid zero-wait shortcut. The puzzle floor stays 12.
Local gateway transport allowances are raised to support accelerated mining;
MCP defaults remain unchanged. These are test settings, not launch policy.

Stop with Ctrl-C or, in another terminal, `node scripts/devnet.mjs --stop`.
Allow up to 90 seconds for the independent Pear/MSB processes to drain; the
control request waits for complete shutdown before reporting success.
`node scripts/devnet.mjs --reset` stops it and deletes exactly this repository's
`.devnet/`, including all run stores, test wallets and logs. It checks ownership
and refuses a symlink. A private Unix socket controls shutdown; the command never
sends a kill signal based on an unverified PID. After a crash, a subsequent start
can clear a dead lock. If a PID was reused or shutdown fails, inspect the process
and lock manually; reset refuses to delete an apparently active network.

To run the real-gateway client loop against the already running devnet, load only the
public manifest in a shell (the password below belongs only to disposable tests):

```sh
export RESET_GATEWAY_URL="$(node -p "require('./.devnet/manifest.json').gateways[0].gatewayUrl")"
export RESET_MCP_URL="$(node -p "require('./.devnet/manifest.json').gateways[0].mcpUrl")"
export RESET_E2E_KEYSTORE="$(node -p "require('./.devnet/manifest.json').players.alice.keystore")"
export RESET_E2E_RECIPIENT="$(node -p "require('./.devnet/manifest.json').players.bob.address")"
export RESET_E2E_CONTEXT="$(node -p "require('./.devnet/manifest.json').root + '/context-1.json'")"
export RESET_SIGNER_PASSWORD=local-disposable-devnet-only
node scripts/e2e-real-gateway.mjs
```

The loop logs in, prepares/solves/signs/submits lock(10), unlock(10), waits for
`counted >= release`, withdraws, then transfers 3 units through MSB. It observes
application in accounts and checks both balances. `RESET_MCP_URL` uses the existing
MCP service; omitting it retains the old local fixture mode that creates a temporary
MCP listener for one run. All URLs and keystores are restricted to local tests.

`node scripts/llms-check.mjs` uses the same environment but independently
interprets the recipe in `tests/fixtures/client-plan.txt`. Use Bob as sender and Alice as
recipient immediately after the first loop, or wait for fresh capacity and request
allowances. The recipe contains every HTTP route, MCP tool name/argument, local
signer command and maturity/settlement predicate. Inputs are the recipe, separate public rules, the
MCP/gateway origins and the player's local credentials, trusted context and
recipient. It does not import the e2e flow or reach into the network fixture. Both clients
refresh public preparation/state reads when mining advances between them;
they still require exact tip agreement before local signing.

Automated verification creates and cleans its own run without requiring the CLI:

```sh
node --test tests/pear-devnet.test.mjs
node --test tests/devnet-e2e.test.mjs
npm test
npm test --prefix signer
npm test --prefix mcp
```

The existing in-process e2e has a five-minute ceiling and includes both independent
client loops. The Pear e2e has a ten-minute ceiling: it runs the same real-gateway
lock/unlock/mature-withdraw/transfer client, verifies actual TNK debit and all
replicated account views, then submits one lottery guess and one Mine claim
through MCP and the local signer, advances the clock and verifies both payouts
and supply conservation. It also verifies distinct runtime process IDs and clean
shutdown. Startup rehearses all three one-shot admin commands across stopped-store
restarts and checks that the indexer’s address, writer key and bootstrap persist.
Player keystores stay in local Node clients; no peer or hosted MCP loads them.

Both devnet acceptance tests also launch `reset-signer mcp` as a separate local
stdio process. An official SDK client calls all nine tools, submits lottery and
Mine moves, waits for settlement, exercises lock/unlock/withdraw, then transfers
three units and verifies the actual TNK debit and both balances. Passwords are
checked absent from tool results and captured logs. Mining is paused during
puzzle work and advanced explicitly for deterministic windows and maturity.
The stdio process is the player's local signer; hosted MCP and peers remain
keyless for players. To connect an agent manually to the disposable devnet,
set `RESET_SIGNER_DIRECTORY` to the player's manifest keystore,
`RESET_SIGNER_CONTEXT` to that gateway's context file, `RESET_GATEWAY_URL` to
its URL, and `RESET_SIGNER_PASSWORD` locally, then launch `reset-signer mcp`.

Pear devnet control uses a private stdin pipe, with a small fixed set of fixture
commands; no admin HTTP endpoint or arbitrary evaluation is added. It requires
`--devnet-control 1`, development mode, loopback-only DHT, a regtest checkpoint
and stores under this checkout’s `.devnet/`. Production JSON rejects these test
options. The ordinary configured path defaults to `contract/launch.js`.
The ordinary suite also includes checkpoint REST fixtures and relay integration.
Tests do not fetch public Bitcoin data.

# Launch checkpoint (explicit read-only maintenance command)

```sh
node scripts/checkpoint.mjs --height 32256
node scripts/checkpoint.mjs --height 32256 --source https://mempool.space/api
```

Use a difficulty-period boundary as the checkpoint; 32256 is a historical
example, not a proposed launch value. The tool prints a JS `CHECKPOINT` constant,
never edits `contract/`, and validates header hashes/proof, eleven linked MTP
headers, genesis network identity and that the selected hash has not changed
during fetching. `times` is **height-10 through height**, oldest first, exactly
what the beacon constructor needs for the next block's MTP. The period start time
is the checkpoint's own time. Chainwork includes all blocks through the checkpoint.

The [Esplora REST API](https://github.com/Blockstream/esplora/blob/master/API.md#blocks)
provides raw headers and height-to-hash lookup, without a chainwork field. The tool
therefore sums `2016 * work(period_bits)` for every earlier period and adds the
checkpoint header's work. It does not multiply today's work by total height.
Expect about two REST requests per historical period, plus MTP context; requests
are sequential with bounded body sizes/timeouts and fail closed on HTTP errors.
This trusts the selected REST source's canonical mainnet height mapping and
Bitcoin's fixed bits within each period; it is not a full historical chain
validator. Cross-check the printed hash/work/context with an independent trusted
source before hard-coding a launch constant. The committed launch checkpoint is 969696 and issuance starts at
971559 (`contract/launch.js`); this tool never changes either constant.
