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
import { renderSeedFile, renderSeedTestFile } from "./seed.js";

interface CrudSettings {
  adminRoles: string[];
  destructiveRoles: string[];
  destructiveOrgRoles: string[] | null;
  defaultPageSize: number;
  maxPageSize: number;
  accountSetupRole: string;
  accountDisallowedRole: string | null;
  organizationSetupRole: string | null;
  organizationDisallowedRole: string | null;
}

function settings(context: TargetRenderContext): CrudSettings {
  const config = context.config as Partial<CrudSettings>;
  const auth = context.featureConfig("auth") as
    | { roles?: string[]; defaultRole?: string }
    | undefined;
  const organizations = context.featureConfig("organizations") as
    | { roles?: string[] }
    | undefined;
  const accountRoles = auth?.roles ?? ["admin", "user"];
  const registrationRole = auth?.defaultRole ?? accountRoles.at(-1) ?? "user";
  const orgRoles = organizations?.roles ?? ["owner", "admin", "member"];
  const adminRoles =
    config.adminRoles !== undefined && config.adminRoles.length > 0
      ? config.adminRoles
      : accountRoles.filter((role) => role !== registrationRole).slice(0, 1);
  const configuredDestructiveRoles = config.destructiveRoles ?? adminRoles;
  const destructiveRoles =
    configuredDestructiveRoles.length > 0
      ? configuredDestructiveRoles
      : [accountRoles[0] ?? "admin"];
  const configuredOrgRoles =
    organizations === undefined
      ? null
      : (config.destructiveOrgRoles ?? orgRoles.slice(0, Math.max(1, orgRoles.length - 1)));
  const destructiveOrgRoles =
    configuredOrgRoles === null
      ? null
      : configuredOrgRoles.length > 0
        ? configuredOrgRoles
        : [orgRoles[0] ?? "owner"];

  return {
    adminRoles,
    // Destructive operations default to admin-equivalent roles. Every listed
    // organization role except the least privileged counts as administrative,
    // mirroring the organizations feature's own ADMIN_ROLES.
    destructiveRoles,
    destructiveOrgRoles,
    defaultPageSize: config.defaultPageSize ?? 20,
    maxPageSize: config.maxPageSize ?? 100,
    accountSetupRole: destructiveRoles[0] ?? accountRoles[0] ?? "admin",
    accountDisallowedRole:
      accountRoles.find((role) => !destructiveRoles.includes(role)) ?? null,
    organizationSetupRole: destructiveOrgRoles?.[0] ?? null,
    organizationDisallowedRole:
      destructiveOrgRoles === null
        ? null
        : (orgRoles.find((role) => !destructiveOrgRoles.includes(role)) ?? null),
  };
}

