/**
 * Scaleway IAM (Identity & Access Management) integration.
 *
 * Wraps the Scaleway IAM API (`/iam/v1alpha1`, **global** — no zone/region
 * segment in the path) so a swamp model represents a single IAM application,
 * keyed by its application ID (`applicationId`). Exposes `sync`, `create`,
 * `update` (PATCH), `delete` (idempotent), a factory `list` (every application
 * in the Organization), and factories `list-api-keys` / `list-policies`.
 * Authenticated with the `X-Auth-Token` header (secret key wired from a vault).
 *
 * IAM is **Organization-scoped**: applications, API keys, and policies belong to
 * an Organization, so this model takes an `organizationId` global argument (not
 * a `projectId`). A labeled pre-flight check (`org-specified`) auto-runs before
 * the mutating verbs (`create`/`update`/`delete`) to ensure the mutation targets
 * a non-empty Organization.
 *
 * SECRET HYGIENE: creating an API key returns its `secret_key` exactly once. This
 * model never writes any `secret_key` (or `access_key` secret material) into a
 * resource snapshot or log. `list-api-keys` snapshots API-key metadata only —
 * the `toApiKeyResource` mapper explicitly omits `secret_key`.
 *
 * API reference: https://www.scaleway.com/en/developers/api/iam/
 * @module
 */
// extensions/models/scaleway-iam/scaleway_iam.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the IAM model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  organizationId: z.string().describe(
    "Scaleway Organization ID that owns the IAM application, API keys, and policies.",
  ),
  applicationId: z.string().describe(
    "ID of the IAM application this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new IAM application (CreateApplication). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new IAM application."),
  description: z.string().optional().describe(
    "Optional human-readable description of the application.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Optional tags to attach to the new application.",
  ),
});

