/**
 * Unit tests for scaleway_mongodb.ts — URL construction, auth header, resource
 * mapping, pagination, delete-404 idempotency, valid-region checks, error
 * handling, and secret hygiene, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_mongodb.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  instanceId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the instance and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.instanceId,
          name: "mongo-1",
          status: "ready",
          version: "7.0.12",
          node_type: "MGDB-PLAY2-NANO",
          node_amount: 1,
          region: "fr-par",
          volume: { type: "sbs_5k", size_bytes: 5000000000 },
          endpoints: [{ ip: "203.0.113.10", port: 27017 }],
          created_at: "2026-07-17T00:00:00Z",
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/mongodb/v1/regions/fr-par/instances/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "instance");
  // Snapshot is keyed under the real instance ID, never the literal "latest".
  assertEquals(writes[0].name, G.instanceId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.version, "7.0.12");
  assertEquals(writes[0].data.nodeType, "MGDB-PLAY2-NANO");
  assertEquals(writes[0].data.nodeAmount, 1);
  assertEquals(writes[0].data.volumeType, "sbs_5k");
  assertEquals(writes[0].data.volumeSize, 5000000000);
  assertEquals(writes[0].data.endpointHost, "203.0.113.10");
  assertEquals(writes[0].data.endpointPort, 27017);
});

Deno.test("sync maps an endpoint dns_records host when no ip is present", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: G.instanceId,
          status: "ready",
          region: "fr-par",
          endpoints: [{ dns_records: ["mongo.example.com"], port: 27017 }],
        }),
        { status: 200 },
      ),
    () => model.methods.sync.execute({}, ctx),
  );
  assertEquals(writes[0].data.endpointHost, "mongo.example.com");
  assertEquals(writes[0].data.endpointPort, 27017);
});

Deno.test("create POSTs the instance body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-mongo",
          status: "provisioning",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-mongo",
        version: "7.0.12",
        nodeType: "MGDB-PLAY2-NANO",
        nodeAmount: 1,
        userName: "admin",
        password: "super-secret-pw",
        volumeType: "sbs_5k",
        volumeSize: 5000000000,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/mongodb/v1/regions/fr-par/instances");
  const body = String(call.init.body);
  // The password must be sent in the request body to provision.
  assertStringIncludes(body, "super-secret-pw");
  // Volume is nested with node_amount and version fields.
  assertStringIncludes(body, "node_amount");
  assertStringIncludes(body, '"version":"7.0.12"');
  assertStringIncludes(body, "volume_size");
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
          name: "new-mongo",
          status: "provisioning",
          region: "fr-par",
          // A hostile/verbose API echoing a secret must never leak into a snapshot.
          password: "echoed-secret",
          user_name: "admin",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        name: "new-mongo",
        version: "7.0.12",
        nodeType: "MGDB-PLAY2-NANO",
        nodeAmount: 1,
        userName: "admin",
        password: "super-secret-pw",
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
          id: G.instanceId,
          name: "renamed",
          status: "ready",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ name: "renamed" }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertEquals(writes[0].name, G.instanceId);
  assertEquals(writes[0].data.name, "renamed");
});

Deno.test("delete DELETEs the instance", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.instanceId,
          status: "deleting",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.instanceId);
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
  assertEquals(writes[0].name, G.instanceId);
  assertEquals(writes[0].data.id, G.instanceId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { instances: [{ id: "a", status: "ready" }], total_count: 2 }
        : { instances: [{ id: "b", status: "provisioning" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  // Factory snapshots are keyed by each instance's real ID.
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

Deno.test("instancesPath is regional", () => {
  assertEquals(
    _internal.instancesPath(G),
    "/mongodb/v1/regions/fr-par/instances",
  );
});

// --- instanceId is optional: create provisions it, others require it --------

Deno.test("create works with no instanceId set (no placeholder needed)", async () => {
  const { instanceId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "55555555-5555-5555-5555-555555555555",
          name: "provisioned-db",
          status: "provisioning",
          version: "7.0.12",
          region: "fr-par",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        name: "provisioned-db",
        version: "7.0.12",
        nodeType: "MGDB-PLAY2-NANO",
        nodeAmount: 1,
        userName: "admin",
        password: "not-a-real-password",
      }, ctx),
  );
  // The new instance ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.id, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.name, "provisioned-db");
});

/** Every method that operates on an existing instance. */
const guardedMethods: Array<[string, (ctx: AnyCtx) => Promise<unknown>]> = [
  ["sync", (ctx) => model.methods.sync.execute({}, ctx)],
  ["update", (ctx) => model.methods.update.execute({ name: "x" }, ctx)],
  ["delete", (ctx) => model.methods.delete.execute({}, ctx)],
];

for (const [method, run] of guardedMethods) {
  Deno.test(`${method} fails fast with an actionable error when instanceId is absent`, async () => {
    const { instanceId: _omitted, ...noId } = G;
    const { ctx, writes } = makeContext(noId);
    let fetched = false;
    const err = await withMockedFetch(
      () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      async () => {
        try {
          await run(ctx);
          return null;
        } catch (e) {
          return e as Error;
        }
      },
    );
    assert(err !== null, `${method} should throw when instanceId is missing`);
    assertStringIncludes(err.message, "instanceId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
