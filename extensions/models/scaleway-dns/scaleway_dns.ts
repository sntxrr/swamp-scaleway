/**
 * Scaleway Domains & DNS integration.
 *
 * Wraps the Scaleway Domains and DNS API (`/domain/v2beta1`, **global** — no
 * zone/region segment in the path) so a swamp model represents a single managed
 * DNS zone, keyed by its domain name (`dnsZone`). Exposes `sync` /
 * `list-records` (snapshot every record in the zone), a factory `list-zones`
 * (snapshot every DNS zone in the project), `create` / `delete` (provision or
 * deprovision the zone itself), and `update` (apply a batch of
 * add/set/delete/clear record changes via PATCH). Authenticated with the
 * `X-Auth-Token` header (secret key wired from a vault).
 *
 * A labeled pre-flight check (`zone-specified`) auto-runs before `create`,
 * `update`, and `delete` (the mutating verbs) to ensure the mutation targets a
 * non-empty DNS zone.
 *
 * API reference: https://www.scaleway.com/en/developers/api/domains-and-dns/
 * @module
 */
// extensions/models/scaleway-dns/scaleway_dns.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the DNS zone.",
  ),
  dnsZone: z.string().describe(
    "The DNS zone (domain name) this model manages, e.g. example.com.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CreateArgsSchema = z.object({
  domain: z.string().optional().describe(
    "Parent registrable domain to create the zone under (e.g. example.com). " +
      "Defaults to globalArgs.dnsZone with its first label stripped.",
  ),
  subdomain: z.string().optional().describe(
    "Subdomain label for the new zone (e.g. `test` for test.example.com). " +
      "Required by Scaleway's CreateDNSZone — the apex/root zone cannot be " +
      "created via the API. Defaults to the first label of globalArgs.dnsZone.",
  ),
});

const UpdateArgsSchema = z.object({
  changes: z.array(z.record(z.string(), z.unknown())).describe(
    "Ordered list of record-change operations. Each entry holds exactly one of " +
      "`add` ({ records }), `set` ({ id_fields, records }), `delete` " +
      "({ id_fields }) or `clear` ({}). Passed through verbatim as the PATCH " +
      "`changes` body.",
  ),
  returnAllRecords: z.boolean().optional().describe(
    "When true, the API returns every record in the zone after applying the " +
      "changes; those are snapshotted. Maps to `return_all_records`.",
  ),
});

const RecordSchema = z.object({
  id: z.string().nullable().optional().describe("Record ID (server-assigned)."),
  name: z.string().describe("Record name relative to the zone (e.g. www, @)."),
  type: z.string().describe("Record type, e.g. A, AAAA, CNAME, MX, TXT."),
  ttl: z.number().nullable().optional().describe("Time-to-live in seconds."),
  data: z.string().describe("Record value/target data."),
  priority: z.number().nullable().optional().describe(
    "Record priority (e.g. for MX/SRV records).",
  ),
  comment: z.string().nullable().optional().describe(
    "Optional record comment.",
  ),
  dnsZone: z.string().describe("The DNS zone this record belongs to."),
  observedAt: z.string().describe(
    "ISO-8601 timestamp this snapshot was taken.",
  ),
});

