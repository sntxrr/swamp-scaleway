# @sntxrr/scaleway-key-manager

A [swamp](https://swamp-club.com) model for a **Scaleway Key Manager (KMS)
key** — one model instance per key, keyed by its key ID. Wraps the
[Scaleway Key Manager API](https://www.scaleway.com/en/developers/api/key-manager/)
(`/key-manager/v1alpha1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method    | What it does                                                              |
| --------- | ------------------------------------------------------------------------ |
| `sync`    | Fetch the key's current metadata (`GetKey`) and store a snapshot          |
| `create`  | Provision a new key (`CreateKey`) and snapshot its metadata               |
| `delete`  | Deprovision the key (`DeleteKey`) — idempotent (a 404 is treated as gone) |
| `list`    | Factory discovery — snapshot every key in the region (paginated)          |
| `encrypt` | Encrypt base64 plaintext (`Encrypt`); snapshots only the ciphertext       |
| `decrypt` | Decrypt ciphertext (`Decrypt`); returns plaintext in a sensitive field    |
| `rotate`  | Rotate the key's material (`RotateKey`) and re-snapshot it                |

## Secret handling

The `plaintext` handled by `encrypt` (input) and `decrypt` (output) is
**sensitive**:

- `encrypt`'s `plaintext` argument is marked sensitive; it is sent to the API to
  encrypt but is **never logged** and **never written into any snapshot**. The
  `encrypt` snapshot stores only the returned **ciphertext**, which is not a
  secret.
- `decrypt` returns the recovered plaintext via a dedicated `plaintext` resource
  whose `plaintext` field is marked sensitive (masked in display and logs). It
  is never logged and never written into the normal key snapshot.

The API `secretKey` is likewise sensitive and wired from a vault; it never
appears in a snapshot or log.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a key (wire the key from the vault)
swamp model create @sntxrr/scaleway-key-manager main-key \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'keyId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-key-manager method run sync main-key
swamp model @sntxrr/scaleway-key-manager method run create main-key \
  --input name=app-key --input usageSymmetricEncryption=aes_256_gcm
swamp model @sntxrr/scaleway-key-manager method run rotate main-key
swamp model @sntxrr/scaleway-key-manager method run list main-key
swamp model @sntxrr/scaleway-key-manager method run delete main-key

# Cryptographic operations (plaintext is base64-encoded)
swamp model @sntxrr/scaleway-key-manager method run encrypt main-key \
  --input plaintext="$(printf 'hello' | base64)"
swamp model @sntxrr/scaleway-key-manager method run decrypt main-key \
  --input ciphertext='<ciphertext-from-encrypt>'
```

`sync` and `list` are read-only. `encrypt` accepts base64 plaintext and returns
base64 ciphertext; `decrypt` reverses it and returns base64 plaintext.

## Global arguments

| Arg         | Required | Default                    | Description                                            |
| ----------- | -------- | -------------------------- | ------------------------------------------------------ |
| `secretKey` | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault) |
| `projectId` | yes      | —                          | Project ID that owns the key                           |
| `region`    | no       | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                  |
| `keyId`     | yes      | —                          | ID of the key this model manages                       |
| `endpoint`  | no       | `https://api.scaleway.com` | Override the API host                                  |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_key_manager.ts
$DENO test  scaleway_key_manager_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
