/**
 * Unit tests for scaleway_secret_manager.ts — URL construction, auth header,
 * metadata mapping, pagination, delete-404 idempotency, region validation,
 * add-version + access shape, error handling, and — most importantly — secret
 * VALUE hygiene: the secret value must never land in a metadata snapshot or a
 * log line. All tests mock `fetch`; no live calls.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_secret_manager.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  secretId: "22222222-2222-2222-2222-222222222222",
};

// deno-lint-ignore no-explicit-any
type AnyCtx = any;
function makeContext(): {
  ctx: AnyCtx;
  writes: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
  logs: string[];
} {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const logs: string[] = [];
  const record = (message: string, props?: Record<string, unknown>) => {
    logs.push(message + " " + JSON.stringify(props ?? {}));
  };
  const ctx = {
    globalArgs: G,
    logger: { info: record, warn: record },
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { ctx, writes, logs };
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

Deno.test("sync GETs the secret and maps metadata with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.secretId,
          name: "db-password",
          status: "ready",
          version_count: 3,
          type: "opaque",
          region: "fr-par",
          tags: ["prod"],
          path: "/prod",
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
  assertStringIncludes(
    call.url,
    "/secret-manager/v1beta1/regions/fr-par/secrets/",
  );
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "secret");
  // Snapshot is keyed under the real secret ID, never the literal "latest".
  assertEquals(writes[0].name, G.secretId);
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.versionCount, 3);
  assertEquals(writes[0].data.type, "opaque");
  assertEquals(writes[0].data.path, "/prod");
});

Deno.test("create POSTs metadata (name/tags, no value) and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "api-token",
          status: "ready",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "api-token",
        tags: ["prod"],
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(
    call.url,
    "/secret-manager/v1beta1/regions/fr-par/secrets",
  );
  // Metadata only — a create request never carries a secret value.
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.name, "api-token");
  assertEquals(body.project_id, G.projectId);
  assertEquals(Object.prototype.hasOwnProperty.call(body, "data"), false);
  assertEquals(Object.prototype.hasOwnProperty.call(body, "value"), false);
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
  assertEquals(writes[0].data.status, "ready");
});

Deno.test("update PATCHes mutable metadata and re-snapshots", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.secretId,
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
  assertEquals(writes[0].name, G.secretId);
  assertEquals(writes[0].data.name, "renamed");
});

Deno.test("delete DELETEs the secret and snapshots the response", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({
          id: G.secretId,
          status: "deleting",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.secretId);
  assertEquals(writes[0].data.status, "deleting");
});

Deno.test("delete treats a 404 as success and writes an absent snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.secretId);
  assertEquals(writes[0].data.id, G.secretId);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("delete treats a 412 resource_not_usable (already deleted) as success", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          help_message: "cannot act on deleted resource",
          precondition: "resource_not_usable",
          type: "precondition_failed",
        }),
        { status: 412 },
      ),
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].data.status, "absent");
});

Deno.test("delete re-throws a 412 that is not resource_not_usable", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({ precondition: "locked", type: "precondition_failed" }),
        { status: 412 },
      ),
    async () => {
      let threw = false;
      try {
        await model.methods.delete.execute({}, ctx);
      } catch {
        threw = true;
      }
      assert(threw, "expected a non-resource_not_usable 412 to re-throw");
    },
  );
  assertEquals(writes.length, 0);
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { secrets: [{ id: "a", status: "ready" }], total_count: 2 }
        : { secrets: [{ id: "b", status: "ready" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].name, "a");
  assertEquals(writes[1].name, "b");
});

Deno.test("add-version base64-encodes the value and POSTs to /versions", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          secret_id: G.secretId,
          revision: 4,
          status: "enabled",
          latest: true,
          created_at: "2026-07-17T02:00:00Z",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods["add-version"].execute({
        value: "s3cr3t-value",
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, `/secrets/${G.secretId}/versions`);
  const body = JSON.parse(String(call.init.body));
  // The value is base64-encoded into `data`, and the raw value never appears.
  assertEquals(body.data, _internal.toBase64("s3cr3t-value"));
  assertEquals(String(call.init.body).includes("s3cr3t-value"), false);
  // Only version METADATA is snapshotted — no value.
  assertEquals(writes[0].spec, "secretVersion");
  assertEquals(writes[0].name, G.secretId);
  assertEquals(writes[0].data.revision, 4);
  assertEquals(
    Object.prototype.hasOwnProperty.call(writes[0].data, "value"),
    false,
  );
});

Deno.test("access GETs the version value and returns it via the sensitive secretValue spec", async () => {
  const { ctx, writes } = makeContext();
  const plaintext = "correct horse battery staple";
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          secret_id: G.secretId,
          revision: 4,
          data: _internal.toBase64(plaintext),
        }),
        { status: 200 },
      );
    },
    () => model.methods.access.execute({ revision: "latest" }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertStringIncludes(
    call.url,
    `/secrets/${G.secretId}/versions/latest/access`,
  );
  // The decoded value is delivered only via the sensitive `secretValue` spec.
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "secretValue");
  assertEquals(writes[0].name, G.secretId);
  assertEquals(writes[0].data.value, plaintext);
  // The spec is declared sensitive so the value is vaulted before persistence.
  assertEquals(model.resources.secretValue.sensitiveOutput, true);
});

Deno.test("SECRET HYGIENE: the value never appears in a metadata snapshot or a log line", async () => {
  const plaintext = "TOP-SECRET-PLAINTEXT-VALUE";

  // 1. add-version: value must not reach the secretVersion snapshot or any log.
  {
    const { ctx, writes, logs } = makeContext();
    await withMockedFetch(
      () =>
        new Response(
          JSON.stringify({
            secret_id: G.secretId,
            revision: 1,
            status: "enabled",
          }),
          { status: 200 },
        ),
      () => model.methods["add-version"].execute({ value: plaintext }, ctx),
    );
    for (const w of writes) {
      assertEquals(
        JSON.stringify(w.data).includes(plaintext),
        false,
        `value leaked into ${w.spec} snapshot`,
      );
    }
    for (const line of logs) {
      assertEquals(line.includes(plaintext), false, "value leaked into a log");
    }
  }

  // 2. access: value goes ONLY to the sensitive secretValue spec, never to a
  //    metadata (`secret`/`secretVersion`) snapshot, and never to a log line.
  {
    const { ctx, writes, logs } = makeContext();
    await withMockedFetch(
      () =>
        new Response(
          JSON.stringify({
            secret_id: G.secretId,
            revision: 1,
            data: _internal.toBase64(plaintext),
          }),
          { status: 200 },
        ),
      () => model.methods.access.execute({ revision: "latest" }, ctx),
    );
    for (const w of writes) {
      if (w.spec === "secret" || w.spec === "secretVersion") {
        assertEquals(
          JSON.stringify(w.data).includes(plaintext),
          false,
          `value leaked into ${w.spec} metadata snapshot`,
        );
      }
    }
    // The only place the value appears is the sensitive secretValue spec.
    const carriers = writes.filter((w) =>
      JSON.stringify(w.data).includes(plaintext)
    );
    assertEquals(carriers.length, 1);
    assertEquals(carriers[0].spec, "secretValue");
    // And it is never logged.
    for (const line of logs) {
      assertEquals(line.includes(plaintext), false, "value leaked into a log");
    }
  }
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
  const bad = check.execute({ globalArgs: { ...G, region: "us-east-1" } });
  assertEquals(bad.pass, false);
  assert(Array.isArray(bad.errors) && bad.errors.length > 0);
  assertStringIncludes(bad.errors[0], "us-east-1");
});

Deno.test("secretsPath is regional under the v1beta1 prefix", () => {
  assertEquals(
    _internal.secretsPath(G),
    "/secret-manager/v1beta1/regions/fr-par/secrets",
  );
});

Deno.test("base64 round-trips UTF-8 values", () => {
  const value = "pä$$wörd-🔐";
  assertEquals(_internal.fromBase64(_internal.toBase64(value)), value);
});
