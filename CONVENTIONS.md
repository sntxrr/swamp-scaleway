# CONVENTIONS — Scaleway Extension Suite

**Lead-owned. Builders read this, copy from it, and propose changes via the lead
— never edit it directly.** This is the single source of truth for the shared
technical contract in [`PRD.md`](./PRD.md) §5. If the PRD and this file ever
disagree, this file wins for *implementation* detail; the PRD wins for *scope*.

Everything here is derived from the working precedent
`../oracle/extensions/models/oci_instance.ts` (single cloud resource wrapped
with an inline authed HTTP client, no SDK) — study it alongside this doc.

---

## 1. How a builder uses this doc

1. Pick one service row from [`PRD.md`](./PRD.md) §6.
2. Copy the **golden template** (§7) to `extensions/models/scaleway_<service>.ts`.
3. Copy the **`scalewayFetch` / `scalewayListAll` helpers (§5) byte-identical** —
   do not "improve" them per-service; a change is a lead-driven sweep across all
   extensions.
4. Fill in schemas, URL paths (from §4 + the live Scaleway API docs), and
   methods (§3 taxonomy).
5. Copy the **test template** (§8) to `scaleway_<service>_test.ts`; mock `fetch`.
6. Copy the **manifest / README / LICENSE templates** (§9).
7. Run the **verification + publish sequence** (§10), including the Adversarial
   Review Gate.
8. Tick every box in [`PRD.md`](./PRD.md) §8 Definition of Done.

**File ownership:** each service owns distinct filenames
(`scaleway_<service>.ts`, `scaleway_<service>_test.ts`,
`manifests/scaleway-<service>.yaml`). No builder edits another's files. The root
`README.md` index is lead-owned.

---

## 2. Hard rules (non-negotiable)

- `import { z } from "npm:zod@4";` — **never** bare `"zod"`.
- Static imports only; **no** dynamic `import()`.
- Deno-native only: `fetch` + Web Crypto. **No npm deps** in these extensions if
  at all avoidable (keeps dependency-trust clean and bundles tiny). If one is
  unavoidable, pin it: `npm:pkg@x.y.z`.
- **Never hardcode a secret.** `secretKey` is `.meta({ sensitive: true })` and
  wired from a vault. Never write a secret into a resource data snapshot or log.
- Explicit return types on `execute` and every exported function.
- JSDoc on the module, every exported symbol, and each schema field via
  `.describe(...)` (drives the ≥80% JSDoc quality factor).
- Type string: `@sntxrr/scaleway-<service>` (lowercase, hyphens). `swamp`/`si`
  collectives are reserved — never use them.

---

## 3. Method taxonomy

Implement only the methods the API actually supports; name them from this fixed
vocabulary so every Scaleway extension feels identical:

| Method | HTTP | Semantics |
| --- | --- | --- |
| `sync` | GET | Read current state of the one resource this model manages. **Always implement.** Idempotent. |
| `create` | POST | Provision the resource; write a snapshot including the new ID. |
| `update` | PATCH/PUT | Mutate mutable fields. |
| `delete` | DELETE | Deprovision. Verify the ID first (`swamp model get --json`). |
| `start`/`stop`/`reboot` | POST action | Compute-like lifecycle (mirror `oci_instance`). |
| `list` | GET (paginated) | **Factory** discovery: one method fans out and writes many snapshots. Never loop `run` N times (per-model lock contention). Use `scalewayListAll`. |

- **One model instance per real resource**, keyed by the Scaleway resource ID
  (global arg `resourceId`, or a service-specific `serverId`/`vpcId`/…).
- Async states: Scaleway creates return transient states (`starting`,
  `creating`). `sync` reports `status`; callers poll `sync`. Models never block
  on a spin-loop.

---

## 4. Auth & URL patterns

**Auth (default):** header `X-Auth-Token: <secretKey>`. Base
`https://api.scaleway.com` (overridable via the `endpoint` global arg).

**URL shapes** off the base:

| Shape | Template | Region/zone global arg |
| --- | --- | --- |
| Zoned | `/{product}/{version}/zones/{zone}/{object}` | `zone` (default `fr-par-1`) |
| Regional | `/{product}/{version}/regions/{region}/{object}` | `region` (default `fr-par`) |
| Global | `/{product}/{version}/{object}` | none |

- Zones: `fr-par-1..3`, `nl-ams-1..3`, `pl-waw-1..3`. Regions: `fr-par`,
  `nl-ams`, `pl-waw`.
