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
| `@sntxrr/scaleway-load-balancer` | Load Balancer | sync, create, update, delete, list, list-backends, list-frontends | ✅ built |
| `@sntxrr/scaleway-object-storage` | Object Storage (S3, SigV4) | list-buckets, create, delete, sync, list-objects | ✅ built |
| `@sntxrr/scaleway-registry` | Container Registry | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-kapsule` | Kubernetes Kapsule | sync, create, update, upgrade, delete, list, list-pools, get-kubeconfig | ✅ built |
| `@sntxrr/scaleway-serverless-functions` | Serverless Functions | sync, create, update, delete, action, list, list-namespaces | ✅ built |
| `@sntxrr/scaleway-serverless-containers` | Serverless Containers | sync, create, update, delete, action, list, list-namespaces | ✅ built |
| `@sntxrr/scaleway-key-manager` | Key Manager (KMS) | sync, create, delete, list, encrypt, decrypt, rotate | ✅ built |
| `@sntxrr/scaleway-iam` | IAM (global) | sync, create, update, delete, list, list-api-keys, list-policies | ✅ built |
| `@sntxrr/scaleway-secret-manager` | Secret Manager | sync, create, update, delete, list, add-version, access | ✅ built |
| `@sntxrr/scaleway-secret-manager-vault` | Secret Manager (vault backend) | get, put, list, getName | ✅ built |
| `@sntxrr/scaleway-elastic-metal` | Bare Metal | sync, create, action, delete, list | ✅ built |
| `@sntxrr/scaleway-apple-silicon` | Apple silicon (Mac) | sync, create, update, action, delete, list | ✅ built |
| `@sntxrr/scaleway-redis` | Managed Redis | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-mongodb` | Managed MongoDB | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-public-gateway` | Public Gateway | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-serverless-jobs` | Serverless Jobs | sync, create, update, action, delete, list | ✅ built |
| `@sntxrr/scaleway-ipam` | IP Address Management | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-inference` | Managed Inference | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-cockpit` | Observability (Cockpit) | sync, create, delete, list, list-tokens | ✅ built |
| `@sntxrr/scaleway-messaging` | Messaging & Queuing (NATS) | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-tem` | Transactional Email | sync, create, delete, list, list-emails | ✅ built |
| `@sntxrr/scaleway-file-storage` | File Storage (managed NFS) | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-webhosting` | Web Hosting | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-account` | Account / Projects (global) | sync, create, update, delete, list | ✅ built |
| `@sntxrr/scaleway-inventory` | Cross-service inventory **report** | (report) | ✅ built |

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
