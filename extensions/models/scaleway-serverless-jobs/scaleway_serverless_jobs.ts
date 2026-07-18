/**
 * Scaleway Serverless Jobs integration.
 *
 * Wraps the Scaleway Serverless Jobs API (`/serverless-jobs/v1alpha2`, regional)
 * so a swamp model represents a single job definition, keyed by its job
 * definition ID. Exposes `sync`, `create`, `update`, `delete`, a `run` `action`
 * (StartJobDefinition), and a factory `list`. Authenticated with the
 * `X-Auth-Token` header (secret key wired from a vault). Job environment
 * variables are sent to the API to provision or run a job but are never written
 * into a resource snapshot.
 *
 * API reference: https://www.scaleway.com/en/developers/api/serverless-jobs/
 * @module
 */
// extensions/models/scaleway-serverless-jobs/scaleway_serverless_jobs.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the Serverless Jobs model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the job definition.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  jobDefinitionId: z.string().describe(
    "ID of the Serverless Jobs job definition this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Optional cron schedule for a job definition. */
const CronScheduleSchema = z.object({
  schedule: z.string().describe(
    "UNIX cron schedule to run the job, e.g. '0 8 * * *'.",
  ),
  timezone: z.string().describe(
    "Timezone for the cron schedule, tz database format, e.g. 'Europe/Paris'.",
  ),
});

/** Arguments for provisioning a new job definition (CreateJobDefinition). */
const CreateArgsSchema = z.object({
  name: z.string().describe("Name of the new job definition."),
  cpuLimit: z.number().describe("CPU limit of the job (in mvCPU)."),
  memoryLimit: z.number().describe("Memory limit of the job (in MiB)."),
  localStorageCapacity: z.number().describe(
    "Local storage capacity of the job (in MiB).",
  ),
  imageUri: z.string().describe(
    "Container image to run for the job, e.g. rg.fr-par.scw.cloud/ns/app:latest.",
  ),
  startupCommand: z.array(z.string()).optional().describe(
    "Startup command (entrypoint) that overrides the image default.",
  ),
  args: z.array(z.string()).optional().describe(
    "Arguments passed to the startup command at runtime.",
  ),
  environmentVariables: z.record(z.string(), z.string()).optional().describe(
    "Environment variables for the job. Sent to provision; never stored in a snapshot.",
  ),
  description: z.string().optional().describe(
    "Human-readable description of the job definition.",
  ),
  jobTimeout: z.string().optional().describe(
    "Timeout of the job in seconds, e.g. '3600s'. Optional.",
  ),
  cronSchedule: CronScheduleSchema.optional().describe(
    "Optional cron schedule to run the job automatically.",
  ),
});

/** Arguments for mutating a job definition's mutable fields (UpdateJobDefinition). */
const UpdateArgsSchema = z.object({
  name: z.string().optional().describe("New name for the job definition."),
  cpuLimit: z.number().optional().describe("New CPU limit (in mvCPU)."),
  memoryLimit: z.number().optional().describe("New memory limit (in MiB)."),
  localStorageCapacity: z.number().optional().describe(
    "New local storage capacity (in MiB).",
  ),
  imageUri: z.string().optional().describe("New container image to run."),
  startupCommand: z.array(z.string()).optional().describe(
    "New startup command (entrypoint).",
  ),
  args: z.array(z.string()).optional().describe(
    "New arguments passed to the startup command.",
  ),
  environmentVariables: z.record(z.string(), z.string()).optional().describe(
    "Replacement environment variables. Sent to update; never stored in a snapshot.",
  ),
  description: z.string().optional().describe("New description."),
  jobTimeout: z.string().optional().describe(
    "New timeout of the job in seconds, e.g. '3600s'.",
  ),
  cronSchedule: CronScheduleSchema.optional().describe(
    "New cron schedule for the job.",
  ),
});

/** Arguments for running a job definition (StartJobDefinition — the `run` action). */
const RunArgsSchema = z.object({
  startupCommand: z.array(z.string()).optional().describe(
    "Contextual startup command for this specific job run.",
  ),
  args: z.array(z.string()).optional().describe(
    "Contextual arguments for this specific job run.",
  ),
  environmentVariables: z.record(z.string(), z.string()).optional().describe(
    "Contextual environment variables for this run. Sent to run; never stored in a snapshot.",
  ),
  replicas: z.number().optional().describe(
    "Number of parallel job runs to start. Optional; API default applies.",
  ),
});

