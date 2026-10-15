# RESET MCP

Official `@modelcontextprotocol/sdk` **1.32.1**, Streamable HTTP at `/mcp`, JSON
responses, stateless per HTTP request. Login sessions live in bounded memory.
The service has no wallet instance, key loading, mnemonic input or account database.

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
npm ci --prefix signer
npm ci --prefix mcp
npm test --prefix mcp
RESET_GATEWAY_URL=http://127.0.0.1:49223 npm start --prefix mcp
```

Default listener: `127.0.0.1:3100`. Configure `RESET_MCP_HOST`, `RESET_MCP_PORT`,
and `RESET_MCP_ORIGIN` (the exact trusted client-visible origin). A public bind
requires an explicit origin. The implementation is ready for an HTTPS reverse
proxy, see `deploy/RUNBOOK.md` for hosting.
Host and Origin must match; forwarded IP headers are deliberately ignored. A
reverse proxy therefore shares its IP budget unless integration adds a carefully
configured trusted-proxy policy. There is no CORS or OAuth discovery endpoint:
low-level clients use the signed-challenge flow in `docs/SPEC.md` then supply Bearer auth.
Agents can instead use `reset-signer mcp`; it handles local signing and login.

All seven tools require login. Rate limits cover HTTP traffic, including login:
120/IP/minute and 60/address/minute, shared by all sessions of that address.
Challenge validity is 60 seconds; session validity is 10 minutes. Each challenge
is audience/address/IP bound and consumed even on a bad signature. Tokens are
stored by SHA-256 digest. Restarting the process invalidates all tokens.

Limits: 16 KiB input bodies, 10-second body timeout, 5-second gateway timeout,
256 KiB gateway response, 10,000 entries per rate/challenge/session map. Redirects
are refused. Only fixed `/v1` routes at `RESET_GATEWAY_URL` are reachable. Tool
schemas reject unknown fields and submissions must match the login address.
The gateway and contract remain authoritative for balances, puzzles and capacity.

`createMcpService(options)` is importable from `lib/server.mjs`; tests can configure
limits, clock and timeouts. `listen()` returns the local URL; `close()` closes
MCP transports and HTTP connections. Rules are read from `../docs/llms.txt`.

The fake gateway in `test/fake-gateway.mjs` independently checks Ed25519 signatures
with trac-peer's own wallet, puzzle bytes with the supplied Intercom reference,
and MSB transaction hashes with `Protocol.generateTx`. It models balances, exit
maturity, capacity and replay. It does not implement Bitcoin header ingest or
charge real TNK; these belong to the foundation's integration tests.

For the same seven-tool client loop against a real **local test fixture**, run
`node scripts/e2e-real-gateway.mjs` from the root. Configure:

- `RESET_GATEWAY_URL`: the only gateway connection setting; must be loopback HTTP.
- `RESET_MCP_URL`: optional existing loopback MCP origin; otherwise the runner creates a local MCP listener.
- `RESET_E2E_KEYSTORE`: a disposable signer directory under root `.test-tmp/` or `.devnet/`.
- `RESET_SIGNER_PASSWORD`: its password, local only.
- `RESET_E2E_CONTEXT`: path to trusted transfer context JSON (see signer README).
- `RESET_E2E_RECIPIENT`: another local test address, 64 hex characters.

The fixture must have no existing exits at the signing address, at least 13
spendable coin units, TNK test funds and sufficient move capacity. The runner
waits for counted-height exit maturity (up to four minutes), observes application
and checks both final balances. It refuses external gateways or non-temporary
keystores. It never creates or funds a network. Start `scripts/devnet.mjs` first
for a complete fixture with exit_wait=1; see `docs/DEVNET.md`.

Peers run trac-peer with `txContentHash: 'utf8-strict'`; install the committed lockfile.
`node scripts/llms-check.mjs` independently checks the client recipe in
tests/fixtures/client-plan.txt against the same local MCP/gateway.

SDK reference: https://ts.sdk.modelcontextprotocol.io/server
