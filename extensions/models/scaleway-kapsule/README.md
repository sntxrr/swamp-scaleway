# @sntxrr/scaleway-kapsule

A [swamp](https://swamp-club.com) model for a **Scaleway Kubernetes Kapsule
cluster** — one model instance per cluster, keyed by its cluster ID. Wraps the
[Scaleway Kubernetes API](https://www.scaleway.com/en/developers/api/kubernetes/)
(`/k8s/v1`, regional) using only Deno's built-in `fetch` — no SDK. Authenticated
with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method           | What it does                                                                |
| ---------------- | --------------------------------------------------------------------------- |
| `sync`           | Fetch the cluster's current state (`GetCluster`) and store a snapshot       |
| `create`         | Provision a new cluster (`CreateCluster`) with initial node pools           |
| `update`         | Mutate mutable fields — name, description, tags (`UpdateCluster`)           |
| `upgrade`        | Upgrade the cluster to a target Kubernetes version (`UpgradeCluster`)       |
| `delete`         | Deprovision the cluster (`DeleteCluster`) — idempotent (404 = already gone) |
| `list`           | Factory discovery — snapshot every cluster in the region (paginated)        |
| `list-pools`     | Factory discovery — snapshot every node pool on this cluster (paginated)    |
| `get-kubeconfig` | Fetch the cluster kubeconfig (base64) into a **sensitive** snapshot         |

## Secret handling

The cluster **kubeconfig** contains cluster-admin credentials. The
`get-kubeconfig` method stores the base64 `content` in a dedicated `kubeconfig`
resource whose `content` field is marked **sensitive**: the raw kubeconfig is
never logged and is never written into a normal `cluster` or `pool` snapshot.
The `secretKey` global argument is likewise sensitive and wired from a vault.

## Region pre-flight

A labeled `valid-region` check (`["policy"]`) validates the target region before
the mutating verbs `create`, `update`, and `delete` run. Note: the `upgrade`
method is not one of the auto-checked verb names
(`create`/`update`/`delete`/`action`), so its pre-flight does not fire
automatically — validate the region on a prior `create`/`update`, or run `sync`
first.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a Kapsule cluster (wire the key from the vault)
swamp model create @sntxrr/scaleway-kapsule main-cluster \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'clusterId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-kapsule method run sync main-cluster
swamp model @sntxrr/scaleway-kapsule method run create main-cluster \
  --input name=main-cluster --input version=1.30.2 --input cni=cilium
swamp model @sntxrr/scaleway-kapsule method run update main-cluster --input name=renamed
swamp model @sntxrr/scaleway-kapsule method run upgrade main-cluster --input version=1.31.0
swamp model @sntxrr/scaleway-kapsule method run delete main-cluster
swamp model @sntxrr/scaleway-kapsule method run list main-cluster
swamp model @sntxrr/scaleway-kapsule method run list-pools main-cluster
swamp model @sntxrr/scaleway-kapsule method run get-kubeconfig main-cluster
```

`sync`, `list`, and `list-pools` are read-only. Scaleway provisioning is
asynchronous — the cluster returns a transient status (`creating`, `updating`);
poll `sync` to observe the settled `ready` state.

## Global arguments

| Arg         | Required    | Default                    | Description                                                                                                 |
| ----------- | ----------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `secretKey` | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                      |
| `projectId` | yes         | —                          | Project ID that owns the cluster                                                                            |
| `region`    | no          | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                                                                       |
| `clusterId` | conditional | —                          | ID of the Kapsule cluster this model manages. Required by every method except `create`, which provisions it |
| `endpoint`  | no          | `https://api.scaleway.com` | Override the API host                                                                                       |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_kapsule.ts
$DENO test  scaleway_kapsule_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
