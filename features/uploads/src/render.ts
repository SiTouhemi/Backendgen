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

const S3_PROVIDER = `import { Injectable } from '@nestjs/common';
import { presignS3Url } from './s3-presign';
import {
  PresignedRequest,
  StorageProvider,
  StoredObjectHead,
} from './storage-provider';

const PRESIGN_TTL_SECONDS = Number(process.env.UPLOADS_PRESIGN_TTL_SECONDS ?? '900');

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

    this.endpoint = process.env.S3_ENDPOINT as string;
    this.bucket = process.env.S3_BUCKET as string;
    this.accessKeyId = process.env.S3_ACCESS_KEY_ID as string;
    this.secretAccessKey = process.env.S3_SECRET_ACCESS_KEY as string;
    this.region = process.env.S3_REGION ?? 'us-east-1';
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
    });
  }

  async presignGet(key: string): Promise<PresignedRequest> {
    return this.presign('GET', key);
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const request = this.presign('HEAD', key);
    const response = await fetch(request.url, { method: 'HEAD' });
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
    const response = await fetch(request.url, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error('Storage DELETE failed with status ' + String(response.status));
    }
  }
}
`;

const MOCK_PROVIDER = `import { Injectable } from '@nestjs/common';
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
      headers: { 'content-length': String(sizeBytes), 'content-type': contentType },
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
  }

  async presignGet(key: string): Promise<PresignedRequest> {
    return { url: 'mock://get/' + key, headers: {}, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** What the real client's PUT to the presigned URL would have stored. */
  simulateUpload(key: string, sizeBytes: number, contentType: string): void {
    this.objects.set(key, { sizeBytes, contentType });
  }

  reset(): void {
    this.objects.clear();
  }
}
`;

interface ParentShape {
  entity: NormalizedEntity;
  maxSizeMb: number;
  allowedTypes: string[];
}

