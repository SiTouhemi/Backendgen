import type { NormalizedEntity } from "@backend-compiler/compiler";
import { names, postgresIdentifier } from "@backend-compiler/target-nestjs-prisma";
import {
  emptyRenderResult,
  type FeatureTargetRenderer,
  type RenderResult,
  type RenderedFile,
  type TargetRenderContext,
} from "@backend-compiler/target-sdk";
import { holdsEnabled, reservationsConfig, type ReservationsConfig } from "./feature.js";

function file(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "generated" };
}

function scaffold(path: string, contents: string): RenderedFile {
  return { path, contents, ownership: "custom-scaffold" };
}

function constraintName(entity: string): string {
  return postgresIdentifier(`${entity}_no_overlap`);
}

function hasNotificationEvent(context: TargetRenderContext, event: string): boolean {
  const events = context.featureConfig("notifications")?.events;
  return Array.isArray(events) && events.includes(event);
}

/**
 * The exclusion constraint is the whole point of the feature: it makes an
 * overlapping pair of reservations unrepresentable, so two concurrent writers
 * cannot both win regardless of what the application does.
 */
function overlapSql(config: ReservationsConfig): string[] {
  if (!config.preventOverlap) {
    return [];
  }

  return [
    `-- Reservations: database-enforced overlap prevention.
-- btree_gist lets a GiST index combine an equality predicate on a text column
-- with a range overlap predicate in one exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "${config.entity}"
  ADD CONSTRAINT "${constraintName(config.entity)}"
  EXCLUDE USING gist (
    "resourceId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE (status IN ('HELD', 'CONFIRMED'));`,
  ];
}

function policyFile(config: ReservationsConfig): string {
  return `import { Injectable } from '@nestjs/common';

export const CANCELLATION_WINDOW_MINUTES = ${config.cancellationWindowMinutes};

export interface ReservationRequest {
  resourceId: string;
  ownerId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface ReservationSnapshot {
  status: string;
  startsAt: Date;
}

/**
 * The extension seam for reservation rules. Implement this in
 * \`src/custom/reservation-policy.ts\`, provide it in CustomModule under the
 * CUSTOM_RESERVATION_POLICY token, and the generated service will use it instead
 * of the default. Nothing in \`src/generated/\` needs to change.
 */
export interface ReservationPolicy {
  /** Throw to reject a request, for example on a blackout date. */
  validateRequest(request: ReservationRequest): Promise<void> | void;
  /** Return false to refuse a cancellation. */
  canCancel(reservation: ReservationSnapshot, now: Date): boolean;
}

export const RESERVATION_POLICY = Symbol.for('backendgen:ReservationPolicy');

/** Token the custom module provides to override the default policy. */
export const CUSTOM_RESERVATION_POLICY = Symbol.for('backendgen:CustomReservationPolicy');

@Injectable()
export class DefaultReservationPolicy implements ReservationPolicy {
  validateRequest(): void {
    // The default policy adds no rules beyond the interval and availability
    // checks the service already performs.
  }

  canCancel(reservation: ReservationSnapshot, now: Date): boolean {
    if (CANCELLATION_WINDOW_MINUTES === 0) {
      return true;
    }

    const noticeMs = reservation.startsAt.getTime() - now.getTime();
    return noticeMs >= CANCELLATION_WINDOW_MINUTES * 60_000;
  }
}
`;
}

const CUSTOM_POLICY_SCAFFOLD = `import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ReservationPolicy,
  ReservationRequest,
  ReservationSnapshot,
} from '../generated/reservations/reservation-policy';

/**
 * Your reservation rules. This file is written once and never regenerated.
 *
 * To activate it, add the provider to src/custom/custom.module.ts:
 *
 *   import { CUSTOM_RESERVATION_POLICY } from '../generated/reservations/reservation-policy';
 *   import { CustomReservationPolicy } from './reservation-policy';
 *
 *   @Module({
 *     providers: [{ provide: CUSTOM_RESERVATION_POLICY, useClass: CustomReservationPolicy }],
 *     exports: [CUSTOM_RESERVATION_POLICY],
 *   })
 *   export class CustomModule {}
 */
@Injectable()
export class CustomReservationPolicy implements ReservationPolicy {
  validateRequest(request: ReservationRequest): void {
    // Example: refuse reservations that start in the past.
    if (request.startsAt.getTime() < Date.now()) {
      throw new BadRequestException('A reservation cannot start in the past');
    }
  }

  canCancel(_reservation: ReservationSnapshot, _now: Date): boolean {
    return true;
  }
}
`;

