# @sntxrr/scaleway-elastic-metal

A [swamp](https://swamp-club.com) model for a **Scaleway Elastic Metal (Bare
Metal) server** — one model instance per server, keyed by its server ID. Wraps
the
[Scaleway Elastic Metal API](https://www.scaleway.com/en/developers/api/elastic-metal/)
(`/baremetal/v1`, zoned) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method   | What it does                                                                |
| -------- | --------------------------------------------------------------------------- |
| `sync`   | Fetch the server's current state (`GetServer`) and store a snapshot         |
| `create` | Provision a new bare-metal server from a commercial offer, then snapshot it |
| `action` | Issue a lifecycle verb: `start`, `stop`, `reboot`, then re-read state       |
| `delete` | Deprovision the server (idempotent — a `404` is treated as already-absent)  |
| `list`   | Factory discovery — snapshot every server in the zone (paginated)           |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a server (wire the key from the vault)
swamp model create @sntxrr/scaleway-elastic-metal metal-1 \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'zone=fr-par-1' \
  --global-arg 'serverId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-elastic-metal method run sync metal-1
swamp model @sntxrr/scaleway-elastic-metal method run action metal-1 --input action=reboot
swamp model @sntxrr/scaleway-elastic-metal method run action metal-1 --input action=start
swamp model @sntxrr/scaleway-elastic-metal method run action metal-1 --input action=stop
swamp model @sntxrr/scaleway-elastic-metal method run create metal-1 --input name=metal-new --input offerId=<offer-id>
swamp model @sntxrr/scaleway-elastic-metal method run delete metal-1
swamp model @sntxrr/scaleway-elastic-metal method run list metal-1
```

`sync` and `list` are read-only. Elastic Metal lifecycle actions are
asynchronous — the server returns a transient status (`starting`, `stopping`,
`delivering`); poll `sync` to observe the settled status. Primary IPs surface in
the snapshot as, e.g., `203.0.113.10`.

## Global arguments

| Arg         | Required    | Default                    | Description                                                                                                      |
| ----------- | ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `secretKey` | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                           |
| `projectId` | yes         | —                          | Project ID that owns the server                                                                                  |
| `zone`      | no          | `fr-par-1`                 | Availability zone (`fr-par-1`, `nl-ams-1`, `pl-waw-1`…)                                                          |
| `serverId`  | conditional | —                          | ID of the Elastic Metal server this model manages. Required by every method except `create`, which provisions it |
| `endpoint`  | no          | `https://api.scaleway.com` | Override the API host                                                                                            |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_elastic_metal.ts
$DENO test  scaleway_elastic_metal_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