function parentScopeFilter(parent: NormalizedEntity, authenticated: boolean): string {
  const clauses: string[] = [];
  if (parent.softDelete) clauses.push("deletedAt: null,");
  if (parent.tenant) clauses.push(`${parent.tenant.foreignKey}: requireOrganization(scope),`);
  if (parent.ownership && authenticated) {
    clauses.push(
      `...(isAdmin(scope, ADMIN_ROLES) ? {} : { ${parent.ownership.foreignKey}: requireUser(scope) }),`,
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

  const scopeImports = new Set<string>(["RequestScope"]);
  if (parent.tenant) scopeImports.add("requireOrganization");
  if (parent.ownership && authenticated) {
    scopeImports.add("isAdmin");
    scopeImports.add("requireUser");
  }

  return `import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ${[...scopeImports].sort().join(", ")} } from '../common/scope';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER, StorageProvider } from './storage-provider';

const MAX_SIZE_BYTES = ${maxBytes};
const ALLOWED_TYPES: readonly string[] = ${JSON.stringify(shape.allowedTypes)};
${parent.ownership && authenticated ? `const ADMIN_ROLES: readonly string[] = ['admin'];\n` : ""}
export interface UploadTicket {
  attachmentId: string;
  uploadUrl: string;
  /** The client must send these exactly; they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: string;
}

@Injectable()
export class ${model}Service {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  private async requireParent(parentId: string, scope: RequestScope): Promise<void> {
    const parent = await this.prisma.${parentDelegate}.findFirst({
      where: {
        id: parentId,
${parentScopeFilter(parent, authenticated)}
      },
      select: { id: true },
    });

    if (parent === null) {
      throw new NotFoundException('${parentModel} not found');
    }
  }

  private scopedAttachmentWhere(id: string, scope: RequestScope): Record<string, unknown> {
    return {
      id,
      parent: {
${parentScopeFilter(parent, authenticated)}
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
      where: this.scopedAttachmentWhere(id, scope) as never,
    });
    if (record === null) {
      throw new NotFoundException('Attachment not found');
    }
    if (record.status === 'READY') {
      return { id: record.id, status: record.status };
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

    const updated = await this.prisma.${delegate}.update({
      where: { id: record.id },
      data: { status: 'READY' },
      select: { id: true, status: true },
    });
    return { id: updated.id, status: updated.status };
  }

  async download(id: string, scope: RequestScope): Promise<{ url: string; expiresAt: string; fileName: string }> {
    const record = await this.prisma.${delegate}.findFirst({
      where: this.scopedAttachmentWhere(id, scope) as never,
    });
    if (record === null || record.status !== 'READY') {
      throw new NotFoundException('Attachment not found');
    }

    const presigned = await this.storage.presignGet(record.storageKey);
    return { url: presigned.url, expiresAt: presigned.expiresAt, fileName: record.fileName };
  }

  async remove(id: string, scope: RequestScope): Promise<void> {
    const record = await this.prisma.${delegate}.findFirst({
      where: this.scopedAttachmentWhere(id, scope) as never,
      select: { id: true, storageKey: true },
    });
    if (record === null) {
      throw new NotFoundException('Attachment not found');
    }

    await this.storage.delete(record.storageKey);
    await this.prisma.${delegate}.delete({ where: { id: record.id } });
  }

  /** Sweeps stale UPLOADING rows and their objects. Multi-instance safe: deletes are idempotent. */
  async sweepStale(olderThan: Date): Promise<number> {
    const stale = await this.prisma.${delegate}.findMany({
      where: { status: 'UPLOADING', createdAt: { lt: olderThan } },
      select: { id: true, storageKey: true },
      take: 100,
    });

    for (const record of stale) {
      await this.storage.delete(record.storageKey);
      await this.prisma.${delegate}.deleteMany({ where: { id: record.id, status: 'UPLOADING' } });
    }
    return stale.length;
  }
}

export const UPLOADS_STALE_AFTER_MS = ${config.staleAfterMinutes} * 60_000;
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiErrorDto } from '../common/api-error.dto';
import { CurrentScope, RequestScope } from '../common/scope';
import { ${model}Service, UploadTicket } from './${stem}.service';

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
  @HttpCode(HttpStatus.NO_CONTENT)
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
      return `import { ${model}Controller } from './${stem}.controller';\nimport { ${model}Service, UPLOADS_STALE_AFTER_MS } from './${stem}.service';`;
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

  void config;
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

/**
 * Under test, storage defaults to the in-memory mock so suites never need a
 * live object store or credentials. An explicit STORAGE_PROVIDER still wins,
 * except that the mock is refused outside NODE_ENV=test.
 */
function selectStorage(custom?: StorageProvider): StorageProvider {
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

  return `import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { MockStorageProvider } from '../src/generated/uploads/mock.provider';
import { STORAGE_PROVIDER } from '../src/generated/uploads/storage-provider';
import { ${names.model(attachment)}Service } from '../src/generated/uploads/${names.file(attachment)}.service';
import { registerAccount } from './utils/auth-helper';
import { create${names.model(parent.name)} } from './utils/factories';
import { resetDatabase } from './utils/reset';
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

  async function setup(): Promise<{ headers: Record<string, string>; parentId: string; ownerId: string }> {
    const account = await registerAccount(app, prisma, { role: 'admin' });
    const parent = await create${names.model(parent.name)}(prisma${parent.ownership ? ", { ownerId: account.id }" : ""});
    return {
      headers: { Authorization: 'Bearer ' + account.accessToken },
      parentId: parent.id,
      ownerId: account.id,
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

    // Deleting removes the row and the stored object.
    await request(app.getHttpServer())
      .delete('/${prefix}/${attachmentRoute}/' + ticket.body.attachmentId)
      .set(headers)
      .expect(204);
    expect(storage.objects.has(stored.storageKey)).toBe(false);
  });

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

  it('never exposes an attachment through another principal', async () => {
    const { headers, parentId } = await setup();

    const ticket = await request(app.getHttpServer())
      .post('/${prefix}/${parentRoute}/' + parentId + '/attachments')
      .set(headers)
      .send({ fileName: 'photo.png', contentType: '${goodType}', sizeBytes: 10 })
      .expect(201);

    const outsider = await registerAccount(app, prisma);
    await request(app.getHttpServer())
      .get('/${prefix}/${attachmentRoute}/' + ticket.body.attachmentId)
      .set({ Authorization: 'Bearer ' + outsider.accessToken })
      .expect(404);
  });

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
      file("src/generated/uploads/s3.provider.ts", S3_PROVIDER),
      file("src/generated/uploads/mock.provider.ts", MOCK_PROVIDER),
      file("src/generated/uploads/uploads.module.ts", moduleFile(shapes, config)),
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
          name: "S3_FORCE_PATH_STYLE",
          value: "true",
          comment: "Path-style addressing; required by MinIO, set false for AWS virtual-host style.",
        },
      ],
    };
  },
};
