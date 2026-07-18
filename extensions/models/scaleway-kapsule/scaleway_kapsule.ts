/**
 * Scaleway Kubernetes Kapsule integration.
 *
 * Wraps the Scaleway Kubernetes API (`/k8s/v1`, regional) so a swamp model
 * represents a single managed Kapsule cluster, keyed by its cluster ID. Exposes
 * `sync` (GET one cluster), `create` (POST), `update` (PATCH), `delete`
 * (DELETE, idempotent), `upgrade` (POST a target version), a factory `list`
 * over every cluster in the region, a factory `list-pools` over one cluster's
 * node pools, and `get-kubeconfig`. Authenticated with the `X-Auth-Token`
 * header (secret key wired from a vault).
 *
 * The cluster kubeconfig contains cluster-admin credentials: its `content` is
 * marked sensitive, is never logged, and its raw bytes are never written into a
 * normal cluster/pool snapshot.
 *
 * API reference: https://www.scaleway.com/en/developers/api/kubernetes/
 * @module
 */
// extensions/models/scaleway-kapsule/scaleway_kapsule.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Kapsule model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the Kapsule cluster.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  clusterId: z.string().describe(
    "ID of the Kapsule cluster this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Specification for a node pool created alongside a new cluster. */
const PoolInputSchema = z.object({
  name: z.string().describe("Name of the node pool."),
  nodeType: z.string().describe(
    "Node type (commercial size) for the pool, e.g. DEV1-M, GP1-XS.",
  ),
  size: z.number().describe("Number of nodes in the pool."),
  autoscaling: z.boolean().optional().describe(
    "Whether to enable autoscaling on the pool.",
  ),
  autohealing: z.boolean().optional().describe(
    "Whether to enable autohealing on the pool.",
  ),
});

/** Arguments for provisioning a new Kapsule cluster (CreateCluster). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new Kapsule cluster."),
  version: z.string().describe(
    "Kubernetes version for the cluster, e.g. 1.30.2.",
  ),
  cni: z.string().default("cilium").describe(
    "Container Network Interface plugin, e.g. cilium, calico, flannel.",
  ),
  type: z.string().optional().describe(
    "Cluster type (offer), e.g. kapsule, kapsule-dedicated-4. Optional.",
  ),
  description: z.string().optional().describe(
    "Optional human-readable description of the cluster.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the new cluster.",
  ),
  pools: z.array(PoolInputSchema).optional().describe(
    "Initial node pools to create with the cluster.",
  ),
});

/** Arguments for mutating a cluster's mutable fields (UpdateCluster). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the cluster."),
  description: z.string().optional().describe(
    "New human-readable description of the cluster.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the cluster.",
  ),
});

/** Arguments for upgrading a cluster to a target version (UpgradeCluster). */
const UpgradeArgsSchema = z.object({
  version: z.string().describe(
    "Target Kubernetes version to upgrade the cluster to, e.g. 1.31.0.",
  ),
  upgradePools: z.boolean().default(false).describe(
    "Whether to also upgrade the cluster's node pools to the target version.",
  ),
});

