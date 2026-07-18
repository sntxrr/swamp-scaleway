# @sntxrr/scaleway-mongodb

A [swamp](https://swamp-club.com) model for a **Scaleway Managed MongoDB®
Database Instance** — one model instance per database, keyed by its instance ID.
Wraps the
[Scaleway Managed Database for MongoDB® API](https://www.scaleway.com/en/developers/api/managed-mongodb-databases/)
(`/mongodb/v1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method   | What it does                                                             |
| -------- | ------------------------------------------------------------------------ |
| `sync`   | Fetch the instance's current state (`GetInstance`) and store a snapshot   |
| `create` | Provision a new MongoDB® Database Instance (`CreateInstance`) and snapshot |
| `update` | Mutate mutable fields — name, tags (`UpdateInstance`)                     |
| `delete` | Deprovision the instance (`DeleteInstance`); idempotent (404 → absent)   |
| `list`   | Factory discovery — snapshot every instance in the region (paginated)     |

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

# Register a MongoDB instance (wire the key from the vault)
swamp model create @sntxrr/scaleway-mongodb main-mongo \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'instanceId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-mongodb method run sync main-mongo
swamp model @sntxrr/scaleway-mongodb method run create main-mongo \
  --input name=main-mongo --input version=7.0.12 --input nodeType=MGDB-PLAY2-NANO \
  --input nodeAmount=1 --input userName=admin --input password='<default-user-password>'
swamp model @sntxrr/scaleway-mongodb method run update main-mongo --input name=renamed-mongo
swamp model @sntxrr/scaleway-mongodb method run delete main-mongo
swamp model @sntxrr/scaleway-mongodb method run list main-mongo
```

`sync` and `list` are read-only. Scaleway provisioning is asynchronous — the
instance returns a transient status (`provisioning`, `configuring`); poll `sync`
to observe the settled `ready` state.

## Global arguments

| Arg          | Required | Default                    | Description                                            |
| ------------ | -------- | -------------------------- | ------------------------------------------------------ |
| `secretKey`  | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault) |
| `projectId`  | yes      | —                          | Project ID that owns the instance                      |
| `region`     | no       | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                  |
| `instanceId` | yes      | —                          | ID of the MongoDB® instance this model manages         |
| `endpoint`   | no       | `https://api.scaleway.com` | Override the API host                                  |

MongoDB® is currently offered in the `fr-par` region; `nl-ams` and `pl-waw` are
accepted by the region policy check for parity with other Scaleway services.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_mongodb.ts
$DENO test  scaleway_mongodb_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
