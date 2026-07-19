/**
 * Scaleway Key Manager (KMS) integration.
 *
 * Wraps the Scaleway Key Manager API (`/key-manager/v1alpha1`, regional) so a
 * swamp model represents a single cryptographic key, keyed by its key ID.
 * Exposes `sync`, `create`, `delete`, a factory `list`, and the cryptographic
 * operations `encrypt`, `decrypt`, and `rotate`. Authenticated with the
 * `X-Auth-Token` header (secret key wired from a vault).
 *
 * Secret hygiene: the `plaintext` handled by `encrypt` (input) and `decrypt`
 * (output) is sensitive. It is never logged and never written into the normal
 * key snapshot. `encrypt` snapshots only the non-secret ciphertext; `decrypt`
 * returns the recovered plaintext via a dedicated resource whose `plaintext`
 * field is marked sensitive, so it is masked in display and logs.
 *
 * API reference: https://www.scaleway.com/en/developers/api/key-manager/
 * @module
 */
// extensions/models/scaleway-key-manager/scaleway_key_manager.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Key Manager model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the key.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  keyId: z.string().optional().describe(
    "ID of the Key Manager key this model manages. Optional — `create` " +
      "provisions a new key and returns its ID; every other method requires it.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new key (CreateKey). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new key."),
  description: z.string().optional().describe(
    "Human-readable description of the key.",
  ),
  usageSymmetricEncryption: z.string().default("aes_256_gcm").describe(
    "Symmetric-encryption algorithm for the key, e.g. aes_256_gcm.",
  ),
  tags: z.array(z.string()).optional().describe(
    "Tags to attach to the new key.",
  ),
  unprotected: z.boolean().default(false).describe(
    "Whether the key can be deleted without first disabling protection.",
  ),
});

/** Arguments for the encrypt operation (Encrypt). */
const EncryptArgsSchema = z.object({
  plaintext: z.string().meta({ sensitive: true }).describe(
    "Base64-encoded plaintext to encrypt. SENSITIVE: never logged or stored.",
  ),
  associatedData: z.string().optional().describe(
    "Optional base64-encoded additional authenticated data (AAD). Not secret.",
  ),
});

/** Arguments for the decrypt operation (Decrypt). */
const DecryptArgsSchema = z.object({
  ciphertext: z.string().describe(
    "Ciphertext previously returned by encrypt. Not secret.",
  ),
  associatedData: z.string().optional().describe(
    "Optional base64-encoded additional authenticated data (AAD) used at encrypt time.",
  ),
});

