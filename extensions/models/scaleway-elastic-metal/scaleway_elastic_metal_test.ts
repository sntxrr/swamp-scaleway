/**
 * Unit tests for scaleway_elastic_metal.ts — URL construction, auth header,
 * resource mapping, list pagination, idempotent delete, the valid-zone check,
 * lifecycle action, and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_elastic_metal.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  zone: "fr-par-1",
  serverId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the server and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.serverId,
          name: "metal-1",
          status: "ready",
          offer_id: "offer-abc",
          ips: [{ address: "203.0.113.10", version: "IPv4" }],
          tags: ["prod"],
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/baremetal/v1/zones/fr-par-1/servers/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "server");
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.publicIp, "203.0.113.10");
  assertEquals(writes[0].data.offerId, "offer-abc");
});

Deno.test("sync writes the snapshot under the real serverId, not 'latest'", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({ id: G.serverId, status: "ready", ips: [], tags: [] }),
        { status: 200 },
      ),
    () => model.methods.sync.execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.serverId);
});

Deno.test("create POSTs the offer and project then writes under the returned id", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "metal-new",
          status: "delivering",
          ips: [],
          tags: [],
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute(
        { name: "metal-new", offerId: "offer-xyz" },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/baremetal/v1/zones/fr-par-1/servers");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.offer_id, "offer-xyz");
  assertEquals(body.project_id, G.projectId);
  assertEquals(body.name, "metal-new");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
  assertEquals(writes[0].data.status, "delivering");
});

Deno.test("action POSTs the verb to the right path then re-reads state", async () => {
  const { ctx, writes } = makeContext();
  const calls: Array<{ method: string; url: string }> = [];
  await withMockedFetch(
    (url, init) => {
      calls.push({ method: String(init.method ?? "GET"), url });
      return new Response(
        JSON.stringify({
          id: G.serverId,
          status: "starting",
          ips: [],
          tags: [],
        }),
        { status: 200 },
      );
    },
    () => model.methods.action.execute({ action: "start" }, ctx),
  );
  assertEquals(calls[0].method, "POST");
  assertStringIncludes(calls[0].url, "/servers/" + G.serverId + "/start");
  assertEquals(calls[1].method, "GET");
  assertEquals(writes[0].data.status, "starting");
  assertEquals(writes[0].name, G.serverId);
});

Deno.test("delete treats a 404 as already-absent (idempotent) and writes a deleting snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.serverId);
  assertEquals(writes[0].data.status, "deleting");
});

Deno.test("delete rethrows a non-404 error", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    async () => {
      try {
        await model.methods.delete.execute({}, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "500");
      }
    },
  );
  assert(threw);
  assertEquals(writes.length, 0);
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? {
          servers: [{ id: "a", status: "ready", ips: [], tags: [] }],
          total_count: 2,
        }
        : {
          servers: [{ id: "b", status: "stopped", ips: [], tags: [] }],
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

Deno.test("valid-zone check passes for a real zone and fails for a bogus one", () => {
  const pass = model.checks["valid-zone"].execute({ globalArgs: G });
  assertEquals(pass.pass, true);

  const fail = model.checks["valid-zone"].execute({
    globalArgs: { ...G, zone: "us-east-1" },
  });
  assertEquals(fail.pass, false);
  assert(fail.errors !== undefined && fail.errors.length > 0);
  assertStringIncludes(fail.errors[0], "us-east-1");
});

Deno.test("serversPath builds the zoned baremetal collection path", () => {
  assertEquals(
    _internal.serversPath(G),
    "/baremetal/v1/zones/fr-par-1/servers",
  );
});
