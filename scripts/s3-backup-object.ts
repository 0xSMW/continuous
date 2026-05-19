import { createHash, createHmac } from "node:crypto";
import { basename } from "node:path";
import { readFileSync, statSync } from "node:fs";

type HeaderMap = Record<string, string>;

const emptyPayloadHash = hash(Buffer.alloc(0));

function argValue(name: string) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg?.slice(prefix.length).trim();
}

function hasArg(name: string) {
  return process.argv.includes(`--${name}`);
}

function envValue(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function requiredEnv(...names: string[]) {
  const value = envValue(...names);

  if (!value) {
    throw new Error(`Set one of ${names.join(", ")}.`);
  }

  return value;
}

function hash(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer | string, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function amzDates(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");

  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function encodeSegment(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function objectPath(bucket: string, key: string) {
  const parts = [bucket, ...key.split("/").filter(Boolean)].map(encodeSegment);
  return `/${parts.join("/")}`;
}

function normalizePrefix(value: string | undefined) {
  return (value ?? "postgres")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function backupKey(prefix: string, filePath: string) {
  return [prefix, basename(filePath)].filter(Boolean).join("/");
}

function latestKey(prefix: string) {
  return [prefix, "latest.json"].filter(Boolean).join("/");
}

function canonicalizeHeaders(headers: HeaderMap) {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name].trim().replace(/\s+/g, " ")}`)
    .join("\n");

  return {
    canonicalHeaders: `${canonicalHeaders}\n`,
    signedHeaders: names.join(";"),
  };
}

function signingKey(secretKey: string, dateStamp: string, region: string) {
  const dateKey = hmac(`AWS4${secretKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function signedRequest(input: {
  method: string;
  endpoint: URL;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  body?: Buffer | string;
  contentType?: string;
}) {
  const body = input.body ?? "";
  const payloadHash = input.method === "HEAD" ? emptyPayloadHash : hash(body);
  const { amzDate, dateStamp } = amzDates();
  const path = objectPath(input.bucket, input.key);
  const url = new URL(`${input.endpoint.origin}${path}`);
  const headers: HeaderMap = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  if (input.contentType) {
    headers["content-type"] = input.contentType;
  }

  const { canonicalHeaders, signedHeaders } = canonicalizeHeaders(headers);
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const canonicalRequest = [
    input.method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hash(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(
    signingKey(input.secretAccessKey, dateStamp, input.region),
    stringToSign,
  );
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
  const requestHeaders: HeaderMap = {};

  for (const [name, value] of Object.entries(headers)) {
    if (name !== "host") {
      requestHeaders[name] = value;
    }
  }

  requestHeaders.authorization = authorization;
  const requestBody = Buffer.isBuffer(body) ? new ArrayBuffer(body.byteLength) : body;

  if (Buffer.isBuffer(body)) {
    new Uint8Array(requestBody as ArrayBuffer).set(body);
  }

  return {
    url,
    headers: requestHeaders,
    body: requestBody,
  };
}

async function s3Request(input: {
  method: string;
  endpoint: URL;
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  body?: Buffer | string;
  contentType?: string;
}) {
  const request = signedRequest(input);
  const response = await fetch(request.url, {
    method: input.method,
    headers: request.headers,
    body: input.method === "HEAD" ? undefined : request.body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `S3 ${input.method} ${input.key} failed with ${response.status}: ${detail.slice(0, 500)}`,
    );
  }

  return response;
}

function settings() {
  const endpoint = new URL(requiredEnv("BACKUP_S3_ENDPOINT", "AWS_ENDPOINT_URL_S3"));
  const bucket = requiredEnv("BACKUP_S3_BUCKET");
  const region = envValue("BACKUP_S3_REGION", "AWS_REGION") ?? endpoint.hostname.split(".")[0];
  const accessKeyId = requiredEnv("BACKUP_S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("BACKUP_S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY");
  const prefix = normalizePrefix(envValue("BACKUP_S3_PREFIX"));
  const dryRun = envValue("BACKUP_S3_DRY_RUN") === "true";

  return {
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix,
    dryRun,
  };
}

async function uploadBackup(filePath: string) {
  const config = settings();
  const body = readFileSync(filePath);
  const digest = hash(body);
  const sidecar = `${digest}  ${basename(filePath)}\n`;
  const key = backupKey(config.prefix, filePath);
  const sidecarKey = `${key}.sha256`;
  const manifestKey = latestKey(config.prefix);
  const stat = statSync(filePath);
  const uploadedAt = new Date().toISOString();
  const manifest = JSON.stringify(
    {
      bucket: config.bucket,
      endpoint: config.endpoint.origin,
      key,
      sidecarKey,
      sha256: digest,
      sizeBytes: stat.size,
      uploadedAt,
    },
    null,
    2,
  );

  if (!config.dryRun) {
    await s3Request({
      ...config,
      method: "PUT",
      key,
      body,
      contentType: "application/octet-stream",
    });
    await s3Request({
      ...config,
      method: "PUT",
      key: sidecarKey,
      body: sidecar,
      contentType: "text/plain; charset=utf-8",
    });
    await s3Request({
      ...config,
      method: "PUT",
      key: manifestKey,
      body: manifest,
      contentType: "application/json; charset=utf-8",
    });
  }

  return {
    dryRun: config.dryRun,
    bucket: config.bucket,
    endpoint: config.endpoint.origin,
    key,
    sidecarKey,
    manifestKey,
    sha256: digest,
    sizeBytes: stat.size,
    uploadedAt,
  };
}

async function checkLatest() {
  const config = settings();
  const maxAgeHours = Number(envValue("BACKUP_S3_MAX_AGE_HOURS") ?? "26");

  if (!Number.isInteger(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error("BACKUP_S3_MAX_AGE_HOURS must be a positive integer.");
  }

  const manifestObject = latestKey(config.prefix);

  if (config.dryRun) {
    return {
      dryRun: true,
      bucket: config.bucket,
      endpoint: config.endpoint.origin,
      manifestKey: manifestObject,
      maxAgeHours,
    };
  }

  const response = await s3Request({
    ...config,
    method: "GET",
    key: manifestObject,
    contentType: "application/json; charset=utf-8",
  });
  const manifest = (await response.json()) as {
    key?: string;
    sidecarKey?: string;
    sha256?: string;
    sizeBytes?: number;
    uploadedAt?: string;
  };
  const uploadedAt = manifest.uploadedAt ? Date.parse(manifest.uploadedAt) : Number.NaN;

  if (!Number.isFinite(uploadedAt)) {
    throw new Error(`Latest backup manifest has invalid uploadedAt: ${manifest.uploadedAt}`);
  }

  const ageHours = (Date.now() - uploadedAt) / 3_600_000;

  if (ageHours > maxAgeHours) {
    throw new Error(
      `Latest object backup is too old: ${ageHours.toFixed(2)}h; max ${maxAgeHours}h.`,
    );
  }

  if (!manifest.key || !manifest.sidecarKey) {
    throw new Error("Latest backup manifest is missing key or sidecarKey.");
  }

  await s3Request({
    ...config,
    method: "HEAD",
    key: manifest.key,
  });
  await s3Request({
    ...config,
    method: "HEAD",
    key: manifest.sidecarKey,
  });

  return {
    dryRun: false,
    bucket: config.bucket,
    endpoint: config.endpoint.origin,
    manifestKey: manifestObject,
    key: manifest.key,
    sidecarKey: manifest.sidecarKey,
    sha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
    uploadedAt: manifest.uploadedAt,
    ageHours: Number(ageHours.toFixed(4)),
  };
}

async function main() {
  if (hasArg("check-latest")) {
    console.log(JSON.stringify(await checkLatest(), null, 2));
    return;
  }

  const filePath = argValue("file") ?? envValue("BACKUP_FILE");

  if (!filePath) {
    throw new Error("Set --file=<path> or BACKUP_FILE.");
  }

  console.log(JSON.stringify(await uploadBackup(filePath), null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