/** Arguments for mutating an IAM application's mutable fields (UpdateApplication). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the application."),
  description: z.string().optional().describe(
    "New description for the application.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the application.",
  ),
});

/** Snapshot schema for an IAM application. Never contains secrets. */
const ApplicationSchema = z.object({
  id: z.string().describe("Application ID."),
  name: z.string().nullable().optional().describe("Application name."),
  description: z.string().nullable().optional().describe(
    "Application description.",
  ),
  organizationId: z.string().nullable().optional().describe(
    "Organization ID that owns the application.",
  ),
  editable: z.boolean().nullable().optional().describe(
    "Whether the application is editable.",
  ),
  nbApiKeys: z.number().nullable().optional().describe(
    "Number of API keys attached to the application.",
  ),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the application.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last-update timestamp (ISO 8601).",
  ),
  status: z.string().nullable().optional().describe(
    "Lifecycle status, e.g. present or absent (set to absent after delete).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/**
 * Snapshot schema for IAM API-key metadata. Deliberately has **no** `secretKey`
 * field: the API only ever returns `secret_key` once (at creation) and it must
 * never be persisted into a snapshot.
 */
const ApiKeySchema = z.object({
  accessKey: z.string().describe(
    "API key access key (public identifier, non-secret).",
  ),
  description: z.string().nullable().optional().describe(
    "API key description.",
  ),
  applicationId: z.string().nullable().optional().describe(
    "ID of the application bearing this API key.",
  ),
  userId: z.string().nullable().optional().describe(
    "ID of the user bearing this API key (mutually exclusive with applicationId).",
  ),
  defaultProjectId: z.string().nullable().optional().describe(
    "Default project ID used by this API key.",
  ),
  editable: z.boolean().nullable().optional().describe(
    "Whether the API key is editable.",
  ),
  expiresAt: z.string().nullable().optional().describe(
    "Expiry timestamp (ISO 8601), or null if it never expires.",
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

/** Snapshot schema for an IAM policy. Never contains secrets. */
const PolicySchema = z.object({
  id: z.string().describe("Policy ID."),
  name: z.string().nullable().optional().describe("Policy name."),
  description: z.string().nullable().optional().describe(
    "Policy description.",
  ),
  organizationId: z.string().nullable().optional().describe(
    "Organization ID that owns the policy.",
  ),
  applicationId: z.string().nullable().optional().describe(
    "ID of the application this policy is bound to (if any).",
  ),
  userId: z.string().nullable().optional().describe(
    "ID of the user this policy is bound to (if any).",
  ),
  groupId: z.string().nullable().optional().describe(
    "ID of the group this policy is bound to (if any).",
  ),
  noPrincipal: z.boolean().nullable().optional().describe(
    "Whether the policy is bound to no principal.",
  ),
  editable: z.boolean().nullable().optional().describe(
    "Whether the policy is editable.",
  ),
  nbRules: z.number().nullable().optional().describe(
    "Number of rules in the policy.",
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
/** Map a raw Scaleway IAM application (snake_case) to a camelCase snapshot. */
function toApplicationResource(
  a: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (a.id as string) ?? g.applicationId,
    name: (a.name as string) ?? null,
    description: (a.description as string) ?? null,
    organizationId: (a.organization_id as string) ?? g.organizationId,
    editable: (a.editable as boolean) ?? null,
    nbApiKeys: (a.nb_api_keys as number) ?? null,
    tags: (a.tags as string[]) ?? null,
    createdAt: (a.created_at as string) ?? null,
    updatedAt: (a.updated_at as string) ?? null,
    status: (a.status as string) ?? "present",
    observedAt,
  };
}

/**
 * Map a raw Scaleway IAM API key (snake_case) to a camelCase **metadata-only**
 * snapshot. SECRET HYGIENE: `secret_key` is intentionally never read or copied —
 * only the non-secret `access_key` and surrounding metadata are persisted.
 */
function toApiKeyResource(
  k: Record<string, unknown>,
  observedAt: string,
): Record<string, unknown> {
  return {
    accessKey: (k.access_key as string) ?? "",
    description: (k.description as string) ?? null,
    applicationId: (k.application_id as string) ?? null,
    userId: (k.user_id as string) ?? null,
    defaultProjectId: (k.default_project_id as string) ?? null,
    editable: (k.editable as boolean) ?? null,
    expiresAt: (k.expires_at as string) ?? null,
    createdAt: (k.created_at as string) ?? null,
    updatedAt: (k.updated_at as string) ?? null,
    observedAt,
  };
}

/** Map a raw Scaleway IAM policy (snake_case) to a camelCase snapshot. */
function toPolicyResource(
  p: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (p.id as string) ?? "",
    name: (p.name as string) ?? null,
    description: (p.description as string) ?? null,
    organizationId: (p.organization_id as string) ?? g.organizationId,
    applicationId: (p.application_id as string) ?? null,
    userId: (p.user_id as string) ?? null,
    groupId: (p.group_id as string) ?? null,
    noPrincipal: (p.no_principal as boolean) ?? null,
    editable: (p.editable as boolean) ?? null,
    nbRules: (p.nb_rules as number) ?? null,
    createdAt: (p.created_at as string) ?? null,
    updatedAt: (p.updated_at as string) ?? null,
    observedAt,
  };
}

// --- Paths (global scope — no zone/region segment) -------------------------
/** IAM applications collection path (global scope). */
const applicationsPath = (): string => `/iam/v1alpha1/applications`;

/** IAM API keys collection path (global scope). */
const apiKeysPath = (): string => `/iam/v1alpha1/api-keys`;

/** IAM policies collection path (global scope). */
const policiesPath = (): string => `/iam/v1alpha1/policies`;

// --- Model -----------------------------------------------------------------
/** Scaleway IAM model — one instance per application, keyed by applicationId. */
export const model = {
  type: "@sntxrr/scaleway-iam",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "application": {
      description: "Snapshot of the IAM application's state",
      schema: ApplicationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "api-key": {
      description:
        "Snapshot of IAM API-key metadata (never includes the secret key)",
      schema: ApiKeySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "policy": {
      description: "Snapshot of an IAM policy discovered in the Organization",
      schema: PolicySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "org-specified": {
      description:
        "An IAM mutation must target an Organization: globalArgs.organizationId must be set.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        const org = context.globalArgs.organizationId;
        if (!org || org.trim() === "") {
          return {
            pass: false,
            errors: [
              "globalArgs.organizationId is empty — an IAM mutation must target an Organization.",
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    sync: {
      description:
        "Fetch the IAM application's current state (GetApplication).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway IAM application {id}", {
          id: g.applicationId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${applicationsPath()}/${encodeURIComponent(g.applicationId)}`,
        );
        const handle = await context.writeResource(
          "application",
          g.applicationId,
          toApplicationResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway IAM application {id}", {
          id: g.applicationId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new IAM application (CreateApplication) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway IAM application {name} in org {org}", {
          name: args.name,
          org: g.organizationId,
        });
        const body: Record<string, unknown> = {
          organization_id: g.organizationId,
          name: args.name,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          applicationsPath(),
          body,
        );
        const newId = (res.id as string) ?? g.applicationId;
        const handle = await context.writeResource(
          "application",
          newId,
          toApplicationResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway IAM application {id}", { id: newId });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate an IAM application's mutable fields (UpdateApplication, PATCH).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway IAM application {id}", {
          id: g.applicationId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.description !== undefined) body.description = args.description;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${applicationsPath()}/${encodeURIComponent(g.applicationId)}`,
          body,
        );
        const handle = await context.writeResource(
          "application",
          g.applicationId,
          toApplicationResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway IAM application {id}", {
          id: g.applicationId,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the IAM application (DeleteApplication).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway IAM application {id}", {
          id: g.applicationId,
        });
        // Idempotent delete: a 404 means the application is already gone — treat
        // it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${applicationsPath()}/${encodeURIComponent(g.applicationId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toApplicationResource(
            { id: g.applicationId, status: "absent" },
            g,
            observedAt,
          )
          : toApplicationResource(
            res ?? { id: g.applicationId, status: "absent" },
            g,
            observedAt,
          );
        const handle = await context.writeResource(
          "application",
          g.applicationId,
          snapshot,
        );
        logger.info("Deleted Scaleway IAM application {id} (absent={absent})", {
          id: g.applicationId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description:
        "Discover all IAM applications in the Organization (factory, paginated).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Discovering IAM applications in org {org}", {
          org: g.organizationId,
        });
        const applications = await scalewayListAll<Record<string, unknown>>(
          g,
          `${applicationsPath()}?organization_id=${
            encodeURIComponent(g.organizationId)
          }`,
          "applications",
        );
        logger.info("Discovered {n} IAM applications", {
          n: applications.length,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const a of applications) {
          handles.push(
            await context.writeResource(
              "application",
              (a.id as string) ?? crypto.randomUUID(),
              toApplicationResource(a, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-api-keys": {
      description:
        "Discover API-key metadata for the managed application (factory, paginated). " +
        "Never snapshots secret_key values.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Discovering IAM API keys for application {id}", {
          id: g.applicationId,
        });
        const keys = await scalewayListAll<Record<string, unknown>>(
          g,
          `${apiKeysPath()}?application_id=${
            encodeURIComponent(g.applicationId)
          }`,
          "api_keys",
        );
        logger.info("Discovered {n} IAM API keys", { n: keys.length });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const k of keys) {
          // Key snapshots under the non-secret access_key; secret_key is dropped.
          handles.push(
            await context.writeResource(
              "api-key",
              (k.access_key as string) ?? crypto.randomUUID(),
              toApiKeyResource(k, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-policies": {
      description:
        "Discover all IAM policies in the Organization (factory, paginated).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Discovering IAM policies in org {org}", {
          org: g.organizationId,
        });
        const policies = await scalewayListAll<Record<string, unknown>>(
          g,
          `${policiesPath()}?organization_id=${
            encodeURIComponent(g.organizationId)
          }`,
          "policies",
        );
        logger.info("Discovered {n} IAM policies", { n: policies.length });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const p of policies) {
          handles.push(
            await context.writeResource(
              "policy",
              (p.id as string) ?? crypto.randomUUID(),
              toPolicyResource(p, g, now),
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
  toApplicationResource,
  toApiKeyResource,
  toPolicyResource,
  applicationsPath,
  apiKeysPath,
  policiesPath,
};
