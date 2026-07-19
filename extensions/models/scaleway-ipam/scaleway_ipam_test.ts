/**
 * Unit tests for scaleway_ipam.ts — URL construction, auth header, resource
 * mapping, pagination, delete-404 idempotency, region validation, and error
 * handling, with a mocked fetch. All example IPs are RFC 5737 (192.0.2.x /
 * 198.51.100.x / 203.0.113.x).
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_ipam.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  ipId: "22222222-2222-2222-2222-222222222222",
};

// deno-lint-ignore no-explicit-any
type AnyCtx = any;
function makeContext(globalArgs: Record<string, unknown> = G): {
  ctx: AnyCtx;
  writes: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
} {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx = {
    globalArgs,
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

Deno.test("sync GETs the IP and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.ipId,
          address: "203.0.113.10/32",
          is_ipv6: false,
          region: "fr-par",
          zone: "fr-par-1",
          project_id: G.projectId,
          resource: { type: "instance_server", id: "srv-1" },
          reverses: [{ hostname: "host.example.com", address: "203.0.113.10" }],
          tags: ["prod"],
          created_at: "2026-07-17T00:00:00Z",
          updated_at: "2026-07-17T01:00:00Z",
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/ipam/v1/regions/fr-par/ips/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "ip");
  // Snapshot is keyed under the real IP ID, never the literal "latest".
  assertEquals(writes[0].name, G.ipId);
  assertEquals(writes[0].data.address, "203.0.113.10/32");
  assertEquals(writes[0].data.isIpv6, false);
  assertEquals(writes[0].data.resourceType, "instance_server");
  assertEquals(writes[0].data.resourceId, "srv-1");
  assertEquals(writes[0].data.tags, ["prod"]);
});

Deno.test("create POSTs the book body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          address: "192.0.2.20/32",
          region: "fr-par",
          project_id: G.projectId,
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        source: { subnet_id: "44444444-4444-4444-4444-444444444444" },
        isIpv6: false,
        tags: ["reserved"],
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/ipam/v1/regions/fr-par/ips");
  const body = String(call.init.body);
  assertStringIncludes(body, "project_id");
  assertStringIncludes(body, "subnet_id");
  assertStringIncludes(body, "is_ipv6");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
  assertEquals(writes[0].data.address, "192.0.2.20/32");
});

Deno.test("update PATCHes tags and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  let body = "";
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      body = String(init.body);
      return new Response(
        JSON.stringify({
          id: G.ipId,
          address: "198.51.100.5/32",
          region: "fr-par",
          tags: ["retagged"],
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ tags: ["retagged"] }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertStringIncludes(body, "retagged");
  assertEquals(writes[0].name, G.ipId);
  assertEquals(writes[0].data.tags, ["retagged"]);
});

Deno.test("delete DELETEs the IP", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({ id: G.ipId, address: "203.0.113.10/32" }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.ipId);
  assertEquals(writes[0].data.id, G.ipId);
});

Deno.test("delete treats a 404 as success and writes an absent snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    () => model.methods.delete.execute({}, ctx),
  );
  // A 404 (already released) is not an error: exactly one absent snapshot.
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.ipId);
  assertEquals(writes[0].data.id, G.ipId);
  assertEquals(writes[0].data.absent, true);
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? {
          ips: [{ id: "a", address: "192.0.2.1/32" }],
          total_count: 2,
        }
        : {
          ips: [{ id: "b", address: "192.0.2.2/32" }],
          total_count: 2,
        };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].name, "a");
  assertEquals(writes[1].name, "b");
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

Deno.test("valid-region check passes for a supported region and fails otherwise", () => {
  const check = model.checks["valid-region"];
  assertEquals(check.execute({ globalArgs: G }).pass, true);
  const bad = check.execute({
    globalArgs: { ...G, region: "us-east-1" },
  });
  assertEquals(bad.pass, false);
  assert(Array.isArray(bad.errors) && bad.errors.length > 0);
  assertStringIncludes(bad.errors[0], "us-east-1");
});

Deno.test("ipsPath is regional", () => {
  assertEquals(
    _internal.ipsPath(G),
    "/ipam/v1/regions/fr-par/ips",
  );
});

// --- ipId is optional: create provisions it, other methods require it -------

Deno.test("create works with no ipId set (no placeholder needed)", async () => {
  const { ipId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "55555555-5555-5555-5555-555555555555",
          address: "192.0.2.30/32",
          region: "fr-par",
          project_id: G.projectId,
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        source: { zonal: "fr-par-1" },
        isIpv6: false,
      }, ctx),
  );
  // The booked ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.id, "55555555-5555-5555-5555-555555555555");
});

for (const method of ["sync", "update", "delete"] as const) {
  Deno.test(`${method} fails fast with an actionable error when ipId is absent`, async () => {
    const { ipId: _omitted, ...noId } = G;
    const { ctx, writes } = makeContext(noId);
    let fetched = false;
    const err = await withMockedFetch(
      () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      async () => {
        try {
          await model.methods[method].execute({}, ctx);
          return null;
        } catch (e) {
          return e as Error;
        }
      },
    );
    assert(err !== null, `${method} should throw when ipId is missing`);
    assertStringIncludes(err.message, "ipId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
