/**
 * Scaleway Web Hosting integration.
 *
 * Wraps the Scaleway Web Hosting API (`/webhosting/v1`, regional) so a swamp
 * model represents a single Web Hosting plan, keyed by its hosting ID. Exposes
 * `sync`, `create`, `update`, `delete`, and a factory `list`. Authenticated with
 * the `X-Auth-Token` header (secret key wired from a vault). Snapshots store only
 * non-secret facts (status, domain, offer, platform hostname, IPv4); the plan's
 * one-time password (issued only via the separate ResetHostingPassword endpoint,
 * not implemented here) is never logged or stored.
 *
 * API reference: https://www.scaleway.com/en/developers/api/webhosting/hosting-api/
 * @module
 */
// extensions/models/scaleway-webhosting/scaleway_webhosting.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Web Hosting model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the Web Hosting plan.",
  ),
  region: z.string().default("fr-par").describe(
    "Region hosting the plan. Web Hosting is available only in fr-par.",
  ),
  hostingId: z.string().describe(
    "ID of the Web Hosting plan this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new Web Hosting plan (CreateHosting). */
const CreateArgsSchema = z.object({
  offerId: z.string().describe(
    "UUID of the selected Web Hosting offer (plan size).",
  ),
  domain: z.string().describe(
    "Domain name to attach to the plan; must already be owned.",
  ),
  email: z.string().optional().describe(
    "Contact email for the hosting account. Optional.",
  ),
  language: z.string().optional().describe(
    "Default language for the hosting control panel, e.g. en_US. Optional.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the new plan.",
  ),
});

/** Arguments for mutating a Web Hosting plan's mutable fields (UpdateHosting). */
const UpdateArgsSchema = z.object({
  offerId: z.string().optional().describe(
    "New offer UUID to migrate the plan to (upgrade/downgrade).",
  ),
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the plan.",
  ),
  protected: z.boolean().optional().describe(
    "Whether the plan is protected against accidental deletion.",
  ),
});

