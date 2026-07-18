/**
 * Scaleway Object Storage (S3-compatible) integration.
 *
 * Wraps the Scaleway Object Storage S3 API (`https://s3.<region>.scw.cloud`) so a
 * swamp model manages an S3 bucket, keyed by its bucket name. Exposes
 * `list-buckets` (factory), `create`, `delete`, `sync`
 * (confirm existence/region), and `list-objects` (factory, paginated via
 * ListObjectsV2 continuation tokens).
 *
 * Unlike the other Scaleway extensions, Object Storage does **NOT** use the
 * `X-Auth-Token` header. It speaks the S3 API and every request is signed with
 * **AWS Signature Version 4** (service name `s3`) using an access key + secret
 * key. The SigV4 signer is implemented inline with Web Crypto HMAC-SHA256 and
 * SHA-256 digests — no SDK, no npm dependencies — mirroring the way
 * `oci_instance.ts` implements RSA-SHA256 request signing inline.
 *
 * S3 responses are XML; they are parsed dependency-free with small, documented
 * string/regex extraction helpers (see `parseListAllMyBuckets` /
 * `parseListBucket`).
 *
 * API reference: https://www.scaleway.com/en/developers/api/object-storage/
 * AWS SigV4 reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 *
 * @module
 */
// extensions/models/scaleway-object-storage/scaleway_object_storage.ts
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  accessKey: z.string().describe(
    "Scaleway Object Storage access key (the public half of an API key). Wire with ${{ vault.get(scaleway, SCW_ACCESS_KEY) }}.",
  ),
  secretKey: z.string().meta({ sensitive: true }).describe(
    "Scaleway Object Storage secret key (the secret half of an API key). Used only to derive the AWS SigV4 signing key; never logged or stored. Wire with ${{ vault.get(scaleway, SCW_SECRET_KEY) }}.",
  ),
  region: z.string().default("fr-par").describe(
    "Object Storage region: fr-par, nl-ams, or pl-waw. Selects the s3.<region>.scw.cloud endpoint and is part of the SigV4 credential scope.",
  ),
  bucket: z.string().describe(
    "Name of the bucket this model manages. Used by create, delete, sync, and list-objects; ignored by the list-buckets factory.",
  ),
  endpoint: z.string().optional().describe(
    "Override the S3 endpoint base URL. Defaults to https://s3.<region>.scw.cloud.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ListObjectsArgsSchema = z.object({
  prefix: z.string().optional().describe(
    "Only list objects whose key begins with this prefix.",
  ),
});

/** Stored snapshot of a bucket's observed state. */
const BucketSchema = z.object({
  name: z.string().describe("Bucket name."),
  region: z.string().describe("Region the bucket lives in."),
  endpoint: z.string().describe("S3 endpoint base URL used to reach it."),
  creationDate: z.string().nullable().optional().describe(
    "ISO-8601 creation timestamp, when reported by ListBuckets.",
  ),
  exists: z.boolean().describe(
    "Whether the bucket exists as of observedAt (false after delete).",
  ),
  observedAt: z.string().describe("ISO-8601 time this snapshot was taken."),
});

/** Stored snapshot of a single object listed in a bucket. */
const ObjectSchema = z.object({
  bucket: z.string().describe("Name of the containing bucket."),
  key: z.string().describe("Object key (path within the bucket)."),
  size: z.number().nullable().optional().describe("Object size in bytes."),
  lastModified: z.string().nullable().optional().describe(
    "ISO-8601 last-modified timestamp.",
  ),
  etag: z.string().nullable().optional().describe(
    "Entity tag (quoted MD5 or multipart hash).",
  ),
  storageClass: z.string().nullable().optional().describe(
    "Storage class, e.g. STANDARD or GLACIER.",
  ),
  observedAt: z.string().describe("ISO-8601 time this snapshot was taken."),
});

// ---------------------------------------------------------------------------
// AWS Signature Version 4 signer (HMAC-SHA256), implemented inline with Web
// Crypto. See https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// ---------------------------------------------------------------------------

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Lowercase hex-encode raw bytes. */
function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Lowercase hex SHA-256 digest of a string or bytes (the S3 payload hash). */
async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** HMAC-SHA256(key, message) → raw bytes. */
async function hmacSha256(
  key: Uint8Array,
  message: string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return new Uint8Array(sig);
}

