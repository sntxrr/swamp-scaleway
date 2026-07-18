/**
 * Scaleway VPC (network) integration.
 *
 * Wraps the Scaleway VPC API (`/vpc/v2`, regional) so a swamp model represents a
 * single Virtual Private Cloud, keyed by its VPC ID. Exposes `sync`, `create`,
 * `delete`, a factory `list` over the region's VPCs, and a factory
 * `list-private-networks` over the region's Private Networks. Authenticated with
 * the `X-Auth-Token` header (secret key wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/vpc/
 * @module
 */
// extensions/models/scaleway_vpc.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe("Scaleway Project ID that owns the VPC."),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  vpcId: z.string().describe("ID of the VPC this model manages."),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CreateArgsSchema = z.object({
  name: z.string().describe("Name for the new VPC."),
  tags: z.array(z.string()).optional().describe(
    "Optional tags to attach to the VPC.",
  ),
  enableRouting: z.boolean().optional().describe(
    "Enable routing between the VPC's Private Networks (default managed by API).",
  ),
});

const VpcSchema = z.object({
  id: z.string().describe("VPC ID (UUID)."),
  name: z.string().nullable().optional().describe("VPC name."),
  organizationId: z.string().nullable().optional().describe(
    "Organization ID that owns the VPC.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the VPC.",
  ),
  region: z.string().describe("Region the VPC lives in."),
  tags: z.array(z.string()).describe("Tags attached to the VPC."),
  isDefault: z.boolean().nullable().optional().describe(
    "Whether this is the Project's default VPC.",
  ),
  privateNetworkCount: z.number().nullable().optional().describe(
    "Number of Private Networks inside the VPC.",
  ),
  routingEnabled: z.boolean().nullable().optional().describe(
    "Whether routing between Private Networks is enabled.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "RFC 3339 creation timestamp.",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "RFC 3339 last-update timestamp.",
  ),
  observedAt: z.string().describe(
    "RFC 3339 timestamp when this snapshot was taken.",
  ),
});

const PrivateNetworkSchema = z.object({
  id: z.string().describe("Private Network ID (UUID)."),
  name: z.string().nullable().optional().describe("Private Network name."),
  vpcId: z.string().nullable().optional().describe(
    "ID of the VPC this Private Network belongs to.",
  ),
  organizationId: z.string().nullable().optional().describe(
    "Organization ID that owns the Private Network.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the Private Network.",
  ),
  region: z.string().describe("Region the Private Network lives in."),
  tags: z.array(z.string()).describe("Tags attached to the Private Network."),
  dhcpEnabled: z.boolean().nullable().optional().describe(
    "Whether DHCP is enabled on the Private Network.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "RFC 3339 creation timestamp.",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "RFC 3339 last-update timestamp.",
  ),
  observedAt: z.string().describe(
    "RFC 3339 timestamp when this snapshot was taken.",
  ),
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
/** Map a raw Scaleway VPC object to the snake_case → camelCase resource shape. */
function toVpcResource(
  v: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (v.id as string) ?? g.vpcId,
    name: (v.name as string) ?? null,
    organizationId: (v.organization_id as string) ?? null,
    projectId: (v.project_id as string) ?? g.projectId,
    region: (v.region as string) ?? g.region,
    tags: (v.tags as string[]) ?? [],
    isDefault: (v.is_default as boolean) ?? null,
    privateNetworkCount: (v.private_network_count as number) ?? null,
    routingEnabled: (v.routing_enabled as boolean) ?? null,
    createdAt: (v.created_at as string) ?? null,
    updatedAt: (v.updated_at as string) ?? null,
    observedAt,
  };
}

/** Map a raw Scaleway Private Network object to the resource shape. */
function toPrivateNetworkResource(
  p: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: p.id as string,
    name: (p.name as string) ?? null,
    vpcId: (p.vpc_id as string) ?? null,
    organizationId: (p.organization_id as string) ?? null,
    projectId: (p.project_id as string) ?? g.projectId,
    region: (p.region as string) ?? g.region,
    tags: (p.tags as string[]) ?? [],
    dhcpEnabled: (p.dhcp_enabled as boolean) ?? null,
    createdAt: (p.created_at as string) ?? null,
    updatedAt: (p.updated_at as string) ?? null,
    observedAt,
  };
}

const vpcsPath = (g: GlobalArgs): string => `/vpc/v2/regions/${g.region}/vpcs`;

const privateNetworksPath = (g: GlobalArgs): string =>
  `/vpc/v2/regions/${g.region}/private-networks`;

// --- Model -----------------------------------------------------------------
/** Scaleway VPC model — one instance per VPC, keyed by vpcId. */
export const model = {
  type: "@sntxrr/scaleway-vpc",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "vpc": {
      description: "Snapshot of the VPC's state",
      schema: VpcSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "private-network": {
      description: "Snapshot of a Private Network in the region",
      schema: PrivateNetworkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description: "Fetch the VPC's current state (GetVPC).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway VPC {id}", { id: g.vpcId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${vpcsPath(g)}/${encodeURIComponent(g.vpcId)}`,
        );
        const handle = await context.writeResource(
          "vpc",
          "latest",
          toVpcResource(res, g, new Date().toISOString()),
        );
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Provision a new VPC (CreateVPC) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway VPC {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          name: args.name,
          project_id: g.projectId,
        };
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.enableRouting !== undefined) {
          body.enable_routing = args.enableRouting;
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          vpcsPath(g),
          body,
        );
        const handle = await context.writeResource(
          "vpc",
          (res.id as string) ?? "latest",
          toVpcResource(res, g, new Date().toISOString()),
        );
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the VPC (DeleteVPC).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway VPC {id}", { id: g.vpcId });
        await scalewayFetch(
          g,
          "DELETE",
          `${vpcsPath(g)}/${encodeURIComponent(g.vpcId)}`,
        );
        return { dataHandles: [] };
      },
    },
    list: {
      description: "Discover all VPCs in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const vpcs = await scalewayListAll<Record<string, unknown>>(
          g,
          vpcsPath(g),
          "vpcs",
        );
        logger.info("Discovered {n} VPCs in {region}", {
          n: vpcs.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const v of vpcs) {
          handles.push(
            await context.writeResource(
              "vpc",
              (v.id as string) ?? crypto.randomUUID(),
              toVpcResource(v, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-private-networks": {
      description: "Discover all Private Networks in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const pns = await scalewayListAll<Record<string, unknown>>(
          g,
          privateNetworksPath(g),
          "private_networks",
        );
        logger.info("Discovered {n} private networks in {region}", {
          n: pns.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const p of pns) {
          handles.push(
            await context.writeResource(
              "private-network",
              (p.id as string) ?? crypto.randomUUID(),
              toPrivateNetworkResource(p, g, now),
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
  toVpcResource,
  toPrivateNetworkResource,
  vpcsPath,
  privateNetworksPath,
};