function dtoFile(config: ReservationsConfig, reservation: NormalizedEntity): string {
  const tenant = reservation.tenant !== null;
  const model = names.model(config.entity);

  return `import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import type { ${model} } from '@prisma/client';
import { PaginationQueryDto } from '../../common/pagination';

export const RESERVATION_STATUSES = ['HELD', 'CONFIRMED', 'CANCELLED', 'EXPIRED'] as const;

export class Create${model}Dto {
  @ApiProperty({ description: 'Identifier of the ${config.resource} to reserve' })
  @IsString()
  @MaxLength(128)
  resourceId!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Inclusive start. Send an ISO-8601 instant with an offset, for example 2025-01-01T10:00:00Z.',
  })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Exclusive end. An interval ending exactly when another begins does not overlap.',
  })
  @IsISO8601()
  endsAt!: string;
}

export class Availability${model}QueryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  resourceId!: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601()
  endsAt!: string;
}

export class Query${model}Dto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RESERVATION_STATUSES })
  @IsOptional()
  @IsIn(RESERVATION_STATUSES)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  resourceId?: string;
}

export class AvailabilityDto {
  @ApiProperty() available!: boolean;
  @ApiProperty({ description: 'Number of active reservations overlapping the interval' })
  conflicts!: number;
}

export class ${model}Dto {
  @ApiProperty() id!: string;
  @ApiProperty() resourceId!: string;
  @ApiProperty() ownerId!: string;${tenant ? "\n  @ApiProperty() organizationId!: string;" : ""}
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty({ enum: RESERVATION_STATUSES }) status!: string;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) holdExpiresAt!: string | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) confirmedAt!: string | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) cancelledAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export function to${model}(reservation: ${model}): ${model}Dto {
  return {
    id: reservation.id,
    resourceId: reservation.resourceId,
    ownerId: reservation.ownerId,${tenant ? "\n    organizationId: reservation.organizationId," : ""}
    startsAt: reservation.startsAt.toISOString(),
    endsAt: reservation.endsAt.toISOString(),
    status: reservation.status,
    holdExpiresAt:
      reservation.holdExpiresAt === null ? null : reservation.holdExpiresAt.toISOString(),
    confirmedAt: reservation.confirmedAt === null ? null : reservation.confirmedAt.toISOString(),
    cancelledAt: reservation.cancelledAt === null ? null : reservation.cancelledAt.toISOString(),
    createdAt: reservation.createdAt.toISOString(),
  };
}
`;
}

