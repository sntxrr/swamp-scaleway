/**
 * Unit tests for scaleway_key_manager.ts — URL construction, auth header, key
 * mapping, pagination, idempotent delete, region validation, encrypt/decrypt
 * round-trip shape, error handling, and plaintext secret hygiene, with a mocked
 * fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_key_manager.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  keyId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the key and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.keyId,
          name: "app-key",
          state: "enabled",
          usage: { symmetric_encryption: "aes_256_gcm" },
          rotation_count: 3,
          region: "fr-par",
          project_id: G.projectId,
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
    "/key-manager/v1alpha1/regions/fr-par/keys/",
  );
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "key");
  // Snapshot is keyed under the real key ID, never the literal "latest".
  assertEquals(writes[0].name, G.keyId);
  assertEquals(writes[0].data.state, "enabled");
  assertEquals(writes[0].data.rotationCount, 3);
  assertEquals(
    (writes[0].data.usage as Record<string, unknown>).symmetric_encryption,
    "aes_256_gcm",
  );
});

Deno.test("create POSTs the key body and snapshots under the new ID", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-key",
          state: "enabled",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-key",
        usageSymmetricEncryption: "aes_256_gcm",
        unprotected: false,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/key-manager/v1alpha1/regions/fr-par/keys");
  assertStringIncludes(String(call.init.body), "symmetric_encryption");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
  assertEquals(writes[0].data.state, "enabled");
});

Deno.test("delete DELETEs the key and snapshots under the key ID", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response(
        JSON.stringify({ id: G.keyId, state: "deleting", region: "fr-par" }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.keyId);
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
  assertEquals(writes[0].name, G.keyId);
  assertEquals(writes[0].data.id, G.keyId);
  assertEquals(writes[0].data.state, "absent");
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
  assertEquals(writes[0].data.state, "absent");
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

Deno.test("encrypt POSTs to the encrypt path and snapshots only ciphertext", async () => {
  const { ctx, writes, logs } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  const PLAINTEXT = "c3VwZXItc2VjcmV0LXBsYWludGV4dA=="; // base64
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ ciphertext: "Q0lQSEVSVEVYVA==", key_id: G.keyId }),
        { status: 200 },
      );
    },
    () => model.methods.encrypt.execute({ plaintext: PLAINTEXT }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, `/keys/${G.keyId}/encrypt`);
  // Plaintext is sent in the request body to encrypt.
  assertStringIncludes(String(call.init.body), PLAINTEXT);
  // The snapshot stores ciphertext only, never the plaintext.
  assertEquals(writes[0].spec, "cipher");
  assertEquals(writes[0].data.ciphertext, "Q0lQSEVSVEVYVA==");
  assertEquals(
    Object.prototype.hasOwnProperty.call(writes[0].data, "plaintext"),
    false,
  );
  assertEquals(JSON.stringify(writes[0].data).includes(PLAINTEXT), false);
  // Plaintext must never be logged.
  assertEquals(logs.join("\n").includes(PLAINTEXT), false);
});

Deno.test("decrypt POSTs to the decrypt path and returns plaintext via a sensitive field", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  const PLAINTEXT = "cmVjb3ZlcmVkLXBsYWludGV4dA=="; // base64
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ plaintext: PLAINTEXT, key_id: G.keyId }),
        { status: 200 },
      );
    },
    () =>
      model.methods.decrypt.execute({ ciphertext: "Q0lQSEVSVEVYVA==" }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, `/keys/${G.keyId}/decrypt`);
  // The recovered plaintext is returned in the dedicated "plaintext" resource.
  assertEquals(writes[0].spec, "plaintext");
  assertEquals(writes[0].name, G.keyId);
  assertEquals(writes[0].data.plaintext, PLAINTEXT);
  // The carrying field is declared sensitive in the schema.
  const shape = model.resources.plaintext.schema.shape as Record<
    string,
    { meta?: () => Record<string, unknown> }
  >;
  const meta = shape.plaintext.meta?.() ?? {};
  assertEquals(meta.sensitive, true);
});

Deno.test("encrypt/decrypt is a round-trip over the same key", async () => {
  const encCtx = makeContext();
  const decCtx = makeContext();
  const PLAINTEXT = "cm91bmQtdHJpcA=="; // base64
  const CIPHERTEXT = "Um91bmRUcmlwQ2lwaGVy";
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({ ciphertext: CIPHERTEXT, key_id: G.keyId }),
        { status: 200 },
      ),
    () => model.methods.encrypt.execute({ plaintext: PLAINTEXT }, encCtx.ctx),
  );
  assertEquals(encCtx.writes[0].data.ciphertext, CIPHERTEXT);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({ plaintext: PLAINTEXT, key_id: G.keyId }),
        { status: 200 },
      ),
    () =>
      model.methods.decrypt.execute(
        { ciphertext: String(encCtx.writes[0].data.ciphertext) },
        decCtx.ctx,
      ),
  );
  assertEquals(decCtx.writes[0].data.plaintext, PLAINTEXT);
  assertEquals(decCtx.writes[0].data.keyId, G.keyId);
});

Deno.test("no plaintext leaks into any snapshot or log across encrypt then decrypt", async () => {
  const { ctx, writes, logs } = makeContext();
  const ENC_PLAINTEXT = "ZW5jcnlwdC1pbnB1dC1wbGFpbnRleHQ="; // base64
  const DEC_PLAINTEXT = "ZGVjcnlwdC1vdXRwdXQtcGxhaW50ZXh0"; // base64
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({ ciphertext: "Q0lQSA==", key_id: G.keyId }),
        { status: 200 },
      ),
    () => model.methods.encrypt.execute({ plaintext: ENC_PLAINTEXT }, ctx),
  );
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({ plaintext: DEC_PLAINTEXT, key_id: G.keyId }),
        { status: 200 },
      ),
    () => model.methods.decrypt.execute({ ciphertext: "Q0lQSA==" }, ctx),
  );
  // The encrypt-input plaintext must appear in NO snapshot at all.
  for (const w of writes) {
    assertEquals(JSON.stringify(w.data).includes(ENC_PLAINTEXT), false);
  }
  // The decrypt-output plaintext appears ONLY in the "plaintext" resource's
  // sensitive field — never in the "cipher" or "key" (normal) snapshots.
  for (const w of writes) {
    if (w.spec !== "plaintext") {
      assertEquals(JSON.stringify(w.data).includes(DEC_PLAINTEXT), false);
    }
  }
  // Neither plaintext is ever logged.
  const allLogs = logs.join("\n");
  assertEquals(allLogs.includes(ENC_PLAINTEXT), false);
  assertEquals(allLogs.includes(DEC_PLAINTEXT), false);
});

Deno.test("rotate POSTs to the rotate path and re-snapshots the key", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.keyId,
          state: "enabled",
          rotation_count: 4,
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () => model.methods.rotate.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, `/keys/${G.keyId}/rotate`);
  assertEquals(writes[0].spec, "key");
  assertEquals(writes[0].name, G.keyId);
  assertEquals(writes[0].data.rotationCount, 4);
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { keys: [{ id: "a", state: "enabled" }], total_count: 2 }
        : { keys: [{ id: "b", state: "disabled" }], total_count: 2 };
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

Deno.test("keysPath is regional and versioned v1alpha1", () => {
  assertEquals(
    _internal.keysPath(G),
    "/key-manager/v1alpha1/regions/fr-par/keys",
  );
});
