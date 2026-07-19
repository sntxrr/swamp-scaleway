/**
 * Unit tests for scaleway_redis.ts — URL construction, auth header, resource
 * mapping, pagination, delete idempotency, secret hygiene, and zone validation,
 * with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_redis.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  zone: "fr-par-1",
  clusterId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the cluster and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.clusterId,
          name: "cache-1",
          status: "ready",
          version: "7.0.5",
          node_type: "RED1-MICRO",
          zone: "fr-par-1",
          cluster_size: 1,
          tls_enabled: true,
          user_name: "admin",
          endpoints: [{ ips: ["203.0.113.10"], port: 6379 }],
          created_at: "2026-07-17T00:00:00Z",
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/redis/v1/zones/fr-par-1/clusters/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "cluster");
  // Snapshot is keyed under the real cluster ID, never the literal "latest".
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.version, "7.0.5");
  assertEquals(writes[0].data.nodeType, "RED1-MICRO");
  assertEquals(writes[0].data.clusterSize, 1);
  assertEquals(writes[0].data.tlsEnabled, true);
  assertEquals(writes[0].data.endpointHost, "203.0.113.10");
  assertEquals(writes[0].data.endpointPort, 6379);
});

Deno.test("create POSTs the cluster body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-cache",
          status: "provisioning",
          zone: "fr-par-1",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-cache",
        version: "7.0.5",
        nodeType: "RED1-MICRO",
        userName: "admin",
        password: "super-secret-pw",
        tlsEnabled: false,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/redis/v1/zones/fr-par-1/clusters");
  // The password must be sent in the request body to provision.
  assertStringIncludes(String(call.init.body), "super-secret-pw");
  assertEquals(writes[0].data.status, "provisioning");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("no password or secret field is written into the snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-cache",
          status: "provisioning",
          zone: "fr-par-1",
          // A hostile/verbose API echoing a secret must never leak into a snapshot.
          password: "echoed-secret",
          user_name: "admin",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        name: "new-cache",
        version: "7.0.5",
        nodeType: "RED1-MICRO",
        userName: "admin",
        password: "super-secret-pw",
        tlsEnabled: false,
      }, ctx),
  );
  const snapshot = writes[0].data;
  const serialized = JSON.stringify(snapshot);
  assertEquals(
    Object.prototype.hasOwnProperty.call(snapshot, "password"),
    false,
  );
  assertEquals(serialized.includes("super-secret-pw"), false);
  assertEquals(serialized.includes("echoed-secret"), false);
});

Deno.test("update PATCHes mutable fields and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.clusterId,
          name: "renamed",
          status: "ready",
          zone: "fr-par-1",
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ name: "renamed" }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.name, "renamed");
});

Deno.test("delete DELETEs the cluster", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.clusterId,
          status: "deleting",
          zone: "fr-par-1",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.status, "deleting");
});

Deno.test("delete treats a 404 as success and writes an absent snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    () => model.methods.delete.execute({}, ctx),
  );
  // A 404 (already gone) is not an error: exactly one absent snapshot is written.
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.id, G.clusterId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { clusters: [{ id: "a", status: "ready" }], total_count: 2 }
        : { clusters: [{ id: "b", status: "provisioning" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  // Each cluster is keyed under its own returned id, never "latest".
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

Deno.test("valid-zone check passes for a supported zone and fails otherwise", () => {
  const check = model.checks["valid-zone"];
  assertEquals(check.execute({ globalArgs: G }).pass, true);
  const bad = check.execute({
    globalArgs: { ...G, zone: "us-east-1" },
  });
  assertEquals(bad.pass, false);
  assert(Array.isArray(bad.errors) && bad.errors.length > 0);
  assertStringIncludes(bad.errors[0], "us-east-1");
});

Deno.test("clustersPath is zoned", () => {
  assertEquals(
    _internal.clustersPath(G),
    "/redis/v1/zones/fr-par-1/clusters",
  );
});

// --- clusterId is optional: create provisions it, others require it ---------

Deno.test("create works with no clusterId set (no placeholder needed)", async () => {
  const { clusterId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "55555555-5555-5555-5555-555555555555",
          name: "fresh-cache",
          status: "provisioning",
          zone: "fr-par-1",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        name: "fresh-cache",
        version: "7.0.5",
        nodeType: "RED1-MICRO",
        userName: "admin",
        password: "super-secret-pw",
        tlsEnabled: false,
      }, ctx),
  );
  // The new ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.id, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.name, "fresh-cache");
});

for (const method of ["sync", "update", "delete"] as const) {
  Deno.test(`${method} fails fast with an actionable error when clusterId is absent`, async () => {
    const { clusterId: _omitted, ...noId } = G;
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
    assert(err !== null, `${method} should throw when clusterId is missing`);
    assertStringIncludes(err.message, "clusterId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