function serviceFile(
  config: ReservationsConfig,
  reservation: NormalizedEntity,
  resource: NormalizedEntity,
  context: TargetRenderContext,
): string {
  const model = names.model(config.entity);
  const delegate = names.delegate(config.entity);
  const resourceModel = names.model(config.resource);
  const resourceDelegate = names.delegate(config.resource);
  const statusEnum = names.enumType(config.entity, "status");
  const holds = holdsEnabled(config);
  const tenant = reservation.tenant !== null;
  const notifyCreated = hasNotificationEvent(context, "reservation_created");
  const notifyConfirmed = hasNotificationEvent(context, "reservation_confirmed");
  const notifyCancelled = hasNotificationEvent(context, "reservation_cancelled");
  const notifyExpired = hasNotificationEvent(context, "reservation_expired");
  const usesOutbox = notifyCreated || notifyConfirmed || notifyCancelled || notifyExpired;
  const crud = context.featureConfig("crud") as { adminRoles?: unknown } | undefined;
  const auth = context.featureConfig("auth") as
    | { roles?: string[]; defaultRole?: string }
    | undefined;
  const accountRoles = auth?.roles ?? ["admin", "user"];
  const registrationRole = auth?.defaultRole ?? accountRoles.at(-1) ?? "user";
  const adminRoles = Array.isArray(crud?.adminRoles)
    ? crud.adminRoles.filter((role): role is string => typeof role === "string")
    : accountRoles.filter((role) => role !== registrationRole).slice(0, 1);

  const scopeImports = ["RequestScope", "isAdmin", "requireUser"];
  if (tenant) scopeImports.push("requireOrganization");

  const resourceFilters = [
    "id: resourceId,",
    ...(resource.softDelete ? ["deletedAt: null,"] : []),
    ...(resource.tenant !== null ? [`${resource.tenant.foreignKey}: organizationId,`] : []),
    ...(resource.ownership !== null
      ? [
          `...(isAdmin(scope, ADMIN_ROLES) ? {} : { ${resource.ownership.foreignKey}: ownerId }),`,
        ]
      : []),
  ];

  return `import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, ${statusEnum} } from '@prisma/client';
import { Page, toPage } from '../common/pagination';
import { ${scopeImports.sort().join(", ")} } from '../common/scope';
${usesOutbox ? "import { enqueueNotification } from '../notifications/outbox';\n" : ""}import { PrismaService } from '../prisma/prisma.service';
import {
  Availability${model}QueryDto,
  AvailabilityDto,
  Create${model}Dto,
  Query${model}Dto,
  ${model}Dto,
  to${model},
} from './dto/reservation.dto';
import { RESERVATION_POLICY, ReservationPolicy } from './reservation-policy';

const ADMIN_ROLES = ${JSON.stringify(adminRoles)};
${holds ? `const HOLD_MINUTES = ${config.holdMinutes};\n` : ""}const MIN_DURATION_MS = ${config.minDurationMinutes} * 60_000;
const MAX_DURATION_MS = ${config.maxDurationMinutes} * 60_000;
const OVERLAP_CONSTRAINT = '${constraintName(config.entity)}';

/** Statuses that occupy the interval. Anything else releases it. */
const ACTIVE_STATUSES: ${statusEnum}[] = ['HELD', 'CONFIRMED'];

/**
 * PostgreSQL raises SQLSTATE 23P01 when an exclusion constraint is violated.
 * That is the only signal that reliably distinguishes "someone else won the
 * race" from any other failure, so it is matched explicitly rather than inferred
 * from a prior availability read.
 */
function isOverlapViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('23P01') || message.includes(OVERLAP_CONSTRAINT);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Canonical digest of the semantic reservation request. Scope and owner are
 * enforced separately by the unique key, so only request fields belong here.
 */
function fingerprintRequest(resourceId: string, startsAt: Date, endsAt: Date): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        resourceId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      }),
    )
    .digest('hex');
}

/**
 * All timestamps are handled as UTC instants. The API accepts ISO-8601 strings
 * that carry an offset and stores the resulting instant; it never interprets a
 * wall-clock time in a server-local zone.
 */
@Injectable()
export class ${model}Service {
  private readonly logger = new Logger(${model}Service.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    @Inject(RESERVATION_POLICY) private readonly policy: ReservationPolicy,
  ) {}

  async create(
    dto: Create${model}Dto,
    scope: RequestScope,
    idempotencyKey?: string,
  ): Promise<${model}Dto> {
    const ownerId = requireUser(scope);${tenant ? "\n    const organizationId = requireOrganization(scope);" : ""}

    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      throw new BadRequestException(
        'Idempotency-Key must be 1-128 letters, numbers, dots, underscores, colons, or hyphens',
      );
    }

    const resourceId = dto.resourceId;
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    this.assertValidInterval(startsAt, endsAt);

    const requestFingerprint = fingerprintRequest(resourceId, startsAt, endsAt);
    const idempotencyWhere: Prisma.${model}WhereInput = {
      ownerId,${tenant ? "\n      organizationId," : ""}
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };

    if (idempotencyKey !== undefined) {
      const replayed = await this.prisma.${delegate}.findFirst({
        where: idempotencyWhere,
      });

      if (replayed !== null) {
        if (replayed.requestFingerprint !== requestFingerprint) {
          throw new ConflictException(
            'That idempotency key was already used for a different reservation request',
          );
        }
        return to${model}(replayed);
      }
    }

    const resource = await this.prisma.${resourceDelegate}.findFirst({
      where: {
        ${resourceFilters.join("\n        ")}
      },
      select: { id: true },
    });

    if (resource === null) {
      throw new NotFoundException('${resourceModel} not found');
    }

    // Resource ownership is established before either custom policy execution
    // or hold cleanup, preventing a caller from affecting another tenant by
    // submitting a foreign resource id.
    await this.policy.validateRequest({ resourceId, ownerId, startsAt, endsAt });

    // Release holds that have timed out, so their intervals stop blocking this
    // request. The scheduled job does the same thing; doing it here as well
    // means a request never has to wait for the next tick.
    await this.expireHolds(resourceId);

    const status = ${holds ? "'HELD'" : "'CONFIRMED'"} as const;

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const reservation = await tx.${delegate}.create({
          data: {
            resourceId,
            ownerId,${tenant ? "\n            organizationId," : ""}
            startsAt,
            endsAt,
            status,${
              holds
                ? "\n            holdExpiresAt: new Date(Date.now() + HOLD_MINUTES * 60_000),"
                : "\n            confirmedAt: new Date(),"
            }
            ...(idempotencyKey !== undefined
              ? { idempotencyKey, requestFingerprint }
              : {}),
          },
        });

${
  notifyCreated
    ? `        await enqueueNotification(tx, 'reservation.created', {
          reservationId: reservation.id,
          resourceId: reservation.resourceId,
          ownerId: reservation.ownerId,
          status: reservation.status,
        });
`
    : ""
}${
  !holds && notifyConfirmed
    ? `        await enqueueNotification(tx, 'reservation.confirmed', {
          reservationId: reservation.id,
          resourceId: reservation.resourceId,
          ownerId: reservation.ownerId,
        });
`
    : ""
}        return reservation;
      });

      this.events.emit('reservation.created', {
        reservationId: created.id,
        resourceId: created.resourceId,
        ownerId: created.ownerId,
        status: created.status,
      });
${
  holds
    ? ""
    : `
      this.events.emit('reservation.confirmed', {
        reservationId: created.id,
        resourceId: created.resourceId,
        ownerId: created.ownerId,
        startsAt: created.startsAt.toISOString(),
        endsAt: created.endsAt.toISOString(),
      });
`
}
      return to${model}(created);
    } catch (error) {
      if (isOverlapViolation(error)) {
        throw new ConflictException('That ${resourceModel} is already reserved for part of this interval');
      }

      // Two identical requests raced on the same idempotency key: the loser
      // returns what the winner created rather than an error.
      if (isUniqueViolation(error) && idempotencyKey !== undefined) {
        const existing = await this.prisma.${delegate}.findFirst({
          where: idempotencyWhere,
        });

        if (existing !== null) {
          if (existing.requestFingerprint !== requestFingerprint) {
            throw new ConflictException(
              'That idempotency key was already used for a different reservation request',
            );
          }
          return to${model}(existing);
        }

        throw new ConflictException('That idempotency key is already in use');
      }

      throw error;
    }
  }

  async availability(
    query: Availability${model}QueryDto,
    scope: RequestScope,
  ): Promise<AvailabilityDto> {${tenant ? "\n    const organizationId = requireOrganization(scope);" : ""}${resource.ownership !== null ? "\n    const ownerId = requireUser(scope);" : tenant ? "" : "\n    void scope;"}
    const resourceId = query.resourceId;
    const startsAt = new Date(query.startsAt);
    const endsAt = new Date(query.endsAt);
    this.assertValidInterval(startsAt, endsAt);

    const resource = await this.prisma.${resourceDelegate}.findFirst({
      where: {
        ${resourceFilters.join("\n        ")}
      },
      select: { id: true },
    });

    if (resource === null) {
      throw new NotFoundException('${resourceModel} not found');
    }

    await this.expireHolds(resourceId);

    const conflicts = await this.prisma.${delegate}.count({
      where: {
        resourceId,${tenant ? "\n        organizationId," : ""}
        status: { in: ACTIVE_STATUSES },
        // Half-open intervals: [a, b) and [b, c) do not overlap.
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });

    return { available: conflicts === 0, conflicts };
  }

  async findMany(query: Query${model}Dto, scope: RequestScope): Promise<Page<${model}Dto>> {
    const where = this.scopedWhere({}, scope);

    if (query.status !== undefined) {
      where.status = query.status as ${statusEnum};
    }

    if (query.resourceId !== undefined) {
      where.resourceId = query.resourceId;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.${delegate}.count({ where }),
      this.prisma.${delegate}.findMany({
        where,
        orderBy: [{ startsAt: query.order }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return toPage(rows.map(to${model}), total, query.page, query.pageSize);
  }

  async findOne(id: string, scope: RequestScope): Promise<${model}Dto> {
    return to${model}(await this.require(id, scope));
  }

  async confirm(id: string, scope: RequestScope): Promise<${model}Dto> {
    const reservation = await this.require(id, scope);
    const now = new Date();

    if (reservation.status !== 'HELD') {
      throw new ConflictException(
        \`A reservation in state \${reservation.status} cannot be confirmed\`,
      );
    }

    if (reservation.holdExpiresAt !== null && reservation.holdExpiresAt <= now) {
      await this.expireHolds(reservation.resourceId);
      throw new ConflictException('The hold on this reservation has expired');
    }

    const confirmed = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.${delegate}.updateManyAndReturn({
        where: this.scopedWhere(
          {
            id,
            status: 'HELD',
            OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: now } }],
          },
          scope,
        ),
        data: { status: 'CONFIRMED', confirmedAt: now, holdExpiresAt: null },
      });

      if (row === undefined) {
        return undefined;
      }
${
  notifyConfirmed
    ? `
      await enqueueNotification(tx, 'reservation.confirmed', {
        reservationId: row.id,
        resourceId: row.resourceId,
        ownerId: row.ownerId,
      });
`
    : ""
}
      return row;
    });

    if (confirmed === undefined) {
      throw new ConflictException('The reservation changed before it could be confirmed');
    }

    this.events.emit('reservation.confirmed', {
      reservationId: confirmed.id,
      resourceId: confirmed.resourceId,
      ownerId: confirmed.ownerId,
      startsAt: confirmed.startsAt.toISOString(),
      endsAt: confirmed.endsAt.toISOString(),
    });

    return to${model}(confirmed);
  }

  async cancel(id: string, scope: RequestScope): Promise<${model}Dto> {
    const reservation = await this.require(id, scope);

    if (reservation.status !== 'HELD' && reservation.status !== 'CONFIRMED') {
      throw new ConflictException(
        \`A reservation in state \${reservation.status} cannot be cancelled\`,
      );
    }

    if (!this.policy.canCancel(reservation, new Date())) {
      throw new ConflictException('This reservation can no longer be cancelled');
    }

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.${delegate}.updateManyAndReturn({
        where: this.scopedWhere({ id, status: { in: ['HELD', 'CONFIRMED'] } }, scope),
        data: { status: 'CANCELLED', cancelledAt: new Date(), holdExpiresAt: null },
      });

      if (row === undefined) {
        return undefined;
      }
${
  notifyCancelled
    ? `
      await enqueueNotification(tx, 'reservation.cancelled', {
        reservationId: row.id,
        resourceId: row.resourceId,
        ownerId: row.ownerId,
      });
`
    : ""
}
      return row;
    });

    if (cancelled === undefined) {
      throw new ConflictException('The reservation changed before it could be cancelled');
    }

    this.events.emit('reservation.cancelled', {
      reservationId: cancelled.id,
      resourceId: cancelled.resourceId,
      ownerId: cancelled.ownerId,
    });

    return to${model}(cancelled);
  }

  /**
   * Moves every timed-out hold to EXPIRED in bounded batches. Each update still
   * predicates on HELD, so multiple workers can drain concurrently without
   * emitting duplicate state transitions.
   */
  async expireHolds(resourceId?: string): Promise<number> {
    let total = 0;

    for (;;) {
      const now = new Date();
      const batch = await this.prisma.$transaction(async (tx) => {
        const candidates = await tx.${delegate}.findMany({
          where: {
            status: 'HELD',
            holdExpiresAt: { lte: now },
            ...(resourceId !== undefined ? { resourceId } : {}),
          },
          select: { id: true },
          orderBy: [{ holdExpiresAt: 'asc' }, { id: 'asc' }],
          take: 100,
        });

        if (candidates.length === 0) {
          return { candidates: 0, rows: [] };
        }

        const rows = await tx.${delegate}.updateManyAndReturn({
          where: {
            id: { in: candidates.map((row) => row.id) },
            status: 'HELD',
            holdExpiresAt: { lte: now },
          },
          data: { status: 'EXPIRED', holdExpiresAt: null },
          select: { id: true, resourceId: true, ownerId: true },
        });

${
  notifyExpired
    ? `        for (const row of rows) {
          await enqueueNotification(tx, 'reservation.expired', {
            reservationId: row.id,
            resourceId: row.resourceId,
            ownerId: row.ownerId,
          });
        }
`
    : ""
}

        return { candidates: candidates.length, rows };
      });

      for (const row of batch.rows) {
        this.events.emit('reservation.expired', {
          reservationId: row.id,
          resourceId: row.resourceId,
          ownerId: row.ownerId,
        });
      }

      total += batch.rows.length;
      if (batch.candidates === 0) {
        break;
      }
    }

    if (total > 0) {
      this.logger.log(\`Expired \${total} hold(s)\`);
    }
    return total;
  }

  private assertValidInterval(startsAt: Date, endsAt: Date): void {
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('startsAt and endsAt must be ISO-8601 instants');
    }

    const duration = endsAt.getTime() - startsAt.getTime();

    if (duration <= 0) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    if (duration < MIN_DURATION_MS) {
      throw new BadRequestException(
        \`A reservation must last at least \${MIN_DURATION_MS / 60_000} minute(s)\`,
      );
    }

    if (duration > MAX_DURATION_MS) {
      throw new BadRequestException(
        \`A reservation cannot last longer than \${MAX_DURATION_MS / 60_000} minute(s)\`,
      );
    }
  }

  private async require(id: string, scope: RequestScope) {
    if (id.length === 0 || id.length > 128) {
      throw new BadRequestException('Invalid reservation identifier');
    }

    const reservation = await this.prisma.${delegate}.findFirst({
      where: this.scopedWhere({ id }, scope),
    });

    if (reservation === null) {
      throw new NotFoundException('${model} not found');
    }

    return reservation;
  }

  private scopedWhere(
    where: Prisma.${model}WhereInput,
    scope: RequestScope,
  ): Prisma.${model}WhereInput {
    const scoped: Prisma.${model}WhereInput = { ...where };
${tenant ? "\n    scoped.organizationId = requireOrganization(scope);\n" : ""}
    if (!isAdmin(scope, ADMIN_ROLES)) {
      scoped.ownerId = requireUser(scope);
    }

    return scoped;
  }
}
`;
}

