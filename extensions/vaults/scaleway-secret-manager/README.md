# @sntxrr/scaleway-secret-manager-vault

A [swamp](https://swamp-club.com) **vault backend** backed by
[Scaleway Secret Manager](https://www.scaleway.com/en/developers/api/secret-manager/)
(`/secret-manager/v1beta1`, regional). Once configured, any model can source a
secret from Scaleway Secret Manager with a `vault.get(...)` expression — no SDK,
just Deno `fetch` and the `X-Auth-Token` header.

Companion to the `@sntxrr/scaleway-secret-manager` model (which manages secrets
as resources); this package exposes the same store as a swamp vault.

## Provider contract

| Method | Behavior |
| --- | --- |
| `get(name)` | Resolves the secret id from its name, accesses the latest version, returns the decoded value. **Throws** if the secret does not exist. |
| `put(name, value)` | Creates the secret on first use, then appends a new version (idempotent overwrite). |
| `list()` | Returns secret **names** only (never values), paginated. |
| `getName()` | The vault instance name. |

## Setup

```bash
swamp vault create @sntxrr/scaleway-secret-manager-vault scw-secrets \
  --config '{"secretKey":"<SCW_SECRET_KEY>","projectId":"11111111-1111-1111-1111-111111111111","region":"fr-par"}'
```

Then reference secrets from any model:

```bash
swamp model create @sntxrr/some-model my-thing \
  --global-arg 'apiToken=${{ vault.get(scw-secrets, API_TOKEN) }}'
```

## Config

| Key | Required | Default | Description |
| --- | --- | --- | --- |
| `secretKey` | yes | — | Scaleway API secret key (sensitive) |
| `projectId` | yes | — | Project that owns the secrets |
| `region` | no | `fr-par` | `fr-par`, `nl-ams`, `pl-waw` |
| `endpoint` | no | `https://api.scaleway.com` | API host override |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check mod.ts
$DENO test  mod_test.ts
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
