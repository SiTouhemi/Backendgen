import { names } from "@backend-compiler/target-nestjs-prisma";
import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import {
  memberRole,
  organizationsConfig,
  ownerRole,
  type OrganizationsConfig,
} from "./feature.js";

function file(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

const CONTEXT_GUARD = `import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

interface TenantUser {
  id: string;
  organizationId: string | null;
  organizationRole?: string;
}

interface TenantRequest {
  user?: TenantUser;
  headers: Record<string, string | string[] | undefined>;
}

export const ORGANIZATION_HEADER = 'x-organization-id';

/**
 * Resolves the caller's organization once per request, from a membership row
 * rather than from anything the client asserts. A client may name an
 * organization with the X-Organization-Id header, but only one it belongs to.
 *
 * Registered globally and ordered after the authentication guard, so
 * request.user is already populated when this runs.
 */
@Injectable()
export class OrganizationContextGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TenantRequest>();
    const user = request.user;

    if (user === undefined) {
      throw new UnauthorizedException('Authentication required');
    }

    const header = request.headers[ORGANIZATION_HEADER];
    if (Array.isArray(header)) {
      throw new BadRequestException('X-Organization-Id must be supplied once');
    }
    const requested = header;

    if (typeof requested === 'string') {
      if (requested.length === 0 || requested.length > 128) {
        throw new BadRequestException('Invalid X-Organization-Id');
      }

      const membership = await this.prisma.membership.findFirst({
        where: { userId: user.id, organizationId: requested },
        select: { organizationId: true, role: true },
      });

      if (membership === null) {
        throw new ForbiddenException('You are not a member of this organization');
      }

      user.organizationId = membership.organizationId;
      user.organizationRole = membership.role;
      return true;
    }

    // Only two rows are needed to distinguish no membership, one unambiguous
    // membership, and the multi-organization case.
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      select: { organizationId: true, role: true },
      orderBy: { organizationId: 'asc' },
      take: 2,
    });

    if (memberships.length === 1) {
      const membership = memberships[0];
      if (membership !== undefined) {
        user.organizationId = membership.organizationId;
        user.organizationRole = membership.role;
      }
    }

    return true;
  }
}
`;

const ORG_ROLES_DECORATOR = `import { SetMetadata } from '@nestjs/common';

export const ORG_ROLES_KEY = 'backendgen:organizationRoles';

/** Requires one of the listed organization roles in the caller's active organization. */
export const OrgRoles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ORG_ROLES_KEY, roles);
`;

const ORG_ROLES_GUARD = `import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ORG_ROLES_KEY } from '../decorators/org-roles.decorator';

interface TenantRequest {
  user?: { organizationRole?: string };
}

@Injectable()
export class OrganizationRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ORG_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TenantRequest>();
    const role = request.user?.organizationRole;

    if (role === undefined || !required.includes(role)) {
      throw new ForbiddenException('Insufficient organization role');
    }

    return true;
  }
}
`;

function dtoFile(config: OrganizationsConfig): string {
  return `import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Membership, MembershipRole, Organization } from '@prisma/client';

export class CreateOrganizationDto {
  @ApiProperty({ minLength: 2, maxLength: 120 })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
}

export class AddMemberDto {
  @ApiProperty({ description: 'Email of an existing account' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ enum: ${JSON.stringify(config.roles)} })
  @IsOptional()
  @IsIn(${JSON.stringify(config.roles)})
  role?: string;
}

export class UpdateMemberDto {
  @ApiProperty({ enum: ${JSON.stringify(config.roles)} })
  @IsIn(${JSON.stringify(config.roles)})
  role!: string;
}

export class OrganizationDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class MemberDto {
  @ApiProperty() userId!: string;
  @ApiProperty() organizationId!: string;
  @ApiProperty({ enum: ${JSON.stringify(config.roles)} }) role!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export function toOrganization(organization: Organization): OrganizationDto {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    createdAt: organization.createdAt.toISOString(),
  };
}

export function toMember(membership: Membership): MemberDto {
  return {
    userId: membership.userId,
    organizationId: membership.organizationId,
    role: membership.role,
    createdAt: membership.createdAt.toISOString(),
  };
}

export type { MembershipRole };
`;
}

function serviceFile(
  config: OrganizationsConfig,
  userEntity: string,
  userSoftDelete: boolean,
): string {
  const delegate = names.delegate(userEntity);
  const admins = config.roles.slice(0, Math.max(1, config.roles.length - 1));
  // A soft-deleted account must not count as an active member or owner: the
  // active-owner invariant is about accounts that can still sign in.
  const activeUserFilter = userSoftDelete ? ", user: { deletedAt: null }" : "";
  const activeAccountFilter = userSoftDelete ? ", deletedAt: null" : "";

  return `import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddMemberDto,
  CreateOrganizationDto,
  MemberDto,
  OrganizationDto,
  toMember,
  toOrganization,
  UpdateMemberDto,
} from './dto/organization.dto';

export const OWNER_ROLE = '${ownerRole(config)}';
export const DEFAULT_MEMBER_ROLE = '${memberRole(config)}';
export const ADMIN_ROLES: readonly string[] = ${JSON.stringify(admins)};

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return \`\${base.length > 0 ? base : 'org'}-\${randomBytes(3).toString('hex')}\`;
}

/**
 * Every method takes the acting user id and re-checks membership against the
 * database. No caller-supplied organization id is ever trusted on its own.
 */
@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateOrganizationDto, userId: string): Promise<OrganizationDto> {
    const organization = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: { name: dto.name, slug: slugify(dto.name) },
      });

      await tx.membership.create({
        data: { organizationId: created.id, userId, role: OWNER_ROLE as never },
      });

      return created;
    });

    return toOrganization(organization);
  }

  async listForUser(userId: string): Promise<OrganizationDto[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => toOrganization(membership.organization));
  }

  async readForUser(organizationId: string, userId: string): Promise<OrganizationDto> {
    await this.requireMembership(organizationId, userId);

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });

    if (organization === null) {
      throw new NotFoundException('Organization not found');
    }

    return toOrganization(organization);
  }

  async listMembers(organizationId: string, userId: string): Promise<MemberDto[]> {
    await this.requireMembership(organizationId, userId);

    const members = await this.prisma.membership.findMany({
      where: { organizationId${activeUserFilter} },
      orderBy: { createdAt: 'asc' },
    });

    return members.map(toMember);
  }

  async addMember(
    organizationId: string,
    dto: AddMemberDto,
    actorId: string,
  ): Promise<MemberDto> {
    await this.requireAdmin(organizationId, actorId);

    const account = await this.prisma.${delegate}.findFirst({
      where: { email: dto.email.trim().toLowerCase()${activeAccountFilter} },
    });

    if (account === null) {
      throw new NotFoundException('No account exists with that email');
    }

    const existing = await this.prisma.membership.findFirst({
      where: { organizationId, userId: account.id },
    });

    if (existing !== null) {
      throw new ConflictException('That account is already a member');
    }

    const membership = await this.prisma.membership.create({
      data: {
        organizationId,
        userId: account.id,
        role: (dto.role ?? DEFAULT_MEMBER_ROLE) as never,
      },
    });

    return toMember(membership);
  }

  async updateMember(
    organizationId: string,
    userId: string,
    dto: UpdateMemberDto,
    actorId: string,
  ): Promise<MemberDto> {
    await this.requireAdmin(organizationId, actorId);

    const updated = await this.serializable(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { organizationId, userId },${userSoftDelete ? "\n        include: { user: { select: { deletedAt: true } } }," : ""}
      });

      if (membership === null) {
        throw new NotFoundException('Membership not found');
      }

      if (${userSoftDelete ? "membership.user.deletedAt === null && " : ""}membership.role === OWNER_ROLE && dto.role !== OWNER_ROLE) {
        const owners = await tx.membership.count({
          where: { organizationId, role: OWNER_ROLE as never${activeUserFilter} },
        });

        if (owners <= 1) {
          throw new ConflictException('An organization must keep at least one ' + OWNER_ROLE);
        }
      }

      return tx.membership.update({
        where: { id: membership.id },
        data: { role: dto.role as never },
      });
    });

    return toMember(updated);
  }

  async removeMember(organizationId: string, userId: string, actorId: string): Promise<void> {
    await this.requireAdmin(organizationId, actorId);

    await this.serializable(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { organizationId, userId },${userSoftDelete ? "\n        include: { user: { select: { deletedAt: true } } }," : ""}
      });

      if (membership === null) {
        throw new NotFoundException('Membership not found');
      }

      if (${userSoftDelete ? "membership.user.deletedAt === null && " : ""}membership.role === OWNER_ROLE) {
        const owners = await tx.membership.count({
          where: { organizationId, role: OWNER_ROLE as never${activeUserFilter} },
        });

        if (owners <= 1) {
          throw new ConflictException('An organization must keep at least one ' + OWNER_ROLE);
        }
      }

      await tx.membership.delete({ where: { id: membership.id } });
    });
  }

  private async requireMembership(organizationId: string, userId: string): Promise<string> {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId${activeUserFilter} },
      select: { role: true },
    });

    if (membership === null) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    return membership.role;
  }

  private async requireAdmin(organizationId: string, userId: string): Promise<void> {
    const role = await this.requireMembership(organizationId, userId);

    if (!ADMIN_ROLES.includes(role)) {
      throw new ForbiddenException('Insufficient organization role');
    }
  }

  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
        if (!retryable || attempt === 2) {
          throw error;
        }
      }
    }

    throw new Error('Unreachable transaction retry state');
  }
}
`;
}

function controllerFile(): string {
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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from '../common/api-error.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import {
  AddMemberDto,
  CreateOrganizationDto,
  MemberDto,
  OrganizationDto,
  UpdateMemberDto,
} from './dto/organization.dto';
import { OrganizationService } from './organization.service';

@ApiTags('organizations')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ApiErrorDto })
@Controller('organizations')
export class OrganizationController {
  constructor(private readonly service: OrganizationService) {}

