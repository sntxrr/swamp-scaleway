/**
 * Unit tests for scaleway_iam.ts — global (no zone/region) URL construction,
 * auth header, resource mapping, pagination, idempotent delete, org-specified
 * check, error handling, and secret hygiene (no secret_key leaks), with a
 * mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_iam.ts";

const G = {
  secretKey: "scw-secret-test",
  organizationId: "11111111-1111-1111-1111-111111111111",
  applicationId: "22222222-2222-2222-2222-222222222222",
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

/** Assert a path carries no zoned/regional segment (IAM is global). */
function assertGlobalPath(url: string): void {
  assert(!url.includes("/regions/"), `URL must not be regional: ${url}`);
  assert(!url.includes("/zones/"), `URL must not be zoned: ${url}`);
}

Deno.test("sync GETs the application (global path) and maps it with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.applicationId,
          name: "ci-app",
          description: "CI application",
          organization_id: G.organizationId,
          editable: true,
          nb_api_keys: 2,
          created_at: "2026-07-17T00:00:00Z",
        }),
        { status: 200 },
      );
    },
    () => model.methods.sync.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(call.url, "/iam/v1alpha1/applications/");
  assertGlobalPath(call.url);
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "application");
  // Snapshot is keyed under the real application ID, never the literal "latest".
  assertEquals(writes[0].name, G.applicationId);
  assertEquals(writes[0].data.name, "ci-app");
  assertEquals(writes[0].data.organizationId, G.organizationId);
  assertEquals(writes[0].data.nbApiKeys, 2);
});

Deno.test("create POSTs the application body (with organization_id) and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-app",
          organization_id: G.organizationId,
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-app",
        description: "provisioned by swamp",
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/iam/v1alpha1/applications");
  assertGlobalPath(call.url);
  // The body is Organization-scoped (organization_id, not project_id).
  assertStringIncludes(String(call.init.body), "organization_id");
  assertStringIncludes(String(call.init.body), G.organizationId);
  assertEquals(String(call.init.body).includes("project_id"), false);
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
  assertEquals(writes[0].data.name, "new-app");
});

Deno.test("update PATCHes mutable fields and re-snapshots under the app ID", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.applicationId,
          name: "renamed-app",
          organization_id: G.organizationId,
        }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ name: "renamed-app" }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertEquals(writes[0].name, G.applicationId);
  assertEquals(writes[0].data.name, "renamed-app");
});

