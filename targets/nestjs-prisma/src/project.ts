import type { RenderedFile, TargetRenderContext } from "@backend-compiler/target-sdk";

function generated(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

function scaffold(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "custom-scaffold" };
}

const TSCONFIG = `{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": false,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2023",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "exclude": ["node_modules", "dist", "client"]
}
`;

const TSCONFIG_BUILD = `{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "client", "**/*spec.ts"]
}
`;

const NEST_CLI = `{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true
  }
}
`;

const JEST_UNIT = `{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "src",
  "testRegex": ".*\\\\.spec\\\\.ts$",
  "transform": {
    "^.+\\\\.(t|j)s$": ["ts-jest", { "tsconfig": "tsconfig.json" }]
  },
  "testEnvironment": "node"
}
`;

const JEST_INTEGRATION = `{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testRegex": "test/.*\\\\.e2e-spec\\\\.ts$",
  "transform": {
    "^.+\\\\.(t|j)s$": ["ts-jest", { "tsconfig": "tsconfig.json" }]
  },
  "setupFiles": ["<rootDir>/test/utils/test-env.ts"],
  "testEnvironment": "node",
  "testTimeout": 60000
}
`;

const GITIGNORE = `node_modules/
dist/
coverage/
*.tsbuildinfo
.env
.env.*
!.env.example
`;

const DOCKERIGNORE = `node_modules
dist
.git
.env
coverage
`;

const PRISMA_SERVICE = `import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  enableShutdownHooks(app: INestApplication): void {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}
`;

const PRISMA_MODULE = `import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
`;

const API_ERROR = `import { ApiProperty } from '@nestjs/swagger';

/** The single error shape every endpoint in this API returns. */
export class ApiErrorDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'VALIDATION_FAILED' })
  code!: string;

  @ApiProperty({ type: [String], example: ['name should not be empty'] })
  message!: string[];

  @ApiProperty({ example: '/api/rooms' })
  path!: string;

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  timestamp!: string;
}
`;

const EXCEPTION_FILTER = `import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string[];
  path: string;
  timestamp: string;
}

/**
 * Normalises every failure into one response shape. Prisma's driver errors are
 * translated here so that no persistence detail leaks to clients.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    // Query strings often contain tokens or user data. Keep both the response
    // and logs on the route path so operational telemetry cannot capture them.
    const body = this.toErrorBody(exception, request.path);

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const errorName = exception instanceof Error ? exception.name : 'UnknownError';
      const stack = process.env.NODE_ENV === 'production' ? undefined : exception instanceof Error ? exception.stack : undefined;
      this.logger.error(\`\${request.method} \${request.path} failed (\${errorName})\`, stack);
    }

    response.status(body.statusCode).json(body);
  }

  private toErrorBody(exception: unknown, path: string): ErrorBody {
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? [payload]
          : Array.isArray((payload as { message?: unknown }).message)
            ? ((payload as { message: string[] }).message)
            : [String((payload as { message?: unknown }).message ?? exception.message)];
      const code =
        typeof payload === 'object' && typeof (payload as { code?: unknown }).code === 'string'
          ? (payload as { code: string }).code
          : this.defaultCode(status);
      return { statusCode: status, code, message, path, timestamp };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            statusCode: HttpStatus.CONFLICT,
            code: 'UNIQUE_CONSTRAINT_VIOLATION',
            message: ['A record with these values already exists'],
            path,
            timestamp,
          };
        case 'P2025':
          return {
            statusCode: HttpStatus.NOT_FOUND,
            code: 'NOT_FOUND',
            message: ['Resource not found'],
            path,
            timestamp,
          };
        case 'P2003':
          return {
            statusCode: HttpStatus.BAD_REQUEST,
            code: 'FOREIGN_KEY_VIOLATION',
            message: ['A referenced record does not exist'],
            path,
            timestamp,
          };
        default:
          break;
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: ['Internal server error'],
      path,
      timestamp,
    };
  }

  private defaultCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_FAILED';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return 'ERROR';
    }
  }
}
`;

