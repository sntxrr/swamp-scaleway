# @sntxrr/scaleway-load-balancer

A [swamp](https://swamp-club.com) model for a **Scaleway Load Balancer** — one
model instance per Load Balancer, keyed by its LB ID. Wraps the
[Scaleway Load Balancer API](https://www.scaleway.com/en/developers/api/load-balancer/zoned-api/)
(`/lb/v1`, zoned) using only Deno's built-in `fetch` — no SDK. Authenticated
with the `X-Auth-Token` header (secret key wired from a vault).

> The **regional** Load Balancer API is deprecated — this model uses the zoned
> API.

## Methods

| Method           | What it does                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `sync`           | Fetch the Load Balancer's current state (`GetLb`) and store a snapshot         |
| `create`         | Provision a new Load Balancer (`CreateLb`) and snapshot it (including its ID)  |
| `update`         | Update the Load Balancer's `name`, `description`, or `tags` (`UpdateLb`)       |
| `delete`         | Deprovision the Load Balancer (`DeleteLb`); optionally release its flexible IP |
| `list`           | Factory discovery — snapshot every Load Balancer in the zone (paginated)       |
| `list-backends`  | Factory discovery — snapshot every backend attached to this LB (paginated)     |
| `list-frontends` | Factory discovery — snapshot every frontend attached to this LB (paginated)    |

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a Load Balancer (wire the key from the vault)
swamp model create @sntxrr/scaleway-load-balancer web-lb \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'zone=fr-par-1' \
  --global-arg 'lbId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-load-balancer method run sync web-lb
swamp model @sntxrr/scaleway-load-balancer method run create web-lb --input name=web-lb --input type=LB-S
swamp model @sntxrr/scaleway-load-balancer method run update web-lb --input name=web-lb-2
swamp model @sntxrr/scaleway-load-balancer method run delete web-lb --input releaseIp=true
swamp model @sntxrr/scaleway-load-balancer method run list web-lb
swamp model @sntxrr/scaleway-load-balancer method run list-backends web-lb
swamp model @sntxrr/scaleway-load-balancer method run list-frontends web-lb
```

`sync`, `list`, `list-backends`, and `list-frontends` are read-only. Scaleway LB
provisioning is asynchronous — `create` returns a transient status (`pending`,
`migrating`); poll `sync` to observe the settled `ready` state.

## Global arguments

| Arg         | Required    | Default                    | Description                                                                                               |
| ----------- | ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `secretKey` | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                    |
| `projectId` | yes         | —                          | Project ID that owns the Load Balancer                                                                    |
| `zone`      | no          | `fr-par-1`                 | Availability zone (`fr-par-1`, `nl-ams-1`, `pl-waw-1`…)                                                   |
| `lbId`      | conditional | —                          | ID of the Load Balancer this model manages. Required by every method except `create`, which provisions it |
| `endpoint`  | no          | `https://api.scaleway.com` | Override the API host                                                                                     |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_load_balancer.ts
$DENO test  scaleway_load_balancer_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
