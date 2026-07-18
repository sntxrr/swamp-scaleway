# @sntxrr/scaleway-serverless-functions

A [swamp](https://swamp-club.com) model for a **Scaleway Serverless Function** —
one model instance per function, keyed by its function ID. Wraps the
[Scaleway Serverless Functions API](https://www.scaleway.com/en/developers/api/serverless-functions/)
(`/functions/v1beta1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method            | What it does                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `sync`            | Fetch the function's current state (`GetFunction`) and store a snapshot  |
| `create`          | Provision a new function (`CreateFunction`) in a namespace and snapshot  |
| `update`          | Mutate mutable fields — runtime, scaling, env, etc. (`UpdateFunction`)   |
| `action`          | Deploy the function (`op=deploy`, `DeployFunction`) and re-snapshot      |
| `delete`          | Deprovision the function (`DeleteFunction`); idempotent (404 → absent)   |
| `list`            | Factory discovery — snapshot every function in the region (paginated)    |
| `list-namespaces` | Factory discovery — snapshot every function namespace (paginated)        |

`sync`, `list`, and `list-namespaces` are read-only. Deployment is asynchronous —
the function returns a transient status (`pending`, `deploying`); poll `sync` to
observe the settled `ready` state.

## Secret handling

`secretEnvironmentVariables` on `create`/`update` is a sensitive input: it is
sent to the API only to provision the function and is **never** logged or written
into a resource snapshot. Snapshots store non-secret fields only (status,
runtime, scaling, domain name, etc.).

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a function (wire the key from the vault)
swamp model create @sntxrr/scaleway-serverless-functions main-fn \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'namespaceId=44444444-4444-4444-4444-444444444444' \
  --global-arg 'functionId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-serverless-functions method run sync main-fn
swamp model @sntxrr/scaleway-serverless-functions method run create main-fn \
  --input name=hello --input runtime=node22 --input privacy=public \
  --input handler=handler.handle
swamp model @sntxrr/scaleway-serverless-functions method run update main-fn \
  --input memoryLimit=512
swamp model @sntxrr/scaleway-serverless-functions method run action main-fn \
  --input op=deploy
swamp model @sntxrr/scaleway-serverless-functions method run delete main-fn
swamp model @sntxrr/scaleway-serverless-functions method run list main-fn
swamp model @sntxrr/scaleway-serverless-functions method run list-namespaces main-fn
```

## Global arguments

| Arg           | Required | Default                    | Description                                             |
| ------------- | -------- | -------------------------- | ------------------------------------------------------- |
| `secretKey`   | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault)  |
| `projectId`   | yes      | —                          | Project ID that owns the function and namespace         |
| `region`      | no       | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                   |
| `functionId`  | yes      | —                          | ID of the function this model manages                   |
| `namespaceId` | no\*     | —                          | Namespace ID (required for `create`; scopes `list`)     |
| `endpoint`    | no       | `https://api.scaleway.com` | Override the API host                                   |

\* `namespaceId` is required for `create` and optionally scopes `list` to a
single namespace.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_serverless_functions.ts
$DENO test  scaleway_serverless_functions_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
