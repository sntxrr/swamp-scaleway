/**
 * Unit tests for scaleway_cockpit.ts — URL construction, auth header, resource
 * mapping, pagination, delete-404 idempotency, region validation, error
 * handling, and token-secret hygiene, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_cockpit.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  dataSourceId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the data source and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.dataSourceId,
          name: "metrics-ds",
          type: "metrics",
          url: "https://metrics.example.com",
          origin: "scaleway",
          project_id: G.projectId,
          region: "fr-par",
          retention_days: 31,
          created_at: "2026-07-17T00:00:00Z",
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/cockpit/v1/regions/fr-par/data-sources/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "data-source");
  // Snapshot is keyed under the real data source ID, never the literal "latest".
  assertEquals(writes[0].name, G.dataSourceId);
  assertEquals(writes[0].data.type, "metrics");
  assertEquals(writes[0].data.url, "https://metrics.example.com");
  assertEquals(writes[0].data.retentionDays, 31);
});

Deno.test("create POSTs the data source body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-ds",
          type: "logs",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-ds",
        type: "logs",
        retentionDays: 7,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/cockpit/v1/regions/fr-par/data-sources");
  assertStringIncludes(String(call.init.body), "new-ds");
  assertStringIncludes(String(call.init.body), "retention_days");
  assertEquals(writes[0].data.type, "logs");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("delete DELETEs the data source", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.dataSourceId,
          type: "metrics",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.dataSourceId);
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
  assertEquals(writes[0].name, G.dataSourceId);
  assertEquals(writes[0].data.id, G.dataSourceId);
  assertEquals(writes[0].data.type, "absent");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { data_sources: [{ id: "a", type: "metrics" }], total_count: 2 }
        : { data_sources: [{ id: "b", type: "logs" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "data-source");
});

Deno.test("list-tokens aggregates tokens and never writes a secret key", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? {
          tokens: [{
            id: "tok-a",
            name: "writer",
            project_id: G.projectId,
            region: "fr-par",
            scopes: { write_metrics: true },
            // A hostile/verbose API echoing the one-time secret must never leak.
            secret_key: "must-not-leak-secret",
          }],
          total_count: 1,
        }
        : { tokens: [], total_count: 1 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods["list-tokens"].execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "token");
  assertEquals(writes[0].name, "tok-a");
  const snapshot = writes[0].data;
  const serialized = JSON.stringify(snapshot);
  // The token snapshot must carry metadata but never any secret material.
  assertEquals(
    Object.prototype.hasOwnProperty.call(snapshot, "secret_key"),
    false,
  );
  assertEquals(
    Object.prototype.hasOwnProperty.call(snapshot, "secretKey"),
    false,
  );
  assertEquals(serialized.includes("must-not-leak-secret"), false);
  assertEquals(
    (snapshot.scopes as Record<string, unknown>).write_metrics,
    true,
  );
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

Deno.test("data source and token paths are regional", () => {
  assertEquals(
    _internal.dataSourcesPath(G),
    "/cockpit/v1/regions/fr-par/data-sources",
  );
  assertEquals(
    _internal.tokensPath(G),
    "/cockpit/v1/regions/fr-par/tokens",
  );
});
