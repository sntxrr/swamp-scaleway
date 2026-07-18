# @sntxrr/scaleway-object-storage

A [swamp](https://swamp-club.com) model for **Scaleway Object Storage** — an
S3-compatible bucket, keyed by its bucket name. Wraps the
[Scaleway Object Storage S3 API](https://www.scaleway.com/en/developers/api/object-storage/)
(`https://s3.<region>.scw.cloud`) using only Deno's built-in `fetch` and Web
Crypto — no SDK, no npm dependencies.

**Auth is different from the other Scaleway extensions.** Object Storage speaks
the S3 API, so it does **not** use the `X-Auth-Token` header. Every request is
signed with **AWS Signature Version 4** (service `s3`) from an **access key** and
**secret key** (both wired from a vault). The signer is implemented inline with
Web Crypto HMAC-SHA256; the secret key is used only to derive the signing key and
is never logged or stored in a snapshot.

## Methods

| Method          | What it does                                                                       |
| --------------- | ---------------------------------------------------------------------------------- |
| `list-buckets`  | Factory discovery — `GET /` → `ListAllMyBucketsResult`; snapshot every bucket        |
| `create-bucket` | Create the managed bucket (`PUT /{bucket}`)                                          |
| `delete-bucket` | Delete the managed bucket (`DELETE /{bucket}`; the bucket must be empty)             |
| `sync`          | Confirm the managed bucket exists and record its region (`HEAD /{bucket}`)           |
| `list-objects`  | Factory discovery — `GET /{bucket}?list-type=2` (ListObjectsV2), paginated via tokens |

Object put/get/delete are **out of scope for v1** and are planned as a future
addition.

## Setup

```bash
# Store your Scaleway Object Storage API key (access + secret) in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_ACCESS_KEY   # paste the access key
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key

# Register a bucket (wire both halves of the key from the vault)
swamp model create @sntxrr/scaleway-object-storage my-bucket \
  --global-arg 'accessKey=${{ vault.get(scaleway, SCW_ACCESS_KEY) }}' \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'region=fr-par' \
  --global-arg 'bucket=my-bucket'
```

## Usage

```bash
swamp model @sntxrr/scaleway-object-storage method run list-buckets my-bucket
swamp model @sntxrr/scaleway-object-storage method run create-bucket my-bucket
swamp model @sntxrr/scaleway-object-storage method run sync my-bucket
swamp model @sntxrr/scaleway-object-storage method run list-objects my-bucket
swamp model @sntxrr/scaleway-object-storage method run list-objects my-bucket --input prefix=logs/
swamp model @sntxrr/scaleway-object-storage method run delete-bucket my-bucket
```

`list-buckets`, `sync`, and `list-objects` are read-only. `list-buckets` and
`list-objects` are factory methods — one run writes many snapshots.

## Global arguments

| Arg         | Required | Default                          | Description                                                           |
| ----------- | -------- | -------------------------------- | --------------------------------------------------------------------- |
| `accessKey` | yes      | —                                | Object Storage access key (public half of the API key)                |
| `secretKey` | yes      | —                                | Object Storage secret key (sensitive; wire from a vault)              |
| `region`    | no       | `fr-par`                         | Region: `fr-par`, `nl-ams`, or `pl-waw`                               |
| `bucket`    | yes      | —                                | Bucket this model manages (ignored by `list-buckets`)                 |
| `endpoint`  | no       | `https://s3.<region>.scw.cloud`  | Override the S3 endpoint base URL                                     |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_object_storage.ts
$DENO test  scaleway_object_storage_test.ts   # includes a SigV4 known-answer test
swamp extension quality manifest.yaml --json
```

The test suite includes a **SigV4 known-answer test** that reproduces AWS's
documented S3 "GET Object" example signature, proving the inline signer is
correct.

## License

MIT — see [LICENSE.md](./LICENSE.md).