- **Pagination:** Scaleway list endpoints accept `?page=N&page_size=M` and
  return `{ "<key>": [...], "total_count": N }`. Aggregate with `scalewayListAll`.

**S3-compatible services (`scaleway-object-storage`, `scaleway-file-storage`):**
these use the **S3 API + AWS SigV4** (access key + secret key), endpoint
`https://s3.<region>.scw.cloud` — **not** `X-Auth-Token`. Use the SigV4 signer
in **Appendix A** instead of `scalewayFetch`. Higher complexity; senior builder.

---

## 5. Canonical HTTP client (copy byte-identical)

```typescript
// --- Scaleway HTTP client — CANONICAL, copy byte-identical into each model ---
// GlobalArgs must include: secretKey, endpoint?  (see golden template §7)

/** Perform an X-Auth-Token-authenticated Scaleway API call, returning JSON. */
async function scalewayFetch<T>(
  g: { secretKey: string; endpoint?: string },
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const base = (g.endpoint ?? "https://api.scaleway.com").replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Auth-Token": g.secretKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Scaleway ${method} ${path} failed (${res.status}): ${text}`,
    );
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Aggregate every page of a Scaleway list endpoint into one array. */
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
    const total = Number(res.total_count ?? items.length);
    if (batch.length === 0 || items.length >= total) break;
    page += 1;
  }
  return items;
}
```

---

## 6. Shared context types (copy byte-identical)

```typescript
// --- Swamp execute-context shape (from oci_instance.ts) ---------------------
type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type ExecuteContext<G> = {
  globalArgs: G;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};
```

Method `execute` signature is always
`(args, context): Promise<{ dataHandles: Array<{ name: string }> }>`.

---

## 7. Golden template (concrete, compiling reference: `scaleway-instance`)

This is a real, type-checking reference for the Instance API (zoned). Copy it,
rename `<service>`, and adapt schemas + paths. It demonstrates `sync` (GET),
`reboot`/`start`/`stop` (POST action), and factory `list` (paginated).

```typescript
/**
 * Scaleway Instance (compute) integration.
 *
 * Wraps the Scaleway Instance API (`/instance/v1`) so a swamp model represents a
 * single compute server, keyed by its server ID. Exposes `sync`, `start`,
 * `stop`, `reboot`, and a factory `list`. Authenticated with the `X-Auth-Token`
 * header (secret key wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/instance/
 * @module
 */
// extensions/models/scaleway_instance.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe("Scaleway Project ID that owns the server."),
  zone: z.string().default("fr-par-1").describe(
    "Availability zone, e.g. fr-par-1, nl-ams-1, pl-waw-1.",
  ),
  serverId: z.string().describe("ID of the Instance server this model manages."),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ActionArgsSchema = z.object({
  action: z.enum(["poweron", "poweroff", "reboot", "stop_in_place", "terminate"])
    .describe("Instance server action verb."),
});

const ServerSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  state: z.string(),
  zone: z.string(),
  commercialType: z.string().nullable().optional(),
  publicIp: z.string().nullable().optional(),
  observedAt: z.string(),
});

