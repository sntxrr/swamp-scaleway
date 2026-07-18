/**
 * Unit tests for scaleway_tem.ts — URL construction, auth header, domain and
 * email mapping, pagination, idempotent delete, region policy check, and error
 * handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_tem.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  domainId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the domain and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.domainId,
          domain_name: "mail.example.com",
          status: "checked",
          project_id: G.projectId,
          region: "fr-par",
          reputation: { status: "excellent" },
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
    "/transactional-email/v1alpha1/regions/fr-par/domains/",
  );
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "domain");
  // Snapshot is keyed under the real domain ID, never the literal "latest".
  assertEquals(writes[0].name, G.domainId);
  assertEquals(writes[0].data.domainName, "mail.example.com");
  assertEquals(writes[0].data.status, "checked");
  assertEquals(writes[0].data.reputation, "excellent");
});

Deno.test("create POSTs the domain body and snapshots the result", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          domain_name: "mail.example.com",
          status: "pending",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        domainName: "mail.example.com",
        acceptTos: true,
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(
    call.url,
    "/transactional-email/v1alpha1/regions/fr-par/domains",
  );
  assertStringIncludes(String(call.init.body), "mail.example.com");
  assertStringIncludes(String(call.init.body), "accept_tos");
  assertEquals(writes[0].data.status, "pending");
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
});

Deno.test("delete POSTs to the /delete sub-path", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ id: G.domainId, status: "revoked", region: "fr-par" }),
        { status: 200 },
      );
    },
    () => model.methods.delete.execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, `/domains/${G.domainId}/delete`);
  assertEquals(writes[0].name, G.domainId);
  assertEquals(writes[0].data.status, "revoked");
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
  assertEquals(writes[0].name, G.domainId);
  assertEquals(writes[0].data.id, G.domainId);
  assertEquals(writes[0].data.status, "revoked");
});

Deno.test("list aggregates domain pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { domains: [{ id: "a", status: "checked" }], total_count: 2 }
        : { domains: [{ id: "b", status: "pending" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "domain");
  assertEquals(writes[0].name, "a");
});

Deno.test("list-emails aggregates email pages and maps sender/recipients", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      assertStringIncludes(
        url,
        "/transactional-email/v1alpha1/regions/fr-par/emails",
      );
      const body = page === "1"
        ? {
          emails: [{
            id: "e1",
            subject: "Welcome",
            status: "sent",
            from: { email: "noreply@example.com" },
            to: [{ email: "user@example.com" }],
          }],
          total_count: 2,
        }
        : {
          emails: [{ id: "e2", subject: "Receipt", status: "new" }],
          total_count: 2,
        };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods["list-emails"].execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "email");
  assertEquals(writes[0].name, "e1");
  assertEquals(writes[0].data.fromEmail, "noreply@example.com");
  assertEquals(writes[0].data.toEmails, ["user@example.com"]);
  assertEquals(writes[0].data.status, "sent");
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

Deno.test("domainsPath and emailsPath are regional", () => {
  assertEquals(
    _internal.domainsPath(G),
    "/transactional-email/v1alpha1/regions/fr-par/domains",
  );
  assertEquals(
    _internal.emailsPath(G),
    "/transactional-email/v1alpha1/regions/fr-par/emails",
  );
});
