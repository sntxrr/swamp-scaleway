/**
 * Scaleway Container Registry integration.
 *
 * Wraps the Scaleway Container Registry API (`/registry/v1`, regional) so a
 * swamp model represents a single registry namespace, keyed by its namespace ID.
 * Exposes `sync`, `create`, `update`, `delete`, and a factory `list`.
 * Authenticated with the `X-Auth-Token` header (secret key wired from a vault).
 *
 * A namespace is a collection of container images sharing a unique identifier;
 * snapshots record the pull/push endpoint, visibility, size, and image count.
 * No secret is ever written into a snapshot or log.
 *
 * API reference: https://www.scaleway.com/en/developers/api/registry/
 * @module
 */
// extensions/models/scaleway-registry/scaleway_registry.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Container Registry model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the registry namespace.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  namespaceId: z.string().describe(
    "ID of the Container Registry namespace this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new registry namespace (CreateNamespace). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new registry namespace."),
  description: z.string().optional().describe(
    "Human-readable description of the namespace.",
  ),
  isPublic: z.boolean().default(false).describe(
    "Whether images in the namespace are publicly pullable without auth.",
  ),
});

/** Arguments for mutating a namespace's mutable fields (UpdateNamespace). */
const UpdateArgsSchema = z.object({
  description: z.string().optional().describe(
    "New description for the namespace.",
  ),
  isPublic: z.boolean().optional().describe(
    "New public/private visibility for the namespace.",
  ),
});

/** Snapshot schema for a Container Registry namespace. Never contains secrets. */
const NamespaceSchema = z.object({
  id: z.string().describe("Namespace ID."),
  name: z.string().nullable().optional().describe("Namespace name."),
  status: z.string().describe(
    "Namespace status, e.g. ready, deleting, error, unknown.",
  ),
  statusMessage: z.string().nullable().optional().describe(
    "Human-readable detail accompanying the status.",
  ),
  description: z.string().nullable().optional().describe(
    "Human-readable description of the namespace.",
  ),
  endpoint: z.string().nullable().optional().describe(
    "Registry pull/push endpoint host. Non-secret.",
  ),
  isPublic: z.boolean().nullable().optional().describe(
    "Whether images are publicly pullable without authentication.",
  ),
  size: z.number().nullable().optional().describe(
    "Total size of the namespace in bytes.",
  ),
  imageCount: z.number().nullable().optional().describe(
    "Number of container images in the namespace.",
  ),
  region: z.string().describe("Region hosting the namespace."),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the namespace.",
  ),
  organizationId: z.string().nullable().optional().describe(
    "Organization ID that owns the namespace.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last-update timestamp (ISO 8601).",
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
 * Map a raw Scaleway Container Registry namespace object (snake_case) to the
 * camelCase snapshot shape. Copies only non-secret metadata.
 */
function toNamespaceResource(
  n: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (n.id as string) ?? g.namespaceId,
    name: (n.name as string) ?? null,
    status: (n.status as string) ?? "unknown",
    statusMessage: (n.status_message as string) ?? null,
    description: (n.description as string) ?? null,
    endpoint: (n.endpoint as string) ?? null,
    isPublic: (n.is_public as boolean) ?? null,
    size: (n.size as number) ?? null,
    imageCount: (n.image_count as number) ?? null,
    region: (n.region as string) ?? g.region,
    projectId: (n.project_id as string) ?? null,
    organizationId: (n.organization_id as string) ?? null,
    createdAt: (n.created_at as string) ?? null,
    updatedAt: (n.updated_at as string) ?? null,
    observedAt,
  };
}

const namespacesPath = (g: GlobalArgs): string =>
  `/registry/v1/regions/${g.region}/namespaces`;

// --- Model -----------------------------------------------------------------
/** Scaleway Container Registry model — one instance per namespace, keyed by namespaceId. */
export const model = {
  type: "@sntxrr/scaleway-registry",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "namespace": {
      description: "Snapshot of the Container Registry namespace's state",
      schema: NamespaceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported Container Registry regions.",
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
      description: "Fetch the namespace's current state (GetNamespace).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway registry namespace {id}", {
          id: g.namespaceId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${namespacesPath(g)}/${encodeURIComponent(g.namespaceId)}`,
        );
        const handle = await context.writeResource(
          "namespace",
          g.namespaceId,
          toNamespaceResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway registry namespace {id}", {
          id: g.namespaceId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new registry namespace (CreateNamespace) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway registry namespace {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          is_public: args.isPublic,
        };
        if (args.description !== undefined) body.description = args.description;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          namespacesPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.namespaceId;
        const handle = await context.writeResource(
          "namespace",
          newId,
          toNamespaceResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway registry namespace {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a namespace's mutable fields — description, visibility (UpdateNamespace).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway registry namespace {id}", {
          id: g.namespaceId,
        });
        const body: Record<string, unknown> = {};
        if (args.description !== undefined) body.description = args.description;
        if (args.isPublic !== undefined) body.is_public = args.isPublic;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${namespacesPath(g)}/${encodeURIComponent(g.namespaceId)}`,
          body,
        );
        const handle = await context.writeResource(
          "namespace",
          g.namespaceId,
          toNamespaceResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway registry namespace {id}", {
          id: g.namespaceId,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the registry namespace (DeleteNamespace).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway registry namespace {id}", {
          id: g.namespaceId,
        });
        // Idempotent delete: a 404 means the namespace is already gone — treat
        // it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${namespacesPath(g)}/${encodeURIComponent(g.namespaceId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toNamespaceResource(
            { id: g.namespaceId, status: "absent" },
            g,
            observedAt,
          )
          : toNamespaceResource(res ?? { id: g.namespaceId }, g, observedAt);
        const handle = await context.writeResource(
          "namespace",
          g.namespaceId,
          snapshot,
        );
        logger.info(
          "Deleted Scaleway registry namespace {id} (absent={absent})",
          {
            id: g.namespaceId,
            absent,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all registry namespaces in the region (factory).",
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
  toNamespaceResource,
  namespacesPath,
};
