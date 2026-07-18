# PRD — Scaleway Extension Suite for Swamp

**Status:** Draft v1 · **Owner:** @sntxrr · **Date:** 2026-07-17
**Repo:** `swamp-extensions/scaleway` · **Registry namespace:** `@sntxrr/scaleway-*`
**GitHub:** `https://github.com/sntxrr/swamp-scaleway` — **already public, with a root `README.md` committed.**
**Execution model:** A team of Claude agents (one lead + N builders + reviewers) working in parallel.

> **Prerequisite (satisfied):** The public GitHub repo is already published and
> carries a root `README.md` **before** any extension is pushed. This matters
> because the quality scorecard requires each manifest's `repository:` URL to
> resolve to a real, allowlisted, public repo — so the `repository` field is a
> known-good constant from the first push, not an open item. Builders reference
> `https://github.com/sntxrr/swamp-scaleway` verbatim; the lead maintains the
> root `README.md` index (adding a row per shipped extension), never recreates
> the repo or its initial README.
>
> **Monorepo, by design:** all ~30 `@sntxrr/scaleway-*` packages are published
> from this single repo and therefore share one `repository:` URL. Distinct
> published package names from a common repository is expected and passes the
> quality gate — there is no requirement for one repo per package.

---

## 1. Summary

Build a **comprehensive, published set of swamp extensions** that let swamp
operators manage Scaleway cloud resources through swamp's model/method/data
primitives — the same way `@sntxrr/oci-instance` wraps an Oracle Cloud VM, but
spanning the whole Scaleway product surface (~30 services, delivered in three
prioritized waves).

Each service becomes one published extension package
(`@sntxrr/scaleway-<service>`) containing one or more model types that wrap the
service's REST API using **only Deno's built-in `fetch` and Web Crypto — no
vendor SDK**. Work is parallelized across a team of agents, one service per
agent, all conforming to a single shared technical contract (Section 5) and a
golden reference template (Appendix A).

This document is the **agent-executable spec**: a builder agent should be able
to pick a row from the catalog (Section 6), read the contract (Section 5) and
the template (Appendix A), and ship a quality-gated extension without further
clarification.

---

## 2. Background — the swamp extensions model

Swamp is an infrastructure-automation tool built around a few primitives
(see the `swamp` skill for authoritative detail):

- **Model** — a typed definition of a resource (a VM, a bucket, a DNS record)
  exposing **methods** (`create`, `start`, `stop`, `sync`, `delete`, `list`)
  that call the real API. Authored in TypeScript, `export const model`.
- **Data** — versioned state snapshots produced by method runs; other models
  reference them via CEL expressions
  (`data.latest("<name>", "<spec>").attributes.<field>`).
- **Vault** — secret storage; models read secrets at runtime via
  `${{ vault.get(<vault>, <KEY>) }}` expressions. Can also be *provided* by an
  extension (`export const vault`).
- **Extension** — a TypeScript package adding model types, vault backends,
  datastores, drivers, or report generators; published to a registry via
  `swamp extension push`.
- **Report** — a repeatable analysis over model/workflow output.

**Extension mechanics that constrain this project:**

- Source files must import zod as `import { z } from "npm:zod@4";` — never bare
  `"zod"`. The scorer runs in a hermetic sandbox with no imports map.
- **Static imports only.** Dynamic `import()` is rejected at push.
- **npm deps are bundled inline** (except zod). Pin every `npm:` specifier.
  `deno.lock`/`package.json` do **not** cover extension deps.
- Bundled Deno lives at `~/.swamp/deno/deno` (not on `PATH`).
- Reserved collectives: cannot use `swamp` or `si`. We use `@sntxrr`.
- Type pattern: `@collective/name` (lowercase, alphanumeric, hyphens,
  underscores).
- **Adversarial Review Gate:** `swamp extension push` requires a complete,
  content-hash-bound review report for the exact code being pushed. Editing
  source or bumping the version invalidates the report.
- **Quality scorecard:** max third-party score **14/15 (93%, Grade A)** — needs
  README in `additionalFiles`, LICENSE, JSDoc ≥80%, explicit return types,
  manifest `description`, `repository` URL, and trusted pinned deps.

---

## 3. Goals & Non-goals

### Goals

