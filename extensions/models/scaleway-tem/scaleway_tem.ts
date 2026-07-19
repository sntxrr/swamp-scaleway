/**
 * Scaleway Transactional Email (TEM) integration.
 *
 * Wraps the Scaleway Transactional Email API (`/transactional-email/v1alpha1`,
 * regional) so a swamp model represents a single sending domain, keyed by its
 * domain ID. Exposes `sync`, `create`, `delete`, a factory `list` (domains), and
 * a factory `list-emails` (sent emails). Authenticated with the `X-Auth-Token`
 * header (secret key wired from a vault). Snapshots record non-secret domain and
 * email metadata only; the DKIM private key is never fetched, logged, or stored.
 *
 * API reference: https://www.scaleway.com/en/developers/api/transactional-email/
 * @module
 */
// extensions/models/scaleway-tem/scaleway_tem.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
/** Global arguments shared by every method on the TEM model. */
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the sending domain.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  domainId: z.string().describe(
    "ID of the Transactional Email domain this model manages.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for registering a new sending domain (CreateDomain). */
const CreateArgsSchema = z.object({
  domainName: z.string().describe(
    "Fully-qualified domain name to register for sending, e.g. mail.example.com.",
  ),
  acceptTos: z.boolean().default(false).describe(
    "Acknowledge acceptance of Scaleway's Transactional Email terms of service.",
  ),
  autoconfig: z.boolean().optional().describe(
    "Attempt automatic DNS configuration where the registrar supports it.",
  ),
});

/** Snapshot schema for a Transactional Email sending domain. Never contains secrets. */
const DomainSchema = z.object({
  id: z.string().describe("Domain ID."),
  domainName: z.string().nullable().optional().describe(
    "Fully-qualified sending domain name.",
  ),
  status: z.string().describe(
    "Domain status, e.g. checked, unchecked, invalid, revoked, pending.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the domain.",
  ),
  region: z.string().describe("Region hosting the domain."),
  lastError: z.string().nullable().optional().describe(
    "Most recent validation or delivery error reported for the domain.",
  ),
  reputation: z.string().nullable().optional().describe(
    "Reputation tier of the domain when reported by the API.",
  ),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "Last update timestamp (ISO 8601).",
  ),
  observedAt: z.string().describe(
    "Timestamp when this snapshot was taken (ISO 8601).",
  ),
});

