/**
 * Unit tests for scaleway_webhosting.ts — URL construction, auth header, resource
 * mapping, pagination, delete idempotency, error handling, and secret hygiene,
 * with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_webhosting.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  hostingId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the hosting and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.hostingId,
          status: "ready",
          domain: "example.com",
          region: "fr-par",
          offer: { id: "44444444-4444-4444-4444-444444444444", name: "Perso" },
          platform: { hostname: "platform.example.com" },
          ipv4: "203.0.113.10",
          user: { username: "webmaster" },
          protected: false,
          dns_status: "valid",
          tags: ["prod"],
          created_at: "2026-07-17T00:00:00Z",
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/webhosting/v1/regions/fr-par/hostings/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "hosting");
  // Snapshot is keyed under the real hosting ID, never the literal "latest".
  assertEquals(writes[0].name, G.hostingId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.domain, "example.com");
  assertEquals(writes[0].data.offerId, "44444444-4444-4444-4444-444444444444");
  assertEquals(writes[0].data.offerName, "Perso");
  assertEquals(writes[0].data.platformHostname, "platform.example.com");
  assertEquals(writes[0].data.ipv4, "203.0.113.10");
  assertEquals(writes[0].data.username, "webmaster");
  assertEquals(writes[0].data.dnsStatus, "valid");
});

Deno.test("create POSTs the hosting body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          status: "delivering",
          domain: "example.com",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        offerId: "44444444-4444-4444-4444-444444444444",
        domain: "example.com",
        email: "admin@example.com",
        tags: ["prod"],
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/webhosting/v1/regions/fr-par/hostings");
  assertStringIncludes(String(call.init.body), "offer_id");
  assertStringIncludes(String(call.init.body), "example.com");
  assertStringIncludes(String(call.init.body), G.projectId);
  assertEquals(writes[0].data.status, "delivering");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("no password or credential field is written into the snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          status: "delivering",
          domain: "example.com",
          region: "fr-par",
          // A verbose/hostile API echoing credentials must never leak into a snapshot.
          one_time_password: "echoed-secret-pw",
          one_time_password_b64: "ZWNob2VkLXNlY3JldC1wdw==",
          user: { username: "webmaster", password: "another-secret" },
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        offerId: "44444444-4444-4444-4444-444444444444",
        domain: "example.com",
      }, ctx),
  );
  const snapshot = writes[0].data;
  const serialized = JSON.stringify(snapshot);
  assertEquals(
    Object.prototype.hasOwnProperty.call(snapshot, "one_time_password"),
    false,
  );
  assertEquals(
    Object.prototype.hasOwnProperty.call(snapshot, "password"),
    false,
  );
  assertEquals(serialized.includes("echoed-secret-pw"), false);
  assertEquals(serialized.includes("another-secret"), false);
  assertEquals(serialized.includes("ZWNob2VkLXNlY3JldC1wdw=="), false);
  // The non-secret username is still captured.
  assertEquals(snapshot.username, "webmaster");
});

Deno.test("update PATCHes mutable fields and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  let body = "";
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      body = String(init.body ?? "");
      return new Response(
        JSON.stringify({
          id: G.hostingId,
          status: "updating",
          domain: "example.com",
          region: "fr-par",
          tags: ["renamed"],
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ tags: ["renamed"] }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertStringIncludes(body, "renamed");
  assertEquals(writes[0].name, G.hostingId);
  assertEquals(writes[0].data.status, "updating");
});

Deno.test("delete DELETEs the hosting", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.hostingId,
          status: "deleting",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.hostingId);
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
  assertEquals(writes[0].name, G.hostingId);
  assertEquals(writes[0].data.id, G.hostingId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { hostings: [{ id: "a", status: "ready" }], total_count: 2 }
        : { hostings: [{ id: "b", status: "delivering" }], total_count: 2 };
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

Deno.test("valid-region check passes for fr-par and fails otherwise", () => {
  const check = model.checks["valid-region"];
  assertEquals(check.execute({ globalArgs: G }).pass, true);
  const bad = check.execute({
    globalArgs: { ...G, region: "nl-ams" },
  });
  assertEquals(bad.pass, false);
  assert(Array.isArray(bad.errors) && bad.errors.length > 0);
  assertStringIncludes(bad.errors[0], "nl-ams");
});

Deno.test("hostingsPath is regional", () => {
  assertEquals(
    _internal.hostingsPath(G),
    "/webhosting/v1/regions/fr-par/hostings",
  );
});