/** Snapshot schema for a Web Hosting plan. Never contains secrets. */
const HostingSchema = z.object({
  id: z.string().describe("Hosting plan ID."),
  status: z.string().describe(
    "Plan status, e.g. ready, delivering, updating, deleting, error, locked.",
  ),
  domain: z.string().nullable().optional().describe(
    "Domain name attached to the plan.",
  ),
  region: z.string().describe("Region hosting the plan."),
  offerId: z.string().nullable().optional().describe(
    "UUID of the plan's current offer.",
  ),
  offerName: z.string().nullable().optional().describe(
    "Human-readable name of the plan's current offer.",
  ),
  platformHostname: z.string().nullable().optional().describe(
    "Hostname of the platform the plan runs on. Non-secret.",
  ),
  ipv4: z.string().nullable().optional().describe(
    "IPv4 address of the hosting platform. Non-secret.",
  ),
  username: z.string().nullable().optional().describe(
    "Control-panel account username. Non-secret (no password stored).",
  ),
  protected: z.boolean().nullable().optional().describe(
    "Whether the plan is protected against accidental deletion.",
  ),
  dnsStatus: z.string().nullable().optional().describe(
    "DNS configuration status for the attached domain.",
  ),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the plan.",
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
 * Map a raw Scaleway Web Hosting object (snake_case) to the camelCase snapshot
 * shape. Copies only an allow-list of non-secret fields; any password or
 * one-time credential echoed by the API is never propagated into the snapshot.
 */
function toHostingResource(
  h: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const offer = h.offer as Record<string, unknown> | null | undefined;
  const platform = h.platform as Record<string, unknown> | null | undefined;
  const user = h.user as Record<string, unknown> | null | undefined;
  return {
    id: (h.id as string) ?? g.hostingId,
    status: (h.status as string) ?? "unknown",
    domain: (h.domain as string) ?? null,
    region: (h.region as string) ?? g.region,
    offerId: (offer?.id as string) ?? (h.offer_id as string) ?? null,
    offerName: (offer?.name as string) ?? null,
    platformHostname: (platform?.hostname as string) ?? null,
    ipv4: (h.ipv4 as string) ?? (platform?.ipv4 as string) ?? null,
    username: (user?.username as string) ?? null,
    protected: (h.protected as boolean) ?? null,
    dnsStatus: (h.dns_status as string) ?? null,
    tags: (h.tags as string[]) ?? null,
    createdAt: (h.created_at as string) ?? null,
    updatedAt: (h.updated_at as string) ?? null,
    observedAt,
  };
}

const hostingsPath = (g: GlobalArgs): string =>
  `/webhosting/v1/regions/${g.region}/hostings`;

// --- Model -----------------------------------------------------------------
/** Scaleway Web Hosting model — one instance per plan, keyed by hostingId. */
export const model = {
  type: "@sntxrr/scaleway-webhosting",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "hosting": {
      description: "Snapshot of the Web Hosting plan's state",
      schema: HostingSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one where Scaleway Web Hosting is offered.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        // Web Hosting is currently offered only in fr-par.
        const allowed = ["fr-par"];
        const region = context.globalArgs.region;
        if (!allowed.includes(region)) {
          return {
            pass: false,
            errors: [
              `Region "${region}" is not a Scaleway Web Hosting region: ${
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
      description: "Fetch the Web Hosting plan's current state (GetHosting).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway Web Hosting plan {id}", {
          id: g.hostingId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${hostingsPath(g)}/${encodeURIComponent(g.hostingId)}`,
        );
        const handle = await context.writeResource(
          "hosting",
          g.hostingId,
          toHostingResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway Web Hosting plan {id}", {
          id: g.hostingId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new Web Hosting plan (CreateHosting) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info(
          "Creating Scaleway Web Hosting plan for {domain} in {region}",
          {
            domain: args.domain,
            region: g.region,
          },
        );
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          offer_id: args.offerId,
          domain: args.domain,
        };
        if (args.email !== undefined) body.email = args.email;
        if (args.language !== undefined) body.language = args.language;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          hostingsPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.hostingId;
        const handle = await context.writeResource(
          "hosting",
          newId,
          toHostingResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway Web Hosting plan {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a Web Hosting plan's mutable fields (UpdateHosting).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway Web Hosting plan {id}", {
          id: g.hostingId,
        });
        const body: Record<string, unknown> = {};
        if (args.offerId !== undefined) body.offer_id = args.offerId;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.protected !== undefined) body.protected = args.protected;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${hostingsPath(g)}/${encodeURIComponent(g.hostingId)}`,
          body,
        );
        const handle = await context.writeResource(
          "hosting",
          g.hostingId,
          toHostingResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway Web Hosting plan {id}", {
          id: g.hostingId,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the Web Hosting plan (DeleteHosting).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway Web Hosting plan {id}", {
          id: g.hostingId,
        });
        // Idempotent delete: a 404 means the plan is already gone — treat it as
        // success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${hostingsPath(g)}/${encodeURIComponent(g.hostingId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toHostingResource(
            { id: g.hostingId, status: "absent" },
            g,
            observedAt,
          )
          : toHostingResource(res ?? { id: g.hostingId }, g, observedAt);
        const handle = await context.writeResource(
          "hosting",
          g.hostingId,
          snapshot,
        );
        logger.info(
          "Deleted Scaleway Web Hosting plan {id} (absent={absent})",
          {
            id: g.hostingId,
            absent,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Web Hosting plans in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const hostings = await scalewayListAll<Record<string, unknown>>(
          g,
          hostingsPath(g),
          "hostings",
        );
        logger.info("Discovered {n} Web Hosting plans in {region}", {
          n: hostings.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const h of hostings) {
          handles.push(
            await context.writeResource(
              "hosting",
              (h.id as string) ?? crypto.randomUUID(),
              toHostingResource(h, g, now),
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
  toHostingResource,
  hostingsPath,
};
