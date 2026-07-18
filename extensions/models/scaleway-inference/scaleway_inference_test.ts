/**
 * Unit tests for scaleway_inference.ts — URL construction, auth header, resource
 * mapping, pagination, error handling, and delete idempotency, with a mocked
 * fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_inference.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  deploymentId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the deployment and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.deploymentId,
          name: "llm-1",
          status: "ready",
          model_id: "44444444-4444-4444-4444-444444444444",
          model_name: "meta/llama-3.1-8b-instruct",
          node_type_name: "L4",
          region: "fr-par",
          size: 1,
          min_size: 1,
          max_size: 1,
          quantization: { bits: 8 },
          endpoints: [{
            id: "55555555-5555-5555-5555-555555555555",
            url: "https://example.com/v1",
            disable_auth: false,
          }],
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
  assertStringIncludes(call.url, "/inference/v1/regions/fr-par/deployments/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "deployment");
  // Snapshot is keyed under the real deployment ID, never the literal "latest".
  assertEquals(writes[0].name, G.deploymentId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.modelName, "meta/llama-3.1-8b-instruct");
  assertEquals(writes[0].data.nodeType, "L4");
  assertEquals(writes[0].data.quantizationBits, 8);
  assertEquals(writes[0].data.endpointUrl, "https://example.com/v1");
});

Deno.test("create POSTs node_type_name + endpoints and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-llm",
          status: "creating",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-llm",
        modelId: "44444444-4444-4444-4444-444444444444",
        nodeType: "L4",
        acceptEula: true,
        publicEndpoint: true,
        disableAuth: false,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/inference/v1/regions/fr-par/deployments");
  const sentBody = String(call.init.body);
  // The create body must use node_type_name and include a public endpoint spec.
  assertStringIncludes(sentBody, "node_type_name");
  assertStringIncludes(sentBody, "public_network");
  assertStringIncludes(sentBody, "accept_eula");
  assertEquals(writes[0].data.status, "creating");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("update PATCHes mutable fields and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  let body: string | undefined;
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      body = String(init.body);
      return new Response(
        JSON.stringify({
          id: G.deploymentId,
          name: "renamed",
          status: "ready",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ name: "renamed", minSize: 2 }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertStringIncludes(String(body), "min_size");
  assertEquals(writes[0].name, G.deploymentId);
  assertEquals(writes[0].data.name, "renamed");
});

Deno.test("delete DELETEs the deployment", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.deploymentId,
          status: "deleting",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.deploymentId);
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
  assertEquals(writes[0].name, G.deploymentId);
  assertEquals(writes[0].data.id, G.deploymentId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates pages using page/page_size until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  const params: Array<{ page: string | null; pageSize: string | null }> = [];
  await withMockedFetch(
    (url) => {
      const u = new URL(url);
      params.push({
        page: u.searchParams.get("page"),
        pageSize: u.searchParams.get("page_size"),
      });
      const page = u.searchParams.get("page");
      const body = page === "1"
        ? { deployments: [{ id: "a", status: "ready" }], total_count: 2 }
        : { deployments: [{ id: "b", status: "creating" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  // Confirms the canonical page/page_size params are used (not per_page).
  assertEquals(params[0].pageSize, "100");
  assertEquals(params[0].page, "1");
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

Deno.test("deploymentsPath is regional", () => {
  assertEquals(
    _internal.deploymentsPath(G),
    "/inference/v1/regions/fr-par/deployments",
  );
});
