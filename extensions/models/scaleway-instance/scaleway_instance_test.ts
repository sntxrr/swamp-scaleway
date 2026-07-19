/**
 * Unit tests for scaleway_instance.ts — URL construction, auth header, resource
 * mapping, pagination, and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_instance.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  zone: "fr-par-1",
  serverId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the server and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          server: { id: G.serverId, state: "running", name: "web-1" },
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/instance/v1/zones/fr-par-1/servers/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "server");
  assertEquals(writes[0].data.state, "running");
});

Deno.test("sync writes the snapshot under the real serverId, not 'latest'", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({ server: { id: G.serverId, state: "running" } }),
        { status: 200 },
      ),
    () => model.methods.sync.execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.serverId);
});

Deno.test("action POSTs the verb then re-reads state", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({ server: { id: G.serverId, state: "starting" } }),
        { status: 200 },
      );
    },
    () => model.methods.action.execute({ action: "poweron" }, ctx),
  );
  assertEquals(methods[0], "POST");
  assertEquals(methods[1], "GET");
  assertEquals(writes[0].data.state, "starting");
  assertEquals(writes[0].name, G.serverId);
});

Deno.test("action('terminate') POSTs once, skips the re-read GET, and writes a terminating snapshot", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      // A GET here would 404 (server gone) — assert it is never issued.
      return new Response(JSON.stringify({}), { status: 200 });
    },
    () => model.methods.action.execute({ action: "terminate" }, ctx),
  );
  assertEquals(methods.length, 1);
  assertEquals(methods[0], "POST");
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.serverId);
  assertEquals(writes[0].data.state, "terminating");
  assertEquals(writes[0].data.id, G.serverId);
  assertEquals(writes[0].data.zone, G.zone);
  assertEquals(writes[0].data.name, null);
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { servers: [{ id: "a", state: "running" }], total_count: 2 }
        : { servers: [{ id: "b", state: "stopped" }], total_count: 2 };
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

// --- serverId is optional: `list` discovers, other methods require it -------

Deno.test("list works with no serverId set (factory discovery needs no placeholder)", async () => {
  const { serverId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          servers: [
            { id: "srv-a", state: "running" },
            { id: "srv-b", state: "stopped" },
          ],
          total_count: 2,
        }),
        { status: 200 },
      ),
    () => model.methods.list.execute({}, ctx),
  );
  // Discovered IDs come from the API, never from a preset globalArg.
  assertEquals(writes.length, 2);
  assertEquals(writes.map((w) => w.name).sort(), ["srv-a", "srv-b"]);
});

for (const method of ["sync", "action"] as const) {
  Deno.test(`${method} fails fast with an actionable error when serverId is absent`, async () => {
    const { serverId: _omitted, ...noId } = G;
    const { ctx, writes } = makeContext(noId);
    let fetched = false;
    // `action` requires an args object; `sync` ignores it. The guard runs
    // before either is read, so one shared shape is fine here.
    const exec = model.methods[method].execute as unknown as (
      args: unknown,
      ctx: unknown,
    ) => Promise<unknown>;
    const err = await withMockedFetch(
      () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      async () => {
        try {
          await exec({ action: "poweron" }, ctx);
          return null;
        } catch (e) {
          return e as Error;
        }
      },
    );
    assert(err !== null, `${method} should throw when serverId is missing`);
    assertStringIncludes(err.message, "serverId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
