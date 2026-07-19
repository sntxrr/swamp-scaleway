/**
 * Scaleway Secret Manager integration.
 *
 * Wraps the Scaleway Secret Manager API (`/secret-manager/v1beta1`, regional) so
 * a swamp model represents a single secret, keyed by its secret ID. Exposes
 * `sync`, `create`, `update`, `delete`, a factory `list`, plus `add-version`
 * (store a new secret value) and `access` (read the latest value). Authenticated
 * with the `X-Auth-Token` header (secret key wired from a vault).
 *
 * SECRET HYGIENE — this is the whole point of the service. The secret *value*
 * (the `data` returned by `access`, and the value passed to `add-version`) is
 * sensitive. It is:
 *   - never logged (only ids/revisions/metadata are logged),
 *   - never written into a metadata snapshot (`secret` / `secretVersion`), and
 *   - surfaced only through the dedicated `secretValue` resource, which is
 *     marked `sensitiveOutput: true` (its `value` field is also `.meta({
 *     sensitive: true })`). swamp vaults those fields and replaces them with a
 *     vault reference before the snapshot is persisted, so cleartext never lands
 *     on disk. A vault must be configured for `access` to persist (a Scaleway
 *     Secret Manager vault backend for this service is a planned follow-up).
 *
 * API reference: https://www.scaleway.com/en/developers/api/secret-manager/
 * @module
 */
// extensions/models/scaleway-secret-manager/scaleway_secret_manager.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Secret Manager model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the secret.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  secretId: z.string().optional().describe(
    "ID of the Secret Manager secret this model manages. Optional — `create` " +
      "provisions a new secret and returns its ID; every other method requires it.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for creating a new secret (CreateSecret). Metadata only — no value. */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new secret."),
  type: z.string().optional().describe(
    "Secret type, e.g. opaque, key_value, basic_credential. Defaults to opaque.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the new secret.",
  ),
  path: z.string().optional().describe(
    "Location of the secret in the directory structure, e.g. /prod.",
  ),
  description: z.string().optional().describe(
    "Human-readable description of the secret. Not a secret value.",
  ),
});

/** Arguments for mutating a secret's mutable metadata (UpdateSecret). No value. */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the secret."),
  tags: z.array(z.string()).optional().describe(
    "Replacement set of tags for the secret.",
  ),
  path: z.string().optional().describe("New path for the secret."),
  description: z.string().optional().describe(
    "New description for the secret. Not a secret value.",
  ),
});

/**
 * Arguments for storing a new secret version (CreateSecretVersion).
 *
 * `value` is the raw secret material and is SENSITIVE: it is base64-encoded into
 * the API `data` field, never logged, and never written into a snapshot.
 */
const AddVersionArgsSchema = z.object({
  value: z.string().meta({ sensitive: true }).describe(
    "Raw secret value to store as a new version. Sensitive — base64-encoded " +
      "into the request; never logged or stored in a snapshot.",
  ),
  description: z.string().optional().describe(
    "Description of this version. Not a secret value.",
  ),
  disablePrevious: z.boolean().optional().describe(
    "Disable the previous version when creating this one.",
  ),
});

/** Arguments for accessing a secret version's value (AccessSecretVersion). */
const AccessArgsSchema = z.object({
  revision: z.string().default("latest").describe(
    "Version to access: 'latest' or a numeric revision. Defaults to latest.",
  ),
});

