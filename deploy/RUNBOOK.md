# RESET service kit — Ubuntu 24.04

This kit is written for review. It has not been installed, started, or deployed on
a server. The local acceptance target is `docs/DEVNET.md`. Do not run the devnet
faucet, test miner, or test wallets on a server. The committed launch settings are
in `contract/launch.js`; the operator chooses
network settings, host and resource budgets.

## Install a reviewed release

1. Review `setup-user.sh`, then run it as root on the intended Ubuntu host. It
   creates system user/group `reset`, no supplementary groups, no sudo, home
   `/srv/reset`, shell `/usr/sbin/nologin`. Each peer role has a separate 0700
   store and `pear/` home beneath it.
2. Install the official Node **23.11.0** Linux archive for the host architecture,
   verify its published SHA256, and expose its directory as `/opt/reset/node`.
   Use a root-owned installation; a service does not source nvm or login scripts.
   Node supervises the embedded `pear-runtime` runner and runs the separate MCP
   service. All peer/MSB-client code executes in Pear/Bare. The player-side signer
   uses Node on the player’s own machine; do not install player keys here.
3. Copy the reviewed checkout to `/opt/reset/releases/<commit>`. With that Node
   on PATH, run `npm ci`, `npm ci --prefix signer`, `npm ci --prefix mcp` from the
   release directory. MCP imports the signer package’s public wire-verification
   helpers, so its dependencies are installed too; this creates no wallet.
   Use the committed lockfiles; do not update dependencies.
   Keep the release root-owned and not writable by `reset`. Point
   `/opt/reset/current` to the release only after all local tests pass. Install
   dependencies during staging, never in ExecStart or under the service user.
4. Copy `*.example.json` to `/etc/reset/indexer.json`, `gateway.json`, `relay.json`.
   Replace every placeholder. Copy `mcp.example.env` to `/etc/reset/mcp.env`
   and set the gateway loopback
   URL, port and approved public origin. Keep all configs root:reset 0640. Both MSB and peer DHT
   bootstrap lists, both channels, MSB bootstrap and environment are explicit;
   invalid/incomplete configuration fails before opening network connections.
   The examples are incomplete development configurations, not launch settings.
   Keep a transport relay on a unique `relay-...` discovery channel with its own
   subnet, separate from the application subnet. A relay never joins the app's
   sidechannels. Supply its printed swarm public key in the indexer/gateway
   `relayKeys` lists when fallback is wanted.
   The gateway's optional `chat` object turns on the miners' chat. `viewerKeyFile`
   names a root:reset 0640 file holding one random key (32+ characters of
   `A-Za-z0-9_-`) that a game uses to relay its approved viewer messages; leave it
   out to accept agent messages only.
