/**
 * Scaleway Elastic Metal (Bare Metal) integration.
 *
 * Wraps the Scaleway Elastic Metal API (`/baremetal/v1`, zoned) so a swamp model
 * represents a single dedicated bare-metal server, keyed by its server ID.
 * Exposes `sync` (GET), `create` (POST), `delete` (idempotent DELETE), an
 * `action` verb (start/stop/reboot), and a factory `list`, plus a `valid-zone`
 * pre-flight check. Authenticated with the `X-Auth-Token` header (secret key
 * wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/elastic-metal/
 * @module
 */
// extensions/models/scaleway-elastic-metal/scaleway_elastic_metal.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the Elastic Metal server.",
  ),
  zone: z.string().default("fr-par-1").describe(
    "Availability zone, e.g. fr-par-1, nl-ams-1, pl-waw-1.",
  ),
  serverId: z.string().describe(
    "ID of the Elastic Metal server this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for the `action` method (start/stop/reboot lifecycle verbs). */
const ActionArgsSchema = z.object({
  action: z.enum(["start", "stop", "reboot"]).describe(
    "Elastic Metal server lifecycle verb.",
  ),
  bootType: z.enum(["normal", "rescue"]).optional().describe(
    "Boot type for start/reboot (normal or rescue). Ignored by stop.",
  ),
});

/** Arguments for the `create` method (provision a new bare-metal server). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name for the new Elastic Metal server."),
  offerId: z.string().describe(
    "ID of the commercial offer (server type) to provision.",
  ),
  description: z.string().optional().describe(
    "Optional human-readable description.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Optional tags to attach to the server.",
  ),
});

/** Normalised snapshot of an Elastic Metal server. */
const ServerSchema = z.object({
  id: z.string().describe("Scaleway server ID."),
  name: z.string().nullable().optional().describe("Server name."),
  status: z.string().describe(
    "Lifecycle status (delivering, ready, starting, stopped, error, ...).",
  ),
  zone: z.string().describe("Availability zone the server lives in."),
  description: z.string().nullable().optional().describe(
    "Human-readable description.",
  ),
  offerId: z.string().nullable().optional().describe(
    "Commercial offer (server type) ID.",
  ),
  publicIp: z.string().nullable().optional().describe(
    "Primary IPv4 address, if assigned.",
  ),
  ips: z.array(z.string()).describe("All assigned IP addresses."),
  tags: z.array(z.string()).describe("Tags attached to the server."),
  observedAt: z.string().describe("ISO-8601 timestamp of observation."),
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
 * Normalise a raw Elastic Metal server object into the resource snapshot shape.
 * The Bare Metal API returns the server object directly (unwrapped).
 */
function toServerResource(
  s: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const rawIps = Array.isArray(s.ips) ? s.ips as Record<string, unknown>[] : [];
  const ips = rawIps
    .map((ip) => ip?.address)
    .filter((a): a is string => typeof a === "string");
  const firstV4 = rawIps.find((ip) => ip?.version === "IPv4")?.address as
    | string
    | undefined;
  return {
    id: (s.id as string) ?? g.serverId,
    name: (s.name as string) ?? null,
    status: (s.status as string) ?? "unknown",
    zone: (s.zone as string) ?? g.zone,
    description: (s.description as string) ?? null,
    offerId: (s.offer_id as string) ?? null,
    publicIp: firstV4 ?? ips[0] ?? null,
    ips,
    tags: Array.isArray(s.tags) ? s.tags as string[] : [],
    observedAt,
  };
}

/** Zoned collection path for Elastic Metal servers. */
const serversPath = (g: GlobalArgs): string =>
  `/baremetal/v1/zones/${g.zone}/servers`;

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
/** Scaleway Elastic Metal model — one instance per server, keyed by serverId. */
export const model = {
  type: "@sntxrr/scaleway-elastic-metal",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "server": {
      description: "Snapshot of the Elastic Metal server's state",
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
        logger.info("Syncing Scaleway Elastic Metal server {id}", {
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
        logger.info("Synced Elastic Metal server {id} in {zone}", {
          id: g.serverId,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Provision a new Elastic Metal server (CreateServer).",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Elastic Metal server {name} in {zone}", {
          name: args.name,
          zone: g.zone,
        });
        const server = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          serversPath(g),
          {
            offer_id: args.offerId,
            project_id: g.projectId,
            name: args.name,
            description: args.description ?? "",
            tags: args.tags ?? [],
          },
        );
        const id = (server.id as string) ?? g.serverId;
        const handle = await context.writeResource(
          "server",
          id,
          toServerResource(server, g, new Date().toISOString()),
        );
        logger.info("Created Elastic Metal server {id} in {zone}", {
          id,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    action: {
      description:
        "Issue a lifecycle action (start, stop, reboot) then re-read state.",
      arguments: ActionArgsSchema,
      execute: async (
        args: z.infer<typeof ActionArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Elastic Metal server {id} action {action}", {
          id: g.serverId,
          action: args.action,
        });
        // start/reboot accept an optional boot_type; stop takes an empty body.
        const body = args.action === "stop"
          ? {}
          : (args.bootType ? { boot_type: args.bootType } : {});
        await scalewayFetch(
          g,
          "POST",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}/${args.action}`,
          body,
        );
        const now = new Date().toISOString();
        const server = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
        );
        const handle = await context.writeResource(
          "server",
          g.serverId,
          toServerResource(server, g, now),
        );
        logger.info("Completed action {action} on server {id} in {zone}", {
          action: args.action,
          id: g.serverId,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description:
        "Deprovision the server (DeleteServer). Idempotent: a 404 is treated as already-absent.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Elastic Metal server {id} in {zone}", {
          id: g.serverId,
          zone: g.zone,
        });
        let alreadyGone = false;
        try {
          await scalewayFetch(
            g,
            "DELETE",
            `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          alreadyGone = true;
        }
        const handle = await context.writeResource("server", g.serverId, {
          id: g.serverId,
          name: null,
          status: "deleting",
          zone: g.zone,
          description: null,
          offerId: null,
          publicIp: null,
          ips: [],
          tags: [],
          observedAt: new Date().toISOString(),
        });
        logger.info("Deleted Elastic Metal server {id} (alreadyGone={gone})", {
          id: g.serverId,
          gone: alreadyGone,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Elastic Metal servers in the zone (factory).",
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
        logger.info("Discovered {n} Elastic Metal servers in {zone}", {
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
