# @sntxrr/scaleway-messaging

A [swamp](https://swamp-club.com) model for a **Scaleway Messaging & Queuing
(MNQ) NATS account** — one model instance per NATS account, keyed by its account
ID. Wraps the
[Scaleway Messaging & Queuing NATS API](https://www.scaleway.com/en/developers/api/messaging-and-queuing/nats-api/)
(`/mnq/v1beta1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault). A
NATS account provides the scope for your NATS streams, messages, and
credentials.

## Methods

| Method   | What it does                                                              |
| -------- | ------------------------------------------------------------------------- |
| `sync`   | Fetch the account's current state (`GetNatsAccount`) and store a snapshot |
| `create` | Provision a new NATS account (`CreateNatsAccount`) and snapshot it        |
| `update` | Mutate mutable fields — name (`UpdateNatsAccount`, PATCH)                 |
| `delete` | Deprovision the account (`DeleteNatsAccount`)                             |
| `list`   | Factory discovery — snapshot every NATS account in the region (paginated) |

## Secret handling

The Scaleway API `secretKey` is a sensitive global argument, wired from a vault
and sent only as the `X-Auth-Token` request header — it is never logged or
written into a resource snapshot. NATS account snapshots store only non-secret
metadata (id, name, connection `endpoint`, project, timestamps).

**NATS credentials** (the private credential material returned by
`CreateNatsCredentials`) are a distinct secret-bearing operation and are
intentionally **out of scope for this version** — see _Future work_ below.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a NATS account (wire the key from the vault)
swamp model create @sntxrr/scaleway-messaging main-nats \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'natsAccountId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-messaging method run sync main-nats
swamp model @sntxrr/scaleway-messaging method run create main-nats \
  --input name=main-nats
swamp model @sntxrr/scaleway-messaging method run update main-nats --input name=renamed-nats
swamp model @sntxrr/scaleway-messaging method run delete main-nats
swamp model @sntxrr/scaleway-messaging method run list main-nats
```

`sync` and `list` are read-only. `delete` is idempotent — a `404` (already gone)
is treated as success and records an `absent` snapshot.

## Global arguments

| Arg             | Required    | Default                    | Description                                                                                              |
| --------------- | ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `secretKey`     | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                   |
| `projectId`     | yes         | —                          | Project ID that owns the NATS account                                                                    |
| `region`        | no          | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                                                                    |
| `natsAccountId` | conditional | —                          | ID of the NATS account this model manages. Required by every method except `create`, which provisions it |
| `endpoint`      | no          | `https://api.scaleway.com` | Override the API host                                                                                    |

## Future work

- **NATS credentials** (`create-credentials` / `get-credentials`): these return
  private credential material (JWT / seed / creds file). They must be surfaced
  via a sensitive field and never snapshotted or logged; deferred to a future
  version.
- **SQS/SNS activation info**: MNQ also exposes SQS/SNS activation-status and
  credential endpoints; not modeled here.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_messaging.ts
$DENO test  scaleway_messaging_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
