/**
 * Unit tests for scaleway_dns.ts — URL construction (global scope: no /zones/ or
 * /regions/ segment), auth header, record & zone mapping, pagination, and error
 * handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_dns.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  dnsZone: "example.com",
};

// deno-lint-ignore no-explicit-any
type AnyCtx = any;
function makeContext(globalArgsOverride?: Record<string, unknown>): {
  ctx: AnyCtx;
  writes: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
} {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx = {
    globalArgs: { ...G, ...(globalArgsOverride ?? {}) },
    logger: { info: () => {}, warn: () => {} },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
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
  globalThis.fetch =
    ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        handler(String(input), init ?? {}),
      )) as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("sync GETs zone records on a global path (no /zones/ or /regions/) with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          records: [
            { id: "r1", name: "www", type: "A", data: "192.0.2.10", ttl: 300 },
          ],
          total_count: 1,
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(
    call.url,
    "/domain/v2beta1/dns-zones/example.com/records",
  );
  // Global scope: the path must NOT contain a zone or region segment.
  assert(!call.url.includes("/zones/"));
  assert(!call.url.includes("/regions/"));
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "record");
  assertEquals(writes[0].data.type, "A");
  assertEquals(writes[0].data.data, "192.0.2.10");
  assertEquals(writes[0].data.dnsZone, "example.com");
});

Deno.test("list-records aggregates record pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? {
          records: [{ id: "a", name: "@", type: "A", data: "198.51.100.1" }],
          total_count: 2,
        }
        : {
          records: [{ id: "b", name: "www", type: "CNAME", data: "@" }],
          total_count: 2,
        };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods["list-records"].execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].name, "a");
  assertEquals(writes[1].name, "b");
});

Deno.test("list-zones lists dns-zones globally and maps snake_case to camelCase", async () => {
  const { ctx, writes } = makeContext();
  let capturedUrl = "";
  await withMockedFetch(
    (url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          dns_zones: [
            {
              domain: "example.com",
              subdomain: "",
              status: "active",
              project_id: G.projectId,
              ns: ["ns0.dom.scw.cloud"],
              updated_at: "2026-07-17T00:00:00Z",
            },
          ],
          total_count: 1,
        }),
        { status: 200 },
      );
    },
    () => model.methods["list-zones"].execute({}, ctx),
  );
  assertStringIncludes(capturedUrl, "/domain/v2beta1/dns-zones");
  assert(!capturedUrl.includes("/zones/z"));
  assert(!capturedUrl.includes("/regions/"));
  assertEquals(writes[0].spec, "zone");
  assertEquals(writes[0].data.projectId, G.projectId);
  assertEquals(writes[0].data.status, "active");
  assertEquals(writes[0].data.updatedAt, "2026-07-17T00:00:00Z");
});

Deno.test("update PATCHes the changes body and snapshots returned records", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          records: [
            { id: "r9", name: "api", type: "A", data: "203.0.113.9", ttl: 60 },
          ],
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.update.execute(
        {
          changes: [
            {
              add: {
                records: [
                  { name: "api", type: "A", data: "203.0.113.9", ttl: 60 },
                ],
              },
            },
          ],
          returnAllRecords: true,
        },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "PATCH");
  assertStringIncludes(
    call.url,
    "/domain/v2beta1/dns-zones/example.com/records",
  );
  assert(!call.url.includes("/zones/"));
  assert(!call.url.includes("/regions/"));
  const sent = JSON.parse(String(call.init.body));
  assertEquals(sent.return_all_records, true);
  assertEquals(sent.changes[0].add.records[0].name, "api");
  assertEquals(writes[0].spec, "record");
  assertEquals(writes[0].data.data, "203.0.113.9");
});

Deno.test("create derives subdomain+domain from a child dnsZone and POSTs the new zone", async () => {
  // dnsZone is a child zone → subdomain "test", domain "example.com".
  const { ctx, writes } = makeContext({ dnsZone: "test.example.com" });
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          domain: "example.com",
          subdomain: "test",
          status: "pending",
          project_id: G.projectId,
          ns: ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"],
        }),
        { status: 200 },
      );
    },
    () => model.methods.create.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/domain/v2beta1/dns-zones");
  assert(!call.url.includes("/zones/"));
  assert(!call.url.includes("/regions/"));
  const sent = JSON.parse(String(call.init.body));
  assertEquals(sent.domain, "example.com"); // first label of dnsZone stripped
  assertEquals(sent.subdomain, "test");
  assertEquals(sent.project_id, G.projectId);
  assertEquals(writes[0].spec, "zone");
  assertEquals(writes[0].name, "test.example.com"); // key = subdomain.domain
  assertEquals(writes[0].data.status, "pending");
  assertEquals(writes[0].data.projectId, G.projectId);
});

Deno.test("create refuses an apex dnsZone (Scaleway CreateDNSZone requires a subdomain)", async () => {
  const { ctx, writes } = makeContext({ dnsZone: "example.com" });
  let threw = false;
  await withMockedFetch(
    () => new Response("{}", { status: 200 }),
    async () => {
      try {
        await model.methods.create.execute({}, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "apex");
      }
    },
  );
  assert(threw);
  assertEquals(writes.length, 0); // no API call snapshot on a pre-flight refusal
});

Deno.test("create honors an explicit subdomain and keys the snapshot as sub.domain", async () => {
  const { ctx, writes } = makeContext();
  let sentBody: Record<string, unknown> = {};
  await withMockedFetch(
    (_url, init) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          domain: "example.com",
          subdomain: "test",
          status: "pending",
          project_id: G.projectId,
        }),
        { status: 200 },
      );
    },
    () => model.methods.create.execute({ subdomain: "test" }, ctx),
  );
  assertEquals(sentBody.subdomain, "test");
  assertEquals(writes[0].name, "test.example.com");
});

Deno.test("delete DELETEs the zone via query params and snapshots the returned state", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          domain: "example.com",
          status: "deleting",
          project_id: G.projectId,
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "DELETE");
  assertStringIncludes(call.url, "/domain/v2beta1/dns-zones?dns_zone=example.com");
  assertStringIncludes(call.url, `project_id=${G.projectId}`);
  assert(!call.url.includes("/zones/"));
  assert(!call.url.includes("/regions/"));
  assertEquals(writes[0].spec, "zone");
  assertEquals(writes[0].name, "example.com");
  assertEquals(writes[0].data.status, "deleting");
});

Deno.test("delete treats a 404 as success (idempotent) and marks the zone deleted", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "zone");
  assertEquals(writes[0].name, "example.com");
  assertEquals(writes[0].data.domain, "example.com");
  assertEquals(writes[0].data.status, "deleted");
});

Deno.test("zone-specified check fails on blank dnsZone and passes when set", () => {
  const fail = model.checks["zone-specified"].execute({
    globalArgs: { ...G, dnsZone: "   " },
  });
  assertEquals(fail.pass, false);
  assert((fail.errors ?? []).length > 0);

  const ok = model.checks["zone-specified"].execute({ globalArgs: G });
  assertEquals(ok.pass, true);
});

Deno.test("a non-2xx response throws and writes nothing", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
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

Deno.test("recordsPath and zonesPath are global (no zone/region segment)", () => {
  assertEquals(
    _internal.recordsPath(G.dnsZone),
    "/domain/v2beta1/dns-zones/example.com/records",
  );
  assertEquals(_internal.zonesPath(), "/domain/v2beta1/dns-zones");
});

// --- dnsZone is optional: list-zones discovers, other methods require it ----

Deno.test("list-zones works with no dnsZone set (no placeholder needed)", async () => {
  const { ctx, writes } = makeContext({ dnsZone: undefined });
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          dns_zones: [
            { domain: "a.example", subdomain: "", status: "active" },
            { domain: "b.example", subdomain: "", status: "active" },
          ],
          total_count: 2,
        }),
        { status: 200 },
      ),
    () => model.methods["list-zones"].execute({}, ctx),
  );
  // Discovered zones come from the API, never from a preset globalArg.
  assertEquals(writes.length, 2);
});

for (
  const [method, args] of [
    ["sync", {}],
    ["list-records", {}],
    ["create", {}],
    ["delete", {}],
    ["update", { changes: [] }],
  ] as const
) {
  Deno.test(`${method} fails fast with an actionable error when dnsZone is absent`, async () => {
    const { ctx, writes } = makeContext({ dnsZone: undefined });
    let fetched = false;
    // The guard runs before arguments are read, so valid args still throw.
    const exec = model.methods[method].execute as unknown as (
      a: unknown,
      c: unknown,
    ) => Promise<unknown>;
    const err = await withMockedFetch(
      () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      async () => {
        try {
          await exec(args, ctx);
          return null;
        } catch (e) {
          return e as Error;
        }
      },
    );
    assert(err !== null, `${method} should throw when dnsZone is missing`);
    assertStringIncludes(err.message, "dnsZone");
    assertStringIncludes(err.message, method);
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
