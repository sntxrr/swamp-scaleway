/**
 * Scaleway Instance (compute) integration.
 *
 * Wraps the Scaleway Instance API (`/instance/v1`) so a swamp model represents a
 * single compute server, keyed by its server ID. Exposes `sync`, an `action`
 * verb (poweron/poweroff/reboot/stop_in_place/terminate), and a factory `list`,
 * plus a `valid-zone` pre-flight check. Authenticated with the `X-Auth-Token`
 * header (secret key wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/instance/
 * @module
 */
// extensions/models/scaleway-instance/scaleway_instance.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe("Scaleway Project ID that owns the server."),
  zone: z.string().default("fr-par-1").describe(
    "Availability zone, e.g. fr-par-1, nl-ams-1, pl-waw-1.",
  ),
  serverId: z.string().describe(
    "ID of the Instance server this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ActionArgsSchema = z.object({
  action: z.enum([
    "poweron",
    "poweroff",
    "reboot",
    "stop_in_place",
    "terminate",
  ])
    .describe("Instance server action verb."),
});

const ServerSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  state: z.string(),
  zone: z.string(),
  commercialType: z.string().nullable().optional(),
  publicIp: z.string().nullable().optional(),
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
function toServerResource(
  s: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const addr = s.public_ip as Record<string, unknown> | null | undefined;
  return {
    id: (s.id as string) ?? g.serverId,
    name: (s.name as string) ?? null,
    state: (s.state as string) ?? "unknown",
    zone: (s.zone as string) ?? g.zone,
    commercialType: (s.commercial_type as string) ?? null,
    publicIp: (addr?.address as string) ?? null,
    observedAt,
  };
}

const serversPath = (g: GlobalArgs): string =>
  `/instance/v1/zones/${g.zone}/servers`;

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
/** Scaleway Instance server model — one instance per server, keyed by serverId. */
export const model = {
  type: "@sntxrr/scaleway-instance",
  version: "2026.07.18.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "server": {
      description: "Snapshot of the Instance server's state",
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
        logger.info("Syncing Scaleway server {id}", { id: g.serverId });
        const res = await scalewayFetch<{ server: Record<string, unknown> }>(
          g,
          "GET",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
        );
        const handle = await context.writeResource(
          "server",
          g.serverId,
          toServerResource(res.server, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway server {id} in {zone}", {
          id: g.serverId,
          zone: g.zone,
        });
        return { dataHandles: [handle] };
      },
    },
    action: {
      description:
        "Issue a power action (poweron, poweroff, reboot, stop_in_place, terminate).",
      arguments: ActionArgsSchema,
      execute: async (
        args: z.infer<typeof ActionArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Server {id} action {action}", {
          id: g.serverId,
          action: args.action,
        });
        await scalewayFetch(
          g,
          "POST",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}/action`,
          { action: args.action },
        );
        const now = new Date().toISOString();
        // `terminate` deletes the server: a follow-up GET would 404 (the
        // resource is gone) and surface a false failure. Write a synthetic
        // `terminating` snapshot instead. All other actions re-read state.
        const server = args.action === "terminate"
          ? { id: g.serverId, state: "terminating", zone: g.zone }
          : (await scalewayFetch<{ server: Record<string, unknown> }>(
            g,
            "GET",
            `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
          )).server;
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
    list: {
      description: "Discover all Instance servers in the zone (factory).",
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
        logger.info("Discovered {n} servers in {zone}", {
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