5. Copy the four `.service` files to `/etc/systemd/system/`, inspect them with
   `systemd-analyze verify`, then `systemctl daemon-reload`. They run as `reset`
   with CPU/memory/task limits, strict read-only system, private tmp, protected
   home and no privileges. Each peer unit can write only its own store/Pear
   directory
   (plus systemd’s private temporary namespace). `reset-mcp` has no writable
   persistent directories and cannot access `/srv/reset`. It talks only to the
   gateway’s local HTTP API; restarting it does not restart the gateway.
   `HOME`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` are scoped to each peer’s
   `/srv/reset/<role>/pear/`. Never share or copy those directories between
   peers/hosts. The embedded runner does not need a global Pear install or copy
   of `~/.config/pear`; dependencies include its pinned Bare runtime.
   The existing explicit Pear-v2 legacy opt-in remains supported by the runner;
   these units use the embedded mode regardless of an installed v2/v3 CLI.
   `KillMode=mixed` sends the initial stop signal only to the supervisor, which
   forwards it once and gives the peer up to 80 seconds to close its stores.
   systemd’s 90-second stop deadline covers the complete process group.

## First initialization and start order

All three peer units invoke `scripts/pear-runner.mjs` → `index.js`, equivalent to:

```sh
npm start -- --role indexer --config /etc/reset/indexer.json
npm start -- --role gateway --config /etc/reset/gateway.json --gateway 1
npm start -- --role relay --config /etc/reset/relay.json --blind-relay-serve 1
```

Run these only as `reset` with the same per-role HOME/XDG environment as the
units and from `/opt/reset/current`. The configured path is noninteractive and
requires explicit network/bootstrap/store settings. `--gateway-port` and
`--gateway-header-source` override their JSON fields; existing `--blind-relay-*`
flags control fallback and resource limits. The old Node peer launcher has been
removed. `contract/launch.js` supplies checkpoint 969696 and coin start 971559
by default. Production configs reject test checkpoint overrides. The admin key
is retained permanently.

Start order is **indexer → gateway → relay → MCP**. On the initial bootstrap only:

1. Start the indexer long enough to create its fresh store and print public
   address, MSB fee address, writer key and subnet bootstrap. Stop it. Set that
   subnet bootstrap in the gateway config. Provision the indexer's TNK using the
   approved network procedure; this kit has no production faucet.
2. With the indexer service stopped, run the following one-shot commands as root
   through `runuser` (the account has no interactive login), from `/opt/reset/current`:

   ```sh
   runuser -u reset -- env HOME=/srv/reset/indexer/pear \
     XDG_CONFIG_HOME=/srv/reset/indexer/pear/config XDG_DATA_HOME=/srv/reset/indexer/pear/data \
     /opt/reset/node/bin/node /opt/reset/current/scripts/pear-runner.mjs \
     --role indexer --config /etc/reset/indexer.json --admin-command init-admin
   runuser -u reset -- env HOME=/srv/reset/indexer/pear \
     XDG_CONFIG_HOME=/srv/reset/indexer/pear/config XDG_DATA_HOME=/srv/reset/indexer/pear/data \
     /opt/reset/node/bin/node /opt/reset/current/scripts/pear-runner.mjs \
     --role indexer --config /etc/reset/indexer.json --admin-command deploy-subnet
   ```

   The first command requires no existing admin and an initial indexer. The
   second submits the actual MSB subnet deployment and waits for replication.
   Never run either command against a store held open by a service. After an
   uncertain deployment result, inspect registration before rerunning it.
3. Start indexer, then gateway to obtain the gateway's printed public address and
   writer key. The gateway is not writable until admitted. Record them in
   `/etc/reset/gateways.json` (root:reset 0640):

   ```json
   [{"gatewayWriter":"<hex writer key>","gatewayAddress":"<hex public address>"}]
   ```

   Stop the indexer briefly and run:

   ```sh
   runuser -u reset -- env HOME=/srv/reset/indexer/pear \
     XDG_CONFIG_HOME=/srv/reset/indexer/pear/config XDG_DATA_HOME=/srv/reset/indexer/pear/data \
     /opt/reset/node/bin/node /opt/reset/current/scripts/pear-runner.mjs \
     --role indexer --config /etc/reset/indexer.json --admin-command admin-setup --gateways-file /etc/reset/gateways.json
   ```

   The commands execute inside Pear, print `ADMIN_DONE` only after success, and
   exit without starting a terminal. Setup imports `setupAdmin` from
   `scripts/admin-setup.mjs`, using only the
   indexer's own admin wallet. It enables chat/transactions, disables whitelist
   and automatic writer enrollment, admits each gateway writer, submits `gw_set`
   through MSB and checks settlement. Players are never admitted as writers.
4. Restart indexer, confirm gateway registration/heartbeat in the local
   `/v1/state`, then start relay. Restart endpoints after configuring its public
   relay key. Start the separate `reset-mcp` service. Enable the units for reboot only after local status is healthy.
   The miner is absent: explicitly configure a reviewed Bitcoin REST header
   source on the gateway if required. Header watching defaults to `off`.
5. Validate the existing HTTPS host's nginx configuration before reloading it.
   `nginx-mcp.conf` uses `/reset/mcp`, `/reset/auth/challenge` and
   `/reset/auth/login`; it does not define or replace a server block, certificates,
   other paths or other services. MCP's `RESET_MCP_ORIGIN` is the HTTPS **origin**, with
   no path. Clients sign that exact audience and use the prefixed public routes.
   Local devnet clients use the unprefixed routes described in `docs/llms.txt`.

## Firewall and proxy

Do not flush or replace a host firewall. Add narrowly scoped rules after reviewing
existing services and access paths. The only public application surface is MCP
and its signed login routes over the existing HTTPS reverse proxy (TCP 443).
Gateway HTTP (default 49223), MCP's upstream listener (3100), and any management
access remain loopback/private; never publish them directly. No sc-bridge or
terminal HTTP administration is enabled by this service entry point.

HyperDHT/UDX needs outbound UDP and return traffic; an internet-reachable blind
relay additionally needs reachable inbound UDP. Bootstrap servers use the ports
in the explicit bootstrap lists. The pinned peer/MSB libraries bind their own UDP
sockets dynamically: inspect their actual listeners/NAT mapping and use a
reviewed host/network rule for those sockets. **Do not assume opening UDP 49737
alone exposes the relay**; that is commonly a bootstrap port. A fixed-port
production ingress policy needs an upstream-supported bind configuration or a
reviewed adapter before rollout. No firewall commands are executed by this kit.

nginx preserves Host and Authorization and disables MCP buffering/caching. The
MCP service ignores forwarded IP headers: all users behind this proxy share the
proxy IP allowance (120 requests/minute by default), while address limits remain
60/minute. Do not silently raise limits or enable arbitrary forwarded-header
trust. Review a trusted-proxy design if shared-IP capacity is insufficient. No
password, mnemonic, player keystore or player private key belongs in any config,
unit, request log or server directory. Peer/MSB identity keys are the service's
own identities; restrict backups accordingly.

## Add indexers later: one to three, never operate with two

Plan one maintenance event with **two new independent peer stores/identities**.
Stage the reviewed release twice, each with its own store and systemd unit (copy
the indexer unit and give each its own `/srv/reset/<name>` ReadWritePaths and
matching `storeDirectory`, e.g. `/srv/reset/indexer-2`, in each new config; also
create its own `pear/` and set HOME/XDG paths to that directory). Point both at the
existing subnet/MSB and let them fully replicate as readers. Keep gateway writes
paused during membership changes. Do not initialize a new admin or copy an old
peer's store to either new peer.

From the existing admin peer, promote both fresh writer keys in **one Autobase
append batch** using the pinned upstream addIndexer operation format below.
This is a procedure for rehearsed maintenance tooling, not a
remote/admin endpoint. Both candidate peers must already be running and caught
up; do not run one `/add_indexer` now and leave the second for a later day.

```js
// peer = existing initialized admin peer; keys = BOTH new public writer keys.
if (keys.length !== 2 || new Set(keys).size !== 2 ||
    keys.some(key => !/^[0-9a-f]{64}$/.test(key)) ||
    (await peer.base.view.get('admin'))?.value !== peer.wallet.publicKey ||
    peer.base.linearizer.indexers.length !== 1) throw new Error('Require admin and 1 -> 3');
