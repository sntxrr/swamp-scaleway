# @sntxrr/scaleway-registry

A [swamp](https://swamp-club.com) model for a **Scaleway Container Registry
namespace** — one model instance per namespace, keyed by its namespace ID. Wraps
the
[Scaleway Container Registry API](https://www.scaleway.com/en/developers/api/registry/)
(`/registry/v1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault). A
namespace is a collection of container images sharing a unique identifier.

## Methods

| Method   | What it does                                                              |
| -------- | ------------------------------------------------------------------------- |
| `sync`   | Fetch the namespace's current state (`GetNamespace`) and store a snapshot |
| `create` | Provision a new namespace (`CreateNamespace`) and snapshot it             |
| `update` | Mutate mutable fields — description, visibility (`UpdateNamespace`)       |
| `delete` | Deprovision the namespace (`DeleteNamespace`)                             |
| `list`   | Factory discovery — snapshot every namespace in the region (paginated)    |

`delete` is idempotent: a `404` (already gone) is treated as success and records
an `absent` snapshot rather than raising an error.

## Snapshot fields

Snapshots record only non-secret namespace metadata: the pull/push `endpoint`
host, `isPublic` visibility, `size` (bytes), `imageCount`, `status`,
`description`, ownership IDs, and timestamps. No credential is ever logged or
written into a snapshot.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a namespace (wire the key from the vault)
swamp model create @sntxrr/scaleway-registry main-registry \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'namespaceId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-registry method run sync main-registry
swamp model @sntxrr/scaleway-registry method run create main-registry \
  --input name=my-app --input description='App images' --input isPublic=false
swamp model @sntxrr/scaleway-registry method run update main-registry \
  --input isPublic=true
swamp model @sntxrr/scaleway-registry method run delete main-registry
swamp model @sntxrr/scaleway-registry method run list main-registry
```

`sync` and `list` are read-only. Scaleway provisioning is asynchronous — the
namespace returns a transient status (`deleting`, etc.); poll `sync` to observe
the settled `ready` state.

## Global arguments

| Arg           | Required    | Default                    | Description                                                                                                    |
| ------------- | ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `secretKey`   | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                         |
| `projectId`   | yes         | —                          | Project ID that owns the namespace                                                                             |
| `region`      | no          | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                                                                          |
| `namespaceId` | conditional | —                          | ID of the registry namespace this model manages. Required by every method except `create`, which provisions it |
| `endpoint`    | no          | `https://api.scaleway.com` | Override the API host                                                                                          |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_registry.ts
$DENO test  scaleway_registry_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
