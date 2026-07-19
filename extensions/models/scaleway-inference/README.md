# @sntxrr/scaleway-inference

A [swamp](https://swamp-club.com) model for a **Scaleway Managed Inference
deployment** — one model instance per deployment, keyed by its deployment ID.
Wraps the
[Scaleway Managed Inference API](https://www.scaleway.com/en/developers/api/managed-inference/)
(`/inference/v1`, regional) using only Deno's built-in `fetch` — no SDK.
Authenticated with the `X-Auth-Token` header (secret key wired from a vault). A
deployment serves a dedicated model behind one or more endpoints.

## Methods

| Method   | What it does                                                                            |
| -------- | --------------------------------------------------------------------------------------- |
| `sync`   | Fetch the deployment's current state (`GetDeployment`) and store a snapshot             |
| `create` | Provision a new deployment (`CreateDeployment`) and snapshot it                         |
| `update` | Mutate mutable fields — name, tags, pool size, model, quantization (`UpdateDeployment`) |
| `delete` | Deprovision the deployment (`DeleteDeployment`)                                         |
| `list`   | Factory discovery — snapshot every deployment in the region (paginated)                 |

## Secret handling

The `secretKey` global argument is sensitive and wired from a vault; it is used
only as the `X-Auth-Token` request header and is never logged or written into a
resource snapshot. Deployments are protected by Scaleway IAM authentication by
default — no per-endpoint API key is returned by, or stored in, this model.
Snapshots store only non-secret data: endpoint **URLs** and **IDs**, status,
model, node type, pool size, and tags.

## Setup

```bash
# Store your Scaleway API secret key in a vault
swamp vault create local_encryption scaleway
swamp vault put scaleway SCW_SECRET_KEY   # paste the secret key of your API key

# Register an inference deployment (wire the key from the vault)
swamp model create @sntxrr/scaleway-inference main-llm \
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}' \
  --global-arg 'projectId=11111111-1111-1111-1111-111111111111' \
  --global-arg 'region=fr-par' \
  --global-arg 'deploymentId=22222222-2222-2222-2222-222222222222'
```

## Usage

```bash
swamp model @sntxrr/scaleway-inference method run sync main-llm
swamp model @sntxrr/scaleway-inference method run create main-llm \
  --input name=main-llm \
  --input modelId=44444444-4444-4444-4444-444444444444 \
  --input nodeType=L4 --input acceptEula=true
swamp model @sntxrr/scaleway-inference method run update main-llm --input name=renamed-llm
swamp model @sntxrr/scaleway-inference method run delete main-llm
swamp model @sntxrr/scaleway-inference method run list main-llm
```

`sync` and `list` are read-only. Scaleway provisioning is asynchronous — a new
deployment returns a transient status (`creating`, `deploying`); poll `sync` to
observe the settled `ready` state.

## Global arguments

| Arg            | Required    | Default                    | Description                                                                                                      |
| -------------- | ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `secretKey`    | yes         | —                          | Scaleway API secret key (sensitive; wire from a vault)                                                           |
| `projectId`    | yes         | —                          | Project ID that owns the deployment                                                                              |
| `region`       | no          | `fr-par`                   | Region (`fr-par`, `nl-ams`, `pl-waw`)                                                                            |
| `deploymentId` | conditional | —                          | ID of the inference deployment this model manages. Required by every method except `create`, which provisions it |
| `endpoint`     | no          | `https://api.scaleway.com` | Override the API host                                                                                            |

## create inputs

| Input               | Required | Description                                                      |
| ------------------- | -------- | ---------------------------------------------------------------- |
| `name`              | yes      | Name of the new deployment                                       |
| `modelId`           | yes      | UUID of the model to deploy (from the Managed Inference catalog) |
| `nodeType`          | yes      | Node type name, e.g. `L4`, `H100` (sent as `node_type_name`)     |
| `acceptEula`        | no       | Accept the model's EULA if it requires one (default `false`)     |
| `minSize`/`maxSize` | no       | Serving pool size (currently must be equal — no autoscaling)     |
| `publicEndpoint`    | no       | Create a public endpoint (default `true`)                        |
| `privateNetworkId`  | no       | Also create a private endpoint on this Private Network           |
| `disableAuth`       | no       | Disable IAM auth on the endpoint(s) (default `false`)            |
| `quantizationBits`  | no       | Quantize each model parameter to this many bits                  |
| `tags`              | no       | Tags to attach to the deployment                                 |

## Development

```bash
DENO=~/.swamp/deno/deno
$DENO check scaleway_inference.ts
$DENO test  scaleway_inference_test.ts
swamp extension quality manifest.yaml --json
```

## License

MIT — see [LICENSE.md](./LICENSE.md).
