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
    "strictNullChecks": true,
    "noImplicitAny": true,
    "strictBindCallApply": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  },
  "exclude": ["node_modules", "dist"]
}
`;

const TSCONFIG_BUILD = `{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
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
      default:
        return 'ERROR';
    }
  }
}
`;

const PAGINATION = `import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 1000000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
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

const HEALTH_CONTROLLER = `import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOkResponse({ description: 'Liveness and database readiness' })
  async check(): Promise<{ status: string; database: string }> {
    try {
      await this.prisma.$queryRaw\`SELECT 1\`;
      return { status: 'ok', database: 'up' };
    } catch {
      return { status: 'degraded', database: 'down' };
    }
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
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('${context.ir.project.name}')
    .setDescription(${JSON.stringify(context.ir.project.description ?? "Generated by backendgen")})
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  SwaggerModule.setup('${settings.apiPrefix}/docs', app, SwaggerModule.createDocument(app, config));
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

This repository was generated by [backendgen](https://github.com/) from a
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

The API listens on port ${settings.port}. Set \`SWAGGER_ENABLED=true\` to serve
OpenAPI documentation at \`/${settings.apiPrefix}/docs\`. It is disabled by default
in \`.env.example\` and whenever \`NODE_ENV=production\`. The
\`/${settings.apiPrefix}/health\` endpoint reports database readiness.

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

## Generated and custom code

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
    scaffold("src/custom/custom.module.ts", CUSTOM_MODULE),
    scaffold("src/custom/README.md", CUSTOM_README),
  ];
}
