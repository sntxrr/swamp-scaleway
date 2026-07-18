# @sntxrr/scaleway-block-storage

A [swamp](https://swamp-club.com) model for a **Scaleway Block Storage volume**
— one model instance per volume, keyed by its volume ID. Wraps the
[Scaleway Block Storage API](https://www.scaleway.com/en/developers/api/block/)
(`/block/v1`, zoned) using only Deno's built-in `fetch` — no SDK. Authenticated
with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method   | What it does                                                                          |
| -------- | ------------------------------------------------------------------------------------- |
| `sync`   | Fetch the volume's current state (`GetVolume`) and store a snapshot                     |
| `create` | Provision a new volume (`CreateVolume`) from empty (with `size`) or from a snapshot     |
| `update` | Mutate name, size (resize), IOPS, or tags (`UpdateVolume`, PATCH)                       |
| `delete` | Deprovision the volume (`DeleteVolume`)                                                 |
| `list`   | Factory discovery — snapshot every volume in the zone (paginated)                      |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a volume (wire the key from the vault)
swamp model create @sntxrr/scaleway-block-storage data-1 \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'zone=fr-par-1' \
  --global-arg 'volumeId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-block-storage method run sync data-1
swamp model @sntxrr/scaleway-block-storage method run create data-1 \
  --input name=data-1 --input size=20000000000 --input perfIops=5000
swamp model @sntxrr/scaleway-block-storage method run update data-1 \
  --input size=30000000000
swamp model @sntxrr/scaleway-block-storage method run delete data-1
swamp model @sntxrr/scaleway-block-storage method run list data-1
```

`sync` and `list` are read-only. Scaleway volume operations are asynchronous —
`create`, `update`, and `delete` return a transient status (`creating`,
`resizing`, `deleting`); poll `sync` to observe the settled state. Sizes are in
**bytes**.

## Global arguments

| Arg         | Required | Default                     | Description                                             |
| ----------- | -------- | --------------------------- | ------------------------------------------------------- |
| `secretKey` | yes      | —                           | Scaleway API secret key (sensitive; wire from a vault)  |
| `projectId` | yes      | —                           | Project ID that owns the volume                         |
| `zone`      | no       | `fr-par-1`                  | Availability zone (`fr-par-1`, `nl-ams-1`, `pl-waw-1`…) |
| `volumeId`  | yes      | —                           | ID of the Block Storage volume this model manages       |
| `endpoint`  | no       | `https://api.scaleway.com`  | Override the API host                                   |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_block_storage.ts
$DENO test  scaleway_block_storage_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
