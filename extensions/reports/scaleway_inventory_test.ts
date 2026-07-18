/**
 * Unit tests for scaleway_inventory.ts — cross-service discovery via
 * `findAllGlobal`, normalization of the `status`/`state` and `zone`/`region`
 * field variants, latest-version dedup, exclusion of non-Scaleway models and
 * `report-*` artifacts, and the aggregated output shape. No live calls.
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createReportTestContext } from "jsr:@swamp-club/swamp-testing";
import { report } from "./scaleway_inventory.ts";

type InventoryReportContext = Parameters<typeof report.execute>[0];

const MODEL_ID = "fleet";

/** Build a stored data artifact for a given model type / instance. */
function artifact(
  modelType: string,
  modelId: string,
  name: string,
  rec: Record<string, unknown>,
  version = 1,
): {
  modelType: string;
  modelId: string;
  data: {
    name: string;
    kind: "resource";
    dataId: string;
    version: number;
    size: number;
    contentType: string;
  };
  content: Uint8Array;
} {
  const content = new TextEncoder().encode(JSON.stringify(rec));
  return {
    modelType,
    modelId,
    data: {
      name,
      kind: "resource" as const,
      dataId: `${modelType}:${modelId}:${name}:${version}`,
      version,
      size: content.length,
      contentType: "application/json",
    },
    content,
  };
}

function ctx(
  dataArtifacts: ReturnType<typeof artifact>[],
): InventoryReportContext {
  const { context } = createReportTestContext({
    scope: "model",
    modelType: "@sntxrr/scaleway-instance",
    modelId: MODEL_ID,
    methodName: "sync",
    executionStatus: "succeeded",
    dataHandles: [],
    dataArtifacts,
  });
  return context as unknown as InventoryReportContext;
}

Deno.test("aggregates resources across multiple scaleway services", async () => {
  const result = await report.execute(ctx([
    // Instance (uses `state` + `zone`)
    artifact("@sntxrr/scaleway-instance", "web-1", "latest", {
      id: "srv-1",
      name: "web-1",
      state: "running",
      zone: "fr-par-1",
      observedAt: "2026-07-17T00:00:00Z",
    }),
    artifact("@sntxrr/scaleway-instance", "web-2", "latest", {
      id: "srv-2",
      name: "web-2",
      state: "stopped",
      zone: "nl-ams-1",
      observedAt: "2026-07-17T00:00:00Z",
    }),
    // Block storage (uses `status` + `zone`)
    artifact("@sntxrr/scaleway-block-storage", "vol-1", "latest", {
      id: "vol-1",
      name: "data",
      status: "available",
      zone: "fr-par-1",
      observedAt: "2026-07-17T00:00:00Z",
    }),
    // RDB (uses `status` + `region`)
    artifact("@sntxrr/scaleway-rdb", "db-1", "latest", {
      id: "db-1",
      name: "prod-db",
      status: "ready",
      region: "fr-par",
      observedAt: "2026-07-17T00:00:00Z",
    }),
  ]));

  assertEquals(result.json.totalResources, 4);
  assertEquals(result.json.serviceCount, 3);
  // fr-par-1, nl-ams-1, fr-par
  assertEquals(result.json.locationCount, 3);

  const byService = result.json.byService as Record<
    string,
    { count: number; locations: string[]; statuses: Record<string, number> }
  >;
  assertEquals(byService["instance"].count, 2);
  assertEquals(byService["instance"].statuses["running"], 1);
  assertEquals(byService["instance"].statuses["stopped"], 1);
  assertEquals(byService["block-storage"].count, 1);
  assertEquals(byService["rdb"].count, 1);

  const byLocation = result.json.byLocation as Record<string, number>;
  assertEquals(byLocation["fr-par-1"], 2);

  const byStatus = result.json.byStatus as Record<string, number>;
  assertEquals(byStatus["running"], 1);
  assertEquals(byStatus["available"], 1);

  assertStringIncludes(result.markdown, "Scaleway inventory");
  assertStringIncludes(result.markdown, "block-storage");
  assertStringIncludes(result.markdown, "prod-db");
});

Deno.test("ignores non-scaleway models and report artifacts", async () => {
  const result = await report.execute(ctx([
    artifact("@sntxrr/scaleway-vpc", "vpc-1", "latest", {
      id: "vpc-1",
      name: "main",
      region: "fr-par",
    }),
    // A different vendor's model must be excluded.
    artifact("@acme/aws-ec2", "i-123", "latest", {
      id: "i-123",
      name: "ec2",
      state: "running",
    }),
    // This report's own persisted output must be excluded.
    artifact("@sntxrr/scaleway-vpc", "vpc-1", "report-scaleway-inventory", {
      totalResources: 99,
    }),
  ]));

  assertEquals(result.json.totalResources, 1);
  assertEquals(result.json.serviceCount, 1);
  const byService = result.json.byService as Record<string, { count: number }>;
  assertEquals(byService["vpc"].count, 1);
  assertEquals(byService["aws-ec2"], undefined);
});

Deno.test("keeps only the latest version of each resource", async () => {
  const result = await report.execute(ctx([
    artifact("@sntxrr/scaleway-instance", "web-1", "latest", {
      id: "srv-1",
      name: "web-1",
      state: "starting",
      zone: "fr-par-1",
    }, 1),
    artifact("@sntxrr/scaleway-instance", "web-1", "latest", {
      id: "srv-1",
      name: "web-1",
      state: "running",
      zone: "fr-par-1",
    }, 2),
  ]));

  assertEquals(result.json.totalResources, 1);
  const byStatus = result.json.byStatus as Record<string, number>;
  assertEquals(byStatus["running"], 1);
  assertEquals(byStatus["starting"], undefined);
});

Deno.test("normalizes object-storage buckets with no id or status", async () => {
  const result = await report.execute(ctx([
    artifact("@sntxrr/scaleway-object-storage", "assets", "latest", {
      name: "assets",
      region: "fr-par",
      observedAt: "2026-07-17T00:00:00Z",
    }),
  ]));

  assertEquals(result.json.totalResources, 1);
  const resources = result.json.resources as Array<{
    service: string;
    id: string | null;
    status: string;
    location: string;
  }>;
  assertEquals(resources[0].service, "object-storage");
  assertEquals(resources[0].id, null);
  assertEquals(resources[0].status, "unknown");
  assertEquals(resources[0].location, "fr-par");
  assertStringIncludes(result.markdown, "| object-storage | — | assets |");
});

Deno.test("handles an empty repository", async () => {
  const result = await report.execute(ctx([]));

  assertEquals(result.json.totalResources, 0);
  assertEquals(result.json.serviceCount, 0);
  assertStringIncludes(result.markdown, "No Scaleway resource data found");
});
