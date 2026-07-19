/**
 * Scaleway Public Gateway (network) integration.
 *
 * Wraps the Scaleway Public Gateway API (`/vpc-gw/v2`, zoned) so a swamp model
 * represents a single Public Gateway, keyed by its gateway ID. Exposes `sync`
 * (GET one gateway), `create` (POST), `update` (PATCH), `delete` (DELETE), and a
 * factory `list` over every gateway in the zone. Authenticated with the
 * `X-Auth-Token` header (secret key wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/public-gateways/
 * @module
 */
// extensions/models/scaleway-public-gateway/scaleway_public_gateway.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the Public Gateway.",
  ),
  zone: z.string().default("fr-par-1").describe(
    "Availability zone, e.g. fr-par-1, it-mil-1, nl-ams-1, pl-waw-1.",
  ),
  gatewayId: z.string().optional().describe(
    "ID of the Public Gateway this model manages. Optional — `create` " +
      "provisions a new gateway and returns its ID; every other method " +
      "requires it.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `create` (CreateGateway). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name to assign to the new Public Gateway."),
  type: z.string().default("VPC-GW-S").describe(
    "Commercial offer type, e.g. VPC-GW-S, VPC-GW-M, VPC-GW-L.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Optional list of tags to attach to the Public Gateway.",
  ),
  ipId: z.string().optional().describe(
    "Optional existing flexible IP address ID to attach to the gateway.",
  ),
  enableBastion: z.boolean().optional().describe(
    "Whether to enable the SSH bastion on the gateway.",
  ),
  enableSmtp: z.boolean().optional().describe(
    "Whether to allow SMTP traffic to pass through the gateway.",
  ),
});

/** Arguments for `update` (UpdateGateway). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe(
    "New name for the Public Gateway.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Replacement list of tags to attach to the Public Gateway.",
  ),
  enableBastion: z.boolean().optional().describe(
    "Whether the SSH bastion should be enabled on the gateway.",
  ),
  enableSmtp: z.boolean().optional().describe(
    "Whether SMTP traffic should be allowed to pass through the gateway.",
  ),
});

/** Arguments for `delete` (DeleteGateway). */
const DeleteArgsSchema = z.object({
  deleteIp: z.boolean().default(false).describe(
    "Whether to delete the gateway's flexible IP address on delete " +
      "(the required `delete_ip` query parameter).",
  ),
});

/**
 * The nine Scaleway availability zones accepted by the Public Gateway v2 API.
 * Note: this differs from the generic CONVENTIONS §4 list — the Public Gateway
 * v2 API supports `it-mil-1` (Milan) but not `fr-par-3`.
 */
const SCALEWAY_ZONES = [
  "fr-par-1",
  "fr-par-2",
  "it-mil-1",
  "nl-ams-1",
  "nl-ams-2",
  "nl-ams-3",
  "pl-waw-1",
  "pl-waw-2",
  "pl-waw-3",
] as const;

const GatewaySchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  status: z.string(),
  type: z.string().nullable().optional(),
  zone: z.string(),
  publicIp: z.string().nullable().optional(),
  bandwidth: z.number().nullable().optional(),
  bastionEnabled: z.boolean().nullable().optional(),
  bastionPort: z.number().nullable().optional(),
  smtpEnabled: z.boolean().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  projectId: z.string().nullable().optional(),
  organizationId: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
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
/** Map a Scaleway Gateway object (snake_case) to a camelCase resource snapshot. */
function toGatewayResource(
  gw: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const ipv4 = gw.ipv4 as Record<string, unknown> | null | undefined;
  return {
    // Callers always supply an id: API responses carry one, and the delete
    // path passes the guarded gatewayId. The final "" is unreachable defensive
    // padding so the snapshot still satisfies GatewaySchema's required id.
    id: (gw.id as string) ?? g.gatewayId ?? "",
    name: (gw.name as string) ?? null,
    status: (gw.status as string) ?? "unknown",
    type: (gw.type as string) ?? null,
    zone: (gw.zone as string) ?? g.zone,
    publicIp: (ipv4?.address as string) ?? null,
    bandwidth: (gw.bandwidth as number) ?? null,
    bastionEnabled: (gw.bastion_enabled as boolean) ?? null,
    bastionPort: (gw.bastion_port as number) ?? null,
    smtpEnabled: (gw.smtp_enabled as boolean) ?? null,
    tags: (gw.tags as string[]) ?? null,
    projectId: (gw.project_id as string) ?? g.projectId,
    organizationId: (gw.organization_id as string) ?? null,
    createdAt: (gw.created_at as string) ?? null,
    updatedAt: (gw.updated_at as string) ?? null,
    observedAt,
  };
}

const gatewaysPath = (g: GlobalArgs): string =>
  `/vpc-gw/v2/zones/${g.zone}/gateways`;

