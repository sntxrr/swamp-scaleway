/**
 * Scaleway IP Address Management (IPAM) integration.
 *
 * Wraps the Scaleway IPAM API (`/ipam/v1`, regional) so a swamp model represents
 * a single managed IP address, keyed by its IP ID. Exposes `sync`, `create`
 * (book/reserve an IP), `update` (mutate tags/reverses), `delete` (release the
 * IP), and a factory `list`. Authenticated with the `X-Auth-Token` header
 * (secret key wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/ipam/
 * @module
 */
// extensions/models/scaleway-ipam/scaleway_ipam.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the IPAM model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the managed IP address.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  ipId: z.string().describe(
    "ID of the managed IP address this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/**
 * Arguments for booking (reserving) a new IP address (BookIP). `source`
 * identifies where the IP is drawn from — a Private Network subnet
 * (`{ "subnet_id": "..." }`) or a zonal public pool (`{ "zonal": "fr-par-1" }`).
 */
const CreateArgsSchema = z.object({
  source: z.record(z.string(), z.unknown()).describe(
    'Source pool to book from, e.g. {"subnet_id":"..."} or {"zonal":"fr-par-1"}.',
  ),
  isIpv6: z.boolean().default(false).describe(
    "Whether to book an IPv6 address instead of IPv4.",
  ),
  address: z.string().optional().describe(
    "Optional specific address to request (CIDR), e.g. 192.0.2.10/32.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the newly booked IP.",
  ),
});

/** Arguments for mutating a managed IP's mutable fields (UpdateIP). */
const UpdateArgsSchema = z.object({
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the IP.",
  ),
  reverses: z.array(
    z.object({
      hostname: z.string().describe("Reverse DNS hostname."),
      address: z.string().optional().describe(
        "Address the reverse points to (CIDR/IP). Optional.",
      ),
    }),
  ).optional().describe("Replacement set of reverse DNS entries for the IP."),
});

/** Snapshot schema for a managed IP address. Never contains secrets. */
const IpSchema = z.object({
  id: z.string().describe("IP ID."),
  address: z.string().nullable().optional().describe(
    "The IP address in CIDR notation, e.g. 192.0.2.10/32.",
  ),
  isIpv6: z.boolean().nullable().optional().describe(
    "Whether this is an IPv6 address.",
  ),
  region: z.string().describe("Region hosting the IP."),
  zone: z.string().nullable().optional().describe(
    "Availability zone, when the IP is zonal.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the IP.",
  ),
  resourceType: z.string().nullable().optional().describe(
    "Type of the resource the IP is attached to, if any.",
  ),
  resourceId: z.string().nullable().optional().describe(
    "ID of the resource the IP is attached to, if any.",
  ),
  reverses: z.array(z.record(z.string(), z.unknown())).nullable().optional()
    .describe("Reverse DNS entries associated with the IP."),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the IP.",
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
 * Map a raw Scaleway IPAM IP object (snake_case) to the camelCase snapshot
 * shape. Flattens the nested `resource` descriptor into resourceType/resourceId.
 */
function toIpResource(
  i: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const resource = i.resource as Record<string, unknown> | null | undefined;
  return {
    id: (i.id as string) ?? g.ipId,
    address: (i.address as string) ?? null,
    isIpv6: (i.is_ipv6 as boolean) ?? null,
    region: (i.region as string) ?? g.region,
    zone: (i.zone as string) ?? null,
    projectId: (i.project_id as string) ?? null,
    resourceType: (resource?.type as string) ?? null,
    resourceId: (resource?.id as string) ?? null,
    reverses: (i.reverses as Array<Record<string, unknown>>) ?? null,
    tags: (i.tags as string[]) ?? null,
    createdAt: (i.created_at as string) ?? null,
    updatedAt: (i.updated_at as string) ?? null,
    observedAt,
  };
}

const ipsPath = (g: GlobalArgs): string => `/ipam/v1/regions/${g.region}/ips`;

// --- Model -----------------------------------------------------------------
/** Scaleway IPAM model — one instance per managed IP address, keyed by ipId. */
export const model = {
  type: "@sntxrr/scaleway-ipam",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "ip": {
      description: "Snapshot of the managed IP address's state",
      schema: IpSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported IPAM regions.",
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
      description: "Fetch the managed IP's current state (GetIP).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway IPAM IP {id}", { id: g.ipId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${ipsPath(g)}/${encodeURIComponent(g.ipId)}`,
        );
        const handle = await context.writeResource(
          "ip",
          g.ipId,
          toIpResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway IPAM IP {id}", { id: g.ipId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Book (reserve) a new IP address (BookIP) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Booking Scaleway IPAM IP in {region}", {
          region: g.region,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          source: args.source,
          is_ipv6: args.isIpv6,
        };
        if (args.address !== undefined) body.address = args.address;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          ipsPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.ipId;
        const handle = await context.writeResource(
          "ip",
          newId,
          toIpResource(res, g, new Date().toISOString()),
        );
        logger.info("Booked Scaleway IPAM IP {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a managed IP's mutable fields — tags, reverses (UpdateIP).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway IPAM IP {id}", { id: g.ipId });
        const body: Record<string, unknown> = {};
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.reverses !== undefined) body.reverses = args.reverses;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${ipsPath(g)}/${encodeURIComponent(g.ipId)}`,
          body,
        );
        const handle = await context.writeResource(
          "ip",
          g.ipId,
          toIpResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway IPAM IP {id}", { id: g.ipId });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Release the managed IP address (ReleaseIP).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Releasing Scaleway IPAM IP {id}", { id: g.ipId });
        // Idempotent delete: a 404 means the IP is already released — treat it
        // as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${ipsPath(g)}/${encodeURIComponent(g.ipId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? { ...toIpResource({ id: g.ipId }, g, observedAt), status: "absent" }
          : toIpResource(res ?? { id: g.ipId }, g, observedAt);
        const handle = await context.writeResource("ip", g.ipId, snapshot);
        logger.info("Released Scaleway IPAM IP {id} (absent={absent})", {
          id: g.ipId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all managed IPs in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const ips = await scalewayListAll<Record<string, unknown>>(
          g,
          ipsPath(g),
          "ips",
        );
        logger.info("Discovered {n} IPs in {region}", {
          n: ips.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const i of ips) {
          handles.push(
            await context.writeResource(
              "ip",
              (i.id as string) ?? crypto.randomUUID(),
              toIpResource(i, g, now),
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
  toIpResource,
  ipsPath,
};
