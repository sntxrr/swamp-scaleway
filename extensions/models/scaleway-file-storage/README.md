# @sntxrr/scaleway-file-storage

A [swamp](https://swamp-club.com) model for a **Scaleway File Storage (managed
NFS) filesystem** — one model instance per filesystem, keyed by its filesystem
ID. Wraps the
[Scaleway File Storage API](https://www.scaleway.com/en/developers/api/file-storage/)
(`/file/v1alpha1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).
This is the native Scaleway token API — not the S3/SigV4 surface.

File Storage provides network-attached storage that can be mounted by multiple
Instances in the same region simultaneously (accessible over Private Networks).

## Methods

| Method   | What it does                                                                |
| -------- | --------------------------------------------------------------------------- |
| `sync`   | Fetch the filesystem's current state (`GetFileSystem`) and store a snapshot |
| `create` | Provision a new filesystem (`CreateFileSystem`) and snapshot it             |
| `update` | Mutate mutable fields — name, size, tags (`UpdateFileSystem`)               |
| `delete` | Deprovision a detached filesystem (`DeleteFileSystem`)                      |
| `list`   | Factory discovery — snapshot every filesystem in the region (paginated)     |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a filesystem (wire the key from the vault)
swamp model create @sntxrr/scaleway-file-storage main-fs \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'filesystemId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-file-storage method run sync main-fs
swamp model @sntxrr/scaleway-file-storage method run create main-fs \
  --input name=main-fs --input size=25000000000
swamp model @sntxrr/scaleway-file-storage method run update main-fs \
  --input name=renamed-fs --input size=50000000000
swamp model @sntxrr/scaleway-file-storage method run delete main-fs
swamp model @sntxrr/scaleway-file-storage method run list main-fs
```

`sync` and `list` are read-only. Filesystem `size` is in bytes with GB
granularity (10^9): the minimum is 25 GB and the maximum is 50 TB; a `size`
passed to `update` must be larger than the current size. Scaleway provisioning
is asynchronous — the filesystem returns a transient status (`creating`,
`updating`); poll `sync` to observe the settled `available` state. A filesystem
must be detached from all Instances before it can be deleted.

## Global arguments

| Arg            | Required    | Default                    | Description                                                                                            |
| -------------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `secretKey`    | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                 |
| `projectId`    | yes         | —                          | Project ID that owns the filesystem                                                                    |
| `region`       | no          | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                                                                  |
| `filesystemId` | conditional | —                          | ID of the filesystem this model manages. Required by every method except `create`, which provisions it |
| `endpoint`     | no          | `https://api.scaleway.com` | Override the API host                                                                                  |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_file_storage.ts
$DENO test  scaleway_file_storage_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
