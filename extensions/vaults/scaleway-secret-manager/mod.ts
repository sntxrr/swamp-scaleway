/**
 * Scaleway Secret Manager vault backend for swamp.
 *
 * Registers a swamp vault provider (`@sntxrr/scaleway-secret-manager-vault`)
 * backed by the Scaleway Secret Manager API (`/secret-manager/v1beta1`,
 * regional). Once configured, other models can source secrets from Scaleway
 * Secret Manager with `${{ vault.get(<vault>, <SECRET_NAME>) }}` expressions.
 *
 * Secret values are looked up by name: `get` resolves the secret id from its
 * name, then accesses the latest version; `put` creates the secret on first use
 * and appends a new version thereafter (idempotent overwrite); `list` returns
 * secret names only. Authenticated with the `X-Auth-Token` header using only
 * Deno's built-in `fetch` — no SDK.
 *
 * API reference: https://www.scaleway.com/en/developers/api/secret-manager/
 * @module
 */
// extensions/vaults/scaleway-secret-manager/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway API secret key. Wire with ${{ vault.get(...) }} is NOT possible here (this IS the vault); pass via --config or an env-substituted value.",
  ),
  projectId: z.string().describe(
    "Scaleway Project ID that owns the secrets.",
  ),
  region: z.string().default("fr-par").describe(
    "Region, e.g. fr-par, nl-ams, pl-waw.",
  ),
  endpoint: z.string().optional().describe(
    "Override the API host. Defaults to https://api.scaleway.com.",
  ),
});

type Config = z.infer<typeof ConfigSchema>;

/** Minimal X-Auth-Token authenticated Scaleway call returning parsed JSON. */
async function scwFetch<T>(
  cfg: Config,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const base = (cfg.endpoint ?? "https://api.scaleway.com").replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Auth-Token": cfg.secretKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: T | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}

const secretsPath = (cfg: Config): string =>
  `/secret-manager/v1beta1/regions/${cfg.region}/secrets`;

/** Resolve a secret's id from its name (null when it does not exist). */
async function resolveSecretId(
  cfg: Config,
  name: string,
): Promise<string | null> {
  const { status, json } = await scwFetch<
    { secrets?: Array<{ id: string; name: string }> }
  >(
    cfg,
    "GET",
    `${secretsPath(cfg)}?project_id=${encodeURIComponent(cfg.projectId)}&name=${
      encodeURIComponent(name)
    }&page_size=100`,
  );
  if (status < 200 || status >= 300) {
    throw new Error(
      `Scaleway Secret Manager list failed (${status}) while resolving "${name}".`,
    );
  }
  const match = (json?.secrets ?? []).find((s) => s.name === name);
  return match?.id ?? null;
}

/** VaultProvider methods backed by Scaleway Secret Manager. */
interface VaultProvider {
  get(secretKey: string): Promise<string>;
  put(secretKey: string, secretValue: string): Promise<void>;
  list(): Promise<string[]>;
  getName(): string;
}

/** Vault provider definition for Scaleway Secret Manager. */
export const vault = {
  type: "@sntxrr/scaleway-secret-manager-vault",
  name: "Scaleway Secret Manager",
  description:
    "Source secrets from Scaleway Secret Manager (regional /secret-manager/v1beta1) via X-Auth-Token.",
  configSchema: ConfigSchema,
  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ): VaultProvider => {
    const cfg = ConfigSchema.parse(config);
    return {
      get: async (secretKey: string): Promise<string> => {
        const id = await resolveSecretId(cfg, secretKey);
        if (id === null) {
          throw new Error(
            `Secret "${secretKey}" not found in Scaleway Secret Manager (project ${cfg.projectId}, region ${cfg.region}).`,
          );
        }
        const { status, json } = await scwFetch<{ data: string }>(
          cfg,
          "GET",
          `${secretsPath(cfg)}/${
            encodeURIComponent(id)
          }/versions/latest/access`,
        );
        if (status < 200 || status >= 300 || !json?.data) {
          throw new Error(
            `Failed to access secret "${secretKey}" version latest (${status}).`,
          );
        }
        // Scaleway returns the value base64-encoded in `data`.
        return new TextDecoder().decode(
          Uint8Array.from(atob(json.data), (c) => c.charCodeAt(0)),
        );
      },

      put: async (secretKey: string, secretValue: string): Promise<void> => {
        let id = await resolveSecretId(cfg, secretKey);
        if (id === null) {
          const created = await scwFetch<{ id: string }>(
            cfg,
            "POST",
            secretsPath(cfg),
            { project_id: cfg.projectId, name: secretKey },
          );
          if (
            created.status < 200 || created.status >= 300 || !created.json?.id
          ) {
            throw new Error(
              `Failed to create secret "${secretKey}" (${created.status}).`,
            );
          }
          id = created.json.id;
        }
        const data = btoa(
          String.fromCharCode(...new TextEncoder().encode(secretValue)),
        );
        const added = await scwFetch(
          cfg,
          "POST",
          `${secretsPath(cfg)}/${encodeURIComponent(id)}/versions`,
          { data },
        );
        if (added.status < 200 || added.status >= 300) {
          throw new Error(
            `Failed to add a version to secret "${secretKey}" (${added.status}).`,
          );
        }
      },

      list: async (): Promise<string[]> => {
        const names: string[] = [];
        let page = 1;
        for (;;) {
          const { status, json } = await scwFetch<
            { secrets?: Array<{ name: string }>; total_count?: number }
          >(
            cfg,
            "GET",
            `${secretsPath(cfg)}?project_id=${
              encodeURIComponent(cfg.projectId)
            }&page=${page}&page_size=100`,
          );
          if (status < 200 || status >= 300) {
            throw new Error(`Scaleway Secret Manager list failed (${status}).`);
          }
          const batch = json?.secrets ?? [];
          for (const s of batch) names.push(s.name);
          if (batch.length === 0) break;
          const total = json?.total_count;
          if (total !== undefined && names.length >= Number(total)) break;
          if (batch.length < 100) break;
          page += 1;
        }
        return names;
      },

      getName: (): string => name,
    };
  },
};

/** Internal helpers exported only for unit testing. */
export const _internal = {
  scwFetch,
  resolveSecretId,
  secretsPath,
  ConfigSchema,
};
