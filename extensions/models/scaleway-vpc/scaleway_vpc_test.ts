/**
 * Unit tests for scaleway_vpc.ts — URL construction, auth header, resource
 * mapping, pagination, and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_vpc.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  vpcId: "22222222-2222-2222-2222-222222222222",
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
    writeResource: (spec: string, name: string, data: Record<string, unknown>) => {
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
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {}))) as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("sync GETs the VPC and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.vpcId,
          name: "prod-vpc",
          region: "fr-par",
          tags: ["prod"],
          is_default: false,
          private_network_count: 3,
          routing_enabled: true,
          organization_id: "org-1",
          project_id: G.projectId,
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/vpc/v2/regions/fr-par/vpcs/");
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "vpc");
  assertEquals(writes[0].name, "latest");
  assertEquals(writes[0].data.name, "prod-vpc");
  assertEquals(writes[0].data.routingEnabled, true);
  assertEquals(writes[0].data.privateNetworkCount, 3);
  assertEquals(writes[0].data.organizationId, "org-1");
  assert(typeof writes[0].data.observedAt === "string");
});

Deno.test("create POSTs the body and snapshots the returned VPC", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-vpc",
          region: "fr-par",
          tags: ["team=net"],
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute(
        { name: "new-vpc", tags: ["team=net"], enableRouting: true },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/vpc/v2/regions/fr-par/vpcs");
  const sent = JSON.parse(String(call.init.body));
  assertEquals(sent.name, "new-vpc");
  assertEquals(sent.project_id, G.projectId);
  assertEquals(sent.enable_routing, true);
  assertEquals(sent.tags, ["team=net"]);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "vpc");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
  assertEquals(writes[0].data.name, "new-vpc");
});

Deno.test("delete DELETEs the VPC and writes nothing", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  const result = await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(null, { status: 204 });
    },
    () => model.methods.delete.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "DELETE");
  assertStringIncludes(call.url, "/vpc/v2/regions/fr-par/vpcs/");
  assertStringIncludes(call.url, G.vpcId);
  assertEquals(writes.length, 0);
  assertEquals(result.dataHandles.length, 0);
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { vpcs: [{ id: "a", region: "fr-par", tags: [] }], total_count: 2 }
        : { vpcs: [{ id: "b", region: "fr-par", tags: [] }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "vpc");
  assertEquals(writes[0].name, "a");
  assertEquals(writes[1].name, "b");
});

Deno.test("list-private-networks snapshots each private network", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          private_networks: [
            { id: "pn-1", name: "pn-one", region: "fr-par", tags: [], vpc_id: G.vpcId },
          ],
          total_count: 1,
        }),
        { status: 200 },
      );
    },
    () => model.methods["list-private-networks"].execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertStringIncludes(call.url, "/vpc/v2/regions/fr-par/private-networks");
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "private-network");
  assertEquals(writes[0].name, "pn-1");
  assertEquals(writes[0].data.vpcId, G.vpcId);
});

Deno.test("a non-2xx response throws and writes nothing", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
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

Deno.test("path helpers build the regional VPC URLs", () => {
  assertEquals(_internal.vpcsPath(G), "/vpc/v2/regions/fr-par/vpcs");
  assertEquals(
    _internal.privateNetworksPath(G),
    "/vpc/v2/regions/fr-par/private-networks",
  );
});
