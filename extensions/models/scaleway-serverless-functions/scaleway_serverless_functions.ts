/**
 * Scaleway Serverless Functions integration.
 *
 * Wraps the Scaleway Serverless Functions API (`/functions/v1beta1`, regional)
 * so a swamp model represents a single serverless function, keyed by its
 * function ID. Exposes `sync`, `create`, `update`, `delete`, an `action`
 * (deploy), a factory `list` (functions), and a factory `list-namespaces`.
 * Authenticated with the `X-Auth-Token` header (secret key wired from a vault).
 * Secret environment variables passed to `create`/`update` are sent to the API
 * to provision but are never logged or written into a resource snapshot.
 *
 * API reference: https://www.scaleway.com/en/developers/api/serverless-functions/
 * @module
 */
// extensions/models/scaleway-serverless-functions/scaleway_serverless_functions.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Serverless Functions model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the function and namespace.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  functionId: z.string().describe(
    "ID of the serverless function this model manages.",
  ),
  namespaceId: z.string().optional().describe(
    "ID of the namespace that owns the function (required for create; also " +
      "used to scope function discovery in list).",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new function (CreateFunction). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new function."),
  runtime: z.string().describe(
    "Function runtime, e.g. node22, python312, go123.",
  ),
  privacy: z.string().default("unknown_privacy").describe(
    "Privacy type: public (no auth) or private (token-gated).",
  ),
  handler: z.string().optional().describe(
    "Handler entrypoint, e.g. handler.handle.",
  ),
  memoryLimit: z.number().optional().describe(
    "Memory allocation in MB (e.g. 128, 256, 512).",
  ),
  minScale: z.number().optional().describe(
    "Minimum number of running instances.",
  ),
  maxScale: z.number().optional().describe(
    "Maximum number of running instances.",
  ),
  timeout: z.string().optional().describe(
    "Request timeout as a duration string, e.g. 300s.",
  ),
  description: z.string().optional().describe("Description of the function."),
  environmentVariables: z.record(z.string(), z.string()).optional().describe(
    "Non-secret environment variables (key/value map).",
  ),
  secretEnvironmentVariables: z.record(z.string(), z.string()).meta({
    sensitive: true,
  }).optional().describe(
    "Secret environment variables (key/value map). Sent only to provision; " +
      "never stored.",
  ),
  httpOption: z.string().optional().describe(
    "HTTP option: enabled (HTTP+HTTPS) or redirected (HTTPS only).",
  ),
});

/** Arguments for mutating a function's mutable fields (UpdateFunction). */
const UpdateArgsSchema = z.object({
  runtime: z.string().optional().describe("New runtime for the function."),
  privacy: z.string().optional().describe("New privacy type."),
  handler: z.string().optional().describe("New handler entrypoint."),
  memoryLimit: z.number().optional().describe("New memory allocation in MB."),
  minScale: z.number().optional().describe("New minimum instance count."),
  maxScale: z.number().optional().describe("New maximum instance count."),
  timeout: z.string().optional().describe("New request timeout, e.g. 300s."),
  description: z.string().optional().describe("New description."),
  environmentVariables: z.record(z.string(), z.string()).optional().describe(
    "Replacement set of non-secret environment variables.",
  ),
  secretEnvironmentVariables: z.record(z.string(), z.string()).meta({
    sensitive: true,
  }).optional().describe(
    "Replacement set of secret environment variables. Sent only; never stored.",
  ),
  httpOption: z.string().optional().describe("New HTTP option."),
});

/** Arguments for a lifecycle action on the function (e.g. deploy). */
const ActionArgsSchema = z.object({
  op: z.enum(["deploy"]).default("deploy").describe(
    "Lifecycle operation to perform. deploy builds and rolls out the function.",
  ),
});

