# @sntxrr/scaleway-inventory

A repeatable, **model-scope** swamp report that consolidates every resource
snapshot written by the installed `@sntxrr/scaleway-*` models into a single
cross-service inventory. It does **not** target one model type — it discovers
whatever Scaleway data exists in the repository and aggregates it.

## What it reports

- **Total resource count** and the number of distinct services and locations.
- **Per service** — resource count, the zones/regions each service spans, and a
  status breakdown (e.g. `running: 3, stopped: 1`).
- **Per region/zone** — resource counts across `fr-par*`, `nl-ams*`, `pl-waw*`,
  and `global`.
- **Per status** — a fleet-wide status roll-up.
- **Per resource** — a flat listing of every resource's id, name, status, and
  location.

## How discovery works

The report reads `context.dataRepository.findAllGlobal()` to enumerate every
stored data record across all model instances, then:

1. Keeps only records whose model type is a `scaleway-<service>` type
   (collective-agnostic — `@sntxrr/scaleway-rdb` → `rdb`).
2. Skips this report's own persisted `report-*` artifacts.
3. Keeps only the latest version of each record.
4. Normalizes each snapshot to a common shape, collapsing the `status`/`state`
   and `zone`/`region` field variants that different Scaleway services use.

Because it runs at model scope, it reports on the **whole fleet** regardless of
which Scaleway model it was attached to.

## Output

Every report produces both:

- **markdown** — human-readable summary tables.
- **json** — `{ totalResources, serviceCount, locationCount, byService,
  byLocation, byStatus, resources }` for machine consumption.

## Usage

Attach the report to any Scaleway model run, then fetch it:

```bash
# Populate data first (any @sntxrr/scaleway-* model sync/list).
swamp model run scaleway-instance list

# Fetch the consolidated inventory.
swamp report get @sntxrr/scaleway-inventory --model scaleway-instance
```

The report is model-scope, so `--model` names the instance the report ran
against; the inventory itself always spans every Scaleway resource in the repo.

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check extensions/reports/scaleway_inventory.ts
$DENO test  extensions/reports/scaleway_inventory_test.ts
swamp extension fmt     extensions/reports/manifest.yaml --check
swamp extension quality extensions/reports/manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