/**
 * Derive the SigV4 signing key:
 * `HMAC(HMAC(HMAC(HMAC("AWS4"+secretKey, yyyymmdd), region), service), "aws4_request")`.
 */
async function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(
    new TextEncoder().encode("AWS4" + secretKey),
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, "aws4_request");
}

/** RFC 3986 URI-encode a query-string component (encodes everything but unreserved). */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Build a canonical (sorted, RFC-3986-encoded) query string from params. */
function canonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join("&");
}

/**
 * Produce a SigV4 `Authorization` header (and the intermediate canonical
 * request / string-to-sign) for a request whose headers to sign are given
 * fully in `headers` (which MUST include `host` and `x-amz-date`). The
 * `dateStamp` is derived from `x-amz-date`.
 */
async function signRequestV4(input: {
  method: string;
  canonicalUri: string;
  canonicalQuery: string;
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
}): Promise<{
  authorization: string;
  signature: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
}> {
  const amzDate = input.headers["x-amz-date"];
  const dateStamp = amzDate.slice(0, 8);

  const lowerNames = Object.keys(input.headers)
    .map((n) => n.toLowerCase())
    .sort();
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) {
    lowerHeaders[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  }
  const canonicalHeaders = lowerNames
    .map((n) => `${n}:${lowerHeaders[n]}\n`)
    .join("");
  const signedHeaders = lowerNames.join(";");

  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(
    input.secretKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    signature,
    signedHeaders,
    canonicalRequest,
    stringToSign,
  };
}

// ---------------------------------------------------------------------------
// S3 HTTP client (SigV4-signed, path-style)
// ---------------------------------------------------------------------------

/** Format a Date as an AWS `x-amz-date` basic-ISO string, e.g. 20130524T000000Z. */
function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
}

/** Resolve the S3 endpoint base URL (`https://s3.<region>.scw.cloud` or override). */
function s3BaseUrl(g: GlobalArgs): string {
  return (g.endpoint ?? `https://s3.${g.region}.scw.cloud`).replace(/\/+$/, "");
}

/**
 * Perform a SigV4-signed S3 request (path-style, empty body) and return the raw
 * status/text/headers. On a non-2xx response it throws an
 * `Error & { status: number }` (with the HTTP status attached as `err.status`)
 * so callers can branch on it (e.g. 409/404 idempotency) and otherwise write
 * nothing. Mirrors the canonical `scalewayFetch` error contract.
 */
