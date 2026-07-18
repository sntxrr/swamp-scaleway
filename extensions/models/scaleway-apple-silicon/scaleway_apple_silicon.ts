/**
 * Scaleway Apple silicon (Mac mini) integration.
 *
 * Wraps the Scaleway Apple silicon API (`/apple-silicon/v1alpha1`) so a swamp
 * model represents a single Mac mini server, keyed by its server ID. Exposes
 * `sync`, `create`, `update`, `delete`, an `action` verb (`reboot`), and a
 * factory `list`, plus a `valid-zone` pre-flight check. Authenticated with the
 * `X-Auth-Token` header (secret key wired from a vault).
 *
 * The Apple silicon API is zoned. Availability is currently limited to
 * `fr-par-1` and `fr-par-3`, but the `valid-zone` check validates against the
 * full nine-zone Scaleway zone list to stay consistent across the suite.
 *
 * API reference: https://www.scaleway.com/en/developers/api/apple-silicon/
 * @module
 */
// extensions/models/scaleway-apple-silicon/scaleway_apple_silicon.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the Apple silicon server.",
  ),
  zone: z.string().default("fr-par-1").describe(
    "Availability zone. Apple silicon is limited to fr-par-1 and fr-par-3.",
  ),
  serverId: z.string().describe(
    "ID of the Apple silicon server this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CreateArgsSchema = z.object({
  name: z.string().describe("Name for the new Apple silicon server."),
  type: z.string().describe(
    "Machine commercial type, e.g. M1-M, M2-M, M2-L, M4-S.",
  ),
  osId: z.string().optional().describe(
    "Optional OS image ID to install; omit for the type's default OS.",
  ),
  enableVpc: z.boolean().optional().describe(
    "Optional: attach the server to a Private Network (VPC).",
  ),
});

const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the server."),
  scheduleDeletion: z.boolean().optional().describe(
    "Whether to schedule the server for automatic deletion at end of term.",
  ),
  enableVpc: z.boolean().optional().describe(
    "Toggle Private Network (VPC) attachment.",
  ),
});

const ActionArgsSchema = z.object({
  action: z.enum(["reboot"]).describe("Apple silicon server action verb."),
});

const ServerSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  status: z.string(),
  zone: z.string(),
  ip: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  deletableAt: z.string().nullable().optional(),
  absent: z.boolean().optional(),
  observedAt: z.string(),
});

// --- Scaleway HTTP client (canonical — see CONVENTIONS.md §5) ---------------
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
 * Map a raw Apple silicon Server object to the model's resource snapshot.
 * Credential fields returned by the API (`sudo_password`, `ssh_username`,
 * `vnc_url`) are deliberately omitted so no secret ever lands in a snapshot.
 */
function toServerResource(
  s: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (s.id as string) ?? g.serverId,
    name: (s.name as string) ?? null,
    type: (s.type as string) ?? null,
    status: (s.status as string) ?? "unknown",
    zone: (s.zone as string) ?? g.zone,
    ip: (s.ip as string) ?? null,
    projectId: (s.project_id as string) ?? g.projectId ?? null,
    createdAt: (s.created_at as string) ?? null,
    deletableAt: (s.deletable_at as string) ?? null,
    observedAt,
  };
}

const serversPath = (g: GlobalArgs): string =>
  `/apple-silicon/v1alpha1/zones/${g.zone}/servers`;

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
/** Scaleway Apple silicon model — one instance per Mac mini, keyed by serverId. */
export const model = {
  type: "@sntxrr/scaleway-apple-silicon",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "server": {
      description: "Snapshot of the Apple silicon server's state",
      schema: ServerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description: "Fetch the server's current state (GetServer).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway Apple silicon server {id}", {
          id: g.serverId,
        });
        const server = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
        );
        const handle = await context.writeResource(
          "server",
          g.serverId,
          toServerResource(server, g, new Date().toISOString()),
        );
        logger.info("Synced Apple silicon server {id} in {zone}", {
          id: g.serverId,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Provision a new Apple silicon server (CreateServer).",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Apple silicon server {name} ({type}) in {zone}", {
          name: args.name,
          type: args.type,
          zone: g.zone,
        });
        const body: Record<string, unknown> = {
          name: args.name,
          type: args.type,
          project_id: g.projectId,
        };
        if (args.osId !== undefined) body.os_id = args.osId;
        if (args.enableVpc !== undefined) body.enable_vpc = args.enableVpc;
        const server = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          serversPath(g),
          body,
        );
        const resource = toServerResource(server, g, new Date().toISOString());
        // Key the snapshot under the newly returned real ID, never "latest".
        const handle = await context.writeResource(
          "server",
          (server.id as string) ?? g.serverId,
          resource,
        );
        logger.info("Created Apple silicon server {id} in {zone}", {
          id: resource.id,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Update mutable fields of the server (UpdateServer, PATCH).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Apple silicon server {id}", { id: g.serverId });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.scheduleDeletion !== undefined) {
          body.schedule_deletion = args.scheduleDeletion;
        }
        if (args.enableVpc !== undefined) body.enable_vpc = args.enableVpc;
        const server = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
          body,
        );
        const handle = await context.writeResource(
          "server",
          g.serverId,
          toServerResource(server, g, new Date().toISOString()),
        );
        logger.info("Updated Apple silicon server {id} in {zone}", {
          id: g.serverId,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description:
        "Delete the server (DeleteServer). Idempotent: a 404 is treated as already absent.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Apple silicon server {id}", { id: g.serverId });
        try {
          await scalewayFetch(
            g,
            "DELETE",
            `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
          );
        } catch (e) {
          // Already gone → success (idempotent delete). Re-throw anything else.
          if ((e as { status?: number }).status !== 404) throw e;
          logger.info("Apple silicon server {id} already absent (404)", {
            id: g.serverId,
          });
        }
        const now = new Date().toISOString();
        const resource = {
          ...toServerResource(
            { id: g.serverId, status: "deleted", zone: g.zone },
            g,
            now,
          ),
          absent: true,
        };
        const handle = await context.writeResource(
          "server",
          g.serverId,
          resource,
        );
        logger.info("Deleted Apple silicon server {id} in {zone}", {
          id: g.serverId,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    action: {
      description: "Issue a server action (reboot).",
      arguments: ActionArgsSchema,
      execute: async (
        args: z.infer<typeof ActionArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Apple silicon server {id} action {action}", {
          id: g.serverId,
          action: args.action,
        });
        await scalewayFetch(
          g,
          "POST",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}/${args.action}`,
        );
        // Re-read settled state after the reboot request is accepted.
        const server = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
        );
        const handle = await context.writeResource(
          "server",
          g.serverId,
          toServerResource(server, g, new Date().toISOString()),
        );
        logger.info("Completed action {action} on server {id} in {zone}", {
          action: args.action,
          id: g.serverId,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Apple silicon servers in the zone (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const servers = await scalewayListAll<Record<string, unknown>>(
          g,
          serversPath(g),
          "servers",
        );
        logger.info("Discovered {n} Apple silicon servers in {zone}", {
          n: servers.length,
          zone: g.zone,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const s of servers) {
          handles.push(
            await context.writeResource(
              "server",
              (s.id as string) ?? crypto.randomUUID(),
              toServerResource(s, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
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
};

/** Internal helpers exported only for unit testing. */
export const _internal = {
  scalewayFetch,
  scalewayListAll,
  toServerResource,
  serversPath,
  SCALEWAY_ZONES,
};
