# @sntxrr/scaleway-public-gateway

A [swamp](https://swamp-club.com) model for a **Scaleway Public Gateway** — one
model instance per Public Gateway, keyed by its gateway ID. Wraps the
[Scaleway Public Gateway API](https://www.scaleway.com/en/developers/api/public-gateways/)
(`/vpc-gw/v2`, zoned) using only Deno's built-in `fetch` — no SDK. Authenticated
with the `X-Auth-Token` header (secret key wired from a vault).

## Methods

| Method   | What it does                                                                   |
| -------- | ------------------------------------------------------------------------------ |
| `sync`   | Fetch the Public Gateway's current state (`GetGateway`) and store a snapshot    |
| `create` | Provision a new Public Gateway (`CreateGateway`) and snapshot it (with its ID)  |
| `update` | Update the gateway's `name`, `tags`, or bastion/SMTP settings (`UpdateGateway`) |
| `delete` | Deprovision the gateway (`DeleteGateway`); optionally delete its flexible IP    |
| `list`   | Factory discovery — snapshot every Public Gateway in the zone (paginated)       |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a Public Gateway (wire the key from the vault)
swamp model create @sntxrr/scaleway-public-gateway edge-gw \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'zone=fr-par-1' \
  --global-arg 'gatewayId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-public-gateway method run sync edge-gw
swamp model @sntxrr/scaleway-public-gateway method run create edge-gw --input name=edge-gw --input type=VPC-GW-S
swamp model @sntxrr/scaleway-public-gateway method run update edge-gw --input name=edge-gw-2
swamp model @sntxrr/scaleway-public-gateway method run delete edge-gw --input deleteIp=true
swamp model @sntxrr/scaleway-public-gateway method run list edge-gw
```

`sync` and `list` are read-only. Scaleway Public Gateway provisioning is
asynchronous — `create` returns a transient status (`allocating`,
`configuring`); poll `sync` to observe the settled `running` state.

## Global arguments

| Arg         | Required | Default                    | Description                                              |
| ----------- | -------- | -------------------------- | -------------------------------------------------------- |
| `secretKey` | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault)   |
| `projectId` | yes      | —                          | Project ID that owns the Public Gateway                  |
| `zone`      | no       | `fr-par-1`                 | Availability zone (`fr-par-1`, `it-mil-1`, `nl-ams-1`…)  |
| `gatewayId` | yes      | —                          | ID of the Public Gateway this model manages              |
| `endpoint`  | no       | `https://api.scaleway.com` | Override the API host                                    |

> **Zones:** the Public Gateway v2 API accepts `fr-par-1`, `fr-par-2`,
> `it-mil-1`, `nl-ams-1`, `nl-ams-2`, `nl-ams-3`, `pl-waw-1`, `pl-waw-2`,
> `pl-waw-3`. Note it supports `it-mil-1` (Milan) but not `fr-par-3`.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_public_gateway.ts
$DENO test  scaleway_public_gateway_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
