# @sntxrr/scaleway-serverless-jobs

A [swamp](https://swamp-club.com) model for a **Scaleway Serverless Jobs job
definition** — one model instance per job definition, keyed by its job
definition ID. Wraps the
[Scaleway Serverless Jobs API](https://www.scaleway.com/en/developers/api/serverless-jobs/)
(`/serverless-jobs/v1alpha2`, regional) using only Deno's built-in `fetch` — no
SDK. Authenticated with the `X-Auth-Token` header (secret key wired from a
vault).

## Methods

| Method   | What it does                                                                        |
| -------- | ----------------------------------------------------------------------------------- |
| `sync`   | Fetch the job definition's current state (`GetJobDefinition`) and store a snapshot   |
| `create` | Provision a new job definition (`CreateJobDefinition`)                               |
| `update` | Mutate mutable fields — image, cpu/memory limits, command, env, schedule (`PATCH`)  |
| `delete` | Deprovision the job definition (`DeleteJobDefinition`); idempotent on 404            |
| `action` | Run the job definition (`StartJobDefinition`), starting one or more job runs         |
| `list`   | Factory discovery — snapshot every job definition in the region (paginated)          |

## Secret handling

The `secretKey` global arg is sensitive and wired from a vault; it is sent only
in the `X-Auth-Token` header and is never logged or written into a snapshot.
Job **environment variables** — both those passed to `create`/`update` and the
contextual ones passed to a `run` (`action`) — are sent to the API to provision
or run the job but are **never** copied into a resource snapshot. Snapshots
store only non-secret configuration and status (name, cpu/memory limits, image,
schedule, run state, exit code).

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register a job definition (wire the key from the vault)
swamp model create @sntxrr/scaleway-serverless-jobs main-job \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'jobDefinitionId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-serverless-jobs method run sync main-job
swamp model @sntxrr/scaleway-serverless-jobs method run create main-job \
  --input name=nightly-batch --input cpuLimit=1000 --input memoryLimit=2048 \
  --input localStorageCapacity=20480 \
  --input imageUri=rg.fr-par.scw.cloud/ns/batch:latest
swamp model @sntxrr/scaleway-serverless-jobs method run update main-job --input memoryLimit=4096
swamp model @sntxrr/scaleway-serverless-jobs method run action main-job --input replicas=2
swamp model @sntxrr/scaleway-serverless-jobs method run delete main-job
swamp model @sntxrr/scaleway-serverless-jobs method run list main-job
```

`sync` and `list` are read-only. Running a job (`action`) starts job runs, which
begin in a transient state (`queued`, `running`); a job run's terminal state
(`succeeded`, `failed`) is captured in its own `job-run` snapshot.

## Global arguments

| Arg               | Required | Default                    | Description                                            |
| ----------------- | -------- | -------------------------- | ------------------------------------------------------ |
| `secretKey`       | yes      | —                          | Scaleway API secret key (sensitive; wire from a vault) |
| `projectId`       | yes      | —                          | Project ID that owns the job definition                |
| `region`          | no       | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                  |
| `jobDefinitionId` | yes      | —                          | ID of the job definition this model manages            |
| `endpoint`        | no       | `https://api.scaleway.com` | Override the API host                                  |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_serverless_jobs.ts
$DENO test  scaleway_serverless_jobs_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