Deno.test("delete DELETEs the application and snapshots it", async () => {
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
  assertGlobalPath(captured);
  assertEquals(writes[0].name, G.applicationId);
  assertEquals(writes[0].data.id, G.applicationId);
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
  assertEquals(writes[0].name, G.applicationId);
  assertEquals(writes[0].data.id, G.applicationId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("list aggregates application pages until total_count is reached (global path)", async () => {
  const { ctx, writes } = makeContext();
  const urls: string[] = [];
  await withMockedFetch(
    (url) => {
      urls.push(url);
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { applications: [{ id: "a", name: "app-a" }], total_count: 2 }
        : { applications: [{ id: "b", name: "app-b" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  for (const u of urls) {
    assertGlobalPath(u);
    assertStringIncludes(u, "organization_id=");
  }
  assertEquals(writes[0].spec, "application");
});

Deno.test("list-api-keys paginates and snapshots metadata only — no secret_key", async () => {
  const { ctx, writes } = makeContext();
  const urls: string[] = [];
  await withMockedFetch(
    (url) => {
      urls.push(url);
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? {
          api_keys: [{
            access_key: "SCWACCESSKEY1",
            application_id: G.applicationId,
            // Hostile/verbose API echoing a secret must never reach a snapshot.
            secret_key: "leaked-secret-1",
          }],
          total_count: 2,
        }
        : {
          api_keys: [{
            access_key: "SCWACCESSKEY2",
            application_id: G.applicationId,
            secret_key: "leaked-secret-2",
          }],
          total_count: 2,
        };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods["list-api-keys"].execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  for (const u of urls) {
    assertGlobalPath(u);
    assertStringIncludes(u, "/iam/v1alpha1/api-keys");
    assertStringIncludes(u, "application_id=");
  }
  // Keyed under the non-secret access key.
  assertEquals(writes[0].spec, "api-key");
  assertEquals(writes[0].name, "SCWACCESSKEY1");
  assertEquals(writes[0].data.accessKey, "SCWACCESSKEY1");
});

Deno.test("no secret_key leaks into any api-key snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          api_keys: [{
            access_key: "SCWACCESSKEY1",
            application_id: G.applicationId,
            secret_key: "top-secret-value",
          }],
          total_count: 1,
        }),
        { status: 200 },
      ),
    () => model.methods["list-api-keys"].execute({}, ctx),
  );
  const snapshot = writes[0].data;
  const serialized = JSON.stringify(snapshot);
  assertEquals(
    Object.prototype.hasOwnProperty.call(snapshot, "secretKey"),
    false,
  );
  assertEquals(
    Object.prototype.hasOwnProperty.call(snapshot, "secret_key"),
    false,
  );
  assertEquals(serialized.includes("top-secret-value"), false);
  assertEquals(serialized.includes("secret_key"), false);
});

Deno.test("list-policies paginates and snapshots policies (global path)", async () => {
  const { ctx, writes } = makeContext();
  const urls: string[] = [];
  await withMockedFetch(
    (url) => {
      urls.push(url);
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? {
          policies: [{ id: "p1", name: "policy-1" }],
          total_count: 2,
        }
        : {
          policies: [{ id: "p2", name: "policy-2" }],
          total_count: 2,
        };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods["list-policies"].execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  for (const u of urls) {
    assertGlobalPath(u);
    assertStringIncludes(u, "/iam/v1alpha1/policies");
    assertStringIncludes(u, "organization_id=");
  }
  assertEquals(writes[0].spec, "policy");
  assertEquals(writes[0].name, "p1");
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

Deno.test("IAM paths are global — no zone/region segment", () => {
  assertEquals(_internal.applicationsPath(), "/iam/v1alpha1/applications");
  assertEquals(_internal.apiKeysPath(), "/iam/v1alpha1/api-keys");
  assertEquals(_internal.policiesPath(), "/iam/v1alpha1/policies");
  for (
    const p of [
      _internal.applicationsPath(),
      _internal.apiKeysPath(),
      _internal.policiesPath(),
    ]
  ) {
    assert(!p.includes("/regions/"));
    assert(!p.includes("/zones/"));
  }
});

// --- applicationId is optional: create provisions it, others require it -----

Deno.test("create works with no applicationId set (no placeholder needed)", async () => {
  const { applicationId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "66666666-6666-6666-6666-666666666666",
          name: "provisioned-app",
          organization_id: G.organizationId,
        }),
        { status: 200 },
      ),
    () => model.methods.create.execute({ name: "provisioned-app" }, ctx),
  );
  // The new ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "66666666-6666-6666-6666-666666666666");
  assertEquals(writes[0].data.id, "66666666-6666-6666-6666-666666666666");
  assertEquals(writes[0].data.name, "provisioned-app");
});

for (const method of ["sync", "update", "delete", "list-api-keys"] as const) {
  Deno.test(`${method} fails fast with an actionable error when applicationId is absent`, async () => {
    const { applicationId: _omitted, ...noId } = G;
    const { ctx, writes } = makeContext(noId);
    let fetched = false;
    const err = await withMockedFetch(
      () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      async () => {
        try {
          await model.methods[method].execute({}, ctx);
          return null;
        } catch (e) {
          return e as Error;
        }
      },
    );
    assert(err !== null, `${method} should throw when applicationId is missing`);
    assertStringIncludes(err.message, "applicationId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
