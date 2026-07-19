# @sntxrr/scaleway-redis

A [swamp](https://swamp-club.com) model for a **Scaleway Managed Database for
Redis™ cluster** — one model instance per cluster, keyed by its cluster ID.
Wraps the
[Scaleway Managed Database for Redis API](https://www.scaleway.com/en/developers/api/managed-database-redis)
(`/redis/v1`, zoned) using only Deno's built-in `fetch` — no SDK. Authenticated
with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method   | What it does                                                          |
| -------- | --------------------------------------------------------------------- |
| `sync`   | Fetch the cluster's current state (`GetCluster`) and store a snapshot |
| `create` | Provision a new Redis cluster (`CreateCluster`) and snapshot it       |
| `update` | Mutate mutable fields — name, tags (`UpdateCluster`)                  |
| `delete` | Deprovision the cluster (`DeleteCluster`); idempotent (404 → absent)  |
| `list`   | Factory discovery — snapshot every cluster in the zone (paginated)    |

## Secret handling

The default user's `password` is a sensitive `create` input: it is sent to the
API only to provision the cluster and is **never** logged or written into a
resource snapshot. Snapshots store the connection **host** and **port** (which
are not secrets) but never any password or credential.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a Redis cluster (wire the key from the vault)
swamp model create @sntxrr/scaleway-redis main-cache \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'zone=fr-par-1' \
  --global-arg 'clusterId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-redis method run sync main-cache
swamp model @sntxrr/scaleway-redis method run create main-cache \
  --input name=main-cache --input version=7.0.5 --input nodeType=RED1-MICRO \
  --input userName=admin --input password='<default-user-password>'
swamp model @sntxrr/scaleway-redis method run update main-cache --input name=renamed-cache
swamp model @sntxrr/scaleway-redis method run delete main-cache
swamp model @sntxrr/scaleway-redis method run list main-cache
```

`sync` and `list` are read-only. Scaleway provisioning is asynchronous — the
cluster returns a transient status (`provisioning`, `configuring`); poll `sync`
to observe the settled `ready` state.

## Global arguments

| Arg         | Required    | Default                    | Description                                                                                               |
| ----------- | ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `secretKey` | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                    |
| `projectId` | yes         | —                          | Project ID that owns the cluster                                                                          |
| `zone`      | no          | `fr-par-1`                 | Zone (`fr-par-1`, `nl-ams-1`, `pl-waw-1`, …)                                                              |
| `clusterId` | conditional | —                          | ID of the Redis cluster this model manages. Required by every method except `create`, which provisions it |
| `endpoint`  | no          | `https://api.scaleway.com` | Override the API host                                                                                     |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_redis.ts
$DENO test  scaleway_redis_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
