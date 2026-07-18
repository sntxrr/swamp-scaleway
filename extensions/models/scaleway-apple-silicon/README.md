# @sntxrr/scaleway-apple-silicon

A [swamp](https://swamp-club.com) model for a **Scaleway Apple silicon (Mac
mini) server** — one model instance per server, keyed by its server ID. Wraps
the
[Scaleway Apple silicon API](https://www.scaleway.com/en/developers/api/apple-silicon/)
(`/apple-silicon/v1alpha1`, zoned) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault).

Apple silicon availability is currently limited to the `fr-par-1` and `fr-par-3`
zones.

## Methods

| Method              | What it does                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `sync`              | Fetch the server's current state (`GetServer`) and store a snapshot                                                  |
| `create`            | Provision a new server (`name`, `type`, optional `osId`/`enableVpc`)                                                 |
| `update`            | Update mutable fields (`name`, `scheduleDeletion`, `enableVpc`) via `PATCH`                                          |
| `delete`            | Delete the server; idempotent — a `404` is treated as already absent                                                 |
| `action`            | Issue a server action (`reboot`), then re-read state                                                                 |
| `list`              | Factory discovery — snapshot every server in the zone (paginated)                                                    |
| `list-server-types` | Discover available server types — names, specs, **stock**, and the minimum lease duration (read-only)                |
| `list-os`           | Discover installable OS images and which server types they support (read-only)                                       |
| `connection-info`   | Capture login details (`ssh_username`, `sudo_password`, `vnc_url`) into the sensitive, vaulted `connection` resource |

The plain `server` snapshot deliberately **excludes** the credential fields the
API returns (`sudo_password`, `ssh_username`, `vnc_url`) so no secret ever lands
in a metadata snapshot. To retrieve them, use `connection-info`: it writes them
to the dedicated `connection` resource, which is marked `sensitiveOutput: true`
so swamp vaults the sensitive fields before persistence (cleartext never on
disk) and never logs them.

> **Billing:** every server type carries a `minimum_lease_duration` of **24
> hours** (`86400s`) — creating and immediately deleting a Mac still bills a
> full day. Check `list-server-types` for current pricing tier / stock before
> provisioning. Apple silicon is available only in **`fr-par-1`** and
> **`fr-par-3`**.

## Trying it out — end-to-end

```bash
# 0. see what's actually available + in stock (read-only, free)
swamp model method run <model> list-server-types
swamp model method run <model> list-os

# 1. provision (⚠️ starts the 24h minimum charge)
swamp model method run <factory-model> create \
  --input name=my-mac --input type=M4-M            # add --input osId=<id> for a specific OS

# 2. re-key a manager model to the returned server id, then log in
swamp model method run <mgr-model> connection-info  # creds land in the vaulted `connection` resource
swamp model method run <mgr-model> action --input action=reboot

# 3. tear down (stops further charges beyond the 24h minimum)
swamp model method run <mgr-model> delete
```

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a server (wire the key from the vault)
swamp model create @sntxrr/scaleway-apple-silicon mac-1 \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'zone=fr-par-1' \
  --global-arg 'serverId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-apple-silicon method run sync mac-1
swamp model @sntxrr/scaleway-apple-silicon method run create mac-1 --input name=mac-new --input type=M2-M
swamp model @sntxrr/scaleway-apple-silicon method run update mac-1 --input name=renamed
swamp model @sntxrr/scaleway-apple-silicon method run action mac-1 --input action=reboot
swamp model @sntxrr/scaleway-apple-silicon method run delete mac-1
swamp model @sntxrr/scaleway-apple-silicon method run list mac-1
```

`sync` and `list` are read-only. Provisioning and reboot are asynchronous — the
server returns a transient status (`starting`, `rebooting`); poll `sync` to
observe the settled state.

## Global arguments

| Arg         | Required | Default                    | Description                                                  |
| ----------- | -------- | -------------------------- | ------------------------------------------------------------ |
| `secretKey` | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault)       |
| `projectId` | yes      | —                          | Project ID that owns the server                              |
| `zone`      | no       | `fr-par-1`                 | Availability zone (`fr-par-1`, `fr-par-3` for Apple silicon) |
| `serverId`  | yes      | —                          | ID of the Apple silicon server this model manages            |
| `endpoint`  | no       | `https://api.scaleway.com` | Override the API host                                        |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_apple_silicon.ts
$DENO test  scaleway_apple_silicon_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
