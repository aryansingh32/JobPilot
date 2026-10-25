import { createHash, createHmac } from 'crypto';
import { mkdir, readFile, unlink, writeFile, stat } from 'fs/promises';
import path from 'path';

// ============================================================
// OBJECT STORAGE — files must be reachable from every host (API in the
// cloud, workers on the Oracle VM), so they live behind this interface.
//
//   STORAGE_DRIVER=local (default) → USER_FILE_STORAGE_ROOT on disk
//   STORAGE_DRIVER=s3              → any S3-compatible store (AWS S3,
//     Cloudflare R2, MinIO) via S3_ENDPOINT / S3_BUCKET / S3_REGION /
//     S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY. Signed with SigV4 using
//     node:crypto — no SDK dependency.
//
// A stored file is referenced by an opaque string kept in
// user_files.storage_path: an absolute path (local) or "s3://bucket/key".
// ============================================================

const LOCAL_ROOT =
  process.env.USER_FILE_STORAGE_ROOT ?? path.resolve(process.cwd(), 'mnt/user-data/outputs/automation-platform/uploads');
const CACHE_ROOT = path.join(process.env.TEMP_STORAGE_ROOT ?? '/tmp/automation-platform', 'object-cache');

export function storageDriver(): 'local' | 's3' {
  return process.env.STORAGE_DRIVER === 's3' ? 's3' : 'local';
}

// ─── S3 (SigV4) ─────────────────────────────────────────────

interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function s3Config(): S3Config {
  const cfg = {
    endpoint: (process.env.S3_ENDPOINT ?? `https://s3.${process.env.S3_REGION ?? 'us-east-1'}.amazonaws.com`).replace(/\/$/, ''),
    bucket: process.env.S3_BUCKET ?? '',
    region: process.env.S3_REGION ?? 'auto',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
  };
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
  return cfg;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

/** Path-style request (works for S3, R2 and MinIO). */
async function s3Request(method: 'PUT' | 'GET' | 'DELETE', key: string, body?: Buffer, contentType?: string): Promise<Response> {
  const cfg = s3Config();
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${encodeKey(key)}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body ?? '');
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalRequest = [
    method,
    url.pathname,
    '',
    signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join(''),
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  const res = await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    throw new Error(`S3 ${method} ${key} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res;
}

function parseS3Ref(ref: string): string {
  const m = ref.match(/^s3:\/\/[^/]+\/(.+)$/);
  if (!m) throw new Error(`Not an s3 reference: ${ref}`);
  return m[1];
}

// ─── Public API ─────────────────────────────────────────────

/** Store bytes under `key` (e.g. "users/<id>/resume/<uuid>.pdf"). Returns the reference to persist. */
export async function putObject(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<string> {
  if (storageDriver() === 's3') {
    await s3Request('PUT', key, body, contentType);
    return `s3://${s3Config().bucket}/${key}`;
  }
  const full = path.join(LOCAL_ROOT, key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
  return full;
}

export async function getObject(ref: string): Promise<Buffer> {
  if (ref.startsWith('s3://')) {
    const res = await s3Request('GET', parseS3Ref(ref));
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(ref);
}

export async function deleteObject(ref: string): Promise<void> {
  if (ref.startsWith('s3://')) {
    await s3Request('DELETE', parseS3Ref(ref));
    return;
  }
  await unlink(ref).catch(() => {});
}

/**
 * A local file path for `ref` — what Playwright needs for uploads. Local refs
 * are returned as-is; remote ones are downloaded once into a temp cache.
 */
export async function materialize(ref: string): Promise<string> {
  if (!ref.startsWith('s3://')) return ref;
  const key = parseS3Ref(ref);
  const local = path.join(CACHE_ROOT, sha256(ref).slice(0, 16), path.basename(key));
  try {
    await stat(local);
    return local;
  } catch {
    /* not cached yet */
  }
  await mkdir(path.dirname(local), { recursive: true });
  await writeFile(local, await getObject(ref));
  return local;
}
