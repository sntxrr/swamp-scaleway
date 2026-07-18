/**
 * Scaleway Managed Inference integration.
 *
 * Wraps the Scaleway Managed Inference API (`/inference/v1`, regional) so a swamp
 * model represents a single inference deployment (a dedicated model serving
 * endpoint), keyed by its deployment ID. Exposes `sync`, `create`, `update`
 * (PATCH), `delete`, and a factory `list`. Authenticated with the `X-Auth-Token`
 * header (secret key wired from a vault). Endpoint URLs and IDs are non-secret
 * and stored in snapshots; no model/endpoint API key or credential is ever
 * logged or written into a resource snapshot.
 *
 * API reference: https://www.scaleway.com/en/developers/api/managed-inference/
 * @module
 */
// extensions/models/scaleway-inference/scaleway_inference.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Managed Inference model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the inference deployment.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  deploymentId: z.string().describe(
    "ID of the Managed Inference deployment this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new inference deployment (CreateDeployment). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new inference deployment."),
  modelId: z.string().describe(
    "UUID of the model to deploy (see the Managed Inference model catalog).",
  ),
  nodeType: z.string().describe(
    "Name of the node type to use, e.g. L4, H100, H100-2 (sent as node_type_name).",
  ),
  acceptEula: z.boolean().default(false).describe(
    "Accept the model's End User License Agreement (EULA) if it requires one.",
  ),
  minSize: z.number().optional().describe(
    "Minimum size of the serving pool. Optional; API default applies.",
  ),
  maxSize: z.number().optional().describe(
    "Maximum size of the serving pool. Currently must equal minSize (no autoscaling).",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the new deployment.",
  ),
  publicEndpoint: z.boolean().default(true).describe(
    "Create a public endpoint for the deployment.",
  ),
  privateNetworkId: z.string().optional().describe(
    "If set, also create a private endpoint attached to this Private Network ID.",
  ),
  disableAuth: z.boolean().default(false).describe(
    "Disable IAM authentication on the created endpoint(s). Defaults to protected.",
  ),
  quantizationBits: z.number().optional().describe(
    "If set, quantize each model parameter to this many bits.",
  ),
});

/** Arguments for mutating a deployment's mutable fields (UpdateDeployment). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the deployment."),
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the deployment.",
  ),
  minSize: z.number().optional().describe(
    "New minimum size of the serving pool.",
  ),
  maxSize: z.number().optional().describe(
    "New maximum size of the serving pool. Currently must equal minSize.",
  ),
  modelId: z.string().optional().describe(
    "UUID of a new model to set on the deployment.",
  ),
  quantizationBits: z.number().optional().describe(
    "New quantization: number of bits per model parameter.",
  ),
});

/** Snapshot schema for one deployment endpoint. Never contains secrets. */
const EndpointSchema = z.object({
  id: z.string().nullable().optional().describe("Endpoint ID."),
  url: z.string().nullable().optional().describe(
    "Endpoint URL (non-secret). Callers still authenticate via IAM unless disabled.",
  ),
  disableAuth: z.boolean().nullable().optional().describe(
    "Whether IAM authentication is disabled on this endpoint.",
  ),
  privateNetworkId: z.string().nullable().optional().describe(
    "Private Network ID if this is a private endpoint; null for public.",
  ),
});

