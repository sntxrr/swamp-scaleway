# @sntxrr/scaleway-ipam

A [swamp](https://swamp-club.com) model for a **Scaleway IPAM (IP Address
Management) IP** — one model instance per managed IP address, keyed by its IP ID.
Wraps the [Scaleway IPAM API](https://www.scaleway.com/en/developers/api/ipam/)
(`/ipam/v1`, regional) using only Deno's built-in `fetch` — no SDK. Authenticated
with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method   | What it does                                                            |
| -------- | ---------------------------------------------------------------------- |
| `sync`   | Fetch the IP's current state (`GetIP`) and store a snapshot             |
| `create` | Book (reserve) a new IP address (`BookIP`) and snapshot it              |
| `update` | Mutate mutable fields — tags, reverse DNS entries (`UpdateIP`)          |
| `delete` | Release the IP address (`ReleaseIP`); a 404 is treated as already gone  |
| `list`   | Factory discovery — snapshot every managed IP in the region (paginated) |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a managed IP (wire the key from the vault)
swamp model create @sntxrr/scaleway-ipam main-ip \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'ipId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-ipam method run sync main-ip
swamp model @sntxrr/scaleway-ipam method run create main-ip \
  --input source='{"subnet_id":"44444444-4444-4444-4444-444444444444"}' \
  --input isIpv6=false
swamp model @sntxrr/scaleway-ipam method run update main-ip --input tags='["prod"]'
swamp model @sntxrr/scaleway-ipam method run delete main-ip
swamp model @sntxrr/scaleway-ipam method run list main-ip
```

`sync` and `list` are read-only. The `create` `source` selects the pool the IP is
booked from — a Private Network subnet (`{"subnet_id":"..."}`) or a zonal public
pool (`{"zonal":"fr-par-1"}`). Addresses in this doc are RFC 5737 documentation
ranges (`192.0.2.x` / `198.51.100.x` / `203.0.113.x`).

## Global arguments

| Arg         | Required | Default                    | Description                                           |
| ----------- | -------- | -------------------------- | ----------------------------------------------------- |
| `secretKey` | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault) |
| `projectId` | yes      | —                          | Project ID that owns the IP                           |
| `region`    | no       | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                 |
| `ipId`      | yes      | —                          | ID of the managed IP this model manages               |
| `endpoint`  | no       | `https://api.scaleway.com` | Override the API host                                 |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_ipam.ts
$DENO test  scaleway_ipam_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