1. Cover the Scaleway product surface with idiomatic swamp model extensions,
   phased over three waves (Section 6).
2. Every extension ships **published, Grade-A (≥14/15), tested, reviewed**.
3. A **single consistent contract** across all extensions: identical auth
   wiring, URL-pattern handling, error mapping, data shapes, and method naming —
   so an operator who learns one Scaleway extension knows them all.
4. **No SDK dependency** — Deno `fetch` + Web Crypto only, matching the
   `oci_instance` precedent. Keeps bundles small and dependency-trust clean.
5. Parallelizable execution: a team of agents delivering independent packages
   with minimal merge contention.
6. Deliver a small number of **cross-service value-adds**: Secret Manager as a
   swamp *vault backend*, and a Scaleway *inventory/cost report*.

### Non-goals

- Not a Terraform/Pulumi replacement — swamp models are imperative
  method-runners, not a full declarative reconciler. Full desired-state drift
  reconciliation is out of scope beyond `sync`.
- No Scaleway SDK wrapping, no code generation from OpenAPI in v1 (may be a
  future optimization; see Section 11).
- No UI. No hosting/serving of the extensions beyond registry publish.
- Not covering deprecated/legacy products (e.g. Dedibox classic) unless a wave
  explicitly lists them.

---

## 4. Success metrics

| Metric | Target |
| --- | --- |
| Services covered (all waves) | ≥ 28 of the catalog in Section 6 |
| Wave 1 shipped | 7/7 core services published |
| Quality score per extension | ≥ 14/15 (Grade A) |
| JSDoc coverage per model | ≥ 80% |
| Unit tests | Every model has a colocated `*_test.ts`; `deno test` green |
| Smoke test | Every model smoke-tested against a real Scaleway account (or documented dry-run) before publish |
| Adversarial review | Complete content-hash-bound report per pushed extension |
| Auth consistency | 100% of token-auth services wire the key via `vault.get(...)`; zero hardcoded secrets |
| Merge conflicts | Near-zero (file-ownership partitioning, Section 7) |

---

## 5. Technical contract (every extension MUST follow)

This is the normative section. Deviations require lead-agent sign-off recorded
in `CONVENTIONS.md`.

### 5.1 Authentication

- **Token-auth services (default):** All Scaleway REST APIs authenticate with
  the header `X-Auth-Token: <secret-key>`. The secret key is **always** wired
  from a vault, never hardcoded:

  ```
  --global-arg 'secretKey=${{ vault.get(scaleway, SCW_SECRET_KEY) }}'
  ```

  Model `globalArguments` must declare `secretKey` with
  `.meta({ sensitive: true })`.

- **S3-compatible services (Object Storage, File Storage):** These use the
  **S3 API with AWS SigV4 signing** (access key + secret key), endpoint
  `https://s3.<region>.scw.cloud`, **not** `X-Auth-Token`. These rows are marked
  **[S3/SigV4]** in the catalog and are higher-complexity; the SigV4 signer is
  implemented with Web Crypto (HMAC-SHA256), mirroring how `oci_instance`
  implements RSA-SHA256 signing inline.

- Common global args across all token-auth models: `secretKey` (sensitive),
  `projectId` (or `organizationId` where the API is org-scoped), plus the
  region/zone the resource lives in (see 5.2).

### 5.2 URL patterns

Scaleway endpoints follow three shapes off base `https://api.scaleway.com`:

| Shape | Template | Example service |
| --- | --- | --- |
| **Zoned** | `/{product}/{version}/zones/{zone}/{object}` | Instances, Block Storage, LB, Elastic Metal |
| **Regional** | `/{product}/{version}/regions/{region}/{object}` | VPC, RDB, Kapsule, Registry, Secret Manager |
| **Global** | `/{product}/{version}/{object}` | IAM, Account/Project |

- Zones: `fr-par-1..3`, `nl-ams-1..3`, `pl-waw-1..3`.
- Regions: `fr-par`, `nl-ams`, `pl-waw`.
- Model declares the correct `zone` or `region` global arg with a sensible
  default (`fr-par-1` / `fr-par`) and an `endpoint` override arg (as
  `oci_instance` does) for sovereign/private realms.

### 5.3 Model shape & method taxonomy

Each resource-managing model exposes a **consistent method vocabulary** (include
only those the API supports):