/** Snapshot schema for a Key Manager key. Never contains plaintext or ciphertext. */
const KeySchema = z.object({
  id: z.string().describe("Key ID."),
  name: z.string().nullable().optional().describe("Key name."),
  state: z.string().describe(
    "Key state, e.g. enabled, disabled, pending_key_material.",
  ),
  usage: z.record(z.string(), z.unknown()).nullable().optional().describe(
    "Key usage descriptor, e.g. { symmetric_encryption: aes_256_gcm }.",
  ),
  rotationCount: z.number().nullable().optional().describe(
    "Number of times the key has been rotated.",
  ),
  region: z.string().describe("Region hosting the key."),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the key.",
  ),
  description: z.string().nullable().optional().describe("Key description."),
  tags: z.array(z.string()).nullable().optional().describe(
    "Tags attached to the key.",
  ),
  protected: z.boolean().nullable().optional().describe(
    "Whether the key is protected against deletion.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last-update timestamp (ISO 8601).",
  ),
  rotatedAt: z.string().nullable().optional().describe(
    "Last-rotation timestamp (ISO 8601).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/** Snapshot schema for an encrypt result. Ciphertext is not a secret. */
const CipherSchema = z.object({
  keyId: z.string().describe("ID of the key used to encrypt."),
  ciphertext: z.string().describe(
    "Base64 ciphertext returned by the API. Not secret.",
  ),
  associatedDataUsed: z.boolean().describe(
    "Whether additional authenticated data was supplied.",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/**
 * Snapshot schema for a decrypt result. The recovered `plaintext` is SENSITIVE
 * and is the only field on this model that ever carries plaintext; it is marked
 * sensitive so swamp masks it in display and logs.
 */
const PlaintextSchema = z.object({
  keyId: z.string().describe("ID of the key used to decrypt."),
  plaintext: z.string().meta({ sensitive: true }).describe(
    "Base64 recovered plaintext. SENSITIVE: masked, never logged.",
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
 * Map a raw Scaleway Key object (snake_case) to the camelCase snapshot shape.
 * Copies only key metadata; never copies key material, plaintext, or ciphertext.
 */
function toKeyResource(
  k: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    // Callers always supply an id: API responses carry one, and the delete
    // path passes the guarded keyId. The final "" is unreachable defensive
    // padding so the snapshot still satisfies KeySchema's required id.
    id: (k.id as string) ?? g.keyId ?? "",
    name: (k.name as string) ?? null,
    state: (k.state as string) ?? "unknown",
    usage: (k.usage as Record<string, unknown>) ?? null,
    rotationCount: (k.rotation_count as number) ?? null,
    region: (k.region as string) ?? g.region,
    projectId: (k.project_id as string) ?? g.projectId,
    description: (k.description as string) ?? null,
    tags: (k.tags as string[]) ?? null,
    protected: (k.protected as boolean) ?? null,
    createdAt: (k.created_at as string) ?? null,
    updatedAt: (k.updated_at as string) ?? null,
    rotatedAt: (k.rotated_at as string) ?? null,
    observedAt,
  };
}

const keysPath = (g: GlobalArgs): string =>
  `/key-manager/v1alpha1/regions/${g.region}/keys`;

/**
 * Resolve the managed key ID for methods that act on an *existing* key.
 *
 * `keyId` is optional in the global schema because `create` provisions the key
 * and learns its ID from the API — requiring it up front would force callers to
 * pass a throwaway placeholder just to satisfy validation. Methods that read,
 * mutate, or perform cryptographic operations on an existing key call this to
 * fail fast with an actionable message.
 */
function requireKeyId(g: GlobalArgs, method: string): string {
  if (!g.keyId) {
    throw new Error(
      `The "${method}" method requires globalArgs.keyId — the ID of an ` +
        `existing Key Manager key. Set keyId on the model, or run "create" ` +
        `first to provision one.`,
    );
  }
  return g.keyId;
}

// --- Model -----------------------------------------------------------------
/** Scaleway Key Manager model — one instance per key, keyed by keyId. */
export const model = {
  type: "@sntxrr/scaleway-key-manager",
  version: "2026.07.19.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "key": {
      description: "Snapshot of the Key Manager key's metadata (no secrets)",
      schema: KeySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "cipher": {
      description: "Result of an encrypt call — ciphertext only (non-secret)",
      schema: CipherSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "plaintext": {
      description:
        "Result of a decrypt call — recovered plaintext in a sensitive field",
      schema: PlaintextSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported Key Manager regions.",
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
      description: "Fetch the key's current metadata (GetKey).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const keyId = requireKeyId(g, "sync");
        logger.info("Syncing Scaleway KMS key {id}", { id: keyId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${keysPath(g)}/${encodeURIComponent(keyId)}`,
        );
        const handle = await context.writeResource(
          "key",
          keyId,
          toKeyResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway KMS key {id}", { id: keyId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Provision a new key (CreateKey) and snapshot its metadata.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway KMS key {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          usage: { symmetric_encryption: args.usageSymmetricEncryption },
          unprotected: args.unprotected,
        };
        if (args.description !== undefined) body.description = args.description;
        if (args.tags !== undefined) body.tags = args.tags;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          keysPath(g),
          body,
        );
        // CreateKey always returns the new ID; fall back to a preset keyId only
        // if the caller pinned one, so create never depends on it being set.
        const newId = (res.id as string) ?? g.keyId ?? "";
        const handle = await context.writeResource(
          "key",
          newId,
          toKeyResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway KMS key {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the key (DeleteKey).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const keyId = requireKeyId(g, "delete");
        logger.info("Deleting Scaleway KMS key {id}", { id: keyId });
        // Idempotent delete: a 404 means the key is already gone — treat it as
        // success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${keysPath(g)}/${encodeURIComponent(keyId)}`,
          );
        } catch (e) {
          // Idempotent delete: already-gone → success. Scaleway signals this as
          // a 404, OR a 412 "precondition failed" with precondition
          // "resource_not_usable" ("cannot act on deleted ...") once the key is
          // already deleted. Re-throw anything else (CONVENTIONS.md §3.2).
          const err = e as { status?: number; message?: string };
          const alreadyGone = err.status === 404 ||
            (err.status === 412 &&
              /resource_not_usable/.test(err.message ?? ""));
          if (!alreadyGone) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toKeyResource({ id: keyId, state: "absent" }, g, observedAt)
          : toKeyResource(res ?? { id: keyId }, g, observedAt);
        const handle = await context.writeResource("key", keyId, snapshot);
        logger.info("Deleted Scaleway KMS key {id} (absent={absent})", {
          id: keyId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    encrypt: {
      description:
        "Encrypt base64 plaintext with the key (Encrypt); snapshots only the ciphertext.",
      arguments: EncryptArgsSchema,
      execute: async (
        args: z.infer<typeof EncryptArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const keyId = requireKeyId(g, "encrypt");
        // Never log the plaintext; log only the key ID.
        logger.info("Encrypting with Scaleway KMS key {id}", { id: keyId });
        const body: Record<string, unknown> = { plaintext: args.plaintext };
        if (args.associatedData !== undefined) {
          body.associated_data = args.associatedData;
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${keysPath(g)}/${encodeURIComponent(keyId)}/encrypt`,
          body,
        );
        // Snapshot only the non-secret ciphertext — never the plaintext.
        const handle = await context.writeResource("cipher", keyId, {
          keyId: (res.key_id as string) ?? keyId,
          ciphertext: (res.ciphertext as string) ?? "",
          associatedDataUsed: args.associatedData !== undefined,
          observedAt: new Date().toISOString(),
        });
        logger.info("Encrypted with Scaleway KMS key {id}", { id: keyId });
        return { dataHandles: [handle] };
      },
    },
    decrypt: {
      description:
        "Decrypt ciphertext with the key (Decrypt); returns plaintext in a sensitive field.",
      arguments: DecryptArgsSchema,
      execute: async (
        args: z.infer<typeof DecryptArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const keyId = requireKeyId(g, "decrypt");
        logger.info("Decrypting with Scaleway KMS key {id}", { id: keyId });
        const body: Record<string, unknown> = { ciphertext: args.ciphertext };
        if (args.associatedData !== undefined) {
          body.associated_data = args.associatedData;
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${keysPath(g)}/${encodeURIComponent(keyId)}/decrypt`,
          body,
        );
        // Recovered plaintext is returned ONLY via the sensitive `plaintext`
        // field; it is never logged and never written to the key snapshot.
        const handle = await context.writeResource("plaintext", keyId, {
          keyId: (res.key_id as string) ?? keyId,
          plaintext: (res.plaintext as string) ?? "",
          observedAt: new Date().toISOString(),
        });
        logger.info("Decrypted with Scaleway KMS key {id}", { id: keyId });
        return { dataHandles: [handle] };
      },
    },
    rotate: {
      description: "Rotate the key's material (RotateKey) and re-snapshot it.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const keyId = requireKeyId(g, "rotate");
        logger.info("Rotating Scaleway KMS key {id}", { id: keyId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${keysPath(g)}/${encodeURIComponent(keyId)}/rotate`,
        );
        const handle = await context.writeResource(
          "key",
          keyId,
          toKeyResource(res, g, new Date().toISOString()),
        );
        logger.info("Rotated Scaleway KMS key {id}", { id: keyId });
        return { dataHandles: [handle] };
      },
    },
    protect: {
      description:
        "Enable deletion protection on the key (ProtectKey). A protected key " +
        "cannot be deleted until it is unprotected.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const keyId = requireKeyId(g, "protect");
        logger.info("Protecting Scaleway KMS key {id}", { id: keyId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${keysPath(g)}/${encodeURIComponent(keyId)}/protect`,
        );
        const handle = await context.writeResource(
          "key",
          keyId,
          toKeyResource(res, g, new Date().toISOString()),
        );
        logger.info("Protected Scaleway KMS key {id}", { id: keyId });
        return { dataHandles: [handle] };
      },
    },
    unprotect: {
      description:
        "Disable deletion protection on the key (UnprotectKey), allowing it to " +
        "be deleted.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const keyId = requireKeyId(g, "unprotect");
        logger.info("Unprotecting Scaleway KMS key {id}", { id: keyId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${keysPath(g)}/${encodeURIComponent(keyId)}/unprotect`,
        );
        const handle = await context.writeResource(
          "key",
          keyId,
          toKeyResource(res, g, new Date().toISOString()),
        );
        logger.info("Unprotected Scaleway KMS key {id}", { id: keyId });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all keys in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const keys = await scalewayListAll<Record<string, unknown>>(
          g,
          keysPath(g),
          "keys",
        );
        logger.info("Discovered {n} keys in {region}", {
          n: keys.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const k of keys) {
          handles.push(
            await context.writeResource(
              "key",
              (k.id as string) ?? crypto.randomUUID(),
              toKeyResource(k, g, now),
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
  toKeyResource,
  keysPath,
};
