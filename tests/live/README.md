# Live lifecycle tests — swamp-scaleway

End-to-end tests that drive the **real** Scaleway API through the swamp model
extensions: for each service the harness runs the full
`create → sync → [update] → delete → verify-idempotent` cycle against a
throwaway sandbox project, then tears everything down (model definitions **and**
real resources), even on failure.

These complement the co-located mocked unit tests (`*_test.ts`, no network) —
they catch things mocks cannot: real request/response shapes, auth wiring,
regional/zonal endpoints, and delete/idempotency semantics.

## Prerequisites

- Two credentials, each a 1Password item with fields `scw_access_key`,
  `scw_secret_key` and `scw_organization_id`, read through `@swamp/1password`
  swamp vaults:
  - **Tier A** — `SW_VAULT` / `SW_ITEM` (default `scaleway` / `Scaleway-swamp`):
    an IAM *application* key with an expiry, whose policy grants the Tier A
    service permission sets (VPC, PrivateNetworks, ContainerRegistry,
    SecretManager, KeyManager, MessagingAndQueuing, Observability,
    ObjectStorage — all `FullAccess`) **on the sandbox project only**.
  - **Tier A-org** — `SW_ORG_VAULT` / `SW_ORG_ITEM` (default `scaleway-org` /
    `Scaleway-org`): a credential with organization rights, for the `iam` and
    `account` lifecycles, which create IAM applications and projects.
    Organization-scope IAM policy management is owner-equivalent, so this is
    kept off the routine key.
  - Put your own vault/item names in `tests/live/config.local.sh` (gitignored).
- The 1Password CLI (`op`) authenticated (desktop-app integration or a service
  account token).
- A sandbox project, referenced by `SW_SANDBOX_PROJECT` in `config.sh`.
  **Never point these tests at a real project.** No vault item supplies a
  project id; the project always comes from `SW_SANDBOX_PROJECT`.

## Run

```bash
tests/live/run.sh A        # Tier A — free / trivial cost (~$0), sandbox-scoped key
tests/live/run.sh A-org    # Tier A-org — iam + account, organization credential
tests/live/run.sh B        # Tier B — cheap hourly billable (see tiers below)
```

Override scope via env: `SW_REGION`, `SW_ZONE`, `SW_SANDBOX_PROJECT`, `SW_PREFIX`,
`SW_VAULT`, `SW_ITEM`, `SW_ORG_VAULT`, `SW_ORG_ITEM`.

## Cost tiers

| Tier | Services | Cost |
| ---- | -------- | ---- |
| **A** | vpc, registry, secret-manager, key-manager, messaging, cockpit, object-storage | ~$0 |
| **A-org** | iam, account (organization credential) | ~$0 |
| **B** | block-storage, file-storage, public-gateway, load-balancer | cents if torn down promptly |
| **C** | redis, rdb, mongodb, kapsule, serverless ×3 | billable; need live catalog IDs (versions / node types / images) |
| **D** | dns, tem, webhosting, ipam | need a delegated domain / private network — partial coverage only |
| **E** | instance | extension has **no `create`** (sync/action/list only) — read-only smoke only |
| **F** | elastic-metal, apple-silicon, inference | **expensive / minimum-billing** — opt-in per service |

## How the id threading works

`create` mints a **new** resource id and snapshots under it, but
`sync`/`update`/`delete` target the model's **global-arg id** (which cannot be
overridden per method run). So the engine (`lib.sh`) creates a factory model
with a placeholder id, captures the created id from the run's `dataProduced`,
then re-keys a *manager* model to that id for the mutating verbs.

## Files

- `config.sh` — sandbox scope + vault references (no secrets); sources `config.local.sh` if present.
- `lib.sh` — the engine (`lifecycle`, model factory/rekey, teardown, summary).
- `run.sh` — per-tier service tables.
- `FINDINGS.md` — issues surfaced by live runs.
