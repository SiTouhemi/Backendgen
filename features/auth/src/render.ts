import type { NormalizedEntity } from "@backend-compiler/compiler";
import {
  names,
  outputType,
  readableFields,
  validationDecorators,
  writableFields,
} from "@backend-compiler/target-nestjs-prisma";
import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import { authConfig, defaultRole, type AuthConfig } from "./config.js";

function file(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

const HASH_FILE = `import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque tokens are random 256-bit values. Only their SHA-256 digest is stored,
 * so a database disclosure does not reveal a usable token. Nothing here invents
 * a cryptographic primitive.
 */
export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
`;

const PASSWORD_SERVICE = `import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';

const BCRYPT_COST = 12;
const BCRYPT_MAX_BYTES = 72;

@Injectable()
export class PasswordService {
  /**
   * Compared against when no account matches, so that a failed login costs the
   * same time whether or not the email exists.
   */
  private readonly decoyHash = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST);

  hash(plain: string): Promise<string> {
    if (Buffer.byteLength(plain, 'utf8') > BCRYPT_MAX_BYTES) {
      throw new BadRequestException('Password is too long');
    }

    return bcrypt.hash(plain, BCRYPT_COST);
  }

  async verify(plain: string, hash: string | null): Promise<boolean> {
    if (Buffer.byteLength(plain, 'utf8') > BCRYPT_MAX_BYTES) {
      // Preserve the expensive comparison for unknown/invalid inputs without
      // allowing bcrypt's silent 72-byte truncation to authenticate a prefix.
      await bcrypt.compare('invalid-overlong-password', this.decoyHash);
      return false;
    }

    const matches = await bcrypt.compare(plain, hash ?? this.decoyHash);
    return hash !== null && matches;
  }
}
`;

function secretsFile(): string {
  return `import { loadEnvironment } from '../config/environment';

const MINIMUM_SECRET_LENGTH = 32;

/**
 * Reads the signing key and refuses to continue if it is missing or too short.
 * There is no default, and there is no fallback.
 */
export function requireAccessSecret(): string {
  const secret = loadEnvironment().JWT_ACCESS_SECRET;

  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      \`JWT_ACCESS_SECRET must be at least \${MINIMUM_SECRET_LENGTH} characters long\`,
    );
  }

  return secret;
}
`;
}

function tokenService(config: AuthConfig, user: NormalizedEntity): string {
  const delegate = names.delegate(user.name);

  return `import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { createOpaqueToken, digestToken } from './hash';

export const ACCESS_TOKEN_TTL_SECONDS = ${config.accessTokenTtlSeconds};
export const REFRESH_TOKEN_TTL_MS = ${config.refreshTokenTtlDays} * 24 * 60 * 60 * 1000;

export interface AccessTokenPayload {
  sub: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Refresh sessions are server-managed and rotate on every use. Presenting a
 * refresh token that has already been rotated is treated as theft: every session
 * belonging to that account is revoked.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async issue(account: { id: string }): Promise<TokenPair> {
    const material = await this.createTokenMaterial(account.id);

    await this.prisma.refreshSession.create({
      data: {
        tokenHash: material.tokenHash,
        userId: account.id,
        expiresAt: material.expiresAt,
      },
    });

    return material.pair;
  }

  async rotate(refreshToken: string): Promise<TokenPair> {
    const tokenHash = digestToken(refreshToken);
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (session === null) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.revokedAt !== null) {
      await this.revokeAllSessions(session.userId);
      throw new UnauthorizedException('Refresh token has already been used');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    const now = new Date();
    const replacement = await this.createTokenMaterial(session.user.id);
    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshSession.updateMany({
        where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now, replacedByHash: replacement.tokenHash },
      });

      if (claimed.count !== 1) {
        return false;
      }

      await tx.refreshSession.create({
        data: {
          tokenHash: replacement.tokenHash,
          userId: session.userId,
          expiresAt: replacement.expiresAt,
        },
      });
      return true;
    });

    if (!rotated) {
      await this.revokeAllSessions(session.userId);
      throw new UnauthorizedException('Refresh token has already been used');
    }

    return replacement.pair;
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { tokenHash: digestToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async findAccount(id: string): Promise<{ id: string; email: string; role: string } | null> {
    return this.prisma.${delegate}.findUnique({
      where: { id },
      select: { id: true, email: true, role: true },
    });
  }

  private async createTokenMaterial(userId: string): Promise<{
    pair: TokenPair;
    tokenHash: string;
    expiresAt: Date;
  }> {
    const payload: AccessTokenPayload = { sub: userId };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = createOpaqueToken();
    return {
      pair: { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS },
      tokenHash: digestToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    };
  }
}
`;
}

function jwtStrategy(user: NormalizedEntity): string {
  const delegate = names.delegate(user.name);

  return `import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { requireAccessSecret } from './secrets';
import { AccessTokenPayload } from './token.service';

export interface AuthenticatedUser {
  id: string;
  email: string;
  roles: string[];
  organizationId: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireAccessSecret(),
      algorithms: ['HS256'],
    });
  }

  /**
   * The role is re-read from the database on every request, so revoking a role
   * takes effect immediately instead of at the next token refresh.
   */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const account = await this.prisma.${delegate}.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true },
    });

    if (account === null) {
      throw new UnauthorizedException('Account no longer exists');
    }

    return {
      id: account.id,
      email: account.email,
      roles: [account.role],
      organizationId: null,
    };
  }
}
`;
}

const JWT_GUARD = `import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from '../../common/public.decorator';

/**
 * Registered globally: every route requires a valid access token unless it is
 * explicitly marked @Public(). Access is denied by default.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    return super.canActivate(context);
  }
}
`;

const ROLES_GUARD = `import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

interface RequestWithUser {
  user?: { roles?: string[] };
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required === undefined || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const roles = request.user?.roles ?? [];

    if (!roles.some((role) => required.includes(role))) {
      throw new ForbiddenException('Insufficient role for this operation');
    }

    return true;
  }
}
`;

const ROLES_DECORATOR = `import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'backendgen:roles';

/** Restricts a route to callers holding at least one of the listed roles. */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
`;

const CURRENT_USER_DECORATOR = `import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedUser } from '../jwt.strategy';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();

    if (request.user === undefined) {
      throw new UnauthorizedException('Authentication required');
    }

    return request.user;
  },
);
`;

function dtoFile(config: AuthConfig, user: NormalizedEntity): string {
  const extraFields = writableFields(user).filter((field) => field.name !== "email");
  const validators = new Set<string>(["IsEmail", "IsString", "MaxLength", "MinLength"]);
  const swagger = new Set<string>(["ApiProperty", "ApiPropertyOptional"]);
  const extra: string[] = [];

  for (const field of extraFields) {
    const validation = validationDecorators(user, field, { optional: !field.required });
    validation.validatorImports.forEach((symbol) => validators.add(symbol));
    validation.swaggerImports.forEach((symbol) => swagger.add(symbol));
    extra.push(
      ...validation.decorators.map((decorator) => `  ${decorator}`),
      `  ${field.name}${field.required ? "!" : "?"}: ${validation.type};`,
      "",
    );
  }

  const responseProperties = readableFields(user)
    .map((field) => {
      const type = outputType(user, field);
      const nullable = field.required ? "" : " | null";
      return `  @ApiProperty(${field.required ? "" : "{ nullable: true }"})\n  ${field.name}!: ${type}${nullable};\n`;
    })
    .join("\n");

  const responseMappings = readableFields(user)
    .map((field) => {
      if (field.type === "datetime" || field.type === "date") {
        return field.required
          ? `    ${field.name}: account.${field.name}.toISOString(),`
          : `    ${field.name}: account.${field.name} === null ? null : account.${field.name}.toISOString(),`;
      }
      if (field.type === "decimal") {
        return field.required
          ? `    ${field.name}: account.${field.name}.toString(),`
          : `    ${field.name}: account.${field.name} === null ? null : account.${field.name}.toString(),`;
      }
      return `    ${field.name}: account.${field.name},`;
    })
    .join("\n");

  const prismaTypes = [
    names.model(user.name),
    ...readableFields(user)
      .filter((field) => field.enumValues !== null)
      .map((field) => names.enumType(user.name, field.name)),
  ].sort();

  return `import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ${[...validators].sort().join(", ")} } from 'class-validator';
import type { ${prismaTypes.join(", ")} } from '@prisma/client';

export class RegisterDto {
  @ApiProperty({ maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: ${config.minPasswordLength}, maxLength: 72 })
  @IsString()
  @MinLength(${config.minPasswordLength})
  @MaxLength(72)
  password!: string;

${extra.join("\n").trimEnd()}
}

export class LoginDto {
  @ApiProperty({ maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ maxLength: 72 })
  @IsString()
  @MaxLength(72)
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  refreshToken!: string;
}

export class TokenDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  token!: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(256)
  token!: string;

  @ApiProperty({ minLength: ${config.minPasswordLength}, maxLength: 72 })
  @IsString()
  @MinLength(${config.minPasswordLength})
  @MaxLength(72)
  password!: string;
}

export class RequestPasswordResetDto {
  @ApiProperty({ maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class AccountDto {
  @ApiProperty()
  id!: string;

${responseProperties}
}

export class AuthResponseDto {
  @ApiProperty({ type: AccountDto })
  user!: AccountDto;

  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ description: 'Access token lifetime in seconds' })
  expiresIn!: number;
}

export function toAccount(account: ${names.model(user.name)}): AccountDto {
  return {
    id: account.id,
${responseMappings}
  };
}
`;
}

function authService(config: AuthConfig, user: NormalizedEntity): string {
  const model = names.model(user.name);
  const delegate = names.delegate(user.name);
  const extraFields = writableFields(user).filter((field) => field.name !== "email");

  const createFields = extraFields
    .map((field) =>
      field.required
        ? `        ${field.name}: dto.${field.name},`
        : `        ...(dto.${field.name} !== undefined ? { ${field.name}: dto.${field.name} } : {}),`,
    )
    .join("\n");

  const verificationMethods = config.emailVerification
    ? `
  /** Issues a single-use verification token and publishes it for delivery. */
  async requestEmailVerification(userId: string): Promise<void> {
    const account = await this.prisma.${delegate}.findUnique({ where: { id: userId } });

    if (account === null) {
      throw new UnauthorizedException('Account no longer exists');
    }

    const token = createOpaqueToken();

    await this.prisma.$transaction(async (tx) => {
      await tx.emailVerificationToken.deleteMany({
        where: { userId, consumedAt: null },
      });
      await tx.emailVerificationToken.create({
        data: {
          tokenHash: digestToken(token),
          userId,
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        },
      });
    });

    this.events.emit('user.email_verification_requested', {
      userId,
      email: account.email,
      token,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: digestToken(token) },
    });

    if (record === null || record.consumedAt !== null || record.expiresAt <= new Date()) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    const now = new Date();
    const consumed = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });

      if (claimed.count !== 1) {
        return false;
      }

      await tx.${delegate}.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: now },
      });
      return true;
    });

    if (!consumed) {
      throw new BadRequestException('Invalid or expired verification token');
    }
  }
`
    : "";

  const resetMethods = config.passwordReset
    ? `
  /**
   * Always resolves, whether or not the address exists, so that the endpoint
   * cannot be used to enumerate accounts.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const account = await this.prisma.${delegate}.findUnique({
      where: { email: normalizeEmail(email) },
    });

    if (account === null) {
      return;
    }

    const token = createOpaqueToken();

    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.deleteMany({
        where: { userId: account.id, consumedAt: null },
      });
      await tx.passwordResetToken.create({
        data: {
          tokenHash: digestToken(token),
          userId: account.id,
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        },
      });
    });

    this.events.emit('user.password_reset_requested', {
      userId: account.id,
      email: account.email,
      token,
    });
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: digestToken(token) },
    });

    if (record === null || record.consumedAt !== null || record.expiresAt <= new Date()) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const passwordHash = await this.passwords.hash(password);
    const now = new Date();
    const consumed = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });

      if (claimed.count !== 1) {
        return false;
      }

      await tx.${delegate}.update({
        where: { id: record.userId },
        data: { passwordHash },
      });
      return true;
    });

    if (!consumed) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // A password change invalidates every existing session.
    await this.tokens.revokeAllSessions(record.userId);
  }
`
    : "";

  const registerVerification = config.emailVerification
    ? "\n    await this.requestEmailVerification(account.id);\n"
    : "";

  return `import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { ${model} } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AccountDto,
  AuthResponseDto,
  LoginDto,
  RegisterDto,
  toAccount,
} from './dto/auth.dto';
import { createOpaqueToken, digestToken } from './hash';
import { PasswordService } from './password.service';
import { TokenPair, TokenService } from './token.service';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly events: EventEmitter2,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.${delegate}.findUnique({ where: { email } });

    if (existing !== null) {
      throw new ConflictException('An account with this email already exists');
    }

    const account = await this.prisma.${delegate}.create({
      data: {
        email,
        passwordHash: await this.passwords.hash(dto.password),
${createFields}
      },
    });

    this.events.emit('user.registered', { userId: account.id, email: account.email });
${registerVerification}
    const pair = await this.tokens.issue(account);
    return this.toResponse(account, pair);
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const account = await this.prisma.${delegate}.findUnique({
      where: { email: normalizeEmail(dto.email) },
    });
    const valid = await this.passwords.verify(dto.password, account?.passwordHash ?? null);

    if (account === null || !valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const pair = await this.tokens.issue(account);
    return this.toResponse(account, pair);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokens.rotate(refreshToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revoke(refreshToken);
  }

  async me(userId: string): Promise<AccountDto> {
    const account = await this.prisma.${delegate}.findUnique({ where: { id: userId } });

    if (account === null) {
      throw new UnauthorizedException('Account no longer exists');
    }

    return toAccount(account);
  }
${verificationMethods}${resetMethods}
  private toResponse(account: ${model}, pair: TokenPair): AuthResponseDto {
    return {
      user: toAccount(account),
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
    };
  }
}
`;
}

function authController(config: AuthConfig): string {
  const verification = config.emailVerification
    ? `
  @Post('request-email-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiAcceptedResponse({ description: 'A verification token was issued' })
  async requestEmailVerification(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.service.requestEmailVerification(user.id);
  }

  @Post('verify-email')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'The email address is verified' })
  async verifyEmail(@Body() dto: TokenDto): Promise<void> {
    await this.service.verifyEmail(dto.token);
  }
`
    : "";

  const reset = config.passwordReset
    ? `
  @Post('request-password-reset')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ description: 'Always accepted, whether or not the account exists' })
  async requestPasswordReset(@Body() dto: RequestPasswordResetDto): Promise<void> {
    await this.service.requestPasswordReset(dto.email);
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'The password was replaced and every session revoked' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.service.resetPassword(dto.token, dto.password);
  }
`
    : "";

  const resetImports = config.passwordReset
    ? "\n  RequestPasswordResetDto,\n  ResetPasswordDto,"
    : "";
  const verificationImports = config.emailVerification ? "\n  TokenDto," : "";

  return `import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiErrorDto } from '../common/api-error.dto';
import { Public } from '../common/public.decorator';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  AccountDto,
  AuthResponseDto,
  LoginDto,
  RefreshDto,
  RegisterDto,${resetImports}${verificationImports}
} from './dto/auth.dto';
import { AuthenticatedUser } from './jwt.strategy';
import { TokenPair } from './token.service';

/**
 * Every route here is rate limited: ${config.rateLimit.limit} requests per
 * ${config.rateLimit.ttlSeconds} seconds per client.
 */
@ApiTags('auth')
@ApiTooManyRequestsResponse({ type: ApiErrorDto })
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: ${config.rateLimit.limit}, ttl: ${config.rateLimit.ttlSeconds * 1000} } })
@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Post('register')
  @Public()
  @ApiCreatedResponse({ type: AuthResponseDto })
  register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.service.register(dto);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.service.login(dto);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'A rotated token pair' })
  @ApiUnauthorizedResponse({ type: ApiErrorDto })
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.service.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'The refresh session is revoked' })
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.service.logout(dto.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: AccountDto })
  me(@CurrentUser() user: AuthenticatedUser): Promise<AccountDto> {
    return this.service.me(user.id);
  }
${verification}${reset}}
`;
}

function authModule(config: AuthConfig): string {
  return `import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PasswordService } from './password.service';
import { requireAccessSecret } from './secrets';
import { ACCESS_TOKEN_TTL_SECONDS, TokenService } from './token.service';

@Module({
  imports: [
    PassportModule,
    ThrottlerModule.forRoot([
      { ttl: ${config.rateLimit.ttlSeconds * 1000}, limit: ${config.rateLimit.limit} },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: requireAccessSecret(),
        signOptions: { expiresIn: ACCESS_TOKEN_TTL_SECONDS, algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, JwtStrategy],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
`;
}

function authServiceSpec(user: NormalizedEntity): string {
  const delegate = names.delegate(user.name);

  return `import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

describe('AuthService', () => {
  const accounts = {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };

  const prisma = {
    ${delegate}: accounts,
    emailVerificationToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    passwordResetToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  };

  const passwords = { hash: jest.fn(), verify: jest.fn() };
  const tokens = {
    issue: jest.fn(),
    rotate: jest.fn(),
    revoke: jest.fn(),
    revokeAllSessions: jest.fn(),
  };

  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwords },
        { provide: TokenService, useValue: tokens },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('refuses to register an email that already exists', async () => {
    accounts.findUnique.mockResolvedValue({ id: 'existing' });

    await expect(
      service.register({ email: 'taken@example.test', password: 'a-long-password' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a login with an unknown email without revealing that it is unknown', async () => {
    accounts.findUnique.mockResolvedValue(null);
    passwords.verify.mockResolvedValue(false);

    await expect(
      service.login({ email: 'nobody@example.test', password: 'a-long-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // The password is still compared, so the response time does not leak existence.
    expect(passwords.verify).toHaveBeenCalledWith('a-long-password', null);
  });

  it('rejects a login with a wrong password', async () => {
    accounts.findUnique.mockResolvedValue({ id: 'u1', email: 'a@example.test', passwordHash: 'hash' });
    passwords.verify.mockResolvedValue(false);

    await expect(
      service.login({ email: 'a@example.test', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
  });
});
`;
}

function authHelper(config: AuthConfig, user: NormalizedEntity, context: TargetRenderContext): string {
  const delegate = names.delegate(user.name);
  const prefix = context.settings.apiPrefix;
  const extras = writableFields(user)
    .filter((field) => field.name !== "email" && field.required)
    .map((field) => {
      switch (field.type) {
        case "integer":
        case "decimal":
          return `    ${field.name}: 1,`;
        case "boolean":
          return `    ${field.name}: false,`;
        case "datetime":
        case "date":
          return `    ${field.name}: new Date().toISOString(),`;
        default:
          return `    ${field.name}: uniqueString(10),`;
      }
    })
    .join("\n");

  return `import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../../src/generated/prisma/prisma.service';
import { uniqueString } from './test-app';

export const TEST_PASSWORD = 'test-password-${config.minPasswordLength}-chars';

export interface TestAccount {
  email: string;
  password: string;
  id: string;
  accessToken: string;
  refreshToken: string;
}

/** Registers an account, optionally elevates its role, and logs it in. */
export async function registerAccount(
  app: INestApplication,
  prisma: PrismaService,
  options: { role?: string } = {},
): Promise<TestAccount> {
  const email = \`user-\${randomUUID()}@example.test\`;

  const registered = await request(app.getHttpServer())
    .post('/${prefix}/auth/register')
    .send({
      email,
      password: TEST_PASSWORD,
${extras}
    })
    .expect(201);

  const id = registered.body.user.id as string;

  if (options.role !== undefined) {
    await prisma.${delegate}.update({ where: { id }, data: { role: options.role as never } });
  }

  const loggedIn = await request(app.getHttpServer())
    .post('/${prefix}/auth/login')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);

  return {
    email,
    password: TEST_PASSWORD,
    id,
    accessToken: loggedIn.body.accessToken as string,
    refreshToken: loggedIn.body.refreshToken as string,
  };
}

export async function authHeaders(
  app: INestApplication,
  prisma: PrismaService,
  options: { role?: string } = {},
): Promise<Record<string, string>> {
  const account = await registerAccount(app, prisma, options);
  return { Authorization: \`Bearer \${account.accessToken}\` };
}
`;
}

function authE2e(config: AuthConfig, context: TargetRenderContext): string {
  const prefix = context.settings.apiPrefix;

  return `import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { registerAccount, TEST_PASSWORD } from './utils/auth-helper';
import { resetDatabase } from './utils/reset';
import { createTestApp } from './utils/test-app';

describe('Authentication (e2e)', () => {
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

  it('registers, logs in and returns the authenticated account', async () => {
    const account = await registerAccount(app, prisma);

    const me = await request(app.getHttpServer())
      .get('/${prefix}/auth/me')
      .set('Authorization', \`Bearer \${account.accessToken}\`)
      .expect(200);

    expect(me.body.email).toBe(account.email);
    expect(me.body.passwordHash).toBeUndefined();
  });

  it('refuses an anonymous request to a protected route', async () => {
    await request(app.getHttpServer()).get('/${prefix}/auth/me').expect(401);
  });

  it('refuses a login with the wrong password', async () => {
    const account = await registerAccount(app, prisma);

    await request(app.getHttpServer())
      .post('/${prefix}/auth/login')
      .send({ email: account.email, password: \`wrong-\${TEST_PASSWORD}\` })
      .expect(401);
  });

  it('rotates the refresh token and rejects the old one', async () => {
    const account = await registerAccount(app, prisma);

    const rotated = await request(app.getHttpServer())
      .post('/${prefix}/auth/refresh')
      .send({ refreshToken: account.refreshToken })
      .expect(200);

    expect(rotated.body.refreshToken).not.toBe(account.refreshToken);

    // Re-using a rotated token is treated as theft.
    await request(app.getHttpServer())
      .post('/${prefix}/auth/refresh')
      .send({ refreshToken: account.refreshToken })
      .expect(401);

    // ...which also revokes the session that replaced it.
    await request(app.getHttpServer())
      .post('/${prefix}/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
  });

  it('revokes the session on logout', async () => {
    const account = await registerAccount(app, prisma);

    await request(app.getHttpServer())
      .post('/${prefix}/auth/logout')
      .set('Authorization', \`Bearer \${account.accessToken}\`)
      .send({ refreshToken: account.refreshToken })
      .expect(204);

    await request(app.getHttpServer())
      .post('/${prefix}/auth/refresh')
      .send({ refreshToken: account.refreshToken })
      .expect(401);
  });

  it('never stores the password in clear text', async () => {
    const account = await registerAccount(app, prisma);
    const stored = await prisma.${names.delegate(context.entity(config.userEntity).name)}.findUnique({
      where: { id: account.id },
    });

    expect(stored?.passwordHash).toBeDefined();
    expect(stored?.passwordHash).not.toBe(TEST_PASSWORD);
  });
});
`;
}

export const authRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const config = authConfig(context.config);
    const user = context.entity(config.userEntity);

    const files: RenderedFile[] = [
      file("src/generated/auth/hash.ts", HASH_FILE),
      file("src/generated/auth/secrets.ts", secretsFile()),
      file("src/generated/auth/password.service.ts", PASSWORD_SERVICE),
      file("src/generated/auth/token.service.ts", tokenService(config, user)),
      file("src/generated/auth/jwt.strategy.ts", jwtStrategy(user)),
      file("src/generated/auth/guards/jwt-auth.guard.ts", JWT_GUARD),
      file("src/generated/auth/guards/roles.guard.ts", ROLES_GUARD),
      file("src/generated/auth/decorators/roles.decorator.ts", ROLES_DECORATOR),
      file("src/generated/auth/decorators/current-user.decorator.ts", CURRENT_USER_DECORATOR),
      file("src/generated/auth/dto/auth.dto.ts", dtoFile(config, user)),
      file("src/generated/auth/auth.service.ts", authService(config, user)),
      file("src/generated/auth/auth.controller.ts", authController(config)),
      file("src/generated/auth/auth.module.ts", authModule(config)),
      file("src/generated/auth/auth.service.spec.ts", authServiceSpec(user)),
      file("test/utils/auth-helper.ts", authHelper(config, user, context)),
      file("test/auth.e2e-spec.ts", authE2e(config, context)),
    ];

    return {
      ...emptyRenderResult(),
      files,
      rootModules: [
        { symbol: "AuthModule", from: "./generated/auth/auth.module", kind: "module", order: 10 },
        {
          symbol: "JwtAuthGuard",
          from: "./generated/auth/guards/jwt-auth.guard",
          kind: "global-guard",
          order: 10,
        },
        {
          symbol: "RolesGuard",
          from: "./generated/auth/guards/roles.guard",
          kind: "global-guard",
          order: 20,
        },
      ],
      packageDependencies: {
        "@nestjs/jwt": "11.0.2",
        "@nestjs/passport": "11.0.5",
        "@nestjs/throttler": "6.5.0",
        bcryptjs: "3.0.3",
        passport: "0.7.0",
        "passport-jwt": "4.0.1",
      },
      packageDevDependencies: {
        "@types/passport-jwt": "4.0.1",
      },
      envExample: [
        {
          name: "JWT_ACCESS_SECRET",
          value: '"replace-with-a-random-secret-of-at-least-32-characters"',
          comment:
            "HMAC key for access tokens. Minimum 32 characters. The application refuses to start without it.",
        },
      ],
      testEnv: {
        JWT_ACCESS_SECRET: "test-only-jwt-secret-with-at-least-32-characters",
      },
    };
  },
};
