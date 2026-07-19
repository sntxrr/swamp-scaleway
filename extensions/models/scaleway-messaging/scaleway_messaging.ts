/**
 * Scaleway Messaging & Queuing (MNQ) — NATS accounts integration.
 *
 * Wraps the Scaleway Messaging & Queuing API (`/mnq/v1beta1`, regional) so a
 * swamp model represents a single NATS account, keyed by its NATS account ID. A
 * NATS account provides the scope for a project's NATS streams, messages, and
 * credentials. Exposes `sync`, `create`, `update` (PATCH), `delete`, and a
 * factory `list`. Authenticated with the `X-Auth-Token` header (secret key
 * wired from a vault). NATS account snapshots contain only non-secret metadata
 * (id, name, endpoint); NATS credential material is a separate operation and is
 * intentionally out of scope for this version (see README "Future work").
 *
 * API reference: https://www.scaleway.com/en/developers/api/messaging-and-queuing/nats-api/
 * @module
 */
// extensions/models/scaleway-messaging/scaleway_messaging.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the MNQ NATS model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the NATS account.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  natsAccountId: z.string().optional().describe(
    "ID of the NATS account this model manages. Optional — `create` " +
      "provisions a new account and returns its ID; every other method " +
      "requires it.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new NATS account (CreateNatsAccount). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new NATS account."),
});

/** Arguments for mutating a NATS account's mutable fields (UpdateNatsAccount). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the NATS account."),
});

/**
 * Snapshot schema for a NATS account. Contains only non-secret metadata — the
 * connection endpoint is public; NATS credentials are never stored here.
 */
const NatsAccountSchema = z.object({
  id: z.string().describe("NATS account ID."),
  name: z.string().nullable().optional().describe("NATS account name."),
  endpoint: z.string().nullable().optional().describe(
    "NATS service connection endpoint URL. Non-secret.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the account.",
  ),
  region: z.string().describe("Region hosting the account."),
  maxStreams: z.number().nullable().optional().describe(
    "Maximum number of NATS streams the account may hold.",
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
  absent: z.boolean().nullable().optional().describe(
    "True when the NATS account has been deleted and no longer exists.",
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
 * Map a raw Scaleway NATS account object (snake_case) to the camelCase snapshot
 * shape. Copies only non-secret metadata; NATS credential material is never
 * present in this object and is never stored.
 */
function toNatsAccountResource(
  a: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    // Callers always supply an id: API responses carry one, and the delete
    // path passes the guarded natsAccountId. The final "" is unreachable
    // defensive padding so the snapshot still satisfies NatsAccountSchema's
    // required id.
    id: (a.id as string) ?? g.natsAccountId ?? "",
    name: (a.name as string) ?? null,
    endpoint: (a.endpoint as string) ?? null,
    projectId: (a.project_id as string) ?? null,
    region: (a.region as string) ?? g.region,
    maxStreams: (a.max_streams as number) ?? null,
    createdAt: (a.created_at as string) ?? null,
    updatedAt: (a.updated_at as string) ?? null,
    observedAt,
  };
}

const natsAccountsPath = (g: GlobalArgs): string =>
  `/mnq/v1beta1/regions/${g.region}/nats-accounts`;

/**
 * Resolve the managed NATS account ID for methods that act on an *existing*
 * account.
 *
 * `natsAccountId` is optional in the global schema because `create` provisions
 * the account and learns its ID from the API — requiring it up front would force
 * callers to pass a throwaway placeholder just to satisfy validation. Methods
 * that read or mutate an existing account call this to fail fast with an
 * actionable message.
 */
function requireNatsAccountId(g: GlobalArgs, method: string): string {
  if (!g.natsAccountId) {
    throw new Error(
      `The "${method}" method requires globalArgs.natsAccountId — the ID of an ` +
        `existing NATS account. Set natsAccountId on the model, or run ` +
        `"create" first to provision one.`,
    );
  }
  return g.natsAccountId;
}

// --- Model -----------------------------------------------------------------
/** Scaleway MNQ NATS account model — one instance per account, keyed by natsAccountId. */
export const model = {
  type: "@sntxrr/scaleway-messaging",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "nats-account": {
      description: "Snapshot of the NATS account's state",
      schema: NatsAccountSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported MNQ regions.",
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
      description: "Fetch the NATS account's current state (GetNatsAccount).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const natsAccountId = requireNatsAccountId(g, "sync");
        logger.info("Syncing Scaleway NATS account {id}", {
          id: natsAccountId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${natsAccountsPath(g)}/${encodeURIComponent(natsAccountId)}`,
        );
        const handle = await context.writeResource(
          "nats-account",
          natsAccountId,
          toNatsAccountResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway NATS account {id}", {
          id: natsAccountId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new NATS account (CreateNatsAccount) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway NATS account {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
        };
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          natsAccountsPath(g),
          body,
        );
        // CreateNatsAccount always returns the new ID; fall back to a preset
        // natsAccountId only if the caller pinned one, so create never depends
        // on it being set.
        const newId = (res.id as string) ?? g.natsAccountId ?? "";
        const handle = await context.writeResource(
          "nats-account",
          newId,
          toNatsAccountResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway NATS account {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a NATS account's mutable fields (UpdateNatsAccount).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const natsAccountId = requireNatsAccountId(g, "update");
        logger.info("Updating Scaleway NATS account {id}", {
          id: natsAccountId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${natsAccountsPath(g)}/${encodeURIComponent(natsAccountId)}`,
          body,
        );
        const handle = await context.writeResource(
          "nats-account",
          natsAccountId,
          toNatsAccountResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway NATS account {id}", {
          id: natsAccountId,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the NATS account (DeleteNatsAccount).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const natsAccountId = requireNatsAccountId(g, "delete");
        logger.info("Deleting Scaleway NATS account {id}", {
          id: natsAccountId,
        });
        // Idempotent delete: a 404 means the account is already gone — treat it
        // as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${natsAccountsPath(g)}/${encodeURIComponent(natsAccountId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? {
            ...toNatsAccountResource({ id: natsAccountId }, g, observedAt),
            absent: true,
          }
          : toNatsAccountResource(
            res ?? { id: natsAccountId },
            g,
            observedAt,
          );
        const handle = await context.writeResource(
          "nats-account",
          natsAccountId,
          snapshot,
        );
        logger.info("Deleted Scaleway NATS account {id} (absent={absent})", {
          id: natsAccountId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all NATS accounts in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const accounts = await scalewayListAll<Record<string, unknown>>(
          g,
          natsAccountsPath(g),
          "nats_accounts",
        );
        logger.info("Discovered {n} NATS accounts in {region}", {
          n: accounts.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const a of accounts) {
          handles.push(
            await context.writeResource(
              "nats-account",
              (a.id as string) ?? crypto.randomUUID(),
              toNatsAccountResource(a, g, now),
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
  toNatsAccountResource,
  natsAccountsPath,
};
