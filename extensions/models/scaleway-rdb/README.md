# @sntxrr/scaleway-rdb

A [swamp](https://swamp-club.com) model for a **Scaleway Managed Database (RDB)
instance** — one model instance per database, keyed by its instance ID. Wraps
the
[Scaleway Managed Database API](https://www.scaleway.com/en/developers/api/managed-database-postgre-mysql/)
(`/rdb/v1`, regional) using only Deno's built-in `fetch` — no SDK. Authenticated
with the `X-Auth-Token` header (secret key wired from a vault). Supports
PostgreSQL and MySQL engines.

## Methods

| Method   | What it does                                                            |
| -------- | ----------------------------------------------------------------------- |
| `sync`   | Fetch the instance's current state (`GetInstance`) and store a snapshot |
| `create` | Provision a new database instance (`CreateInstance`) and snapshot it    |
| `update` | Mutate mutable fields — name, tags (`UpdateInstance`)                   |
| `delete` | Deprovision the instance (`DeleteInstance`)                             |
| `list`   | Factory discovery — snapshot every instance in the region (paginated)   |

## Secret handling

The default user's `password` is a sensitive `create` input: it is sent to the
API only to provision the instance and is **never** logged or written into a
resource snapshot. Snapshots store the connection **host** and **port** (which
are not secrets) but never any password or credential.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a database instance (wire the key from the vault)
swamp model create @sntxrr/scaleway-rdb main-db \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'instanceId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-rdb method run sync main-db
swamp model @sntxrr/scaleway-rdb method run create main-db \
  --input name=main-db --input engine=PostgreSQL-15 --input nodeType=DB-DEV-S \
  --input userName=admin --input password='<default-user-password>'
swamp model @sntxrr/scaleway-rdb method run update main-db --input name=renamed-db
swamp model @sntxrr/scaleway-rdb method run delete main-db
swamp model @sntxrr/scaleway-rdb method run list main-db
```

`sync` and `list` are read-only. Scaleway provisioning is asynchronous — the
instance returns a transient status (`provisioning`, `configuring`); poll `sync`
to observe the settled `ready` state.

## Global arguments

| Arg          | Required    | Default                    | Description                                                                                                   |
| ------------ | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `secretKey`  | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                        |
| `projectId`  | yes         | —                          | Project ID that owns the instance                                                                             |
| `region`     | no          | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                                                                         |
| `instanceId` | conditional | —                          | ID of the database instance this model manages. Required by every method except `create`, which provisions it |
| `endpoint`   | no          | `https://api.scaleway.com` | Override the API host                                                                                         |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_rdb.ts
$DENO test  scaleway_rdb_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