/** Snapshot schema for a Kapsule cluster. Never contains kubeconfig secrets. */
const ClusterSchema = z.object({
  id: z.string().describe("Cluster ID."),
  name: z.string().nullable().optional().describe("Cluster name."),
  status: z.string().describe(
    "Cluster status, e.g. ready, creating, updating, deleting, error.",
  ),
  version: z.string().nullable().optional().describe(
    "Kubernetes version running on the cluster.",
  ),
  type: z.string().nullable().optional().describe(
    "Cluster type (offer), e.g. kapsule.",
  ),
  cni: z.string().nullable().optional().describe(
    "Container Network Interface plugin in use.",
  ),
  region: z.string().describe("Region hosting the cluster."),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the cluster.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/** Snapshot schema for a Kapsule node pool. */
const PoolSchema = z.object({
  id: z.string().describe("Pool ID."),
  name: z.string().nullable().optional().describe("Pool name."),
  status: z.string().nullable().optional().describe(
    "Pool status, e.g. ready, scaling, upgrading.",
  ),
  version: z.string().nullable().optional().describe(
    "Kubernetes version running on the pool's nodes.",
  ),
  nodeType: z.string().nullable().optional().describe(
    "Node type (commercial size) of the pool.",
  ),
  size: z.number().nullable().optional().describe(
    "Number of nodes in the pool.",
  ),
  autoscaling: z.boolean().nullable().optional().describe(
    "Whether autoscaling is enabled on the pool.",
  ),
  autohealing: z.boolean().nullable().optional().describe(
    "Whether autohealing is enabled on the pool.",
  ),
  clusterId: z.string().describe("ID of the cluster owning this pool."),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/**
 * Snapshot schema for a cluster kubeconfig. The `content` field holds
 * cluster-admin credentials and is marked sensitive: it is never logged and
 * only ever written here (never into a cluster or pool snapshot).
 */
const KubeconfigSchema = z.object({
  clusterId: z.string().describe("ID of the cluster this kubeconfig targets."),
  name: z.string().nullable().optional().describe(
    "Filename reported by the API for the kubeconfig.",
  ),
  type: z.string().nullable().optional().describe(
    "File type identifier reported by the API.",
  ),
  content: z.string().meta({ sensitive: true }).describe(
    "Base64-encoded kubeconfig contents. Sensitive — cluster-admin credentials.",
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
/** Map a raw Scaleway cluster object (snake_case) to the camelCase snapshot. */
function toClusterResource(
  c: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (c.id as string) ?? g.clusterId,
    name: (c.name as string) ?? null,
    status: (c.status as string) ?? "unknown",
    version: (c.version as string) ?? null,
    type: (c.type as string) ?? null,
    cni: (c.cni as string) ?? null,
    region: (c.region as string) ?? g.region,
    tags: (c.tags as string[]) ?? null,
    createdAt: (c.created_at as string) ?? null,
    observedAt,
  };
}

/** Map a raw Scaleway pool object (snake_case) to the camelCase snapshot. */
function toPoolResource(
  p: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (p.id as string) ?? crypto.randomUUID(),
    name: (p.name as string) ?? null,
    status: (p.status as string) ?? null,
    version: (p.version as string) ?? null,
    nodeType: (p.node_type as string) ?? null,
    size: (p.size as number) ?? null,
    autoscaling: (p.autoscaling as boolean) ?? null,
    autohealing: (p.autohealing as boolean) ?? null,
    clusterId: (p.cluster_id as string) ?? g.clusterId,
    observedAt,
  };
}

/**
 * Map a raw Scaleway kubeconfig object to the camelCase snapshot. The base64
 * `content` is carried through verbatim into a sensitive field — never logged.
 */
function toKubeconfigResource(
  k: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    clusterId: g.clusterId,
    name: (k.name as string) ?? null,
    type: (k.type as string) ?? null,
    content: (k.content as string) ?? "",
    observedAt,
  };
}

const clustersPath = (g: GlobalArgs): string =>
  `/k8s/v1/regions/${g.region}/clusters`;

// --- Model -----------------------------------------------------------------
/** Scaleway Kapsule model — one instance per cluster, keyed by clusterId. */
export const model = {
  type: "@sntxrr/scaleway-kapsule",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "cluster": {
      description: "Snapshot of the Kapsule cluster's state",
      schema: ClusterSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "pool": {
      description: "Snapshot of a Kapsule node pool",
      schema: PoolSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "kubeconfig": {
      description:
        "Snapshot of a cluster kubeconfig (sensitive; cluster-admin credentials)",
      schema: KubeconfigSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported Kapsule regions.",
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
      description: "Fetch the Kapsule cluster's current state (GetCluster).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway Kapsule cluster {id}", {
          id: g.clusterId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${clustersPath(g)}/${encodeURIComponent(g.clusterId)}`,
        );
        const handle = await context.writeResource(
          "cluster",
          g.clusterId,
          toClusterResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway Kapsule cluster {id}", {
          id: g.clusterId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new Kapsule cluster (CreateCluster) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway Kapsule cluster {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          version: args.version,
          cni: args.cni,
        };
        if (args.type !== undefined) body.type = args.type;
        if (args.description !== undefined) body.description = args.description;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.pools !== undefined) {
          body.pools = args.pools.map((p) => {
            const pool: Record<string, unknown> = {
              name: p.name,
              node_type: p.nodeType,
              size: p.size,
            };
            if (p.autoscaling !== undefined) pool.autoscaling = p.autoscaling;
            if (p.autohealing !== undefined) pool.autohealing = p.autohealing;
            return pool;
          });
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          clustersPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.clusterId;
        const handle = await context.writeResource(
          "cluster",
          newId,
          toClusterResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway Kapsule cluster {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Mutate a cluster's mutable fields (UpdateCluster).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway Kapsule cluster {id}", {
          id: g.clusterId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.description !== undefined) body.description = args.description;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${clustersPath(g)}/${encodeURIComponent(g.clusterId)}`,
          body,
        );
        const handle = await context.writeResource(
          "cluster",
          g.clusterId,
          toClusterResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway Kapsule cluster {id}", {
          id: g.clusterId,
        });
        return { dataHandles: [handle] };
      },
    },
    upgrade: {
      description:
        "Upgrade the cluster to a target Kubernetes version (UpgradeCluster).",
      arguments: UpgradeArgsSchema,
      execute: async (
        args: z.infer<typeof UpgradeArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Upgrading Scaleway Kapsule cluster {id} to {version}", {
          id: g.clusterId,
          version: args.version,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${clustersPath(g)}/${encodeURIComponent(g.clusterId)}/upgrade`,
          { version: args.version, upgrade_pools: args.upgradePools },
        );
        const handle = await context.writeResource(
          "cluster",
          g.clusterId,
          toClusterResource(res, g, new Date().toISOString()),
        );
        logger.info("Upgraded Scaleway Kapsule cluster {id} to {version}", {
          id: g.clusterId,
          version: args.version,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the Kapsule cluster (DeleteCluster).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway Kapsule cluster {id}", {
          id: g.clusterId,
        });
        // Idempotent delete: a 404 means the cluster is already gone — treat it
        // as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${clustersPath(g)}/${encodeURIComponent(g.clusterId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toClusterResource(
            { id: g.clusterId, status: "absent" },
            g,
            observedAt,
          )
          : toClusterResource(res ?? { id: g.clusterId }, g, observedAt);
        const handle = await context.writeResource(
          "cluster",
          g.clusterId,
          snapshot,
        );
        logger.info("Deleted Scaleway Kapsule cluster {id} (absent={absent})", {
          id: g.clusterId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Kapsule clusters in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const clusters = await scalewayListAll<Record<string, unknown>>(
          g,
          clustersPath(g),
          "clusters",
        );
        logger.info("Discovered {n} clusters in {region}", {
          n: clusters.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const c of clusters) {
          handles.push(
            await context.writeResource(
              "cluster",
              (c.id as string) ?? crypto.randomUUID(),
              toClusterResource(c, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-pools": {
      description:
        "Discover all node pools attached to this cluster (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const pools = await scalewayListAll<Record<string, unknown>>(
          g,
          `${clustersPath(g)}/${encodeURIComponent(g.clusterId)}/pools`,
          "pools",
        );
        logger.info("Discovered {n} pools on cluster {id}", {
          n: pools.length,
          id: g.clusterId,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const p of pools) {
          handles.push(
            await context.writeResource(
              "pool",
              (p.id as string) ?? crypto.randomUUID(),
              toPoolResource(p, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "get-kubeconfig": {
      description:
        "Fetch the cluster's kubeconfig (base64) and store it in a sensitive snapshot.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        // Never log the kubeconfig contents — only the fact of the fetch.
        logger.info("Fetching kubeconfig for Scaleway Kapsule cluster {id}", {
          id: g.clusterId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${clustersPath(g)}/${encodeURIComponent(g.clusterId)}/kubeconfig`,
        );
        const handle = await context.writeResource(
          "kubeconfig",
          g.clusterId,
          toKubeconfigResource(res, g, new Date().toISOString()),
        );
        logger.info("Fetched kubeconfig for Scaleway Kapsule cluster {id}", {
          id: g.clusterId,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Internal helpers exported only for unit testing. */
export const _internal = {
  scalewayFetch,
  scalewayListAll,
  toClusterResource,
  toPoolResource,
  toKubeconfigResource,
  clustersPath,
};
