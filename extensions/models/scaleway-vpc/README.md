# @sntxrr/scaleway-vpc

A [swamp](https://swamp-club.com) model for a **Scaleway VPC** (Virtual Private
Cloud) — one model instance per VPC, keyed by its VPC ID. Wraps the
[Scaleway VPC API](https://www.scaleway.com/en/developers/api/vpc/)
(`/vpc/v2`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method                  | What it does                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `sync`                  | Fetch the VPC's current state (`GetVPC`) and store a snapshot         |
| `create`                | Provision a new VPC (`CreateVPC`) and snapshot it, including its ID   |
| `update`                | Mutate the VPC's name, tags, or routing (`UpdateVPC`) and snapshot it |
| `delete`                | Deprovision the VPC (`DeleteVPC`); a 404 is treated as already gone   |
| `list`                  | Factory discovery — snapshot every VPC in the region (paginated)     |
| `list-private-networks` | Factory discovery — snapshot every Private Network in the region     |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a VPC (wire the key from the vault)
swamp model create @sntxrr/scaleway-vpc prod-vpc \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'vpcId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-vpc method run sync prod-vpc
swamp model @sntxrr/scaleway-vpc method run create prod-vpc --input name=new-vpc
swamp model @sntxrr/scaleway-vpc method run update prod-vpc --input name=renamed-vpc
swamp model @sntxrr/scaleway-vpc method run list prod-vpc
swamp model @sntxrr/scaleway-vpc method run list-private-networks prod-vpc
swamp model @sntxrr/scaleway-vpc method run delete prod-vpc
```

`sync`, `list`, and `list-private-networks` are read-only. `create` writes a
snapshot including the new VPC's ID; `update` mutates the VPC's name, tags, or
routing and re-snapshots it; `delete` deprovisions the VPC keyed by `vpcId` (a
`404` is treated as already gone) and writes an absent snapshot — verify the ID
first with `swamp model get --json`. A labeled `valid-region` pre-flight check
runs before `create`/`update`/`delete`, rejecting any `region` outside
`fr-par`, `nl-ams`, `pl-waw`.

## Global arguments

| Arg         | Required | Default                    | Description                                            |
| ----------- | -------- | -------------------------- | ------------------------------------------------------ |
| `secretKey` | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault) |
| `projectId` | yes      | —                          | Project ID that owns the VPC                           |
| `region`    | no       | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                  |
| `vpcId`     | yes      | —                          | ID of the VPC this model manages                       |
| `endpoint`  | no       | `https://api.scaleway.com` | Override the API host                                  |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_vpc.ts
$DENO test  scaleway_vpc_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