/** Snapshot schema for a job definition. Never contains environment variables. */
const JobDefinitionSchema = z.object({
  id: z.string().describe("Job definition ID."),
  name: z.string().nullable().optional().describe("Job definition name."),
  state: z.string().describe(
    "Snapshot lifecycle state as observed by swamp: present or absent.",
  ),
  projectId: z.string().nullable().optional().describe(
    "ID of the project that owns the job definition.",
  ),
  cpuLimit: z.number().nullable().optional().describe(
    "CPU limit of the job (in mvCPU).",
  ),
  memoryLimit: z.number().nullable().optional().describe(
    "Memory limit of the job (in MiB).",
  ),
  localStorageCapacity: z.number().nullable().optional().describe(
    "Local storage capacity of the job (in MiB).",
  ),
  imageUri: z.string().nullable().optional().describe(
    "Container image the job runs.",
  ),
  jobTimeout: z.string().nullable().optional().describe(
    "Timeout of the job in seconds.",
  ),
  description: z.string().nullable().optional().describe(
    "Human-readable description of the job definition.",
  ),
  cronSchedule: z.string().nullable().optional().describe(
    "Cron schedule expression, if the job is scheduled.",
  ),
  region: z.string().describe("Region hosting the job definition."),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (RFC 3339).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last update timestamp (RFC 3339).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/** Snapshot schema for a job run. Never contains environment variables. */
const JobRunSchema = z.object({
  id: z.string().describe("Job run ID."),
  jobDefinitionId: z.string().nullable().optional().describe(
    "ID of the job definition this run belongs to.",
  ),
  state: z.string().describe(
    "State of the job run, e.g. queued, running, succeeded, failed.",
  ),
  cpuLimit: z.number().nullable().optional().describe(
    "CPU limit of the run (in mvCPU).",
  ),
  memoryLimit: z.number().nullable().optional().describe(
    "Memory limit of the run (in MiB).",
  ),
  exitCode: z.number().nullable().optional().describe(
    "Exit code of the job process, if terminated.",
  ),
  errorMessage: z.string().nullable().optional().describe(
    "Error message, if the run failed.",
  ),
  region: z.string().describe("Region hosting the job run."),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (RFC 3339).",
  ),
  startedAt: z.string().nullable().optional().describe(
    "Start timestamp (RFC 3339).",
  ),
  terminatedAt: z.string().nullable().optional().describe(
    "Termination timestamp (RFC 3339).",
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
 * Map a raw Scaleway job definition object (snake_case) to the camelCase
 * snapshot shape. Copies only non-secret configuration and status fields;
 * environment variables are never copied into the snapshot.
 */
function toJobDefinitionResource(
  j: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
  state = "present",
): Record<string, unknown> {
  const cron = j.cron_schedule as Record<string, unknown> | null | undefined;
  return {
    id: (j.id as string) ?? g.jobDefinitionId,
    name: (j.name as string) ?? null,
    state,
    projectId: (j.project_id as string) ?? g.projectId,
    cpuLimit: (j.cpu_limit as number) ?? null,
    memoryLimit: (j.memory_limit as number) ?? null,
    localStorageCapacity: (j.local_storage_capacity as number) ?? null,
    imageUri: (j.image_uri as string) ?? null,
    jobTimeout: (j.job_timeout as string) ?? null,
    description: (j.description as string) ?? null,
    cronSchedule: (cron?.schedule as string) ?? null,
    region: (j.region as string) ?? g.region,
    createdAt: (j.created_at as string) ?? null,
    updatedAt: (j.updated_at as string) ?? null,
    observedAt,
  };
}

/**
 * Map a raw Scaleway job run object (snake_case) to the camelCase snapshot
 * shape. Copies only non-secret status fields; environment variables are never
 * copied into the snapshot.
 */
function toJobRunResource(
  r: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (r.id as string) ?? "",
    jobDefinitionId: (r.job_definition_id as string) ?? g.jobDefinitionId,
    state: (r.state as string) ?? "unknown",
    cpuLimit: (r.cpu_limit as number) ?? null,
    memoryLimit: (r.memory_limit as number) ?? null,
    exitCode: (r.exit_code as number) ?? null,
    errorMessage: (r.error_message as string) ?? null,
    region: (r.region as string) ?? g.region,
    createdAt: (r.created_at as string) ?? null,
    startedAt: (r.started_at as string) ?? null,
    terminatedAt: (r.terminated_at as string) ?? null,
    observedAt,
  };
}

const jobDefinitionsPath = (g: GlobalArgs): string =>
  `/serverless-jobs/v1alpha2/regions/${g.region}/job-definitions`;

// --- Model -----------------------------------------------------------------
/** Scaleway Serverless Jobs model — one instance per job definition, keyed by jobDefinitionId. */
export const model = {
  type: "@sntxrr/scaleway-serverless-jobs",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "job-definition": {
      description: "Snapshot of the Serverless Jobs job definition's state",
      schema: JobDefinitionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "job-run": {
      description: "Snapshot of a job run started from the job definition",
      schema: JobRunSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported Serverless Jobs regions.",
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
      description:
        "Fetch the job definition's current state (GetJobDefinition).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway job definition {id}", {
          id: g.jobDefinitionId,
        });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${jobDefinitionsPath(g)}/${encodeURIComponent(g.jobDefinitionId)}`,
        );
        const handle = await context.writeResource(
          "job-definition",
          g.jobDefinitionId,
          toJobDefinitionResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway job definition {id}", {
          id: g.jobDefinitionId,
        });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Provision a new job definition (CreateJobDefinition) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway job definition {name} in {region}", {
          name: args.name,
          region: g.region,
        });
        // Environment variables are sent to provision but never logged or
        // stored in a snapshot.
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          name: args.name,
          cpu_limit: args.cpuLimit,
          memory_limit: args.memoryLimit,
          local_storage_capacity: args.localStorageCapacity,
          image_uri: args.imageUri,
        };
        if (args.startupCommand !== undefined) {
          body.startup_command = args.startupCommand;
        }
        if (args.args !== undefined) body.args = args.args;
        if (args.environmentVariables !== undefined) {
          body.environment_variables = args.environmentVariables;
        }
        if (args.description !== undefined) body.description = args.description;
        if (args.jobTimeout !== undefined) body.job_timeout = args.jobTimeout;
        if (args.cronSchedule !== undefined) {
          body.cron_schedule = args.cronSchedule;
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          jobDefinitionsPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.jobDefinitionId;
        const handle = await context.writeResource(
          "job-definition",
          newId,
          toJobDefinitionResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway job definition {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Mutate a job definition's mutable fields (UpdateJobDefinition).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Updating Scaleway job definition {id}", {
          id: g.jobDefinitionId,
        });
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.cpuLimit !== undefined) body.cpu_limit = args.cpuLimit;
        if (args.memoryLimit !== undefined) {
          body.memory_limit = args.memoryLimit;
        }
        if (args.localStorageCapacity !== undefined) {
          body.local_storage_capacity = args.localStorageCapacity;
        }
        if (args.imageUri !== undefined) body.image_uri = args.imageUri;
        if (args.startupCommand !== undefined) {
          body.startup_command = args.startupCommand;
        }
        if (args.args !== undefined) body.args = args.args;
        if (args.environmentVariables !== undefined) {
          body.environment_variables = args.environmentVariables;
        }
        if (args.description !== undefined) body.description = args.description;
        if (args.jobTimeout !== undefined) body.job_timeout = args.jobTimeout;
        if (args.cronSchedule !== undefined) {
          body.cron_schedule = args.cronSchedule;
        }
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "PATCH",
          `${jobDefinitionsPath(g)}/${encodeURIComponent(g.jobDefinitionId)}`,
          body,
        );
        const handle = await context.writeResource(
          "job-definition",
          g.jobDefinitionId,
          toJobDefinitionResource(res, g, new Date().toISOString()),
        );
        logger.info("Updated Scaleway job definition {id}", {
          id: g.jobDefinitionId,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Deprovision the job definition (DeleteJobDefinition).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway job definition {id}", {
          id: g.jobDefinitionId,
        });
        // Idempotent delete: a 404 means the job definition is already gone —
        // treat it as success and record an absent snapshot (CONVENTIONS.md §3.2).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            `${jobDefinitionsPath(g)}/${encodeURIComponent(g.jobDefinitionId)}`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toJobDefinitionResource(
            { id: g.jobDefinitionId },
            g,
            observedAt,
            "absent",
          )
          : toJobDefinitionResource(
            res ?? { id: g.jobDefinitionId },
            g,
            observedAt,
          );
        const handle = await context.writeResource(
          "job-definition",
          g.jobDefinitionId,
          snapshot,
        );
        logger.info("Deleted Scaleway job definition {id} (absent={absent})", {
          id: g.jobDefinitionId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    action: {
      description:
        "Run the job definition, starting one or more job runs (StartJobDefinition).",
      arguments: RunArgsSchema,
      execute: async (
        args: z.infer<typeof RunArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Running Scaleway job definition {id}", {
          id: g.jobDefinitionId,
        });
        // Contextual environment variables are sent to run but never stored.
        const body: Record<string, unknown> = {};
        if (args.startupCommand !== undefined) {
          body.startup_command = args.startupCommand;
        }
        if (args.args !== undefined) body.args = args.args;
        if (args.environmentVariables !== undefined) {
          body.environment_variables = args.environmentVariables;
        }
        if (args.replicas !== undefined) body.replicas = args.replicas;
        const res = await scalewayFetch<{ job_runs?: unknown }>(
          g,
          "POST",
          `${jobDefinitionsPath(g)}/${
            encodeURIComponent(g.jobDefinitionId)
          }/start`,
          body,
        );
        const runs =
          (res.job_runs as Array<Record<string, unknown>> | undefined) ?? [];
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const r of runs) {
          handles.push(
            await context.writeResource(
              "job-run",
              (r.id as string) ?? crypto.randomUUID(),
              toJobRunResource(r, g, now),
            ),
          );
        }
        logger.info("Started {n} job run(s) for job definition {id}", {
          n: runs.length,
          id: g.jobDefinitionId,
        });
        return { dataHandles: handles };
      },
    },
    list: {
      description: "Discover all job definitions in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const jobs = await scalewayListAll<Record<string, unknown>>(
          g,
          jobDefinitionsPath(g),
          "job_definitions",
        );
        logger.info("Discovered {n} job definitions in {region}", {
          n: jobs.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const j of jobs) {
          handles.push(
            await context.writeResource(
              "job-definition",
              (j.id as string) ?? crypto.randomUUID(),
              toJobDefinitionResource(j, g, now),
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
  toJobDefinitionResource,
  toJobRunResource,
  jobDefinitionsPath,
};
