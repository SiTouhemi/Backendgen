import type { NormalizedEntity } from "@backend-compiler/compiler";
import { names } from "@backend-compiler/target-nestjs-prisma";
import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import {
  attachmentEntityName,
  DEFAULT_ALLOWED_TYPES,
  uploadsConfig,
  type UploadsConfig,
} from "./feature.js";

function file(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

const STORAGE_PROVIDER = `export interface PresignedRequest {
  url: string;
  /** Headers the client must send exactly; they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StoredObjectHead {
  sizeBytes: number;
  contentType: string;
}

/**
 * The only thing the API knows about object storage. Keys are always chosen
 * by the server; clients never influence where an object lands.
 */
export interface StorageProvider {
  readonly id: string;
  presignPut(key: string, contentType: string, sizeBytes: number): Promise<PresignedRequest>;
  presignGet(key: string): Promise<PresignedRequest>;
  /** Returns null when the object does not exist. */
  head(key: string): Promise<StoredObjectHead | null>;
  delete(key: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol.for('backendgen:StorageProvider');
export const CUSTOM_STORAGE_PROVIDER = Symbol.for('backendgen:CustomStorageProvider');
`;

const S3_PRESIGN = `import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 query presigning for S3-compatible stores, with no
 * SDK dependency. UNSIGNED-PAYLOAD is used (standard for presigned URLs);
 * extra headers passed in are signed, so the client must send them exactly —
 * that is how content-type and content-length limits are enforced by the
 * store itself rather than by trusting the client.
 */
export interface PresignInput {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  /** Lowercase header names to exact values; signed alongside host. */
  headers?: Record<string, string>;
  /** Path-style addressing (endpoint/bucket/key); required by MinIO. */
  pathStyle?: boolean;
  /** Signing time; defaults to now. Injectable for known-answer tests. */
  date?: Date;
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** RFC 3986 encoding as SigV4 requires (encode everything except unreserved). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

export function presignS3Url(input: PresignInput): string {
  const url = new URL(input.endpoint);
  const host = input.pathStyle === false ? input.bucket + '.' + url.host : url.host;
  const canonicalUri =
    input.pathStyle === false
      ? '/' + encodeKeyPath(input.key)
      : '/' + encodeRfc3986(input.bucket) + '/' + encodeKeyPath(input.key);

  const date = input.date ?? new Date();
  const amzDate =
    date.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const shortDate = amzDate.slice(0, 8);
  const scope = shortDate + '/' + input.region + '/s3/aws4_request';

  const extraHeaders = Object.entries(input.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  const signedHeaderNames = ['host', ...extraHeaders.map(([name]) => name)].sort().join(';');

  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', input.accessKeyId + '/' + scope],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaderNames],
  ];
  const canonicalQuery = query
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => name + '=' + value)
    .join('&');

  const headerLines = [['host', host] as const, ...extraHeaders]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => name + ':' + value + '\\n')
    .join('');

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    headerLines,
    signedHeaderNames,
    'UNSIGNED-PAYLOAD',
  ].join('\\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\\n');

  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + input.secretAccessKey, shortDate), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return (
    url.protocol +
    '//' +
    host +
    canonicalUri +
    '?' +
    canonicalQuery +
    '&X-Amz-Signature=' +
    signature
  );
}
`;

const S3_PRESIGN_SPEC = `import { presignS3Url } from './s3-presign';

describe('SigV4 presigner', () => {
  it('reproduces the AWS documentation known-answer vector', () => {
    // "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)"
    // — the canonical example from the S3 API reference.
    const url = presignS3Url({
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      key: 'test.txt',
      method: 'GET',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresSeconds: 86400,
      pathStyle: false,
      date: new Date('2013-05-24T00:00:00Z'),
    });

    expect(url).toContain('https://examplebucket.s3.amazonaws.com/test.txt?');
    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('signs extra headers so the client cannot vary them', () => {
    const base = {
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-east-1',
      bucket: 'uploads',
      key: 'tenant/object',
      method: 'PUT' as const,
      accessKeyId: 'minio',
      secretAccessKey: 'minio-secret',
      expiresSeconds: 900,
      date: new Date('2030-01-01T00:00:00Z'),
    };

    const small = presignS3Url({
      ...base,
      headers: { 'content-length': '10', 'content-type': 'image/png' },
    });
    const large = presignS3Url({
      ...base,
      headers: { 'content-length': '11', 'content-type': 'image/png' },
    });

    expect(small).toContain('X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost');
    expect(small).not.toBe(large);
  });
});
`;

function s3Provider(config: UploadsConfig): string {
  const ttlSeconds = config.presignTtlMinutes * 60;
  return `import { Injectable } from '@nestjs/common';
import { presignS3Url } from './s3-presign';
import {
  PresignedRequest,
  StorageProvider,
  StoredObjectHead,
} from './storage-provider';

const PRESIGN_TTL_SECONDS = ${ttlSeconds};
const STORAGE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * S3-compatible storage over presigned URLs and plain fetch — no SDK. Path
 * style is the default because MinIO requires it; set S3_FORCE_PATH_STYLE=false
 * for AWS virtual-host addressing.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  readonly id = 's3';

  private readonly endpoint: string;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly pathStyle: boolean;

  constructor() {
    const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
    const missing = required.filter((name) => {
      const value = process.env[name];
      return value === undefined || value.trim() === '';
    });
    if (missing.length > 0) {
      throw new Error('Missing storage configuration: ' + missing.join(', '));
    }

    const endpoint = new URL(process.env.S3_ENDPOINT as string);
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      throw new Error('S3_ENDPOINT must use http or https.');
    }
    if (
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.search !== '' ||
      endpoint.hash !== '' ||
      (endpoint.pathname !== '' && endpoint.pathname !== '/')
    ) {
      throw new Error('S3_ENDPOINT must be an origin URL without credentials, path, query, or fragment.');
    }
    if (
      endpoint.protocol === 'http:' &&
      process.env.NODE_ENV === 'production' &&
      process.env.S3_ALLOW_INSECURE_HTTP !== 'true'
    ) {
      throw new Error(
        'S3_ENDPOINT must use https in production unless S3_ALLOW_INSECURE_HTTP=true is explicitly set.',
      );
    }

    this.endpoint = endpoint.origin;
    this.bucket = process.env.S3_BUCKET as string;
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(this.bucket)) {
      throw new Error('S3_BUCKET must be a valid 3-63 character DNS-compatible bucket name.');
    }
    this.accessKeyId = process.env.S3_ACCESS_KEY_ID as string;
    this.secretAccessKey = process.env.S3_SECRET_ACCESS_KEY as string;
    this.region = process.env.S3_REGION ?? 'us-east-1';
    if (!/^[A-Za-z0-9-]{1,64}$/.test(this.region)) {
      throw new Error('S3_REGION contains invalid characters.');
    }
    this.pathStyle = process.env.S3_FORCE_PATH_STYLE !== 'false';
  }

  private presign(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
    headers?: Record<string, string>,
  ): PresignedRequest {
    const url = presignS3Url({
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      key,
      method,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      expiresSeconds: PRESIGN_TTL_SECONDS,
      pathStyle: this.pathStyle,
      ...(headers === undefined ? {} : { headers }),
    });

    return {
      url,
      headers: headers ?? {},
      expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async presignPut(key: string, contentType: string, sizeBytes: number): Promise<PresignedRequest> {
    return this.presign('PUT', key, {
      'content-length': String(sizeBytes),
      'content-type': contentType,
      // A completed object stays immutable even while the presigned URL is
      // still valid. S3/MinIO return 412 if this key already exists.
      'if-none-match': '*',
    });
  }

  async presignGet(key: string): Promise<PresignedRequest> {
    return this.presign('GET', key);
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const request = this.presign('HEAD', key);
    const response = await fetch(request.url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error('Storage HEAD failed with status ' + String(response.status));
    }

    return {
      sizeBytes: Number(response.headers.get('content-length') ?? '0'),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async delete(key: string): Promise<void> {
    const request = this.presign('DELETE', key);
    const response = await fetch(request.url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error('Storage DELETE failed with status ' + String(response.status));
    }
  }
}
`;
}

function mockProvider(config: UploadsConfig): string {
  const ttlMilliseconds = config.presignTtlMinutes * 60_000;
  return `import { Injectable } from '@nestjs/common';
import {
  PresignedRequest,
  StorageProvider,
  StoredObjectHead,
} from './storage-provider';

/**
 * Test provider: an in-memory object store. Tests simulate the client's PUT
 * with {@link simulateUpload}; everything else behaves like real storage.
 */
@Injectable()
export class MockStorageProvider implements StorageProvider {
  readonly id = 'mock';

  readonly objects = new Map<string, StoredObjectHead>();

  async presignPut(key: string, contentType: string, sizeBytes: number): Promise<PresignedRequest> {
    return {
      url: 'mock://put/' + key,
      headers: {
        'content-length': String(sizeBytes),
        'content-type': contentType,
        'if-none-match': '*',
      },
      expiresAt: new Date(Date.now() + ${ttlMilliseconds}).toISOString(),
    };
  }

  async presignGet(key: string): Promise<PresignedRequest> {
    return { url: 'mock://get/' + key, headers: {}, expiresAt: new Date(Date.now() + ${ttlMilliseconds}).toISOString() };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** What the real client's PUT to the presigned URL would have stored. */
  simulateUpload(key: string, sizeBytes: number, contentType: string): void {
    if (this.objects.has(key)) {
      throw new Error('Precondition failed: object already exists');
    }
    this.objects.set(key, { sizeBytes, contentType });
  }

  reset(): void {
    this.objects.clear();
  }
}
`;
}

interface ParentShape {
  entity: NormalizedEntity;
  maxSizeMb: number;
  allowedTypes: string[];
}

interface UploadPolicy {
  adminRoles: string[];
  deleteRoles: string[];
  deleteRoleKind: "account" | "organization" | null;
}

function isCallerOwned(parent: NormalizedEntity, context: TargetRenderContext): boolean {
  if (parent.ownership !== null) return true;
  const auth = context.featureConfig("auth") as { userEntity?: string } | undefined;
  return auth !== undefined && parent.name === (auth.userEntity ?? "User");
}

function uploadPolicy(parent: NormalizedEntity, context: TargetRenderContext): UploadPolicy {
  const auth = context.featureConfig("auth") as
    | { roles?: string[]; defaultRole?: string; userEntity?: string }
    | undefined;
  const crud = context.featureConfig("crud") as
    | { adminRoles?: string[]; destructiveRoles?: string[]; destructiveOrgRoles?: string[] }
    | undefined;
  const organizations = context.featureConfig("organizations") as
    | { roles?: string[] }
    | undefined;
  const accountRoles = auth?.roles ?? ["admin", "user"];
  const registrationRole = auth?.defaultRole ?? accountRoles.at(-1) ?? "user";
  const adminRoles =
    crud?.adminRoles ?? accountRoles.filter((role) => role !== registrationRole).slice(0, 1);

  if (parent.tenant !== null && organizations !== undefined) {
    const organizationRoles = organizations.roles ?? ["owner", "admin", "member"];
    return {
      adminRoles,
      deleteRoles:
        crud?.destructiveOrgRoles ??
        organizationRoles.slice(0, Math.max(1, organizationRoles.length - 1)),
      deleteRoleKind: "organization",
    };
  }

  if (auth !== undefined && !isCallerOwned(parent, context)) {
    return {
      adminRoles,
      deleteRoles: crud?.destructiveRoles ?? adminRoles,
      deleteRoleKind: "account",
    };
  }

  return { adminRoles, deleteRoles: [], deleteRoleKind: null };
}

function stringArguments(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function parentScopeFilter(
  parent: NormalizedEntity,
  context: TargetRenderContext,
  softDelete: "active" | "runtime" | "any",
): string {
  const clauses: string[] = [];
  const authenticated = context.hasFeature("auth");
  if (parent.softDelete && softDelete === "active") clauses.push("deletedAt: null,");
  if (parent.softDelete && softDelete === "runtime") {
    clauses.push("...(requireActiveParent ? { deletedAt: null } : {}),");
  }
  if (parent.tenant) clauses.push(`${parent.tenant.foreignKey}: requireOrganization(scope),`);
  if (authenticated && isCallerOwned(parent, context)) {
    const callerFilter =
      parent.ownership !== null
        ? `{ ${parent.ownership.foreignKey}: requireUser(scope) }`
        : "{ AND: [{ id: requireUser(scope) }] }";
    clauses.push(
      `...(isAdmin(scope, ADMIN_ROLES) ? {} : ${callerFilter}),`,
    );
  }
  return clauses.map((clause) => `        ${clause}`).join("\n");
}

function serviceFile(
  shape: ParentShape,
  context: TargetRenderContext,
  config: UploadsConfig,
): string {
  const parent = shape.entity;
  const attachment = attachmentEntityName(parent.name);
  const model = names.model(attachment);
  const delegate = names.delegate(attachment);
  const parentDelegate = names.delegate(parent.name);
  const parentModel = names.model(parent.name);
  const authenticated = context.hasFeature("auth");
  const maxBytes = shape.maxSizeMb * 1024 * 1024;
  const policy = uploadPolicy(parent, context);
  const callerOwned = authenticated && isCallerOwned(parent, context);
  const scopeUsed = parent.tenant !== null || callerOwned;

  const scopeImports = new Set<string>(["RequestScope"]);
  if (parent.tenant) scopeImports.add("requireOrganization");
  if (callerOwned) {
    scopeImports.add("isAdmin");
    scopeImports.add("requireUser");
  }

  return `import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ${[...scopeImports].sort().join(", ")} } from '../common/scope';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from './storage-provider';

const MAX_SIZE_BYTES = ${maxBytes};
const ALLOWED_TYPES: readonly string[] = ${JSON.stringify(shape.allowedTypes)};
const PRESIGN_TTL_MS = ${config.presignTtlMinutes} * 60_000;
${callerOwned ? `const ADMIN_ROLES: readonly string[] = ${JSON.stringify(policy.adminRoles)};\n` : ""}
export interface UploadTicket {
  attachmentId: string;
  uploadUrl: string;
  /** The client must send these exactly; they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: string;
}

@Injectable()
export class ${model}Service {
  private readonly logger = new Logger(${model}Service.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private async requireParent(parentId: string, scope: RequestScope): Promise<void> {
${scopeUsed ? "" : "    void scope;\n"}    const parent = await this.prisma.${parentDelegate}.findFirst({
      where: {
        id: parentId,
${parentScopeFilter(parent, context, "active")}
      },
      select: { id: true },
    });

    if (parent === null) {
      throw new NotFoundException('${parentModel} not found');
    }
  }

  private scopedAttachmentWhere(
    id: string,
    scope: RequestScope,
    requireActiveParent = true,
  ): Prisma.${model}WhereInput {
${scopeUsed ? "" : "    void scope;\n"}${parent.softDelete ? "" : "    void requireActiveParent;\n"}    return {
      id,
      parent: {
${parentScopeFilter(parent, context, "runtime")}
      },
    };
  }

  async requestUpload(
    parentId: string,
    input: { fileName: string; contentType: string; sizeBytes: number },
    scope: RequestScope,
  ): Promise<UploadTicket> {
    if (!ALLOWED_TYPES.includes(input.contentType)) {
      throw new BadRequestException(
        'Content type ' + input.contentType + ' is not allowed. Allowed: ' + ALLOWED_TYPES.join(', '),
      );
    }
    if (input.sizeBytes > MAX_SIZE_BYTES) {
      throw new BadRequestException(
        'File exceeds the maximum of ' + String(MAX_SIZE_BYTES) + ' bytes',
      );
    }

    await this.requireParent(parentId, scope);

    // Keys are server-chosen: a client can never place an object outside its
    // parent's namespace or overwrite another object.
    const storageKey = '${names.route(parent.name)}/' + parentId + '/' + randomUUID();

    const record = await this.prisma.${delegate}.create({
      data: {
        parentId,
        storageKey,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      },
      select: { id: true },
    });

    const presigned = await this.storage.presignPut(
      storageKey,
      input.contentType,
      input.sizeBytes,
    );

    return {
      attachmentId: record.id,
      uploadUrl: presigned.url,
      headers: presigned.headers,
      expiresAt: presigned.expiresAt,
    };
  }

  async complete(id: string, scope: RequestScope): Promise<{ id: string; status: string }> {
    const record = await this.prisma.${delegate}.findFirst({
      where: this.scopedAttachmentWhere(id, scope),
    });
    if (record === null) {
      throw new NotFoundException('Attachment not found');
    }
    if (record.status === 'READY') {
      return { id: record.id, status: record.status };
    }
    if (record.status !== 'UPLOADING') {
      throw new ConflictException('Attachment is being deleted');
    }

    const head = await this.storage.head(record.storageKey);
    if (head === null) {
      throw new ConflictException('No object was uploaded for this attachment');
    }
    if (head.sizeBytes !== record.sizeBytes || head.contentType !== record.contentType) {
      // The stored object does not match what was declared and signed. Remove
      // it: nothing downstream may ever serve unverified content.
      await this.storage.delete(record.storageKey);
      throw new ConflictException('Uploaded object does not match the declared size and type');
    }

    const updated = await this.prisma.${delegate}.updateMany({
      where: { id: record.id, status: 'UPLOADING' },
      data: { status: 'READY' },
    });
    if (updated.count !== 1) {
      const completed = await this.prisma.${delegate}.findFirst({
        where: { ...this.scopedAttachmentWhere(id, scope), status: 'READY' },
        select: { id: true },
      });
      if (completed !== null) return { id: completed.id, status: 'READY' };
      throw new ConflictException('Attachment changed while completion was in progress');
    }
    return { id: record.id, status: 'READY' };
  }

  async download(id: string, scope: RequestScope): Promise<{ url: string; expiresAt: string; fileName: string }> {
    const record = await this.prisma.${delegate}.findFirst({
      where: this.scopedAttachmentWhere(id, scope),
    });
    if (record === null || record.status !== 'READY') {
      throw new NotFoundException('Attachment not found');
    }

    const presigned = await this.storage.presignGet(record.storageKey);
    return { url: presigned.url, expiresAt: presigned.expiresAt, fileName: record.fileName };
  }

  async remove(id: string, scope: RequestScope): Promise<void> {
    const record = await this.prisma.${delegate}.findFirst({
      where: this.scopedAttachmentWhere(id, scope, false),
      select: { id: true, storageKey: true, createdAt: true },
    });
    if (record === null) {
      throw new NotFoundException('Attachment not found');
    }

    await this.prisma.${delegate}.updateMany({
      where: { id: record.id, status: { in: ['UPLOADING', 'READY'] } },
      data: { status: 'DELETING' },
    });
    await this.storage.delete(record.storageKey);

    // Keep a tombstone until the upload URL has expired. A late conditional
    // PUT can recreate an object after the first delete; the sweeper performs
    // the final delete before removing this row.
    if (record.createdAt.getTime() <= Date.now() - PRESIGN_TTL_MS) {
      await this.prisma.${delegate}.deleteMany({
        where: { id: record.id, status: 'DELETING' },
      });
    }
  }

  /** Claims stale rows before deleting bytes, so completion and cleanup cannot both win. */
  async sweepStale(olderThan: Date): Promise<number> {
    const stale = await this.prisma.${delegate}.findMany({
      where: {
        OR: [
          { status: 'UPLOADING', createdAt: { lt: olderThan } },
          { status: 'DELETING', createdAt: { lt: olderThan } },
        ],
      },
      select: { id: true, storageKey: true, status: true },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    });

    let removed = 0;
    for (const record of stale) {
      if (record.status === 'UPLOADING') {
        const claim = await this.prisma.${delegate}.updateMany({
          where: { id: record.id, status: 'UPLOADING', createdAt: { lt: olderThan } },
          data: { status: 'DELETING' },
        });
        if (claim.count !== 1) continue;
      }

      try {
        await this.storage.delete(record.storageKey);
        const deleted = await this.prisma.${delegate}.deleteMany({
          where: { id: record.id, status: 'DELETING' },
        });
        removed += deleted.count;
      } catch {
        // Keep DELETING rows for a later retry and continue processing the
        // rest of the batch; one unavailable object must not starve cleanup.
        this.logger.error('Failed to remove stale attachment ' + record.id);
        await this.prisma.${delegate}.updateMany({
          where: { id: record.id, status: 'DELETING' },
          data: { status: 'DELETING' },
        });
      }
    }
    return removed;
  }
}

`;
}

function controllerFile(shape: ParentShape, context: TargetRenderContext): string {
  const parent = shape.entity;
  const attachment = attachmentEntityName(parent.name);
  const model = names.model(attachment);
  const stem = names.file(attachment);
  const parentRoute = names.route(parent.name);
  const attachmentRoute = names.route(attachment);
  const authenticated = context.hasFeature("auth");
  const maxBytes = shape.maxSizeMb * 1024 * 1024;
  const policy = uploadPolicy(parent, context);
  const deleteRoleImport =
    policy.deleteRoleKind === "organization"
      ? "import { OrgRoles } from '../organizations/decorators/org-roles.decorator';\n"
      : policy.deleteRoleKind === "account"
        ? "import { Roles } from '../auth/decorators/roles.decorator';\n"
        : "";
  const deleteRoleDecorator =
    policy.deleteRoleKind === "organization"
      ? `  @OrgRoles(${stringArguments(policy.deleteRoles)})\n`
      : policy.deleteRoleKind === "account"
        ? `  @Roles(${stringArguments(policy.deleteRoles)})\n`
        : "";

  return `import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,${authenticated ? "\n  ApiBearerAuth," : ""}
  ApiCreatedResponse,
${policy.deleteRoleKind !== null ? "  ApiForbiddenResponse,\n" : ""}  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiErrorDto } from '../common/api-error.dto';
import { CurrentScope, RequestScope } from '../common/scope';
${deleteRoleImport}import { ${model}Service, UploadTicket } from './${stem}.service';

export class Request${model}UploadDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  fileName!: string;

  @ApiProperty({ enum: ${JSON.stringify(shape.allowedTypes)} })
  @IsIn(${JSON.stringify(shape.allowedTypes)})
  contentType!: string;

  @ApiProperty({ minimum: 1, maximum: ${maxBytes} })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(${maxBytes})
  sizeBytes!: number;
}

export class ${model}TicketDto implements UploadTicket {
  @ApiProperty() attachmentId!: string;
  @ApiProperty() uploadUrl!: string;
  @ApiProperty({ description: 'Send these headers exactly; they are signed.' })
  headers!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class ${model}DownloadDto {
  @ApiProperty() url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty() fileName!: string;
}

@ApiTags('${attachmentRoute}')${authenticated ? "\n@ApiBearerAuth()" : ""}
@ApiBadRequestResponse({ type: ApiErrorDto })
@ApiNotFoundResponse({ type: ApiErrorDto })
@Controller()
export class ${model}Controller {
  constructor(private readonly service: ${model}Service) {}

  @Post('${parentRoute}/:id/attachments')
  @ApiCreatedResponse({ type: ${model}TicketDto })
  request(
    @Param('id') id: string,
    @Body() dto: Request${model}UploadDto,
    @CurrentScope() scope: RequestScope,
  ): Promise<UploadTicket> {
    return this.service.requestUpload(id, dto, scope);
  }

  @Post('${attachmentRoute}/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'The upload was verified against storage' })
  @ApiConflictResponse({ type: ApiErrorDto })
  complete(
    @Param('id') id: string,
    @CurrentScope() scope: RequestScope,
  ): Promise<{ id: string; status: string }> {
    return this.service.complete(id, scope);
  }

  @Get('${attachmentRoute}/:id')
  @ApiOkResponse({ type: ${model}DownloadDto })
  download(
    @Param('id') id: string,
    @CurrentScope() scope: RequestScope,
  ): Promise<${model}DownloadDto> {
    return this.service.download(id, scope);
  }

  @Delete('${attachmentRoute}/:id')
${deleteRoleDecorator}${policy.deleteRoleKind !== null ? "  @ApiForbiddenResponse({ type: ApiErrorDto })\n" : ""}  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@Param('id') id: string, @CurrentScope() scope: RequestScope): Promise<void> {
    return this.service.remove(id, scope);
  }
}
`;
}

function moduleFile(shapes: ParentShape[], config: UploadsConfig): string {
  const serviceImports = shapes
    .map((shape) => {
      const model = names.model(attachmentEntityName(shape.entity.name));
      const stem = names.file(attachmentEntityName(shape.entity.name));
      return `import { ${model}Controller } from './${stem}.controller';\nimport { ${model}Service } from './${stem}.service';`;
    })
    .join("\n");

  const controllers = shapes
    .map((shape) => `${names.model(attachmentEntityName(shape.entity.name))}Controller`)
    .join(", ");
  const services = shapes
    .map((shape) => `${names.model(attachmentEntityName(shape.entity.name))}Service`)
    .join(", ");

  const sweeps = shapes
    .map(
      (shape) =>
        `      await this.${names.variable(attachmentEntityName(shape.entity.name))}Service.sweepStale(olderThan);`,
    )
    .join("\n");
  const sweeperInjections = shapes
    .map(
      (shape) =>
        `    private readonly ${names.variable(attachmentEntityName(shape.entity.name))}Service: ${names.model(attachmentEntityName(shape.entity.name))}Service,`,
    )
    .join("\n");

  return `import { Injectable, Logger, Module } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ScheduleModule } from '@nestjs/schedule';
import { CustomModule } from '../../custom/custom.module';
${serviceImports}
import { MockStorageProvider } from './mock.provider';
import { S3StorageProvider } from './s3.provider';
import {
  CUSTOM_STORAGE_PROVIDER,
  STORAGE_PROVIDER,
  StorageProvider,
} from './storage-provider';

const UPLOADS_STALE_AFTER_MS = ${config.staleAfterMinutes} * 60_000;

/**
 * Under test, storage defaults to the in-memory mock so suites never need a
 * live object store or credentials. An explicit STORAGE_PROVIDER still wins,
 * except that the mock is refused outside NODE_ENV=test.
 */
export function selectStorage(custom?: StorageProvider): StorageProvider {
  const explicit = process.env.STORAGE_PROVIDER;
  const selected =
    explicit !== undefined && explicit !== ''
      ? explicit
      : process.env.NODE_ENV === 'test'
        ? 'mock'
        : 's3';

  if (selected === 'mock') {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('The mock storage provider is only allowed when NODE_ENV is "test".');
    }
    return new MockStorageProvider();
  }
  if (custom !== undefined) {
    return custom;
  }
  if (selected === 's3') {
    return new S3StorageProvider();
  }
  throw new Error('Unknown STORAGE_PROVIDER "' + selected + '". Use one of: s3, mock.');
}

@Injectable()
export class UploadsSweeper {
  private readonly logger = new Logger(UploadsSweeper.name);

  constructor(
${sweeperInjections}
  ) {}

  @Interval(60_000)
  async sweep(): Promise<void> {
    const olderThan = new Date(Date.now() - UPLOADS_STALE_AFTER_MS);
    try {
${sweeps}
    } catch {
      this.logger.error('Stale upload sweep failed');
    }
  }
}

@Module({
  imports: [CustomModule, ScheduleModule.forRoot()],
  controllers: [${controllers}],
  providers: [
    ${services},
    UploadsSweeper,
    {
      provide: STORAGE_PROVIDER,
      useFactory: selectStorage,
      inject: [{ token: CUSTOM_STORAGE_PROVIDER, optional: true }],
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class UploadsModule {}
`;
}

function uploadsE2e(shapes: ParentShape[], context: TargetRenderContext): string | null {
  const shape = shapes[0];
  if (shape === undefined || !context.hasFeature("auth")) return null;

  const parent = shape.entity;
  const attachment = attachmentEntityName(parent.name);
  const parentRoute = names.route(parent.name);
  const attachmentRoute = names.route(attachment);
  const delegate = names.delegate(attachment);
  const prefix = context.settings.apiPrefix;
  const badType = shape.allowedTypes.includes("text/x-unlikely")
    ? "application/x-other"
    : "text/x-unlikely";
  const goodType = shape.allowedTypes[0]!;
  const maxBytes = shape.maxSizeMb * 1024 * 1024;
  const setupRole = uploadPolicy(parent, context).adminRoles[0] ?? "admin";
  const tenant = parent.tenant !== null;
  const callerOwned = isCallerOwned(parent, context);
  const authConfig = context.featureConfig("auth") as { userEntity?: string } | undefined;
  const authUser = parent.name === (authConfig?.userEntity ?? "User");
  const crudParent = context.crudEntities().some((entity) => entity.name === parent.name);
  const organizationConfig = context.featureConfig("organizations") as
    | { roles?: string[]; defaultRole?: string }
    | undefined;
  const organizationRoles = organizationConfig?.roles ?? ["owner", "admin", "member"];
  const organizationMemberRole =
    organizationConfig?.defaultRole ?? organizationRoles.at(-1) ?? "member";
  const parentOverrides = [
    ...(parent.ownership ? ["ownerId: account.id"] : []),
    ...(tenant ? ["organizationId"] : []),
  ].join(", ");

  return `import { INestApplication } from '@nestjs/common';
${tenant && callerOwned ? `import { ${names.enumType("Membership", "role")} } from '@prisma/client';\n` : ""}import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { MockStorageProvider } from '../src/generated/uploads/mock.provider';
import { STORAGE_PROVIDER } from '../src/generated/uploads/storage-provider';
import { ${names.model(attachment)}Service } from '../src/generated/uploads/${names.file(attachment)}.service';
import { registerAccount } from './utils/auth-helper';
${authUser ? "" : `import { create${names.model(parent.name)} } from './utils/factories';\n`}import { resetDatabase } from './utils/reset';
import { createTestApp } from './utils/test-app';

describe('Uploads (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: MockStorageProvider;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    storage = app.get<MockStorageProvider>(STORAGE_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    storage.reset();
  });

  async function setup(): Promise<{
    headers: Record<string, string>;
    parentId: string;
    organizationId: string | null;
  }> {
    const account = await registerAccount(app, prisma, { role: '${setupRole}' });
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + account.accessToken,
    };
${
  tenant
    ? `    const organization = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set(headers)
      .send({ name: 'Uploads' })
      .expect(201);
    const organizationId = organization.body.id as string;
    headers['X-Organization-Id'] = organizationId;
`
    : "    const organizationId: string | null = null;\n"
}    const parent = ${authUser ? "{ id: account.id }" : `await create${names.model(parent.name)}(prisma${parentOverrides ? `, { ${parentOverrides} }` : ""})`};
    return {
      headers,
      parentId: parent.id,
      organizationId,
    };
  }

  it('walks the full upload lifecycle with server-side verification', async () => {
    const { headers, parentId } = await setup();

    const ticket = await request(app.getHttpServer())
      .post('/${prefix}/${parentRoute}/' + parentId + '/attachments')
      .set(headers)
      .send({ fileName: 'photo.png', contentType: '${goodType}', sizeBytes: 1234 })
      .expect(201);

    expect(ticket.body.uploadUrl).toBeDefined();
    expect(ticket.body.headers['content-length']).toBe('1234');

    // Completing before any bytes exist is refused.
    await request(app.getHttpServer())
      .post('/${prefix}/${attachmentRoute}/' + ticket.body.attachmentId + '/complete')
      .set(headers)
      .expect(409);

    // A mismatched object (wrong size) is refused and removed.
    const stored = await prisma.${delegate}.findFirstOrThrow();
    storage.simulateUpload(stored.storageKey, 999, '${goodType}');
    await request(app.getHttpServer())
      .post('/${prefix}/${attachmentRoute}/' + ticket.body.attachmentId + '/complete')
      .set(headers)
      .expect(409);
    expect(storage.objects.has(stored.storageKey)).toBe(false);

    // The matching object completes and becomes downloadable.
    storage.simulateUpload(stored.storageKey, 1234, '${goodType}');
    expect(() => storage.simulateUpload(stored.storageKey, 1234, '${goodType}')).toThrow(
      'Precondition failed',
    );
    await request(app.getHttpServer())
      .post('/${prefix}/${attachmentRoute}/' + ticket.body.attachmentId + '/complete')
      .set(headers)
      .expect(200);

    const download = await request(app.getHttpServer())
      .get('/${prefix}/${attachmentRoute}/' + ticket.body.attachmentId)
      .set(headers)
      .expect(200);
    expect(download.body.url).toContain(stored.storageKey);
    expect(download.body.fileName).toBe('photo.png');

${
  crudParent && parent.softDelete
    ? `    // Soft-deleting a parent retains attachment metadata, but the
    // storage-aware attachment endpoint must still be able to purge it.
    await request(app.getHttpServer())
      .delete('/${prefix}/${parentRoute}/' + parentId)
      .set(headers)
      .expect(204);
`
    : crudParent
      ? `    // A hard parent delete is blocked until storage cleanup finishes.
    await request(app.getHttpServer())
      .delete('/${prefix}/${parentRoute}/' + parentId)
      .set(headers)
      .expect(409);
`
      : ""
}    // Delete removes the current object but retains a tombstone until the
    // upload URL expires, so a late PUT cannot become a permanent orphan.
    await request(app.getHttpServer())
      .delete('/${prefix}/${attachmentRoute}/' + ticket.body.attachmentId)
      .set(headers)
      .expect(204);
    expect(storage.objects.has(stored.storageKey)).toBe(false);

    storage.simulateUpload(stored.storageKey, 1234, '${goodType}');
    await prisma.${delegate}.update({
      where: { id: stored.id },
      data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    const service = app.get(${names.model(attachment)}Service);
    await service.sweepStale(new Date(Date.now() - 60_000));
    expect(await prisma.${delegate}.count()).toBe(0);
    expect(storage.objects.has(stored.storageKey)).toBe(false);
${
  crudParent && !parent.softDelete
    ? `
    await request(app.getHttpServer())
      .delete('/${prefix}/${parentRoute}/' + parentId)
      .set(headers)
      .expect(204);
`
    : ""
}  });

  it('refuses disallowed types and oversized declarations at request time', async () => {
    const { headers, parentId } = await setup();

    await request(app.getHttpServer())
      .post('/${prefix}/${parentRoute}/' + parentId + '/attachments')
      .set(headers)
      .send({ fileName: 'evil.bin', contentType: '${badType}', sizeBytes: 10 })
      .expect(400);

    await request(app.getHttpServer())
      .post('/${prefix}/${parentRoute}/' + parentId + '/attachments')
      .set(headers)
      .send({ fileName: 'huge.png', contentType: '${goodType}', sizeBytes: ${maxBytes + 1} })
      .expect(400);

    expect(await prisma.${delegate}.count()).toBe(0);
  });

${
  callerOwned
    ? `  it('never exposes an attachment through another principal', async () => {
    const ${tenant ? "{ headers, parentId, organizationId }" : "{ headers, parentId }"} = await setup();

    const ticket = await request(app.getHttpServer())
      .post('/${prefix}/${parentRoute}/' + parentId + '/attachments')
      .set(headers)
      .send({ fileName: 'photo.png', contentType: '${goodType}', sizeBytes: 10 })
      .expect(201);

    const outsider = await registerAccount(app, prisma);
${
  tenant
    ? `    if (organizationId === null) throw new Error('Expected tenant setup');
    await prisma.membership.create({
      data: {
        organizationId,
        userId: outsider.id,
        role: ${names.enumType("Membership", "role")}.${organizationMemberRole},
      },
    });
`
    : ""
}    const outsiderHeaders: Record<string, string> = {
      Authorization: 'Bearer ' + outsider.accessToken,
    };
${tenant ? "    outsiderHeaders['X-Organization-Id'] = organizationId;\n" : ""}    await request(app.getHttpServer())
      .get('/${prefix}/${attachmentRoute}/' + ticket.body.attachmentId)
      .set(outsiderHeaders)
      .expect(404);
  });
`
    : ""
}

  it('sweeps stale uploads together with their objects', async () => {
    const { headers, parentId } = await setup();

    await request(app.getHttpServer())
      .post('/${prefix}/${parentRoute}/' + parentId + '/attachments')
      .set(headers)
      .send({ fileName: 'stale.png', contentType: '${goodType}', sizeBytes: 10 })
      .expect(201);

    const stored = await prisma.${delegate}.findFirstOrThrow();
    storage.simulateUpload(stored.storageKey, 10, '${goodType}');
    await prisma.${delegate}.update({
      where: { id: stored.id },
      data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const service = app.get(${names.model(attachment)}Service);
    await service.sweepStale(new Date(Date.now() - 60_000));

    expect(await prisma.${delegate}.count()).toBe(0);
    expect(storage.objects.has(stored.storageKey)).toBe(false);
  });
});
`;
}

const UPLOADS_STARTUP_SPEC = `import { selectStorage } from './uploads.module';

const VALID_S3_ENV = {
  STORAGE_PROVIDER: 's3',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'startup-test-uploads',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'startup-test',
  S3_SECRET_ACCESS_KEY: 'startup-test-secret',
  S3_FORCE_PATH_STYLE: 'true',
};

/**
 * Startup behavior of storage selection: the documented quick-start
 * configuration must boot, and unsafe or incomplete configurations must fail
 * with actionable errors before the application accepts traffic.
 */
describe('storage startup validation', () => {
  const saved = process.env;

  beforeEach(() => {
    process.env = { ...saved };
    delete process.env.STORAGE_PROVIDER;
    delete process.env.S3_ALLOW_INSECURE_HTTP;
    for (const name of Object.keys(VALID_S3_ENV)) delete process.env[name];
  });

  afterAll(() => {
    process.env = saved;
  });

  it('boots with the documented local development configuration', () => {
    Object.assign(process.env, VALID_S3_ENV, { NODE_ENV: 'development' });
    expect(selectStorage().id).toBe('s3');
  });

  it('lists every missing S3 variable in one actionable error', () => {
    Object.assign(process.env, { NODE_ENV: 'development', STORAGE_PROVIDER: 's3' });
    expect(() => selectStorage()).toThrow(
      'Missing storage configuration: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY',
    );
  });

  it('refuses the mock provider outside NODE_ENV=test', () => {
    Object.assign(process.env, { NODE_ENV: 'production', STORAGE_PROVIDER: 'mock' });
    expect(() => selectStorage()).toThrow('only allowed when NODE_ENV is "test"');
  });

  it('defaults to the mock provider under test', () => {
    expect(selectStorage().id).toBe('mock');
  });

  it('requires https in production unless explicitly overridden', () => {
    Object.assign(process.env, VALID_S3_ENV, { NODE_ENV: 'production' });
    expect(() => selectStorage()).toThrow('S3_ENDPOINT must use https in production');

    process.env.S3_ALLOW_INSECURE_HTTP = 'true';
    expect(selectStorage().id).toBe('s3');
  });

  it('rejects an unknown provider name', () => {
    Object.assign(process.env, { NODE_ENV: 'development', STORAGE_PROVIDER: 'gcs' });
    expect(() => selectStorage()).toThrow('Unknown STORAGE_PROVIDER');
  });
});
`;

/** DNS-compatible bucket name derived from the project name, e.g. `my-api-uploads`. */
function uploadsBucketName(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug.slice(0, 63 - "-uploads".length)}-uploads`;
}

/** Local-development access key; doubles as the MinIO root user (min 3 chars). */
function uploadsAccessKeyId(projectName: string): string {
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length >= 3 ? slug : `${slug}-storage`;
}

export const uploadsRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const config = uploadsConfig(context.config);

    const shapes: ParentShape[] = Object.entries(config.entities ?? {})
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([name, entityConfig]) => ({
        entity: context.entity(name),
        maxSizeMb: entityConfig.maxSizeMb ?? 10,
        allowedTypes: entityConfig.allowedTypes ?? [...DEFAULT_ALLOWED_TYPES],
      }));

    const files: RenderedFile[] = [
      file("src/generated/uploads/storage-provider.ts", STORAGE_PROVIDER),
      file("src/generated/uploads/s3-presign.ts", S3_PRESIGN),
      file("src/generated/uploads/s3-presign.spec.ts", S3_PRESIGN_SPEC),
      file("src/generated/uploads/s3.provider.ts", s3Provider(config)),
      file("src/generated/uploads/mock.provider.ts", mockProvider(config)),
      file("src/generated/uploads/uploads.module.ts", moduleFile(shapes, config)),
      file("src/generated/uploads/uploads-startup.spec.ts", UPLOADS_STARTUP_SPEC),
    ];

    for (const shape of shapes) {
      const stem = names.file(attachmentEntityName(shape.entity.name));
      files.push(
        file(`src/generated/uploads/${stem}.service.ts`, serviceFile(shape, context, config)),
        file(`src/generated/uploads/${stem}.controller.ts`, controllerFile(shape, context)),
      );
    }

    const e2e = uploadsE2e(shapes, context);
    if (e2e !== null) {
      files.push(file("test/uploads.e2e-spec.ts", e2e));
    }

    return {
      ...emptyRenderResult(),
      files,
      rootModules: [
        {
          symbol: "UploadsModule",
          from: "./generated/uploads/uploads.module",
          kind: "module",
          order: 60,
        },
      ],
      packageDependencies: { "@nestjs/schedule": "5.0.1" },
      testEnv: { STORAGE_PROVIDER: "mock" },
      envExample: [
        {
          name: "STORAGE_PROVIDER",
          value: "s3",
          comment: "Object storage provider: s3 (any S3-compatible store) or mock (tests only).",
        },
        {
          name: "S3_ENDPOINT",
          value: "http://localhost:9000",
          comment:
            "Origin URL of the object store. The default points at the local MinIO service from docker-compose.yml; use your provider's HTTPS endpoint in production.",
        },
        {
          name: "S3_BUCKET",
          value: uploadsBucketName(context.ir.project.name),
          comment: "Bucket for uploads. The docker-compose minio-init service creates it in MinIO on first start.",
        },
        {
          name: "S3_REGION",
          value: "us-east-1",
          comment: "Region used in request signatures. MinIO accepts any value; AWS requires the bucket's real region.",
        },
        {
          name: "S3_ACCESS_KEY_ID",
          value: uploadsAccessKeyId(context.ir.project.name),
          comment: "Static access key. docker-compose reuses this value as the local MinIO root user.",
        },
        {
          name: "S3_SECRET_ACCESS_KEY",
          value: "replace-with-a-random-storage-password",
          comment:
            "Static secret key (at least 8 characters). docker-compose reuses this value as the local MinIO root password.",
        },
        {
          name: "S3_FORCE_PATH_STYLE",
          value: "true",
          comment: "Path-style addressing; required by MinIO, set false for AWS virtual-host style.",
        },
        {
          name: "S3_ALLOW_INSECURE_HTTP",
          value: "false",
          comment: "Explicit production-only opt-out from the default HTTPS requirement.",
        },
      ],
    };
  },
};
