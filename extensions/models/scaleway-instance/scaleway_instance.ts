/**
 * Scaleway Instance (compute) integration.
 *
 * Wraps the Scaleway Instance API (`/instance/v1`) so a swamp model represents a
 * single compute server, keyed by its server ID. Exposes `sync`, `start`,
 * `stop`, `reboot`, and a factory `list`. Authenticated with the `X-Auth-Token`
 * header (secret key wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/instance/
 * @module
 */
// extensions/models/scaleway_instance.ts
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
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Auth-Token": g.secretKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Scaleway ${method} ${path} failed (${res.status}): ${text}`,
    );
  }
  return (text ? JSON.parse(text) : undefined) as T;
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
    const total = Number(res.total_count ?? items.length);
    if (batch.length === 0 || items.length >= total) break;
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

// --- Model -----------------------------------------------------------------
/** Scaleway Instance server model — one instance per server, keyed by serverId. */
export const model = {
  type: "@sntxrr/scaleway-instance",
  version: "2026.07.17.1",
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
          "latest",
          toServerResource(res.server, g, new Date().toISOString()),
        );
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
        const res = await scalewayFetch<{ server: Record<string, unknown> }>(
          g,
          "GET",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
        );
        const handle = await context.writeResource(
          "server",
          "latest",
          toServerResource(res.server, g, new Date().toISOString()),
        );
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
};

/** Internal helpers exported only for unit testing. */
export const _internal = {
  scalewayFetch,
  scalewayListAll,
  toServerResource,
  serversPath,
};
