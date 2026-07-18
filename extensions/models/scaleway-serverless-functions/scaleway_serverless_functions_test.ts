/**
 * Unit tests for scaleway_serverless_functions.ts — URL construction, auth
 * header, resource mapping, pagination (functions + namespaces), deploy action,
 * idempotent delete, secret hygiene, and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_serverless_functions.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  functionId: "22222222-2222-2222-2222-222222222222",
  namespaceId: "44444444-4444-4444-4444-444444444444",
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

Deno.test("sync GETs the function and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.functionId,
          name: "hello",
          namespace_id: G.namespaceId,
          status: "ready",
          runtime: "node22",
          handler: "handler.handle",
          privacy: "public",
          memory_limit: 256,
          cpu_limit: 140,
          min_scale: 0,
          max_scale: 20,
          timeout: "300s",
          domain_name: "hello.functions.example.com",
          http_option: "enabled",
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
    "/functions/v1beta1/regions/fr-par/functions/",
  );
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "function");
  // Snapshot is keyed under the real function ID, never the literal "latest".
  assertEquals(writes[0].name, G.functionId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.runtime, "node22");
  assertEquals(writes[0].data.namespaceId, G.namespaceId);
  assertEquals(writes[0].data.memoryLimit, 256);
  assertEquals(writes[0].data.domainName, "hello.functions.example.com");
});

Deno.test("create POSTs the function body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-fn",
          namespace_id: G.namespaceId,
          status: "created",
          runtime: "python312",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-fn",
        runtime: "python312",
        privacy: "public",
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/functions/v1beta1/regions/fr-par/functions");
  assertStringIncludes(String(call.init.body), G.namespaceId);
  assertStringIncludes(String(call.init.body), "python312");
  assertEquals(writes[0].data.status, "created");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("no secret env var is written into the snapshot", async () => {
  const { ctx, writes } = makeContext();
  let capturedBody = "";
  await withMockedFetch(
    (_url, init) => {
      capturedBody = String(init.body);
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-fn",
          status: "created",
          region: "fr-par",
          // A verbose API echoing a secret must never leak into a snapshot.
          secret_environment_variables: [{ key: "API_KEY", value: "echoed" }],
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-fn",
        runtime: "node22",
        privacy: "private",
        secretEnvironmentVariables: { API_KEY: "super-secret-value" },
      }, ctx),
  );
  // The secret must be sent in the request body to provision.
  assertStringIncludes(capturedBody, "super-secret-value");
  const snapshot = writes[0].data;
  const serialized = JSON.stringify(snapshot);
  assertEquals(serialized.includes("super-secret-value"), false);
  assertEquals(serialized.includes("echoed"), false);
  assertEquals(
    Object.prototype.hasOwnProperty.call(
      snapshot,
      "secretEnvironmentVariables",
    ),
    false,
  );
});

Deno.test("update PATCHes mutable fields and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.functionId,
          name: "hello",
          status: "ready",
          memory_limit: 512,
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ memoryLimit: 512 }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertEquals(writes[0].name, G.functionId);
  assertEquals(writes[0].data.memoryLimit, 512);
});

Deno.test("action POSTs to the deploy endpoint and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.functionId,
          status: "deploying",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.action.execute({ op: "deploy" }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, `/functions/${G.functionId}/deploy`);
  assertEquals(writes[0].name, G.functionId);
  assertEquals(writes[0].data.status, "deploying");
});

Deno.test("delete DELETEs the function", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.functionId,
          status: "deleting",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.functionId);
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
  assertEquals(writes[0].name, G.functionId);
  assertEquals(writes[0].data.id, G.functionId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates function pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { functions: [{ id: "a", status: "ready" }], total_count: 2 }
        : { functions: [{ id: "b", status: "created" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "function");
  assertEquals(writes[0].name, "a");
  assertEquals(writes[1].name, "b");
});

Deno.test("list-namespaces aggregates namespace pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  let sawNamespacesPath = false;
  await withMockedFetch(
    (url) => {
      if (url.includes("/namespaces")) sawNamespacesPath = true;
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { namespaces: [{ id: "n1", status: "ready" }], total_count: 2 }
        : { namespaces: [{ id: "n2", status: "pending" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods["list-namespaces"].execute({}, ctx),
  );
  assert(sawNamespacesPath);
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "namespace");
  assertEquals(writes[0].name, "n1");
  assertEquals(writes[1].name, "n2");
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

Deno.test("functionsPath and namespacesPath are regional", () => {
  assertEquals(
    _internal.functionsPath(G),
    "/functions/v1beta1/regions/fr-par/functions",
  );
  assertEquals(
    _internal.namespacesPath(G),
    "/functions/v1beta1/regions/fr-par/namespaces",
  );
});
