/**
 * Scaleway File Storage (managed NFS) integration.
 *
 * Wraps the Scaleway File Storage API (`/file/v1alpha1`, regional) so a swamp
 * model represents a single network-attached filesystem, keyed by its
 * filesystem ID. Exposes `sync`, `create`, `update`, `delete`, and a factory
 * `list`. Authenticated with the `X-Auth-Token` header (secret key wired from a
 * vault) — this is the native Scaleway token API, not the S3/SigV4 surface.
 *
 * API reference: https://www.scaleway.com/en/developers/api/file-storage/
 * @module
 */
// extensions/models/scaleway-file-storage/scaleway_file_storage.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the File Storage model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the filesystem.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  filesystemId: z.string().optional().describe(
    "ID of the File Storage filesystem this model manages. Optional — " +
      "`create` provisions a new filesystem and returns its ID; every other " +
      "method requires it.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new filesystem (CreateFileSystem). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new filesystem."),
  size: z.number().describe(
    "Filesystem size in bytes (GB granularity, 10^9). Min 25 GB, max 50 TB.",
  ),
  type: z.string().optional().describe(
    "Filesystem type. Optional; a service default applies when omitted.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the new filesystem.",
  ),
});

/** Arguments for mutating a filesystem's mutable fields (UpdateFileSystem). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the filesystem."),
  size: z.number().optional().describe(
    "New filesystem size in bytes; must be larger than the current size.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the filesystem.",
  ),
});

/** Snapshot schema for a File Storage filesystem. Never contains secrets. */
const FilesystemSchema = z.object({
  id: z.string().describe("Filesystem ID."),
  name: z.string().nullable().optional().describe("Filesystem name."),
  status: z.string().describe(
    "Current status, e.g. available, creating, updating, error, absent.",
  ),
  size: z.number().nullable().optional().describe(
    "Filesystem size in bytes.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the filesystem.",
  ),
  organizationId: z.string().nullable().optional().describe(
    "Organization ID that owns the filesystem.",
  ),
  numberOfAttachments: z.number().nullable().optional().describe(
    "Current number of attachments (mounts) the filesystem has.",
  ),
  filesystemTypeId: z.string().nullable().optional().describe(
    "UUID of the filesystem type.",
  ),
  region: z.string().describe("Region hosting the filesystem."),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the filesystem.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (RFC 3339).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last update timestamp (RFC 3339).",
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
 * Map a raw Scaleway filesystem object (snake_case) to the camelCase snapshot
 * shape. Copies only descriptive, non-secret metadata.
 */
function toFilesystemResource(
  f: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    // Callers always supply an id: API responses carry one, and the delete
    // path passes the guarded filesystemId. The final "" is unreachable
    // defensive padding so the snapshot still satisfies FilesystemSchema's
    // required id.
    id: (f.id as string) ?? g.filesystemId ?? "",
    name: (f.name as string) ?? null,
    status: (f.status as string) ?? "unknown",
    size: (f.size as number) ?? null,
    projectId: (f.project_id as string) ?? null,
    organizationId: (f.organization_id as string) ?? null,
    numberOfAttachments: (f.number_of_attachments as number) ?? null,
    filesystemTypeId: (f.filesystem_type_id as string) ?? null,
    region: (f.region as string) ?? g.region,
    tags: (f.tags as string[]) ?? null,
    createdAt: (f.created_at as string) ?? null,
    updatedAt: (f.updated_at as string) ?? null,
    observedAt,
  };
}

const filesystemsPath = (g: GlobalArgs): string =>
  `/file/v1alpha1/regions/${g.region}/filesystems`;

/**
 * Resolve the managed filesystem ID for methods that act on an *existing*
 * filesystem.
 *
 * `filesystemId` is optional in the global schema because `create` provisions
 * the filesystem and learns its ID from the API — requiring it up front would
 * force callers to pass a throwaway placeholder just to satisfy validation.
 * Methods that read or mutate an existing filesystem call this to fail fast
 * with an actionable message.
 */
function requireFilesystemId(g: GlobalArgs, method: string): string {
  if (!g.filesystemId) {
    throw new Error(
      `The "${method}" method requires globalArgs.filesystemId — the ID of an ` +
        `existing filesystem. Set filesystemId on the model, or run "create" ` +
        `first to provision one.`,
    );
  }
  return g.filesystemId;
}

// --- Model -----------------------------------------------------------------
/** Scaleway File Storage model — one instance per filesystem, keyed by filesystemId. */
export const model = {
  type: "@sntxrr/scaleway-file-storage",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "filesystem": {
      description: "Snapshot of the File Storage filesystem's state",
      schema: FilesystemSchema,
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
      description: "Fetch the filesystem's current state (GetFileSystem).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const filesystemId = requireFilesystemId(g, "sync");
        logger.info("Syncing Scaleway filesystem {id}", {
          id: filesystemId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${filesystemsPath(g)}/${encodeURIComponent(filesystemId)}`,
        );
        const handle = await context.writeResource(
          "filesystem",
          filesystemId,
          toFilesystemResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway filesystem {id}", { id: filesystemId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new filesystem (CreateFileSystem) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway filesystem {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          size: args.size,
        };
        if (args.type !== undefined) body.type = args.type;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          filesystemsPath(g),
          body,
        );
        // CreateFileSystem always returns the new ID; fall back to a preset
        // filesystemId only if the caller pinned one, so create never depends
        // on it being set.
        const newId = (res.id as string) ?? g.filesystemId ?? "";
        const handle = await context.writeResource(
          "filesystem",
          newId,
          toFilesystemResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway filesystem {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a filesystem's mutable fields — name, size, tags (UpdateFileSystem).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const filesystemId = requireFilesystemId(g, "update");
        logger.info("Updating Scaleway filesystem {id}", {
          id: filesystemId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.size !== undefined) body.size = args.size;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${filesystemsPath(g)}/${encodeURIComponent(filesystemId)}`,
          body,
        );
        const handle = await context.writeResource(
          "filesystem",
          filesystemId,
          toFilesystemResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway filesystem {id}", { id: filesystemId });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the filesystem (DeleteFileSystem).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const filesystemId = requireFilesystemId(g, "delete");
        logger.info("Deleting Scaleway filesystem {id}", {
          id: filesystemId,
        });
        // Idempotent delete: a 404 means the filesystem is already gone — treat
        // it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        // A successful delete returns 204 (no body), so synthesize the state.
        let absent = false;
        try {
          await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${filesystemsPath(g)}/${encodeURIComponent(filesystemId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = toFilesystemResource(
          { id: filesystemId, status: absent ? "absent" : "deleting" },
          g,
          observedAt,
        );
        const handle = await context.writeResource(
          "filesystem",
          filesystemId,
          snapshot,
        );
        logger.info("Deleted Scaleway filesystem {id} (absent={absent})", {
          id: filesystemId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all filesystems in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const filesystems = await scalewayListAll<Record<string, unknown>>(
          g,
          filesystemsPath(g),
          "filesystems",
        );
        logger.info("Discovered {n} filesystems in {region}", {
          n: filesystems.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const f of filesystems) {
          handles.push(
            await context.writeResource(
              "filesystem",
              (f.id as string) ?? crypto.randomUUID(),
              toFilesystemResource(f, g, now),
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
  toFilesystemResource,
  filesystemsPath,
};