const PAGINATION = `import { applyDecorators, type Type as ClassRef } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  /**
   * Offset pagination is bounded: deep offsets scan and discard every earlier
   * row. Filter or sort to reach older records instead of paging to them.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'desc';
}

export class PageMetaDto {
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export interface Page<T> {
  data: T[];
  meta: PageMetaDto;
}

export function toPage<T>(data: T[], total: number, page: number, pageSize: number): Page<T> {
  return {
    data,
    meta: {
      page,
      pageSize,
      total,
      totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
    },
  };
}

/**
 * OpenAPI schema for the { data, meta } envelope every list endpoint returns.
 * Generated clients see the real response shape, not a bare array.
 */
export function ApiPaginatedResponse<TModel extends ClassRef<unknown>>(
  model: TModel,
): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(PageMetaDto, model),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta: { $ref: getSchemaPath(PageMetaDto) },
        },
      },
    }),
  );
}
`;

const PUBLIC_DECORATOR = `import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'backendgen:isPublic';

/**
 * Marks a route as reachable without authentication. The concept lives in the
 * core so that the health endpoint and the OpenAPI document stay reachable even
 * when a feature installs a global authentication guard.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
`;

const HEALTH_CONTROLLER = `import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness answers "is this process running"; readiness answers "can it serve
 * traffic". Orchestrators restart on failed liveness and stop routing on
 * failed readiness, so the two must never be conflated: a database outage
 * should drain traffic, not restart every API instance.
 */
@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @ApiOkResponse({ description: 'The process is up and serving HTTP' })
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ description: 'Every required dependency is reachable' })
  @ApiServiceUnavailableResponse({ description: 'The database is unreachable' })
  async ready(): Promise<{ status: string; database: string }> {
    try {
      await this.prisma.$queryRaw\`SELECT 1\`;
    } catch {
      throw new ServiceUnavailableException('Database is unreachable');
    }

    return { status: 'ok', database: 'up' };
  }

  /** Kept for compatibility; equivalent to /health/ready. */
  @Get()
  @ApiOkResponse({ description: 'Alias of /health/ready' })
  @ApiServiceUnavailableResponse({ description: 'The database is unreachable' })
  check(): Promise<{ status: string; database: string }> {
    return this.ready();
  }
}
`;

const HEALTH_MODULE = `import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
`;

function healthE2e(context: TargetRenderContext): string {
  const prefix = context.settings.apiPrefix;
  return `import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/generated/common/bootstrap';
import { PrismaService } from '../src/generated/prisma/prisma.service';

describe('health (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('separates process liveness from database readiness', async () => {
    await request(app.getHttpServer())
      .get('/${prefix}/health/live')
      .expect(200)
      .expect({ status: 'ok' });

    await request(app.getHttpServer())
      .get('/${prefix}/health/ready')
      .expect(200)
      .expect({ status: 'ok', database: 'up' });
  });

  it('returns 503 when the database readiness check fails', async () => {
    const query = jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('test outage'));
    try {
      const response = await request(app.getHttpServer())
        .get('/${prefix}/health/ready')
        .expect(503);
      expect(response.body).toMatchObject({
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: ['Database is unreachable'],
      });
    } finally {
      query.mockRestore();
    }
  });
});
`;
}

function openApiE2e(context: TargetRenderContext): string | null {
  const endpoint = context.ir.endpoints.find(
    (candidate) => candidate.feature === "crud" && candidate.operation === "list",
  );
  if (endpoint === undefined) return null;

  const path = `/${context.settings.apiPrefix}${endpoint.path}`;
  return `import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp, createOpenApiDocument } from '../src/generated/common/bootstrap';

describe('OpenAPI document (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('describes paginated CRUD responses as data and meta', () => {
    const document = createOpenApiDocument(app);
    const response = document.paths[${JSON.stringify(path)}]?.get?.responses['200'] as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined;

    expect(response?.content?.['application/json']?.schema).toMatchObject({
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { type: 'array' },
        meta: { '$ref': expect.stringContaining('PageMetaDto') },
      },
    });
  });
});
`;
}

const CUSTOM_MODULE = `import { Module } from '@nestjs/common';

/**
 * Your module. The generator creates this file once and never rewrites it.
 *
 * Register custom providers here — for example an implementation of a
 * generated policy interface — and they will override the generated defaults
 * because this module is imported last.
 */
@Module({
  providers: [],
  exports: [],
})
export class CustomModule {}
`;

