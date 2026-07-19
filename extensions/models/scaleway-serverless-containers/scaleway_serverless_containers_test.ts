/**
 * Unit tests for scaleway_serverless_containers.ts — URL construction, auth
 * header, resource mapping, pagination (containers + namespaces), idempotent
 * delete, the redeploy action, region validation, and error handling, with a
 * mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_serverless_containers.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  containerId: "22222222-2222-2222-2222-222222222222",
  namespaceId: "44444444-4444-4444-4444-444444444444",
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

Deno.test("sync GETs the container and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.containerId,
          name: "web",
          namespace_id: G.namespaceId,
          status: "ready",
          min_scale: 0,
          max_scale: 5,
          memory_limit: 256,
          cpu_limit: 140,
          registry_image: "rg.fr-par.scw.cloud/ns/app:latest",
          port: 8080,
          privacy: "public",
          domain_name: "app.example.com",
          region: "fr-par",
          created_at: "2026-07-17T00:00:00Z",
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
    "/containers/v1beta1/regions/fr-par/containers/",
  );
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "container");
  // Snapshot is keyed under the real container ID, never the literal "latest".
  assertEquals(writes[0].name, G.containerId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.namespaceId, G.namespaceId);
  assertEquals(writes[0].data.maxScale, 5);
  assertEquals(writes[0].data.memoryLimit, 256);
  assertEquals(
    writes[0].data.registryImage,
    "rg.fr-par.scw.cloud/ns/app:latest",
  );
  assertEquals(writes[0].data.port, 8080);
  assertEquals(writes[0].data.domainName, "app.example.com");
});

Deno.test("create POSTs the container body with namespace_id and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-container",
          namespace_id: G.namespaceId,
          status: "creating",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-container",
        registryImage: "rg.fr-par.scw.cloud/ns/app:latest",
        port: 8080,
        minScale: 0,
        maxScale: 3,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(
    call.url,
    "/containers/v1beta1/regions/fr-par/containers",
  );
  assertStringIncludes(String(call.init.body), G.namespaceId);
  assertStringIncludes(String(call.init.body), "registry_image");
  assertEquals(writes[0].data.status, "creating");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("create without a namespaceId throws and writes nothing", async () => {
  const { ctx, writes } = makeContext({ ...G, namespaceId: undefined });
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({}), { status: 200 }),
    async () => {
      try {
        await model.methods.create.execute({ name: "x" }, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "namespaceId");
      }
    },
  );
  assert(threw);
  assertEquals(writes.length, 0);
});

Deno.test("update PATCHes mutable fields and re-snapshots under the container id", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.containerId,
          name: "web",
          status: "ready",
          max_scale: 10,
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ maxScale: 10 }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertEquals(writes[0].name, G.containerId);
  assertEquals(writes[0].data.maxScale, 10);
});

Deno.test("action POSTs to the redeploy endpoint and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.containerId,
          status: "pending",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.action.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/redeploy");
  assertEquals(writes[0].name, G.containerId);
  assertEquals(writes[0].data.status, "pending");
});

Deno.test("delete DELETEs the container", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.containerId,
          status: "deleting",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.containerId);
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
  assertEquals(writes[0].name, G.containerId);
  assertEquals(writes[0].data.id, G.containerId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates container pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext({ ...G, namespaceId: undefined });
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { containers: [{ id: "a", status: "ready" }], total_count: 2 }
        : { containers: [{ id: "b", status: "creating" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "container");
  assertEquals(writes[0].name, "a");
});

Deno.test("list scopes to a namespace when namespaceId is set", async () => {
  const { ctx } = makeContext();
  let firstUrl = "";
  await withMockedFetch(
    (url) => {
      if (!firstUrl) firstUrl = url;
      return new Response(
        JSON.stringify({ containers: [], total_count: 0 }),
        { status: 200 },
      );
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertStringIncludes(firstUrl, `namespace_id=${G.namespaceId}`);
});

Deno.test("list-namespaces aggregates pages and writes namespace snapshots", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? {
          namespaces: [{ id: "n1", name: "ns-1", status: "ready" }],
          total_count: 2,
        }
        : {
          namespaces: [{ id: "n2", name: "ns-2", status: "ready" }],
          total_count: 2,
        };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods["list-namespaces"].execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "namespace");
  assertEquals(writes[0].name, "n1");
  assertEquals(writes[1].data.name, "ns-2");
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

Deno.test("containersPath and namespacesPath are regional", () => {
  assertEquals(
    _internal.containersPath(G),
    "/containers/v1beta1/regions/fr-par/containers",
  );
  assertEquals(
    _internal.namespacesPath(G),
    "/containers/v1beta1/regions/fr-par/namespaces",
  );
});

// --- containerId is optional: create provisions it, others require it -------

Deno.test("create works with no containerId set (no placeholder needed)", async () => {
  const { containerId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "55555555-5555-5555-5555-555555555555",
          name: "provisioned",
          namespace_id: G.namespaceId,
          status: "creating",
          region: "fr-par",
        }),
        { status: 200 },
      ),
    () => model.methods.create.execute({ name: "provisioned" }, ctx),
  );
  // The new ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.id, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.name, "provisioned");
});

for (const method of ["sync", "update", "delete", "action"] as const) {
  Deno.test(`${method} fails fast with an actionable error when containerId is absent`, async () => {
    const { containerId: _omitted, ...noId } = G;
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
    assert(err !== null, `${method} should throw when containerId is missing`);
    assertStringIncludes(err.message, "containerId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
