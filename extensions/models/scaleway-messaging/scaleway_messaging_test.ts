/**
 * Unit tests for scaleway_messaging.ts — URL construction, auth header, resource
 * mapping, pagination, delete-404 idempotency, region check, error handling, and
 * secret hygiene, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_messaging.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  natsAccountId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the account and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.natsAccountId,
          name: "nats-1",
          endpoint: "nats://nats.mnq.fr-par.scaleway.com:4222",
          project_id: G.projectId,
          region: "fr-par",
          max_streams: 10,
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
  assertStringIncludes(call.url, "/mnq/v1beta1/regions/fr-par/nats-accounts/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "nats-account");
  // Snapshot is keyed under the real account ID, never the literal "latest".
  assertEquals(writes[0].name, G.natsAccountId);
  assertEquals(writes[0].data.name, "nats-1");
  assertEquals(
    writes[0].data.endpoint,
    "nats://nats.mnq.fr-par.scaleway.com:4222",
  );
  assertEquals(writes[0].data.maxStreams, 10);
  assertEquals(writes[0].data.projectId, G.projectId);
});

Deno.test("create POSTs the account body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-nats",
          region: "fr-par",
          project_id: G.projectId,
        }),
        { status: 200 },
      );
    },
    () => model.methods.create.execute({ name: "new-nats" }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/mnq/v1beta1/regions/fr-par/nats-accounts");
  // The project ID and name must be sent in the request body.
  assertStringIncludes(String(call.init.body), "new-nats");
  assertStringIncludes(String(call.init.body), G.projectId);
  assertEquals(writes[0].data.name, "new-nats");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("no secret key ever leaks into a snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-nats",
          region: "fr-par",
          // A hostile/verbose API echoing a credential must never leak into a snapshot.
          credentials: { nats_credentials: G.secretKey },
        }),
        { status: 200 },
      ),
    () => model.methods.create.execute({ name: "new-nats" }, ctx),
  );
  const serialized = JSON.stringify(writes[0].data);
  assertEquals(serialized.includes(G.secretKey), false);
  assertEquals(serialized.includes("nats_credentials"), false);
});

Deno.test("update PATCHes mutable fields and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.natsAccountId,
          name: "renamed",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ name: "renamed" }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertEquals(writes[0].name, G.natsAccountId);
  assertEquals(writes[0].data.name, "renamed");
});

Deno.test("delete DELETEs the account", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({ id: G.natsAccountId, region: "fr-par" }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.natsAccountId);
  assertEquals(writes[0].data.id, G.natsAccountId);
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
  assertEquals(writes[0].name, G.natsAccountId);
  assertEquals(writes[0].data.id, G.natsAccountId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { nats_accounts: [{ id: "a", name: "one" }], total_count: 2 }
        : { nats_accounts: [{ id: "b", name: "two" }], total_count: 2 };
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

Deno.test("natsAccountsPath is regional", () => {
  assertEquals(
    _internal.natsAccountsPath(G),
    "/mnq/v1beta1/regions/fr-par/nats-accounts",
  );
});
