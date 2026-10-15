# Blind relay

This Feature carries the existing subnet replication and sidechannel protocols over an end-to-end Noise
connection when direct dialing fails. It uses the peer's existing swarm and leaves trac-peer unchanged.

For an already configured local peer, add these flags to its runner arguments:

```text
server: --blind-relay-serve 1
client: --blind-relay <relay-swarm-public-key-hex>,<backup-swarm-public-key-hex>
```

Configure the client list on both endpoints. Use the relay's printed `Peer pubkey (hex)`, not its subnet bootstrap
or writer key. The two roles can be combined. With neither flag the Feature is disabled.

For programmatic local peers, start after their swarm is ready and stop before destroying it:

```js
import BlindRelay from './features/blind-relay/index.js';

const relay = new BlindRelay(peer, { serve: true });
await relay.start();
peer.blindRelay = relay; // enables live sc-bridge status
// ... peer runs ...
await relay.stop();
```

Client configuration is `{ relays: [relayPublicKeyHex] }`. The existing Hyperswarm topic discovery and
`joinPeer()` calls both use fallback. Direct attempts have a 15-second deadline, relay attempts a 20-second
deadline. Each destination rotates independently through its configured relays and then retries direct.
Normal Hyperswarm backoff remains in charge. Keepalives and a receive-silence deadline bound recovery after a
relay disappears; streams are re-established, so applications should retry ephemeral messages if necessary.
Autobase resumes durable replication on the replacement connection.

Authenticated sc-bridge `stats` includes `blindRelay`; `info` includes `info.blindRelay`. A startup log also
prints the initial snapshot. See [SPEC §8](../../docs/SPEC.md#8-blind-relay) for every limit, flag,
default and counter. Rate limiting closes sessions after a sampled aggregate budget overrun; it is not packet
shaping. A transport-only relay should have its own subnet and sidechannel discovery channels, since ordinary
participation in an application's channels is separate from forwarding encrypted tunnels. This Feature does
not configure or relay the MSB swarm.

Run the self-contained local testnet suite with:

```sh
source ~/.nvm/nvm.sh
nvm use 23.11.0
node --test tests/blind-relay.test.mjs
```

It creates loopback HyperDHT bootstrap nodes, fresh test identities and temporary Corestores under `.test-tmp/`,
then closes the nodes and removes the exact stores it created. No public DHT or MSB is needed. The ledger tests
use trac-peer's installed Autobase/Corestore/Hyperswarm versions and the real Sidechannel Feature. A separate
privacy test uses the same Noise implementation over blind-relay links and an audit-only JavaScript forwarding
adapter so actual relay handler buffers can be inspected; production and the replication tests use native UDX
`relayTo`. The adapter has no endpoint keys.

The pinned adapter depends on blind-relay 1.6.1's decoded pair/unpair handlers and link lifecycle, HyperDHT
6.29.6's inbound relay hook, and Hyperswarm's retry fields. Dependency upgrades must rerun this suite.