  @Post()
  @ApiCreatedResponse({ type: OrganizationDto })
  create(
    @Body() dto: CreateOrganizationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationDto> {
    return this.service.create(dto, user.id);
  }

  @Get()
  @ApiOkResponse({ type: [OrganizationDto] })
  list(@CurrentUser() user: AuthenticatedUser): Promise<OrganizationDto[]> {
    return this.service.listForUser(user.id);
  }

  @Get(':id')
  @ApiOkResponse({ type: OrganizationDto })
  read(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrganizationDto> {
    return this.service.readForUser(id, user.id);
  }

  @Get(':id/members')
  @ApiOkResponse({ type: [MemberDto] })
  listMembers(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto[]> {
    return this.service.listMembers(id, user.id);
  }

  @Post(':id/members')
  @ApiCreatedResponse({ type: MemberDto })
  addMember(
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.service.addMember(id, dto, user.id);
  }

  @Patch(':id/members/:userId')
  @ApiOkResponse({ type: MemberDto })
  updateMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.service.updateMember(id, userId, dto, user.id);
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.service.removeMember(id, userId, user.id);
  }
}
`;
}

const ORG_MODULE = `import { Module } from '@nestjs/common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

@Module({
  controllers: [OrganizationController],
  providers: [OrganizationService],
  exports: [OrganizationService],
})
export class OrganizationModule {}
`;

function serviceSpec(config: OrganizationsConfig, userSoftDelete: boolean): string {
  const delegate = names.delegate(config.userEntity);
  const owner = ownerRole(config);
  const admins = config.roles.slice(0, Math.max(1, config.roles.length - 1));
  // Role strings that are guaranteed to be non-admin / non-owner even for a
  // single-role configuration; the service never validates them against the enum.
  const nonAdmin = config.roles.find((role) => !admins.includes(role)) ?? "not-an-admin-role";
  const member = config.roles.find((role) => role !== owner) ?? "not-the-owner-role";
  const activeUserFilter = userSoftDelete ? ", user: { deletedAt: null }" : "";

  const softDeleteTests = userSoftDelete
    ? `
  it('refuses to add a soft-deleted account as a member', async () => {
    prisma.membership.findFirst.mockResolvedValue({ role: '${owner}' });
    prisma.${delegate}.findFirst.mockResolvedValue(null);

    await expect(
      service.addMember('org-1', { email: 'ghost@example.test' }, 'acting-admin'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.${delegate}.findFirst).toHaveBeenCalledWith({
      where: { email: 'ghost@example.test', deletedAt: null },
    });
  });

  it('allows demoting a soft-deleted owner without counting it as active', async () => {
    prisma.membership.findFirst
      .mockResolvedValueOnce({ role: '${owner}' })
      .mockResolvedValueOnce({
        id: 'membership-1',
        role: '${owner}',
        user: { deletedAt: new Date() },
      });
    prisma.membership.update.mockResolvedValue({
      userId: 'user-1',
      organizationId: 'org-1',
      role: '${member}',
      createdAt: new Date(),
    });
    prisma.$transaction.mockImplementation(async (work) => work(prisma));

    await service.updateMember('org-1', 'user-1', { role: '${member}' }, 'acting-admin');
    expect(prisma.membership.count).not.toHaveBeenCalled();
  });
`
    : "";

  return `import { ConflictException, ForbiddenException${userSoftDelete ? ", NotFoundException" : ""} } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationService } from './organization.service';

describe('OrganizationService', () => {
  const prisma = {
    organization: { create: jest.fn(), findUnique: jest.fn() },
    membership: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    ${delegate}: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };

  let service: OrganizationService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [OrganizationService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(OrganizationService);
  });

  it('refuses to read an organization the caller does not belong to', async () => {
    prisma.membership.findFirst.mockResolvedValue(null);

    await expect(service.readForUser('org-1', 'outsider')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.organization.findUnique).not.toHaveBeenCalled();
  });

  it('refuses to add a member without an administrative organization role', async () => {
    prisma.membership.findFirst.mockResolvedValue({ role: '${nonAdmin}' });

    await expect(
      service.addMember('org-1', { email: 'new@example.test' }, 'plain-member'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses to demote the last active ${owner}', async () => {
    prisma.membership.findFirst
      .mockResolvedValueOnce({ role: '${owner}' })
      .mockResolvedValueOnce({ id: 'membership-1', role: '${owner}'${userSoftDelete ? ", user: { deletedAt: null }" : ""} });
    prisma.membership.count.mockResolvedValue(1);
    prisma.$transaction.mockImplementation(async (work) => work(prisma));

    await expect(
      service.updateMember('org-1', 'user-1', { role: '${member}' }, 'acting-admin'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.membership.count).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', role: '${owner}'${activeUserFilter} },
    });
    expect(prisma.membership.update).not.toHaveBeenCalled();
  });

  it('refuses to remove the last active ${owner}', async () => {
    prisma.membership.findFirst
      .mockResolvedValueOnce({ role: '${owner}' })
      .mockResolvedValueOnce({ id: 'membership-1', role: '${owner}'${userSoftDelete ? ", user: { deletedAt: null }" : ""} });
    prisma.membership.count.mockResolvedValue(1);
    prisma.$transaction.mockImplementation(async (work) => work(prisma));

    await expect(
      service.removeMember('org-1', 'user-1', 'acting-admin'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.membership.delete).not.toHaveBeenCalled();
  });
${softDeleteTests}});
`;
}

function organizationsE2e(context: TargetRenderContext): string {
  const prefix = context.settings.apiPrefix;

  return `import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { registerAccount } from './utils/auth-helper';
import { resetDatabase } from './utils/reset';
import { createTestApp } from './utils/test-app';

describe('Organizations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('makes the creator the first owner and lists only their organizations', async () => {
    const founder = await registerAccount(app, prisma);
    const stranger = await registerAccount(app, prisma);

    const created = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${founder.accessToken}\`)
      .send({ name: 'Acme' })
      .expect(201);

    const members = await request(app.getHttpServer())
      .get(\`/${prefix}/organizations/\${created.body.id}/members\`)
      .set('Authorization', \`Bearer \${founder.accessToken}\`)
      .expect(200);

    expect(members.body).toHaveLength(1);
    expect(members.body[0].userId).toBe(founder.id);

    const strangerList = await request(app.getHttpServer())
      .get('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${stranger.accessToken}\`)
      .expect(200);

    expect(strangerList.body).toHaveLength(0);

    await request(app.getHttpServer())
      .get(\`/${prefix}/organizations/\${created.body.id}\`)
      .set('Authorization', \`Bearer \${stranger.accessToken}\`)
      .expect(403);
  });

  it('refuses to let a plain member add another member', async () => {
    const founder = await registerAccount(app, prisma);
    const member = await registerAccount(app, prisma);
    const outsider = await registerAccount(app, prisma);

    const organization = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${founder.accessToken}\`)
      .send({ name: 'Acme' })
      .expect(201);

    await request(app.getHttpServer())
      .post(\`/${prefix}/organizations/\${organization.body.id}/members\`)
      .set('Authorization', \`Bearer \${founder.accessToken}\`)
      .send({ email: member.email })
      .expect(201);

    await request(app.getHttpServer())
      .post(\`/${prefix}/organizations/\${organization.body.id}/members\`)
      .set('Authorization', \`Bearer \${member.accessToken}\`)
      .send({ email: outsider.email })
      .expect(403);
  });
});
`;
}

function isolationE2e(context: TargetRenderContext): string {
  const prefix = context.settings.apiPrefix;
  const scoped = context.ir.entities.find((entity) => entity.crud && entity.tenant !== null);

  if (scoped === undefined) {
    return `import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { registerAccount } from './utils/auth-helper';
import { resetDatabase } from './utils/reset';
import { createTestApp } from './utils/test-app';

describe('Tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('refuses to act in an organization the caller does not belong to', async () => {
    const alice = await registerAccount(app, prisma);
    const bob = await registerAccount(app, prisma);

    const organization = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${alice.accessToken}\`)
      .send({ name: 'Alpha' })
      .expect(201);

    await request(app.getHttpServer())
      .get(\`/${prefix}/organizations/\${organization.body.id}/members\`)
      .set('Authorization', \`Bearer \${bob.accessToken}\`)
      .set('X-Organization-Id', organization.body.id)
      .expect(403);
  });
});
`;
  }

  const model = names.model(scoped.name);
  const route = names.route(scoped.name);

  return `import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { registerAccount, TestAccount } from './utils/auth-helper';
import { create${model} } from './utils/factories';
import { resetDatabase } from './utils/reset';
import { createTestApp } from './utils/test-app';

/**
 * Proves the requirement that no tenant can reach another tenant's rows, for
 * every read and write path of a scoped resource. The row is inserted directly
 * so the test exercises the server-side filter rather than the create path.
 */
describe('Tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function createOrganization(account: TestAccount, name: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${account.accessToken}\`)
      .send({ name })
      .expect(201);

    return response.body.id as string;
  }

  it('never exposes one organization\\'s ${model} to another', async () => {
    const alice = await registerAccount(app, prisma);
    const bob = await registerAccount(app, prisma);

    const alpha = await createOrganization(alice, 'Alpha');
    const beta = await createOrganization(bob, 'Beta');

    const row = await create${model}(prisma, { organizationId: alpha });

    const alphaHeaders = {
      Authorization: \`Bearer \${alice.accessToken}\`,
      'X-Organization-Id': alpha,
    };
    const betaHeaders = {
      Authorization: \`Bearer \${bob.accessToken}\`,
      'X-Organization-Id': beta,
    };

    // The owning tenant sees the row.
    await request(app.getHttpServer())
      .get(\`/${prefix}/${route}/\${row.id}\`)
      .set(alphaHeaders)
      .expect(200);

    // The other tenant sees nothing, on every path.
    await request(app.getHttpServer())
      .get(\`/${prefix}/${route}/\${row.id}\`)
      .set(betaHeaders)
      .expect(404);

    const listed = await request(app.getHttpServer())
      .get('/${prefix}/${route}')
      .set(betaHeaders)
      .expect(200);

    expect(listed.body.meta.total).toBe(0);

    await request(app.getHttpServer())
      .patch(\`/${prefix}/${route}/\${row.id}\`)
      .set(betaHeaders)
      .send({})
      .expect(404);

    await request(app.getHttpServer())
      .delete(\`/${prefix}/${route}/\${row.id}\`)
      .set(betaHeaders)
      .expect(404);

    // The row is still there.
    await request(app.getHttpServer())
      .get(\`/${prefix}/${route}/\${row.id}\`)
      .set(alphaHeaders)
      .expect(200);
  });

  it('refuses a borrowed organization header', async () => {
    const alice = await registerAccount(app, prisma);
    const bob = await registerAccount(app, prisma);

    const alpha = await createOrganization(alice, 'Alpha');
    await createOrganization(bob, 'Beta');

    await request(app.getHttpServer())
      .get('/${prefix}/${route}')
      .set('Authorization', \`Bearer \${bob.accessToken}\`)
      .set('X-Organization-Id', alpha)
      .expect(403);
  });
});
`;
}

export const organizationsRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const config = organizationsConfig(context.config);
    const userSoftDelete = context.entity(config.userEntity)?.softDelete === true;

    const files: RenderedFile[] = [
      file(
        "src/generated/organizations/guards/organization-context.guard.ts",
        CONTEXT_GUARD,
      ),
      file("src/generated/organizations/guards/organization-roles.guard.ts", ORG_ROLES_GUARD),
      file("src/generated/organizations/decorators/org-roles.decorator.ts", ORG_ROLES_DECORATOR),
      file("src/generated/organizations/dto/organization.dto.ts", dtoFile(config)),
      file("src/generated/organizations/organization.service.ts", serviceFile(config, config.userEntity, userSoftDelete)),
      file("src/generated/organizations/organization.controller.ts", controllerFile()),
      file("src/generated/organizations/organization.module.ts", ORG_MODULE),
      file("src/generated/organizations/organization.service.spec.ts", serviceSpec(config, userSoftDelete)),
      file("test/organizations.e2e-spec.ts", organizationsE2e(context)),
      file("test/tenant-isolation.e2e-spec.ts", isolationE2e(context)),
    ];

    return {
      ...emptyRenderResult(),
      files,
      rootModules: [
        {
          symbol: "OrganizationModule",
          from: "./generated/organizations/organization.module",
          kind: "module",
          order: 20,
        },
        {
          symbol: "OrganizationContextGuard",
          from: "./generated/organizations/guards/organization-context.guard",
          kind: "global-guard",
          // After JwtAuthGuard (10) so that request.user exists, before RolesGuard (20).
          order: 15,
        },
        {
          symbol: "OrganizationRolesGuard",
          from: "./generated/organizations/guards/organization-roles.guard",
          kind: "global-guard",
          // After the context guard so the caller's organization role is resolved.
          order: 16,
        },
      ],
    };
  },
};