async function s3Request(
  g: GlobalArgs,
  method: "GET" | "PUT" | "DELETE" | "HEAD",
  path: string,
  query: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const base = s3BaseUrl(g);
  const host = new URL(base).host;
  const canonicalQuery = canonicalQueryString(query);
  const url = canonicalQuery
    ? `${base}${path}?${canonicalQuery}`
    : `${base}${path}`;

  const amzDate = toAmzDate(new Date());
  const payloadHash = EMPTY_SHA256;
  const headers: Record<string, string> = {
    "host": host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  const { authorization } = await signRequestV4({
    method,
    canonicalUri: path,
    canonicalQuery,
    headers,
    payloadHash,
    accessKey: g.accessKey,
    secretKey: g.secretKey,
    region: g.region,
    service: "s3",
  });

  const res = await fetch(url, {
    method,
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "Authorization": authorization,
    },
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(
      `Scaleway S3 ${method} ${path} failed (${res.status}): ${text}`,
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return { status: res.status, text, headers: res.headers };
}

// ---------------------------------------------------------------------------
// XML parsing (dependency-free)
// ---------------------------------------------------------------------------

/** Decode the five predefined XML entities in a text node. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Return the inner text of the first `<tag>...</tag>` in `xml`, or null. */
function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXmlEntities(m[1]) : null;
}

/** Return the inner content of every `<tag>...</tag>` block in `xml`. */
function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Parsed bucket entry from a `ListAllMyBucketsResult` document. */
type ParsedBucket = { name: string; creationDate: string | null };

/** Parse a `ListAllMyBucketsResult` XML document into bucket entries. */
function parseListAllMyBuckets(xml: string): ParsedBucket[] {
  return extractBlocks(xml, "Bucket").map((b) => ({
    name: extractTag(b, "Name") ?? "",
    creationDate: extractTag(b, "CreationDate"),
  }));
}

/** Parsed object entry from a `ListBucketResult` (ListObjectsV2) document. */
type ParsedObject = {
  key: string;
  size: number | null;
  lastModified: string | null;
  etag: string | null;
  storageClass: string | null;
};

/** Parsed page of a `ListBucketResult` (ListObjectsV2) document. */
type ParsedObjectPage = {
  objects: ParsedObject[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
};

/** Parse one page of a `ListBucketResult` (ListObjectsV2) XML document. */
function parseListBucket(xml: string): ParsedObjectPage {
  const objects = extractBlocks(xml, "Contents").map((c) => {
    const size = extractTag(c, "Size");
    return {
      key: extractTag(c, "Key") ?? "",
      size: size === null ? null : Number(size),
      lastModified: extractTag(c, "LastModified"),
      etag: extractTag(c, "ETag"),
      storageClass: extractTag(c, "StorageClass"),
    };
  });
  return {
    objects,
    isTruncated: (extractTag(xml, "IsTruncated") ?? "false").trim() === "true",
    nextContinuationToken: extractTag(xml, "NextContinuationToken"),
  };
}

// ---------------------------------------------------------------------------
// Context types (canonical — see CONVENTIONS.md §6)
// ---------------------------------------------------------------------------

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type ExecuteContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Build a `bucket` resource snapshot. */
function toBucketResource(
  g: GlobalArgs,
  name: string,
  exists: boolean,
  creationDate: string | null,
  observedAt: string,
): Record<string, unknown> {
  return {
    name,
    region: g.region,
    endpoint: s3BaseUrl(g),
    creationDate,
    exists,
    observedAt,
  };
}

/** Build an `object` resource snapshot. */
function toObjectResource(
  bucket: string,
  o: ParsedObject,
  observedAt: string,
): Record<string, unknown> {
  return {
    bucket,
    key: o.key,
    size: o.size,
    lastModified: o.lastModified,
    etag: o.etag,
    storageClass: o.storageClass,
    observedAt,
  };
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

/** The three Scaleway Object Storage regions valid for the `region` global arg. */
const SCALEWAY_REGIONS: readonly string[] = ["fr-par", "nl-ams", "pl-waw"];

/**
 * Scaleway Object Storage model — manages one S3 bucket (keyed by `bucket`) and
 * can discover all buckets / all objects. Authenticated with AWS SigV4.
 */
export const model = {
  type: "@sntxrr/scaleway-object-storage",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "bucket": {
      description: "Snapshot of an Object Storage bucket's state",
      schema: BucketSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "object": {
      description: "Snapshot of an object listed within a bucket",
      schema: ObjectSchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
  },
  methods: {
    "list-buckets": {
      description:
        "Discover every bucket owned by the credentials (GET / → ListAllMyBucketsResult). Factory: writes one bucket snapshot per bucket.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const { text } = await s3Request(g, "GET", "/");
        const buckets = parseListAllMyBuckets(text);
        logger.info("Discovered {n} buckets in {region}", {
          n: buckets.length,
          region: g.region,
        });
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        for (const b of buckets) {
          handles.push(
            await context.writeResource(
              "bucket",
              b.name,
              toBucketResource(g, b.name, true, b.creationDate, now),
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    "create": {
      description:
        "Create the managed bucket (PUT /{bucket}). Idempotent: a 409 (BucketAlreadyOwnedByYou / BucketAlreadyExists) is treated as success.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Creating bucket {bucket} in {region}", {
          bucket: g.bucket,
          region: g.region,
        });
        try {
          await s3Request(g, "PUT", `/${g.bucket}`);
        } catch (e) {
          // A 409 means the bucket already exists and is owned by these
          // credentials (BucketAlreadyOwnedByYou / BucketAlreadyExists) — the
          // desired end state, so treat it as an idempotent success.
          if ((e as { status?: number }).status !== 409) throw e;
          logger.info(
            "Bucket {bucket} already exists (409); treating as created",
            {
              bucket: g.bucket,
            },
          );
        }
        const handle = await context.writeResource(
          "bucket",
          g.bucket,
          toBucketResource(g, g.bucket, true, null, new Date().toISOString()),
        );
        logger.info("Created bucket {bucket} in {region}", {
          bucket: g.bucket,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    "delete": {
      description:
        "Delete the managed bucket (DELETE /{bucket}). The bucket must be empty. Idempotent: a 404 (NoSuchBucket) is treated as success.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Deleting bucket {bucket} in {region}", {
          bucket: g.bucket,
          region: g.region,
        });
        try {
          await s3Request(g, "DELETE", `/${g.bucket}`);
        } catch (e) {
          // A 404 (NoSuchBucket) means the bucket is already gone — the desired
          // end state, so treat it as an idempotent success.
          if ((e as { status?: number }).status !== 404) throw e;
          logger.info(
            "Bucket {bucket} already absent (404); treating as deleted",
            {
              bucket: g.bucket,
            },
          );
        }
        const handle = await context.writeResource(
          "bucket",
          g.bucket,
          toBucketResource(g, g.bucket, false, null, new Date().toISOString()),
        );
        logger.info("Deleted bucket {bucket} in {region}", {
          bucket: g.bucket,
          region: g.region,
        });
        return { dataHandles: [handle] };
      },
    },
    "sync": {
      description:
        "Confirm the managed bucket exists and record its region (HEAD /{bucket}).",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        logger.info("Syncing bucket {bucket}", { bucket: g.bucket });
        const { headers } = await s3Request(g, "HEAD", `/${g.bucket}`);
        const region = headers.get("x-amz-bucket-region") ?? g.region;
        const handle = await context.writeResource(
          "bucket",
          g.bucket,
          {
            ...toBucketResource(
              g,
              g.bucket,
              true,
              null,
              new Date().toISOString(),
            ),
            region,
          },
        );
        logger.info("Synced bucket {bucket} in {region}", {
          bucket: g.bucket,
          region,
        });
        return { dataHandles: [handle] };
      },
    },
    "list-objects": {
      description:
        "List objects in the managed bucket (GET /{bucket}?list-type=2, paginated via continuation tokens). Factory: writes one object snapshot per key.",
      arguments: ListObjectsArgsSchema,
      execute: async (
        args: z.infer<typeof ListObjectsArgsSchema>,
        context: ExecuteContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const { globalArgs: g, logger } = context;
        const now = new Date().toISOString();
        const handles: Array<{ name: string }> = [];
        let continuationToken: string | null = null;
        for (;;) {
          const query: Record<string, string> = { "list-type": "2" };
          if (args.prefix) query["prefix"] = args.prefix;
          if (continuationToken) {
            query["continuation-token"] = continuationToken;
          }
          const { text } = await s3Request(g, "GET", `/${g.bucket}`, query);
          const page = parseListBucket(text);
          for (const o of page.objects) {
            handles.push(
              await context.writeResource(
                "object",
                `${g.bucket}/${o.key}`,
                toObjectResource(g.bucket, o, now),
              ),
            );
          }
          if (!page.isTruncated || !page.nextContinuationToken) break;
          continuationToken = page.nextContinuationToken;
        }
        logger.info("Listed {n} objects in {bucket}", {
          n: handles.length,
          bucket: g.bucket,
        });
        return { dataHandles: handles };
      },
    },
  },
  checks: {
    "valid-region": {
      description:
        "Ensure globalArgs.region is one of the three Scaleway Object Storage regions (fr-par, nl-ams, pl-waw). Runs before create/delete.",
      labels: ["policy"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): { pass: boolean; errors?: string[] } => {
        const region = context.globalArgs.region;
        if (!SCALEWAY_REGIONS.includes(region)) {
          return {
            pass: false,
            errors: [
              `Region "${region}" is not a valid Scaleway Object Storage region. Allowed: ${
                SCALEWAY_REGIONS.join(", ")
              }.`,
            ],
          };
        }
        return { pass: true };
      },
    },
  },
};

/**
 * Internal SigV4 primitives and XML parsers, exported only for unit testing.
 */
export const _internal = {
  toHex,
  sha256Hex,
  hmacSha256,
  deriveSigningKey,
  rfc3986,
  canonicalQueryString,
  signRequestV4,
  toAmzDate,
  s3BaseUrl,
  s3Request,
  decodeXmlEntities,
  extractTag,
  extractBlocks,
  parseListAllMyBuckets,
  parseListBucket,
  toBucketResource,
  toObjectResource,
  EMPTY_SHA256,
  SCALEWAY_REGIONS,
};