/** Snapshot schema for a Managed Inference deployment. Never contains secrets. */
const DeploymentSchema = z.object({
  id: z.string().describe("Deployment ID."),
  name: z.string().nullable().optional().describe("Deployment name."),
  status: z.string().describe(
    "Deployment status, e.g. creating, deploying, ready, scaling, error, deleting.",
  ),
  modelId: z.string().nullable().optional().describe(
    "UUID of the deployed model.",
  ),
  modelName: z.string().nullable().optional().describe(
    "Name of the deployed model.",
  ),
  nodeType: z.string().nullable().optional().describe(
    "Node type of the deployment.",
  ),
  region: z.string().describe("Region hosting the deployment."),
  size: z.number().nullable().optional().describe(
    "Current size of the serving pool.",
  ),
  minSize: z.number().nullable().optional().describe(
    "Minimum size of the serving pool.",
  ),
  maxSize: z.number().nullable().optional().describe(
    "Maximum size of the serving pool.",
  ),
  quantizationBits: z.number().nullable().optional().describe(
    "Quantization bits per model parameter, if quantized.",
  ),
  endpoints: z.array(EndpointSchema).nullable().optional().describe(
    "List of the deployment's endpoints (non-secret URLs/IDs).",
  ),
  endpointUrl: z.string().nullable().optional().describe(
    "URL of the first endpoint, for convenience. Non-secret.",
  ),
  errorMessage: z.string().nullable().optional().describe(
    "Error detail if the deployment is in an error state.",
  ),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the deployment.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (RFC 3339).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last modification timestamp (RFC 3339).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

// --- Scaleway HTTP client (canonical — see CONVENTIONS.md §5) ---------------
/** Perform an X-Auth-Token-authenticated Scaleway API call, returning JSON. */
async function scalewayFetch<T>(
  g: { secretKey: string; endpoint?: string },
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const base = (g.endpoint ?? "https://api.scaleway.com").replace(/\/+$/, "");
  const url = `${base}${path}`;
  const maxAttempts = 3;
  for (let attempt = 1;; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        "X-Auth-Token": g.secretKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const transient = res.status === 429 || res.status === 503;
    if (transient && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000)
        : attempt * 200;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    const err = new Error(
      `Scaleway ${method} ${path} failed (${res.status}${
        transient ? ", transient" : ""
      }): ${text}`,
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
}

async function scalewayListAll<T>(
  g: { secretKey: string; endpoint?: string },
  path: string,
  key: string,
  pageSize = 100,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await scalewayFetch<Record<string, unknown>>(
      g,
      "GET",
      `${path}${sep}page=${page}&page_size=${pageSize}`,
    );
    const batch = (res[key] as T[] | undefined) ?? [];
    items.push(...batch);
    if (batch.length === 0) break;
    const totalRaw = res.total_count;
    if (totalRaw !== undefined && totalRaw !== null) {
      // total_count is authoritative when present.
      if (items.length >= Number(totalRaw)) break;
    } else if (batch.length < pageSize) {
      // No total_count: a short page is the last page.
      break;
    }
    page += 1;
  }
  return items;
}

// --- Context types (canonical — see CONVENTIONS.md §6) ----------------------
type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};
type ExecuteContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// --- Mapping ---------------------------------------------------------------
/**
 * Map a raw Scaleway inference deployment object (snake_case) to the camelCase
 * snapshot shape. Copies only non-secret endpoint URLs/IDs; never copies any
 * credential or API key.
 */
function toDeploymentResource(
  d: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const rawEndpoints =
    (d.endpoints as Array<Record<string, unknown>> | undefined) ?? [];
  const endpoints = rawEndpoints.map((e) => {
    const pn = e.private_network as Record<string, unknown> | null | undefined;
    return {
      id: (e.id as string) ?? null,
      url: (e.url as string) ?? null,
      disableAuth: (e.disable_auth as boolean) ?? null,
      privateNetworkId: (pn?.private_network_id as string) ?? null,
    };
  });
  const quant = d.quantization as Record<string, unknown> | null | undefined;
  return {
    id: (d.id as string) ?? g.deploymentId,
    name: (d.name as string) ?? null,
    status: (d.status as string) ?? "unknown",
    modelId: (d.model_id as string) ?? null,
    modelName: (d.model_name as string) ?? null,
    nodeType: (d.node_type_name as string) ?? null,
    region: (d.region as string) ?? g.region,
    size: (d.size as number) ?? null,
    minSize: (d.min_size as number) ?? null,
    maxSize: (d.max_size as number) ?? null,
    quantizationBits: (quant?.bits as number) ?? null,
    endpoints,
    endpointUrl: (endpoints[0]?.url as string | null) ?? null,
    errorMessage: (d.error_message as string) ?? null,
    tags: (d.tags as string[]) ?? null,
    createdAt: (d.created_at as string) ?? null,
    updatedAt: (d.updated_at as string) ?? null,
    observedAt,
  };
}

const deploymentsPath = (g: GlobalArgs): string =>
  `/inference/v1/regions/${g.region}/deployments`;

// --- Model -----------------------------------------------------------------
/** Scaleway Managed Inference model — one instance per deployment, keyed by deploymentId. */
export const model = {
  type: "@sntxrr/scaleway-inference",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "deployment": {
      description: "Snapshot of the Managed Inference deployment's state",
      schema: DeploymentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported regions.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        const allowed = ["fr-par", "nl-ams", "pl-waw"];
        const region = context.globalArgs.region;
        if (!allowed.includes(region)) {
          return {
            pass: false,
            errors: [
              `Region "${region}" is not an allowed Scaleway region: ${
                allowed.join(", ")
              }`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    sync: {
      description: "Fetch the deployment's current state (GetDeployment).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway inference deployment {id}", {
          id: g.deploymentId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${deploymentsPath(g)}/${encodeURIComponent(g.deploymentId)}`,
        );
        const handle = await context.writeResource(
          "deployment",
          g.deploymentId,
          toDeploymentResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway inference deployment {id}", {
          id: g.deploymentId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new inference deployment (CreateDeployment) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info(
          "Creating Scaleway inference deployment {name} in {region}",
          {
            name: args.name,
            region: g.region,
          },
        );
        // Build the required endpoints list from the convenience flags.
        const endpoints: Array<Record<string, unknown>> = [];
        if (args.privateNetworkId !== undefined) {
          endpoints.push({
            private_network: { private_network_id: args.privateNetworkId },
            disable_auth: args.disableAuth,
          });
        }
        if (args.publicEndpoint || endpoints.length === 0) {
          endpoints.push({
            public_network: {},
            disable_auth: args.disableAuth,
          });
        }
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          model_id: args.modelId,
          node_type_name: args.nodeType,
          accept_eula: args.acceptEula,
          endpoints,
        };
        if (args.minSize !== undefined) body.min_size = args.minSize;
        if (args.maxSize !== undefined) body.max_size = args.maxSize;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.quantizationBits !== undefined) {
          body.quantization = { bits: args.quantizationBits };
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          deploymentsPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.deploymentId;
        const handle = await context.writeResource(
          "deployment",
          newId,
          toDeploymentResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway inference deployment {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate an inference deployment's mutable fields (UpdateDeployment).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway inference deployment {id}", {
          id: g.deploymentId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.minSize !== undefined) body.min_size = args.minSize;
        if (args.maxSize !== undefined) body.max_size = args.maxSize;
        if (args.modelId !== undefined) body.model_id = args.modelId;
        if (args.quantizationBits !== undefined) {
          body.quantization = { bits: args.quantizationBits };
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${deploymentsPath(g)}/${encodeURIComponent(g.deploymentId)}`,
          body,
        );
        const handle = await context.writeResource(
          "deployment",
          g.deploymentId,
          toDeploymentResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway inference deployment {id}", {
          id: g.deploymentId,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the inference deployment (DeleteDeployment).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway inference deployment {id}", {
          id: g.deploymentId,
        });
        // Idempotent delete: a 404 means the deployment is already gone — treat
        // it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${deploymentsPath(g)}/${encodeURIComponent(g.deploymentId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toDeploymentResource(
            { id: g.deploymentId, status: "absent" },
            g,
            observedAt,
          )
          : toDeploymentResource(res ?? { id: g.deploymentId }, g, observedAt);
        const handle = await context.writeResource(
          "deployment",
          g.deploymentId,
          snapshot,
        );
        logger.info(
          "Deleted Scaleway inference deployment {id} (absent={absent})",
          { id: g.deploymentId, absent },
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description:
        "Discover all inference deployments in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const deployments = await scalewayListAll<Record<string, unknown>>(
          g,
          deploymentsPath(g),
          "deployments",
        );
        logger.info("Discovered {n} deployments in {region}", {
          n: deployments.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const d of deployments) {
          handles.push(
            await context.writeResource(
              "deployment",
              (d.id as string) ?? crypto.randomUUID(),
              toDeploymentResource(d, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
  },
};

/** Internal helpers exported only for unit testing. */
export const _internal = {
  scalewayFetch,
  scalewayListAll,
  toDeploymentResource,
  deploymentsPath,
};