function controllerFile(config: ReservationsConfig, reservation: NormalizedEntity): string {
  const model = names.model(config.entity);
  void reservation;
  const confirmRoute = holdsEnabled(config)
    ? `
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ${model}Dto })
  confirm(
    @Param('id') id: string,
    @CurrentScope() scope: RequestScope,
  ): Promise<${model}Dto> {
    return this.service.confirm(id, scope);
  }
`
    : "";

  return `import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorDto } from '../common/api-error.dto';
import { ApiPaginatedResponse, Page } from '../common/pagination';
import { CurrentScope, RequestScope } from '../common/scope';
import {
  Availability${model}QueryDto,
  AvailabilityDto,
  Create${model}Dto,
  Query${model}Dto,
  ${model}Dto,
} from './dto/reservation.dto';
import { ${model}Service } from './reservation.service';

@ApiTags('reservations')
@ApiBearerAuth()
@ApiConflictResponse({ type: ApiErrorDto })
@Controller('reservations')
export class ${model}Controller {
  constructor(private readonly service: ${model}Service) {}

  // Declared before ':id' so that 'availability' is not read as an identifier.
  @Get('availability')
  @ApiOkResponse({ type: AvailabilityDto })
  availability(
    @Query() query: Availability${model}QueryDto,
    @CurrentScope() scope: RequestScope,
  ): Promise<AvailabilityDto> {
    return this.service.availability(query, scope);
  }

  @Post()
  @ApiCreatedResponse({ type: ${model}Dto })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Repeat the same key to retry safely: the original reservation is returned instead of a second one being created.',
  })
  create(
    @Body() dto: Create${model}Dto,
    @CurrentScope() scope: RequestScope,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<${model}Dto> {
    return this.service.create(dto, scope, idempotencyKey);
  }

  @Get()
  @ApiPaginatedResponse(${model}Dto)
  findMany(
    @Query() query: Query${model}Dto,
    @CurrentScope() scope: RequestScope,
  ): Promise<Page<${model}Dto>> {
    return this.service.findMany(query, scope);
  }

  @Get(':id')
  @ApiOkResponse({ type: ${model}Dto })
  findOne(
    @Param('id') id: string,
    @CurrentScope() scope: RequestScope,
  ): Promise<${model}Dto> {
    return this.service.findOne(id, scope);
  }

${confirmRoute}
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ${model}Dto })
  cancel(
    @Param('id') id: string,
    @CurrentScope() scope: RequestScope,
  ): Promise<${model}Dto> {
    return this.service.cancel(id, scope);
  }
}
`;
}

