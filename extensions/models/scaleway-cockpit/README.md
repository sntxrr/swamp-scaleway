# @sntxrr/scaleway-cockpit

A [swamp](https://swamp-club.com) model for a **Scaleway Cockpit (Observability)
data source** — one model instance per data source, keyed by its data source ID.
Wraps the
[Scaleway Cockpit API](https://www.scaleway.com/en/developers/api/cockpit/regional-api/)
(`/cockpit/v1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault). A
Cockpit data source is a metrics, logs, or traces backend that Grafana and
ingestion clients read from and write to.

## Methods

| Method        | What it does                                                                  |
| ------------- | ----------------------------------------------------------------------------- |
| `sync`        | Fetch the data source's current state (`GetDataSource`) and store a snapshot  |
| `create`      | Provision a new data source (`CreateDataSource`) and snapshot it              |
| `delete`      | Deprovision the data source (`DeleteDataSource`); a 404 is treated as success |
| `list`        | Factory discovery — snapshot every data source in the region (paginated)      |
| `list-tokens` | Factory discovery — snapshot every Cockpit token's non-secret metadata        |

## Secret handling

A Cockpit **token** carries a `secret_key` that the API returns **only once**,
at creation. This model never provisions tokens and never writes any token
secret into a snapshot or log: `list-tokens` maps only non-secret token metadata
(id, name, scopes, timestamps). The token snapshot schema has no secret field by
construction. The `secretKey` global argument (your API key) is sensitive and is
wired from a vault, never hardcoded.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a data source (wire the key from the vault)
swamp model create @sntxrr/scaleway-cockpit main-metrics \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'dataSourceId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-cockpit method run sync main-metrics
swamp model @sntxrr/scaleway-cockpit method run create main-metrics \
  --input name=app-metrics --input type=metrics --input retentionDays=31
swamp model @sntxrr/scaleway-cockpit method run delete main-metrics
swamp model @sntxrr/scaleway-cockpit method run list main-metrics
swamp model @sntxrr/scaleway-cockpit method run list-tokens main-metrics
```

`sync`, `list`, and `list-tokens` are read-only. `type` must be one of
`metrics`, `logs`, or `traces`.

## Global arguments

| Arg            | Required    | Default                    | Description                                                                                             |
| -------------- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `secretKey`    | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                  |
| `projectId`    | yes         | —                          | Project ID that owns the data sources and tokens                                                        |
| `region`       | no          | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                                                                   |
| `dataSourceId` | conditional | —                          | ID of the data source this model manages. Required by every method except `create`, which provisions it |
| `endpoint`     | no          | `https://api.scaleway.com` | Override the API host                                                                                   |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_cockpit.ts
$DENO test  scaleway_cockpit_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
