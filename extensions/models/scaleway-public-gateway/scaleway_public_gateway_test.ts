/**
 * Unit tests for scaleway_public_gateway.ts — URL construction, auth header,
 * resource mapping, pagination, create/update/delete flows, and error handling,
 * with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_public_gateway.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  zone: "fr-par-1",
  gatewayId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the gateway and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.gatewayId,
          name: "gw-1",
          status: "running",
          type: "VPC-GW-S",
          ipv4: { address: "203.0.113.10" },
          bastion_enabled: true,
          bastion_port: 61000,
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/vpc-gw/v2/zones/fr-par-1/gateways/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "gateway");
  assertEquals(writes[0].name, G.gatewayId);
  assertEquals(writes[0].data.status, "running");
  assertEquals(writes[0].data.publicIp, "203.0.113.10");
  assertEquals(writes[0].data.bastionEnabled, true);
});

Deno.test("create POSTs the body with project_id and maps the new gateway", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ id: "new-gw", name: "edge-gw", status: "allocating" }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute(
        { name: "edge-gw", type: "VPC-GW-S" },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/vpc-gw/v2/zones/fr-par-1/gateways");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.project_id, G.projectId);
  assertEquals(body.name, "edge-gw");
  assertEquals(body.type, "VPC-GW-S");
  assertEquals(writes[0].name, "new-gw");
  assertEquals(writes[0].data.id, "new-gw");
  assertEquals(writes[0].data.status, "allocating");
});

Deno.test("delete DELETEs with delete_ip and writes an absent snapshot under gatewayId", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response("", { status: 200 });
    },
    () => model.methods.delete.execute({ deleteIp: true }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "DELETE");
  assertStringIncludes(call.url, "/vpc-gw/v2/zones/fr-par-1/gateways/");
  assertStringIncludes(call.url, "delete_ip=true");
  assertEquals(writes[0].name, G.gatewayId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("delete treats a 404 as success and writes an absent snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    () => model.methods.delete.execute({ deleteIp: false }, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.gatewayId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("delete re-throws non-404 errors", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    async () => {
      try {
        await model.methods.delete.execute({ deleteIp: false }, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "500");
      }
    },
  );
  assert(threw);
  assertEquals(writes.length, 0);
});

Deno.test("update PATCHes mutable fields and maps the response under gatewayId", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.gatewayId,
          name: "renamed-gw",
          status: "running",
          tags: ["prod"],
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.update.execute(
        { name: "renamed-gw", tags: ["prod"], enableBastion: true },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "PATCH");
  assertStringIncludes(call.url, "/vpc-gw/v2/zones/fr-par-1/gateways/");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.name, "renamed-gw");
  assertEquals(body.tags, ["prod"]);
  assertEquals(body.enable_bastion, true);
  assertEquals(writes[0].name, G.gatewayId);
  assertEquals(writes[0].data.name, "renamed-gw");
  assertEquals(writes[0].data.status, "running");
});

Deno.test("valid-zone check passes for a real zone and fails otherwise", () => {
  assertEquals(
    model.checks["valid-zone"].execute({ globalArgs: G }).pass,
    true,
  );
  // it-mil-1 is a valid Public Gateway v2 zone.
  assertEquals(
    model.checks["valid-zone"].execute({
      globalArgs: { ...G, zone: "it-mil-1" },
    }).pass,
    true,
  );
  const bad = model.checks["valid-zone"].execute({
    globalArgs: { ...G, zone: "us-east-1" },
  });
  assertEquals(bad.pass, false);
  assert((bad.errors ?? []).length > 0);
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { gateways: [{ id: "a", status: "running" }], total_count: 2 }
        : { gateways: [{ id: "b", status: "stopped" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "gateway");
  assertEquals(writes[0].name, "a");
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

// --- gatewayId is optional: create provisions it, other methods require it --

Deno.test("create works with no gatewayId set (no placeholder needed)", async () => {
  const { gatewayId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "55555555-5555-5555-5555-555555555555",
          name: "fresh-gw",
          status: "allocating",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute(
        { name: "fresh-gw", type: "VPC-GW-S" },
        ctx,
      ),
  );
  // The new ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.id, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.name, "fresh-gw");
});

for (const method of ["sync", "update", "delete"] as const) {
  Deno.test(`${method} fails fast with an actionable error when gatewayId is absent`, async () => {
    const { gatewayId: _omitted, ...noId } = G;
    const { ctx, writes } = makeContext(noId);
    let fetched = false;
    const err = await withMockedFetch(
      () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      async () => {
        // The guard runs before args are read, so an empty arg object is fine
        // even for `delete`, whose schema has a required (defaulted) field.
        const execute = model.methods[method].execute as (
          args: unknown,
          ctx: unknown,
        ) => Promise<unknown>;
        try {
          await execute({}, ctx);
          return null;
        } catch (e) {
          return e as Error;
        }
      },
    );
    assert(err !== null, `${method} should throw when gatewayId is missing`);
    assertStringIncludes(err.message, "gatewayId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}

Deno.test("_internal exposes the canonical helpers and mappers", () => {
  assertEquals(typeof _internal.scalewayFetch, "function");
  assertEquals(typeof _internal.scalewayListAll, "function");
  assertEquals(
    _internal.gatewaysPath({ ...G, endpoint: undefined }),
    "/vpc-gw/v2/zones/fr-par-1/gateways",
  );
});
