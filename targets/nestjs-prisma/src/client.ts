import type { NormalizedEntity, NormalizedField } from "@backend-compiler/compiler";
import type { RenderedFile, TargetRenderContext } from "@backend-compiler/target-sdk";
import {
  foreignKeys,
  names,
  outputType,
  readableFields,
  writableFields,
  writableForeignKeys,
} from "./naming.js";

/**
 * Typed, zero-dependency API client emitted under `client/` in every generated
 * project. Server and client come from the same IR, so they cannot drift; the
 * generated `test/client.e2e-spec.ts` drives the real HTTP server through the
 * client to prove it.
 *
 * The client is deliberately lib-agnostic: it declares minimal structural
 * types for `fetch` instead of depending on the DOM lib, so it compiles under
 * the generated server's tsconfig (for ts-jest) and under its own.
 */

function generated(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

function inputFieldType(entity: NormalizedEntity, field: NormalizedField): string {
  if (field.enumValues && field.enumValues.length > 0) {
    return field.enumValues.map((value) => `'${value}'`).join(" | ");
  }
  switch (field.type) {
    case "integer":
    case "decimal":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

function responseFieldType(entity: NormalizedEntity, field: NormalizedField): string {
  if (field.enumValues && field.enumValues.length > 0) {
    return field.enumValues.map((value) => `'${value}'`).join(" | ");
  }
  return outputType(entity, field);
}

/** Mirrors the crud renderer's sortable-field rule (createdAt/updatedAt + non-text readables). */
function sortableFields(entity: NormalizedEntity): string[] {
  return [
    "createdAt",
    "updatedAt",
    ...readableFields(entity)
      .filter((field) => field.type !== "text")
      .map((field) => field.name),
  ].sort();
}

function filterableFields(entity: NormalizedEntity): NormalizedField[] {
  return writableFields(entity).filter(
    (field) =>
      ["string", "uuid", "boolean", "integer"].includes(field.type) || field.enumValues !== null,
  );
}

function hasSearch(entity: NormalizedEntity): boolean {
  return readableFields(entity).some(
    (field) => (field.type === "string" || field.type === "text") && field.enumValues === null,
  );
}

function clientSample(field: NormalizedField): string {
  if (field.enumValues !== null && field.enumValues.length > 0) {
    return JSON.stringify(field.enumValues[0]);
  }
  switch (field.type) {
    case "boolean":
      return "false";
    case "integer":
    case "decimal":
      return String(Math.max(1, field.constraints.minimum ?? 1));
    case "date":
      return JSON.stringify("2030-01-01");
    case "datetime":
      return JSON.stringify("2030-01-01T10:00:00.000Z");
    case "uuid":
      return JSON.stringify("00000000-0000-4000-8000-000000000001");
    default: {
      const minimum = Math.max(1, field.constraints.minLength ?? 1);
      const maximum = field.constraints.maxLength ?? 64;
      const length = Math.min(maximum, Math.max(minimum, 18));
      return JSON.stringify("x".repeat(length));
    }
  }
}

function entityTypes(entity: NormalizedEntity): string {
  const model = names.model(entity.name);
  const response: string[] = [
    "  id: string;",
    "  createdAt: string;",
    "  updatedAt: string;",
  ];
  if (entity.softDelete) {
    response.push("  deletedAt: string | null;");
  }
  for (const field of readableFields(entity)) {
    response.push(
      `  ${field.name}: ${responseFieldType(entity, field)}${field.required ? "" : " | null"};`,
    );
  }
  for (const key of foreignKeys(entity)) {
    response.push(`  ${key.name}: string${key.required ? "" : " | null"};`);
  }

  const create: string[] = [];
  for (const field of writableFields(entity)) {
    const optional = !field.required || field.defaultValue !== null;
    create.push(`  ${field.name}${optional ? "?" : ""}: ${inputFieldType(entity, field)};`);
  }
  for (const key of writableForeignKeys(entity)) {
    create.push(`  ${key.name}${key.required ? "" : "?"}: string;`);
  }

  const query: string[] = [
    "  page?: number;",
    "  pageSize?: number;",
    "  order?: 'asc' | 'desc';",
    `  sort?: ${sortableFields(entity)
      .map((field) => `'${field}'`)
      .join(" | ")};`,
  ];
  if (hasSearch(entity)) {
    query.push("  q?: string;");
  }
  for (const field of filterableFields(entity)) {
    query.push(`  ${field.name}?: ${inputFieldType(entity, field)};`);
  }
  for (const key of writableForeignKeys(entity)) {
    query.push(`  ${key.name}?: string;`);
  }

  return `export interface ${model}Response {
${response.join("\n")}
}

export interface Create${model}Input {
${create.join("\n")}
}

export type Update${model}Input = Partial<Create${model}Input>;

export interface Query${model}Params {
${query.join("\n")}
}
`;
}

function authTypes(user: NormalizedEntity): string {
  const account: string[] = ["  id: string;"];
  for (const field of readableFields(user)) {
    account.push(
      `  ${field.name}: ${responseFieldType(user, field)}${field.required ? "" : " | null"};`,
    );
  }

  const register: string[] = ["  email: string;", "  password: string;"];
  for (const field of writableFields(user)) {
    if (field.name === "email") continue;
    const optional = !field.required || field.defaultValue !== null;
    register.push(`  ${field.name}${optional ? "?" : ""}: ${inputFieldType(user, field)};`);
  }

  return `export interface AccountResponse {
${account.join("\n")}
}

export interface RegisterInput {
${register.join("\n")}
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthSession extends TokenPair {
  user: AccountResponse;
}
`;
}

const RESERVATION_TYPES = (tenant: boolean): string => `export interface ReservationResponse {
  id: string;
  resourceId: string;
  ownerId: string;${tenant ? "\n  organizationId: string;" : ""}
  startsAt: string;
  endsAt: string;
  status: 'HELD' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
  holdExpiresAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

export interface CreateReservationInput {
  resourceId: string;
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityParams {
  resourceId: string;
  startsAt: string;
  endsAt: string;
}

export interface AvailabilityResponse {
  available: boolean;
  conflicts: number;
}

export interface QueryReservationParams {
  page?: number;
  pageSize?: number;
  order?: 'asc' | 'desc';
  status?: ReservationResponse['status'];
  resourceId?: string;
}
`;

const ORGANIZATION_TYPES = `export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface MemberResponse {
  userId: string;
  organizationId: string;
  role: string;
  createdAt: string;
}
`;

const CORE_TYPES = `/** Pagination envelope every list endpoint returns. */
export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Page<T> {
  data: T[];
  meta: PageMeta;
}

/** The single error shape every endpoint returns. */
export interface ApiError {
  statusCode: number;
  code: string;
  message: string[];
  path: string;
  timestamp: string;
}
`;

function typesFile(context: TargetRenderContext): string {
  const sections: string[] = [
    "// Generated by backendgen. Do not edit; run `backendgen generate` instead.",
    "",
    CORE_TYPES,
  ];

  const entities = context.crudEntities();
  for (const entity of entities) {
    sections.push(entityTypes(entity));
  }

  if (context.hasFeature("auth")) {
    const auth = context.featureConfig("auth") as { userEntity?: string };
    sections.push(authTypes(context.entity(auth.userEntity ?? "User")));
  }
  if (context.hasFeature("organizations")) {
    sections.push(ORGANIZATION_TYPES);
  }
  if (context.hasFeature("reservations")) {
    const reservations = context.featureConfig("reservations") as { entity?: string };
    const reservation = context.entity(reservations.entity ?? "Reservation");
    sections.push(RESERVATION_TYPES(reservation.tenant !== null));
  }

  return `${sections.join("\n")}`;
}

function entityResource(entity: NormalizedEntity, prefix: string): string {
  const model = names.model(entity.name);
  const route = names.route(entity.name);
  const property = names.variable(route.replace(/-/g, "_"));

  return `    ${property}: {
      list: (params?: Query${model}Params): Promise<Page<${model}Response>> =>
        request(options, 'GET', '/${prefix}/${route}', { query: params }),
      get: (id: string): Promise<${model}Response> =>
        request(options, 'GET', '/${prefix}/${route}/' + encodeURIComponent(id), {}),
      create: (input: Create${model}Input): Promise<${model}Response> =>
        request(options, 'POST', '/${prefix}/${route}', { body: input }),
      update: (id: string, input: Update${model}Input): Promise<${model}Response> =>
        request(options, 'PATCH', '/${prefix}/${route}/' + encodeURIComponent(id), { body: input }),
      delete: (id: string): Promise<void> =>
        request(options, 'DELETE', '/${prefix}/${route}/' + encodeURIComponent(id), {}),
    },`;
}

function entityResourceType(entity: NormalizedEntity): string {
  const model = names.model(entity.name);
  const route = names.route(entity.name);
  const property = names.variable(route.replace(/-/g, "_"));

  return `  ${property}: {
    list(params?: Query${model}Params): Promise<Page<${model}Response>>;
    get(id: string): Promise<${model}Response>;
    create(input: Create${model}Input): Promise<${model}Response>;
    update(id: string, input: Update${model}Input): Promise<${model}Response>;
    delete(id: string): Promise<void>;
  };`;
}

function indexFile(context: TargetRenderContext): string {
  const prefix = context.settings.apiPrefix;
  const entities = context.crudEntities();
  const auth = context.hasFeature("auth");
  const organizations = context.hasFeature("organizations");
  const reservations = context.hasFeature("reservations");
  const reservationConfirm = context.ir.endpoints.some(
    (endpoint) => endpoint.feature === "reservations" && endpoint.operation === "confirm",
  );

  const typeImports = new Set<string>(["Page", "ApiError"]);
  for (const entity of entities) {
    const model = names.model(entity.name);
    typeImports.add(`${model}Response`);
    typeImports.add(`Create${model}Input`);
    typeImports.add(`Update${model}Input`);
    typeImports.add(`Query${model}Params`);
  }
  if (auth) {
    ["AccountResponse", "RegisterInput", "TokenPair", "AuthSession"].forEach((name) =>
      typeImports.add(name),
    );
  }
  if (organizations) {
    ["OrganizationResponse", "MemberResponse"].forEach((name) => typeImports.add(name));
  }
  if (reservations) {
    [
      "ReservationResponse",
      "CreateReservationInput",
      "AvailabilityParams",
      "AvailabilityResponse",
      "QueryReservationParams",
    ].forEach((name) => typeImports.add(name));
  }

  const authMembers = auth
    ? `    auth: {
      register: (input: RegisterInput): Promise<AuthSession> =>
        request(options, 'POST', '/${prefix}/auth/register', { body: input }),
      login: (email: string, password: string): Promise<AuthSession> =>
        request(options, 'POST', '/${prefix}/auth/login', { body: { email, password } }),
      refresh: (refreshToken: string): Promise<TokenPair> =>
        request(options, 'POST', '/${prefix}/auth/refresh', { body: { refreshToken } }),
      logout: (refreshToken: string): Promise<void> =>
        request(options, 'POST', '/${prefix}/auth/logout', { body: { refreshToken } }),
      me: (): Promise<AccountResponse> => request(options, 'GET', '/${prefix}/auth/me', {}),
    },
`
    : "";

  const organizationMembers = organizations
    ? `    organizations: {
      create: (name: string): Promise<OrganizationResponse> =>
        request(options, 'POST', '/${prefix}/organizations', { body: { name } }),
      list: (): Promise<OrganizationResponse[]> =>
        request(options, 'GET', '/${prefix}/organizations', {}),
      get: (id: string): Promise<OrganizationResponse> =>
        request(options, 'GET', '/${prefix}/organizations/' + encodeURIComponent(id), {}),
      members: (id: string): Promise<MemberResponse[]> =>
        request(options, 'GET', '/${prefix}/organizations/' + encodeURIComponent(id) + '/members', {}),
      addMember: (id: string, email: string, role?: string): Promise<MemberResponse> =>
        request(options, 'POST', '/${prefix}/organizations/' + encodeURIComponent(id) + '/members', {
          body: role === undefined ? { email } : { email, role },
        }),
    },
    /** A copy of this client scoped to one organization via X-Organization-Id. */
    withOrganization: (organizationId: string): ApiClient =>
      createClient({ ...options, organizationId }),
`
    : "";

  const reservationMembers = reservations
    ? `    reservations: {
      availability: (params: AvailabilityParams): Promise<AvailabilityResponse> =>
        request(options, 'GET', '/${prefix}/reservations/availability', { query: params }),
      create: (
        input: CreateReservationInput,
        extra: { idempotencyKey?: string } = {},
      ): Promise<ReservationResponse> =>
        request(options, 'POST', '/${prefix}/reservations', {
          body: input,
          headers:
            extra.idempotencyKey === undefined
              ? {}
              : { 'idempotency-key': extra.idempotencyKey },
        }),
      list: (params?: QueryReservationParams): Promise<Page<ReservationResponse>> =>
        request(options, 'GET', '/${prefix}/reservations', { query: params }),
      get: (id: string): Promise<ReservationResponse> =>
        request(options, 'GET', '/${prefix}/reservations/' + encodeURIComponent(id), {}),${
          reservationConfirm
            ? `
      confirm: (id: string): Promise<ReservationResponse> =>
        request(options, 'POST', '/${prefix}/reservations/' + encodeURIComponent(id) + '/confirm', {}),`
            : ""
        }
      cancel: (id: string): Promise<ReservationResponse> =>
        request(options, 'POST', '/${prefix}/reservations/' + encodeURIComponent(id) + '/cancel', {}),
    },
`
    : "";

  const authType = auth
    ? `  auth: {
    register(input: RegisterInput): Promise<AuthSession>;
    login(email: string, password: string): Promise<AuthSession>;
    refresh(refreshToken: string): Promise<TokenPair>;
    logout(refreshToken: string): Promise<void>;
    me(): Promise<AccountResponse>;
  };`
    : "";
  const organizationType = organizations
    ? `  organizations: {
    create(name: string): Promise<OrganizationResponse>;
    list(): Promise<OrganizationResponse[]>;
    get(id: string): Promise<OrganizationResponse>;
    members(id: string): Promise<MemberResponse[]>;
    addMember(id: string, email: string, role?: string): Promise<MemberResponse>;
  };
  withOrganization(organizationId: string): ApiClient;`
    : "";
  const reservationType = reservations
    ? `  reservations: {
    availability(params: AvailabilityParams): Promise<AvailabilityResponse>;
    create(
      input: CreateReservationInput,
      extra?: { idempotencyKey?: string },
    ): Promise<ReservationResponse>;
    list(params?: QueryReservationParams): Promise<Page<ReservationResponse>>;
    get(id: string): Promise<ReservationResponse>;${
      reservationConfirm ? "\n    confirm(id: string): Promise<ReservationResponse>;" : ""
    }
    cancel(id: string): Promise<ReservationResponse>;
  };`
    : "";

  return `// Generated by backendgen. Do not edit; run \`backendgen generate\` instead.
import type {
  ${[...typeImports].sort().join(",\n  ")},
} from './types';

export * from './types';

/**
 * Minimal structural fetch types so this file compiles without the DOM lib,
 * in browsers, and on Node 18+ alike.
 */
interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

export interface ClientOptions {
  /** Origin of the API, e.g. \`http://localhost:3000\` — without the /${prefix} prefix. */
  baseUrl: string;
  /** Custom fetch implementation; defaults to the global one. */
  fetch?: FetchLike;
  /** Called before every request; return the current access token, if any. */
  getAccessToken?: () => string | null | undefined;
  /** Organization to act in; sent as X-Organization-Id on every request. */
  organizationId?: string;
}

/** A non-2xx response, carrying the API's structured error body when present. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError | null,
  ) {
    super(
      error === null
        ? 'Request failed with status ' + String(status)
        : error.message.join('; '),
    );
    this.name = 'ApiRequestError';
  }
}

type QueryValues = object | undefined;

async function request<T>(
  options: ClientOptions,
  method: string,
  path: string,
  init: {
    body?: unknown;
    query?: QueryValues;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const fetchImplementation =
    options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (fetchImplementation === undefined) {
    throw new Error('No fetch implementation available; pass one in ClientOptions.fetch');
  }

  const parameters: string[] = [];
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) {
      parameters.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    }
  }
  const url =
    options.baseUrl.replace(/\\/$/, '') +
    path +
    (parameters.length > 0 ? '?' + parameters.join('&') : '');

  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const token = options.getAccessToken?.();
  if (token !== null && token !== undefined && token !== '') {
    headers.authorization = 'Bearer ' + token;
  }
  if (options.organizationId !== undefined) {
    headers['x-organization-id'] = options.organizationId;
  }

  const response = await fetchImplementation(url, {
    method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(response.status, body);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export interface ApiClient {
${[
    ...entities.map(entityResourceType),
    ...(authType ? [authType] : []),
    ...(organizationType ? [organizationType] : []),
    ...(reservationType ? [reservationType] : []),
  ].join("\n")}
}

export function createClient(options: ClientOptions): ApiClient {
  return {
${entities.map((entity) => entityResource(entity, prefix)).join("\n")}
${authMembers}${organizationMembers}${reservationMembers}  };
}
`;
}

function clientPackageJson(context: TargetRenderContext): string {
  return `${JSON.stringify(
    {
      name: `${context.ir.project.name}-client`,
      version: "0.1.0",
      description: `Typed API client for ${context.ir.project.name}, generated by backendgen`,
      license: "UNLICENSED",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      files: ["dist"],
      scripts: { build: "tsc -p tsconfig.json" },
    },
    null,
    2,
  )}\n`;
}

const CLIENT_TSCONFIG = `{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUnusedLocals": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`;

function clientE2e(
  context: TargetRenderContext,
  first: NormalizedEntity,
): string | null {
  if (!context.hasFeature("auth")) return null;

  const model = names.model(first.name);
  const property = names.variable(names.route(first.name).replace(/-/g, "_"));
  const tenantScoped = first.tenant !== null && context.hasFeature("organizations");
  const deleteRole =
    !tenantScoped && first.ownership === null
      ? context.ir.endpoints.find((endpoint) => endpoint.id === `${first.name}.delete`)?.roles[0]
      : undefined;
  const authConfig = context.featureConfig("auth") as { userEntity?: string };
  const authUser = context.entity(authConfig.userEntity ?? "User");
  const authUserDelegate = names.delegate(authUser.name);
  const prefix = context.settings.apiPrefix;

  return `import { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/generated/common/bootstrap';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { resetDatabase } from './utils/reset';
import {
  createClient,
  ApiRequestError,
  type ApiClient,
  type Create${model}Input,
  type RegisterInput,
} from '../client/src';

/**
 * Drives the real HTTP server through the generated typed client. Client and
 * server are generated from the same IR; this suite is the executable proof
 * that they agree.
 */
describe('Generated client (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = 'http://127.0.0.1:' + String(address.port);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('registers, authenticates and walks a full CRUD cycle through the client', async () => {
    let accessToken: string | null = null;
    let client: ApiClient = createClient({ baseUrl, getAccessToken: () => accessToken });

    const email = 'client-' + Date.now().toString(36) + '@example.test';
    const registration = {
      email,
      password: 'client-password-with-plenty-of-length',
${context
    .entity((context.featureConfig("auth") as { userEntity?: string }).userEntity ?? "User")
    .fields.filter(
      (field) =>
        field.required &&
        field.defaultValue === null &&
        !field.internal &&
        !field.readOnly &&
        field.name !== "email",
    )
    .map((field) => `      ${field.name}: ${clientSample(field)},`)
    .join("\n")}
    } satisfies RegisterInput;
    const session = await client.auth.register(registration);
${deleteRole === undefined ? "" : `    // Self-registration intentionally receives the least-privileged role. Elevate
    // this test account only because the generated DELETE route requires it.
    await prisma.${authUserDelegate}.update({
      where: { id: session.user.id },
      data: { role: ${JSON.stringify(deleteRole)} },
    });
`}
    accessToken = session.accessToken;

    const me = await client.auth.me();
    expect(me.email).toBe(email);
${
    tenantScoped
      ? `
    const organization = await client.organizations.create('Client Org');
    client = client.withOrganization(organization.id);
`
      : ""
  }
    const payload = {
${writableFields(first)
  .filter((field) => field.required && field.defaultValue === null)
  .map((field) => `      ${field.name}: ${clientSample(field)},`)
  .join("\n")}
    } satisfies Create${model}Input;
    const created = await client.${property}.create(payload);
    expect(created.id).toBeDefined();

    const listed = await client.${property}.list({ page: 1, pageSize: 10, sort: 'createdAt' });
    expect(listed.meta.total).toBe(1);
    expect(listed.data[0]?.id).toBe(created.id);

    const fetched = await client.${property}.get(created.id);
    expect(fetched.id).toBe(created.id);

    await client.${property}.delete(created.id);

    await expect(client.${property}.get(created.id)).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 404,
    });

    const rotated = await client.auth.refresh(session.refreshToken);
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    await expect(client.auth.refresh(session.refreshToken)).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });
});
`;
}

export function clientFiles(context: TargetRenderContext): RenderedFile[] {
  if (!context.settings.client) return [];

  const files: RenderedFile[] = [
    generated("client/src/types.ts", typesFile(context)),
    generated("client/src/index.ts", indexFile(context)),
    generated("client/package.json", clientPackageJson(context)),
    generated("client/tsconfig.json", CLIENT_TSCONFIG),
  ];

  // Use any self-contained CRUD entity; declaration order should not suppress
  // a valid executable client/server compatibility proof.
  const selfContained = context
    .crudEntities()
    .find((entity) => writableForeignKeys(entity).every((key) => !key.required));
  const e2e = selfContained ? clientE2e(context, selfContained) : null;
  if (e2e !== null) {
    files.push(generated("test/client.e2e-spec.ts", e2e));
  }

  return files;
}
