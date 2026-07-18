/**
 * Unit tests for scaleway_object_storage.ts.
 *
 * The centerpiece is a SigV4 KNOWN-ANSWER TEST: it signs the exact request from
 * AWS's documented S3 "GET Object" SigV4 example and asserts the derived
 * signature and Authorization header match AWS's published expected values. This
 * proves the inline HMAC-SHA256 signer is correct. The remaining tests exercise
 * the S3 methods with a mocked `fetch`: XML parsing, the SigV4 Authorization
 * header on writes, ListObjectsV2 continuation-token pagination, and the
 * non-2xx-throws-and-writes-nothing contract.
 *
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _internal, model } from "./scaleway_object_storage.ts";

// ---------------------------------------------------------------------------
// 1. SigV4 known-answer test — AWS S3 "GET Object" example
//    https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
//    AccessKey AKIAIOSFODNN7EXAMPLE / Secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
//    Region us-east-1, service s3, x-amz-date 20130524T000000Z.
// ---------------------------------------------------------------------------

const AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AWS_EXPECTED_SIGNATURE =
  "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41";
const AWS_EXPECTED_CANONICAL_HASH =
  "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972";

Deno.test("SigV4 known-answer: AWS S3 GET Object example reproduces the documented signature", async () => {
  const result = await _internal.signRequestV4({
    method: "GET",
    canonicalUri: "/test.txt",
    canonicalQuery: "",
    headers: {
      "host": "examplebucket.s3.amazonaws.com",
      "range": "bytes=0-9",
      "x-amz-content-sha256": _internal.EMPTY_SHA256,
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: _internal.EMPTY_SHA256,
    accessKey: AWS_ACCESS_KEY,
    secretKey: AWS_SECRET_KEY,
    region: "us-east-1",
    service: "s3",
  });

  // Canonical request must hash to AWS's documented value.
  assertEquals(
    await _internal.sha256Hex(result.canonicalRequest),
    AWS_EXPECTED_CANONICAL_HASH,
    "canonical request hash must match AWS's documented example",
  );

  // The signing/string-to-sign path must yield AWS's documented signature.
  assertEquals(result.signature, AWS_EXPECTED_SIGNATURE);
  assertEquals(
    result.signedHeaders,
    "host;range;x-amz-content-sha256;x-amz-date",
  );
  assertStringIncludes(
    result.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
  );
  assertStringIncludes(
    result.authorization,
    `Signature=${AWS_EXPECTED_SIGNATURE}`,
  );
});

Deno.test("deriveSigningKey independently reproduces the documented S3 signature", async () => {
  // Independently exercise the signing-key derivation
  // (HMAC(HMAC(HMAC(HMAC('AWS4'+secret, date), region), 's3'), 'aws4_request'))
  // against AWS's documented string-to-sign and expected signature for the S3
  // GET Object example — proving the key-derivation chain, not just the
  // end-to-end signRequestV4 path.
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    "20130524T000000Z",
    "20130524/us-east-1/s3/aws4_request",
    AWS_EXPECTED_CANONICAL_HASH,
  ].join("\n");
  const signingKey = await _internal.deriveSigningKey(
    AWS_SECRET_KEY,
    "20130524",
    "us-east-1",
    "s3",
  );
  const signature = _internal.toHex(
    await _internal.hmacSha256(signingKey, stringToSign),
  );
  assertEquals(signature, AWS_EXPECTED_SIGNATURE);
});

Deno.test("sha256Hex of the empty payload matches the S3 UNSIGNED-PAYLOAD-free constant", async () => {
  assertEquals(await _internal.sha256Hex(""), _internal.EMPTY_SHA256);
});

// ---------------------------------------------------------------------------
// 2. XML parsers
// ---------------------------------------------------------------------------

Deno.test("parseListAllMyBuckets extracts name + creation date from each Bucket", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Owner><ID>abc</ID><DisplayName>me</DisplayName></Owner>
  <Buckets>
    <Bucket><Name>photos</Name><CreationDate>2019-12-11T23:32:47.000Z</CreationDate></Bucket>
    <Bucket><Name>logs-&amp;-more</Name><CreationDate>2020-01-01T00:00:00.000Z</CreationDate></Bucket>
  </Buckets>
</ListAllMyBucketsResult>`;
  const buckets = _internal.parseListAllMyBuckets(xml);
  assertEquals(buckets.length, 2);
  assertEquals(buckets[0].name, "photos");
  assertEquals(buckets[0].creationDate, "2019-12-11T23:32:47.000Z");
  assertEquals(buckets[1].name, "logs-&-more"); // entity decoded
});

Deno.test("parseListBucket extracts objects and pagination fields", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>photos</Name>
  <KeyCount>2</KeyCount>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>TOKEN-XYZ</NextContinuationToken>
  <Contents>
    <Key>a/one.jpg</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified>
    <ETag>"abc123"</ETag><Size>1024</Size><StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>a/two.jpg</Key><Size>2048</Size><StorageClass>GLACIER</StorageClass>
  </Contents>
</ListBucketResult>`;
  const page = _internal.parseListBucket(xml);
  assertEquals(page.objects.length, 2);
  assertEquals(page.objects[0].key, "a/one.jpg");
  assertEquals(page.objects[0].size, 1024);
  assertEquals(page.objects[0].etag, '"abc123"');
  assertEquals(page.objects[1].storageClass, "GLACIER");
  assertEquals(page.isTruncated, true);
  assertEquals(page.nextContinuationToken, "TOKEN-XYZ");
});

Deno.test("canonicalQueryString sorts and RFC-3986-encodes params", () => {
  assertEquals(
    _internal.canonicalQueryString({
      "list-type": "2",
      "continuation-token": "a/b+c",
    }),
    "continuation-token=a%2Fb%2Bc&list-type=2",
  );
});

// ---------------------------------------------------------------------------
// 3. Method tests with a mocked fetch
// ---------------------------------------------------------------------------

const G = {
  accessKey: AWS_ACCESS_KEY,
  secretKey: AWS_SECRET_KEY,
  region: "fr-par",
  bucket: "my-bucket",
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

Deno.test("list-buckets GETs the service root and parses the bucket XML", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(
        `<ListAllMyBucketsResult><Buckets>
          <Bucket><Name>photos</Name><CreationDate>2020-01-01T00:00:00.000Z</CreationDate></Bucket>
          <Bucket><Name>logs</Name><CreationDate>2020-02-01T00:00:00.000Z</CreationDate></Bucket>
        </Buckets></ListAllMyBucketsResult>`,
        { status: 200 },
      );
    },
    () => model.methods["list-buckets"].execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "GET");
  assertEquals(call.url, "https://s3.fr-par.scw.cloud/");
  const headers = call.init.headers as Record<string, string>;
  assertStringIncludes(headers["Authorization"], "AWS4-HMAC-SHA256");
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "bucket");
  assertEquals(writes[0].name, "photos");
  assertEquals(writes[0].data.exists, true);
  assertEquals(writes[0].data.region, "fr-par");
});

Deno.test("create PUTs to /{bucket} with a SigV4 Authorization header", async () => {
  const { ctx, writes } = makeContext();
  let captured: { url: string; init: RequestInit } | null = null;
  await withMockedFetch(
    (url, init) => {
      captured = { url, init };
      return new Response("", { status: 200 });
    },
    () => model.methods["create"].execute({}, ctx),
  );
  const call = captured as unknown as { url: string; init: RequestInit };
  assertEquals(call.init.method, "PUT");
  assertEquals(call.url, "https://s3.fr-par.scw.cloud/my-bucket");
  const headers = call.init.headers as Record<string, string>;
  assertStringIncludes(
    headers["Authorization"],
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/",
  );
  assertStringIncludes(headers["Authorization"], "/fr-par/s3/aws4_request");
  assert(headers["x-amz-date"], "x-amz-date must be sent");
  assertEquals(headers["x-amz-content-sha256"], _internal.EMPTY_SHA256);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].data.name, "my-bucket");
  assertEquals(writes[0].data.exists, true);
});

Deno.test("delete DELETEs /{bucket} and records exists=false", async () => {
  const { ctx, writes } = makeContext();
  let method = "";
  await withMockedFetch(
    (_u, init) => {
      method = String(init.method ?? "");
      return new Response(null, { status: 204 });
    },
    () => model.methods["delete"].execute({}, ctx),
  );
  assertEquals(method, "DELETE");
  assertEquals(writes[0].data.exists, false);
});

Deno.test("create treats a 409 (BucketAlreadyOwnedByYou) as success and writes exists=true", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        "<Error><Code>BucketAlreadyOwnedByYou</Code></Error>",
        { status: 409 },
      ),
    () => model.methods["create"].execute({}, ctx),
  );
  assertEquals(writes.length, 1, "must still write a snapshot on 409");
  assertEquals(writes[0].spec, "bucket");
  assertEquals(writes[0].name, "my-bucket");
  assertEquals(writes[0].data.exists, true);
});

Deno.test("delete treats a 404 (NoSuchBucket) as success and writes exists=false", async () => {
  const { ctx, writes } = makeContext();
  await withMockedFetch(
    () =>
      new Response(
        "<Error><Code>NoSuchBucket</Code></Error>",
        { status: 404 },
      ),
    () => model.methods["delete"].execute({}, ctx),
  );
  assertEquals(writes.length, 1, "must still write a snapshot on 404");
  assertEquals(writes[0].spec, "bucket");
  assertEquals(writes[0].name, "my-bucket");
  assertEquals(writes[0].data.exists, false);
});

Deno.test("list-objects follows continuation tokens across pages", async () => {
  const { ctx, writes } = makeContext();
  const urls: string[] = [];
  await withMockedFetch(
    (url) => {
      urls.push(url);
      const token = new URL(url).searchParams.get("continuation-token");
      const body = token === null
        ? `<ListBucketResult><IsTruncated>true</IsTruncated>
             <NextContinuationToken>PAGE2</NextContinuationToken>
             <Contents><Key>a.txt</Key><Size>1</Size></Contents></ListBucketResult>`
        : `<ListBucketResult><IsTruncated>false</IsTruncated>
             <Contents><Key>b.txt</Key><Size>2</Size></Contents></ListBucketResult>`;
      return new Response(body, { status: 200 });
    },
    () => model.methods["list-objects"].execute({}, ctx),
  );
  assertEquals(writes.length, 2);
  assertEquals(writes[0].spec, "object");
  assertEquals(writes[0].name, "my-bucket/a.txt");
  assertEquals(writes[1].name, "my-bucket/b.txt");
  // First page has no continuation-token; second page carries PAGE2.
  assertStringIncludes(urls[0], "list-type=2");
  assertStringIncludes(urls[1], "continuation-token=PAGE2");
});

Deno.test("a non-2xx S3 response throws and writes nothing", async () => {
  const { ctx, writes } = makeContext();
  let threw = false;
  await withMockedFetch(
    () =>
      new Response(
        "<Error><Code>NoSuchBucket</Code></Error>",
        { status: 404 },
      ),
    async () => {
      try {
        await model.methods["sync"].execute({}, ctx);
      } catch (e) {
        threw = true;
        assertStringIncludes((e as Error).message, "404");
      }
    },
  );
  assert(threw, "expected a 404 to throw");
  assertEquals(writes.length, 0, "must not write a resource on failure");
});
