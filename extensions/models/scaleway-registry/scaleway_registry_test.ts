/**
 * Unit tests for scaleway_registry.ts — URL construction, auth header, resource
 * mapping, pagination, idempotent delete, and error handling, with a mocked
 * fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_registry.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  namespaceId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the namespace and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.namespaceId,
          name: "my-app",
          status: "ready",
          description: "App images",
          endpoint: "rg.fr-par.scw.cloud/my-app",
          is_public: false,
          size: 1048576,
          image_count: 3,
          region: "fr-par",
          project_id: G.projectId,
          organization_id: "44444444-4444-4444-4444-444444444444",
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
  assertStringIncludes(call.url, "/registry/v1/regions/fr-par/namespaces/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "namespace");
  // Snapshot is keyed under the real namespace ID, never the literal "latest".
  assertEquals(writes[0].name, G.namespaceId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.endpoint, "rg.fr-par.scw.cloud/my-app");
  assertEquals(writes[0].data.isPublic, false);
  assertEquals(writes[0].data.size, 1048576);
  assertEquals(writes[0].data.imageCount, 3);
});

Deno.test("create POSTs the namespace body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-ns",
          status: "ready",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-ns",
        description: "for CI images",
        isPublic: true,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/registry/v1/regions/fr-par/namespaces");
  const body = String(call.init.body);
  assertStringIncludes(body, "new-ns");
  assertStringIncludes(body, "is_public");
  assertStringIncludes(body, G.projectId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("update PATCHes mutable fields and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  let body = "";
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      body = String(init.body);
      return new Response(
        JSON.stringify({
          id: G.namespaceId,
          name: "my-app",
          status: "ready",
          description: "updated",
          is_public: true,
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.update.execute(
        { description: "updated", isPublic: true },
        ctx,
      ),
  );
  assertEquals(methods[0], "PATCH");
  assertStringIncludes(body, "is_public");
  assertEquals(writes[0].name, G.namespaceId);
  assertEquals(writes[0].data.description, "updated");
  assertEquals(writes[0].data.isPublic, true);
});

Deno.test("delete DELETEs the namespace", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.namespaceId,
          status: "deleting",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.namespaceId);
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
  assertEquals(writes[0].name, G.namespaceId);
  assertEquals(writes[0].data.id, G.namespaceId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { namespaces: [{ id: "a", status: "ready" }], total_count: 2 }
        : { namespaces: [{ id: "b", status: "ready" }], total_count: 2 };
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

Deno.test("namespacesPath is regional", () => {
  assertEquals(
    _internal.namespacesPath(G),
    "/registry/v1/regions/fr-par/namespaces",
  );
});

// --- namespaceId is optional: create provisions it, others require it ------

Deno.test("create works with no namespaceId set (no placeholder needed)", async () => {
  const { namespaceId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "55555555-5555-5555-5555-555555555555",
          name: "fresh-ns",
          status: "ready",
          region: "fr-par",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        name: "fresh-ns",
        isPublic: false,
      }, ctx),
  );
  // The new ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.id, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.name, "fresh-ns");
});

for (const method of ["sync", "update", "delete"] as const) {
  Deno.test(`${method} fails fast with an actionable error when namespaceId is absent`, async () => {
    const { namespaceId: _omitted, ...noId } = G;
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
    assert(err !== null, `${method} should throw when namespaceId is missing`);
    assertStringIncludes(err.message, "namespaceId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
