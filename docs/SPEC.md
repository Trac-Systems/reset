# RESET — technical specification

RESET is a coin that lives in an Intercom (trac-peer) contract and is clocked by Bitcoin block headers. Agents mine it
by playing games through signed, gas-free messages. Transfers and all other actions are contract transactions via MSB
with a TNK fee. This repo is a fork of the Intercom template (upstream `Trac-Systems/intercom` 4ab5299, trac-peer
2e6f458 = 0.4.11 with `txContentHash: 'utf8-strict'`, trac-msb ea72a9c).

**The words "RESET" / a ticker must never appear in contract code** (`contract/**`). Repo, docs, MCP and signer may
use it. Contract code says "coin".

## 0. Fixed rules
- Issuance: **3.125 coins per counted Bitcoin block**, constant forever, no halving. 8 decimals → 1 coin = 100,000,000
  units; issuance = **312,500,000 units per block**. All amounts are integer units, stored and transported as decimal
  strings, computed with BigInt. No floats anywhere in amounts.
- Gateway share: **1 % of each block = 3,125,000 units**: 90 % (2,812,500) split equally among active gateways (integer
  division; remainder → game pool), 10 % (312,500) to the address that posted the first valid copy of that block's
  header, from the first coin block on. While fewer than **3 active gateways** exist, the gateways' 90 % goes to the
  **gateway reserve** (locked in the contract, owned by nobody). From the first counted block with ≥ 3 active gateways
  on, each block additionally releases `min(reserve, 3,125,000)` from the reserve, split equally among active gateways
  (remainder stays in reserve).
- The other **99 % (309,375,000)** of each block funds the bootstrap lottery during its window; unused slots and
  division dust go to Mine. Outside the window all 99 % goes to Mine. `pool/game` is Mine stock S; `pool/mine_vein`
  holds buffered overflow. Gateway division remainders also go to Mine.
- **Admin key is never nulled.** No code path, script or doc step calls `updateAdmin(null)`.
- **Non-custodial.** No server ever holds a player key. Players sign locally.
- Admin settings before any real run: `chat_status` on, transactions enabled, whitelist off, **auto_add_writers off**
  (players never become writers). Gateways are writers added by the admin.

