# @sntxrr/scaleway-serverless-containers

A [swamp](https://swamp-club.com) model for a **Scaleway Serverless Container**
— one model instance per container, keyed by its container ID. Wraps the
[Scaleway Serverless Containers API](https://www.scaleway.com/en/developers/api/serverless-containers/)
(`/containers/v1beta1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method            | What it does                                                                   |
| ----------------- | ------------------------------------------------------------------------------ |
| `sync`            | Fetch the container's current state (`GetContainer`) and store a snapshot      |
| `create`          | Provision a new container in a namespace (`CreateContainer`)                   |
| `update`          | Mutate mutable fields — image, scale, limits, env, privacy (`UpdateContainer`) |
| `delete`          | Deprovision the container (`DeleteContainer`); idempotent on 404               |
| `action`          | Redeploy the container so changes take effect (`RedeployContainer`)            |
| `list`            | Factory discovery — snapshot every container in the region (paginated)         |
| `list-namespaces` | Factory discovery — snapshot every namespace in the region (paginated)         |

`create` requires the `namespaceId` global arg. `list` optionally scopes to a
single namespace when `namespaceId` is set.

## Secret handling

The `secretKey` global arg is sensitive and wired from a vault; it is sent only
in the `X-Auth-Token` header and is never logged or written into a snapshot.
Environment variables and any container secrets are never copied into a resource
snapshot — snapshots store only non-secret configuration and status (image,
scale, limits, domain name, port).

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a container (wire the key from the vault)
swamp model create @sntxrr/scaleway-serverless-containers main-container \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'containerId=22222222-2222-2222-2222-222222222222' \
  --global-arg 'namespaceId=44444444-4444-4444-4444-444444444444'
```

## Usage

```bash
swamp model @sntxrr/scaleway-serverless-containers method run sync main-container
swamp model @sntxrr/scaleway-serverless-containers method run create main-container \
  --input name=my-app --input registryImage=rg.fr-par.scw.cloud/ns/app:latest \
  --input port=8080 --input minScale=0 --input maxScale=3
swamp model @sntxrr/scaleway-serverless-containers method run update main-container --input maxScale=10
swamp model @sntxrr/scaleway-serverless-containers method run action main-container
swamp model @sntxrr/scaleway-serverless-containers method run delete main-container
swamp model @sntxrr/scaleway-serverless-containers method run list main-container
swamp model @sntxrr/scaleway-serverless-containers method run list-namespaces main-container
```

`sync`, `list`, and `list-namespaces` are read-only. Scaleway provisioning and
redeploys are asynchronous — the container returns a transient status
(`creating`, `pending`); poll `sync` to observe the settled `ready` state.

## Global arguments

| Arg           | Required    | Default                    | Description                                                                                           |
| ------------- | ----------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `secretKey`   | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                |
| `projectId`   | yes         | —                          | Project ID that owns the container and namespaces                                                     |
| `region`      | no          | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                                                                 |
| `containerId` | conditional | —                          | ID of the container this model manages. Required by every method except `create`, which provisions it |
| `namespaceId` | no          | —                          | Namespace ID (required for `create`; optional `list` filter)                                          |
| `endpoint`    | no          | `https://api.scaleway.com` | Override the API host                                                                                 |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_serverless_containers.ts
$DENO test  scaleway_serverless_containers_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
