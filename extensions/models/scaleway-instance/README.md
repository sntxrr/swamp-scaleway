# @sntxrr/scaleway-instance

A [swamp](https://swamp-club.com) model for a **Scaleway Instance compute
server** — one model instance per server, keyed by its server ID. Wraps the
[Scaleway Instance API](https://www.scaleway.com/en/developers/api/instance/)
(`/instance/v1`, zoned) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method   | What it does                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `sync`   | Fetch the server's current state (`GetServer`) and store a snapshot                                     |
| `action` | Issue a power action: `poweron`, `poweroff`, `reboot`, `stop_in_place`, `terminate`, then re-read state |
| `list`   | Factory discovery — snapshot every server in the zone (paginated)                                       |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a server (wire the key from the vault)
swamp model create @sntxrr/scaleway-instance web-1 \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'zone=fr-par-1' \
  --global-arg 'serverId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-instance method run sync web-1
swamp model @sntxrr/scaleway-instance method run action web-1 --input action=poweron
swamp model @sntxrr/scaleway-instance method run action web-1 --input action=reboot
swamp model @sntxrr/scaleway-instance method run list web-1
```

`sync` and `list` are read-only. Scaleway power actions are asynchronous — the
server returns a transient state (`starting`, `stopping`); poll `sync` to
observe the settled state.

## Global arguments

| Arg         | Required    | Default                    | Description                                                                                      |
| ----------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `secretKey` | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                           |
| `projectId` | yes         | —                          | Project ID that owns the server                                                                  |
| `zone`      | no          | `fr-par-1`                 | Availability zone (`fr-par-1`, `nl-ams-1`, `pl-waw-1`…)                                          |
| `serverId`  | conditional | —                          | ID of the Instance server this model manages. Required by every method except the `list` factory |
| `endpoint`  | no          | `https://api.scaleway.com` | Override the API host                                                                            |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_instance.ts
$DENO test  scaleway_instance_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
