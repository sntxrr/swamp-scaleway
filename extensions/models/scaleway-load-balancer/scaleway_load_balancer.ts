/**
 * Scaleway Load Balancer (network) integration.
 *
 * Wraps the Scaleway Load Balancer API (`/lb/v1`, zoned) so a swamp model
 * represents a single Load Balancer, keyed by its LB ID. Exposes `sync` (GET
 * one LB), `create` (POST), `delete` (DELETE), a factory `list` over every LB
 * in the zone, and factory `list-backends` / `list-frontends` over one LB's
 * sub-resources. Authenticated with the `X-Auth-Token` header (secret key wired
 * from a vault).
 *
 * The regional Load Balancer API is deprecated — this model uses the zoned API.
 *
 * API reference: https://www.scaleway.com/en/developers/api/load-balancer/zoned-api/
 * @module
 */
// extensions/models/scaleway-load-balancer/scaleway_load_balancer.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the Load Balancer.",
  ),
  zone: z.string().default("fr-par-1").describe(
    "Availability zone, e.g. fr-par-1, nl-ams-1, pl-waw-1.",
  ),
  lbId: z.string().describe("ID of the Load Balancer this model manages."),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `create` (CreateLb). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name to assign to the new Load Balancer."),
  description: z.string().optional().describe(
    "Optional human-readable description of the Load Balancer.",
  ),
  type: z.string().default("LB-S").describe(
    "Commercial offer type, e.g. LB-S, LB-GP-M, LB-GP-L.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Optional list of tags to attach to the Load Balancer.",
  ),
  assignFlexibleIp: z.boolean().optional().describe(
    "Whether to automatically assign a new flexible IP to the Load Balancer.",
  ),
});

/** Arguments for `delete` (DeleteLb). */
const DeleteArgsSchema = z.object({
  releaseIp: z.boolean().default(false).describe(
    "Whether to release the Load Balancer's flexible IP addresses on delete.",
  ),
});

const LoadBalancerSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.string(),
  type: z.string().nullable().optional(),
  zone: z.string(),
  publicIp: z.string().nullable().optional(),
  frontendCount: z.number().nullable().optional(),
  backendCount: z.number().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  projectId: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  observedAt: z.string(),
});

const BackendSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  forwardProtocol: z.string().nullable().optional(),
  forwardPort: z.number().nullable().optional(),
  forwardPortAlgorithm: z.string().nullable().optional(),
  lbId: z.string(),
  observedAt: z.string(),
});

const FrontendSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  inboundPort: z.number().nullable().optional(),
  backendId: z.string().nullable().optional(),
  lbId: z.string(),
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
/** Map a Scaleway LB object (snake_case) to a camelCase resource snapshot. */
function toLoadBalancerResource(
  lb: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const ips = lb.ip as Array<Record<string, unknown>> | null | undefined;
  const firstIp = Array.isArray(ips) && ips.length > 0 ? ips[0] : undefined;
  return {
    id: (lb.id as string) ?? g.lbId,
    name: (lb.name as string) ?? null,
    description: (lb.description as string) ?? null,
    status: (lb.status as string) ?? "unknown",
    type: (lb.type as string) ?? null,
    zone: (lb.zone as string) ?? g.zone,
    publicIp: (firstIp?.ip_address as string) ?? null,
    frontendCount: (lb.frontend_count as number) ?? null,
    backendCount: (lb.backend_count as number) ?? null,
    tags: (lb.tags as string[]) ?? null,
    projectId: (lb.project_id as string) ?? g.projectId,
    createdAt: (lb.created_at as string) ?? null,
    observedAt,
  };
}

/** Map a Scaleway LB backend object to a camelCase resource snapshot. */
function toBackendResource(
  b: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (b.id as string) ?? crypto.randomUUID(),
    name: (b.name as string) ?? null,
    forwardProtocol: (b.forward_protocol as string) ?? null,
    forwardPort: (b.forward_port as number) ?? null,
    forwardPortAlgorithm: (b.forward_port_algorithm as string) ?? null,
    lbId: g.lbId,
    observedAt,
  };
}