| Method | Semantics | Notes |
| --- | --- | --- |
| `create` | Provision the resource | Writes a resource data snapshot with the new ID |
| `sync` | Fetch current state (GET) | Idempotent; the read path — always implement |
| `update` | Mutate mutable fields (PATCH) | Where the API allows |
| `delete` | Deprovision | Verify ID first (CLAUDE.md rule 5) |
| Power/lifecycle | `start` / `stop` / `reboot` | Compute-like services (mirror `oci_instance`) |
| `list` | **Factory** discovery of existing resources | One method that fans out and writes multiple data snapshots — never loop `run` N times (CLAUDE.md rule 6) |

- **One model instance per real resource**, keyed by the Scaleway resource ID
  (as `oci_instance` is keyed by instance OCID), plus a **factory `list` model**
  per service for discovery. Prefer fan-out methods over per-target loops.
- `globalArguments`, method `arguments`, and every resource `schema` are zod
  schemas with `.describe(...)` on each field (drives JSDoc/quality score).
- Resource specs use `lifetime` + `garbageCollection` sensibly (see template).
- **Explicit return types** on `execute` and all exported functions (quality
  requirement).

### 5.4 HTTP client & errors

- A small inline `scalewayFetch` helper (in the golden template, Appendix A)
  centralizes: base URL + region/zone path building, `X-Auth-Token` header,
  JSON encode/decode, non-2xx → typed error with Scaleway's
  `{ message, type, ... }` body surfaced, and **pagination** (`page` /
  `page_size`, aggregate until `total_count` reached) for `list`.
- Because deps can't be shared across published packages, this helper is
  **copied into each extension** from the template (single source of truth in
  `CONVENTIONS.md`). Keep it byte-identical across services to ease review.
- Handle Scaleway async transitions: creates often return a resource in a
  transient state (`creating`, `starting`). `sync` reports `status`; document
  that callers poll `sync` rather than the model blocking indefinitely.

### 5.5 Testing

- **Unit tests** (`*_test.ts`, colocated): schema validation, URL construction,
  error mapping, pagination aggregation, signing (for S3 rows). Mock `fetch`;
  no live calls. `~/.swamp/deno/deno test` must pass.
- **Smoke test** (models): exercise against a real Scaleway project per
  `references/model/smoke_testing.md` before publish, or document why a safe
  dry-run substitutes (e.g. read-only `sync`/`list` only).

### 5.6 Quality, manifest & versioning

- Per-extension `manifest.yaml`: `name: "@sntxrr/scaleway-<service>"`,
  CalVer `version` (`swamp extension version --manifest ... --json`),
  `description`, `repository: https://github.com/sntxrr/swamp-scaleway`,
  `models:` list, `additionalFiles: [README.md, LICENSE.md]`, `labels:`
  (`scaleway`, product family, `compute`/`storage`/etc.).
- Run `swamp extension fmt --check`, then
  `swamp extension quality manifest.yaml --json` → must be ≥14/15.
- **Adversarial Review Gate** before every push: run mechanical verification +
  dimensional review, write the content-hash-bound report, present findings,
  then push. Never `--yes` past the gate.
- Publish via the `swamp-extension-publish` skill. Confirm the collective with
  `swamp auth whoami --json` at kickoff (expected: `@sntxrr`).

### 5.7 Repo layout (multi-extension, one repo)

```
swamp-extensions/scaleway/
  CONVENTIONS.md            # golden template + client helper + method taxonomy (lead-owned)
  PRD.md                    # this file
  README.md                 # ALREADY PRESENT in the public repo before any push;
                            #   lead maintains it as the index of published extensions
  extensions/
    models/
      scaleway_instance.ts
      scaleway_instance_test.ts
      scaleway_vpc.ts
      scaleway_vpc_test.ts
      ...                    # one pair per service; distinct filenames => no merge contention
    reports/
      scaleway_inventory.ts  # cross-service report (Wave 3)
    vaults/
      scaleway_secret_manager/mod.ts   # Secret Manager as a vault backend (Wave 2)
  manifests/
    scaleway-instance.yaml   # per-extension manifest (uses paths.base as needed)
    scaleway-vpc.yaml
    ...
```

