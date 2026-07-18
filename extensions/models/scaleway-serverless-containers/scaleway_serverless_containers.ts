/**
 * Scaleway Serverless Containers integration.
 *
 * Wraps the Scaleway Serverless Containers API (`/containers/v1beta1`, regional)
 * so a swamp model represents a single container, keyed by its container ID.
 * Exposes `sync`, `create`, `update`, `delete`, a redeploy `action`, and two
 * factory discovery methods: `list` (containers) and `list-namespaces`.
 * Authenticated with the `X-Auth-Token` header (secret key wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/serverless-containers/
 * @module
 */
// extensions/models/scaleway-serverless-containers/scaleway_serverless_containers.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Serverless Containers model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the container and namespaces.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  containerId: z.string().describe(
    "ID of the Serverless Container this model manages.",
  ),
  namespaceId: z.string().optional().describe(
    "Namespace ID that owns the container. Required for create; optional list filter.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new container (CreateContainer). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new container."),
  registryImage: z.string().optional().describe(
    "Registry image reference to run, e.g. rg.fr-par.scw.cloud/ns/app:latest.",
  ),
  port: z.number().optional().describe(
    "Port the container listens on. Optional; API default applies.",
  ),
  minScale: z.number().optional().describe(
    "Minimum number of container instances. Optional.",
  ),
  maxScale: z.number().optional().describe(
    "Maximum number of container instances. Optional.",
  ),
  memoryLimit: z.number().optional().describe(
    "Memory limit in MB. Optional; API default applies.",
  ),
  cpuLimit: z.number().optional().describe(
    "CPU limit in mvCPU. Optional; API default applies.",
  ),
  privacy: z.string().optional().describe(
    "Privacy setting: public or private. Optional; API default applies.",
  ),
  environmentVariables: z.record(z.string(), z.string()).optional().describe(
    "Non-secret environment variables to inject into the container.",
  ),
  description: z.string().optional().describe(
    "Human-readable description of the container.",
  ),
});

/** Arguments for mutating a container's mutable fields (UpdateContainer). */
const UpdateArgsSchema = z.object({
  registryImage: z.string().optional().describe(
    "New registry image reference to run.",
  ),
  port: z.number().optional().describe("New listen port."),
  minScale: z.number().optional().describe("New minimum instance count."),
  maxScale: z.number().optional().describe("New maximum instance count."),
  memoryLimit: z.number().optional().describe("New memory limit in MB."),
  cpuLimit: z.number().optional().describe("New CPU limit in mvCPU."),
  privacy: z.string().optional().describe("New privacy setting."),
  environmentVariables: z.record(z.string(), z.string()).optional().describe(
    "Replacement set of non-secret environment variables.",
  ),
  description: z.string().optional().describe("New description."),
});