const CUSTOM_README = `# Custom code

Everything in \`src/custom/\` belongs to you. \`backendgen generate\` writes these
files once and never touches them again, even with \`--force\`.

Everything in \`src/generated/\` belongs to the compiler and is replaced on every
run. Editing a generated file is allowed, but the next generation will refuse to
overwrite it until you either revert it or pass \`--force\`.

To change generated behaviour, implement the interface the generator exposes and
register it in \`custom.module.ts\`. Run \`backendgen generate --dry-run\` to see
what a regeneration would change.
`;

function bootstrapHelper(context: TargetRenderContext): string {
  const { settings } = context;
  return `import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { Express } from 'express';
import { json, urlencoded } from 'express';
import helmet from 'helmet';

export interface AppSecurityOptions {
  /** Number of trusted reverse proxies. Keep at zero unless the deployment has one. */
  trustProxyHops?: number;
  /** Swagger UI needs an inline script exception, so it is opt-in in production. */
  swaggerEnabled?: boolean;
}

/**
 * Shared between \`main.ts\` and the integration tests so that both run against
 * an identically configured application.
 */
export function configureApp(app: INestApplication, options: AppSecurityOptions = {}): void {
  const server = app.getHttpAdapter().getInstance() as Express;
  server.disable('x-powered-by');
  if ((options.trustProxyHops ?? 0) > 0) {
    server.set('trust proxy', options.trustProxyHops as number);
  }
  server.use(
    helmet(options.swaggerEnabled === true ? { contentSecurityPolicy: false } : {}),
  );
  server.use(json({ limit: '100kb', strict: true }));
  server.use(urlencoded({ extended: false, limit: '20kb', parameterLimit: 100 }));

  app.setGlobalPrefix('${settings.apiPrefix}');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('${context.ir.project.name}')
    .setDescription(${JSON.stringify(context.ir.project.description ?? "Generated by backendgen")})
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setupOpenApi(app: INestApplication): void {
  SwaggerModule.setup('${settings.apiPrefix}/docs', app, createOpenApiDocument(app));
}
`;
}

function mainFile(context: TargetRenderContext): string {
  return `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, setupOpenApi } from './generated/common/bootstrap';
import { loadEnvironment } from './generated/config/environment';

async function bootstrap(): Promise<void> {
  const environment = loadEnvironment();
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  configureApp(app, {
    swaggerEnabled: environment.SWAGGER_ENABLED,
    trustProxyHops: environment.TRUST_PROXY_HOPS,
  });
  if (environment.SWAGGER_ENABLED) {
    setupOpenApi(app);
  }
  app.enableShutdownHooks();

  await app.listen(environment.PORT);
}

void bootstrap();
`;
}

function environmentFile(context: TargetRenderContext): string {
  const required = context.ir.secrets.filter((secret) => secret.required).map((secret) => secret.name);
  const optional = context.ir.secrets.filter((secret) => !secret.required).map((secret) => secret.name);
  const requiredList = ["DATABASE_URL", ...required].sort();

  const fields = [
    "  NODE_ENV: 'development' | 'test' | 'production';",
    "  PORT: number;",
    "  SWAGGER_ENABLED: boolean;",
    "  TRUST_PROXY_HOPS: number;",
    ...requiredList.map((name) => `  ${name}: string;`),
    ...optional.map((name) => `  ${name}: string | undefined;`),
  ].join("\n");

  const assignments = [
    ...requiredList.map((name) => `    ${name}: source.${name} as string,`),
    ...optional.map((name) => `    ${name}: source.${name},`),
  ].join("\n");

  return `export interface Environment {
${fields}
}

const REQUIRED_VARIABLES = [
${requiredList.map((name) => `  '${name}',`).join("\n")}
] as const;

/**
 * Fails fast and loudly when a required secret is absent. The application must
 * never start with a missing signing key or database URL, and it must never
 * substitute a default for one.
 */
export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const missing = REQUIRED_VARIABLES.filter((name) => {
    const value = source[name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      \`Missing required environment variables: \${missing.join(', ')}. See .env.example.\`,
    );
  }

  const port = Number.parseInt(source.PORT ?? '${context.settings.port}', 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const nodeEnvironment = source.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnvironment)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const trustProxyHops = Number.parseInt(source.TRUST_PROXY_HOPS ?? '0', 10);
  if (Number.isNaN(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 10) {
    throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 10');
  }

  const swaggerSetting = source.SWAGGER_ENABLED;
  if (swaggerSetting !== undefined && swaggerSetting !== 'true' && swaggerSetting !== 'false') {
    throw new Error('SWAGGER_ENABLED must be true or false');
  }

  return {
    NODE_ENV: nodeEnvironment as Environment['NODE_ENV'],
    PORT: port,
    SWAGGER_ENABLED: swaggerSetting === undefined ? nodeEnvironment !== 'production' : swaggerSetting === 'true',
    TRUST_PROXY_HOPS: trustProxyHops,
${assignments}
  };
}
`;
}