function holdExpiryJob(config: ReservationsConfig): string {
  const model = names.model(config.entity);

  return `import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ${model}Service } from './reservation.service';

/**
 * Releases intervals held by requests that were never confirmed. Expiry is also
 * performed inline before every create, so this job only bounds how long a stale
 * hold can sit in the table; it is never the only thing standing between a user
 * and a free slot.
 */
@Injectable()
export class HoldExpiryJob {
  private readonly logger = new Logger(HoldExpiryJob.name);

  constructor(private readonly reservations: ${model}Service) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expire(): Promise<void> {
    try {
      await this.reservations.expireHolds();
    } catch (error) {
      const stack =
        process.env.NODE_ENV === 'production' || !(error instanceof Error)
          ? undefined
          : error.stack;
      this.logger.error('Hold expiry failed', stack);
    }
  }
}
`;
}

function moduleFile(config: ReservationsConfig): string {
  const model = names.model(config.entity);
  const holds = holdsEnabled(config);

  return `import { Module } from '@nestjs/common';
${holds ? "import { ScheduleModule } from '@nestjs/schedule';\n" : ""}import { CustomModule } from '../../custom/custom.module';
${holds ? "import { HoldExpiryJob } from './hold-expiry.job';\n" : ""}import { ${model}Controller } from './reservation.controller';
import {
  CUSTOM_RESERVATION_POLICY,
  DefaultReservationPolicy,
  RESERVATION_POLICY,
  ReservationPolicy,
} from './reservation-policy';
import { ${model}Service } from './reservation.service';

@Module({
  imports: [CustomModule${holds ? ", ScheduleModule.forRoot()" : ""}],
  controllers: [${model}Controller],
  providers: [
    ${model}Service,${holds ? `\n    HoldExpiryJob,` : ""}
    {
      // A policy provided by CustomModule wins; otherwise the generated default
      // is used. This is how generated behaviour is replaced without editing a
      // generated file.
      provide: RESERVATION_POLICY,
      useFactory: (custom?: ReservationPolicy): ReservationPolicy =>
        custom ?? new DefaultReservationPolicy(),
      inject: [{ token: CUSTOM_RESERVATION_POLICY, optional: true }],
    },
  ],
  exports: [${model}Service],
})
export class ${model}Module {}
`;
}