// --- Scaleway HTTP client (canonical — see CONVENTIONS.md §5) ---------------
async function scalewayFetch<T>(
  g: { secretKey: string; endpoint?: string },
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const base = (g.endpoint ?? "https://api.scaleway.com").replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Auth-Token": g.secretKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Scaleway ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
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
    const total = Number(res.total_count ?? items.length);
    if (batch.length === 0 || items.length >= total) break;
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
function toServerResource(
  s: Record<string, unknown>,
  g: GlobalArgs,
  observedAt: string,
): Record<string, unknown> {
  const addr = (s.public_ip as Record<string, unknown> | null | undefined);
  return {
    id: (s.id as string) ?? g.serverId,
    name: (s.name as string) ?? null,
    state: (s.state as string) ?? "unknown",
    zone: (s.zone as string) ?? g.zone,
    commercialType: (s.commercial_type as string) ?? null,
    publicIp: (addr?.address as string) ?? null,
    observedAt,
  };
}

const serversPath = (g: GlobalArgs): string =>
  `/instance/v1/zones/${g.zone}/servers`;

// --- Model -----------------------------------------------------------------
/** Scaleway Instance server model — one instance per server, keyed by serverId. */
export const model = {
  type: "@sntxrr/scaleway-instance",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "server": {
      description: "Snapshot of the Instance server's state",
      schema: ServerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    sync: {
      description: "Fetch the server's current state (GetServer).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing Scaleway server {id}", { id: g.serverId });
        const res = await scalewayFetch<{ server: Record<string, unknown> }>(
          g,
          "GET",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
        );
        const handle = await context.writeResource(
          "server",
          "latest",
          toServerResource(res.server, g, new Date().toISOString()),
        );
        return { dataHandles: [handle] };
      },
    },
    action: {
      description:
        "Issue a power action (poweron, poweroff, reboot, stop_in_place, terminate).",
      arguments: ActionArgsSchema,
      execute: async (
        args: z.infer<typeof ActionArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Server {id} action {action}", {
          id: g.serverId,
          action: args.action,
        });
        await scalewayFetch(
          g,
          "POST",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}/action`,
          { action: args.action },
        );
        const res = await scalewayFetch<{ server: Record<string, unknown> }>(
          g,
          "GET",
          `${serversPath(g)}/${encodeURIComponent(g.serverId)}`,
        );
        const handle = await context.writeResource(
          "server",
          "latest",
          toServerResource(res.server, g, new Date().toISOString()),
        );
        return { dataHandles: [handle] };
      },
    },
    list: {
      description: "Discover all Instance servers in the zone (factory).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const servers = await scalewayListAll<Record<string, unknown>>(
          g,
          serversPath(g),
          "servers",
        );
        logger.info("Discovered {n} servers in {zone}", {
          n: servers.length,
          zone: g.zone,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const s of servers) {
          handles.push(
            await context.writeResource(
              "server",
              (s.id as string) ?? crypto.randomUUID(),
              toServerResource(s, g, now),
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
  toServerResource,
  serversPath,
};
```

---

## 8. Test template (mock `fetch`; no live calls)

```typescript
/**
 * Unit tests for scaleway_instance.ts — URL construction, auth header, resource
 * mapping, pagination, and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_instance.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  zone: "fr-par-1",
  serverId: "22222222-2222-2222-2222-222222222222",
};

// deno-lint-ignore no-explicit-any
type AnyCtx = any;
function makeContext(): {
  ctx: AnyCtx;
  writes: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
} {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx = {
    globalArgs: G,
    logger: { info: () => {}, warn: () => {} },
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { ctx, writes };
}

async function withMockedFetch<T>(
  handler: (url: string, init: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {}))) as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("sync GETs the server and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ server: { id: G.serverId, state: "running", name: "web-1" } }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/instance/v1/zones/fr-par-1/servers/");
  assertEquals((call.init.headers as Record<string, string>)["X-Auth-Token"], G.secretKey);
  assertEquals(writes[0].spec, "server");
  assertEquals(writes[0].data.state, "running");
});

Deno.test("action POSTs the verb then re-reads state", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(JSON.stringify({ server: { id: G.serverId, state: "starting" } }), { status: 200 });
    },
    () => model.methods.action.execute({ action: "poweron" }, ctx),
  );
  assertEquals(methods[0], "POST");
  assertEquals(methods[1], "GET");
  assertEquals(writes[0].data.state, "starting");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { servers: [{ id: "a", state: "running" }], total_count: 2 }
        : { servers: [{ id: "b", state: "stopped" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
});

Deno.test("a non-2xx response throws and writes nothing", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    async () => {
      try {
        await model.methods.sync.execute({}, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "404");
      }
    },
  );
  assert(threw);
  assertEquals(writes.length, 0);
});
```

---

## 9. Manifest / README / LICENSE templates

**`manifests/scaleway-<service>.yaml`** (set `paths.base` if you adopt a
per-service subdir layout; default resolves paths relative to `extensions/`):

```yaml
manifestVersion: 1

name: "@sntxrr/scaleway-<service>"
version: "2026.07.17.1"   # use: swamp extension version --manifest <file> --json
description: "<one sentence: what resource, which API, which methods>."
repository: "https://github.com/sntxrr/swamp-scaleway"

models:
  - scaleway_<service>.ts

additionalFiles:
  - README.md
  - LICENSE.md

labels:
  - scaleway
  - <product-family>   # compute | storage | network | database | serverless | security | ...
  - <keywords>
```

- **README.md** (per extension, in `additionalFiles`): purpose, method table,
  the `swamp vault` + `swamp model create` quick-start (mirror
  `../oracle/README.md`), development commands, license line.
- **LICENSE.md**: MIT, matching the sibling repos. Copy `../oracle/extensions/models/LICENSE.md`.

---

## 10. Verify → review → publish sequence

```bash
DENO=~/.swamp/deno/deno   # or: swamp doctor extensions --json | jq -r .denoPath

# 1. Type-check + test
$DENO check extensions/models/scaleway_<service>.ts
$DENO test  extensions/models/scaleway_<service>_test.ts

# 2. Confirm it registers
swamp model type search scaleway --json

# 3. Smoke test (read-only sync/list first) — see swamp skill:
#    references/model/smoke_testing.md

# 4. Format + quality (target >= 14/15)
swamp extension fmt     manifests/scaleway-<service>.yaml --check
swamp extension quality manifests/scaleway-<service>.yaml --json

# 5. Adversarial Review Gate (REQUIRED before push)
#    - run the Mandatory Mechanical Verification checks first
#    - then dimensional review; write the content-hash-bound report to the
#      path that --dry-run prints; set every verdict pass/na (note non-pass)
swamp extension push manifests/scaleway-<service>.yaml --dry-run

# 6. Publish (via the swamp-extension-publish skill)
swamp extension push manifests/scaleway-<service>.yaml --json
```

Never `--yes` past the review gate. Editing source or bumping the version
invalidates the report — regenerate it.

---

## Wave 1 API reconciliation (verified against live Scaleway docs, 2026-07-17)

Lead-verified base paths/scopes for the gating wave. Builders still read each
service's live reference for exact request/response fields, but these
prefixes/scopes are confirmed — build against them:

| Service | Verified prefix | Scope | Notes |
| --- | --- | --- | --- |
| `scaleway-instance` | `/instance/v1` | zoned | `/instance/v1/zones/{zone}/servers`; action via POST `.../servers/{id}/action`. Golden template §7 matches. |
| `scaleway-block-storage` | `/block/v1` | zoned | **Graduated from `v1alpha1` → `v1`** (PRD corrected). `/block/v1/zones/{zone}/volumes`. |
| `scaleway-object-storage` | `s3.<region>.scw.cloud` | regional | S3 API + SigV4 (Appendix A) — **not** `X-Auth-Token`. |
| `scaleway-vpc` | `/vpc/v2` | regional | `/vpc/v2/regions/{region}/vpcs` and `/private-networks`. |
| `scaleway-load-balancer` | `/lb/v1` | **zoned** | `/lb/v1/zones/{zone}/lbs`. The **regional** LB API is deprecated — use zoned. |
| `scaleway-rdb` | `/rdb/v1` | regional | `/rdb/v1/regions/{region}/instances`. |
| `scaleway-dns` | `/domain/v2beta1` | **global** (PRD corrected) | `/domain/v2beta1/dns-zones/{zone}/records`; no region/zone in path. |

Sources: scaleway.com/en/developers/api/{block,domains-and-dns,load-balancer}.
Wave 2/3 prefixes in the PRD are provisional — each builder confirms its own
service's version/scope against the live reference at pickup and reports any
correction back to the lead for this table.

## Appendix A — S3 / SigV4 (object & file storage)

`scaleway-object-storage` and `scaleway-file-storage` do **not** use
`X-Auth-Token`. They speak the S3 API at `https://s3.<region>.scw.cloud` with
**AWS Signature V4** (access key + secret key). Implement the signer inline with
Web Crypto HMAC-SHA256, the same way `oci_instance` implements RSA-SHA256 inline
(canonical steps: canonical request → string-to-sign → signing key
`HMAC(HMAC(HMAC(HMAC("AWS4"+secret,date),region),"s3"),"aws4_request")` →
`Authorization: AWS4-HMAC-SHA256 ...`). The lead lands the reviewed signer
snippet here before those two rows start; both copy it byte-identical.

Global args for S3 rows: `accessKey`, `secretKey` (sensitive), `region`
(default `fr-par`), `endpoint?`.

---

## Appendix B — Secret Manager as a vault backend

`scaleway-secret-manager` ships **both** a model (`extensions/models/`) and a
swamp vault backend (`extensions/vaults/scaleway_secret_manager/mod.ts`,
`export const vault`) so operators can source other models' secrets from
Scaleway Secret Manager. The vault's `createProvider(name, config)` returns
`{ get, put, list, getName }` backed by `scalewayFetch` against
`/secret-manager/v1beta1/regions/{region}/secrets`. See the swamp extension
guide's Vault quick-start.
```