/**
 * Resolve the managed gateway ID for methods that act on an *existing* gateway.
 *
 * `gatewayId` is optional in the global schema because `create` provisions the
 * gateway and learns its ID from the API — requiring it up front would force
 * callers to pass a throwaway placeholder just to satisfy validation. Methods
 * that read or mutate an existing gateway call this to fail fast with an
 * actionable message.
 */
function requireGatewayId(g: GlobalArgs, method: string): string {
  if (!g.gatewayId) {
    throw new Error(
      `The "${method}" method requires globalArgs.gatewayId — the ID of an ` +
        `existing Public Gateway. Set gatewayId on the model, or run ` +
        `"create" first to provision one.`,
    );
  }
  return g.gatewayId;
}

// --- Model -----------------------------------------------------------------
/** Scaleway Public Gateway model — one instance per gateway, keyed by gatewayId. */
export const model = {
  type: "@sntxrr/scaleway-public-gateway",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "gateway": {
      description: "Snapshot of the Public Gateway's state",
      schema: GatewaySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description: "Fetch the Public Gateway's current state (GetGateway).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const gatewayId = requireGatewayId(g, "sync");
        logger.info("Syncing Scaleway Public Gateway {id}", {
          id: gatewayId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${gatewaysPath(g)}/${encodeURIComponent(gatewayId)}`,
        );
        const handle = await context.writeResource(
          "gateway",
          gatewayId,
          toGatewayResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway Public Gateway {id}", {
          id: gatewayId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Provision a new Public Gateway (CreateGateway).",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway Public Gateway {name}", {
          name: args.name,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          type: args.type,
        };
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.ipId !== undefined) body.ip_id = args.ipId;
        if (args.enableBastion !== undefined) {
          body.enable_bastion = args.enableBastion;
        }
        if (args.enableSmtp !== undefined) body.enable_smtp = args.enableSmtp;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          gatewaysPath(g),
          body,
        );
        // CreateGateway always returns the new ID; fall back to a preset
        // gatewayId only if the caller pinned one, so create never depends on
        // it being set.
        const newId = (res.id as string) ?? g.gatewayId ?? "";
        const handle = await context.writeResource(
          "gateway",
          newId,
          toGatewayResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway Public Gateway {id}", { id: newId });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Update the Public Gateway's mutable fields (UpdateGateway).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const gatewayId = requireGatewayId(g, "update");
        logger.info("Updating Scaleway Public Gateway {id}", {
          id: gatewayId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.enableBastion !== undefined) {
          body.enable_bastion = args.enableBastion;
        }
        if (args.enableSmtp !== undefined) body.enable_smtp = args.enableSmtp;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${gatewaysPath(g)}/${encodeURIComponent(gatewayId)}`,
          body,
        );
        const handle = await context.writeResource(
          "gateway",
          gatewayId,
          toGatewayResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway Public Gateway {id}", {
          id: gatewayId,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the Public Gateway (DeleteGateway).",
      arguments: DeleteArgsSchema,
      execute: async (
        args: z.infer<typeof DeleteArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const gatewayId = requireGatewayId(g, "delete");
        logger.info("Deleting Scaleway Public Gateway {id}", {
          id: gatewayId,
        });
        try {
          await scalewayFetch(
            g,
            "DELETE",
            `${gatewaysPath(g)}/${
              encodeURIComponent(gatewayId)
            }?delete_ip=${args.deleteIp}`,
          );
        } catch (e) {
          // Idempotent delete: a 404 means the gateway is already gone
          // (CONVENTIONS §3.2). Any other error is fatal.
          if ((e as { status?: number }).status !== 404) throw e;
        }
        const handle = await context.writeResource(
          "gateway",
          gatewayId,
          toGatewayResource(
            { id: gatewayId, status: "absent" },
            g,
            new Date().toISOString(),
          ),
        );
        logger.info("Deleted Scaleway Public Gateway {id}", {
          id: gatewayId,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Public Gateways in the zone (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const gateways = await scalewayListAll<Record<string, unknown>>(
          g,
          gatewaysPath(g),
          "gateways",
        );
        logger.info("Discovered {n} Public Gateways in {zone}", {
          n: gateways.length,
          zone: g.zone,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const gw of gateways) {
          handles.push(
            await context.writeResource(
              "gateway",
              (gw.id as string) ?? crypto.randomUUID(),
              toGatewayResource(gw, g, now),
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
        "Ensure the configured zone is one of the nine Public Gateway zones.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        const zone = context.globalArgs.zone;
        if (!(SCALEWAY_ZONES as readonly string[]).includes(zone)) {
          return {
            pass: false,
            errors: [
              `Zone "${zone}" is not a valid Scaleway Public Gateway zone. ` +
              `Allowed: ${SCALEWAY_ZONES.join(", ")}.`,
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
  toGatewayResource,
  gatewaysPath,
};