/** Snapshot schema for a single sent transactional email. Never contains secrets. */
const EmailSchema = z.object({
  id: z.string().describe("Email ID."),
  subject: z.string().nullable().optional().describe("Email subject line."),
  status: z.string().describe(
    "Email status: new, sending, sent, failed, or canceled.",
  ),
  fromEmail: z.string().nullable().optional().describe(
    "Sender email address.",
  ),
  toEmails: z.array(z.string()).nullable().optional().describe(
    "Recipient email addresses.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the email.",
  ),
  region: z.string().describe("Region that handled the email."),
  createdAt: z.string().nullable().optional().describe(
    "Creation timestamp (ISO 8601).",
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
 * Map a raw Scaleway TEM domain object (snake_case) to the camelCase snapshot
 * shape. The DKIM private key is never read or copied — only public,
 * non-secret metadata is retained.
 */
function toDomainResource(
  d: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (d.id as string) ?? g.domainId,
    domainName: (d.domain_name as string) ?? (d.name as string) ?? null,
    status: (d.status as string) ?? "unknown",
    projectId: (d.project_id as string) ?? null,
    region: (d.region as string) ?? g.region,
    lastError: (d.last_error as string) ?? null,
    reputation: ((d.reputation as Record<string, unknown> | null | undefined)
      ?.status as string) ?? null,
    createdAt: (d.created_at as string) ?? null,
    updatedAt: (d.updated_at as string) ?? null,
    observedAt,
  };
}

/**
 * Map a raw Scaleway TEM email object (snake_case) to the camelCase snapshot
 * shape. Recipient/sender addresses are non-secret metadata; no message body or
 * credential is stored.
 */
function toEmailResource(
  e: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const from = e.from as Record<string, unknown> | null | undefined;
  const toRaw = e.to as Array<Record<string, unknown>> | null | undefined;
  const toEmails = Array.isArray(toRaw)
    ? toRaw
      .map((r) => (r?.email as string) ?? null)
      .filter((v): v is string => typeof v === "string")
    : null;
  return {
    id: (e.id as string) ?? "unknown",
    subject: (e.subject as string) ?? null,
    status: (e.status as string) ?? "unknown",
    fromEmail: (from?.email as string) ?? null,
    toEmails,
    projectId: (e.project_id as string) ?? null,
    region: (e.region as string) ?? g.region,
    createdAt: (e.created_at as string) ?? null,
    observedAt,
  };
}

const domainsPath = (g: GlobalArgs): string =>
  `/transactional-email/v1alpha1/regions/${g.region}/domains`;

const emailsPath = (g: GlobalArgs): string =>
  `/transactional-email/v1alpha1/regions/${g.region}/emails`;

// --- Model -----------------------------------------------------------------
/** Scaleway Transactional Email model — one instance per sending domain, keyed by domainId. */
export const model = {
  type: "@sntxrr/scaleway-tem",
  version: "2026.07.18.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "domain": {
      description: "Snapshot of the Transactional Email sending domain's state",
      schema: DomainSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "email": {
      description: "Snapshot of a single sent transactional email",
      schema: EmailSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure the target region is one of Scaleway's supported regions.",
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
      description: "Fetch the sending domain's current state (GetDomain).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway TEM domain {id}", { id: g.domainId });
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "GET",
          `${domainsPath(g)}/${encodeURIComponent(g.domainId)}`,
        );
        const handle = await context.writeResource(
          "domain",
          g.domainId,
          toDomainResource(res, g, new Date().toISOString()),
        );
        logger.info("Synced Scaleway TEM domain {id}", { id: g.domainId });
        return { dataHandles: [handle] };
      },
    },
    create: {
      description:
        "Register a new sending domain (CreateDomain) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating Scaleway TEM domain {name} in {region}", {
          name: args.domainName,
          region: g.region,
        });
        const body: Record<string, unknown> = {
          project_id: g.projectId,
          domain_name: args.domainName,
          accept_tos: args.acceptTos,
        };
        if (args.autoconfig !== undefined) body.autoconfig = args.autoconfig;
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          domainsPath(g),
          body,
        );
        const newId = (res.id as string) ?? g.domainId;
        const handle = await context.writeResource(
          "domain",
          newId,
          toDomainResource(res, g, new Date().toISOString()),
        );
        logger.info("Created Scaleway TEM domain {id} in {region}", {
          id: newId,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description:
        "Delete the sending domain (DeleteDomain — POST .../{id}/delete).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting Scaleway TEM domain {id}", { id: g.domainId });
        // Idempotent delete: a 404 means the domain is already gone — treat it
        // as success and record an absent snapshot (CONVENTIONS.md §3.2).
        // Scaleway TEM deletes via POST .../domains/{id}/delete (not DELETE).
        let res: Record<string, unknown> | undefined;
        let absent = false;
        try {
          res = await scalewayFetch<Record<string, unknown>>(
            g,
            "POST",
            `${domainsPath(g)}/${encodeURIComponent(g.domainId)}/delete`,
          );
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          absent = true;
        }
        const observedAt = new Date().toISOString();
        const snapshot = absent
          ? toDomainResource(
            { id: g.domainId, status: "revoked" },
            g,
            observedAt,
          )
          : toDomainResource(res ?? { id: g.domainId }, g, observedAt);
        const handle = await context.writeResource(
          "domain",
          g.domainId,
          snapshot,
        );
        logger.info("Deleted Scaleway TEM domain {id} (absent={absent})", {
          id: g.domainId,
          absent,
        });
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all sending domains in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const domains = await scalewayListAll<Record<string, unknown>>(
          g,
          domainsPath(g),
          "domains",
        );
        logger.info("Discovered {n} domains in {region}", {
          n: domains.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const d of domains) {
          handles.push(
            await context.writeResource(
              "domain",
              (d.id as string) ?? crypto.randomUUID(),
              toDomainResource(d, g, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "list-emails": {
      description:
        "Discover all sent transactional emails in the region (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const emails = await scalewayListAll<Record<string, unknown>>(
          g,
          emailsPath(g),
          "emails",
        );
        logger.info("Discovered {n} emails in {region}", {
          n: emails.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const e of emails) {
          handles.push(
            await context.writeResource(
              "email",
              (e.id as string) ?? crypto.randomUUID(),
              toEmailResource(e, g, now),
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
  toDomainResource,
  toEmailResource,
  domainsPath,
  emailsPath,
};