function stringArguments(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
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
  const validators = new Set<string>(["IsIn", "IsInt", "IsOptional", "Max", "Min"]);
  const transformers = new Set<string>(["Type"]);
  const swagger = new Set<string>(["ApiPropertyOptional"]);
  const body: string[] = [
    "  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 1 })",
    "  @IsOptional()",
    "  @Type(() => Number)",
    "  @IsInt()",
    "  @Min(1)",
    "  @Max(1000)",
    "  page: number = 1;",
    "",
    `  @ApiPropertyOptional({ minimum: 1, maximum: ${crud.maxPageSize}, default: ${crud.defaultPageSize} })`,
    "  @IsOptional()",
    "  @Type(() => Number)",
    "  @IsInt()",
    "  @Min(1)",
    `  @Max(${crud.maxPageSize})`,
    `  pageSize: number = ${crud.defaultPageSize};`,
    "",
    "  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })",
    "  @IsOptional()",
    "  @IsIn(['asc', 'desc'])",
    "  order: 'asc' | 'desc' = 'desc';",
    "",
  ];

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
    `\n/** Pagination defaults: page size ${crud.defaultPageSize}, maximum ${crud.maxPageSize}. */\n` +
    `export class Query${model}Dto {\n` +
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
  const swaggerImports = [
    "ApiProperty",
    ...(entity.softDelete || fields.some((field) => !field.required) || keys.some((key) => !key.required)
      ? ["ApiPropertyOptional"]
      : []),
  ];
  return (
    importLine(swaggerImports, "@nestjs/swagger") +
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
  const usesAdminRoles =
    entity.ownership !== null || protectedRelations.some(({ target }) => target.ownership !== null);

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
    .map((field) => `        case '${field}':\n          return { ${field}: query.order };`)
    .join("\n");

  const removeBody = entity.softDelete
    ? `    const result = await this.prisma.${delegate}.updateMany({
      where: this.scopedWhere({ id }, scope),
      data: { deletedAt: new Date() },
    });`
    : `    let result;
    try {
      result = await this.prisma.${delegate}.deleteMany({
        where: this.scopedWhere({ id }, scope),
      });
    } catch (error) {
      // Restrictive foreign keys refuse the delete while dependants exist.
      // That is a state conflict the caller can resolve, not a bad request.
      if (isRestrictiveDeleteViolation(error)) {
        throw new ConflictException(
          'This ${model} still has related records; delete or detach them first',
        );
      }
      throw error;
    }`;

  const deleteConflictHelper = entity.softDelete
    ? ""
    : `
/**
 * Prisma maps ordinary FK failures to P2003, while PostgreSQL ON DELETE
 * RESTRICT currently arrives as an unknown request error carrying SQLSTATE
 * 23001. Match only those two database signals so unrelated failures remain
 * visible as server errors.
 */
function isRestrictiveDeleteViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2003';
  }

  return error instanceof Error && /code:\\s*["']23001["']/.test(error.message);
}
`;

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
  const relationChecksUseScope = protectedRelations.some(
    ({ target }) => Boolean(target.tenant || target.ownership),
  );

  return `import { BadRequestException, ${entity.softDelete ? "" : "ConflictException, "}Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Page, toPage } from '../common/pagination';
${importLine([...scopeImports], "../common/scope")}import { PrismaService } from '../prisma/prisma.service';
import { Create${model}Dto } from './dto/create-${stem}.dto';
import { Query${model}Dto } from './dto/query-${stem}.dto';
import { Update${model}Dto } from './dto/update-${stem}.dto';
import { ${model}ResponseDto, to${model}Response } from './dto/${stem}.response.dto';

${usesAdminRoles ? `const ADMIN_ROLES = ${JSON.stringify(crud.adminRoles)};` : ""}
${deleteConflictHelper}

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
${relationChecks.length > 0 ? `${relationChecksUseScope ? "" : "    void scope;\n"}${relationChecks}` : "    void dto;\n    void scope;"}
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
${entity.tenant || entity.ownership ? "" : "    void scope;\n"}${scopeClauses.join("\n")}
    return { AND: clauses };
  }

  /** The unique id is always the final sort key, making equal-valued rows deterministic. */
  private orderBy(query: Query${model}Dto): Prisma.${model}OrderByWithRelationInput[] {
    const primary = ((): Prisma.${model}OrderByWithRelationInput => {
      switch (query.sort) {
${orderCases}
        default:
          return { createdAt: query.order };
      }
    })();

    return [primary, { id: 'asc' }];
  }
}
`;
}

/**
 * Guard decoration for destructive routes. Tenant-scoped entities require an
 * administrative organization role; entities without row ownership require an
 * administrative account role. Row-owned entities stay open because the
 * service already restricts every write to the caller's own rows.
 */
function destructiveGuard(
  entity: NormalizedEntity,
  context: TargetRenderContext,
  crud: CrudSettings,
): { decorator: string; importLine: string; forbidden: boolean } {
  if (entity.tenant !== null && crud.destructiveOrgRoles !== null) {
    return {
      decorator: `  @OrgRoles(${stringArguments(crud.destructiveOrgRoles)})\n`,
      importLine:
        "import { OrgRoles } from '../organizations/decorators/org-roles.decorator';\n",
      forbidden: true,
    };
  }

  if (context.hasFeature("auth") && entity.ownership === null) {
    return {
      decorator: `  @Roles(${stringArguments(crud.destructiveRoles)})\n`,
      importLine: "import { Roles } from '../auth/decorators/roles.decorator';\n",
      forbidden: true,
    };
  }

  return { decorator: "", importLine: "", forbidden: false };
}

function controllerFile(entity: NormalizedEntity, context: TargetRenderContext): string {
  const model = names.model(entity.name);
  const stem = names.file(entity.name);
  const resource = names.route(entity.name);
  const authenticated = context.hasFeature("auth");
  const guard = destructiveGuard(entity, context, settings(context));

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
  ApiCreatedResponse,${authenticated ? "\n  ApiBearerAuth," : ""}${!entity.softDelete ? "\n  ApiConflictResponse," : ""}${guard.forbidden ? "\n  ApiForbiddenResponse," : ""}
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
${guard.importLine}import { ApiErrorDto } from '../common/api-error.dto';
import { ApiPaginatedResponse, Page } from '../common/pagination';
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
  @ApiPaginatedResponse(${model}ResponseDto)
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
${guard.decorator}  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()${guard.forbidden ? "\n  @ApiForbiddenResponse({ type: ApiErrorDto })" : ""}
${entity.softDelete ? "" : "  @ApiConflictResponse({ type: ApiErrorDto })\n"}  @ApiNotFoundResponse({ type: ApiErrorDto })
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
      expect.objectContaining({
        skip: 2,
        take: 2,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
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

  // Background workers (webhook dispatch, job polling, upload sweeps) poll on
  // intervals and hold short claim transactions. Integration tests drive those
  // workers explicitly and truncate tables between cases, so a scheduled tick
  // racing a test causes nondeterministic deadlocks (PostgreSQL 40P01).
  // Removing the scheduled intervals keeps every queue interaction test-driven.
  try {
    // The specifier is typed as plain string so projects generated without a
    // scheduled worker (no @nestjs/schedule dependency) still type-check;
    // the failed import is handled below at runtime.
    const specifier: string = '@nestjs/schedule';
    const schedule = (await import(specifier)) as {
      SchedulerRegistry: new () => {
        getIntervals(): string[];
        deleteInterval(name: string): void;
      };
    };
    const registry = app.get(schedule.SchedulerRegistry, { strict: false });
    for (const name of registry.getIntervals()) {
      registry.deleteInterval(name);
    }
  } catch {
    // The schedule module is absent when no feature registers a worker.
  }

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

/**
 * Truncates every generated table. Integration tests start from a clean state.
 *
 * Background queue workers (webhooks, jobs, notifications) poll on an interval
 * and hold short FOR UPDATE SKIP LOCKED claim transactions, so a TRUNCATE can
 * lose a deadlock race (PostgreSQL 40P01) and be chosen as the victim. The
 * claim transactions are short-lived, so retrying the truncate is safe and
 * deterministic.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$executeRawUnsafe(
        \`TRUNCATE TABLE \${TABLES.join(', ')} RESTART IDENTITY CASCADE\`,
      );
      return;
    } catch (error) {
      const isDeadlock = error instanceof Error && error.message.includes('40P01');
      if (!isDeadlock || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
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

/** A mutation whose API representation differs from the create fixture. */
function updateProbe(entity: NormalizedEntity): { field: string; expression: string } | null {
  for (const field of writableFields(entity)) {
    const suppliedOnCreate = field.required && field.defaultValue === null;

    if (field.enumValues !== null && field.enumValues.length > 0) {
      const value = suppliedOnCreate ? field.enumValues[1] : field.enumValues[0];
      if (value !== undefined) return { field: field.name, expression: JSON.stringify(value) };
      continue;
    }

    switch (field.type) {
      case "string":
      case "text":
      case "uuid":
        return { field: field.name, expression: sampleExpression(entity, field, "json") };
      case "boolean":
        return { field: field.name, expression: "true" };
      case "datetime":
      case "date":
        return {
          field: field.name,
          expression: "new Date(Date.now() + 60_000).toISOString()",
        };
      case "integer":
        if (!suppliedOnCreate) {
          return { field: field.name, expression: sampleExpression(entity, field, "json") };
        }
        break;
      default:
        break;
    }
  }

  return null;
}

function restrictiveDependent(
  context: TargetRenderContext,
  parent: NormalizedEntity,
): { entity: NormalizedEntity; foreignKey: string } | null {
  for (const candidate of context.ir.entities) {
    const relation = candidate.relations.find(
      (item) =>
        item.owner &&
        item.target === parent.name &&
        item.onDelete === "restrict" &&
        item.foreignKey !== null &&
        (candidate.tenant === null || parent.tenant !== null),
    );
    if (relation?.foreignKey !== null && relation?.foreignKey !== undefined) {
      return { entity: candidate, foreignKey: relation.foreignKey };
    }
  }

  return null;
}

function e2eFile(entity: NormalizedEntity, context: TargetRenderContext): string {
  const model = names.model(entity.name);
  const stem = names.file(entity.name);
  const resource = names.route(entity.name);
  const authenticated = context.hasFeature("auth");
  const prefix = context.settings.apiPrefix;
  const crud = settings(context);
  const delegate = names.delegate(entity.name);
  const guard = destructiveGuard(entity, context, crud);
  const probe = updateProbe(entity);
  const dependent = entity.softDelete ? null : restrictiveDependent(context, entity);

  const payloadFields = writableFields(entity)
    .filter((field) => field.required && field.defaultValue === null)
    .map((field) => `    ${field.name}: ${sampleExpression(entity, field, "json")},`);

  const payloadKeys = writableForeignKeys(entity)
    .filter((key) => key.required)
    .map((key) => {
      const target = context.ir.entities.find((candidate) => candidate.name === key.target);
      const tenantOverride = target?.tenant
        ? `, { ${target.tenant.foreignKey}: organizationId }`
        : "";

      return `  payload.${key.name} = (await create${names.model(key.target)}(prisma${tenantOverride})).id;`;
    });

  const factoryImports = [
    ...new Set(
      [
        ...writableForeignKeys(entity)
          .filter((key) => key.required)
          .map((key) => `create${names.model(key.target)}`),
        ...(dependent === null ? [] : [`create${names.model(dependent.entity.name)}`]),
      ],
    ),
  ].sort();

  const tenantScoped = entity.tenant !== null;
  const emitsTenantDenial =
    tenantScoped && guard.forbidden && crud.organizationDisallowedRole !== null;
  const emitsAccountDenial =
    !tenantScoped && guard.forbidden && crud.accountDisallowedRole !== null;
  const needsRegister = tenantScoped || (authenticated && emitsAccountDenial);
  const authSymbols = [
    ...(needsRegister ? ["registerAccount"] : []),
    ...(!tenantScoped && authenticated ? ["authHeaders"] : []),
  ];
  const authImport =
    authSymbols.length > 0
      ? `import { ${authSymbols.join(", ")} } from './utils/auth-helper';\n`
      : "";
  const headerSetup = tenantScoped
    ? `    const account = await registerAccount(app, prisma, { role: ${JSON.stringify(crud.accountSetupRole)} });
    const organization = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${account.accessToken}\`)
      .send({ name: uniqueString(24) })
      .expect(201);
    organizationId = organization.body.id as string;
${
  guard.forbidden && crud.organizationSetupRole !== null
    ? `    await prisma.membership.updateMany({
      where: { organizationId, userId: account.id },
      data: { role: ${JSON.stringify(crud.organizationSetupRole)} as never },
    });
`
    : ""
}    headers = {
      Authorization: \`Bearer \${account.accessToken}\`,
      'X-Organization-Id': organizationId,
    };`
    : authenticated
      ? `    headers = await authHeaders(app, prisma, { role: ${JSON.stringify(crud.accountSetupRole)} });`
      : "    headers = {};";
  const restrictiveDeleteTest =
    dependent === null
      ? ""
      : `
  it('returns conflict and retains data when a dependent restricts deletion', async () => {
    const payload = await buildPayload();
    const created = await request(app.getHttpServer())
      .post('/${prefix}/${resource}')
      .set(headers)
      .send(payload)
      .expect(201);
    const id = created.body.id as string;

    await create${names.model(dependent.entity.name)}(prisma, {
      ${dependent.foreignKey}: id,${
        dependent.entity.tenant === null
          ? ""
          : `
      ${dependent.entity.tenant.foreignKey}: organizationId,`
      }
    });

    await request(app.getHttpServer())
      .delete(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .expect(409);

    await request(app.getHttpServer())
      .get(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .expect(200);
    await expect(
      prisma.${names.delegate(dependent.entity.name)}.count({
        where: { ${dependent.foreignKey}: id },
      }),
    ).resolves.toBe(1);
  });
`;

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
${tenantScoped ? "  let organizationId: string;\n" : ""}

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

    const revised = await buildPayload();
${probe === null ? "" : `    revised[${JSON.stringify(probe.field)}] = ${probe.expression};\n`}
    const updated = await request(app.getHttpServer())
      .patch(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .send(revised)
      .expect(200);

    expect(updated.body.id).toBe(id);
${
  probe === null
    ? ""
    : `    expect(updated.body[${JSON.stringify(probe.field)}]).toEqual(revised[${JSON.stringify(probe.field)}]);

    const persisted = await request(app.getHttpServer())
      .get(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .expect(200);
    expect(persisted.body[${JSON.stringify(probe.field)}]).toEqual(revised[${JSON.stringify(probe.field)}]);
`
}

    await request(app.getHttpServer())
      .delete(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .expect(204);

    await request(app.getHttpServer())
      .get(\`/${prefix}/${resource}/\${id}\`)
      .set(headers)
      .expect(404);
${
    entity.softDelete
      ? `
    // Soft delete hides the row from the API but retains it, and everything
    // that references it, in the database.
    const retained = await prisma.${delegate}.findUnique({ where: { id } });
    expect(retained).not.toBeNull();
    expect(retained?.deletedAt).not.toBeNull();
`
      : ""
  }  });

  it('rejects a payload that violates the specification', async () => {
    await request(app.getHttpServer())
      .post('/${prefix}/${resource}')
      .set(headers)
      .send({ unexpectedProperty: uniqueString(4) })
      .expect(400);
  });
${restrictiveDeleteTest}
${
    emitsTenantDenial
      ? `
  it('refuses destructive operations for a disallowed organization role', async () => {
    const payload = await buildPayload();
    const created = await request(app.getHttpServer())
      .post('/${prefix}/${resource}')
      .set(headers)
      .send(payload)
      .expect(201);
    const id = created.body.id as string;

    const member = await registerAccount(app, prisma, { role: ${JSON.stringify(crud.accountSetupRole)} });
    await prisma.membership.create({
      data: {
        organizationId,
        userId: member.id,
        role: ${JSON.stringify(crud.organizationDisallowedRole)} as never,
      },
    });
    const memberHeaders = {
      Authorization: \`Bearer \${member.accessToken}\`,
      'X-Organization-Id': organizationId,
    };

    await request(app.getHttpServer())
      .delete(\`/${prefix}/${resource}/\${id}\`)
      .set(memberHeaders)
      .expect(403);

    // The member may still read the row; only destruction is restricted.
    await request(app.getHttpServer())
      .get(\`/${prefix}/${resource}/\${id}\`)
      .set(memberHeaders)
      .expect(200);
  });
`
      : emitsAccountDenial
        ? `
  it('refuses deletion without an administrative role', async () => {
    const payload = await buildPayload();
    const created = await request(app.getHttpServer())
      .post('/${prefix}/${resource}')
      .set(headers)
      .send(payload)
      .expect(201);
    const id = created.body.id as string;

    const outsider = await registerAccount(app, prisma, {
      role: ${JSON.stringify(crud.accountDisallowedRole)},
    });

    await request(app.getHttpServer())
      .delete(\`/${prefix}/${resource}/\${id}\`)
      .set({ Authorization: \`Bearer \${outsider.accessToken}\` })
      .expect(403);
  });
`
        : ""
  }});
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

    const seedFile = renderSeedFile(context);
    const seedTestFile = renderSeedTestFile(context);
    if (seedFile !== null) {
      files.push(file("prisma/seed.ts", seedFile));
    }
    if (seedTestFile !== null) {
      files.push(file("test/seed.e2e-spec.ts", seedTestFile));
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
      ...(seedFile !== null
        ? {
            scripts: { "db:seed": "ts-node --transpile-only prisma/seed.ts" },
            packageDevDependencies: { "ts-node": "10.9.2" },
          }
        : {}),
    };
  },
};
