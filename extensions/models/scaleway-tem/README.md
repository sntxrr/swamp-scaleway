# @sntxrr/scaleway-tem

A [swamp](https://swamp-club.com) model for a **Scaleway Transactional Email
(TEM) sending domain** — one model instance per domain, keyed by its domain ID.
Wraps the
[Scaleway Transactional Email API](https://www.scaleway.com/en/developers/api/transactional-email/)
(`/transactional-email/v1alpha1`, regional) using only Deno's built-in `fetch` —
no SDK. Authenticated with the `X-Auth-Token` header (secret key wired from a
vault).

## Methods

| Method        | What it does                                                            |
| ------------- | ----------------------------------------------------------------------- |
| `sync`        | Fetch the domain's current state (`GetDomain`) and store a snapshot      |
| `create`      | Register a new sending domain (`CreateDomain`) and snapshot it           |
| `delete`      | Revoke the domain (`DeleteDomain`, POST `.../{id}/delete`)               |
| `list`        | Factory discovery — snapshot every domain in the region (paginated)      |
| `list-emails` | Factory discovery — snapshot every sent email in the region (paginated)  |

## Secret handling

Only public, non-secret metadata is stored. The DKIM **private** key that
Scaleway generates for a domain is never fetched, logged, or written into a
resource snapshot. Email snapshots record subject, status, sender, and recipient
addresses — never message bodies or credentials.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a sending domain (wire the key from the vault)
swamp model create @sntxrr/scaleway-tem main-domain \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'domainId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-tem method run sync main-domain
swamp model @sntxrr/scaleway-tem method run create main-domain \
  --input domainName=mail.example.com --input acceptTos=true
swamp model @sntxrr/scaleway-tem method run delete main-domain
swamp model @sntxrr/scaleway-tem method run list main-domain
swamp model @sntxrr/scaleway-tem method run list-emails main-domain
```

`sync`, `list`, and `list-emails` are read-only. Domain validation is
asynchronous — a newly created domain returns a transient status (`pending`,
`unchecked`); poll `sync` to observe the settled `checked` state once its DNS
records are configured.

## Global arguments

| Arg         | Required | Default                    | Description                                            |
| ----------- | -------- | -------------------------- | ------------------------------------------------------ |
| `secretKey` | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault) |
| `projectId` | yes      | —                          | Project ID that owns the domain                        |
| `region`    | no       | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                  |
| `domainId`  | yes      | —                          | ID of the sending domain this model manages            |
| `endpoint`  | no       | `https://api.scaleway.com` | Override the API host                                  |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_tem.ts
$DENO test  scaleway_tem_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
