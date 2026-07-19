/**
 * Unit tests for scaleway_serverless_jobs.ts — URL construction, auth header,
 * resource mapping, list pagination, idempotent delete, the run action
 * (StartJobDefinition), region validation, secret env-var handling
 * (sent-but-not-stored), and error handling, with a mocked fetch.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_serverless_jobs.ts";

const G = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
  jobDefinitionId: "22222222-2222-2222-2222-222222222222",
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

Deno.test("sync GETs the job definition and maps the resource with the auth header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: G.jobDefinitionId,
          name: "nightly-batch",
          project_id: G.projectId,
          cpu_limit: 1000,
          memory_limit: 2048,
          local_storage_capacity: 20480,
          image_uri: "rg.fr-par.scw.cloud/ns/batch:latest",
          job_timeout: "3600s",
          description: "nightly ETL",
          cron_schedule: { schedule: "0 2 * * *", timezone: "Europe/Paris" },
          region: "fr-par",
          created_at: "2026-07-17T00:00:00Z",
          environment_variables: { SECRET_TOKEN: "should-not-be-stored" },
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
    "/serverless-jobs/v1alpha2/regions/fr-par/job-definitions/",
  );
  assertEquals(
    (call.init.headers as Record<string, string>)["X-Auth-Token"],
    G.secretKey,
  );
  assertEquals(writes[0].spec, "job-definition");
  // Snapshot is keyed under the real job definition ID, never "latest".
  assertEquals(writes[0].name, G.jobDefinitionId);
  assertEquals(writes[0].data.state, "present");
  assertEquals(writes[0].data.name, "nightly-batch");
  assertEquals(writes[0].data.cpuLimit, 1000);
  assertEquals(writes[0].data.memoryLimit, 2048);
  assertEquals(writes[0].data.localStorageCapacity, 20480);
  assertEquals(writes[0].data.imageUri, "rg.fr-par.scw.cloud/ns/batch:latest");
  assertEquals(writes[0].data.cronSchedule, "0 2 * * *");
  // Environment variables are never copied into a snapshot.
  assertEquals("environmentVariables" in writes[0].data, false);
  assertStringIncludes(JSON.stringify(writes[0].data), "0 2 * * *");
  assert(!JSON.stringify(writes[0].data).includes("should-not-be-stored"));
});

Deno.test("create POSTs the body with project_id and env vars, but never stores env vars", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: "33333333-3333-3333-3333-333333333333",
          name: "new-job",
          project_id: G.projectId,
          cpu_limit: 500,
          memory_limit: 1024,
          local_storage_capacity: 10240,
          image_uri: "rg.fr-par.scw.cloud/ns/app:latest",
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.create.execute({
        name: "new-job",
        cpuLimit: 500,
        memoryLimit: 1024,
        localStorageCapacity: 10240,
        imageUri: "rg.fr-par.scw.cloud/ns/app:latest",
        environmentVariables: { API_SECRET: "sent-not-stored" },
      }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(
    call.url,
    "/serverless-jobs/v1alpha2/regions/fr-par/job-definitions",
  );
  // The secret env var IS sent to the API...
  assertStringIncludes(String(call.init.body), "environment_variables");
  assertStringIncludes(String(call.init.body), "sent-not-stored");
  assertStringIncludes(String(call.init.body), G.projectId);
  // ...but is NEVER written into the resource snapshot.
  assertEquals(writes[0].name, "33333333-3333-3333-3333-333333333333");
  assertEquals(writes[0].data.state, "present");
  assertEquals("environmentVariables" in writes[0].data, false);
  assert(!JSON.stringify(writes[0].data).includes("sent-not-stored"));
});

Deno.test("update PATCHes mutable fields and re-snapshots under the job definition id", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  let body = "";
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      body = String(init.body);
      return new Response(
        JSON.stringify({
          id: G.jobDefinitionId,
          name: "renamed",
          memory_limit: 4096,
          region: "fr-par",
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.update.execute({ name: "renamed", memoryLimit: 4096 }, ctx),
  );
  assertEquals(methods[0], "PATCH");
  assertStringIncludes(body, "memory_limit");
  assertEquals(writes[0].name, G.jobDefinitionId);
  assertEquals(writes[0].data.name, "renamed");
  assertEquals(writes[0].data.memoryLimit, 4096);
});

Deno.test("action POSTs to the /start endpoint and snapshots each returned job run", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          job_runs: [
            {
              id: "run-a",
              job_definition_id: G.jobDefinitionId,
              state: "queued",
              region: "fr-par",
            },
            {
              id: "run-b",
              job_definition_id: G.jobDefinitionId,
              state: "queued",
              region: "fr-par",
            },
          ],
        }),
        { status: 200 },
      );
    },
    () => model.methods.action.execute({ replicas: 2 }, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "/start");
  assertStringIncludes(String(call.init.body), "replicas");
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "job-run");
  assertEquals(writes[0].name, "run-a");
  assertEquals(writes[0].data.state, "queued");
  assertEquals(writes[1].name, "run-b");
});

Deno.test("action never stores contextual env-var secrets in the run snapshot", async () => {
  const { ctx, writes } = makeContext();
  let body = "";
  await withMockedFetch(
    (_u, init) => {
      body = String(init.body);
      return new Response(
        JSON.stringify({
          job_runs: [
            {
              id: "run-a",
              job_definition_id: G.jobDefinitionId,
              state: "queued",
              region: "fr-par",
              environment_variables: { CTX_SECRET: "run-secret" },
            },
          ],
        }),
        { status: 200 },
      );
    },
    () =>
      model.methods.action.execute({
        environmentVariables: { CTX_SECRET: "run-secret" },
      }, ctx),
  );
  // Sent to the API...
  assertStringIncludes(body, "run-secret");
  // ...but never persisted.
  assertEquals("environmentVariables" in writes[0].data, false);
  assert(!JSON.stringify(writes[0].data).includes("run-secret"));
});

Deno.test("delete DELETEs the job definition and records present state", async () => {
  const { ctx, writes } = makeContext();
  const methods: string[] = [];
  await withMockedFetch(
    (_u, init) => {
      methods.push(String(init.method ?? "GET"));
      return new Response("", { status: 200 });
    },
    () => model.methods.delete.execute({}, ctx),
  );
  assertEquals(methods[0], "DELETE");
  assertEquals(writes[0].name, G.jobDefinitionId);
  assertEquals(writes[0].data.id, G.jobDefinitionId);
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
  assertEquals(writes[0].name, G.jobDefinitionId);
  assertEquals(writes[0].data.id, G.jobDefinitionId);
  assertEquals(writes[0].data.state, "absent");
});

Deno.test("list aggregates job-definition pages until total_count is reached", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { job_definitions: [{ id: "a", name: "j1" }], total_count: 2 }
        : { job_definitions: [{ id: "b", name: "j2" }], total_count: 2 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => model.methods.list.execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "job-definition");
  assertEquals(writes[0].name, "a");
  assertEquals(writes[1].name, "b");
});

Deno.test("a non-2xx response throws and writes nothing", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    async () => {
      try {
        await model.methods.sync.execute({}, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "500");
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

Deno.test("jobDefinitionsPath is regional and versioned v1alpha2", () => {
  assertEquals(
    _internal.jobDefinitionsPath(G),
    "/serverless-jobs/v1alpha2/regions/fr-par/job-definitions",
  );
});

// --- jobDefinitionId is optional: create provisions it, others require it ---

Deno.test("create works with no jobDefinitionId set (no placeholder needed)", async () => {
  const { jobDefinitionId: _omitted, ...noId } = G;
  const { ctx, writes } = makeContext(noId);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "55555555-5555-5555-5555-555555555555",
          name: "provisioned",
          project_id: G.projectId,
          region: "fr-par",
        }),
        { status: 200 },
      ),
    () =>
      model.methods.create.execute({
        name: "provisioned",
        cpuLimit: 500,
        memoryLimit: 1024,
        localStorageCapacity: 10240,
        imageUri: "rg.fr-par.scw.cloud/ns/app:latest",
      }, ctx),
  );
  // The new ID comes from the API response, not from a preset globalArg.
  assertEquals(writes[0].name, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.id, "55555555-5555-5555-5555-555555555555");
  assertEquals(writes[0].data.name, "provisioned");
});

for (const method of ["sync", "update", "delete", "action"] as const) {
  Deno.test(`${method} fails fast with an actionable error when jobDefinitionId is absent`, async () => {
    const { jobDefinitionId: _omitted, ...noId } = G;
    const { ctx, writes } = makeContext(noId);
    let fetched = false;
    const err = await withMockedFetch(
      () => {
        fetched = true;
        return new Response("{}", { status: 200 });
      },
      async () => {
        try {
          // deno-lint-ignore no-explicit-any
          await (model.methods[method].execute as any)({}, ctx);
          return null;
        } catch (e) {
          return e as Error;
        }
      },
    );
    assert(
      err !== null,
      `${method} should throw when jobDefinitionId is missing`,
    );
    assertStringIncludes(err.message, "jobDefinitionId");
    assertStringIncludes(err.message, method);
    // Guard runs before any network call or write.
    assertEquals(fetched, false);
    assertEquals(writes.length, 0);
  });
}