function dockerfile(context: TargetRenderContext): string {
  return `FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
USER node
EXPOSE ${context.settings.port}
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \\
  CMD ["node", "-e", "fetch('http://127.0.0.1:${context.settings.port}/${context.settings.apiPrefix}/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main"]
`;
}

function dockerCompose(context: TargetRenderContext): string {
  const project = context.ir.project.name;
  const port = context.settings.port;
  return `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-${project}}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: \${POSTGRES_DB:-${project}}
    ports:
      - '5432:5432'
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"']
      interval: 5s
      timeout: 5s
      retries: 10

  api:
    build: .
    depends_on:
      migrate:
        condition: service_completed_successfully
    env_file:
      - .env
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER:-${project}}:\${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}@postgres:5432/\${POSTGRES_DB:-${project}}?schema=public
    ports:
      - '${port}:${port}'
    init: true
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

  migrate:
    build:
      context: .
      target: builder
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - .env
    environment:
      DATABASE_URL: postgresql://\${POSTGRES_USER:-${project}}:\${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}@postgres:5432/\${POSTGRES_DB:-${project}}?schema=public
    command: npm run db:deploy
    restart: 'no'

volumes:
  postgres-data:
`;
}

function readme(context: TargetRenderContext): string {
  const { ir, settings } = context;
  const features = ir.features.map((feature) => `- \`${feature.name}\` v${feature.version}`).join("\n");
  const entities = ir.entities.map((entity) => `- \`${entity.name}\``).join("\n");
  const endpoints = ir.endpoints
    .map((endpoint) => `| \`${endpoint.method}\` | \`/${settings.apiPrefix}${endpoint.path}\` | ${endpoint.summary} | ${endpoint.auth === "public" ? "public" : endpoint.roles.length > 0 ? endpoint.roles.join(", ") : "authenticated"} |`)
    .join("\n");
  const customization = ir.customizationPoints
    .map((point) => `- \`${point.path}\` — implements \`${point.contract}\`. ${point.description}`)
    .join("\n");

  return `# ${ir.project.name}

${ir.project.description ?? "Generated by backendgen."}

This repository was generated by \`backendgen\` from a
\`backendcompiler.dev/v1\` specification. It builds, tests and runs independently
of the compiler.

## Requirements

- Node.js 22+
- Docker (for PostgreSQL), or an existing PostgreSQL 14+ database

## Quick start

\`\`\`bash
cp .env.example .env      # then fill in every secret
docker compose up -d postgres
npm install
npm run db:generate
npm run db:deploy
npm run start:dev
\`\`\`

The first \`npm install\` creates \`package-lock.json\`. Commit that lockfile and
use \`npm ci\` in automation to reproduce the complete tested dependency tree.

The API listens on port ${settings.port}. Set \`SWAGGER_ENABLED=true\` to serve
OpenAPI documentation at \`/${settings.apiPrefix}/docs\`. It is disabled by default
in \`.env.example\` and whenever \`NODE_ENV=production\`.

\`/${settings.apiPrefix}/health/live\` confirms the process is up;
\`/${settings.apiPrefix}/health/ready\` returns 503 while the database is
unreachable. Point orchestrator liveness probes at the former and readiness
probes (and load balancers) at the latter.

## Commands

| Command | Purpose |
|---|---|
| \`npm run build\` | Compile to \`dist/\` |
| \`npm test\` | Unit tests (no database required) |
| \`npm run test:integration\` | Integration tests (requires \`DATABASE_URL\`) |
| \`npm run db:generate\` | Regenerate the Prisma client |
| \`npm run db:deploy\` | Apply migrations |
| \`npm run db:validate\` | Validate the Prisma schema |

## Features

${features || "- none"}

## Entities

${entities || "- none"}

## Endpoints

| Method | Path | Summary | Access |
|---|---|---|---|
${endpoints || "| | | | |"}

${
    context.settings.client
      ? `## TypeScript client

\`client/\` holds a zero-dependency typed API client generated from the same
model as the server, so the two cannot drift. Build it with
\`npm run build:client\` and publish or vendor \`client/\` as
\`${ir.project.name}-client\`.

\`\`\`ts
import { createClient } from '${ir.project.name}-client';

const api = createClient({
  baseUrl: 'http://localhost:${settings.port}',
  getAccessToken: () => tokenStore.accessToken,
});
\`\`\`

Non-2xx responses throw \`ApiRequestError\` carrying the API's structured
error body.

`
      : ""
  }## Generated and custom code