Use the manifest `paths.base` field where a per-extension-subdir layout is
cleaner. Each service = distinct model file(s) + distinct manifest → agents
rarely touch the same file. `CONVENTIONS.md` is the only shared hot file and is
lead-owned (Section 7).

---

## 6. Service catalog

Package = `@sntxrr/scaleway-<service>`. "Auth": **T** = `X-Auth-Token`,
**S3** = S3/SigV4. "Scope": Z=zoned, R=regional, G=global. Complexity: S/M/L.

### Wave 1 — Core (7) — ship first, unblock everything else

| Service pkg | Product / API base | Auth | Scope | Key methods | Cx |
| --- | --- | --- | --- | --- | --- |
| `scaleway-instance` | Instances `/instance/v1` | T | Z | create, start, stop, reboot, delete, sync, list | M |
| `scaleway-block-storage` | Block Storage `/block/v1` | T | Z | create, sync, resize, delete, list | M |
| `scaleway-object-storage` | Object Storage (S3) `s3.<region>.scw.cloud` | **S3** | R | create-bucket, list-buckets, delete-bucket, put/get/delete-object, sync | L |
| `scaleway-vpc` | VPC + Private Networks `/vpc/v2` | T | R | create-vpc, create-private-network, attach, delete, sync, list | M |
| `scaleway-load-balancer` | Load Balancer `/lb/v1` | T | Z | create, add-backend, add-frontend, delete, sync, list | L |
| `scaleway-rdb` | Managed DB (PG/MySQL) `/rdb/v1` | T | R | create, sync, add-user, apply-acl, delete, list | L |
| `scaleway-dns` | Domains & DNS `/domain/v2beta1` | T | G | list-zones, set-records, add-record, delete-record, sync | M |

### Wave 2 — Platform (7) — build on Wave 1 primitives

| Service pkg | Product / API base | Auth | Scope | Key methods | Cx |
| --- | --- | --- | --- | --- | --- |
| `scaleway-kapsule` | Kubernetes Kapsule `/k8s/v1` | T | R | create-cluster, create-pool, get-kubeconfig, upgrade, delete, sync, list | L |
| `scaleway-registry` | Container Registry `/registry/v1` | T | R | create-namespace, sync, delete, list | S |
| `scaleway-serverless-functions` | Functions `/functions/v1beta1` | T | R | create-namespace, deploy, sync, delete, list | M |
| `scaleway-serverless-containers` | Containers `/containers/v1beta1` | T | R | create-namespace, deploy, sync, delete, list | M |
| `scaleway-secret-manager` | Secret Manager `/secret-manager/v1beta1` | T | R | create, add-version, access, delete, sync + **vault backend** | M |
| `scaleway-iam` | IAM `/iam/v1alpha1` | T | G | create-application, create-api-key, attach-policy, sync, list | M |
| `scaleway-key-manager` | Key Manager (KMS) `/key-manager/v1alpha1` | T | R | create-key, encrypt, decrypt, rotate, delete, sync | M |

> **Value-add:** `scaleway-secret-manager` ships *both* a model **and** a swamp
> `export const vault` backend (`extensions/vaults/scaleway_secret_manager/mod.ts`),
> so operators can source other models' secrets directly from Scaleway Secret
> Manager. Assign to a senior builder.

### Wave 3 — Advanced & long tail (~14) — parallel once contract is proven

| Service pkg | Product / API base | Auth | Scope | Cx |
| --- | --- | --- | --- | --- |
| `scaleway-elastic-metal` | Bare metal `/baremetal/v1` | T | Z | M |
| `scaleway-apple-silicon` | Apple silicon `/apple-silicon/v1alpha1` | T | Z | S |
| `scaleway-redis` | Managed Redis `/redis/v1` | T | Z | M |
| `scaleway-mongodb` | Managed MongoDB `/mongodb/v1alpha1` | T | R | M |
| `scaleway-serverless-jobs` | Serverless Jobs `/serverless-jobs/v1alpha1` | T | R | M |
| `scaleway-public-gateway` | Public Gateway `/vpc-gw/v2` | T | Z | M |
| `scaleway-ipam` | IPAM `/ipam/v1` | T | R | S |
| `scaleway-inference` | Managed Inference `/inference/v1` | T | R | M |
| `scaleway-cockpit` | Observability / Cockpit `/cockpit/v1` | T | R | M |
| `scaleway-messaging` | Messaging & Queuing (NATS/SQS/SNS) `/mnq/v1beta1` | T | R | M |
| `scaleway-tem` | Transactional Email `/transactional-email/v1alpha1` | T | R | M |
| `scaleway-file-storage` | File Storage (S3/NFS) | **S3** | R | L |
| `scaleway-webhosting` | Web Hosting `/webhosting/v1` | T | R | S |
| `scaleway-account` | Account / Project / Billing `/account/v3`, `/billing/v2beta1` | T | G | M |

