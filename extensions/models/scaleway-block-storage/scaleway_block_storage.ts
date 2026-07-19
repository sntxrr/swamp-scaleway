/**
 * Scaleway Block Storage integration.
 *
 * Wraps the Scaleway Block Storage API (`/block/v1`, zoned) so a swamp model
 * represents a single block volume, keyed by its volume ID. Exposes `sync`,
 * `create`, `update` (resize / rename / re-tag), `delete`, and a factory
 * `list`. Authenticated with the `X-Auth-Token` header (secret key wired from
 * a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/block/
 * @module
 */
// extensions/models/scaleway-block-storage/scaleway_block_storage.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method of this model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the volume.",
  ),
  zone: z.string().default("fr-par-1").describe(
    "Availability zone, e.g. fr-par-1, nl-ams-1, pl-waw-1.",
  ),
  volumeId: z.string().optional().describe(
    "ID of the Block Storage volume this model manages. Optional — `create` " +
      "provisions a new volume and returns its ID; every other method requires it.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `create` — provision a new volume from empty or a snapshot. */
const CreateArgsSchema = z.object({
  name: z.string().describe("Human-readable name for the new volume."),
  size: z.number().int().positive().optional().describe(
    "Volume size in bytes. Required when creating from empty; optional (defaults to the snapshot size) when creating from a snapshot.",
  ),
  perfIops: z.number().int().positive().optional().describe(
    "Requested provisioned IOPS for the volume (e.g. 5000 or 15000).",
  ),
  fromSnapshotId: z.string().optional().describe(
    "If set, create the volume from this snapshot ID instead of from empty.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Optional list of tags to attach to the volume.",
  ),
});

/** Arguments for `update` — mutate a volume's mutable fields (PATCH). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the volume."),
  size: z.number().int().positive().optional().describe(
    "New volume size in bytes (resize; may only grow).",
  ),
  perfIops: z.number().int().positive().optional().describe(
    "New requested provisioned IOPS for the volume.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Replacement list of tags for the volume.",
  ),
});

/** Stored snapshot of a Block Storage volume (camelCase). */
const VolumeSchema = z.object({
  id: z.string().describe("Volume ID."),
  name: z.string().nullable().optional().describe("Volume name."),
  type: z.string().nullable().optional().describe(
    "Volume type / product class.",
  ),
  size: z.number().nullable().optional().describe("Volume size in bytes."),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the volume.",
  ),
  zone: z.string().describe("Availability zone the volume lives in."),
  status: z.string().describe(
    "Lifecycle status, e.g. creating, available, in_use, resizing, deleting, error.",
  ),
  perfIops: z.number().nullable().optional().describe(
    "Provisioned IOPS from the volume specs.",
  ),
  volumeClass: z.string().nullable().optional().describe(
    "Performance class from the volume specs.",
  ),
  parentSnapshotId: z.string().nullable().optional().describe(
    "Snapshot ID the volume was created from, if any.",
  ),
  tags: z.array(z.string()).nullable().optional().describe("Volume tags."),
  createdAt: z.string().nullable().optional().describe(
    "RFC 3339 creation timestamp.",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "RFC 3339 last-update timestamp.",
  ),
  observedAt: z.string().describe(
    "RFC 3339 timestamp when swamp observed this state.",
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
/** Map a raw Scaleway volume (snake_case) to the stored resource (camelCase). */
function toVolumeResource(
  v: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const specs = v.specs as Record<string, unknown> | null | undefined;
  return {
    // Callers always supply an id: API responses carry one, and the delete
    // path passes the guarded volumeId. The final "" is unreachable defensive
    // padding so the snapshot still satisfies VolumeSchema's required id.
    id: (v.id as string) ?? g.volumeId ?? "",
    name: (v.name as string) ?? null,
    type: (v.type as string) ?? null,
    size: (v.size as number) ?? null,
    projectId: (v.project_id as string) ?? g.projectId,
    zone: (v.zone as string) ?? g.zone,
    status: (v.status as string) ?? "unknown",
    perfIops: (specs?.perf_iops as number) ?? null,
    volumeClass: (specs?.class as string) ?? null,
    parentSnapshotId: (v.parent_snapshot_id as string) ?? null,
    tags: (v.tags as string[]) ?? null,
    createdAt: (v.created_at as string) ?? null,
    updatedAt: (v.updated_at as string) ?? null,
    observedAt,
  };
}

/** Build the zoned volumes collection path. */
const volumesPath = (g: GlobalArgs): string =>
  `/block/v1/zones/${g.zone}/volumes`;

/**
 * Resolve the managed volume ID for methods that act on an *existing* volume.
 *
 * `volumeId` is optional in the global schema because `create` provisions the
 * volume and learns its ID from the API — requiring it up front would force
 * callers to pass a throwaway placeholder just to satisfy validation. Methods
 * that read or mutate an existing volume call this to fail fast with an
 * actionable message.
 */
function requireVolumeId(g: GlobalArgs, method: string): string {
  if (!g.volumeId) {
    throw new Error(
      `The "${method}" method requires globalArgs.volumeId — the ID of an ` +
        `existing Block Storage volume. Set volumeId on the model, or run ` +
        `"create" first to provision one.`,
    );
  }
  return g.volumeId;
}

// --- Model -----------------------------------------------------------------
/** Scaleway Block Storage model — one instance per volume, keyed by volumeId. */
export const model = {
  type: "@sntxrr/scaleway-block-storage",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "volume": {
      description: "Snapshot of the Block Storage volume's state",
      schema: VolumeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-zone": {
      description:
        "Ensure the configured zone is one of the nine Scaleway zones.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        const allowed = [
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
        const zone = context.globalArgs.zone;
        if (!allowed.includes(zone)) {
          return {
            pass: false,
            errors: [
              `Zone "${zone}" is not a valid Scaleway zone (allowed: ${
                allowed.join(", ")
              }).`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    sync: {
      description: "Fetch the volume's current state (GetVolume).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const volumeId = requireVolumeId(g, "sync");
        logger.info("Syncing Scaleway volume {id}", { id: volumeId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${volumesPath(g)}/${encodeURIComponent(volumeId)}`,
        );
        const handle = await context.writeResource(
          "volume",
          volumeId,
          toVolumeResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway volume {id} (status {status})", {
          id: volumeId,
          status: (res.status as string) ?? "unknown",
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Provision a new Block Storage volume (CreateVolume).",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway volume {name}", { name: args.name });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
        };
        if (args.perfIops !== undefined) body.perf_iops = args.perfIops;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.fromSnapshotId !== undefined) {
          const fromSnapshot: Record<string, unknown> = {
            snapshot_id: args.fromSnapshotId,
          };
          if (args.size !== undefined) fromSnapshot.size = args.size;
          body.from_snapshot = fromSnapshot;
        } else {
          body.from_empty = { size: args.size };
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          volumesPath(g),
          body,
        );
        // CreateVolume always returns the new ID; fall back to a preset
        // volumeId only if the caller pinned one, so create never depends on it.
        const newId = (res.id as string) ?? g.volumeId ?? "";
        const handle = await context.writeResource(
          "volume",
          newId,
          toVolumeResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway volume {id} ({name})", {
          id: (res.id as string) ?? "unknown",
          name: args.name,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a volume's name, size (resize), IOPS, or tags (UpdateVolume, PATCH).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const volumeId = requireVolumeId(g, "update");
        logger.info("Updating Scaleway volume {id}", { id: volumeId });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.size !== undefined) body.size = args.size;
        if (args.perfIops !== undefined) body.perf_iops = args.perfIops;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${volumesPath(g)}/${encodeURIComponent(volumeId)}`,
          body,
        );
        const handle = await context.writeResource(
          "volume",
          volumeId,
          toVolumeResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway volume {id} (status {status})", {
          id: volumeId,
          status: (res.status as string) ?? "unknown",
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the volume (DeleteVolume).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const volumeId = requireVolumeId(g, "delete");
        logger.info("Deleting Scaleway volume {id}", { id: volumeId });
        let alreadyGone = false;
        try {
          await scalewayFetch(
            g,
            "DELETE",
            `${volumesPath(g)}/${encodeURIComponent(volumeId)}`,
          );
        } catch (e) {
          // 404 => the volume is already gone; treat delete as idempotent.
          if ((e as { status?: number }).status !== 404) throw e;
          alreadyGone = true;
        }
        const handle = await context.writeResource(
          "volume",
          volumeId,
          {
            id: volumeId,
            zone: g.zone,
            status: alreadyGone ? "absent" : "deleting",
            observedAt: new Date().toISOString(),
          },
        );
        logger.info("Deleted Scaleway volume {id} ({state})", {
          id: volumeId,
          state: alreadyGone ? "already absent" : "deleting",
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Block Storage volumes in the zone (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const volumes = await scalewayListAll<Record<string, unknown>>(
          g,
          volumesPath(g),
          "volumes",
        );
        logger.info("Discovered {n} volumes in {zone}", {
          n: volumes.length,
          zone: g.zone,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const v of volumes) {
          handles.push(
            await context.writeResource(
              "volume",
              (v.id as string) ?? crypto.randomUUID(),
              toVolumeResource(v, g, now),
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
  toVolumeResource,
  volumesPath,
};