## 1. Two paths
| Action | Path | Cost |
|---|---|---|
| Mining moves (header post, deposit lock/unlock/withdraw, gateway beat, lottery guess, Mine claim) | message signed by the player, written by a gateway with `ProtocolApi.post(prepared, signature, nonce)` (`peer.protocol.instance.api`, needs `apiMsgExposed: true`, gateway must be a writer) → contract `messageHandler` (returning an error rejects the message) | free; puzzle + capacity + rate |
| Coin transfers + every non-mining action (admin settings, gateway registry) | contract transaction via MSB (`api.tx`, surrogate: the player signs, TNK fee from the player's own MSB address) | TNK fee |

Message facts (trac-peer 0.4.9, verified): message JSON ≤ `msgMaxBytes()` (8 KB), tx ≤ 4 KB; apply checks
`chat_status === 'on'`, whitelist, mute, signature over `JSON.stringify(prepared) + nonce` against
`dispatch.address` (64-hex Ed25519 public key), replay via `sh/<signature>`; the contract's message handler runs on
apply and may `put` non-reserved keys. HTTP RPC has no msg route → the gateway exposes posting itself.

## 2. Move envelope
`dispatch.msg` is a JSON string of exactly this object (canonical = stable JSON, keys sorted, no whitespace):

```json
{ "v": 1, "t": "<move type>", "b": <height int>, "h": "<64-hex block hash of height b>", "p": { ... }, "w": "<puzzle nonce, 1-32 hex chars>" }
```

- `b`/`h`: a counted-or-pending header the player saw. Accepted only if `h` is the hash at height `b` on the current
  best chain and `tip - 2 ≤ b ≤ tip` (tip = best-chain height at apply time). Binds the puzzle to a fresh block, so
  nobody can precompute.
- Puzzle: `sha256(stableJSON({ a: <address>, b, h, p, t, v, w }))` must have ≥ `bits(t)` leading zero bits. Exact
  stable-JSON and bit counting = Intercom sidechannel PoW (test vectors in `tests/fixtures/intercom-vectors.json`).
- `bits(t)`: `header` and `gw_beat` → 0 (Bitcoin PoW / gateway registry is their spam cost). All other moves:
  `move_bits` (default 12), except `guess`, which uses `guess_bits` (default 20). Each is adjusted per counted block by demand: moves applied at the previous tip height
  > capacity/2 → +1 bit; < capacity/8 → −1 bit; never below that move's floor, never above 32. Stored in state so gateways
  and contract agree.
- Capacity: at most `capacity` (default 600) puzzle moves applied per tip height in total, at most `per_address`
  (default 6) per address per tip height. Over the limit → rejected.
- Every rule is a **pure function in `contract/rules/`** used by both the contract and the gateway pre-check, so the
  gateway never writes what the contract would reject.

Move types (`t`):
| t | p | effect |
|---|---|---|
| `header` | `{ "hx": ["<160-hex raw header>", ...] }` (1–20 headers, consecutive) | beacon ingest; first valid poster of each header recorded |
| `lock` | `{ "amount": "<units>" }` | balance → deposit |
| `unlock` | `{ "amount": "<units>" }` | deposit → exiting, releasable at `counted_height + exit_wait` (default 144) |
| `withdraw` | `{}` | all released exiting → balance |
| `gw_beat` | `{}` | an admin-registered gateway marks itself active for this tip height |
| `guess` | `{ "tb": <target height integer>, "n": "<8 lowercase hex>" }` | one lottery guess per address per target, while `tip <= tb - 3` |
| `claim` | `{ "r": <round integer>, "q": <integer 0..2000> }` | snapshot a positive deposit and claim thousandths of the fair share in that round's first three tip heights |

`commit` and `reveal` are not move types. Mine uses one visible relative claim; see §10.

## 3. Bitcoin beacon (exchangeable "beacon slot")
Module `contract/beacon/` with a small interface (`ingest(headers, poster)`, `tip()`, `hashAt(height)`,
`countedHeight()`, `onCounted(cb)`) so other beacons (LTC/DOGE headers, drand) can replace it. Bitcoin implementation:
- Hard-coded checkpoint at a **difficulty-period start** (height % 2016 == 0): height, hash, bits, time, chainwork. Chosen
  at launch; tests use their own.
- Each header: parse 80 bytes; prev-hash links to a known header; double-SHA256 ≤ target(bits); `bits` equals the
  expected value (exact 2016-block retarget with the 4× clamp, using stored period-start time; no testnet 20-minute
  rule); timestamp > median of previous 11 (when known); cumulative work tracked; most cumulative work = best chain.
- A height is **counted** when it is 6 deep on the best chain (`tip - 5 ≥ height`, i.e. 6 confirmations including the
  tip). Counting is final and never rolls back; a reorg deeper than that is ignored (headers that would re-org a counted
  height are rejected).
- Issuance/payouts run once per counted height, in height order, inside the apply of the message that made it counted.
- Prune: keep full header records only for the last 2016 + branches within 12 blocks of tip; for counted heights keep
  `hash/<height>` forever (it is the randomness).
- Test beacon: same code with regtest-style params (powLimit `0x207fffff`, retarget off via param) so tests mine headers
  in JS in milliseconds. Real mainnet history fixtures (a full retarget period incl. the boundary) live in
  `tests/fixtures/` (fetched once from public data, e.g. mempool.space `/api/block/<hash>/header`, committed).

## 4. Ledger state (keys are lowercase, no coin name)
`bal/<addr>`, `dep/<addr>`, `exit/<addr>` (list of `{amount, release}`), `pool/game`, `pool/gwreserve`,
`gw/<addr>` (registered, `last_beat`), `supply/issued`, `cnt/<height>` (counted marker + poster + per-block payout
record), `diff/<t>`, `load/<height>`. Invariant tested after every operation in every test: **sum of all balances +
deposits + exiting + pools == supply/issued**.

## 5. Contract transactions (MSB path, TNK fee)
- `transfer { to: <64-hex addr>, amount: "<units>" }` — sender = signer of the MSB tx.
- Admin only: `gw_set { addr, on: bool }`, `params_set { key, value }` for knobs (`move_bits`, `capacity`,
  `per_address`, `exit_wait`, and §10 game knobs). Mine knob changes take effect from the next tip round; all other
  changes take effect at the next counted height. The bootstrap lottery window locks once used.
- Reads (free, local view): balances, deposits, exits, pools, tip, counted height, difficulty, capacity left, gateways.

## 6. Gateway (Feature `features/gateway/`)
Runs inside a writer peer. Exposes a local HTTP JSON API (bind 127.0.0.1 by default, port knob). The MCP server talks
to it; the gateway is never a wallet for anyone but itself.
- `GET  /v1/state` → `{ tip: {height, hash}, counted, bits: {<t>: n}, capacity_left, per_address, params, gateways, lottery, mine }`
- `GET  /v1/account/:addr` → `{ balance, deposit, exits, moves_this_height, mine }`
- `POST /v1/move` body `{ prepared, signature, nonce }` → pre-check with `contract/rules` against the current view
  (schema, `b`/`h`, puzzle, capacity, rate, balances, signature) → `api.post` → `{ ok, error? }`. Rejected moves are
  never written. Per-IP and per-address rate limits in memory.
- `POST /v1/tx/prepare` and `POST /v1/tx/submit`: thin pass-through to trac-peer `generateTx`/`api.tx` for transfers
  (the player's signer signs the tx hash). No keys held.
- Header watcher (optional knob): fetches new Bitcoin headers from a configured source, posts them as its own signed
  `header` moves (it earns the 10 % poster share like anyone). It waits `headerDelayMs` (default 60 000) after first
  seeing a new block, so agents get the first chance to post it; the gateway posts only as a fallback.
- `gw_beat` once per tip height when registered.

## 7. MCP + local signer
- Hosted MCP server (`mcp/`, Streamable HTTP, Node): tools `reset_state`, `reset_account`, `reset_prepare_move`,
  `reset_submit_move`, `reset_prepare_transfer`, `reset_submit_transfer`, `reset_rules` (plain-language rules text).
  Login = signed challenge (no accounts); limits per address and per IP. Talks only to a gateway's HTTP API.
- `prepare_move` returns the exact envelope minus `w`, the required bits, and the exact `prepared` message skeleton.
- Local signer (`signer/`, runnable via `npx`, uses upstream trac-wallet 2.1.0): create/import key (mnemonic,
  encrypted keystore), show address, **solve the puzzle locally**, sign the prepared message, sign a transfer **after
  recomputing what it signs locally** (never blind-signs a hash the server hands over without checking it matches the
  shown transfer). Flow: prepare (hosted) → `sign_and_solve` (local) → submit (hosted).
- `docs/llms.txt`: how an agent plays, in plain words.

### Local stdio MCP

`reset-signer mcp` uses the official MCP SDK and stdio transport. It runs only on
the player's machine, unlocks the encrypted keystore once, and exposes these tools.
It has no network listener and no key-export or arbitrary-signing tool. The hosted
MCP remains keyless and keeps the low-level §7a interface.

| Tool | Arguments | Behavior |
|---|---|---|
| `status` | `{}` | Tip/counting, lottery and Mine windows, own balance/deposit/exits/strikes, fair-share estimate, difficulty and remaining capacity |
| `address` | `{}` | Own public hex address |
| `post_headers` | `{}` | Fetch up to 20 headers after the network tip from a Bitcoin REST source (`--header-source`, default mempool.space), check hashes and links, post one `header` move; if the source disagrees with the tip, start after the counted height |
| `lottery_guess` | `{target?,guess?}` | Default next eligible target, skipping full targets and this process's accepted guesses; random eight-lowercase-hex guess |
| `mine_claim` | `{level?,allow_over?}` | Default 1000, exactly the eventual fair share; integer 0..2000; levels above 1000 require `allow_over:true` and show the excess-times-strikes penalty |
| `lock`, `unlock` | `{amount}` | Move spendable coins into deposit, or start exiting deposit |
| `withdraw` | `{}` | Withdraw all mature exits, subject to unsettled-claim protection |
| `transfer` | `{to,amount}` | Show exact sender/recipient/amount and own-MSB TNK fee source before checked signing and submission |
| `rules` | `{}` | Plain-language rules |

Unknown arguments are rejected. Amount inputs are positive **coin strings** with
at most eight decimals, without exponent/sign/leading zeros; outputs use exactly
eight decimals. Conversion uses BigInt; wire amounts remain integer-unit strings
of at most 78 digits. No envelope, puzzle nonce, signature or transaction hash is
required from or returned to the tool caller. Results are JSON text with plain
messages, except `rules` which is plain text. Failure sets `isError`. Submissions
report `outcome: accepted|rejected|unknown`; acceptance is not application/finality.
No submission is automatically retried, including an uncertain transfer.

Configuration flags override environment: `--gateway` / `RESET_GATEWAY_URL`,
`--mcp-url` / `RESET_MCP_URL`, `--directory` / `RESET_SIGNER_DIRECTORY`,
`--context` / `RESET_SIGNER_CONTEXT` (trusted local JSON file), `--max-attempts` /
`RESET_SIGNER_MAX_ATTEMPTS`, and `--max-work-ms` / `RESET_SIGNER_MAX_WORK_MS`.
At least one service origin is required; remote origins require HTTPS. Gateway-only
mode prepares locally. Hosted mode signs the audience-bound login challenge locally
and renews its session before expiry. If both origins are configured, trusted state
and account reads come directly from the gateway while preparation/submission uses
hosted MCP. Hosted-only mode explicitly trusts that configured origin for fresh
state reads. Transfers always require independently supplied context pins from §7a.

Password comes only from `RESET_SIGNER_PASSWORD` or one hidden controlling-terminal
prompt at startup, never MCP stdin or a tool argument. GUI clients without a
controlling terminal must supply the local environment variable. Stdout contains
only MCP messages; public progress/review goes to MCP logging and stderr. A progress
token additionally receives MCP progress notifications. The default work limits
are 10,000,000 attempts and 90 seconds (configurable time at most 110 seconds);
cancellation/exhaustion never submits. Each move gets coherent fresh state/account
reads, checks the requested payload against preparation, uses the existing signer
checks, and refreshes tip/hash/difficulty again after solving before signing.
Inconsistent state is refused; these checks cannot authenticate a dishonest state
source. Calls are serialized by refusing overlapping tools while one is running.
HTTP reads have a five-second timeout and 256 KiB response ceiling; redirects are
refused and only fixed service routes are used. Stdio buffers are limited to 16 KiB.

The local process remembers its accepted lottery targets only for its lifetime;
after restart an already-used default target may be rejected, requiring an explicit
target. The current public account API does not expose per-address pending guesses.
`docs/llms.txt` is short human/agent guidance; the executable low-level compatibility
recipe is `tests/fixtures/client-plan.txt`. The package bundles the same rules text,
with a test enforcing equality, so installed tarballs do not need repository files.

### 7a. Wire details

Hex is lowercase. Amounts are positive canonical decimal strings (no signs, leading zeros or fractions), subject to
the existing 8 KiB message / 4 KiB transaction limits. Signatures are 128 hex characters. The signature `nonce` is
32 random bytes encoded as 64 hex characters, separate from puzzle `w` (1–32 hex characters).

MCP tools take these exact argument objects; additional fields are rejected:
- `reset_state {}`, `reset_rules {}`.
- `reset_account {address?}` (defaults to the authenticated address).
- `reset_prepare_move {t,p}` and `reset_submit_move {prepared,signature,nonce}`.
- `reset_prepare_transfer {to,amount}` and `reset_submit_transfer {tx,prepared_command,address,signature,nonce}`.

Tools use the authenticated address for preparation and require that same address on submission. Results are JSON
in MCP text content, except `reset_rules`, which is plain text. Tool failures set `isError`. A gateway submission
result `{ok:false,error}` is preserved. State and accounts are public reads but the hosted tools require login.

Move preparation is `{envelope,bits,prepared,issued_at,expires_at}`, where `envelope` is §2 without `w`, bound to
the current tip. `prepared` is the trac-peer 0.4.9 `prepareMessage` skeleton in this property order:
`{dispatch:{type:"msg",msg:stableJSON(envelope),address,attachments:[],deleted_by:null,reply_to:null,pinned:false,pin_id:null}}`.
The signer inserts solved `w`, regenerates `dispatch.msg` using stable JSON, and signs UTF-8 bytes of
`JSON.stringify(prepared) + nonce`. It emits exactly `{prepared,signature,nonce}`. No server solves the puzzle.

`issued_at` / `expires_at` are local-client/MCP Unix milliseconds (never contract clocks), at most 120 seconds apart.
The signer rejects expired/future preparations and checks expiry again after solving. It requires a separately
supplied trusted current `/v1/state` snapshot and conservatively signs only at its exact tip. The contract's
tip-2 acceptance window is unchanged. Offline checks cannot establish that the supplied snapshot is honest/current.
The default local work ceiling is 10,000,000 attempts; exhaustion never produces a signature. Callers may raise it.

Gateway transfer wire:
- `POST /v1/tx/prepare` receives `{address,to,amount,nonce}`; MCP generates this 64-hex nonce.
- Response: `{address,to,amount,prepared_command,tx,nonce,context}` where
  `prepared_command = {type:"transfer",value:{to,amount}}` in that property order and
  `context = {network_id,txv,writer,content_hash,subnet,msb}`. All context fields except `network_id` are 64-hex.
- `network_id` is an integer in 1..4294967295. `writer` is the gateway writing key, not the player's address.
- `content_hash = BLAKE3(UTF8(JSON.stringify(prepared_command)))` (32 bytes).
- `tx = BLAKE3(u32be(network_id) || hex(txv) || hex(writer) || hex(content_hash) || hex(subnet) || hex(msb)
  || hex(nonce) || u32be(12))`. This is trac-peer `Protocol.generateTx` / trac-msb `createMessage` for operation TX.
- `POST /v1/tx/submit` receives `{tx,prepared_command,address,signature,nonce}`. Signature covers the **32 decoded
  transaction bytes**, not its hex text or another appended nonce. `address` is the payer/signer; MSB charges it TNK.

MCP checks that the gateway echoed the requested address, recipient, amount and nonce, and validates both hashes.
It returns a local-signer packet `{address,to,amount,prepared_command,tx,nonce,command_hash,context,issued_at,expires_at}`,
mapping `content_hash` to `command_hash` and context to
`{networkId,txv,incomingWritingKey,subnetBootstrap,msbBootstrap}`. The signer independently recomputes both hashes and
requires a trusted local context pinning `networkId`, `incomingWritingKey`, `subnetBootstrap`, `msbBootstrap`.
`txv` comes from the preparation; it is authenticated by the transaction signature and checked by MSB. No arbitrary
command or arbitrary hash signing interface is exposed.

Command hashes are BLAKE3 over the UTF-8 bytes of the JSON command (trac-peer `txContentHash: 'utf8-strict'`).

Login is a separate HTTP flow (not an additional MCP tool):
- `POST /auth/challenge {address}` returns `{v:1,domain:"reset-mcp-login",audience,address,nonce,issued_at,expires_at}`.
  `audience` is the configured MCP origin; nonce is 32 random bytes in hex; lifetime defaults to 60 seconds.
- `sign_challenge` signs UTF-8 `RESET MCP LOGIN`, then one LF byte (0x0a), then `stableJSON(challenge)`.
  It requires a locally supplied expected audience and checks address, lifetime and domain.
- `POST /auth/login {challenge,signature}` verifies the issued, IP-bound challenge. Each attempt consumes it,
  including a failed signature. Success returns `{token,token_type:"Bearer",expires_at,address}`. Token lifetime
  defaults to 10 minutes; only its SHA-256 digest is stored. No account records or player keys exist on the server.
- Clients send `Authorization: Bearer <token>` to `/mcp` using Streamable HTTP. HTTP errors use `{error}` and the
  appropriate status; auth failure is 401, rate limiting 429, body limit 413, timeout 408.

MCP defaults: 120 requests/IP/minute, 60/address/minute (shared across sessions), 16 KiB request body, 10-second body
timeout, 5-second gateway timeout, 256 KiB gateway response, 10,000 entries per in-memory rate/challenge/session map.
The server validates Host/Origin, ignores forwarded IP headers, refuses gateway redirects and only calls fixed routes
at its configured gateway origin. It uses stateless Streamable HTTP requests; login tokens supply application sessions.
The hosted service has no local signer interface or secret inputs. Local keystores use scrypt (N=32768,r=8,p=1),
AES-256-GCM, authenticated metadata, private directory 0700 and file 0600; creation never overwrites an existing file.

## 8. Blind relay
Feature `features/blind-relay/`: Holepunch `blind-relay` 1.6.1 server on `peer.swarm` plus client use of
`swarm.dht.connect(remote, { relayThrough })` for peers that cannot connect directly.
Must carry subnet replication (Autobase) and sidechannels for peers whose direct connections fail.

Runtime interface: `--blind-relay-serve 1` enables the server; `--blind-relay <64-hex-key,...>` enables
client fallback. Both roles can run together, but a peer cannot name itself as a relay. Keys are the relay's
**swarm public keys**, not Autobase writer/bootstrap keys. Malformed keys or non-positive/non-integer limits fail
startup. Without either flag this Feature is disabled. Configure the relay list on both endpoints.

The client tries direct first, then uses Hyperswarm's `relayThrough` callback and
`swarm.dht.connect(remote, { keyPair: swarm.keyPair, relayThrough })`. General dial failures and bounded timeouts
also trigger fallback. Relay keys rotate per destination; after exhausting the list, the next attempt is direct
again. Hyperswarm owns discovery, connection admission, retry backoff and `connection` events, so trac-peer's
existing Corestore replication and Sidechannel handlers see the same authenticated Noise connection. Retry state
is kept alive for peers still requested by Hyperswarm; leaving a topic or banning a peer still prevents retries.
Instance-local HyperDHT hooks track inbound relays, preserve the existing firewall and reject unconfigured inbound
relay choices. Hooks are restored on stop. The MSB swarm is outside this Feature's scope.

All flags below take positive integers; byte limits count observed raw UDX receive bytes, once per relay ingress.

| Flag after `--blind-relay-` | Default | Meaning |
|---|---:|---|
| `max-sessions` | 128 | Maximum active paired tunnels |
| `max-sessions-per-peer` | 8 | Pending plus active links per authenticated control-peer key; also caps its control sessions |
| `max-clients` | 256 | Maximum control sessions across all peers |
| `max-pending` | 256 | Maximum unmatched pairing tokens across all peers |
| `rate-bytes-per-second` | 8388608 | Aggregate server traffic budget, replenished per second |
| `rate-burst-bytes` | 16777216 | Aggregate burst allowance |
| `idle-timeout-ms` | 120000 | Wire-idle link/session timeout and maximum unmatched-token age |
| `direct-timeout-ms` | 15000 | Maximum time for a direct dial |
| `relay-timeout-ms` | 20000 | Maximum time for a relay dial and subsequent receive-silence deadline |
| `sweep-interval-ms` | 250 | Resource-accounting interval |

Limits reject new work before pairing resources are allocated. The traffic budget is a sampled cutoff: exceeding
it closes current server relay sessions; it does not shape UDP packets. Traffic can overshoot by the bytes received
between sweeps. Wire-idle means no transport bytes, including keepalives; the relay cannot inspect application
activity. Quotas identify authenticated transport keys and do not provide Sybil resistance.

Startup prints a `[blind-relay]` status snapshot. Authenticated sc-bridge `stats.blindRelay` and
`info.info.blindRelay` expose live sessions, active/pending pairs, active control peers relayed, received bytes,
completed pairings, rejection/timeout counters, client relay connections and configured limits. No payloads or
private keys appear in status. Native UDX forwarding carries the endpoint Noise ciphertext; ordinary subnet or
sidechannel participation by the relay node is separate and must use separate discovery channels when that node
is intended only as a transport relay. No inference, pairing-business or application proxy protocol is added.

`blind-relay` is pinned and overridden to 1.6.1, and `hyperdht` to 6.29.6, so HyperDHT and the Feature use one
copy each. The admission adapter uses the pinned blind-relay decoded pair-handler and link lifecycle internals;
transport hooks use the pinned HyperDHT inbound relay handler and Hyperswarm peer retry fields. Changes to these
dependencies require rerunning the local relay integration suite.

## 9. Launch shape (for reference)
1 gateway (+ MCP), 1 indexer (admin), 1 blind relay. Indexers go 1 → 3, never 2.

## 9a. Ledger, beacon and gateway details

These fill unspecified details; the move object and existing HTTP paths above remain unchanged.

- Wire addresses, hashes, raw headers, signatures and puzzle nonces use lowercase hex. Amounts in units are canonical
  unsigned decimal strings, at most 78 digits; lock/unlock/transfer require a positive amount. The display parser
  accepts at most eight decimal places and never uses floating point. JSON envelopes reject extra/duplicate keys,
  noncanonical spelling and nesting deeper than 16. Prepared messages use the exact upstream `prepareMessage` shape,
  with empty attachments and null reply/pin/deletion fields.
- The checkpoint is already final, with no issuance for the checkpoint or any earlier height. The launch checkpoint
  and coin start are hard-coded in `contract/launch.js` (checkpoint 969696, coin start 971559). Test-only peer
  configs inject a regtest checkpoint; there is no HTTP or transaction knob for replacing the beacon.
- Equal cumulative work keeps the incumbent chain. Header batches are atomic and consecutive. A known header is an
  idempotent no-op and never replaces its first poster. A move containing only known headers is rejected with
  `header_known`, preventing zero-cost re-signing of already-used PoW. A callback/issuance runs only after the whole batch validates.
  Full records carry their period-start timestamp and rolling eleven timestamps, so pruning cannot lose retarget or
  median-time-past context. Only timestamps known since the checkpoint are used in its first eleven descendants.
- A gateway is active when registered and `last_beat` equals the best tip height immediately before the header message.
  That active set is frozen for all blocks counted in that message; a gateway must beat again at the new tip. This
  avoids making the newly advanced tip require a heartbeat that could not have arrived before the header. Repeated
  beats at one tip are rejected. Newly registered/re-enabled gateways must beat before earning a share.
- Demand for a header batch is the number of puzzle moves at its pre-message tip, frozen for each counted block in
  that batch. All puzzle move types share total/per-address counters and the demand adjustment; guesses have their
  own floor and stored difficulty. Header/beat
  moves do not consume those counters. Pending parameter changes apply before the next counted block's adjustment;
  the last pending value for a key wins. Bounds: `move_bits` 0–32, `capacity` and `per_address` 1–100000, `exit_wait`
  1–1000000. The default minimum remains 12. Unlocks with the same release height are coalesced. The contract bounds each
  address to 256 exiting records (see §10), so penalties cannot scan unbounded historical exits.
- Additional internal keys: `beacon/state` (bounded header snapshot), `hash/<height>` (permanent final hashes),
  `params/current`, `params/pending`, `gw/list`, and `rate/<tip>/<address>`. Spec ledger keys remain as listed above.
  `cnt/<height>` stores `{hash, poster, game, reserve, released, credits}`; `reserve` is the resulting reserve balance,
  `released` the amount actually credited after remainder retention, and `credits` maps addresses to unit strings.
- Gateway pre-check runs the very same staged transition as contract apply against one local Hyperbee snapshot,
  alongside upstream chat/whitelist/mute/replay/signature/size checks. Submissions on one gateway are serialized.
  Replication can change state between different gateways' checks and final ordering; consensus revalidates and rejects
  a losing race without ledger writes. A repeated already-applied signature returns `{ok:true}` without appending.
  `{ok:true}` acknowledges local submission/idempotence, not signed finality. Readers should query the account/state.
- Gateway defaults: loopback `127.0.0.1:49223`, header source `off`, 16 KiB HTTP bodies, 10-second request/header limits,
  240 requests/IP/minute, 60 submissions/address/minute, bounded queue of 64. HTTP validation errors return
  `{ok:false,error}`; move rejections use HTTP 200, malformed bodies 400, oversized 413, throttled 429. Automatic
  registered-gateway heartbeats run once per new tip; header polling uses the optional configured REST source.
- Free protocol read helpers: `coinState()`, `coinAccount(address)`, `coinPools()`, `coinHashAt(height)` on
  `peer.protocol.instance.api`. State/account HTTP responses retain §6's shape; gateways contain
  `{addr, registered, last_beat, active}`. These are local, unsigned views.
- The §1 MSB admin path covers contract knobs (`params_set`) and gateway registration (`gw_set`). Initial Intercom
  control-plane setup (chat, transaction enablement, whitelist, automatic writer enrollment, writer membership)
  uses trac-peer's existing admin-signed protocol operations. Those reserved keys cannot be written by a contract;
  `scripts/admin-setup.mjs` uses the upstream terminal handlers for these controls, then MSB for `gw_set`.

### Transfer HTTP wire details

The §6 transaction bodies were previously unspecified. They now use these exact shapes. No server signs for a player.

`POST /v1/tx/prepare` takes `{address,to,amount,nonce}`; the local signer chooses a 32-byte hex nonce. It returns:

```json
{
  "address": "<hex32>", "to": "<hex32>", "amount": "<units>", "nonce": "<hex32>",
  "prepared_command": {"type":"transfer","value":{"to":"<hex32>","amount":"<units>"}},
  "tx": "<hex32>",
  "context": {"network_id": 918, "txv":"<hex32>", "writer":"<hex32>",
    "content_hash":"<hex32>", "subnet":"<hex32>", "msb":"<hex32>"}
}
```

`network_id` above is illustrative; the actual local MSB config supplies it. `content_hash` is BLAKE3 of
`JSON.stringify(prepared_command)` in exactly the displayed property order. The transaction hash is BLAKE3 of
trac-msb `createMessage(network_id, txv, writer, content_hash, subnet, msb, nonce, 12)` with hex fields decoded to bytes.
The signature covers the **32 raw bytes of `tx`**, as upstream `api.tx` verifies (not the textual hex and not `tx+nonce`).
The signer must reconstruct the shown transfer and hashes, and enforce its own expected network/subnet context.

`POST /v1/tx/submit` takes `{tx,prepared_command,address,signature,nonce}` and returns `{ok,result}` or `{ok:false,error}`.
Only `transfer` is exposed by these HTTP routes. Admin transactions use the local admin peer's protocol/MSB path.
`params_set` and `gw_set` CLI commands are JSON objects with an `op` plus their §5 fields, mapped to `{type,value}`.

## 9b. Local devnet and launch tooling

- The installed trac-peer must match the committed **0.4.11** pin, with
  `txContentHash: 'utf8-strict'` on every app peer. Reinstall from the lockfile
  when a checkout still has older `node_modules`.
- The disposable devnet uses the existing test beacon parameters, one indexer,
  three registered gateway writers/MCP services, a separate-channel blind relay,
  local HyperDHT and actual local MSB settlement. Each start creates a fresh run
  under `.devnet/`. It funds named local test player MSB addresses and gifts coin
  from real gateway payouts. Test-only admin setup sets `exit_wait=1`; the contract
  minimum remains 1 and the normal default remains 144. A client waits until
  `state.counted >= exit.release`, then prepares withdraw. No zero-wait contract
  parameter or immediate-withdraw assumption is introduced.
- Player keys remain in local signer test keystores. Devnet bootstrap runs the
  signer CLI locally and passes only public addresses to funding. Runtime gateway
  and MCP services have no access to loaded player wallets. The devnet is never
  a server deployment entry point. The server kit requires explicit network and
  bootstrap settings and does not inject test beacon options.
- A launch checkpoint may include `times`, the chronologically ordered timestamps
  of headers `height-10..height` (or all available at genesis), as already accepted
  by the beacon constructor. The next header's MTP uses those eleven timestamps.
  Since the checkpoint is a period boundary, its `time` is also the period-start
  retarget context. `chainwork` is the decimal integer sum of work through the
  checkpoint, inclusive. The REST checkpoint tool derives it from every mainnet
  difficulty-period start rather than assuming a REST chainwork field. The tool
  prints a constant for review; it never changes the contract checkpoint.
- `tests/fixtures/client-plan.txt` contains a versioned, executable client recipe describing
  login, all seven tools, trusted local signing inputs, maturity and observed
  settlement. The independent check interpreter consumes that text; it has no
  fixture-specific protocol knowledge. Its required operator inputs (trusted
  gateway, transfer context, local keystore and recipient) are explicit. Hosted
  prefixed proxy paths are a deployment routing choice documented in the runbook;
  the underlying MCP/auth wire paths and signed audience origin are unchanged.

## 9c. Pear runtime

- All operational peers (indexer, gateway, blind relay) run in Pear/Bare through
  `npm start -- …` → `scripts/pear-runner.mjs` → `index.js`. Node only supervises
  that runtime, runs the separate MCP service and local signer, and runs local
  test tooling. The historical interactive Pear path remains available.
- Configured peers require `--role` and `--config`; gateways additionally require
  `--gateway 1`, relays `--blind-relay-serve 1`. JSON supplies explicit environment,
  both bootstrap lists/channels, MSB/subnet bootstrap and store directory. No
  configured peer silently uses historical mainnet defaults. Gateway port/header
  flags and existing blind-relay flags remain available.
- `--admin-command init-admin|deploy-subnet|admin-setup` executes in the stopped
  indexer’s Pear process, with `--gateways-file` for registry setup. Commands retain
  the existing admin wallet, wait for application/settlement and exit. No admin
  HTTP route, player key custody or admin-key release is introduced.
- The default contract settings are the committed `contract/launch.js` checkpoint
  **969696** and coin start **971559**. Production config rejects beacon overrides. Only explicit disposable
  devnet control can inject the local regtest beacon; game logic is unchanged.
- Each service peer owns its store and a separate Pear HOME/XDG directory under
  `/srv/reset/<role>`. Neither peer stores nor Pear key directories may be shared
  or copied between peer processes/hosts. `reset-mcp` is a separate, keyless Node
  service with no peer-store access, using the gateway’s loopback HTTP API.
- `scripts/devnet.mjs --pear` launches five Pear processes and three Node MCP
  processes against local DHT/MSB, using the same configured entry point. A private
  stdin-only fixture control is gated on development mode, loopback bootstrap,
  regtest checkpoint and disposable `.devnet/` storage. It never exports a peer
  wallet or accepts player secrets. Player actions keep the existing MCP/local
  signer wire formats. The retained in-process fixture remains a regression test.
- Local acceptance clients refresh preparation and trusted-state reads if a header
  arrives between them, before signing/submitting anything. The executable
  `tests/fixtures/client-plan.txt` recipe uses its bounded wait construct for this check.
  Signer validation and uncertain-submission handling are unchanged.

## 10. Bootstrap lottery and Mine

Game rules in short: a 144-block bootstrap lottery from the coin start (the 10 guesses closest to the last 32 bits
of the target block hash share 99 % of that block), then 99 % of every block flows into the Mine. Mine rounds last 6
blocks; each address makes one `claim {r, q}` in the first 3 (q = claim level in thousandths of its fair share).
Fair shares (guideline × own deposit / claimers' deposits) are paid first, excess only from what is left; claims
above the fair share earn a strike and a penalty of excess × strikes from deposit, then exiting coins; one strike is
forgiven per 24 clean rounds. Stock above capacity goes to a vein buffer, released when a counted block hash ends in
three equal hex digits. The collapse safety arms once the stock has reached half capacity. The following defines the
integer arithmetic, timing, storage and edge cases. Monetary values below are units as decimal strings. Heights, round numbers, claim levels and
per-mille parameters are safe JSON integers. Every division floors; retained dust is never minted or discarded.

### Lottery

The counted-height window is `[lottery_start_block, lottery_start_block + lottery_blocks)`. The development default
start is checkpoint height + 1; the operator must announce/configure the launch start before the window opens.
A guess has exactly `{tb,n}` and needs `tip <= tb-3`, a target inside the window, its `guess` puzzle and the shared
capacity/address allowance. An address may guess once per target, independently of its per-height move allowance.
Each target additionally admits at most `3 * capacity` guesses, with that limit snapshotted by its first guess.
This bounds settlement even when guesses arrive many heights before the target.

When that target is counted, use the display-order block hash's final eight hex digits as an unsigned 32-bit number.
Distance is `min(abs(n-h), 2^32-abs(n-h))`. Rank ascending; tied addresses sort lexically for stable presentation only.
With W winner slots, a tied group of N guesses sharing K remaining slots gets `floor(309375000*K/(W*N))` units each.
All guesses tied at the cutoff win their fraction. Unfilled slots and division dust enter Mine; gateway-share
remainders are never part of lottery prizes. The full permanent result is `{tb,hash,winners:[{address,n,distance,amount}],
paid,to_mine}`. All target records, guesses and per-target duplicate markers are deleted upon settlement.

`lottery_start_block`, `lottery_blocks` and `lottery_winners` become immutable after the first accepted guess or
first counted height at/after the start. Before that, their admin updates apply at the next counted height. Guesses
are rejected as `lottery_pending` while a window change is queued, so an accepted guess cannot be invalidated by a
pending change. `guess_bits` remains adjustable. The lottery cannot be restarted after bootstrap.

### Mine timing and payout

Let H be the checkpoint height. Round r is tip heights `H+1+6*r` through `H+6+6*r`, inclusive. Its claim window is
its first three heights. Round 0 is visible at the checkpoint, but its window has not opened. There is one claim per
address per round. It requires a positive deposit, snapshots its amount d, and accepts exactly `{r,q}`, with
`q` in 0..2000. q=1000 requests the fair share; q=0 is an admitted zero request. The shared capacity bounds admissions
by the sum of the three per-height capacities (1800 at the default). A shallow reorg does not erase claims or reset
per-height admission counters. Settlement occurs once, when the last height of that round becomes counted: normally
five tip heights later. Thus two rounds may have unsettled claims simultaneously.

Each counted block first settles its lottery, if applicable. The unused game inflow enters stock S (`pool/game`),
up to available capacity C; the rest enters `pool/mine_vein`. Before and after the lottery window, all game inflow goes
to Mine. A hash whose last three display hex digits are identical releases the entire vein buffer into S, including
that block's overflow. Previously released vein funds and penalties can keep S above C; the next block caps only its
new inflow, so it does not immediately put the released vein back into the buffer.

At settlement, normally `G = min(S, 1856250000 + floor(max(0,S-floor(C/2))*mine_bonus_per_mille/1000))`.
The constant 1856250000 is six blocks' 99% issuance, even during bootstrap. Only this round's claimers contribute to
D = sum of snapshotted deposits. Each fair share is `f_i = floor(G*d_i/D)` and requested amount is
`c_i = floor(f_i*q_i/1000)`. All `min(c_i,f_i)` are funded first. Remaining excess requests compete pro rata for
remaining S; integer remainders stay in S. Dormant deposits do not enter D. Skipping a round earns nothing and does
not itself cost deposit. There is no commit/reveal, withheld-reveal charge, or free overclaim tolerance.

For a positive excess `e_i = c_i-f_i`, increment strikes, capped at `mine_max_strikes`, and clear the clean counter.
Penalty is `min(current deposit + exiting, e_i*strikes)`. Debit current deposit first, then exiting records in their
stored order, removing empty records; add the penalty to S after payout allocation. A non-overclaiming settled
claim increments the clean counter. Every `mine_clean_rounds` clean participations forgives one strike and clears
that counter; absence neither increments nor resets it. Lowering the strike cap clamps it on the next participation.
First-strike net excess is at most zero; repeated deviations in the simulation lose strictly. It is not a promise
that every individual first overclaim loses strictly.

**Solvency clarification:** excess payout eligibility is capped at the claimant's currently collectible deposit plus
exiting collateral before pro-rata allocation. Without this cap, small/depleted collateral could collect excess that
its mandated penalty cannot cover. Fair-share payouts still use the original snapshot. Penalties themselves remain
based on the full requested excess, not just the paid excess. This prevents profit from exhausting collateral across
overlapping rounds. It closes the insolvency case.

**Exit clarification:** unlock remains allowed immediately, but withdraw rejects `claim_pending` while the address's
latest claimed round has not settled, even if admin reduced `exit_wait` below the settlement lag. This keeps the
snapshot's collateral reachable; after settlement normal maturity applies. Penalties can reach mature but
unwithdrawn exiting records. Unrelated unclaimed addresses retain the original deposit/withdraw behavior.
There are at most 256 exiting records per address: unlock rejects `exit_capacity` if it would create a 257th
record, while same-release coalescing remains allowed. Withdraw clears matured records normally. A legacy account
already above this bound must withdraw enough matured records before claiming. This storage bound ensures even
penalty collection costs at most a fixed 256-record scan per admitted claimant, with no global ledger scan.

If, before payout, `S*1000 < C*mine_collapse_threshold_per_mille`, use `G=min(S,1856250000)` and shrink C to the larger
of `floor(C*(1000-mine_collapse_loss_per_mille)/1000)` and
`floor(configured mine_capacity*mine_capacity_floor_per_mille/1000)`. This lower C persists into following rounds.
An effective change to the configured `mine_capacity` explicitly resets C to that new value and establishes its new
floor; resubmitting the same value does not undo a collapse. Parameters for a round are fixed by its tip-height
configuration, even if it settles after newer parameters become visible.

Amounts floor per address, with no address-order rounding bonus. A ten-way split earns exactly the same when shares
are divisible (tested over 240 rounds), and otherwise may lose division dust; exact equality for arbitrary integer
shares is mathematically impossible. Splitting cannot increase a fixed guideline's aggregate proportional fair share.

### Admin knobs

All use the existing admin-only `params_set {key,value}` MSB operation. Issuance, six-height rounds, three-height
claim windows, 0..2000 relative claims, and the three-equal-hex vein trigger are protocol constants, not settings.

| Key | Default | Allowed values | Effective time |
|---|---:|---|---|
| `lottery_start_block` | checkpoint + 1 | integer 1..2147483647 | next counted height, before window lock |
| `lottery_blocks` | 144 | integer 1..2016 | next counted height, before window lock |
| `lottery_winners` | 10 | integer 1..100 | next counted height, before window lock |
| `guess_bits` | 20 | integer 0..32 | next counted height |
| `mine_capacity` | `"44550000000"` | canonical decimal integer string, 4..(10^78 − 1) | next tip round |
| `mine_bonus_per_mille` | 100 | integer 0..1000 | next tip round |
| `mine_clean_rounds` | 24 | integer 1..1000000 | next tip round |
| `mine_max_strikes` | 4 | integer 1..100 | next tip round |
| `mine_collapse_threshold_per_mille` | 100 | integer 1..1000 | next tip round |
| `mine_collapse_loss_per_mille` | 50 | integer 1..1000 | next tip round |
| `mine_capacity_floor_per_mille` | 250 | integer 1..1000 | next tip round |

Mine changes submitted in round r target r+1. Multiple changes to the same key/round use the last submitted value.
Configuration epochs are pruned after settlement, keeping the one needed by the next unsettled round and newer
scheduled epochs. Other parameters retain their next-counted-height behavior. Difficulty adjustment does not reset
when a floor is reduced: it continues decaying by the demand rule.

### Public reads and storage

`coinState()` and `/v1/state` append:

- `lottery: {start,end,blocks,winners,locked,open_targets,recent_results}`. `end` is exclusive; `open_targets` lists
  unsettled targets that have guesses, each `{tb,guesses,accepting,capacity_left}`. The complete empty-target range
  follows from the window. Results list the last 12 settled targets, including empty ones. Each result has the full
  record's summary and at most its first 10 `winners`, plus `winner_count` and `winners_truncated`. This bounds HTTP
  responses for large cutoff ties; the permanent on-chain `lottery/result/<height>` retains every winner.
- `mine: {r,start,claim_end,end,window_open,S,C,vein_buffer,last_guideline,claim_count,claim_deposit,params,last_result,
  last_vein}`. Round end and claim end are inclusive. `params` is the config for the current tip round. C is the
  actual stock capacity at the latest counted height; a future round's capacity setting first affects inflow when
  that round's heights are counted. `last_result` is `{r,hash,claims,deposit,guideline,capacity,collapse,paid,penalties,
  stock}` or null. `last_vein` is `{height,hash,amount}` or null.

`coinAccount(address)` and `/v1/account/:addr` append
`mine: {r,claim,fair_share_estimate,strikes,clean,last_result}`. `claim` is `{d,q}` or null for the current tip round.
The estimate uses current S, C and known claims, adding the address's current deposit if it has not claimed. It does
not predict future issuance, other claims or settlement ordering. `last_result` is the address's latest
`{r,address,fair,amount,penalty,strikes,clean}` or null. `coinPools()` also returns `mine_vein`.

Additional keys: `lottery/locked`, `lottery/targets`, `lottery/target/<tb>`, `lottery/guess/<tb>/<index>`,
`lottery/seen/<tb>/<address>`, `lottery/result/<tb>`, `lottery/recent`; `mine/configs`, `mine/capacity`,
`mine/capacity_setting`, `mine/round/<r>`, `mine/claim/<r>/<index>`, `mine/seen/<r>/<address>`,
`mine/last_claim/<address>`, `mine/strikes/<address>`, `mine/result/<address>`, `mine/last`, `mine/last_vein`,
and `pool/mine_vein`. Mine deletes settled round metadata, claim records and duplicate markers; it keeps only the
latest per-address result/strike state and global round summary. It never scans all accounts/deposits at settlement.
The supply invariant includes both stock and vein exactly once. Read-only head access avoids cloning all retained
beacon headers for every claim; header ingestion still uses the unchanged validating beacon.

MCP `reset_prepare_move` / `reset_submit_move` and the local signer accept the same `guess` / `claim` payloads. All
signing, puzzles, signature binding, lifetime checks and non-custodial requirements remain unchanged.
