# @sntxrr/scaleway-account

A [swamp](https://swamp-club.com) model for a **Scaleway Account Project** — one
model instance per Project, keyed by its project ID (`projectId`). Wraps the
[Scaleway Account API](https://www.scaleway.com/en/developers/api/account/)
(`/account/v3`, **global**) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

> This API is **global**: paths carry **no** `/zones/{zone}` or
> `/regions/{region}` segment, so there is no zone/region global argument.

> Account/Projects is **Organization-scoped**: Projects belong to an
> Organization, so this model takes an `organizationId` global argument (used to
> create and to list) — plus a `projectId` for the managed Project.

## Methods

| Method   | What it does                                                                                |
| -------- | ------------------------------------------------------------------------------------------- |
| `sync`   | Fetch the managed Project's current state (`GetProject`) and store a snapshot               |
| `create` | Provision a new Project (`CreateProject`, POST) and snapshot it under its new ID            |
| `update` | Mutate the Project's mutable fields (`UpdateProject`, PATCH) and re-snapshot                |
| `delete` | Deprovision the Project (`DeleteProject`) — idempotent (a `404` is treated as already gone) |
| `list`   | Factory discovery — snapshot every Project in the Organization (paginated)                  |

The mutating verbs (`create`/`update`/`delete`) auto-run the labeled
`org-specified` pre-flight check, which fails fast if `organizationId` is empty.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a Project (wire the key from the vault)
swamp model create @sntxrr/scaleway-account prod \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'organizationId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'projectId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-account method run sync prod
swamp model @sntxrr/scaleway-account method run list prod

# Create a new Project
swamp model @sntxrr/scaleway-account method run create prod \
  --input 'name=staging' --input 'description=Staging environment'

# Update the managed Project
swamp model @sntxrr/scaleway-account method run update prod \
  --input 'description=renamed by swamp'

# Delete the managed Project (idempotent)
swamp model @sntxrr/scaleway-account method run delete prod
```

`sync` and `list` are read-only. `create`, `update`, and `delete` mutate; each
fires the `org-specified` pre-flight check first.

## Global arguments

| Arg              | Required    | Default                    | Description                                                                                          |
| ---------------- | ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `secretKey`      | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                               |
| `organizationId` | yes         | —                          | Organization ID that owns the Project (create/list)                                                  |
| `projectId`      | conditional | —                          | Account Project ID this model manages. Required by every method except `create`, which provisions it |
| `endpoint`       | no          | `https://api.scaleway.com` | Override the API host                                                                                |

> No `zone`/`region` argument — the Account API is global. Scope is the
> **Organization**.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_account.ts
$DENO test  scaleway_account_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
