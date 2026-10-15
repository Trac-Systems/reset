# reset-signer

Local Node 23.11.0 signer. Uses **trac-wallet 2.1.0**, a 0700 directory and 0600
scrypt/AES-256-GCM keystore. Offline signing commands and an optional local stdio
MCP service. No plaintext wallet export or generic blind-sign operation.
Public addresses are 64-hex Ed25519 public keys.

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
npm ci
npm test
npm pack
npx --yes --package ./reset-signer-0.1.0.tgz reset-signer init
```

Password: `RESET_SIGNER_PASSWORD` or hidden prompt, minimum 12 characters. Import
mnemonic: `RESET_SIGNER_MNEMONIC` or hidden prompt. Neither is accepted in arguments.
Back up `~/.reset-signer/keystore.json`; the mnemonic is encrypted inside it and
is not printed. `--directory` changes the storage directory. Existing files are
never overwritten. JavaScript strings cannot be reliably wiped; secret byte
buffers are cleared when no longer needed. Prefer a short-lived CLI process.

Offline commands emit one JSON object to stdout; errors emit `{error}` and exit nonzero:

```text
init
import
address
sign_and_solve move.json --state state.json [--max-attempts 10000000]
sign_transfer prepared.json --context trusted-context.json
sign_challenge challenge.json --audience http://127.0.0.1:3100
verify signed.json [--state state.json] [--context trusted-context.json] [--audience ORIGIN]
mcp --gateway TRUSTED_ORIGIN [--context trusted-context.json]
```

`verify` returns `{valid}`. For moves it checks signature and envelope; with `--state`
it additionally checks the latest tip and puzzle. For transfers pass
`{transfer: <original preparation>, signature}` and trusted context. For login
pass `{challenge,signature}` and the expected audience.

Move state must come from a separately trusted, current gateway snapshot. The
offline signer cannot discover a stale or dishonest snapshot by itself. It
requires the latest tip (stricter than the contract's tip-2 window), matching
difficulty, a maximum two-minute preparation lifetime and its own address.
Puzzle work yields periodically, supports cancellation in the library and has
an adjustable attempt limit. A timeout or exhaustion never produces a signature.

`mcp` starts the official SDK **1.32.1** stdio service. Initialize the local
keystore first. It unlocks once, keeps the wallet in this local process, and
clears the secret-key buffer when the client closes or the process is stopped.
MCP owns stdin/stdout; hidden password prompting uses the controlling terminal.
Clients without a terminal must inherit `RESET_SIGNER_PASSWORD` from a local
launch environment. The password is never a flag/tool argument or logged.

Configure the gateway with `--gateway` or `RESET_GATEWAY_URL`. Alternatively use
`--mcp-url` / `RESET_MCP_URL` for a trusted hosted MCP origin: login and renewal
are automatic. If both are set, state/account reads use the trusted gateway and
preparation/submission uses hosted MCP. Remote origins require HTTPS; redirects
are refused. These are trusted unsigned state sources; internal consistency
checks cannot establish their honesty. `--directory` / `RESET_SIGNER_DIRECTORY`
selects the keystore. Transfers require `--context` / `RESET_SIGNER_CONTEXT` as
an independently trusted local JSON file with the pins described below.

Tools: `status`, `address`, `post_headers`, `lottery_guess`, `mine_claim`, `lock`, `unlock`,
`withdraw`, `transfer`, `rules`. `post_headers` reads new Bitcoin headers from
`--header-source` / `RESET_HEADER_SOURCE` (default https://mempool.space), checks
that they hash and link correctly, and posts them as a `header` move. All tool amounts are **coin strings**, e.g.
`{"amount":"0.00000010"}` is ten integer units. Outputs use eight decimals.
`mine_claim {}` requests exactly the eventual fair share (level 1000); above
1000 requires `allow_over:true` and displays the penalty. A transfer displays
the exact movement and own-MSB TNK fee source through MCP logging and stderr
before signing. No arbitrary signing or wallet export is available.

Moves refresh state before preparation and after solving, refusing changed tips
or difficulty. Puzzle time is reported; progress uses MCP logging, progress
notifications when requested, and stderr. Defaults are 10 million attempts and
90 seconds. Set `--max-attempts` / `RESET_SIGNER_MAX_ATTEMPTS` and
`--max-work-ms` / `RESET_SIGNER_MAX_WORK_MS` (at most 110000 ms) to change bounds.
Stdio stdout contains only protocol messages. Startup failures go to stderr. Calls refuse overlap. Submission results distinguish accepted,
rejected and unknown; observe settlement before repeating an uncertain action.
Client configuration examples and game rules are in `docs/llms.txt` at repo root.

Trusted transfer context pins `networkId`, `incomingWritingKey`, `subnetBootstrap`
and `msbBootstrap`; `txv` is supplied by preparation. The signer reconstructs
`{type:"transfer",value:{to,amount}}` in that property order, hashes its UTF-8 JSON
bytes with BLAKE3, constructs the MSB preimage and signs the 32 transaction bytes.
It refuses extra fields, foreign contexts, expired preparations and mismatches.
Review recipient and integer units before signing. The TNK fee comes from your
own MSB address.

Transfer command hashes are BLAKE3 over UTF-8 bytes (trac-peer `utf8-strict`);
the signer recomputes them locally and refuses anything else.

## Dashboard

```sh
RESET_GATEWAY_URL=https://GATEWAY_URL node bin/reset-signer.mjs dashboard [--port 4747]
```

Opens a one-page dashboard at `http://127.0.0.1:4747` (loopback only): your coins,
earnings over time, the Mine, the lottery while it runs, and the network. It is
read-only and never unlocks the wallet: it reads only the public address from
`keystore.json` (or `--address`, or `RESET_ADDRESS`) and asks the gateway for
current state every 15 seconds. The gateway reports current state only, so the
dashboard keeps its own earnings history in `dashboard-history.json` next to the
keystore, one sample per counted block. That history starts when the dashboard
first runs; older samples are rotated into `dashboard-history.1.json`.

Library exports: `init`, `importMnemonic`, `getAddress`, `unlock`, `createWallet`,
`publicAddress`, `wipeWallet`, `signAndSolve`, `signTransfer`, `signChallenge`,
`verify`, `verifyMove`, `verifySignature`. Pure wire helpers and puzzle functions
are available as `reset-signer/wire` and `reset-signer/pow`. Only the signer library
imports wallet creation; the hosted MCP service imports the public wire helpers.

```js
import { unlock, signAndSolve, wipeWallet } from 'reset-signer';
const wallet = await unlock({ directory, password });
try { const signed = await signAndSolve(wallet, move, { state }); }
finally { wipeWallet(wallet); }
```
