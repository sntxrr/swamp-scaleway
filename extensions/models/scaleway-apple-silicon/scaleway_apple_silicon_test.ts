/**
 * Unit tests for scaleway_apple_silicon.ts — URL construction, auth header,
 * resource mapping, pagination, idempotent delete, the valid-zone check, the
 * reboot action, and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_apple_silicon.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  zone: "fr-par-1",
  serverId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the server and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.serverId,
          status: "ready",
          name: "mac-1",
          type: "M2-M",
          ip: "192.0.2.10",
          project_id: G.projectId,
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
    "/apple-silicon/v1alpha1/zones/fr-par-1/servers/",
  );
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "server");
  assertEquals(writes[0].data.status, "ready");
  assertEquals(writes[0].data.type, "M2-M");
  assertEquals(writes[0].data.ip, "192.0.2.10");
});

Deno.test("sync writes the snapshot under the real serverId, not 'latest'", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({ id: G.serverId, status: "ready" }),
        { status: 200 },
      ),
    () => model.methods.sync.execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.serverId);
});

Deno.test("sync never leaks credential fields into the snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: G.serverId,
          status: "ready",
          sudo_password: "s3cr3t",
          ssh_username: "m1",
          vnc_url: "vnc://192.0.2.10",
        }),
        { status: 200 },
      ),
    () => model.methods.sync.execute({}, ctx),
  );
  const data = writes[0].data;
  assertEquals(data.sudo_password, undefined);
  assertEquals(data.ssh_username, undefined);
  assertEquals(data.vnc_url, undefined);
});

Deno.test("create POSTs name/type/project_id and keys the snapshot by the new id", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  const newId = "33333333-3333-3333-3333-333333333333";
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ id: newId, status: "starting", name: "mac-new" }),
        { status: 201 },
      );
    },
    () =>
      model.methods.create.execute(
        { name: "mac-new", type: "M2-M" },
        ctx,
      ),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.name, "mac-new");
  assertEquals(body.type, "M2-M");
  assertEquals(body.project_id, G.projectId);
  assertEquals(writes[0].name, newId);
  assertEquals(writes[0].data.status, "starting");
});

Deno.test("update PATCHes only the provided fields", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ id: G.serverId, status: "ready", name: "renamed" }),
        { status: 200 },
      );
    },
    () => model.methods.update.execute({ name: "renamed" }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "PATCH");
  const body = JSON.parse(String(call.init.body));
  assertEquals(body.name, "renamed");
  assertEquals("schedule_deletion" in body, false);
  assertEquals(writes[0].name, G.serverId);
  assertEquals(writes[0].data.name, "renamed");
});

Deno.test("action reboot POSTs to /reboot then re-reads state", async () => {
  const { ctx, writes } = makeContext();
  const calls: Array<{ method: string; url: string }> = [];
  await withMockedFetch(
    (url, init) => {
      calls.push({ method: String(init.method ?? "GET"), url });
      return new Response(
        JSON.stringify({ id: G.serverId, status: "rebooting" }),
        { status: 200 },
      );
    },
    () => model.methods.action.execute({ action: "reboot" }, ctx),
  );
  assertEquals(calls[0].method, "POST");
  assertStringIncludes(calls[0].url, "/servers/" + G.serverId + "/reboot");
  assertEquals(calls[1].method, "GET");
  assertEquals(writes[0].name, G.serverId);
  assertEquals(writes[0].data.status, "rebooting");
});

Deno.test("delete treats a 404 as success and writes an absent snapshot", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 }),
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].name, G.serverId);
  assertEquals(writes[0].data.absent, true);
  assertEquals(writes[0].data.status, "deleted");
  assertEquals(writes[0].data.id, G.serverId);
});

Deno.test("delete DELETEs then writes an absent snapshot on success", async () => {
  const { ctx, writes } = makeContext();
  let method: string | null = null;
  await withMockedFetch(
    (_url, init) => {
      method = String(init.method ?? "GET");
      return new Response(null, { status: 204 });
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(method, "DELETE");
  assertEquals(writes[0].data.absent, true);
});

Deno.test("delete re-throws non-404 errors and writes nothing", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    async () => {
      try {
        await model.methods.delete.execute({}, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "500");
      }
    },
  );
  assert(threw);
  assertEquals(writes.length, 0);
});

Deno.test("list aggregates pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { servers: [{ id: "a", status: "ready" }], total_count: 2 }
        : { servers: [{ id: "b", status: "stopped" }], total_count: 2 };
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

Deno.test("valid-zone check passes for a real zone and fails for a bogus one", () => {
  const pass = model.checks["valid-zone"].execute({ globalArgs: G });
  assertEquals(pass.pass, true);

  const fail = model.checks["valid-zone"].execute({
    globalArgs: { ...G, zone: "us-east-1" },
  });
  assertEquals(fail.pass, false);
  assert(fail.errors !== undefined && fail.errors.length > 0);
  assertStringIncludes(fail.errors[0], "us-east-1");
});

Deno.test("serversPath targets the apple-silicon zoned prefix", () => {
  assertEquals(
    _internal.serversPath(G),
    "/apple-silicon/v1alpha1/zones/fr-par-1/servers",
  );
});

// --- discovery + connection-info (added for the Apple silicon trial) --------

Deno.test("list-server-types GETs /server-types, keys by name, lifts stock + minimum lease", async () => {
  const { ctx, writes } = makeContext();
  let url = "";
  await withMockedFetch(
    (u) => {
      url = u;
      return new Response(
        JSON.stringify({
          server_types: [
            {
              name: "M4-M",
              stock: "low_stock",
              minimum_lease_duration: "86400s",
              cpu: { name: "Apple M4", core_count: 10 },
              memory: { capacity: 16000000000 },
              disk: { capacity: 256000000000 },
            },
            // second form: Duration as an object {seconds}
            {
              name: "M2-L-ASAHI",
              stock: { unexpected: true },
              minimum_lease_duration: { seconds: "86400" },
            },
          ],
        }),
        { status: 200 },
      );
    },
    () => model.methods["list-server-types"].execute({}, ctx),
  );
  assertStringIncludes(
    url,
    "/apple-silicon/v1alpha1/zones/fr-par-1/server-types",
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "server-type");
  assertEquals(writes[0].name, "M4-M");
  assertEquals(writes[0].data.stock, "low_stock");
  assertEquals(writes[0].data.minimumLeaseDuration, "86400s");
  // Duration-object form is coerced to "<seconds>s".
  assertEquals(writes[1].data.minimumLeaseDuration, "86400s");
  // The full API object is preserved under `raw`.
  assertEquals((writes[0].data.raw as Record<string, unknown>).name, "M4-M");
});

Deno.test("list-os GETs /os, keys by id, maps compatible server types", async () => {
  const { ctx, writes } = makeContext();
  let url = "";
  await withMockedFetch(
    (u) => {
      url = u;
      return new Response(
        JSON.stringify({
          os: [
            {
              id: "decafedd-9f25-4e16-b86b-47c5a6c6577b",
              name: "fedora-asahi-remix",
              version: "42",
              compatible_server_types: ["M2-L-ASAHI"],
            },
          ],
        }),
        { status: 200 },
      );
    },
    () => model.methods["list-os"].execute({}, ctx),
  );
  assertStringIncludes(url, "/apple-silicon/v1alpha1/zones/fr-par-1/os");
  assertEquals(writes[0].spec, "os");
  assertEquals(writes[0].name, "decafedd-9f25-4e16-b86b-47c5a6c6577b");
  assertEquals(writes[0].data.version, "42");
  assertEquals(writes[0].data.compatibleServerTypes, ["M2-L-ASAHI"]);
});

Deno.test("connection-info surfaces creds in the connection resource but never logs them", async () => {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const logs: string[] = [];
  // deno-lint-ignore no-explicit-any
  const record = (msg: string, props?: Record<string, unknown>) =>
    logs.push(msg + " " + JSON.stringify(props ?? {}));
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
    // deno-lint-ignore no-explicit-any
  } as any;

  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: G.serverId,
          status: "ready",
          ssh_username: "m1",
          sudo_password: "s3cr3t-passw0rd",
          vnc_url: "vnc://192.0.2.10?token=abc123",
          ip: "192.0.2.10",
        }),
        { status: 200 },
      ),
    () => model.methods["connection-info"].execute({}, ctx),
  );

  // The creds ARE captured (so the model is actually usable)…
  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "connection");
  assertEquals(writes[0].name, G.serverId);
  assertEquals(writes[0].data.sshUsername, "m1");
  assertEquals(writes[0].data.sudoPassword, "s3cr3t-passw0rd");
  assertEquals(writes[0].data.vncUrl, "vnc://192.0.2.10?token=abc123");

  // …but they must NEVER appear in any log line.
  const allLogs = logs.join("\n");
  assert(!allLogs.includes("s3cr3t-passw0rd"), "sudo password leaked to logs");
  assert(!allLogs.includes("token=abc123"), "vnc token leaked to logs");
});

Deno.test("the connection resource spec is marked sensitiveOutput", () => {
  assertEquals(model.resources["connection"].sensitiveOutput, true);
});