/** Snapshot schema for a secret's metadata. Never contains a secret value. */
const SecretSchema = z.object({
  id: z.string().describe("Secret ID."),
  name: z.string().nullable().optional().describe("Secret name."),
  status: z.string().describe(
    "Secret status, e.g. ready, locked, enabled.",
  ),
  versionCount: z.number().nullable().optional().describe(
    "Number of versions the secret holds. Metadata, not a value.",
  ),
  type: z.string().nullable().optional().describe(
    "Secret type, e.g. opaque, key_value, basic_credential.",
  ),
  region: z.string().describe("Region hosting the secret."),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the secret.",
  ),
  path: z.string().nullable().optional().describe(
    "Location of the secret in the directory structure.",
  ),
  description: z.string().nullable().optional().describe(
    "Human-readable description. Not a secret value.",
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

/** Snapshot schema for a secret version's metadata. Never contains a value. */
const SecretVersionSchema = z.object({
  secretId: z.string().describe("ID of the parent secret."),
  revision: z.number().nullable().optional().describe(
    "Monotonic revision number of this version.",
  ),
  status: z.string().describe(
    "Version status, e.g. enabled, disabled, deleted.",
  ),
  latest: z.boolean().nullable().optional().describe(
    "Whether this is the latest revision.",
  ),
  description: z.string().nullable().optional().describe(
    "Description of this version. Not a secret value.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/**
 * Snapshot schema for an accessed secret value. SENSITIVE — the `value` field
 * holds the decoded secret material and is vaulted before persistence. The whole
 * spec is marked `sensitiveOutput: true` as defence-in-depth.
 */
const SecretValueSchema = z.object({
  secretId: z.string().describe("ID of the secret this value belongs to."),
  revision: z.union([z.number(), z.string()]).nullable().optional().describe(
    "Revision accessed.",
  ),
  value: z.string().meta({ sensitive: true }).describe(
    "The decoded secret value. SENSITIVE — vaulted, never logged.",
  ),
  observedAt: z.string().describe(
    "Timestamp when this value was accessed (ISO 8601).",
  ),
});

// --- Base64 helpers (UTF-8 safe; Deno-native, no deps) ----------------------
/** Base64-encode a UTF-8 string (for the CreateSecretVersion `data` field). */
function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decode a base64 payload (the `data` field from AccessSecretVersion) to UTF-8. */
function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

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
 * Map a raw Scaleway secret object (snake_case) to the camelCase metadata
 * snapshot shape. Copies only non-secret metadata — never a secret value.
 */
function toSecretResource(
  s: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    // Callers always supply an id: API responses carry one, and the delete
    // path passes the guarded secretId. The final "" is unreachable defensive
    // padding so the snapshot still satisfies SecretSchema's required id.
    id: (s.id as string) ?? g.secretId ?? "",
    name: (s.name as string) ?? null,
    status: (s.status as string) ?? "unknown",
    versionCount: (s.version_count as number) ?? null,
    type: (s.type as string) ?? null,
    region: (s.region as string) ?? g.region,
    tags: (s.tags as string[]) ?? null,
    path: (s.path as string) ?? null,
    description: (s.description as string) ?? null,
    createdAt: (s.created_at as string) ?? null,
    updatedAt: (s.updated_at as string) ?? null,
    observedAt,
  };
}

/**
 * Map a raw Scaleway secret-version object to the camelCase metadata snapshot
 * shape. Version objects carry no value — only revision/status metadata.
 */
function toVersionResource(
  v: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    // Version responses always carry secret_id; the guarded globalArg and the
    // final "" are unreachable defensive padding for the required field.
    secretId: (v.secret_id as string) ?? g.secretId ?? "",
    revision: (v.revision as number) ?? null,
    status: (v.status as string) ?? "unknown",
    latest: (v.latest as boolean) ?? (v.is_latest as boolean) ?? null,
    description: (v.description as string) ?? null,
    createdAt: (v.created_at as string) ?? null,
    observedAt,
  };
}

const secretsPath = (g: GlobalArgs): string =>
  `/secret-manager/v1beta1/regions/${g.region}/secrets`;

/**
 * Resolve the managed secret ID for methods that act on an *existing* secret.
 *
 * `secretId` is optional in the global schema because `create` provisions the
 * secret and learns its ID from the API — requiring it up front would force
 * callers to pass a throwaway placeholder just to satisfy validation. Methods
 * that read or mutate an existing secret call this to fail fast with an
 * actionable message.
 */
function requireSecretId(g: GlobalArgs, method: string): string {
  if (!g.secretId) {
    throw new Error(
      `The "${method}" method requires globalArgs.secretId — the ID of an ` +
        `existing secret. Set secretId on the model, or run "create" first to ` +
        `provision one.`,
    );
  }
  return g.secretId;
}

// --- Model -----------------------------------------------------------------
/** Scaleway Secret Manager model — one instance per secret, keyed by secretId. */
export const model = {
  type: "@sntxrr/scaleway-secret-manager",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "secret": {
      description: "Snapshot of the secret's metadata (never its value)",
      schema: SecretSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "secretVersion": {
      description: "Snapshot of a secret version's metadata (never its value)",
      schema: SecretVersionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "secretValue": {
      description:
        "The accessed secret value. Sensitive — vaulted, never logged.",
      schema: SecretValueSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
      sensitiveOutput: true,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported Secret Manager regions.",
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
      description: "Fetch the secret's current metadata (GetSecret).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const secretId = requireSecretId(g, "sync");
        logger.info("Syncing Scaleway secret {id}", { id: secretId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${secretsPath(g)}/${encodeURIComponent(secretId)}`,
        );
        const handle = await context.writeResource(
          "secret",
          secretId,
          toSecretResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway secret {id}", { id: secretId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Create a new secret's metadata (CreateSecret) — name/tags only, no value.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway secret {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
        };
        if (args.type !== undefined) body.type = args.type;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.path !== undefined) body.path = args.path;
        if (args.description !== undefined) body.description = args.description;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          secretsPath(g),
          body,
        );
        // CreateSecret always returns the new ID; fall back to a preset
        // secretId only if the caller pinned one, so create never depends on it.
        const newId = (res.id as string) ?? g.secretId ?? "";
        const handle = await context.writeResource(
          "secret",
          newId,
          toSecretResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway secret {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a secret's mutable metadata (UpdateSecret) — name, tags, path.",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const secretId = requireSecretId(g, "update");
        logger.info("Updating Scaleway secret {id}", { id: secretId });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.tags !== undefined) body.tags = args.tags;
        if (args.path !== undefined) body.path = args.path;
        if (args.description !== undefined) body.description = args.description;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${secretsPath(g)}/${encodeURIComponent(secretId)}`,
          body,
        );
        const handle = await context.writeResource(
          "secret",
          secretId,
          toSecretResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway secret {id}", { id: secretId });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Delete the secret and all its versions (DeleteSecret).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const secretId = requireSecretId(g, "delete");
        logger.info("Deleting Scaleway secret {id}", { id: secretId });
        // Idempotent delete: a 404 means the secret is already gone — treat it
        // as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${secretsPath(g)}/${encodeURIComponent(secretId)}`,
          );
        } catch (e) {
          // Idempotent delete: already-gone → success. Scaleway signals this as
          // a 404, OR a 412 "precondition failed" with precondition
          // "resource_not_usable" ("cannot act on deleted ...") once the secret
          // is already deleted. Re-throw anything else (CONVENTIONS.md §3.2).
          const err = e as { status?: number; message?: string };
          const alreadyGone = err.status === 404 ||
            (err.status === 412 &&
              /resource_not_usable/.test(err.message ?? ""));
          if (!alreadyGone) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toSecretResource(
            { id: secretId, status: "absent" },
            g,
            observedAt,
          )
          : toSecretResource(res ?? { id: secretId }, g, observedAt);
        const handle = await context.writeResource(
          "secret",
          secretId,
          snapshot,
        );
        logger.info("Deleted Scaleway secret {id} (absent={absent})", {
          id: secretId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all secrets in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const secrets = await scalewayListAll<Record<string, unknown>>(
          g,
          secretsPath(g),
          "secrets",
        );
        logger.info("Discovered {n} secrets in {region}", {
          n: secrets.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const s of secrets) {
          handles.push(
            await context.writeResource(
              "secret",
              (s.id as string) ?? crypto.randomUUID(),
              toSecretResource(s, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "add-version": {
      description:
        "Store a new secret value as a version (CreateSecretVersion). " +
        "The value is base64-encoded, never logged, and never snapshotted.",
      arguments: AddVersionArgsSchema,
      execute: async (
        args: z.infer<typeof AddVersionArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const secretId = requireSecretId(g, "add-version");
        // Log only the id — never the value.
        logger.info("Adding a version to Scaleway secret {id}", {
          id: secretId,
        });
        const body: Record<string, unknown> = {
          // Base64 the raw value into `data`; the value itself is never logged.
          data: toBase64(args.value),
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.disablePrevious !== undefined) {
          body.disable_previous = args.disablePrevious;
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${secretsPath(g)}/${encodeURIComponent(secretId)}/versions`,
          body,
        );
        // Snapshot only version METADATA — never the value.
        const handle = await context.writeResource(
          "secretVersion",
          secretId,
          toVersionResource(res, g, new Date().toISOString()),
        );
        logger.info("Added version {revision} to Scaleway secret {id}", {
          revision: (res.revision as number) ?? null,
          id: secretId,
        });
        return { dataHandles: [handle] };
      },
    },
    "access": {
      description:
        "Read a secret version's value (AccessSecretVersion). The value is " +
        "returned only via the sensitive `secretValue` resource — never logged.",
      arguments: AccessArgsSchema,
      execute: async (
        args: z.infer<typeof AccessArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const secretId = requireSecretId(g, "access");
        // Log only the id and revision selector — never the value.
        logger.info("Accessing Scaleway secret {id} revision {revision}", {
          id: secretId,
          revision: args.revision,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${secretsPath(g)}/${encodeURIComponent(secretId)}/versions/${
            encodeURIComponent(args.revision)
          }/access`,
        );
        const rawData = (res.data as string) ?? "";
        // Decode the base64 payload into the raw value. This lands only in the
        // sensitive `secretValue` spec (vaulted before persistence) — it is
        // never logged and never written to a metadata snapshot.
        const value = rawData ? fromBase64(rawData) : "";
        const handle = await context.writeResource(
          "secretValue",
          secretId,
          {
            secretId: (res.secret_id as string) ?? secretId,
            revision: (res.revision as number | string) ?? args.revision,
            value,
            observedAt: new Date().toISOString(),
          },
        );
        // Deliberately no value in this (or any) log line.
        logger.info("Accessed Scaleway secret {id}", { id: secretId });
        return { dataHandles: [handle] };
      },
    },
  },
};

/** Internal helpers exported only for unit testing. */
export const _internal = {
  scalewayFetch,
  scalewayListAll,
  toSecretResource,
  toVersionResource,
  toBase64,
  fromBase64,
  secretsPath,
};
