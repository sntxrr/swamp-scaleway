# @sntxrr/scaleway-webhosting

A [swamp](https://swamp-club.com) model for a **Scaleway Web Hosting plan** —
one model instance per plan, keyed by its hosting ID. Wraps the
[Scaleway Web Hosting API](https://www.scaleway.com/en/developers/api/webhosting/hosting-api/)
(`/webhosting/v1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).
Web Hosting is currently offered only in the `fr-par` region.

## Methods

| Method   | What it does                                                       |
| -------- | ------------------------------------------------------------------ |
| `sync`   | Fetch the plan's current state (`GetHosting`) and store a snapshot |
| `create` | Provision a new Web Hosting plan (`CreateHosting`) and snapshot it |
| `update` | Mutate mutable fields — offer, tags, protected (`UpdateHosting`)   |
| `delete` | Deprovision the plan (`DeleteHosting`); a 404 is treated as absent |
| `list`   | Factory discovery — snapshot every plan in the region (paginated)  |

## Secret handling

Creating a plan does **not** take a password. A Web Hosting plan's control-panel
one-time password is issued only through the separate `ResetHostingPassword`
endpoint (not implemented here) and is **never** logged or written into a
snapshot. The resource mapper copies only an allow-list of non-secret fields
(status, domain, offer, platform hostname, IPv4, username); any credential
echoed by the API is dropped.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a Web Hosting plan (wire the key from the vault)
swamp model create @sntxrr/scaleway-webhosting main-site \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'hostingId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-webhosting method run sync main-site
swamp model @sntxrr/scaleway-webhosting method run create main-site \
  --input offerId=44444444-4444-4444-4444-444444444444 \
  --input domain=example.com --input email=admin@example.com
swamp model @sntxrr/scaleway-webhosting method run update main-site --input protected=true
swamp model @sntxrr/scaleway-webhosting method run delete main-site
swamp model @sntxrr/scaleway-webhosting method run list main-site
```

`sync` and `list` are read-only. Scaleway provisioning is asynchronous — the
plan returns a transient status (`delivering`, `updating`); poll `sync` to
observe the settled `ready` state.

## Global arguments

| Arg         | Required    | Default                    | Description                                                                                                  |
| ----------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `secretKey` | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                       |
| `projectId` | yes         | —                          | Project ID that owns the plan                                                                                |
| `region`    | no          | `fr-par`                   | Region (Web Hosting is offered only in `fr-par`)                                                             |
| `hostingId` | conditional | —                          | ID of the Web Hosting plan this model manages. Required by every method except `create`, which provisions it |
| `endpoint`  | no          | `https://api.scaleway.com` | Override the API host                                                                                        |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_webhosting.ts
$DENO test  scaleway_webhosting_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