**Cross-service extras (Wave 3):**

- `scaleway-inventory` **report** — reads `list`/`sync` data across installed
  Scaleway models and emits a consolidated inventory + estimated cost summary
  (pattern: `cloudflare-x402`'s `x402_spend` report).

> Catalog is a starting partition, not a contract with Scaleway; the lead agent
> reconciles exact API versions/paths against
> https://www.scaleway.com/en/developers/api/ at kickoff and records any
> corrections in `CONVENTIONS.md`. Log any service intentionally dropped (no
> silent truncation).

---

## 7. Agent team model

### Roles

| Role | Count | Responsibility |
| --- | --- | --- |
| **Lead / Orchestrator** | 1 | Owns `CONVENTIONS.md` + golden template + client helper; reconciles the catalog against live Scaleway docs; assigns services; runs `swamp auth whoami`; integrates; enforces DoD; owns the root `README.md` index. The **only** agent that edits shared/hot files. |
| **Builder** | N (1 per service, batched by wave) | Implements one `scaleway-<service>` extension end-to-end: model(s), tests, manifest, README, LICENSE, quality pass, review report, publish. Touches only its own distinct files. |
| **Reviewer** | 1–2 (rotating) | Runs the Adversarial Review Gate per extension: mechanical verification + dimensional review, writes the content-hash-bound report, refutes correctness/security/auth claims before publish. |

### Orchestration

1. **Kickoff (Lead, serial):** run `swamp auth whoami --json` (confirm
   `@sntxrr`); confirm the public GitHub repo
   `https://github.com/sntxrr/swamp-scaleway` is live with its root `README.md`
   committed (prerequisite — see top of doc; do **not** recreate it); init/verify
   the swamp repo (`swamp` managed `CLAUDE.md`, `.swamp.yaml`);
   reconcile catalog vs. live docs; author `CONVENTIONS.md` with the finalized
   golden template + `scalewayFetch` helper + method taxonomy + auth wiring;
   create the `scaleway` vault and store `SCW_SECRET_KEY` (and S3 keys) for smoke
   tests.
2. **Wave 1 (parallel builders):** fan out 7 builders, each owning one core
   service. **Gate:** all of Wave 1 must publish + green before Wave 2, because
   Wave 1 proves the contract and surfaces template bugs cheaply.
3. **Waves 2 & 3 (parallel builders):** fan out per service. Wave 3 can begin
   as soon as Wave 2's platform primitives (IAM, VPC deps) are stable.
4. **Review interleaved:** each builder hands finished code to a reviewer;
   reviewer's report unblocks that extension's push. Builds and reviews
   pipeline — a Wave 1 review runs while other Wave 1 services still build.
5. **Isolation:** because each service = distinct files, plain parallel work is
   safe. Use **git worktrees only** if builders will run `swamp extension push`
   concurrently against shared repo state or otherwise mutate shared files;
   otherwise the file-ownership partition is sufficient.

### Coordination rules

- `CONVENTIONS.md` is **append-mostly and lead-owned**. Builders propose changes
  via the lead, never edit it directly — it's the one hot file.
- The `scalewayFetch` helper is **byte-identical** across extensions; a change
  to it is a lead-driven sweep, not a per-builder edit.
- No builder edits another builder's files. Root `README.md` index is
  lead-owned; builders write only their extension's `extensions/models/README.md`.
- Every builder follows the same **Definition of Done** (Section 8).

### Suggested Workflow orchestration (optional)

If run as a swamp/agent workflow rather than ad-hoc: a `pipeline` over the
catalog where stage 1 = build (per service), stage 2 = adversarial review,
stage 3 = quality-gate + publish. Barrier only at the **Wave 1 → Wave 2**
boundary (the contract-proving gate). See the Workflow patterns in the harness
for fan-out/verify shapes.

---

## 8. Definition of Done (per extension)

A builder's extension is done only when **all** of these pass:

- [ ] `swamp auth whoami` collective confirmed as `@sntxrr`.
- [ ] Model(s) authored per the golden template; `X-Auth-Token` (or S3/SigV4)
      auth wired via `vault.get(...)`; **no hardcoded secrets**.
- [ ] Method vocabulary matches Section 5.3 (incl. factory `list`, `sync`).
- [ ] zod schemas on global args, method args, and every resource; `.describe()`
      on each field; **explicit return types** everywhere.
- [ ] `import { z } from "npm:zod@4";`; all npm deps pinned; static imports only.
- [ ] `~/.swamp/deno/deno check` clean.
- [ ] Colocated `*_test.ts`; `~/.swamp/deno/deno test` green (schemas, URL
      building, error mapping, pagination, signing).
- [ ] Smoke-tested against a real Scaleway project (or documented read-only
      dry-run) per `references/model/smoke_testing.md`.
- [ ] `manifest.yaml`: name, CalVer version, description,
      `repository: https://github.com/sntxrr/swamp-scaleway` (the already-public
      repo — verbatim), `additionalFiles: [README.md, LICENSE.md]`, labels.
- [ ] `swamp extension fmt --check` clean; `swamp extension quality` ≥ 14/15.
- [ ] JSDoc coverage ≥ 80%.
- [ ] Adversarial Review Gate: content-hash-bound report complete, all
      dimensions `pass`/`na`, findings presented.
- [ ] `swamp extension push` succeeds; extension appears in registry.
- [ ] Row added to root `README.md` index (via lead).

---

## 9. Phasing & dependencies

```
Kickoff (Lead) ──► CONVENTIONS.md + template + vault ──► [GATE]
        │
        ▼
Wave 1: instance, block-storage, object-storage[S3], vpc,
        load-balancer, rdb, dns            (7 builders ∥)
        │  proves contract; template bugs fixed once, cheaply
        ▼  [GATE: all Wave 1 published + green]
Wave 2: kapsule, registry, functions, containers,
        secret-manager(+vault), iam, key-manager   (7 builders ∥)
        │
        ▼
Wave 3: elastic-metal, apple-silicon, redis, mongodb, jobs,
        public-gateway, ipam, inference, cockpit, messaging,
        tem, file-storage[S3], webhosting, account,
        + scaleway-inventory report        (∥, no hard barrier)
```

Dependency notes:
- **object-storage / file-storage [S3/SigV4]** are the highest-risk Wave items
  (different auth). Assign senior builders; land the SigV4 signer early as a
  reusable snippet in `CONVENTIONS.md`.
- **secret-manager** (dual model + vault backend) is the other senior task.
- **kapsule / lb / rdb** are multi-resource (clusters+pools, lbs+backends+
  frontends, instances+users+acls) → factory/multi-method; budget more time.
- **account / iam** are org-scoped (global) and unblock policy/key wiring for
  other services' smoke tests.

---

## 10. Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Contract drift between builders | Inconsistent UX, review churn | Lead-owned `CONVENTIONS.md` + byte-identical `scalewayFetch`; Wave 1 gate proves it once |
| S3/SigV4 signing bugs (object/file storage) | Auth failures, security risk | Land a reviewed SigV4 snippet early; extra adversarial-review scrutiny on those rows |
| Scaleway API version/path inaccuracies in catalog | Wasted builder time | Lead reconciles vs. live docs at kickoff; catalog is a partition, not gospel |
| Async resource states (creating/starting) | Flaky smoke tests, blocked runs | `sync` reports `status`; callers poll — models don't block; document in README |
| Secret leakage in data snapshots/logs | Security | `.meta({ sensitive: true })`; never write secrets to resource data; review dimension checks this |
| Merge contention | Lost work | File-ownership partition; worktrees if concurrent pushes; lead owns hot files |
| Registry/quality gate surprises at push | Late rework | `quality --json` + `push --dry-run` run *before* review, not after |
| Dependency-trust failures | Push blocked | Deno-native `fetch`/Web Crypto only; avoid npm deps entirely where possible |

---

## 11. Open questions

1. ~~**Repository/GitHub remote:**~~ **Resolved** — the public repo
   `https://github.com/sntxrr/swamp-scaleway` is already published with a root
   `README.md`, and is the constant `repository:` value in every manifest. No
   action needed beyond a kickoff sanity check that it resolves and is
   allowlisted.
2. **Smoke-test account:** which Scaleway project/region hosts throwaway
   resources for smoke tests, and what's the billing guardrail? (Prefer a
   dedicated sandbox project + `fr-par-1`.)
