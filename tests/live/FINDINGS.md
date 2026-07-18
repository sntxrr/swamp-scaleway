# Live-test findings

Issues surfaced by running the live lifecycle harness (`tests/live/run.sh`)
against real Scaleway infrastructure. These are things the mocked unit tests
could not catch.

## Tier A (2026-07-18) — 9 services

7 of 9 services pass a full clean lifecycle: **vpc, registry, messaging, iam,
cockpit, account, object-storage**.

### F1 — idempotent `delete` misses Scaleway's 412 "already deleted" signal (REAL BUG)

**Services:** `secret-manager`, `key-manager` (both regional). Likely a
Scaleway API-family behavior — other regional services should be checked.

**Symptom:** a second `delete` of an already-deleted resource errors instead of
being a no-op.

**Root cause:** the `delete` methods treat only **HTTP 404** as
"already gone" (CONVENTIONS §3.2). But Secret Manager / Key Manager return
**HTTP 412** with body:

```json
{"help_message":"cannot act on deleted ...","precondition":"resource_not_usable","type":"precondition_failed"}
```

**Proposed fix (localized to each `delete` catch):** also treat
`status === 412 && /resource_not_usable/.test(err.message)` as absent — record
the absent snapshot instead of throwing. (The shared `scalewayFetch` error
carries `status` and the raw body in its `.message`.) Consider folding this into
the §3 idempotent-delete convention so future extensions inherit it.

### N1 — Key Manager keys are protected by default → not deletable (BEHAVIOR, not a bug)

Creating a KMS key without `unprotected: true` yields a **protected** key, and
`delete` on it fails (Scaleway refuses to delete protected keys — correct
behavior). The harness now creates keys with `unprotected=true`. Worth a
one-line note in the key-manager README so users aren't surprised.

## Apple Silicon (Tier F) — 2026-07-18

Investigated for a colleague who wants to spin up an Apple Silicon Mac. **No Mac
was provisioned** (user chose to hold off on the 24h-minimum charge). All work
below is free / read-only or unit-tested.

### F2 — extension had no catalog discovery (FIXED, additive)

Original apple-silicon extension exposed no way to see valid server `type`s,
stock, or OS images — a user had to guess `M1-M`. Added two read-only methods
(verified **live**): `list-server-types` and `list-os`. New `server-type` / `os`
resource specs preserve the full API object under `raw`.

Live catalog (fr-par-1, 2026-07-18) — `minimum_lease_duration` = **86400s (24h)**
on every type:

| Type | Hardware | Stock | ~First-24h (min) |
| ---- | -------- | ----- | ---------------- |
| M4-M | Apple M4, 10c, 16GB | low_stock | ~€6.96 (€0.29/h) — cheapest **macOS** in stock |
| M2-L-ASAHI | M2 Pro, Fedora Asahi (Linux) | low_stock | ~€5.04 (€0.21/h) |
| M4-SP | M4 Pro | low_stock | ~€12 (est.) |
| M1-M, M2-M, M2-L, M4-S, M4-XL | — | no_stock | — |

fr-par-3 offered only M1-M (no_stock). OS images incl. macOS Ventura/Sonoma/
Sequoia/Tahoe and `fedora-asahi-remix 42` (`decafedd-…`, M2-L-ASAHI only).

### F3 — no way to retrieve login creds via the model (FIXED, additive)

`sync`/`create` strip `ssh_username`/`sudo_password`/`vnc_url`, so the model
alone couldn't give a user SSH/VNC access. Added `connection-info` (mirrors
secret-manager `access`): writes creds to a `connection` resource marked
`sensitiveOutput: true` (swamp vaults sensitive fields before persistence; never
logged). Unit-tested (creds captured, never logged, `sensitiveOutput` asserted);
**not exercised live** (needs a running server). Caveat documented: the API may
only return `sudo_password` at create time, so run it right after `create`.