/** Snapshot schema for a Serverless Container. Never contains secrets. */
const ContainerSchema = z.object({
  id: z.string().describe("Container ID."),
  name: z.string().nullable().optional().describe("Container name."),
  namespaceId: z.string().nullable().optional().describe(
    "ID of the namespace that owns the container.",
  ),
  status: z.string().describe(
    "Container status, e.g. ready, creating, pending, error.",
  ),
  minScale: z.number().nullable().optional().describe(
    "Minimum number of instances.",
  ),
  maxScale: z.number().nullable().optional().describe(
    "Maximum number of instances.",
  ),
  memoryLimit: z.number().nullable().optional().describe(
    "Memory limit in MB.",
  ),
  cpuLimit: z.number().nullable().optional().describe("CPU limit in mvCPU."),
  registryImage: z.string().nullable().optional().describe(
    "Registry image reference the container runs.",
  ),
  port: z.number().nullable().optional().describe(
    "Port the container listens on.",
  ),
  privacy: z.string().nullable().optional().describe(
    "Privacy setting: public or private.",
  ),
  domainName: z.string().nullable().optional().describe(
    "Public domain name of the container endpoint. Non-secret.",
  ),
  errorMessage: z.string().nullable().optional().describe(
    "Last error message, if the container is in an error state.",
  ),
  region: z.string().describe("Region hosting the container."),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/** Snapshot schema for a Serverless Containers namespace. Never contains secrets. */
const NamespaceSchema = z.object({
  id: z.string().describe("Namespace ID."),
  name: z.string().nullable().optional().describe("Namespace name."),
  status: z.string().describe(
    "Namespace status, e.g. ready, creating, pending, error.",
  ),
  projectId: z.string().nullable().optional().describe(
    "ID of the project that owns the namespace.",
  ),
  registryEndpoint: z.string().nullable().optional().describe(
    "Container Registry endpoint associated with the namespace. Non-secret.",
  ),
  registryNamespaceId: z.string().nullable().optional().describe(
    "ID of the associated Container Registry namespace.",
  ),
  description: z.string().nullable().optional().describe(
    "Human-readable description of the namespace.",
  ),
  region: z.string().describe("Region hosting the namespace."),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
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
 * Map a raw Scaleway container object (snake_case) to the camelCase snapshot
 * shape. Copies only non-secret configuration and status fields; environment
 * variables and any credentials are never copied into the snapshot.
 */
function toContainerResource(
  c: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (c.id as string) ?? g.containerId,
    name: (c.name as string) ?? null,
    namespaceId: (c.namespace_id as string) ?? g.namespaceId ?? null,
    status: (c.status as string) ?? "unknown",
    minScale: (c.min_scale as number) ?? null,
    maxScale: (c.max_scale as number) ?? null,
    memoryLimit: (c.memory_limit as number) ?? null,
    cpuLimit: (c.cpu_limit as number) ?? null,
    registryImage: (c.registry_image as string) ?? null,
    port: (c.port as number) ?? null,
    privacy: (c.privacy as string) ?? null,
    domainName: (c.domain_name as string) ?? null,
    errorMessage: (c.error_message as string) ?? null,
    region: (c.region as string) ?? g.region,
    createdAt: (c.created_at as string) ?? null,
    observedAt,
  };
}

/**
 * Map a raw Scaleway namespace object (snake_case) to the camelCase snapshot
 * shape. Copies only non-secret fields; environment/secret variables are never
 * copied into the snapshot.
 */
function toNamespaceResource(
  n: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (n.id as string) ?? "",
    name: (n.name as string) ?? null,
    status: (n.status as string) ?? "unknown",
    projectId: (n.project_id as string) ?? g.projectId,
    registryEndpoint: (n.registry_endpoint as string) ?? null,
    registryNamespaceId: (n.registry_namespace_id as string) ?? null,
    description: (n.description as string) ?? null,
    region: (n.region as string) ?? g.region,
    createdAt: (n.created_at as string) ?? null,
    observedAt,
  };
}

const containersPath = (g: GlobalArgs): string =>
  `/containers/v1beta1/regions/${g.region}/containers`;

const namespacesPath = (g: GlobalArgs): string =>
  `/containers/v1beta1/regions/${g.region}/namespaces`;

// --- Model -----------------------------------------------------------------
/** Scaleway Serverless Containers model — one instance per container, keyed by containerId. */
export const model = {
  type: "@sntxrr/scaleway-serverless-containers",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "container": {
      description: "Snapshot of the Serverless Container's state",
      schema: ContainerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "namespace": {
      description: "Snapshot of a Serverless Containers namespace's state",
      schema: NamespaceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported Serverless Containers regions.",
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
      description: "Fetch the container's current state (GetContainer).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway container {id}", { id: g.containerId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${containersPath(g)}/${encodeURIComponent(g.containerId)}`,
        );
        const handle = await context.writeResource(
          "container",
          g.containerId,
          toContainerResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway container {id}", { id: g.containerId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new container in a namespace (CreateContainer) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        if (g.namespaceId === undefined) {
          throw new Error(
            "namespaceId global arg is required to create a container.",
          );
        }
        logger.info("Creating Scaleway container {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          namespace_id: g.namespaceId,
          name: args.name,
        };
        if (args.registryImage !== undefined) {
          body.registry_image = args.registryImage;
        }
        if (args.port !== undefined) body.port = args.port;
        if (args.minScale !== undefined) body.min_scale = args.minScale;
        if (args.maxScale !== undefined) body.max_scale = args.maxScale;
        if (args.memoryLimit !== undefined) {
          body.memory_limit = args.memoryLimit;
        }
        if (args.cpuLimit !== undefined) body.cpu_limit = args.cpuLimit;
        if (args.privacy !== undefined) body.privacy = args.privacy;
        if (args.environmentVariables !== undefined) {
          body.environment_variables = args.environmentVariables;
        }
        if (args.description !== undefined) body.description = args.description;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          containersPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.containerId;
        const handle = await context.writeResource(
          "container",
          newId,
          toContainerResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway container {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Mutate a container's mutable fields (UpdateContainer).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway container {id}", { id: g.containerId });
        const body: Record<string, unknown> = {};
        if (args.registryImage !== undefined) {
          body.registry_image = args.registryImage;
        }
        if (args.port !== undefined) body.port = args.port;
        if (args.minScale !== undefined) body.min_scale = args.minScale;
        if (args.maxScale !== undefined) body.max_scale = args.maxScale;
        if (args.memoryLimit !== undefined) {
          body.memory_limit = args.memoryLimit;
        }
        if (args.cpuLimit !== undefined) body.cpu_limit = args.cpuLimit;
        if (args.privacy !== undefined) body.privacy = args.privacy;
        if (args.environmentVariables !== undefined) {
          body.environment_variables = args.environmentVariables;
        }
        if (args.description !== undefined) body.description = args.description;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${containersPath(g)}/${encodeURIComponent(g.containerId)}`,
          body,
        );
        const handle = await context.writeResource(
          "container",
          g.containerId,
          toContainerResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway container {id}", { id: g.containerId });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the container (DeleteContainer).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway container {id}", { id: g.containerId });
        // Idempotent delete: a 404 means the container is already gone — treat
        // it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${containersPath(g)}/${encodeURIComponent(g.containerId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toContainerResource(
            { id: g.containerId, status: "absent" },
            g,
            observedAt,
          )
          : toContainerResource(res ?? { id: g.containerId }, g, observedAt);
        const handle = await context.writeResource(
          "container",
          g.containerId,
          snapshot,
        );
        logger.info("Deleted Scaleway container {id} (absent={absent})", {
          id: g.containerId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    action: {
      description:
        "Redeploy the container so configuration changes take effect (RedeployContainer).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Redeploying Scaleway container {id}", {
          id: g.containerId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${containersPath(g)}/${encodeURIComponent(g.containerId)}/redeploy`,
          {},
        );
        const handle = await context.writeResource(
          "container",
          g.containerId,
          toContainerResource(
            res ?? { id: g.containerId },
            g,
            new Date().toISOString(),
          ),
        );
        logger.info("Redeployed Scaleway container {id}", {
          id: g.containerId,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all containers in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        // Optionally scope discovery to a single namespace when provided.
        const path = g.namespaceId !== undefined
          ? `${containersPath(g)}?namespace_id=${
            encodeURIComponent(g.namespaceId)
          }`
          : containersPath(g);
        const containers = await scalewayListAll<Record<string, unknown>>(
          g,
          path,
          "containers",
        );
        logger.info("Discovered {n} containers in {region}", {
          n: containers.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const c of containers) {
          handles.push(
            await context.writeResource(
              "container",
              (c.id as string) ?? crypto.randomUUID(),
              toContainerResource(c, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-namespaces": {
      description:
        "Discover all Serverless Containers namespaces in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const namespaces = await scalewayListAll<Record<string, unknown>>(
          g,
          namespacesPath(g),
          "namespaces",
        );
        logger.info("Discovered {n} namespaces in {region}", {
          n: namespaces.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const n of namespaces) {
          handles.push(
            await context.writeResource(
              "namespace",
              (n.id as string) ?? crypto.randomUUID(),
              toNamespaceResource(n, g, now),
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
  toContainerResource,
  toNamespaceResource,
  containersPath,
  namespacesPath,
};
