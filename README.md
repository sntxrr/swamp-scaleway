# swamp-scaleway

A [swamp](https://swamp-club.com) extension monorepo for **Scaleway** — one
published `@sntxrr/scaleway-*` extension per Scaleway service, each wrapping the
service's REST API as swamp models (methods + versioned data), using only Deno's
built-in `fetch` and Web Crypto — no vendor SDK.

Modeled on the [`swamp-oci`](https://github.com/sntxrr/swamp-oci) precedent, and
built by a team of agents against a single shared contract.

## Design docs

- **[PRD.md](./PRD.md)** — product requirements: goals, service catalog (3
  waves), agent team model, definition of done.
- **[CONVENTIONS.md](./CONVENTIONS.md)** — the implementation contract: auth,
  URL patterns, the canonical HTTP client, the golden model template, and the
  verify → review → publish sequence every extension follows.

## Authentication

All token-auth Scaleway services use the `X-Auth-Token` header with your API
secret key, wired from a swamp vault (never hardcoded):

```bash
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste your Scaleway API secret key
```

Object Storage and File Storage use the S3 API with AWS SigV4 (access key +
secret key) — see [CONVENTIONS.md](./CONVENTIONS.md) Appendix A.

## Published extensions

Extensions are published to the swamp registry under `@sntxrr/scaleway-*`. This
table is the index of what's shipped (updated as each extension lands).

Status legend: ✅ built & verified locally (quality 14/14, review-ready) ·
🚧 building · ⬜ planned. Nothing is published to the registry yet — publishing
follows smoke tests + the adversarial-review gate.

| Extension | Service | Methods | Status |
| --- | --- | --- | --- |
| `@sntxrr/scaleway-instance` | Compute Instances | sync, action, list | ✅ built |
| `@sntxrr/scaleway-block-storage` | Block Storage | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-vpc` | VPC & Private Networks | sync, create, delete, list, list-private-networks | ✅ built |
| `@sntxrr/scaleway-rdb` | Managed Database (PG/MySQL) | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-dns` | Domains & DNS | sync, list-records, list-zones, set-records | ✅ built |
| `@sntxrr/scaleway-load-balancer` | Load Balancer | sync, create, delete, list | 🚧 building |
| `@sntxrr/scaleway-object-storage` | Object Storage (S3) | list-buckets, create-bucket, delete-bucket, sync, list-objects | 🚧 building |

See [PRD.md](./PRD.md) §6 for the full catalog across all three waves.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check extensions/models/scaleway_<service>.ts
$DENO test  extensions/models/scaleway_<service>_test.ts
swamp extension quality manifests/scaleway-<service>.yaml --json
```

## License

MIT — see each extension's `LICENSE.md`.
