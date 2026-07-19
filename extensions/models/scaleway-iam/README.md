# @sntxrr/scaleway-iam

A [swamp](https://swamp-club.com) model for a **Scaleway IAM application** — one
model instance per application, keyed by its application ID (`applicationId`).
Wraps the [Scaleway IAM API](https://www.scaleway.com/en/developers/api/iam/)
(`/iam/v1alpha1`, **global**) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

> This API is **global**: paths carry **no** `/zones/{zone}` or
> `/regions/{region}` segment, so there is no zone/region global argument.

> IAM is **Organization-scoped**: applications, API keys, and policies belong to
> an Organization, so this model takes an `organizationId` global argument — not
> a `projectId`.

## Methods

| Method          | What it does                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sync`          | Fetch the managed application's current state (`GetApplication`) and store a snapshot                                |
| `create`        | Provision a new IAM application (`CreateApplication`, POST) and snapshot it under its new ID                         |
| `update`        | Mutate the application's mutable fields (`UpdateApplication`, PATCH) and re-snapshot                                 |
| `delete`        | Deprovision the application (`DeleteApplication`) — idempotent (a `404` is treated as already gone)                  |
| `list`          | Factory discovery — snapshot every IAM application in the Organization (paginated)                                   |
| `list-api-keys` | Factory discovery — snapshot **API-key metadata** for the managed application (paginated). Never stores `secret_key` |
| `list-policies` | Factory discovery — snapshot every IAM policy in the Organization (paginated)                                        |

The mutating verbs (`create`/`update`/`delete`) auto-run the labeled
`org-specified` pre-flight check, which fails fast if `organizationId` is empty.

## Secret hygiene

Creating an IAM API key returns its `secret_key` **exactly once**. This model
**never** writes any `secret_key` into a resource snapshot or log.
`list-api-keys` snapshots API-key **metadata only** (the non-secret `access_key`
plus surrounding fields); the mapper explicitly omits `secret_key`, so even an
API response that echoes a secret cannot leak it into a snapshot.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register an IAM application (wire the key from the vault)
swamp model create @sntxrr/scaleway-iam ci-app \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'organizationId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'applicationId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-iam method run sync ci-app
swamp model @sntxrr/scaleway-iam method run list ci-app
swamp model @sntxrr/scaleway-iam method run list-api-keys ci-app
swamp model @sntxrr/scaleway-iam method run list-policies ci-app

# Create a new application
swamp model @sntxrr/scaleway-iam method run create ci-app \
  --input 'name=deploy-bot' --input 'description=CI deploy application'

# Update the managed application
swamp model @sntxrr/scaleway-iam method run update ci-app \
  --input 'description=renamed by swamp'

# Delete the managed application (idempotent)
swamp model @sntxrr/scaleway-iam method run delete ci-app
```

`sync`, `list`, `list-api-keys`, and `list-policies` are read-only. `create`,
`update`, and `delete` mutate; each fires the `org-specified` pre-flight check
first.

## Global arguments

| Arg              | Required    | Default                    | Description                                                                                          |
| ---------------- | ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `secretKey`      | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                               |
| `organizationId` | yes         | —                          | Organization ID that owns the application/keys/policies                                              |
| `applicationId`  | conditional | —                          | IAM application ID this model manages. Required by every method except `create`, which provisions it |
| `endpoint`       | no          | `https://api.scaleway.com` | Override the API host                                                                                |

> No `zone`/`region` argument — the IAM API is global. Scope is the
> **Organization**, not a project.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_iam.ts
$DENO test  scaleway_iam_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
