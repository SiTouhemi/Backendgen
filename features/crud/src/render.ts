import type { NormalizedEntity, NormalizedField } from "@backend-compiler/compiler";
import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import {
  enumFields,
  foreignKeys,
  names,
  outputType,
  readableFields,
  validationDecorators,
  writableFields,
  writableForeignKeys,
} from "@backend-compiler/target-nestjs-prisma";
import { sampleExpression } from "./samples.js";

interface CrudSettings {
  adminRoles: string[];
  defaultPageSize: number;
  maxPageSize: number;
}

function settings(context: TargetRenderContext): CrudSettings {
  const config = context.config as Partial<CrudSettings>;
  return {
    adminRoles: config.adminRoles ?? ["admin"],
    defaultPageSize: config.defaultPageSize ?? 20,
    maxPageSize: config.maxPageSize ?? 100,
  };
}

function file(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

function importLine(symbols: readonly string[], from: string): string {
  return symbols.length > 0 ? `import { ${[...symbols].sort().join(", ")} } from '${from}';\n` : "";
}

/** Fields a client may filter on: closed-value scalars only. */
function filterableFields(entity: NormalizedEntity): NormalizedField[] {
  return writableFields(entity).filter((field) =>
    ["string", "uuid", "boolean", "integer"].includes(field.type) || field.enumValues !== null,
  );
}

function searchableFields(entity: NormalizedEntity): NormalizedField[] {
  return readableFields(entity).filter(
    (field) => (field.type === "string" || field.type === "text") && field.enumValues === null,
  );
}

function sortableFields(entity: NormalizedEntity): string[] {
  return [
    "createdAt",
    "updatedAt",
    ...readableFields(entity)
      .filter((field) => field.type !== "text")
      .map((field) => field.name),
  ].sort();
}

/** Expression converting a DTO value into the value Prisma stores. */
function toPrismaValue(field: NormalizedField, source: string): string {
  return field.type === "datetime" || field.type === "date"
    ? `new Date(${source})`
    : source;
}

/** Expression converting a Prisma model value into the value the API returns. */
function toResponseValue(field: NormalizedField): string {
  const access = `model.${field.name}`;
  const convert = (value: string): string => {
    switch (field.type) {
      case "decimal":
        return `${value}.toString()`;
      case "datetime":
      case "date":
        return `${value}.toISOString()`;
      default:
        return value;
    }
  };

  if (field.type !== "decimal" && field.type !== "datetime" && field.type !== "date") {
    return access;
  }

  return field.required ? convert(access) : `${access} === null ? null : ${convert(access)}`;
}

function enumImports(entity: NormalizedEntity): string[] {
  return enumFields(entity).map(({ typeName }) => typeName);
}

function createDto(entity: NormalizedEntity): string {
  const fields = writableFields(entity);
  const validators = new Set<string>();
  const transformers = new Set<string>();
  const swagger = new Set<string>();
  const body: string[] = [];

  for (const field of fields) {
    const optional = !field.required || field.defaultValue !== null;
    const validation = validationDecorators(entity, field, { optional });
    validation.validatorImports.forEach((symbol) => validators.add(symbol));
    validation.transformerImports.forEach((symbol) => transformers.add(symbol));
    validation.swaggerImports.forEach((symbol) => swagger.add(symbol));

    body.push(
      ...validation.decorators.map((decorator) => `  ${decorator}`),
      `  ${field.name}${optional ? "?" : "!"}: ${validation.type};`,
      "",
    );
  }

  for (const key of writableForeignKeys(entity)) {
    swagger.add(key.required ? "ApiProperty" : "ApiPropertyOptional");
    validators.add("IsString");
    validators.add("MaxLength");
    if (!key.required) validators.add("IsOptional");

    body.push(
      `  @${key.required ? "ApiProperty" : "ApiPropertyOptional"}({ description: 'Identifier of the related ${key.target}' })`,
      ...(key.required ? [] : ["  @IsOptional()"]),
      "  @IsString()",
      "  @MaxLength(128)",
      `  ${key.name}${key.required ? "!" : "?"}: string;`,
      "",
    );
  }

  const enums = enumImports(entity);
  return (
    importLine([...swagger], "@nestjs/swagger") +
    importLine([...transformers], "class-transformer") +
    importLine([...validators], "class-validator") +
    importLine(enums, "@prisma/client") +
    `\nexport class Create${names.model(entity.name)}Dto {\n` +
    body.join("\n").trimEnd() +
    "\n}\n"
  );
}

function updateDto(entity: NormalizedEntity): string {
  const model = names.model(entity.name);
  return `import { PartialType } from '@nestjs/swagger';
import { Create${model}Dto } from './create-${names.file(entity.name)}.dto';

/** Every field of the create DTO, all optional, with the same validation rules. */
export class Update${model}Dto extends PartialType(Create${model}Dto) {}
`;
}

function queryDto(entity: NormalizedEntity, crud: CrudSettings): string {
  const model = names.model(entity.name);
  const validators = new Set<string>(["IsIn", "IsOptional"]);
  const transformers = new Set<string>();
  const swagger = new Set<string>(["ApiPropertyOptional"]);
  const body: string[] = [];

  const sortable = sortableFields(entity);
  body.push(
    `  @ApiPropertyOptional({ enum: ${JSON.stringify(sortable)}, default: 'createdAt' })`,
    "  @IsOptional()",
    `  @IsIn(${JSON.stringify(sortable)})`,
    "  sort: string = 'createdAt';",
    "",
  );

  if (searchableFields(entity).length > 0) {
    validators.add("IsString");
    validators.add("MaxLength");
    body.push(
      "  @ApiPropertyOptional({ description: 'Case-insensitive substring search across text fields' })",
      "  @IsOptional()",
      "  @IsString()",
      "  @MaxLength(200)",
      "  q?: string;",
      "",
    );
  }

  for (const field of filterableFields(entity)) {
    const validation = validationDecorators(entity, field, { optional: true, coerce: true });
    validation.validatorImports.forEach((symbol) => validators.add(symbol));
    validation.transformerImports.forEach((symbol) => transformers.add(symbol));
    validation.swaggerImports.forEach((symbol) => swagger.add(symbol));

    if (field.type === "boolean") {
      transformers.add("Transform");
      body.push(
        "  @ApiPropertyOptional()",
        "  @IsOptional()",
        "  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)",
        "  @IsBoolean()",
        `  ${field.name}?: boolean;`,
        "",
      );
      continue;
    }

    body.push(
      ...validation.decorators.map((decorator) => `  ${decorator}`),
      `  ${field.name}?: ${validation.type};`,
      "",
    );
  }

  for (const key of writableForeignKeys(entity)) {
    validators.add("IsString");
    validators.add("MaxLength");
    body.push(
      `  @ApiPropertyOptional({ description: 'Filter by related ${key.target}' })`,
      "  @IsOptional()",
      "  @IsString()",
      "  @MaxLength(128)",
      `  ${key.name}?: string;`,
      "",
    );
  }

  const enums = enumImports(entity);
  return (
    importLine([...swagger], "@nestjs/swagger") +
    importLine([...transformers], "class-transformer") +
    importLine([...validators], "class-validator") +
    importLine(enums, "@prisma/client") +
    "import { PaginationQueryDto } from '../../common/pagination';\n" +
    `\n/** Pagination defaults: page size ${crud.defaultPageSize}, maximum ${crud.maxPageSize}. */\n` +
    `export class Query${model}Dto extends PaginationQueryDto {\n` +
    body.join("\n").trimEnd() +
    "\n}\n"
  );
}

function responseDto(entity: NormalizedEntity): string {
  const model = names.model(entity.name);
  const fields = readableFields(entity);
  const keys = foreignKeys(entity);
  const properties: string[] = [
    "  @ApiProperty()",
    "  id!: string;",
    "",
    "  @ApiProperty({ format: 'date-time' })",
    "  createdAt!: string;",
    "",
    "  @ApiProperty({ format: 'date-time' })",
    "  updatedAt!: string;",
    "",
  ];
  const mappings: string[] = [
    "    id: model.id,",
    "    createdAt: model.createdAt.toISOString(),",
    "    updatedAt: model.updatedAt.toISOString(),",
  ];

  if (entity.softDelete) {
    properties.push(
      "  @ApiPropertyOptional({ format: 'date-time', nullable: true })",
      "  deletedAt!: string | null;",
      "",
    );
    mappings.push("    deletedAt: model.deletedAt === null ? null : model.deletedAt.toISOString(),");
  }

  for (const field of fields) {
    const type = outputType(entity, field);
    const decorator = field.required ? "ApiProperty" : "ApiPropertyOptional";
    const options: string[] = [];
    if (field.enumValues) options.push(`enum: ${names.enumType(entity.name, field.name)}`);
    if (field.type === "datetime" || field.type === "date") options.push("format: 'date-time'");
    if (!field.required) options.push("nullable: true");

    properties.push(
      `  @${decorator}(${options.length > 0 ? `{ ${options.join(", ")} }` : ""})`,
      `  ${field.name}!: ${type}${field.required ? "" : " | null"};`,
      "",
    );
    mappings.push(`    ${field.name}: ${toResponseValue(field)},`);
  }

  for (const key of keys) {
    properties.push(
      `  @${key.required ? "ApiProperty" : "ApiPropertyOptional"}(${key.required ? "" : "{ nullable: true }"})`,
      `  ${key.name}!: string${key.required ? "" : " | null"};`,
      "",
    );
    mappings.push(`    ${key.name}: model.${key.name},`);
  }

  const enums = enumImports(entity);
  return (
    "import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';\n" +
    importLine(enums, "@prisma/client") +
    `import type { ${names.model(entity.name)} } from '@prisma/client';\n` +
    `\nexport class ${model}ResponseDto {\n` +
    properties.join("\n").trimEnd() +
    "\n}\n\n" +
    `export function to${model}Response(model: ${model}): ${model}ResponseDto {\n` +
    "  return {\n" +
    mappings.join("\n") +
    "\n  };\n}\n"
  );
}

function serviceFile(entity: NormalizedEntity, context: TargetRenderContext): string {
  const crud = settings(context);
  const model = names.model(entity.name);
  const stem = names.file(entity.name);
  const delegate = names.delegate(entity.name);
  const writable = writableFields(entity);
  const requiredFields = writable.filter((field) => field.required && field.defaultValue === null);
  const optionalFields = writable.filter((field) => !requiredFields.includes(field));
  const requiredKeys = writableForeignKeys(entity).filter((key) => key.required);
  const optionalKeys = writableForeignKeys(entity).filter((key) => !key.required);
  const protectedRelations = writableForeignKeys(entity)
    .map((key) => ({ key, target: context.entity(key.target) }))
    .filter(({ target }) => target.softDelete || target.tenant !== null || target.ownership !== null);

  const scopeImports = new Set<string>(["RequestScope"]);
  if (entity.ownership) {
    scopeImports.add("isAdmin");
    scopeImports.add("requireUser");
  }
  if (entity.tenant) {
    scopeImports.add("requireOrganization");
  }
  for (const { target } of protectedRelations) {
    if (target.tenant) scopeImports.add("requireOrganization");
    if (target.ownership) {
      scopeImports.add("isAdmin");
      scopeImports.add("requireUser");
    }
  }

  const createData = [
    ...requiredFields.map((field) => `      ${field.name}: ${toPrismaValue(field, `dto.${field.name}`)},`),
    ...requiredKeys.map((key) => `      ${key.name}: dto.${key.name},`),
    ...optionalFields.map(
      (field) =>
        `      ...(dto.${field.name} !== undefined ? { ${field.name}: ${toPrismaValue(field, `dto.${field.name}`)} } : {}),`,
    ),
    ...optionalKeys.map(
      (key) => `      ...(dto.${key.name} !== undefined ? { ${key.name}: dto.${key.name} } : {}),`,
    ),
  ];

  if (entity.ownership) {
    createData.push(`      ${entity.ownership.foreignKey}: requireUser(scope),`);
  }
  if (entity.tenant) {
    createData.push(`      ${entity.tenant.foreignKey}: requireOrganization(scope),`);
  }

  const updateData = [...writable, ...[]].map(
    (field) =>
      `    if (dto.${field.name} !== undefined) data.${field.name} = ${toPrismaValue(field, `dto.${field.name}`)};`,
  );
  for (const key of writableForeignKeys(entity)) {
    updateData.push(`    if (dto.${key.name} !== undefined) data.${key.name} = dto.${key.name};`);
  }

  const filterLines = filterableFields(entity).map(
    (field) => `    if (query.${field.name} !== undefined) where.${field.name} = query.${field.name};`,
  );
  for (const key of writableForeignKeys(entity)) {
    filterLines.push(`    if (query.${key.name} !== undefined) where.${key.name} = query.${key.name};`);
  }

  const searchable = searchableFields(entity);
  const searchBlock =
    searchable.length > 0
      ? `
    if (query.q !== undefined && query.q !== '') {
      where.OR = [
${searchable.map((field) => `        { ${field.name}: { contains: query.q, mode: 'insensitive' } },`).join("\n")}
      ];
    }
`
      : "";

  const scopeClauses: string[] = [];
  if (entity.softDelete) {
    scopeClauses.push("    clauses.push({ deletedAt: null });");
  }
  if (entity.tenant) {
    scopeClauses.push(
      `    clauses.push({ ${entity.tenant.foreignKey}: requireOrganization(scope) });`,
    );
  }
  if (entity.ownership) {
    scopeClauses.push(
      `    if (!isAdmin(scope, ADMIN_ROLES)) {`,
      `      clauses.push({ ${entity.ownership.foreignKey}: requireUser(scope) });`,
      `    }`,
    );
  }

  const orderCases = sortableFields(entity)
    .filter((field) => field !== "createdAt")
    .map((field) => `      case '${field}':\n        return { ${field}: query.order };`)
    .join("\n");

  const removeBody = entity.softDelete
    ? `    const result = await this.prisma.${delegate}.updateMany({
      where: this.scopedWhere({ id }, scope),
      data: { deletedAt: new Date() },
    });`
    : `    const result = await this.prisma.${delegate}.deleteMany({
      where: this.scopedWhere({ id }, scope),
    });`;

  const relationChecks = protectedRelations
    .map(({ key, target }) => {
      const clauses = [`          id: dto.${key.name},`];
      if (target.softDelete) clauses.push("          deletedAt: null,");
      if (target.tenant) {
        clauses.push(`          ${target.tenant.foreignKey}: requireOrganization(scope),`);
      }
      if (target.ownership) {
        clauses.push(
          `          ...(isAdmin(scope, ADMIN_ROLES) ? {} : { ${target.ownership.foreignKey}: requireUser(scope) }),`,
        );
      }
      return `    if (dto.${key.name} !== undefined) {
      const related = await this.prisma.${names.delegate(target.name)}.findFirst({
        where: {
${clauses.join("\n")}
        },
        select: { id: true },
      });
      if (related === null) {
        throw new BadRequestException('Invalid related ${key.target}');
      }
    }`;
    })
    .join("\n");

  return `import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Page, toPage } from '../common/pagination';
${importLine([...scopeImports], "../common/scope")}import { PrismaService } from '../prisma/prisma.service';
import { Create${model}Dto } from './dto/create-${stem}.dto';
import { Query${model}Dto } from './dto/query-${stem}.dto';
import { Update${model}Dto } from './dto/update-${stem}.dto';
import { ${model}ResponseDto, to${model}Response } from './dto/${stem}.response.dto';

const ADMIN_ROLES = ${JSON.stringify(crud.adminRoles)};

/**
 * Generated data access for ${model}. Every read and write goes through
 * {@link scopedWhere}, so ownership and tenant isolation cannot be bypassed by
 * a client-supplied filter.
 */
@Injectable()
export class ${model}Service {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: Create${model}Dto, scope: RequestScope): Promise<${model}ResponseDto> {
    await this.validateRelatedRecords(dto, scope);
    const data: Prisma.${model}UncheckedCreateInput = {
${createData.join("\n")}
    };

    const created = await this.prisma.${delegate}.create({ data });
    return to${model}Response(created);
  }

  async findMany(query: Query${model}Dto, scope: RequestScope): Promise<Page<${model}ResponseDto>> {
    const where = this.scopedWhere(this.filters(query), scope);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.${delegate}.count({ where }),
      this.prisma.${delegate}.findMany({
        where,
        orderBy: this.orderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return toPage(rows.map(to${model}Response), total, query.page, query.pageSize);
  }

  async findOne(id: string, scope: RequestScope): Promise<${model}ResponseDto> {
    this.assertId(id);
    const row = await this.prisma.${delegate}.findFirst({ where: this.scopedWhere({ id }, scope) });

    if (row === null) {
      throw new NotFoundException('${model} not found');
    }

    return to${model}Response(row);
  }

  async update(id: string, dto: Update${model}Dto, scope: RequestScope): Promise<${model}ResponseDto> {
    this.assertId(id);
    await this.validateRelatedRecords(dto, scope);

    const data: Prisma.${model}UncheckedUpdateManyInput = {};
${updateData.join("\n")}

    const result = await this.prisma.${delegate}.updateMany({
      where: this.scopedWhere({ id }, scope),
      data,
    });
    if (result.count !== 1) {
      throw new NotFoundException('${model} not found');
    }
    return this.findOne(id, scope);
  }

  async remove(id: string, scope: RequestScope): Promise<void> {
    this.assertId(id);
${removeBody}
    if (result.count !== 1) {
      throw new NotFoundException('${model} not found');
    }
  }

  private assertId(id: string): void {
    if (id.length === 0 || id.length > 128) {
      throw new BadRequestException('Invalid identifier');
    }
  }

  private async validateRelatedRecords(
    dto: Partial<Create${model}Dto>,
    scope: RequestScope,
  ): Promise<void> {
${relationChecks.length > 0 ? relationChecks : "    void dto;\n    void scope;"}
  }

  private filters(query: Query${model}Dto): Prisma.${model}WhereInput {
    const where: Prisma.${model}WhereInput = {};
${filterLines.join("\n")}${searchBlock}
    return where;
  }

  /** Applies soft delete, tenant and ownership constraints on the server. */
  private scopedWhere(
    where: Prisma.${model}WhereInput,
    scope: RequestScope,
  ): Prisma.${model}WhereInput {
    const clauses: Prisma.${model}WhereInput[] = [where];
${scopeClauses.join("\n")}
    return { AND: clauses };
  }

  private orderBy(query: Query${model}Dto): Prisma.${model}OrderByWithRelationInput {
    switch (query.sort) {
${orderCases}
      default:
        return { createdAt: query.order };
    }
  }
}
`;
}

function controllerFile(entity: NormalizedEntity, context: TargetRenderContext): string {
  const model = names.model(entity.name);
  const stem = names.file(entity.name);
  const resource = names.route(entity.name);
  const authenticated = context.hasFeature("auth");

  return `import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,${authenticated ? "\n  ApiBearerAuth," : ""}
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from '../common/api-error.dto';
import { Page } from '../common/pagination';
import { CurrentScope, RequestScope } from '../common/scope';
import { Create${model}Dto } from './dto/create-${stem}.dto';
import { Query${model}Dto } from './dto/query-${stem}.dto';
import { Update${model}Dto } from './dto/update-${stem}.dto';
import { ${model}ResponseDto } from './dto/${stem}.response.dto';
import { ${model}Service } from './${stem}.service';

@ApiTags('${resource}')${authenticated ? "\n@ApiBearerAuth()" : ""}
@ApiBadRequestResponse({ type: ApiErrorDto })
@Controller('${resource}')
export class ${model}Controller {
  constructor(private readonly service: ${model}Service) {}

  @Post()
  @ApiCreatedResponse({ type: ${model}ResponseDto })
  create(
    @Body() dto: Create${model}Dto,
    @CurrentScope() scope: RequestScope,
  ): Promise<${model}ResponseDto> {
    return this.service.create(dto, scope);
  }

  @Get()
  @ApiOkResponse({ type: [${model}ResponseDto] })
  findMany(
    @Query() query: Query${model}Dto,
    @CurrentScope() scope: RequestScope,
  ): Promise<Page<${model}ResponseDto>> {
    return this.service.findMany(query, scope);
  }

  @Get(':id')
  @ApiOkResponse({ type: ${model}ResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  findOne(
    @Param('id') id: string,
    @CurrentScope() scope: RequestScope,
  ): Promise<${model}ResponseDto> {
    return this.service.findOne(id, scope);
  }

  @Patch(':id')
  @ApiOkResponse({ type: ${model}ResponseDto })
  @ApiNotFoundResponse({ type: ApiErrorDto })
  update(
    @Param('id') id: string,
    @Body() dto: Update${model}Dto,
    @CurrentScope() scope: RequestScope,
  ): Promise<${model}ResponseDto> {
    return this.service.update(id, dto, scope);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ApiErrorDto })
  remove(@Param('id') id: string, @CurrentScope() scope: RequestScope): Promise<void> {
    return this.service.remove(id, scope);
  }
}
`;
}

function moduleFile(entity: NormalizedEntity): string {
  const model = names.model(entity.name);
  const stem = names.file(entity.name);
  return `import { Module } from '@nestjs/common';
import { ${model}Controller } from './${stem}.controller';
import { ${model}Service } from './${stem}.service';

@Module({
  controllers: [${model}Controller],
  providers: [${model}Service],
  exports: [${model}Service],
})
export class ${model}Module {}
`;
}

function serviceSpec(entity: NormalizedEntity): string {
  const model = names.model(entity.name);
  const stem = names.file(entity.name);
  const delegate = names.delegate(entity.name);
  const scope = entity.ownership
    ? "{ userId: 'user-1', organizationId: 'org-1', roles: ['admin'] }"
    : "{ userId: 'user-1', organizationId: 'org-1', roles: [] }";

  return `import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RequestScope } from '../common/scope';
import { ${model}Service } from './${stem}.service';

const scope: RequestScope = ${scope};

describe('${model}Service', () => {
  const delegate = {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };

  const prisma = {
    ${delegate}: delegate,
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };

  let service: ${model}Service;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [${model}Service, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(${model}Service);
  });

  it('throws when the record does not exist', async () => {
    delegate.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing', scope)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('paginates and reports total pages', async () => {
    delegate.count.mockResolvedValue(3);
    delegate.findMany.mockResolvedValue([]);

    const page = await service.findMany(
      { page: 2, pageSize: 2, order: 'desc', sort: 'createdAt' } as never,
      scope,
    );

    expect(page.meta).toEqual({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect(delegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 2, take: 2, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('never issues an unscoped query', async () => {
    delegate.findFirst.mockResolvedValue(null);

    await expect(service.findOne('id', scope)).rejects.toBeInstanceOf(NotFoundException);
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ AND: expect.any(Array) }),
    });
  });
});
`;
}

const SCOPE_FILE = `import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';

/**
 * The security context of one request. It is derived from the authenticated
 * principal only — never from the request body or query string — so a client
 * cannot widen its own scope.
 */
export interface RequestScope {
  userId: string | null;
  organizationId: string | null;
  roles: string[];
}

interface ScopedRequest {
  user?: {
    id?: string;
    organizationId?: string | null;
    roles?: string[];
  };
}

export const CurrentScope = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestScope => {
    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const user = request.user;

    return {
      userId: user?.id ?? null,
      organizationId: user?.organizationId ?? null,
      roles: user?.roles ?? [],
    };
  },
);

export function isAdmin(scope: RequestScope, adminRoles: readonly string[]): boolean {
  return scope.roles.some((role) => adminRoles.includes(role));
}

export function requireUser(scope: RequestScope): string {
  if (scope.userId === null) {
    throw new ForbiddenException('This resource requires an authenticated user');
  }
  return scope.userId;
}

export function requireOrganization(scope: RequestScope): string {
  if (scope.organizationId === null) {
    throw new ForbiddenException('This resource requires an organization context');
  }
  return scope.organizationId;
}
`;

function testAppFile(): string {
  return `import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/generated/common/bootstrap';
import { PrismaService } from '../../src/generated/prisma/prisma.service';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });

  configureApp(app);
  await app.init();

  return { app, prisma: app.get(PrismaService) };
}

export function uniqueString(length: number): string {
  const source = \`\${Date.now().toString(36)}\${Math.random().toString(36).slice(2)}\`.repeat(2);
  return source.slice(0, Math.max(1, length));
}
`;
}

function resetFile(context: TargetRenderContext): string {
  const tables = context.ir.entities.map((entity) => `'"${entity.name}"'`).join(", ");
  return `import { PrismaService } from '../../src/generated/prisma/prisma.service';

const TABLES = [${tables}];

/** Truncates every generated table. Integration tests start from a clean state. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    \`TRUNCATE TABLE \${TABLES.join(', ')} RESTART IDENTITY CASCADE\`,
  );
}
`;
}

function factoriesFile(context: TargetRenderContext): string {
  const lines: string[] = [
    "import { randomUUID } from 'node:crypto';",
    "import { PrismaService } from '../../src/generated/prisma/prisma.service';",
    "import { uniqueString } from './test-app';",
    "",
    "/**",
    " * Creates a valid row for each entity, recursively creating any required",
    " * parents first. Generated integration tests use these instead of hand-written",
    " * fixtures so that a change to the specification cannot leave them stale.",
    " */",
  ];

  for (const entity of context.ir.entities) {
    const model = names.model(entity.name);
    const delegate = names.delegate(entity.name);
    const assignments = entity.fields
      .filter((field) => field.required && field.defaultValue === null)
      .map((field) => `    ${field.name}: ${sampleExpression(entity, field, "prisma")},`);

    const parents = entity.relations
      .filter((relation) => relation.owner && relation.required && relation.foreignKey !== null)
      .map(
        (relation) =>
          `  if (overrides.${relation.foreignKey} === undefined) {\n` +
          `    data.${relation.foreignKey} = (await create${names.model(relation.target)}(prisma)).id;\n` +
          `  }`,
      );

    lines.push(
      `export async function create${model}(`,
      "  prisma: PrismaService,",
      "  overrides: Record<string, unknown> = {},",
      "): Promise<{ id: string }> {",
      "  const data: Record<string, unknown> = {",
      ...assignments,
      "  };",
      ...(parents.length > 0 ? ["", ...parents] : []),
      "",
      `  return prisma.${delegate}.create({`,
      "    data: { ...data, ...overrides } as never,",
      "    select: { id: true },",
      "  });",
      "}",
      "",
    );
  }

  lines.push("export { randomUUID };");
  return `${lines.join("\n")}\n`;
}

function e2eFile(entity: NormalizedEntity, context: TargetRenderContext): string {
  const model = names.model(entity.name);
  const stem = names.file(entity.name);
  const resource = names.route(entity.name);
  const authenticated = context.hasFeature("auth");
  const prefix = context.settings.apiPrefix;

  const payloadFields = writableFields(entity)
    .filter((field) => field.required && field.defaultValue === null)
    .map((field) => `    ${field.name}: ${sampleExpression(entity, field, "json")},`);

  const payloadKeys = writableForeignKeys(entity)
    .filter((key) => key.required)
    .map(
      (key) =>
        `  payload.${key.name} = (await create${names.model(key.target)}(prisma)).id;`,
    );

  const factoryImports = [
    ...new Set(
      writableForeignKeys(entity)
        .filter((key) => key.required)
        .map((key) => `create${names.model(key.target)}`),
    ),
  ].sort();

  const authImport = authenticated
    ? "import { authHeaders } from './utils/auth-helper';\n"
    : "";
  const headerSetup = authenticated
    ? "    headers = await authHeaders(app, prisma, { role: 'admin' });"
    : "    headers = {};";

  return `import { INestApplication } from '@nestjs/common';
import request from 'supertest';
${authImport}${
    factoryImports.length > 0
      ? `import { ${factoryImports.join(", ")} } from './utils/factories';\n`
      : ""
  }import { resetDatabase } from './utils/reset';
import { createTestApp, uniqueString } from './utils/test-app';
import { PrismaService } from '../src/generated/prisma/prisma.service';

describe('${model} (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let headers: Record<string, string>;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
${headerSetup}
  });

  async function buildPayload(): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
${payloadFields.join("\n")}
    };

${payloadKeys.join("\n")}
    return payload;
  }

  it('creates, reads, lists, updates and deletes a ${model}', async () => {
    const payload = await buildPayload();

    const created = await request(app.getHttpServer())
      .post('/${prefix}/${resource}')
      .set(headers)
      .send(payload)
      .expect(201);

    const id = created.body.id as string;
    expect(id).toBeDefined();

    await request(app.getHttpServer())
      .get(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .expect(200);

    const listed = await request(app.getHttpServer())
      .get('/${prefix}/${resource}')
      .set(headers)
      .expect(200);

    expect(listed.body.meta.total).toBe(1);
    expect(listed.body.data).toHaveLength(1);

    await request(app.getHttpServer())
      .delete(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .expect(204);

    await request(app.getHttpServer())
      .get(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .expect(404);
  });

  it('rejects a payload that violates the specification', async () => {
    await request(app.getHttpServer())
      .post('/${prefix}/${resource}')
      .set(headers)
      .send({ unexpectedProperty: uniqueString(4) })
      .expect(400);
  });
});
`;
}

export const crudRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const entities = context.crudEntities();
    const crud = settings(context);

    const files: RenderedFile[] = [
      file("src/generated/common/scope.ts", SCOPE_FILE),
      file("test/utils/test-app.ts", testAppFile()),
      file("test/utils/reset.ts", resetFile(context)),
      file("test/utils/factories.ts", factoriesFile(context)),
    ];

    for (const entity of entities) {
      const stem = names.file(entity.name);
      const directory = `src/generated/${stem}`;

      files.push(
        file(`${directory}/dto/create-${stem}.dto.ts`, createDto(entity)),
        file(`${directory}/dto/update-${stem}.dto.ts`, updateDto(entity)),
        file(`${directory}/dto/query-${stem}.dto.ts`, queryDto(entity, crud)),
        file(`${directory}/dto/${stem}.response.dto.ts`, responseDto(entity)),
        file(`${directory}/${stem}.service.ts`, serviceFile(entity, context)),
        file(`${directory}/${stem}.controller.ts`, controllerFile(entity, context)),
        file(`${directory}/${stem}.module.ts`, moduleFile(entity)),
        file(`${directory}/${stem}.service.spec.ts`, serviceSpec(entity)),
        file(`test/${stem}.e2e-spec.ts`, e2eFile(entity, context)),
      );
    }

    return {
      ...emptyRenderResult(),
      files,
      rootModules: entities.map((entity, index) => ({
        symbol: `${names.model(entity.name)}Module`,
        from: `./generated/${names.file(entity.name)}/${names.file(entity.name)}.module`,
        kind: "module" as const,
        order: 100 + index,
      })),
    };
  },
};
