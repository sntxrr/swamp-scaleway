/**
 * Scaleway Cockpit (Observability) integration.
 *
 * Wraps the Scaleway Cockpit API (`/cockpit/v1`, regional) so a swamp model
 * represents a single observability data source (metrics / logs / traces),
 * keyed by its data source ID. Exposes `sync`, `create`, `delete`, a factory
 * `list`, and a factory `list-tokens`. Authenticated with the `X-Auth-Token`
 * header (secret key wired from a vault).
 *
 * Secret hygiene: a Cockpit token carries a `secret_key` that the API returns
 * only once, at creation. This model never provisions tokens and never writes
 * any token `secret_key` into a snapshot or log — `list-tokens` maps only
 * non-secret token metadata (id, name, scopes, timestamps).
 *
 * API reference: https://www.scaleway.com/en/developers/api/cockpit/regional-api/
 * @module
 */
// extensions/models/scaleway-cockpit/scaleway_cockpit.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Cockpit model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the Cockpit data sources and tokens.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  dataSourceId: z.string().describe(
    "ID of the Cockpit data source this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new Cockpit data source (CreateDataSource). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new data source."),
  type: z.enum(["metrics", "logs", "traces"]).describe(
    "Data source type: metrics, logs, or traces.",
  ),
  retentionDays: z.number().optional().describe(
    "Data retention period in days. Optional; a plan default applies.",
  ),
});

/** Snapshot schema for a Cockpit data source. Never contains secrets. */
const DataSourceSchema = z.object({
  id: z.string().describe("Data source ID."),
  name: z.string().nullable().optional().describe("Data source name."),
  type: z.string().nullable().optional().describe(
    "Data source type: metrics, logs, or traces.",
  ),
  url: z.string().nullable().optional().describe(
    "Ingestion/query URL of the data source. Non-secret.",
  ),
  origin: z.string().nullable().optional().describe(
    "Origin of the data source, e.g. scaleway, external, custom.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the data source.",
  ),
  region: z.string().describe("Region hosting the data source."),
  retentionDays: z.number().nullable().optional().describe(
    "Data retention period in days.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last update timestamp (ISO 8601).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/**
 * Snapshot schema for a Cockpit token. Intentionally has NO `secret_key`
 * field: the token secret is returned only once at creation and must never be
 * persisted into a snapshot.
 */
const TokenSchema = z.object({
  id: z.string().describe("Token ID."),
  name: z.string().nullable().optional().describe("Token name."),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the token.",
  ),
  region: z.string().describe("Region hosting the token."),
  scopes: z.record(z.string(), z.unknown()).nullable().optional().describe(
    "Permission scopes granted to the token (booleans per capability). Non-secret.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last update timestamp (ISO 8601).",
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
 * Map a raw Scaleway Cockpit data source object (snake_case) to the camelCase
 * snapshot shape. Never copies any secret material.
 */
function toDataSourceResource(
  d: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (d.id as string) ?? g.dataSourceId,
    name: (d.name as string) ?? null,
    type: (d.type as string) ?? null,
    url: (d.url as string) ?? null,
    origin: (d.origin as string) ?? null,
    projectId: (d.project_id as string) ?? g.projectId,
    region: (d.region as string) ?? g.region,
    retentionDays: (d.retention_days as number) ?? null,
    createdAt: (d.created_at as string) ?? null,
    updatedAt: (d.updated_at as string) ?? null,
    observedAt,
  };
}

/**
 * Map a raw Scaleway Cockpit token object (snake_case) to the camelCase
 * snapshot shape. Deliberately omits `secret_key`/`token`: the token secret is
 * shown once at creation and must never be persisted (CONVENTIONS.md §2).
 */
function toTokenResource(
  t: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (t.id as string) ?? "unknown",
    name: (t.name as string) ?? null,
    projectId: (t.project_id as string) ?? g.projectId,
    region: (t.region as string) ?? g.region,
    scopes: (t.scopes as Record<string, unknown>) ?? null,
    createdAt: (t.created_at as string) ?? null,
    updatedAt: (t.updated_at as string) ?? null,
    observedAt,
  };
}

const dataSourcesPath = (g: GlobalArgs): string =>
  `/cockpit/v1/regions/${g.region}/data-sources`;

const tokensPath = (g: GlobalArgs): string =>
  `/cockpit/v1/regions/${g.region}/tokens`;

// --- Model -----------------------------------------------------------------
/** Scaleway Cockpit model — one instance per data source, keyed by dataSourceId. */
export const model = {
  type: "@sntxrr/scaleway-cockpit",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "data-source": {
      description: "Snapshot of the Cockpit data source's state",
      schema: DataSourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "token": {
      description:
        "Snapshot of a Cockpit token's non-secret metadata (never the secret key)",
      schema: TokenSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported Cockpit regions.",
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
      description: "Fetch the data source's current state (GetDataSource).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway Cockpit data source {id}", {
          id: g.dataSourceId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${dataSourcesPath(g)}/${encodeURIComponent(g.dataSourceId)}`,
        );
        const handle = await context.writeResource(
          "data-source",
          g.dataSourceId,
          toDataSourceResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway Cockpit data source {id}", {
          id: g.dataSourceId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new Cockpit data source (CreateDataSource) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info(
          "Creating Scaleway Cockpit data source {name} in {region}",
          {
            name: args.name,
            region: g.region,
          },
        );
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          type: args.type,
        };
        if (args.retentionDays !== undefined) {
          body.retention_days = args.retentionDays;
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          dataSourcesPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.dataSourceId;
        const handle = await context.writeResource(
          "data-source",
          newId,
          toDataSourceResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway Cockpit data source {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the Cockpit data source (DeleteDataSource).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway Cockpit data source {id}", {
          id: g.dataSourceId,
        });
        // Idempotent delete: a 404 means the data source is already gone —
        // treat it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${dataSourcesPath(g)}/${encodeURIComponent(g.dataSourceId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toDataSourceResource(
            { id: g.dataSourceId, type: "absent" },
            g,
            observedAt,
          )
          : toDataSourceResource(res ?? { id: g.dataSourceId }, g, observedAt);
        const handle = await context.writeResource(
          "data-source",
          g.dataSourceId,
          snapshot,
        );
        logger.info(
          "Deleted Scaleway Cockpit data source {id} (absent={absent})",
          { id: g.dataSourceId, absent },
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Cockpit data sources in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const dataSources = await scalewayListAll<Record<string, unknown>>(
          g,
          dataSourcesPath(g),
          "data_sources",
        );
        logger.info("Discovered {n} data sources in {region}", {
          n: dataSources.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const d of dataSources) {
          handles.push(
            await context.writeResource(
              "data-source",
              (d.id as string) ?? crypto.randomUUID(),
              toDataSourceResource(d, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-tokens": {
      description:
        "Discover all Cockpit tokens in the region (factory). Snapshots store only non-secret token metadata — never the token secret key.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const tokens = await scalewayListAll<Record<string, unknown>>(
          g,
          tokensPath(g),
          "tokens",
        );
        logger.info("Discovered {n} tokens in {region}", {
          n: tokens.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const t of tokens) {
          handles.push(
            await context.writeResource(
              "token",
              (t.id as string) ?? crypto.randomUUID(),
              toTokenResource(t, g, now),
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
  toDataSourceResource,
  toTokenResource,
  dataSourcesPath,
  tokensPath,
};