/** Map a Scaleway LB frontend object to a camelCase resource snapshot. */
function toFrontendResource(
  f: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const backend = f.backend as Record<string, unknown> | null | undefined;
  return {
    id: (f.id as string) ?? crypto.randomUUID(),
    name: (f.name as string) ?? null,
    inboundPort: (f.inbound_port as number) ?? null,
    backendId: (backend?.id as string) ?? (f.backend_id as string) ?? null,
    lbId: g.lbId,
    observedAt,
  };
}

const lbsPath = (g: GlobalArgs): string => `/lb/v1/zones/${g.zone}/lbs`;

// --- Model -----------------------------------------------------------------
/** Scaleway Load Balancer model — one instance per LB, keyed by lbId. */
export const model = {
  type: "@sntxrr/scaleway-load-balancer",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "loadBalancer": {
      description: "Snapshot of the Load Balancer's state",
      schema: LoadBalancerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "backend": {
      description: "Snapshot of a Load Balancer backend",
      schema: BackendSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "frontend": {
      description: "Snapshot of a Load Balancer frontend",
      schema: FrontendSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description: "Fetch the Load Balancer's current state (GetLb).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway Load Balancer {id}", { id: g.lbId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${lbsPath(g)}/${encodeURIComponent(g.lbId)}`,
        );
        const handle = await context.writeResource(
          "loadBalancer",
          "latest",
          toLoadBalancerResource(res, g, new Date().toISOString()),
        );
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Provision a new Load Balancer (CreateLb).",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway Load Balancer {name}", {
          name: args.name,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          type: args.type,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.assignFlexibleIp !== undefined) {
          body.assign_flexible_ip = args.assignFlexibleIp;
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          lbsPath(g),
          body,
        );
        const handle = await context.writeResource(
          "loadBalancer",
          "latest",
          toLoadBalancerResource(res, g, new Date().toISOString()),
        );
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the Load Balancer (DeleteLb).",
      arguments: DeleteArgsSchema,
      execute: async (
        args: z.infer<typeof DeleteArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway Load Balancer {id}", { id: g.lbId });
        await scalewayFetch(
          g,
          "DELETE",
          `${lbsPath(g)}/${
            encodeURIComponent(g.lbId)
          }?release_ip=${args.releaseIp}`,
        );
        const handle = await context.writeResource(
          "loadBalancer",
          "latest",
          toLoadBalancerResource(
            { id: g.lbId, status: "deleting" },
            g,
            new Date().toISOString(),
          ),
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Load Balancers in the zone (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const lbs = await scalewayListAll<Record<string, unknown>>(
          g,
          lbsPath(g),
          "lbs",
        );
        logger.info("Discovered {n} Load Balancers in {zone}", {
          n: lbs.length,
          zone: g.zone,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const lb of lbs) {
          handles.push(
            await context.writeResource(
              "loadBalancer",
              (lb.id as string) ?? crypto.randomUUID(),
              toLoadBalancerResource(lb, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-backends": {
      description:
        "Discover all backends attached to this Load Balancer (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const backends = await scalewayListAll<Record<string, unknown>>(
          g,
          `${lbsPath(g)}/${encodeURIComponent(g.lbId)}/backends`,
          "backends",
        );
        logger.info("Discovered {n} backends on LB {id}", {
          n: backends.length,
          id: g.lbId,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const b of backends) {
          handles.push(
            await context.writeResource(
              "backend",
              (b.id as string) ?? crypto.randomUUID(),
              toBackendResource(b, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-frontends": {
      description:
        "Discover all frontends attached to this Load Balancer (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const frontends = await scalewayListAll<Record<string, unknown>>(
          g,
          `${lbsPath(g)}/${encodeURIComponent(g.lbId)}/frontends`,
          "frontends",
        );
        logger.info("Discovered {n} frontends on LB {id}", {
          n: frontends.length,
          id: g.lbId,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const f of frontends) {
          handles.push(
            await context.writeResource(
              "frontend",
              (f.id as string) ?? crypto.randomUUID(),
              toFrontendResource(f, g, now),
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
  toLoadBalancerResource,
  toBackendResource,
  toFrontendResource,
  lbsPath,
};