3. **Object/File storage scope:** full object CRUD, or bucket-lifecycle
   management only in v1? (Recommend bucket + lightweight object ops v1.)
4. **Future optimization:** generate schemas from Scaleway's OpenAPI specs
   instead of hand-writing — deferred to post-v1 (Non-goal now), revisit if
   hand-authoring proves the bottleneck.
5. **Report depth:** does `scaleway-inventory` need real cost data (Billing API)
   or resource inventory only in v1?

---

## Appendix A — Golden model template

The canonical skeleton every builder starts from. Mirrors `oci_instance.ts`
structure (module JSDoc → schemas → inline signed/authed client → `export const
model`). Lead finalizes this into `CONVENTIONS.md`; keep the client helper
byte-identical across services.

```typescript
/**
 * Scaleway <Service> integration.
 *
 * Wraps the Scaleway <Product> API (<base path>) so a swamp model represents a
 * single <resource>. Exposes create / sync / ... and a factory `list`.
 * Authenticated with the X-Auth-Token header (secret key wired from a vault).
 *
 * API reference: https://www.scaleway.com/en/developers/api/<product>/
 * @module
 */
// extensions/models/scaleway_<service>.ts
import { z } from "npm:zod@4";

// --- Schemas ---------------------------------------------------------------
const GlobalArgsSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  projectId: z.string().describe("Scaleway Project ID that owns the resource."),
  region: z.string().default("fr-par").describe("Region, e.g. fr-par, nl-ams, pl-waw."),
  // zone: z.string().default("fr-par-1")  // for zoned services
  resourceId: z.string().describe("ID of the <resource> this model manages."),
  endpoint: z.string().optional().describe(
    "Override API host. Defaults to https://api.scaleway.com.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ResourceSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  status: z.string(),
  region: z.string(),
  observedAt: z.string(),
});

// --- Scaleway HTTP client (copy byte-identical from CONVENTIONS.md) ---------
async function scalewayFetch<T>(
  args: GlobalArgs,
  method: string,
  path: string,          // e.g. `/regions/${args.region}/objects`
  body?: unknown,
): Promise<T> {
  const base = (args.endpoint ?? "https://api.scaleway.com").replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Auth-Token": args.secretKey,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Scaleway ${method} ${path} failed: ${res.status} ${detail}`);
  }
  return res.status === 204 ? (undefined as T) : await res.json() as T;
}