const ZoneSchema = z.object({
  domain: z.string().describe("Root domain of the DNS zone."),
  subdomain: z.string().nullable().optional().describe(
    "Subdomain of the DNS zone (empty for the apex).",
  ),
  status: z.string().describe("Zone status, e.g. active, pending, error."),
  message: z.string().nullable().optional().describe(
    "Human-readable status message.",
  ),
  projectId: z.string().nullable().optional().describe(
    "Project ID that owns the zone.",
  ),
  ns: z.array(z.string()).nullable().optional().describe(
    "Configured name servers for the zone.",
  ),
  updatedAt: z.string().nullable().optional().describe(
    "When the zone was last updated (ISO-8601).",
  ),
  observedAt: z.string().describe(
    "ISO-8601 timestamp this snapshot was taken.",
  ),
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
/** Map a raw Scaleway DNS record (snake_case) to a camelCase resource snapshot. */
function toRecordResource(
  r: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  return {
    id: (r.id as string) ?? null,
    name: (r.name as string) ?? "",
    type: (r.type as string) ?? "unknown",
    ttl: (r.ttl as number) ?? null,
    data: (r.data as string) ?? "",
    priority: (r.priority as number) ?? null,
    comment: (r.comment as string) ?? null,
    dnsZone: g.dnsZone,
    observedAt,
  };
}

/** Map a raw Scaleway DNS zone (snake_case) to a camelCase resource snapshot. */
function toZoneResource(
  z: Record<string, unknown>,
  observedAt: string,
): Record<string, unknown> {
  return {
    domain: (z.domain as string) ?? "",
    subdomain: (z.subdomain as string) ?? null,
    status: (z.status as string) ?? "unknown",
    message: (z.message as string) ?? null,
    projectId: (z.project_id as string) ?? null,
    ns: (z.ns as string[]) ?? null,
    updatedAt: (z.updated_at as string) ?? null,
    observedAt,
  };
}

/** Records collection path for a zone (global scope — no zone/region segment). */
const recordsPath = (g: GlobalArgs): string =>
  `/domain/v2beta1/dns-zones/${encodeURIComponent(g.dnsZone)}/records`;

/** DNS zones collection path (global scope — no zone/region segment). */
const zonesPath = (): string => `/domain/v2beta1/dns-zones`;

// --- Shared method logic ---------------------------------------------------
/** Fetch every record in the managed zone and write a snapshot per record. */
async function syncRecords(
  context: ExecuteContext,
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const { globalArgs: g, logger } = context;
  logger.info("Listing records for DNS zone {zone}", { zone: g.dnsZone });
  const records = await scalewayListAll<Record<string, unknown>>(
    g,
    recordsPath(g),
    "records",
  );
  logger.info("Found {n} records in {zone}", {
    n: records.length,
    zone: g.dnsZone,
  });
  const now = new Date().toISOString();
  const handles: Array<{ name: string }> = [];
  for (const r of records) {
    handles.push(
      await context.writeResource(
        "record",
        (r.id as string) ?? crypto.randomUUID(),
        toRecordResource(r, g, now),
      ),
    );
  }
  return { dataHandles: handles };
}

// --- Model -----------------------------------------------------------------
/** Scaleway Domains & DNS model — one instance per DNS zone, keyed by dnsZone. */
export const model = {
  type: "@sntxrr/scaleway-dns",
  version: "2026.07.19.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "record": {
      description: "Snapshot of a single DNS record in the managed zone",
      schema: RecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "zone": {
      description: "Snapshot of a DNS zone discovered in the project",
      schema: ZoneSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  checks: {
    "zone-specified": {
      description:
        "A DNS mutation must target a zone: globalArgs.dnsZone must be set.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        const zone = context.globalArgs.dnsZone;
        if (!zone || zone.trim() === "") {
          return {
            pass: false,
            errors: [
              "globalArgs.dnsZone is empty — a DNS mutation must target a zone.",
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
        "Fetch every DNS record in the managed zone (ListDNSZoneRecords).",
      arguments: z.object({}),
      execute: (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> =>
        syncRecords(context),
    },
    "list-records": {
      description:
        "Snapshot every DNS record in the managed zone (alias of sync, factory).",
      arguments: z.object({}),
      execute: (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> =>
        syncRecords(context),
    },
    "list-zones": {
      description:
        "Discover all DNS zones in the project (factory, paginated).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Discovering DNS zones in project {project}", {
          project: g.projectId,
        });
        const zones = await scalewayListAll<Record<string, unknown>>(
          g,
          `${zonesPath()}?project_id=${encodeURIComponent(g.projectId)}`,
          "dns_zones",
        );
        logger.info("Discovered {n} DNS zones", { n: zones.length });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const z of zones) {
          const subdomain = (z.subdomain as string) ?? "";
          const domain = (z.domain as string) ?? "";
          const key = subdomain ? `${subdomain}.${domain}` : domain;
          handles.push(
            await context.writeResource(
              "zone",
              key || crypto.randomUUID(),
              toZoneResource(z, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    create: {
      description: "Create a new DNS zone (CreateDNSZone) and snapshot it.",
      arguments: CreateArgsSchema,
      execute: async (
        args: z.infer<typeof CreateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        // Scaleway's CreateDNSZone always requires a subdomain — the apex/root
        // zone is created when the domain is registered/added to the account,
        // not via this API. Derive {subdomain, domain} from the managed dnsZone
        // (strip the first label) unless the caller overrides them.
        const labels = g.dnsZone.split(".");
        const subdomain = args.subdomain ??
          (labels.length >= 3 ? labels[0] : "");
        const domain = args.domain ??
          (labels.length >= 3 ? labels.slice(1).join(".") : g.dnsZone);
        if (!subdomain) {
          throw new Error(
            `Cannot create an apex DNS zone for "${g.dnsZone}" — Scaleway's ` +
              `CreateDNSZone requires a subdomain (the root zone is created when ` +
              `the domain is registered/added to your account). Set dnsZone to ` +
              `"<label>.${g.dnsZone}", or pass an explicit subdomain argument.`,
          );
        }
        logger.info(
          "Creating DNS zone {sub} under {domain} in project {project}",
          { sub: subdomain, domain, project: g.projectId },
        );
        const res = await scalewayFetch<Record<string, unknown>>(
          g,
          "POST",
          zonesPath(),
          { domain, subdomain, project_id: g.projectId },
        );
        // CreateDNSZone returns the zone flat; tolerate a `dns_zone` wrapper.
        const zoneRaw = (res.dns_zone as Record<string, unknown> | undefined) ??
          res;
        const now = new Date().toISOString();
        const subOut = (zoneRaw.subdomain as string) ?? subdomain;
        const domOut = (zoneRaw.domain as string) ?? domain;
        const key = subOut ? `${subOut}.${domOut}` : domOut;
        const handle = await context.writeResource(
          "zone",
          key || crypto.randomUUID(),
          toZoneResource(zoneRaw, now),
        );
        logger.info("Created DNS zone {key} (status {status})", {
          key,
          status: (zoneRaw.status as string) ?? "unknown",
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description:
        "Delete the managed DNS zone (DeleteDNSZone). Idempotent (404 = already absent).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting DNS zone {zone} in project {project}", {
          zone: g.dnsZone,
          project: g.projectId,
        });
        const path = `${zonesPath()}?dns_zone=${
          encodeURIComponent(g.dnsZone)
        }&project_id=${encodeURIComponent(g.projectId)}`;
        let zoneRaw: Record<string, unknown> = {};
        try {
          const res = await scalewayFetch<Record<string, unknown>>(
            g,
            "DELETE",
            path,
          );
          zoneRaw = (res?.dns_zone as Record<string, unknown> | undefined) ??
            res ?? {};
        } catch (e) {
          if ((e as { status?: number }).status !== 404) throw e;
          logger.info("DNS zone {zone} already absent (404)", {
            zone: g.dnsZone,
          });
        }
        const now = new Date().toISOString();
        // Guarantee the required schema fields even when the API returned
        // nothing (404) — real values from the response win when present.
        const merged = { domain: g.dnsZone, status: "deleted", ...zoneRaw };
        const handle = await context.writeResource(
          "zone",
          g.dnsZone,
          toZoneResource(merged, now),
        );
        logger.info("Deleted DNS zone {zone}", { zone: g.dnsZone });
        return { dataHandles: [handle] };
      },
    },
    update: {
      description:
        "Apply a batch of record changes (add/set/delete/clear) to the zone (PATCH).",
      arguments: UpdateArgsSchema,
      execute: async (
        args: z.infer<typeof UpdateArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Applying {n} record changes to {zone}", {
          n: args.changes.length,
          zone: g.dnsZone,
        });
        const res = await scalewayFetch<
          { records?: Record<string, unknown>[] }
        >(
          g,
          "PATCH",
          recordsPath(g),
          {
            changes: args.changes,
            return_all_records: args.returnAllRecords ?? true,
          },
        );
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const r of res.records ?? []) {
          handles.push(
            await context.writeResource(
              "record",
              (r.id as string) ?? crypto.randomUUID(),
              toRecordResource(r, g, now),
            ),
          );
        }
        logger.info(
          "Applied record changes to {zone}; snapshotted {n} records",
          {
            zone: g.dnsZone,
            n: handles.length,
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};

/** Internal helpers exported only for unit testing. */
export const _internal = {
  scalewayFetch,
  scalewayListAll,
  toRecordResource,
  toZoneResource,
  recordsPath,
  zonesPath,
  syncRecords,
};
