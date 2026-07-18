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

- The `scaleway` swamp vault (backend `@swamp/1password`, item `Scaleway-swamp`
  in the Private 1Password vault) with fields `scw_secret_key`,
  `scw_organization_id`, `scw_project_id`, `scw_access_key`.
- The 1Password CLI (`op`) authenticated (desktop-app integration or a service
  account token).
- A sandbox project — created with `sw-account create` and referenced by
  `SW_SANDBOX_PROJECT` in `config.sh`. **Never point these tests at a real
  project.**

## Run

```bash
tests/live/run.sh A        # Tier A — free / trivial cost (~$0)
tests/live/run.sh B        # Tier B — cheap hourly billable (see tiers below)
```

Override scope via env: `SW_REGION`, `SW_ZONE`, `SW_SANDBOX_PROJECT`, `SW_PREFIX`.

## Cost tiers

| Tier | Services | Cost |
| ---- | -------- | ---- |
| **A** | vpc, registry, secret-manager, key-manager, messaging, iam, cockpit, account, object-storage | ~$0 |
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

- `config.sh` — sandbox scope + vault references (no secrets).
- `lib.sh` — the engine (`lifecycle`, model factory/rekey, teardown, summary).
- `run.sh` — per-tier service tables.
- `FINDINGS.md` — issues surfaced by live runs.