function serviceSpec(config: ReservationsConfig, reservation: NormalizedEntity): string {
  const model = names.model(config.entity);
  const delegate = names.delegate(config.entity);
  const resourceDelegate = names.delegate(config.resource);
  const tenant = reservation.tenant !== null;
  const scope = `{ userId: 'user-1', organizationId: 'org-1', roles: [] }`;

  return `import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RequestScope } from '../common/scope';
import { DefaultReservationPolicy, RESERVATION_POLICY } from './reservation-policy';
import { ${model}Service } from './reservation.service';

const scope: RequestScope = ${scope};

function requestFingerprint(resourceId: string, startsAt: string, endsAt: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        resourceId,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
      }),
    )
    .digest('hex');
}

describe('${model}Service', () => {
  const reservations = {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    updateManyAndReturn: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  };

  const prisma = {
    ${delegate}: reservations,
    ${resourceDelegate}: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };

  let service: ${model}Service;

  beforeEach(async () => {
    jest.clearAllMocks();
    reservations.findMany.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ${model}Service,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: RESERVATION_POLICY, useValue: new DefaultReservationPolicy() },
      ],
    }).compile();

    service = moduleRef.get(${model}Service);
  });

  it('rejects an interval that ends before it starts', async () => {
    await expect(
      service.create(
        {
          resourceId: 'resource-1',
          startsAt: '2025-01-02T10:00:00Z',
          endsAt: '2025-01-01T10:00:00Z',
        },
        scope,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('replays an existing reservation for a repeated idempotency key', async () => {
    const existing = {
      id: 'reservation-1',
      resourceId: 'resource-1',
      ownerId: 'user-1',${tenant ? "\n      organizationId: 'org-1'," : ""}
      startsAt: new Date('2025-01-01T10:00:00Z'),
      endsAt: new Date('2025-01-01T11:00:00Z'),
      status: 'HELD',
      requestFingerprint: requestFingerprint(
        'resource-1',
        '2025-01-01T10:00:00Z',
        '2025-01-01T11:00:00Z',
      ),
      holdExpiresAt: null,
      confirmedAt: null,
      cancelledAt: null,
      createdAt: new Date('2025-01-01T09:00:00Z'),
    };

    reservations.findFirst.mockResolvedValue(existing);

    const result = await service.create(
      {
        resourceId: 'resource-1',
        startsAt: '2025-01-01T10:00:00Z',
        endsAt: '2025-01-01T11:00:00Z',
      },
      scope,
      'key-1',
    );

    expect(result.id).toBe('reservation-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a changed request that reuses an idempotency key', async () => {
    reservations.findFirst.mockResolvedValue({
      id: 'reservation-1',
      requestFingerprint: requestFingerprint(
        'resource-1',
        '2025-01-01T10:00:00Z',
        '2025-01-01T11:00:00Z',
      ),
    });

    await expect(
      service.create(
        {
          resourceId: 'resource-1',
          startsAt: '2025-01-01T10:00:00Z',
          endsAt: '2025-01-01T12:00:00Z',
        },
        scope,
        'key-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns not found when availability targets a missing resource', async () => {
    prisma.${resourceDelegate}.findFirst.mockResolvedValue(null);

    await expect(
      service.availability(
        {
          resourceId: 'missing',
          startsAt: '2025-01-01T10:00:00Z',
          endsAt: '2025-01-01T11:00:00Z',
        },
        scope,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to confirm a reservation that is not held', async () => {
    reservations.findFirst.mockResolvedValue({
      id: 'reservation-1',
      status: 'CANCELLED',
      holdExpiresAt: null,
      startsAt: new Date('2025-01-01T10:00:00Z'),
    });

    await expect(service.confirm('reservation-1', scope)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
`;
}

