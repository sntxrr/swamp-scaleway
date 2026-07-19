/**
 * Unit tests for scaleway_file_storage.ts — URL construction, auth header,
 * resource mapping, pagination, delete idempotency, region check, and error
 * handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_file_storage.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  filesystemId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the filesystem and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.filesystemId,
          name: "my-fs",
          status: "available",
          size: 30000000000,
          project_id: G.projectId,
          organization_id: "44444444-4444-4444-4444-444444444444",
          number_of_attachments: 2,
          filesystem_type_id: "55555555-5555-5555-5555-555555555555",
          region: "fr-par",
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
  assertStringIncludes(
    call.url,
    "/file/v1alpha1/regions/fr-par/filesystems/",
  );
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "filesystem");
  // Snapshot is keyed under the real filesystem ID, never the literal "latest".
  assertEquals(writes[0].name, G.filesystemId);
  assertEquals(writes[0].data.status, "available");
  assertEquals(writes[0].data.size, 30000000000);
  assertEquals(writes[0].data.numberOfAttachments, 2);
  assertEquals(writes[0].data.projectId, G.projectId);
  assertEquals(
    writes[0].data.filesystemTypeId,
    "55555555-5555-5555-5555-555555555555",
  );
});

Deno.test("create POSTs the filesystem body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-fs",
          status: "creating",
          size: 25000000000,
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-fs",
        size: 25000000000,
        tags: ["prod"],
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/file/v1alpha1/regions/fr-par/filesystems");
  // The project ID, name, and size are sent in the request body.
  assertStringIncludes(String(call.init.body), G.projectId);
  assertStringIncludes(String(call.init.body), "25000000000");
  assertEquals(writes[0].data.status, "creating");
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
          id: G.filesystemId,
          name: "renamed",
          status: "updating",
          size: 200000000000,
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.update.execute(
        { name: "renamed", size: 200000000000 },
        ctx,
      ),
  );
  assertEquals(methods[0], "PATCH");
  assertStringIncludes(body, "renamed");
  assertStringIncludes(body, "200000000000");
  assertEquals(writes[0].name, G.filesystemId);
  assertEquals(writes[0].data.name, "renamed");
  assertEquals(writes[0].data.size, 200000000000);
});

Deno.test("delete DELETEs the filesystem and writes a deleting snapshot", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      // A successful delete returns 204 with no body.
      return new Response(null, { status: 204 });
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.filesystemId);
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
  assertEquals(writes[0].name, G.filesystemId);
  assertEquals(writes[0].data.id, G.filesystemId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { filesystems: [{ id: "a", status: "available" }], total_count: 2 }
        : { filesystems: [{ id: "b", status: "creating" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  // Each snapshot is keyed under the resource's own real ID.
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

Deno.test("filesystemsPath is regional", () => {
  assertEquals(
    _internal.filesystemsPath(G),
    "/file/v1alpha1/regions/fr-par/filesystems",
  );
});

// --- filesystemId is optional: create provisions it, others require it ------

Deno.test("create works with no filesystemId set (no placeholder needed)", async () => {
  const { filesystemId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "66666666-6666-6666-6666-666666666666",
          name: "provisioned-fs",
          status: "creating",
          size: 25000000000,
          region: "fr-par",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        name: "provisioned-fs",
        size: 25000000000,
      }, ctx),
  );
  // The new ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "66666666-6666-6666-6666-666666666666");
  assertEquals(writes[0].data.id, "66666666-6666-6666-6666-666666666666");
  assertEquals(writes[0].data.name, "provisioned-fs");
});

for (const method of ["sync", "update", "delete"] as const) {
  Deno.test(`${method} fails fast with an actionable error when filesystemId is absent`, async () => {
    const { filesystemId: _omitted, ...noId } = G;
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
    assert(err !== null, `${method} should throw when filesystemId is missing`);
    assertStringIncludes(err.message, "filesystemId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