// --- Model -----------------------------------------------------------------
/** Model definition for a single Scaleway <resource>. */
export const model = {
  type: "@sntxrr/scaleway-<service>",
  version: "2026.07.17.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "resource": {
      description: "Current <resource> state",
      schema: ResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description: "Fetch current <resource> state",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            spec: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const g = context.globalArgs;
        const r = await scalewayFetch<z.infer<typeof ResourceSchema>>(
          g, "GET", `/<product>/<version>/regions/${g.region}/<objects>/${g.resourceId}`,
        );
        const handle = await context.writeResource("resource", "main", {
          ...r,
          observedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    // create / update / delete / start / stop / reboot / list(factory) ...
  },
};
```

## Appendix B — Reference material

- **Golden precedent:** `../oracle/extensions/models/oci_instance.ts` — single
  cloud VM wrapped with inline request signing, no SDK. Study its schema layout,
  method structure, and `context.writeResource` usage.
- **Report precedent:** `../cloudflare-x402/extensions/reports/x402_spend.ts` —
  for `scaleway-inventory`.
- **Swamp skill guides:** extension (`references/extension/`), model
  (`references/model/`), vault, publishing, troubleshooting.
- **Adversarial review:**
  `references/extension/references/adversarial-review.md`.
- **Scaleway API:** https://www.scaleway.com/en/developers/api/ — base
  `api.scaleway.com`, `X-Auth-Token` auth, zoned/regional/global URL shapes.
```