/** Snapshot schema for a serverless function. Never contains secrets. */
const FunctionSchema = z.object({
  id: z.string().describe("Function ID."),
  name: z.string().nullable().optional().describe("Function name."),
  namespaceId: z.string().nullable().optional().describe(
    "ID of the owning namespace.",
  ),
  status: z.string().describe(
    "Function status, e.g. ready, created, pending, deploying, error.",
  ),
  runtime: z.string().nullable().optional().describe("Function runtime."),
  handler: z.string().nullable().optional().describe("Handler entrypoint."),
  privacy: z.string().nullable().optional().describe("Privacy type."),
  memoryLimit: z.number().nullable().optional().describe("Memory in MB."),
  cpuLimit: z.number().nullable().optional().describe("CPU limit in mVCPU."),
  minScale: z.number().nullable().optional().describe(
    "Minimum instance count.",
  ),
  maxScale: z.number().nullable().optional().describe(
    "Maximum instance count.",
  ),
  timeout: z.string().nullable().optional().describe("Request timeout."),
  domainName: z.string().nullable().optional().describe(
    "Public domain name of the function.",
  ),
  httpOption: z.string().nullable().optional().describe("HTTP option."),
  region: z.string().describe("Region hosting the function."),
  description: z.string().nullable().optional().describe(
    "Function description.",
  ),
  errorMessage: z.string().nullable().optional().describe(
    "Last error message, if any.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/** Snapshot schema for a function namespace. Never contains secrets. */
const NamespaceSchema = z.object({
  id: z.string().describe("Namespace ID."),
  name: z.string().nullable().optional().describe("Namespace name."),
  status: z.string().describe(
    "Namespace status, e.g. ready, pending, error.",
  ),
  region: z.string().describe("Region hosting the namespace."),
  projectId: z.string().nullable().optional().describe("Owning project ID."),
  registryEndpoint: z.string().nullable().optional().describe(
    "Container registry endpoint for the namespace.",
  ),
  description: z.string().nullable().optional().describe(
    "Namespace description.",
  ),
  errorMessage: z.string().nullable().optional().describe(
    "Last error message, if any.",
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
 * Map a raw Scaleway function object (snake_case) to the camelCase snapshot
 * shape. Never copies any environment-variable secret into the snapshot.
 */
function toFunctionResource(
  f: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (f.id as string) ?? g.functionId,
    name: (f.name as string) ?? null,
    namespaceId: (f.namespace_id as string) ?? g.namespaceId ?? null,
    status: (f.status as string) ?? "unknown",
    runtime: (f.runtime as string) ?? null,
    handler: (f.handler as string) ?? null,
    privacy: (f.privacy as string) ?? null,
    memoryLimit: (f.memory_limit as number) ?? null,
    cpuLimit: (f.cpu_limit as number) ?? null,
    minScale: (f.min_scale as number) ?? null,
    maxScale: (f.max_scale as number) ?? null,
    timeout: (f.timeout as string) ?? null,
    domainName: (f.domain_name as string) ?? null,
    httpOption: (f.http_option as string) ?? null,
    region: (f.region as string) ?? g.region,
    description: (f.description as string) ?? null,
    errorMessage: (f.error_message as string) ?? null,
    createdAt: (f.created_at as string) ?? null,
    observedAt,
  };
}

/**
 * Map a raw Scaleway namespace object (snake_case) to the camelCase snapshot
 * shape. Never copies any environment-variable secret into the snapshot.
 */
function toNamespaceResource(
  n: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (n.id as string) ?? "",
    name: (n.name as string) ?? null,
    status: (n.status as string) ?? "unknown",
    region: (n.region as string) ?? g.region,
    projectId: (n.project_id as string) ?? null,
    registryEndpoint: (n.registry_endpoint as string) ?? null,
    description: (n.description as string) ?? null,
    errorMessage: (n.error_message as string) ?? null,
    observedAt,
  };
}

const functionsPath = (g: GlobalArgs): string =>
  `/functions/v1beta1/regions/${g.region}/functions`;

const namespacesPath = (g: GlobalArgs): string =>
  `/functions/v1beta1/regions/${g.region}/namespaces`;

// --- Model -----------------------------------------------------------------
/** Scaleway Serverless Functions model — one instance per function, keyed by functionId. */
export const model = {
  type: "@sntxrr/scaleway-serverless-functions",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "function": {
      description: "Snapshot of the serverless function's state",
      schema: FunctionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "namespace": {
      description: "Snapshot of a function namespace's state",
      schema: NamespaceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported Functions regions.",
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
      description: "Fetch the function's current state (GetFunction).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway function {id}", { id: g.functionId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${functionsPath(g)}/${encodeURIComponent(g.functionId)}`,
        );
        const handle = await context.writeResource(
          "function",
          g.functionId,
          toFunctionResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway function {id}", { id: g.functionId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description: "Provision a new function (CreateFunction) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway function {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        // Secret env vars are sent to provision but are never logged or stored.
        const body: Record<string, unknown> = {
          name: args.name,
          namespace_id: g.namespaceId,
          runtime: args.runtime,
          privacy: args.privacy,
        };
        if (args.handler !== undefined) body.handler = args.handler;
        if (args.memoryLimit !== undefined) {
          body.memory_limit = args.memoryLimit;
        }
        if (args.minScale !== undefined) body.min_scale = args.minScale;
        if (args.maxScale !== undefined) body.max_scale = args.maxScale;
        if (args.timeout !== undefined) body.timeout = args.timeout;
        if (args.description !== undefined) body.description = args.description;
        if (args.environmentVariables !== undefined) {
          body.environment_variables = args.environmentVariables;
        }
        if (args.secretEnvironmentVariables !== undefined) {
          body.secret_environment_variables = Object.entries(
            args.secretEnvironmentVariables,
          ).map(([key, value]) => ({ key, value }));
        }
        if (args.httpOption !== undefined) body.http_option = args.httpOption;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          functionsPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.functionId;
        const handle = await context.writeResource(
          "function",
          newId,
          toFunctionResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway function {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description: "Mutate a function's mutable fields (UpdateFunction).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway function {id}", { id: g.functionId });
        const body: Record<string, unknown> = {};
        if (args.runtime !== undefined) body.runtime = args.runtime;
        if (args.privacy !== undefined) body.privacy = args.privacy;
        if (args.handler !== undefined) body.handler = args.handler;
        if (args.memoryLimit !== undefined) {
          body.memory_limit = args.memoryLimit;
        }
        if (args.minScale !== undefined) body.min_scale = args.minScale;
        if (args.maxScale !== undefined) body.max_scale = args.maxScale;
        if (args.timeout !== undefined) body.timeout = args.timeout;
        if (args.description !== undefined) body.description = args.description;
        if (args.environmentVariables !== undefined) {
          body.environment_variables = args.environmentVariables;
        }
        if (args.secretEnvironmentVariables !== undefined) {
          body.secret_environment_variables = Object.entries(
            args.secretEnvironmentVariables,
          ).map(([key, value]) => ({ key, value }));
        }
        if (args.httpOption !== undefined) body.http_option = args.httpOption;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${functionsPath(g)}/${encodeURIComponent(g.functionId)}`,
          body,
        );
        const handle = await context.writeResource(
          "function",
          g.functionId,
          toFunctionResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway function {id}", { id: g.functionId });
        return { dataHandles: [handle] };
      },
    },
    action: {
      description:
        "Perform a lifecycle operation on the function. op=deploy builds and " +
        "rolls out the latest code (DeployFunction).",
      arguments: ActionArgsSchema,
      execute: async (
        args: z.infer<typeof ActionArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Function {id} action {op}", {
          id: g.functionId,
          op: args.op,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          `${functionsPath(g)}/${encodeURIComponent(g.functionId)}/deploy`,
          {},
        );
        const handle = await context.writeResource(
          "function",
          g.functionId,
          toFunctionResource(res, g, new Date().toISOString()),
        );
        logger.info("Function {id} deployed", { id: g.functionId });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the function (DeleteFunction).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway function {id}", { id: g.functionId });
        // Idempotent delete: a 404 means the function is already gone — treat
        // it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${functionsPath(g)}/${encodeURIComponent(g.functionId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toFunctionResource(
            { id: g.functionId, status: "absent" },
            g,
            observedAt,
          )
          : toFunctionResource(res ?? { id: g.functionId }, g, observedAt);
        const handle = await context.writeResource(
          "function",
          g.functionId,
          snapshot,
        );
        logger.info("Deleted Scaleway function {id} (absent={absent})", {
          id: g.functionId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all functions in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        // Optionally scope discovery to the configured namespace.
        const path = g.namespaceId !== undefined
          ? `${functionsPath(g)}?namespace_id=${
            encodeURIComponent(g.namespaceId)
          }`
          : functionsPath(g);
        const functions = await scalewayListAll<Record<string, unknown>>(
          g,
          path,
          "functions",
        );
        logger.info("Discovered {n} functions in {region}", {
          n: functions.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const f of functions) {
          handles.push(
            await context.writeResource(
              "function",
              (f.id as string) ?? crypto.randomUUID(),
              toFunctionResource(f, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-namespaces": {
      description: "Discover all function namespaces in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const namespaces = await scalewayListAll<Record<string, unknown>>(
          g,
          namespacesPath(g),
          "namespaces",
        );
        logger.info("Discovered {n} namespaces in {region}", {
          n: namespaces.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const n of namespaces) {
          handles.push(
            await context.writeResource(
              "namespace",
              (n.id as string) ?? crypto.randomUUID(),
              toNamespaceResource(n, g, now),
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
  toFunctionResource,
  toNamespaceResource,
  functionsPath,
  namespacesPath,
};
