/**
 * Unit tests for scaleway_account.ts — global (no zone/region) URL
 * construction, auth header, Project mapping, pagination, idempotent delete,
 * org-specified check, and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_account.ts";

const G = {
  secretKey: "scw-secret-test",
  organizationId: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
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

/** Assert a path carries no zoned/regional segment (Account is global). */
function assertGlobalPath(url: string): void {
  assert(!url.includes("/regions/"), `URL must not be regional: ${url}`);
  assert(!url.includes("/zones/"), `URL must not be zoned: ${url}`);
}

Deno.test("sync GETs the Project (global path) and maps it with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.projectId,
          name: "prod",
          description: "Production project",
          organization_id: G.organizationId,
          created_at: "2026-07-17T00:00:00Z",
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/account/v3/projects/");
  assertGlobalPath(call.url);
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "project");
  // Snapshot is keyed under the real project ID, never the literal "latest".
  assertEquals(writes[0].name, G.projectId);
  assertEquals(writes[0].data.name, "prod");
  assertEquals(writes[0].data.organizationId, G.organizationId);
});

Deno.test("create POSTs the Project body (with organization_id) and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-project",
          organization_id: G.organizationId,
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-project",
        description: "provisioned by swamp",
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/account/v3/projects");
  assertGlobalPath(call.url);
  // The body is Organization-scoped (organization_id).
  assertStringIncludes(String(call.init.body), "organization_id");
  assertStringIncludes(String(call.init.body), G.organizationId);
  // Snapshot keyed under the newly returned project ID.
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
  assertEquals(writes[0].data.name, "new-project");
});

Deno.test("update PATCHes mutable fields and re-snapshots under the project ID", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.projectId,
          name: "renamed-project",
          organization_id: G.organizationId,
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ name: "renamed-project" }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertEquals(writes[0].name, G.projectId);
  assertEquals(writes[0].data.name, "renamed-project");
});

Deno.test("delete DELETEs the Project (global path) and snapshots it", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  let captured = "";
  await withMockedFetch(
    (url, init) => {
      captured = url;
      methods.push(String(init.method ?? "GET"));
      return new Response(null, { status: 204 });
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertStringIncludes(captured, "/account/v3/projects/");
  assertGlobalPath(captured);
  assertEquals(writes[0].name, G.projectId);
  assertEquals(writes[0].data.id, G.projectId);
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
  assertEquals(writes[0].name, G.projectId);
  assertEquals(writes[0].data.id, G.projectId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates Project pages until total_count is reached (global path)", async () => {
  const { ctx, writes } = makeContext();
  const urls: string[] = [];
  await withMockedFetch(
    (url) => {
      urls.push(url);
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { projects: [{ id: "a", name: "proj-a" }], total_count: 2 }
        : { projects: [{ id: "b", name: "proj-b" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  for (const u of urls) {
    assertGlobalPath(u);
    assertStringIncludes(u, "/account/v3/projects");
    assertStringIncludes(u, "organization_id=");
  }
  assertEquals(writes[0].spec, "project");
  // Factory snapshots keyed under each Project's own real id.
  assertEquals(writes[0].name, "a");
  assertEquals(writes[1].name, "b");
});

Deno.test("a non-2xx response throws and writes nothing", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "forbidden" }), { status: 403 }),
    async () => {
      try {
        await model.methods.sync.execute({}, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "403");
      }
    },
  );
  assert(threw);
  assertEquals(writes.length, 0);
});

Deno.test("org-specified check passes when organizationId is set and fails when blank", () => {
  const check = model.checks["org-specified"];
  assertEquals(check.execute({ globalArgs: G }).pass, true);
  const bad = check.execute({
    globalArgs: { ...G, organizationId: "" },
  });
  assertEquals(bad.pass, false);
  assert(Array.isArray(bad.errors) && bad.errors.length > 0);
  assertStringIncludes(bad.errors[0], "organizationId");
});

Deno.test("Account Projects path is global — no zone/region segment", () => {
  assertEquals(_internal.projectsPath(), "/account/v3/projects");
  assert(!_internal.projectsPath().includes("/regions/"));
  assert(!_internal.projectsPath().includes("/zones/"));
});
