/**
 * Unit tests for scaleway_block_storage.ts — URL construction, auth header,
 * resource mapping, pagination, and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_block_storage.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  zone: "fr-par-1",
  volumeId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the volume and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.volumeId,
          name: "data-1",
          status: "available",
          zone: "fr-par-1",
          size: 10000000000,
          specs: { perf_iops: 5000, class: "bssd" },
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/block/v1/zones/fr-par-1/volumes/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "volume");
  assertEquals(writes[0].data.status, "available");
  assertEquals(writes[0].data.perfIops, 5000);
  assertEquals(writes[0].data.volumeClass, "bssd");
});

Deno.test("create POSTs a from_empty body and stores the new volume id", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "new-vol-id",
          name: "data-2",
          status: "creating",
          zone: "fr-par-1",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute(
        { name: "data-2", size: 20000000000, perfIops: 5000 },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertEquals(call.url.endsWith("/block/v1/zones/fr-par-1/volumes"), true);
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.project_id, G.projectId);
  assertEquals(body.name, "data-2");
  assertEquals(body.perf_iops, 5000);
  assertEquals(body.from_empty.size, 20000000000);
  assertEquals(writes[0].name, "new-vol-id");
  assertEquals(writes[0].data.status, "creating");
});

Deno.test("update PATCHes only the provided mutable fields", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.volumeId,
          name: "renamed",
          status: "resizing",
          zone: "fr-par-1",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.update.execute(
        { name: "renamed", size: 30000000000 },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "PATCH");
  assertStringIncludes(
    call.url,
    `/block/v1/zones/fr-par-1/volumes/${G.volumeId}`,
  );
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.name, "renamed");
  assertEquals(body.size, 30000000000);
  assertEquals("perf_iops" in body, false);
  assertEquals(writes[0].data.name, "renamed");
});

Deno.test("delete DELETEs the volume and records a deleting snapshot", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(null, { status: 204 });
    },
    () => model.methods.delete.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "DELETE");
  assertStringIncludes(
    call.url,
    `/block/v1/zones/fr-par-1/volumes/${G.volumeId}`,
  );
  assertEquals(writes[0].data.status, "deleting");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { volumes: [{ id: "a", status: "available" }], total_count: 2 }
        : { volumes: [{ id: "b", status: "in_use" }], total_count: 2 };
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

Deno.test("_internal.volumesPath builds the zoned collection path", () => {
  assertEquals(
    _internal.volumesPath(G as never),
    "/block/v1/zones/fr-par-1/volumes",
  );
});
