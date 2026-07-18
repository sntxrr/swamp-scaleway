/**
 * Unit tests for scaleway_rdb.ts — URL construction, auth header, resource
 * mapping, pagination, error handling, and secret hygiene, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_rdb.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  instanceId: "22222222-2222-2222-2222-222222222222",
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
          name: "db-1",
          status: "ready",
          engine: "PostgreSQL-15",
          node_type: "DB-DEV-S",
          region: "fr-par",
          is_ha_cluster: false,
          volume: { type: "lssd", size: 5000000000 },
          endpoints: [{ ip: "203.0.113.10", port: 5432 }],
          created_at: "2026-07-17T00:00:00Z",
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/rdb/v1/regions/fr-par/instances/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "instance");
  // Snapshot is keyed under the real instance ID, never the literal "latest".
  assertEquals(writes[0].name, G.instanceId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.engine, "PostgreSQL-15");
  assertEquals(writes[0].data.nodeType, "DB-DEV-S");
  assertEquals(writes[0].data.volumeType, "lssd");
  assertEquals(writes[0].data.endpointHost, "203.0.113.10");
  assertEquals(writes[0].data.endpointPort, 5432);
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
          name: "new-db",
          status: "provisioning",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-db",
        engine: "PostgreSQL-15",
        nodeType: "DB-DEV-S",
        userName: "admin",
        password: "super-secret-pw",
        isHaCluster: false,
        disableBackup: false,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/rdb/v1/regions/fr-par/instances");
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
          name: "new-db",
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
        name: "new-db",
        engine: "PostgreSQL-15",
        nodeType: "DB-DEV-S",
        userName: "admin",
        password: "super-secret-pw",
        isHaCluster: false,
        disableBackup: false,
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
    "/rdb/v1/regions/fr-par/instances",
  );
});
