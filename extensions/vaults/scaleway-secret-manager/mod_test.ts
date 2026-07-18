/**
 * Unit tests for the Scaleway Secret Manager vault backend — get/put/list/getName
 * against a mocked Scaleway API. Verifies the VaultProvider contract: get throws
 * on missing keys, put is idempotent (create-then-version), list returns names
 * only, getName returns the instance name.
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { vault } from "./mod.ts";

const CONFIG = {
  secretKey: "scw-secret-test",
  projectId: "11111111-1111-1111-1111-111111111111",
  region: "fr-par",
};

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
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

Deno.test("getName returns the configured instance name", () => {
  const p = vault.createProvider("scw-secrets", CONFIG);
  assertEquals(p.getName(), "scw-secrets");
});

Deno.test("get resolves the secret id by name then accesses the value", async () => {
  const p = vault.createProvider("scw-secrets", CONFIG);
  const calls: string[] = [];
  const value = await withMockedFetch(
    (url) => {
      calls.push(url);
      if (url.includes("/versions/latest/access")) {
        return new Response(JSON.stringify({ data: b64("hunter2") }), { status: 200 });
      }
      // list-by-name resolution
      return new Response(
        JSON.stringify({ secrets: [{ id: "sec-1", name: "DB_PASSWORD" }], total_count: 1 }),
        { status: 200 },
      );
    },
    () => p.get("DB_PASSWORD"),
  );
  assertEquals(value, "hunter2");
  assert(calls.some((u) => u.includes("name=DB_PASSWORD")));
  assert(calls.some((u) => u.includes("/sec-1/versions/latest/access")));
});

Deno.test("get throws when the secret does not exist (never returns empty)", async () => {
  const p = vault.createProvider("scw-secrets", CONFIG);
  let threw = false;
  await withMockedFetch(
    () => new Response(JSON.stringify({ secrets: [], total_count: 0 }), { status: 200 }),
    async () => {
      try {
        await p.get("MISSING");
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "not found");
      }
    },
  );
  assert(threw, "get must throw on a missing key, not return an empty string");
});

Deno.test("put creates the secret when absent, then adds a version (idempotent overwrite)", async () => {
  const p = vault.createProvider("scw-secrets", CONFIG);
  const posts: Array<{ url: string; body: unknown }> = [];
  await withMockedFetch(
    (url, init) => {
      if (init.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/secrets")) {
          return new Response(JSON.stringify({ id: "sec-new" }), { status: 200 });
        }
        return new Response(JSON.stringify({ revision: 1 }), { status: 200 });
      }
      // resolveSecretId: not found first time
      return new Response(JSON.stringify({ secrets: [], total_count: 0 }), { status: 200 });
    },
    () => p.put("API_TOKEN", "s3cr3t"),
  );
  assertEquals(posts.length, 2);
  assert(posts[0].url.endsWith("/secrets"));
  assertEquals((posts[0].body as { name: string }).name, "API_TOKEN");
  assertStringIncludes(posts[1].url, "/sec-new/versions");
  assertEquals((posts[1].body as { data: string }).data, b64("s3cr3t"));
});

Deno.test("put on an existing secret skips create and only adds a version", async () => {
  const p = vault.createProvider("scw-secrets", CONFIG);
  const posts: string[] = [];
  await withMockedFetch(
    (url, init) => {
      if (init.method === "POST") {
        posts.push(url);
        return new Response(JSON.stringify({ revision: 2 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ secrets: [{ id: "sec-exists", name: "API_TOKEN" }], total_count: 1 }),
        { status: 200 },
      );
    },
    () => p.put("API_TOKEN", "rotated"),
  );
  assertEquals(posts.length, 1);
  assertStringIncludes(posts[0], "/sec-exists/versions");
});

Deno.test("list returns secret names only, never values, and paginates", async () => {
  const p = vault.createProvider("scw-secrets", CONFIG);
  const names = await withMockedFetch(
    (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = page === "1"
        ? { secrets: Array.from({ length: 100 }, (_, i) => ({ name: `S${i}` })), total_count: 101 }
        : { secrets: [{ name: "S100" }], total_count: 101 };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    () => p.list(),
  );
  assertEquals(names.length, 101);
  assertEquals(names[100], "S100");
  // names only — no object leaked
  assert(names.every((n) => typeof n === "string"));
});
