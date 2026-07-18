/**
 * Scaleway Account (Projects) integration.
 *
 * Wraps the Scaleway Account API (`/account/v3`, **global** — no zone/region
 * segment in the path) so a swamp model represents a single Account Project,
 * keyed by its project ID (`projectId`). Exposes `sync`, `create`, `update`
 * (PATCH), `delete` (idempotent), and a factory `list` (every Project in the
 * Organization). Authenticated with the `X-Auth-Token` header (secret key wired
 * from a vault).
 *
 * Account/Projects is **Organization-scoped**: Projects belong to an
 * Organization, so this model takes an `organizationId` global argument (used
 * when creating and when listing). A labeled pre-flight check (`org-specified`)
 * auto-runs before the mutating verbs (`create`/`update`/`delete`) to ensure the
 * mutation targets a non-empty Organization.
 *
 * API reference: https://www.scaleway.com/en/developers/api/account/
 * @module
 */
// extensions/models/scaleway-account/scaleway_account.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Account (Projects) model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  organizationId: z.string().describe(
    "Scaleway Organization ID that owns the Project (used to create and to list).",
  ),
  projectId: z.string().describe(
    "ID of the Account Project this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for provisioning a new Account Project (CreateProject). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new Project."),
  description: z.string().optional().describe(
    "Optional human-readable description of the Project.",
  ),
});

/** Arguments for mutating an Account Project's mutable fields (UpdateProject). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the Project."),
  description: z.string().optional().describe(
    "New description for the Project.",
  ),
});

/** Snapshot schema for an Account Project. Never contains secrets. */
const ProjectSchema = z.object({
  id: z.string().describe("Project ID."),
  name: z.string().nullable().optional().describe("Project name."),
  description: z.string().nullable().optional().describe(
    "Project description.",
  ),
  organizationId: z.string().nullable().optional().describe(
    "Organization ID that owns the Project.",
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
/** Map a raw Scaleway Account Project (snake_case) to a camelCase snapshot. */
function toProjectResource(
  p: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (p.id as string) ?? g.projectId,
    name: (p.name as string) ?? null,
    description: (p.description as string) ?? null,
    organizationId: (p.organization_id as string) ?? g.organizationId,
    createdAt: (p.created_at as string) ?? null,
    updatedAt: (p.updated_at as string) ?? null,
    status: (p.status as string) ?? "present",
    observedAt,
  };
}

// --- Paths (global scope — no zone/region segment) -------------------------
/** Account Projects collection path (global scope). */
const projectsPath = (): string => `/account/v3/projects`;

// --- Model -----------------------------------------------------------------
/** Scaleway Account model — one instance per Project, keyed by projectId. */
export const model = {
  type: "@sntxrr/scaleway-account",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "project": {
      description: "Snapshot of the Account Project's state",
      schema: ProjectSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "org-specified": {
      description:
        "A Project mutation must target an Organization: globalArgs.organizationId must be set.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        const org = context.globalArgs.organizationId;
        if (!org || org.trim() === "") {
          return {
            pass: false,
            errors: [
              "globalArgs.organizationId is empty — a Project mutation must target an Organization.",
            ],
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    sync: {
      description: "Fetch the Account Project's current state (GetProject).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway Project {id}", { id: g.projectId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${projectsPath()}/${encodeURIComponent(g.projectId)}`,
        );
        const handle = await context.writeResource(
          "project",
          g.projectId,
          toProjectResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway Project {id}", { id: g.projectId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new Account Project (CreateProject) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway Project {name} in org {org}", {
          name: args.name,
          org: g.organizationId,
        });
        const body: Record<string, unknown> = {
          organization_id: g.organizationId,
          name: args.name,
        };
        if (args.description !== undefined) body.description = args.description;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          projectsPath(),
          body,
        );
        const newId = (res.id as string) ?? g.projectId;
        const handle = await context.writeResource(
          "project",
          newId,
          toProjectResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway Project {id}", { id: newId });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate an Account Project's mutable fields (UpdateProject, PATCH).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway Project {id}", { id: g.projectId });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.description !== undefined) body.description = args.description;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${projectsPath()}/${encodeURIComponent(g.projectId)}`,
          body,
        );
        const handle = await context.writeResource(
          "project",
          g.projectId,
          toProjectResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway Project {id}", { id: g.projectId });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the Account Project (DeleteProject).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway Project {id}", { id: g.projectId });
        // Idempotent delete: a 404 means the Project is already gone — treat it
        // as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${projectsPath()}/${encodeURIComponent(g.projectId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toProjectResource(
            { id: g.projectId, status: "absent" },
            g,
            observedAt,
          )
          : toProjectResource(
            res ?? { id: g.projectId, status: "absent" },
            g,
            observedAt,
          );
        const handle = await context.writeResource(
          "project",
          g.projectId,
          snapshot,
        );
        logger.info("Deleted Scaleway Project {id} (absent={absent})", {
          id: g.projectId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description:
        "Discover all Account Projects in the Organization (factory, paginated).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Discovering Projects in org {org}", {
          org: g.organizationId,
        });
        const projects = await scalewayListAll<Record<string, unknown>>(
          g,
          `${projectsPath()}?organization_id=${
            encodeURIComponent(g.organizationId)
          }`,
          "projects",
        );
        logger.info("Discovered {n} Projects", { n: projects.length });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const p of projects) {
          handles.push(
            await context.writeResource(
              "project",
              (p.id as string) ?? crypto.randomUUID(),
              toProjectResource(p, g, now),
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
  toProjectResource,
  projectsPath,
};