\`src/generated/\` is owned by the compiler and is replaced on every generation.
\`src/custom/\` is yours; the compiler writes it once and never overwrites it.

${customization || "No customization points are declared by the selected features."}

Run \`backendgen generate --dry-run\` before regenerating to see exactly what
would change.

## Production security checklist

- Terminate TLS at a maintained reverse proxy or load balancer.
- Replace every placeholder secret and database password; never commit \`.env\`.
- Keep \`SWAGGER_ENABLED=false\` unless the documentation is intentionally public.
- Keep \`TRUST_PROXY_HOPS=0\` unless a known number of proxies sits in front of the API.
- CORS is disabled by default. If a browser client needs it, allowlist exact origins.
- The built-in auth rate limiter is process-local. Configure a shared throttler
  store before scaling to multiple API instances.
- The Compose file is a local/development baseline. Use a least-privilege database
  account, managed secrets, backups, network policy, and pinned images in production.
- If custom code changes authentication to cookies, add CSRF protection.

## Time zones

All timestamps are stored and returned in UTC. Clients must send ISO-8601
instants that include an offset (for example \`2025-01-01T10:00:00Z\`).
`;
}

export function projectFiles(context: TargetRenderContext): RenderedFile[] {
  const openApiTest = openApiE2e(context);
  return [
    generated("tsconfig.json", TSCONFIG),
    generated("tsconfig.build.json", TSCONFIG_BUILD),
    generated("nest-cli.json", NEST_CLI),
    generated("jest.config.json", JEST_UNIT),
    generated("jest-integration.config.json", JEST_INTEGRATION),
    generated(".gitignore", GITIGNORE),
    generated(".dockerignore", DOCKERIGNORE),
    generated("Dockerfile", dockerfile(context)),
    generated("docker-compose.yml", dockerCompose(context)),
    generated("README.md", readme(context)),
    generated("src/main.ts", mainFile(context)),
    generated("src/generated/common/bootstrap.ts", bootstrapHelper(context)),
    generated("src/generated/common/http-exception.filter.ts", EXCEPTION_FILTER),
    generated("src/generated/common/api-error.dto.ts", API_ERROR),
    generated("src/generated/common/pagination.ts", PAGINATION),
    generated("src/generated/common/public.decorator.ts", PUBLIC_DECORATOR),
    generated("src/generated/config/environment.ts", environmentFile(context)),
    generated("src/generated/prisma/prisma.service.ts", PRISMA_SERVICE),
    generated("src/generated/prisma/prisma.module.ts", PRISMA_MODULE),
    generated("src/generated/health/health.controller.ts", HEALTH_CONTROLLER),
    generated("src/generated/health/health.module.ts", HEALTH_MODULE),
    generated("test/health.e2e-spec.ts", healthE2e(context)),
    ...(openApiTest === null
      ? []
      : [generated("test/openapi.e2e-spec.ts", openApiTest)]),
    scaffold("src/custom/custom.module.ts", CUSTOM_MODULE),
    scaffold("src/custom/README.md", CUSTOM_README),
  ];
}
