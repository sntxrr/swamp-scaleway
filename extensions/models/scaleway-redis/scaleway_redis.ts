/**
 * Scaleway Managed Database for Redis™ integration.
 *
 * Wraps the Scaleway Managed Redis API (`/redis/v1`, zoned) so a swamp model
 * represents a single Redis cluster, keyed by its cluster ID. Exposes `sync`,
 * `create`, `update`, `delete`, and a factory `list`. Authenticated with the
 * `X-Auth-Token` header (secret key wired from a vault). Connection endpoint
 * host/port are stored in snapshots; the default user's password is used only to
 * provision and is never logged or stored.
 *
 * API reference: https://www.scaleway.com/en/developers/api/managed-database-redis
 * @module
 */
// extensions/models/scaleway-redis/scaleway_redis.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Redis model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the Redis cluster.",
  ),
  zone: z.string().default("fr-par-1").describe(
    "Availability zone, e.g. fr-par-1, nl-ams-1, pl-waw-1.",
  ),
  clusterId: z.string().describe(
    "ID of the Managed Redis cluster this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new Redis cluster (CreateCluster). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new Redis cluster."),
  version: z.string().describe(
    "Redis engine version, e.g. 7.0.5.",
  ),
  nodeType: z.string().describe(
    "Node type (commercial size), e.g. RED1-MICRO.",
  ),
  userName: z.string().describe("Identifier of the default Redis user."),
  password: z.string().meta({ sensitive: true }).describe(
    "Password for the default user. Sent only to provision; never stored.",
  ),
  clusterSize: z.number().optional().describe(
    "Number of nodes (1 for standalone; 3-6 for a cluster). Optional.",
  ),
  tlsEnabled: z.boolean().default(false).describe(
    "Whether to generate a TLS certificate for secure connections.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the new cluster.",
  ),
});

/** Arguments for mutating a Redis cluster's mutable fields (UpdateCluster). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the cluster."),
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the cluster.",
  ),
});

/** Snapshot schema for a Managed Redis cluster. Never contains secrets. */
const ClusterSchema = z.object({
  id: z.string().describe("Cluster ID."),
  name: z.string().nullable().optional().describe("Cluster name."),
  status: z.string().describe(
    "Cluster status, e.g. ready, provisioning, configuring, error, deleting.",
  ),
  version: z.string().nullable().optional().describe(
    "Redis engine version, e.g. 7.0.5.",
  ),
  nodeType: z.string().nullable().optional().describe(
    "Node type (commercial size).",
  ),
  zone: z.string().describe("Zone hosting the cluster."),
  clusterSize: z.number().nullable().optional().describe(
    "Number of nodes in the cluster.",
  ),
  tlsEnabled: z.boolean().nullable().optional().describe(
    "Whether TLS is enabled on the cluster.",
  ),
  endpointHost: z.string().nullable().optional().describe(
    "Connection host (IP) of the primary endpoint. Non-secret.",
  ),
  endpointPort: z.number().nullable().optional().describe(
    "Connection port of the primary endpoint. Non-secret.",
  ),
  userName: z.string().nullable().optional().describe(
    "Identifier of the default Redis user. Non-secret.",
  ),
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
 * Map a raw Scaleway Redis cluster object (snake_case) to the camelCase snapshot
 * shape. Extracts only the primary endpoint's host/port; never copies any
 * password or connection secret. Every stored field is on this explicit
 * whitelist, so a hostile or verbose API echoing a `password` cannot leak into a
 * snapshot.
 */
function toClusterResource(
  c: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const endpoints = c.endpoints as Array<Record<string, unknown>> | undefined;
  const primary = endpoints && endpoints.length > 0 ? endpoints[0] : undefined;
  const ips = primary?.ips as string[] | undefined;
  const endpointHost = (ips && ips.length > 0 ? ips[0] : undefined) ??
    (primary?.ip as string) ?? null;
  return {
    id: (c.id as string) ?? g.clusterId,
    name: (c.name as string) ?? null,
    status: (c.status as string) ?? "unknown",
    version: (c.version as string) ?? null,
    nodeType: (c.node_type as string) ?? null,
    zone: (c.zone as string) ?? g.zone,
    clusterSize: (c.cluster_size as number) ?? null,
    tlsEnabled: (c.tls_enabled as boolean) ?? null,
    endpointHost,
    endpointPort: (primary?.port as number) ?? null,
    userName: (c.user_name as string) ?? null,
    tags: (c.tags as string[]) ?? null,
    createdAt: (c.created_at as string) ?? null,
    observedAt,
  };
}

const clustersPath = (g: GlobalArgs): string =>
  `/redis/v1/zones/${g.zone}/clusters`;

/** The nine Scaleway availability zones (fr-par, nl-ams, pl-waw × 1..3). */
const SCALEWAY_ZONES: readonly string[] = [
  "fr-par-1",
  "fr-par-2",
  "fr-par-3",
  "nl-ams-1",
  "nl-ams-2",
  "nl-ams-3",
  "pl-waw-1",
  "pl-waw-2",
  "pl-waw-3",
];

// --- Model -----------------------------------------------------------------
/** Scaleway Managed Redis model — one instance per cluster, keyed by clusterId. */
export const model = {
  type: "@sntxrr/scaleway-redis",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "cluster": {
      description: "Snapshot of the Managed Redis cluster's state",
      schema: ClusterSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-zone": {
      description:
        "Ensure globalArgs.zone is one of the nine Scaleway availability zones.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        const zone = context.globalArgs.zone;
        if (!SCALEWAY_ZONES.includes(zone)) {
          return {
            pass: false,
            errors: [
              `Zone "${zone}" is not a valid Scaleway zone. Allowed: ${
                SCALEWAY_ZONES.join(", ")
              }.`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    sync: {
      description: "Fetch the Redis cluster's current state (GetCluster).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway Redis cluster {id}", {
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
        logger.info("Synced Scaleway Redis cluster {id}", { id: g.clusterId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new Redis cluster (CreateCluster) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway Redis cluster {name} in {zone}", {
          name: args.name,
          zone: g.zone,
        });
        // Password is sent to provision but is never logged or stored.
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          version: args.version,
          node_type: args.nodeType,
          user_name: args.userName,
          password: args.password,
          tls_enabled: args.tlsEnabled,
        };
        if (args.clusterSize !== undefined) {
          body.cluster_size = args.clusterSize;
        }
        if (args.tags !== undefined) body.tags = args.tags;
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
        logger.info("Created Scaleway Redis cluster {id} in {zone}", {
          id: newId,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Mutate a Redis cluster's mutable fields (UpdateCluster).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway Redis cluster {id}", {
          id: g.clusterId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
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
        logger.info("Updated Scaleway Redis cluster {id}", { id: g.clusterId });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the Redis cluster (DeleteCluster).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway Redis cluster {id}", {
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
        logger.info("Deleted Scaleway Redis cluster {id} (absent={absent})", {
          id: g.clusterId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Redis clusters in the zone (factory).",
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
        logger.info("Discovered {n} clusters in {zone}", {
          n: clusters.length,
          zone: g.zone,
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
  },
};

/** Internal helpers exported only for unit testing. */
export const _internal = {
  scalewayFetch,
  scalewayListAll,
  toClusterResource,
  clustersPath,
  SCALEWAY_ZONES,
};
