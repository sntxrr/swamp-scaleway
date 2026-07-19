/**
 * Unit tests for scaleway_kapsule.ts — URL construction, auth header, resource
 * mapping, list + list-pools pagination, idempotent delete, region checks,
 * error handling, and kubeconfig secret hygiene, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_kapsule.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  clusterId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the cluster and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.clusterId,
          name: "cluster-1",
          status: "ready",
          version: "1.30.2",
          type: "kapsule",
          cni: "cilium",
          region: "fr-par",
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
  assertStringIncludes(call.url, "/k8s/v1/regions/fr-par/clusters/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "cluster");
  // Snapshot is keyed under the real cluster ID, never the literal "latest".
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.version, "1.30.2");
  assertEquals(writes[0].data.cni, "cilium");
  assertEquals(writes[0].data.type, "kapsule");
});

Deno.test("create POSTs the cluster body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-cluster",
          status: "creating",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-cluster",
        version: "1.30.2",
        cni: "cilium",
        pools: [{ name: "default", nodeType: "DEV1-M", size: 3 }],
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/k8s/v1/regions/fr-par/clusters");
  // The pool spec is mapped to snake_case node_type in the request body.
  assertStringIncludes(String(call.init.body), "node_type");
  assertStringIncludes(String(call.init.body), "DEV1-M");
  assertEquals(writes[0].data.status, "creating");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("update PATCHes mutable fields and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.clusterId,
          name: "renamed",
          status: "ready",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ name: "renamed" }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.name, "renamed");
});

Deno.test("upgrade POSTs the target version and upgrade_pools flag", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.clusterId,
          name: "cluster-1",
          status: "updating",
          version: "1.31.0",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.upgrade.execute({
        version: "1.31.0",
        upgradePools: true,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/clusters/" + G.clusterId + "/upgrade");
  assertStringIncludes(String(call.init.body), "1.31.0");
  assertStringIncludes(String(call.init.body), "upgrade_pools");
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.status, "updating");
});

Deno.test("delete DELETEs the cluster", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.clusterId,
          status: "deleting",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.clusterId);
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
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.id, G.clusterId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates cluster pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { clusters: [{ id: "a", status: "ready" }], total_count: 2 }
        : { clusters: [{ id: "b", status: "creating" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "cluster");
  assertEquals(writes[0].name, "a");
});

Deno.test("list-pools GETs the cluster's pools and aggregates pages", async () => {
  const { ctx, writes } = makeContext();
  const urls: string[] = [];
  await withMockedFetch(
    (url) => {
      urls.push(url);
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? {
          pools: [{
            id: "p1",
            name: "default",
            node_type: "DEV1-M",
            size: 3,
            status: "ready",
          }],
          total_count: 2,
        }
        : {
          pools: [{
            id: "p2",
            name: "workers",
            node_type: "GP1-XS",
            size: 5,
            status: "scaling",
          }],
          total_count: 2,
        };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods["list-pools"].execute({}, ctx),
  );
  assertStringIncludes(urls[0], "/clusters/" + G.clusterId + "/pools");
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "pool");
  assertEquals(writes[0].name, "p1");
  assertEquals(writes[0].data.nodeType, "DEV1-M");
  assertEquals(writes[0].data.clusterId, G.clusterId);
});

Deno.test("get-kubeconfig stores the base64 content and never leaks it into logs", async () => {
  const { ctx, writes } = makeContext();
  const secretContent = "YXBpVmVyc2lvbjogdjEK"; // base64 kubeconfig bytes
  const logged: string[] = [];
  ctx.logger = {
    info: (message: string, props?: Record<string, unknown>) => {
      logged.push(message + " " + JSON.stringify(props ?? {}));
    },
    warn: (message: string, props?: Record<string, unknown>) => {
      logged.push(message + " " + JSON.stringify(props ?? {}));
    },
  };
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          content: secretContent,
          name: "kubeconfig-cluster-1.yaml",
          type: "config",
        }),
        { status: 200 },
      );
    },
    () => model.methods["get-kubeconfig"].execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/clusters/" + G.clusterId + "/kubeconfig");
  // The kubeconfig content is stored in the sensitive snapshot field...
  assertEquals(writes[0].spec, "kubeconfig");
  assertEquals(writes[0].name, G.clusterId);
  assertEquals(writes[0].data.content, secretContent);
  // ...but must never appear in any log line.
  for (const line of logged) {
    assertEquals(line.includes(secretContent), false);
  }
});

Deno.test("kubeconfig content field is marked sensitive in the schema", () => {
  const schema = model.resources.kubeconfig.schema;
  // deno-lint-ignore no-explicit-any
  const contentField = (schema as any).shape.content;
  const meta = contentField.meta();
  assertEquals(meta?.sensitive, true);
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

Deno.test("clustersPath is regional", () => {
  assertEquals(
    _internal.clustersPath(G),
    "/k8s/v1/regions/fr-par/clusters",
  );
});

// --- clusterId is optional: create provisions it, others require it ---------

Deno.test("create works with no clusterId set (no placeholder needed)", async () => {
  const { clusterId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "66666666-6666-6666-6666-666666666666",
          name: "provisioned-cluster",
          status: "creating",
          version: "1.30.2",
          region: "fr-par",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        name: "provisioned-cluster",
        version: "1.30.2",
        cni: "cilium",
      }, ctx),
  );
  // The new ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "66666666-6666-6666-6666-666666666666");
  assertEquals(writes[0].data.id, "66666666-6666-6666-6666-666666666666");
  assertEquals(writes[0].data.name, "provisioned-cluster");
});

for (
  const method of [
    "sync",
    "update",
    "upgrade",
    "delete",
    "list-pools",
    "get-kubeconfig",
  ] as const
) {
  Deno.test(`${method} fails fast with an actionable error when clusterId is absent`, async () => {
    const { clusterId: _omitted, ...noId } = G;
    const { ctx, writes } = makeContext(noId);
    let fetched = false;
    const err = await withMockedFetch(
      () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      async () => {
        try {
          // The guard runs before any argument is read, so empty args are
          // fine even for methods with required arguments (e.g. upgrade).
          // deno-lint-ignore no-explicit-any
          await (model.methods[method].execute as any)({}, ctx);
          return null;
        } catch (e) {
          return e as Error;
        }
      },
    );
    assert(err !== null, `${method} should throw when clusterId is missing`);
    assertStringIncludes(err.message, "clusterId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
