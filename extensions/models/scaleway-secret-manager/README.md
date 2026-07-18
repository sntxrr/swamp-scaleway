# @sntxrr/scaleway-secret-manager

A [swamp](https://swamp-club.com) model for a **Scaleway Secret Manager secret**
— one model instance per secret, keyed by its secret ID. Wraps the
[Scaleway Secret Manager API](https://www.scaleway.com/en/developers/api/secret-manager/)
(`/secret-manager/v1beta1`, regional) using only Deno's built-in `fetch` — no
SDK. Authenticated with the `X-Auth-Token` header (secret key wired from a
vault).

## Methods

| Method        | What it does                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| `sync`        | Fetch the secret's current metadata (`GetSecret`) and store a snapshot           |
| `create`      | Create a new secret's metadata (`CreateSecret`) — name/tags/type only, no value  |
| `update`      | Mutate mutable metadata — name, tags, path, description (`UpdateSecret`)          |
| `delete`      | Delete the secret and all its versions (`DeleteSecret`); idempotent on 404        |
| `list`        | Factory discovery — snapshot every secret in the region (paginated)              |
| `add-version` | Store a new secret **value** as a version (`CreateSecretVersion`)                |
| `access`      | Read the latest (or a given revision's) secret **value** (`AccessSecretVersion`) |

## Secret hygiene

Protecting the secret **value** is the entire point of this service, so the
model treats it as radioactive:

- The `add-version` `value` argument is marked `sensitive`. It is base64-encoded
  into the request body's `data` field and is **never logged** and **never
  written into a snapshot**.
- `access` returns the value **only** through the dedicated `secretValue`
  resource, which is declared `sensitiveOutput: true` (its `value` field is also
  `.meta({ sensitive: true })`). swamp vaults those fields and replaces them with
  a vault reference before persistence, so **cleartext never lands on disk**, and
  the value is **never logged**.
- Metadata snapshots (`secret`, `secretVersion`) carry only non-secret fields —
  id, name, status, version count, type, tags, path, timestamps.

Because `access` produces a sensitive output, a **vault must be configured** for
it to persist. A dedicated **swamp vault backend for Scaleway Secret Manager**
(so other models can source their secrets straight from Secret Manager) is a
planned follow-up; until then any configured vault (e.g. `local_encryption`)
satisfies the requirement.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a secret (wire the key from the vault)
swamp model create @sntxrr/scaleway-secret-manager db-password \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'secretId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-secret-manager method run sync db-password
swamp model @sntxrr/scaleway-secret-manager method run create db-password \
  --input name=db-password --input type=opaque
swamp model @sntxrr/scaleway-secret-manager method run update db-password \
  --input name=db-password-prod
swamp model @sntxrr/scaleway-secret-manager method run add-version db-password \
  --input value='<the-secret-value>'
swamp model @sntxrr/scaleway-secret-manager method run access db-password \
  --input revision=latest
swamp model @sntxrr/scaleway-secret-manager method run delete db-password
swamp model @sntxrr/scaleway-secret-manager method run list db-password
```

`sync` and `list` are read-only. `create`/`update`/`delete` run a `valid-region`
pre-flight check first.

## Global arguments

| Arg         | Required | Default                    | Description                                            |
| ----------- | -------- | -------------------------- | ------------------------------------------------------ |
| `secretKey` | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault) |
| `projectId` | yes      | —                          | Project ID that owns the secret                        |
| `region`    | no       | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                  |
| `secretId`  | yes      | —                          | ID of the secret this model manages                    |
| `endpoint`  | no       | `https://api.scaleway.com` | Override the API host                                  |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_secret_manager.ts
$DENO test  scaleway_secret_manager_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