function concurrencyE2e(config: ReservationsConfig, context: TargetRenderContext): string {
  const prefix = context.settings.apiPrefix;
  const model = names.model(config.entity);
  const resourceModel = names.model(config.resource);
  const reservation = context.entity(config.entity);
  const tenant = reservation.tenant !== null;

  const orgSetup = tenant
    ? `
  async function organizationFor(account: TestAccount): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${account.accessToken}\`)
      .send({ name: 'Concurrency' })
      .expect(201);

    return response.body.id as string;
  }
`
    : "";

  const headersFor = tenant
    ? `function headersFor(account: TestAccount, organizationId: string): Record<string, string> {
    return {
      Authorization: \`Bearer \${account.accessToken}\`,
      'X-Organization-Id': organizationId,
    };
  }`
    : `function headersFor(account: TestAccount): Record<string, string> {
    return { Authorization: \`Bearer \${account.accessToken}\` };
  }`;

  return `import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { registerAccount, TestAccount } from './utils/auth-helper';
import { create${resourceModel} } from './utils/factories';
import { resetDatabase } from './utils/reset';
import { createTestApp } from './utils/test-app';

/**
 * The requirement this file exists for: two simultaneous attempts to reserve the
 * same resource for the same interval, exactly one of which may succeed.
 *
 * The guarantee comes from a PostgreSQL exclusion constraint, not from a
 * check-then-write in the service, so it holds no matter how the two requests
 * interleave.
 */
describe('${model} concurrency (e2e)', () => {
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
${orgSetup}
  ${headersFor}

  it('lets exactly one of two simultaneous requests reserve the interval', async () => {
    const alice = await registerAccount(app, prisma);
    const bob = await registerAccount(app, prisma);
${
  tenant
    ? `
    const organizationId = await organizationFor(alice);
    await prisma.membership.create({
      data: { organizationId, userId: bob.id, role: 'member' as never },
    });

    const resource = await create${resourceModel}(prisma, { organizationId });
    const aliceHeaders = headersFor(alice, organizationId);
    const bobHeaders = headersFor(bob, organizationId);
`
    : `
    const resource = await create${resourceModel}(prisma);
    const aliceHeaders = headersFor(alice);
    const bobHeaders = headersFor(bob);
`
}
    const payload = {
      resourceId: resource.id,
      startsAt: '2030-01-01T10:00:00Z',
      endsAt: '2030-01-01T12:00:00Z',
    };

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/${prefix}/reservations')
        .set(aliceHeaders)
        .send(payload),
      request(app.getHttpServer())
        .post('/${prefix}/reservations')
        .set(bobHeaders)
        .send(payload),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const stored = await prisma.${names.delegate(config.entity)}.count({
      where: { resourceId: resource.id, status: { in: ['HELD', 'CONFIRMED'] } },
    });

    expect(stored).toBe(1);
  });

  it('allows adjacent intervals, because the end instant is exclusive', async () => {
    const alice = await registerAccount(app, prisma);
${
  tenant
    ? `
    const organizationId = await organizationFor(alice);
    const resource = await create${resourceModel}(prisma, { organizationId });
    const headers = headersFor(alice, organizationId);
`
    : `
    const resource = await create${resourceModel}(prisma);
    const headers = headersFor(alice);
`
}
    await request(app.getHttpServer())
      .post('/${prefix}/reservations')
      .set(headers)
      .send({
        resourceId: resource.id,
        startsAt: '2030-02-01T10:00:00Z',
        endsAt: '2030-02-01T12:00:00Z',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/${prefix}/reservations')
      .set(headers)
      .send({
        resourceId: resource.id,
        startsAt: '2030-02-01T12:00:00Z',
        endsAt: '2030-02-01T14:00:00Z',
      })
      .expect(201);
  });

  it('returns the original reservation when the same idempotency key is replayed', async () => {
    const alice = await registerAccount(app, prisma);
${
  tenant
    ? `
    const organizationId = await organizationFor(alice);
    const resource = await create${resourceModel}(prisma, { organizationId });
    const headers = headersFor(alice, organizationId);
`
    : `
    const resource = await create${resourceModel}(prisma);
    const headers = headersFor(alice);
`
}
    const payload = {
      resourceId: resource.id,
      startsAt: '2030-03-01T10:00:00Z',
      endsAt: '2030-03-01T12:00:00Z',
    };

    const first = await request(app.getHttpServer())
      .post('/${prefix}/reservations')
      .set(headers)
      .set('Idempotency-Key', 'retry-1')
      .send(payload)
      .expect(201);

    const replay = await request(app.getHttpServer())
      .post('/${prefix}/reservations')
      .set(headers)
      .set('Idempotency-Key', 'retry-1')
      .send(payload)
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);

    await request(app.getHttpServer())
      .post('/${prefix}/reservations')
      .set(headers)
      .set('Idempotency-Key', 'retry-1')
      .send({ ...payload, endsAt: '2030-03-01T13:00:00Z' })
      .expect(409);

    const stored = await prisma.${names.delegate(config.entity)}.count({
      where: { resourceId: resource.id },
    });

    expect(stored).toBe(1);
  });
});
`;
}

