/**
 * Unit tests for scaleway_load_balancer.ts — URL construction, auth header,
 * resource mapping, pagination, create/delete flows, and error handling, with a
 * mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_load_balancer.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  zone: "fr-par-1",
  lbId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the LB and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.lbId,
          name: "lb-1",
          status: "ready",
          ip: [{ ip_address: "203.0.113.10" }],
          frontend_count: 2,
          backend_count: 3,
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/lb/v1/zones/fr-par-1/lbs/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "loadBalancer");
  assertEquals(writes[0].name, G.lbId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.publicIp, "203.0.113.10");
  assertEquals(writes[0].data.frontendCount, 2);
});

Deno.test("create POSTs the body with project_id and maps the new LB", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ id: "new-lb", name: "web-lb", status: "pending" }),
        { status: 200 },
      );
    },
    () => model.methods.create.execute({ name: "web-lb", type: "LB-S" }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/lb/v1/zones/fr-par-1/lbs");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.project_id, G.projectId);
  assertEquals(body.name, "web-lb");
  assertEquals(body.type, "LB-S");
  assertEquals(writes[0].name, "new-lb");
  assertEquals(writes[0].data.id, "new-lb");
  assertEquals(writes[0].data.status, "pending");
});

Deno.test("delete DELETEs with release_ip and writes an absent snapshot under lbId", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response("", { status: 200 });
    },
    () => model.methods.delete.execute({ releaseIp: true }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "DELETE");
  assertStringIncludes(call.url, "/lb/v1/zones/fr-par-1/lbs/");
  assertStringIncludes(call.url, "release_ip=true");
  assertEquals(writes[0].name, G.lbId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("delete treats a 404 as success and writes an absent snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    () => model.methods.delete.execute({ releaseIp: false }, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.lbId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("delete re-throws non-404 errors", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    async () => {
      try {
        await model.methods.delete.execute({ releaseIp: false }, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "500");
      }
    },
  );
  assert(threw);
  assertEquals(writes.length, 0);
});

Deno.test("update PUTs mutable fields and maps the response under lbId", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.lbId,
          name: "renamed-lb",
          description: "updated",
          status: "ready",
          tags: ["prod"],
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.update.execute(
        { name: "renamed-lb", description: "updated", tags: ["prod"] },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "PUT");
  assertStringIncludes(call.url, "/lb/v1/zones/fr-par-1/lbs/");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.name, "renamed-lb");
  assertEquals(body.description, "updated");
  assertEquals(body.tags, ["prod"]);
  assertEquals(writes[0].name, G.lbId);
  assertEquals(writes[0].data.name, "renamed-lb");
  assertEquals(writes[0].data.status, "ready");
});

Deno.test("valid-zone check passes for a real zone and fails otherwise", () => {
  assertEquals(
    model.checks["valid-zone"].execute({ globalArgs: G }).pass,
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
        ? { lbs: [{ id: "a", status: "ready" }], total_count: 2 }
        : { lbs: [{ id: "b", status: "pending" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "loadBalancer");
});

Deno.test("list-backends fetches the LB's backends and maps them", async () => {
  const { ctx, writes } = makeContext();
  let capturedUrl = "";
  await withMockedFetch(
    (url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          backends: [
            { id: "be-1", name: "pool", forward_port: 80 },
          ],
          total_count: 1,
        }),
        { status: 200 },
      );
    },
    () => model.methods["list-backends"].execute({}, ctx),
  );
  assertStringIncludes(capturedUrl, "/lbs/");
  assertStringIncludes(capturedUrl, "/backends");
  assertEquals(writes[0].spec, "backend");
  assertEquals(writes[0].data.forwardPort, 80);
  assertEquals(writes[0].data.lbId, G.lbId);
});

Deno.test("list-frontends fetches the LB's frontends and maps them", async () => {
  const { ctx, writes } = makeContext();
  let capturedUrl = "";
  await withMockedFetch(
    (url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          frontends: [
            { id: "fe-1", name: "http", inbound_port: 443, backend_id: "be-1" },
          ],
          total_count: 1,
        }),
        { status: 200 },
      );
    },
    () => model.methods["list-frontends"].execute({}, ctx),
  );
  assertStringIncludes(capturedUrl, "/frontends");
  assertEquals(writes[0].spec, "frontend");
  assertEquals(writes[0].data.inboundPort, 443);
  assertEquals(writes[0].data.backendId, "be-1");
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

Deno.test("_internal exposes the canonical helpers and mappers", () => {
  assertEquals(typeof _internal.scalewayFetch, "function");
  assertEquals(typeof _internal.scalewayListAll, "function");
  assertEquals(
    _internal.lbsPath({ ...G, endpoint: undefined }),
    "/lb/v1/zones/fr-par-1/lbs",
  );
});
