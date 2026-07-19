# @sntxrr/scaleway-dns

A [swamp](https://swamp-club.com) model for a **Scaleway DNS zone** — one model
instance per DNS zone, keyed by its domain name (`dnsZone`). Wraps the
[Scaleway Domains & DNS API](https://www.scaleway.com/en/developers/api/domains-and-dns/)
(`/domain/v2beta1`, **global**) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

> This API is **global**: paths carry **no** `/zones/{zone}` or
> `/regions/{region}` segment, so there is no zone/region global argument.

## Methods

| Method         | What it does                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`         | Fetch every DNS record in the zone (`ListDNSZoneRecords`) and store a snapshot per record                                                                                                                                                                |
| `list-records` | Alias of `sync` — snapshot every DNS record in the zone (paginated)                                                                                                                                                                                      |
| `list-zones`   | Factory discovery — snapshot every DNS zone in the project (paginated)                                                                                                                                                                                   |
| `create`       | Create a **child** DNS zone (`CreateDNSZone`) and snapshot it. Scaleway requires a subdomain — set `dnsZone` to `<label>.<domain>` (the apex/root zone comes from registering the domain, not this API). A `zone-specified` pre-flight check runs first. |
| `delete`       | Delete the DNS zone (`DeleteDNSZone`); idempotent (a `404` is treated as already absent). A `zone-specified` pre-flight check runs first.                                                                                                                |
| `update`       | Apply a batch of `add`/`set`/`delete`/`clear` record changes to the zone (PATCH), then snapshot the returned records. A `zone-specified` pre-flight check runs first.                                                                                    |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a DNS zone (wire the key from the vault)
swamp model create @sntxrr/scaleway-dns example-com \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'dnsZone=example.com'
```

## Usage

```bash
swamp model @sntxrr/scaleway-dns method run sync example-com
swamp model @sntxrr/scaleway-dns method run list-records example-com
swamp model @sntxrr/scaleway-dns method run list-zones example-com

# Create a child zone — the model's dnsZone must be a subdomain, e.g. test.example.com
# (Scaleway can't create the apex/root zone via the API). subdomain/domain are
# derived from dnsZone, or pass them explicitly.
swamp model @sntxrr/scaleway-dns method run create test-example-com

# Add a record (changes is the PATCH body's "changes" array, passed through verbatim)
swamp model @sntxrr/scaleway-dns method run update example-com \
  --input 'changes=[{"add":{"records":[{"name":"www","type":"A","data":"192.0.2.10","ttl":300}]}}]'

# Delete the zone (idempotent)
swamp model @sntxrr/scaleway-dns method run delete example-com
```

`sync`, `list-records`, and `list-zones` are read-only. `create`, `update`, and
`delete` mutate the zone. For `update`, each change object holds exactly one of
`add` (`{ records }`), `set` (`{ id_fields, records }`), `delete`
(`{ id_fields }`) or `clear` (`{}`). Because they are named `create`/`update`/
`delete`, the labeled `zone-specified` pre-flight check auto-fires before each
and fails fast if `dnsZone` is empty.

## Global arguments

| Arg         | Required    | Default                    | Description                                                                                         |
| ----------- | ----------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| `secretKey` | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                              |
| `projectId` | yes         | —                          | Project ID that owns the DNS zone                                                                   |
| `dnsZone`   | conditional | —                          | DNS zone (domain name) this model manages. Required by every method except the `list-zones` factory |
| `endpoint`  | no          | `https://api.scaleway.com` | Override the API host                                                                               |

> No `zone`/`region` argument — the Domains & DNS API is global.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_dns.ts
$DENO test  scaleway_dns_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