const operations = keys.map(key => {
  const nonce = peer.protocol.instance.generateNonce();
  const msg = { type: 'addIndexer', key };
  return { op: 'append_writer', type: 'addIndexer', key, value: { msg },
    hash: peer.wallet.sign(JSON.stringify(msg) + nonce), nonce };
});
await peer.base.append(operations);
```

Wait until all three peers report the same three active indexers and replication
has advanced with the three-indexer quorum. Only then resume gateway traffic.
Pending membership/acknowledgements are a transition, not an approved two-indexer
operating state. If either candidate cannot join, keep traffic paused and
investigate; do not continue serving with two. Rehearse this exact transition and
failure recovery against disposable peers before use: the test suite covers the
one-indexer network, not production membership migration. Admin ownership never
changes as part of adding indexers.

## Backups, rollback and logs

- Stop the role gracefully before a store backup, or use a documented consistent
  filesystem snapshot. Back up the entire store (including peer/MSB identity keys,
  writer logs and bootstrap file) encrypted offline with restricted access.
  **Never copy a peer store or Pear key directory to another peer/host.**
  Restoring a store means
  replacing that same stopped identity. New peers always create new stores.
- Record release commit, Node/Pear runtime versions, nonsecret configs, bootstrap/public keys
  and checkpoint with each backup. Never include local player wallets. Treat
  service/admin identity backups as sensitive; losing the admin key prevents
  future administration. There is no step to release it.
- Roll back code by stopping MCP, gateway, relay, indexer; point `/opt/reset/current`
  to the previously reviewed compatible release, then start indexer → gateway →
  relay → MCP. Do not roll back an on-chain state change by restoring an old live
  writer log. If store/schema compatibility changed, pause and review
  recovery first; stale store restore can fork an identity.
- Use `systemctl status reset-indexer reset-gateway reset-relay reset-mcp` and
  `journalctl -u reset-gateway -f` (analogous for other roles). Inspect local
  gateway state/accounts, MSB registration and peer public-key startup lines.
  An MCP service restart resets MCP login sessions and in-memory limits; clients
  re-login. Store ownership or disk-full errors must be fixed without broadening
  filesystem permissions. Repeated failures hit the unit start limit.
