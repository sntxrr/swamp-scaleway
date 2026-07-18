/**
 * Scaleway Managed Database (RDB) integration.
 *
 * Wraps the Scaleway Managed Database API (`/rdb/v1`, regional) so a swamp model
 * represents a single database instance (PostgreSQL / MySQL), keyed by its
 * instance ID. Exposes `sync`, `create`, `update`, `delete`, and a factory
 * `list`. Authenticated with the `X-Auth-Token` header (secret key wired from a
 * vault). Connection endpoint host/port are stored in snapshots; the default
 * user's password is used only to provision and is never logged or stored.
 *
 * API reference: https://www.scaleway.com/en/developers/api/managed-database-postgre-mysql/
 * @module
 */
// extensions/models/scaleway-rdb/scaleway_rdb.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the RDB model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the database instance.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  instanceId: z.string().describe(
    "ID of the Managed Database instance this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new database instance (CreateInstance). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new database instance."),
  engine: z.string().describe(
    "Database engine version ID, e.g. PostgreSQL-15 or MySQL-8.",
  ),
  nodeType: z.string().describe(
    "Node type (commercial size), e.g. DB-DEV-S.",
  ),
  userName: z.string().describe("Identifier of the default database user."),
  password: z.string().meta({ sensitive: true }).describe(
    "Password for the default user. Sent only to provision; never stored.",
  ),
  isHaCluster: z.boolean().default(false).describe(
    "Whether to provision a High-Availability cluster.",
  ),
  disableBackup: z.boolean().default(false).describe(
    "Whether to disable automated backups on the new instance.",
  ),
  volumeType: z.string().optional().describe(
    "Volume type, e.g. lssd or bssd. Optional; engine default applies.",
  ),
  volumeSize: z.number().optional().describe(
    "Volume size in bytes. Optional; engine default applies.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the new instance.",
  ),
});

/** Arguments for mutating a database instance's mutable fields (UpdateInstance). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the instance."),
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the instance.",
  ),
});

/** Snapshot schema for a Managed Database instance. Never contains secrets. */
const InstanceSchema = z.object({
  id: z.string().describe("Instance ID."),
  name: z.string().nullable().optional().describe("Instance name."),
  status: z.string().describe(
    "Instance status, e.g. ready, provisioning, configuring, error.",
  ),
  engine: z.string().nullable().optional().describe(
    "Database engine and version, e.g. PostgreSQL-15.",
  ),
  nodeType: z.string().nullable().optional().describe(
    "Node type (commercial size).",
  ),
  region: z.string().describe("Region hosting the instance."),
  isHaCluster: z.boolean().nullable().optional().describe(
    "Whether the instance is a High-Availability cluster.",
  ),
  volumeType: z.string().nullable().optional().describe("Volume type."),
  volumeSize: z.number().nullable().optional().describe(
    "Volume size in bytes.",
  ),
  endpointHost: z.string().nullable().optional().describe(
    "Connection host (IP) of the primary endpoint. Non-secret.",
  ),
  endpointPort: z.number().nullable().optional().describe(
    "Connection port of the primary endpoint. Non-secret.",
  ),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the instance.",
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
 * Map a raw Scaleway RDB instance object (snake_case) to the camelCase snapshot
 * shape. Extracts only the primary endpoint's host/port; never copies any
 * password or connection secret.
 */
function toInstanceResource(
  i: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const volume = i.volume as Record<string, unknown> | null | undefined;
  // Prefer the plural "endpoints" list; fall back to a singular "endpoint".
  const endpoints = i.endpoints as Array<Record<string, unknown>> | undefined;
  const primary =
    (endpoints && endpoints.length > 0 ? endpoints[0] : undefined) ??
      (i.endpoint as Record<string, unknown> | null | undefined) ?? undefined;
  return {
    id: (i.id as string) ?? g.instanceId,
    name: (i.name as string) ?? null,
    status: (i.status as string) ?? "unknown",
    engine: (i.engine as string) ?? null,
    nodeType: (i.node_type as string) ?? null,
    region: (i.region as string) ?? g.region,
    isHaCluster: (i.is_ha_cluster as boolean) ?? null,
    volumeType: (volume?.type as string) ?? null,
    volumeSize: (volume?.size as number) ?? null,
    endpointHost: (primary?.ip as string) ?? (primary?.hostname as string) ??
      null,
    endpointPort: (primary?.port as number) ?? null,
    tags: (i.tags as string[]) ?? null,
    createdAt: (i.created_at as string) ?? null,
    observedAt,
  };
}

const instancesPath = (g: GlobalArgs): string =>
  `/rdb/v1/regions/${g.region}/instances`;

// --- Model -----------------------------------------------------------------
/** Scaleway Managed Database model — one instance per database, keyed by instanceId. */
export const model = {
  type: "@sntxrr/scaleway-rdb",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "instance": {
      description: "Snapshot of the Managed Database instance's state",
      schema: InstanceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported RDB regions.",
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
      description: "Fetch the database instance's current state (GetInstance).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway RDB instance {id}", { id: g.instanceId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${instancesPath(g)}/${encodeURIComponent(g.instanceId)}`,
        );
        const handle = await context.writeResource(
          "instance",
          g.instanceId,
          toInstanceResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway RDB instance {id}", { id: g.instanceId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new database instance (CreateInstance) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway RDB instance {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        // Password is sent to provision but is never logged or stored.
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          engine: args.engine,
          node_type: args.nodeType,
          user_name: args.userName,
          password: args.password,
          is_ha_cluster: args.isHaCluster,
          disable_backup: args.disableBackup,
        };
        if (args.volumeType !== undefined) body.volume_type = args.volumeType;
        if (args.volumeSize !== undefined) body.volume_size = args.volumeSize;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          instancesPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.instanceId;
        const handle = await context.writeResource(
          "instance",
          newId,
          toInstanceResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway RDB instance {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a database instance's mutable fields (UpdateInstance).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway RDB instance {id}", {
          id: g.instanceId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${instancesPath(g)}/${encodeURIComponent(g.instanceId)}`,
          body,
        );
        const handle = await context.writeResource(
          "instance",
          g.instanceId,
          toInstanceResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway RDB instance {id}", { id: g.instanceId });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the database instance (DeleteInstance).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway RDB instance {id}", {
          id: g.instanceId,
        });
        // Idempotent delete: a 404 means the instance is already gone — treat
        // it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${instancesPath(g)}/${encodeURIComponent(g.instanceId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toInstanceResource(
            { id: g.instanceId, status: "absent" },
            g,
            observedAt,
          )
          : toInstanceResource(res ?? { id: g.instanceId }, g, observedAt);
        const handle = await context.writeResource(
          "instance",
          g.instanceId,
          snapshot,
        );
        logger.info("Deleted Scaleway RDB instance {id} (absent={absent})", {
          id: g.instanceId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all database instances in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const instances = await scalewayListAll<Record<string, unknown>>(
          g,
          instancesPath(g),
          "instances",
        );
        logger.info("Discovered {n} instances in {region}", {
          n: instances.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const i of instances) {
          handles.push(
            await context.writeResource(
              "instance",
              (i.id as string) ?? crypto.randomUUID(),
              toInstanceResource(i, g, now),
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
  toInstanceResource,
  instancesPath,
};