function lifecycleE2e(config: ReservationsConfig, context: TargetRenderContext): string {
  const prefix = context.settings.apiPrefix;
  const model = names.model(config.entity);
  const resourceModel = names.model(config.resource);
  const reservation = context.entity(config.entity);
  const tenant = reservation.tenant !== null;
  const holds = holdsEnabled(config);
  const delegate = names.delegate(config.entity);

  const setup = tenant
    ? `
    const account = await registerAccount(app, prisma);
    const organization = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${account.accessToken}\`)
      .send({ name: 'Lifecycle' })
      .expect(201);

    const resource = await create${resourceModel}(prisma, { organizationId: organization.body.id });
    const headers = {
      Authorization: \`Bearer \${account.accessToken}\`,
      'X-Organization-Id': organization.body.id as string,
    };
`
    : `
    const account = await registerAccount(app, prisma);
    const resource = await create${resourceModel}(prisma);
    const headers = { Authorization: \`Bearer \${account.accessToken}\` };
`;

  const setupWithoutResource = tenant
    ? `
    const account = await registerAccount(app, prisma);
    const organization = await request(app.getHttpServer())
      .post('/${prefix}/organizations')
      .set('Authorization', \`Bearer \${account.accessToken}\`)
      .send({ name: 'Lifecycle' })
      .expect(201);

    const headers = {
      Authorization: \`Bearer \${account.accessToken}\`,
      'X-Organization-Id': organization.body.id as string,
    };
`
    : `
    const account = await registerAccount(app, prisma);
    const headers = { Authorization: \`Bearer \${account.accessToken}\` };
`;

  return `import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/generated/prisma/prisma.service';
import { registerAccount } from './utils/auth-helper';
import { create${resourceModel} } from './utils/factories';
import { resetDatabase } from './utils/reset';
import { createTestApp } from './utils/test-app';

describe('${model} lifecycle (e2e)', () => {
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

  it('reports availability, reserves, confirms and cancels', async () => {${setup}
    const interval = {
      resourceId: resource.id,
      startsAt: '2030-04-01T10:00:00Z',
      endsAt: '2030-04-01T12:00:00Z',
    };

    const before = await request(app.getHttpServer())
      .get('/${prefix}/reservations/availability')
      .query(interval)
      .set(headers)
      .expect(200);

    expect(before.body).toEqual({ available: true, conflicts: 0 });

    const created = await request(app.getHttpServer())
      .post('/${prefix}/reservations')
      .set(headers)
      .send(interval)
      .expect(201);

    expect(created.body.status).toBe('${holds ? "HELD" : "CONFIRMED"}');

    const after = await request(app.getHttpServer())
      .get('/${prefix}/reservations/availability')
      .query(interval)
      .set(headers)
      .expect(200);

    expect(after.body).toEqual({ available: false, conflicts: 1 });
${
  holds
    ? `
    const confirmed = await request(app.getHttpServer())
      .post(\`/${prefix}/reservations/\${created.body.id}/confirm\`)
      .set(headers)
      .expect(200);

    expect(confirmed.body.status).toBe('CONFIRMED');
    expect(confirmed.body.holdExpiresAt).toBeNull();

    // Confirming twice is a state error, not a silent success.
    await request(app.getHttpServer())
      .post(\`/${prefix}/reservations/\${created.body.id}/confirm\`)
      .set(headers)
      .expect(409);
`
    : ""
}
    const cancelled = await request(app.getHttpServer())
      .post(\`/${prefix}/reservations/\${created.body.id}/cancel\`)
      .set(headers)
      .expect(200);

    expect(cancelled.body.status).toBe('CANCELLED');

    // Cancelling frees the interval again.
    const freed = await request(app.getHttpServer())
      .get('/${prefix}/reservations/availability')
      .query(interval)
      .set(headers)
      .expect(200);

    expect(freed.body).toEqual({ available: true, conflicts: 0 });
  });

  it('refuses an interval that ends before it starts', async () => {${setup}
    await request(app.getHttpServer())
      .post('/${prefix}/reservations')
      .set(headers)
      .send({
        resourceId: resource.id,
        startsAt: '2030-05-01T12:00:00Z',
        endsAt: '2030-05-01T10:00:00Z',
      })
      .expect(400);
  });

  it('returns not found instead of available for a missing resource', async () => {${setupWithoutResource}
    await request(app.getHttpServer())
      .get('/${prefix}/reservations/availability')
      .query({
        resourceId: 'missing-resource',
        startsAt: '2030-05-01T10:00:00Z',
        endsAt: '2030-05-01T12:00:00Z',
      })
      .set(headers)
      .expect(404);
  });
${
  holds
    ? `
  it('drains more than one batch of expired holds before reporting availability', async () => {${setup}
    const expiredAt = new Date('2020-01-01T00:00:00Z');
    await prisma.${delegate}.createMany({
      data: Array.from({ length: 105 }, (_, index) => {
        const startsAt = new Date(Date.UTC(2020, 0, 2, 0, index * 60));
        return {
          resourceId: resource.id,
          ownerId: account.id,${tenant ? "\n          organizationId: organization.body.id as string," : ""}
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          status: 'HELD' as never,
          holdExpiresAt: expiredAt,
        };
      }),
    });

    await request(app.getHttpServer())
      .get('/${prefix}/reservations/availability')
      .query({
        resourceId: resource.id,
        startsAt: '2031-01-01T10:00:00Z',
        endsAt: '2031-01-01T12:00:00Z',
      })
      .set(headers)
      .expect(200, { available: true, conflicts: 0 });

    expect(
      await prisma.${delegate}.count({
        where: { resourceId: resource.id, status: 'HELD' },
      }),
    ).toBe(0);
    expect(
      await prisma.${delegate}.count({
        where: { resourceId: resource.id, status: 'EXPIRED' },
      }),
    ).toBe(105);
  });
`
    : ""
}

  it('never shows one account the reservations of another', async () => {${setup}
    await request(app.getHttpServer())
      .post('/${prefix}/reservations')
      .set(headers)
      .send({
        resourceId: resource.id,
        startsAt: '2030-06-01T10:00:00Z',
        endsAt: '2030-06-01T12:00:00Z',
      })
      .expect(201);

    const other = await registerAccount(app, prisma);
    const otherHeaders: Record<string, string> = {
      Authorization: \`Bearer \${other.accessToken}\`,
    };
${
  tenant
    ? `
    await prisma.membership.create({
      data: {
        organizationId: organization.body.id as string,
        userId: other.id,
        role: 'member' as never,
      },
    });
    otherHeaders['X-Organization-Id'] = organization.body.id as string;
`
    : ""
}
    const listed = await request(app.getHttpServer())
      .get('/${prefix}/reservations')
      .set(otherHeaders)
      .expect(200);

    expect(listed.body.meta.total).toBe(0);
  });
});
`;
}

export const reservationsRenderer: FeatureTargetRenderer = {
  render(context: TargetRenderContext): RenderResult {
    const config = reservationsConfig(context.config);
    const reservation = context.entity(config.entity);
    const resource = context.entity(config.resource);
    const holds = holdsEnabled(config);
    const model = names.model(config.entity);

    const files: RenderedFile[] = [
      file("src/generated/reservations/reservation-policy.ts", policyFile(config)),
      file("src/generated/reservations/dto/reservation.dto.ts", dtoFile(config, reservation)),
      file(
        "src/generated/reservations/reservation.service.ts",
        serviceFile(config, reservation, resource, context),
      ),
      file("src/generated/reservations/reservation.controller.ts", controllerFile(config, reservation)),
      file("src/generated/reservations/reservation.module.ts", moduleFile(config)),
      file("src/generated/reservations/reservation.service.spec.ts", serviceSpec(config, reservation)),
      scaffold("src/custom/reservation-policy.ts", CUSTOM_POLICY_SCAFFOLD),
      file("test/reservation.e2e-spec.ts", lifecycleE2e(config, context)),
      file("test/reservation-concurrency.e2e-spec.ts", concurrencyE2e(config, context)),
    ];

    if (holds) {
      files.push(file("src/generated/reservations/hold-expiry.job.ts", holdExpiryJob(config)));
    }

    return {
      ...emptyRenderResult(),
      files,
      rootModules: [
        {
          symbol: `${model}Module`,
          from: "./generated/reservations/reservation.module",
          kind: "module",
          order: 30,
        },
      ],
      packageDependencies: holds ? { "@nestjs/schedule": "5.0.1" } : {},
      migrationSql: overlapSql(config),
    };
  },
};
