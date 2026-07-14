import type { DraftEntity, DraftRelation } from "@backend-compiler/compiler";
import type {
  FeatureContext,
  FeatureContribution,
  FeatureEntityContext,
  FeatureEntityContribution,
  FeaturePack,
} from "@backend-compiler/feature-sdk";
import { TARGET_ID } from "@backend-compiler/target-nestjs-prisma";
import { reservationsRenderer } from "./render.js";

export const RESERVATIONS_VERSION = "0.2.0";

export const RESERVATION_STATUSES = ["HELD", "CONFIRMED", "CANCELLED", "EXPIRED"] as const;

export interface ReservationsConfig {
  entity: string;
  resource: string;
  owner: string;
  preventOverlap: boolean;
  holdMinutes: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  cancellationWindowMinutes: number;
}

export function reservationsConfig(raw: Record<string, unknown>): ReservationsConfig {
  return raw as unknown as ReservationsConfig;
}

/** Holds are enabled when a positive hold window is configured. */
export function holdsEnabled(config: ReservationsConfig): boolean {
  return config.holdMinutes > 0;
}

export const reservationsFeature: FeaturePack = {
  name: "reservations",
  version: RESERVATIONS_VERSION,
  description:
    "Interval reservations over a resource: availability checks, configurable temporary holds with expiry, confirmation, cancellation, idempotent creation, transactional writes and database-enforced overlap prevention.",
  dependsOn: ["auth", "crud"],
  conflictsWith: [],
  supportedTargets: [TARGET_ID],

  configSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["resource", "owner"],
    properties: {
      entity: {
        type: "string",
        pattern: "^[A-Za-z][A-Za-z0-9_]*$",
        default: "Reservation",
        description: "Name of the entity this feature creates. It must not already exist.",
      },
      resource: {
        type: "string",
        pattern: "^[A-Za-z][A-Za-z0-9_]*$",
        description: "Entity being reserved, for example Room.",
      },
      owner: {
        type: "string",
        pattern: "^[A-Za-z][A-Za-z0-9_]*$",
        description: "Entity that holds the reservation, normally the user entity.",
      },
      preventOverlap: {
        type: "boolean",
        default: true,
        description:
          "Enforce non-overlapping intervals per resource with a PostgreSQL exclusion constraint.",
      },
      holdMinutes: {
        type: "integer",
        minimum: 0,
        maximum: 1440,
        default: 15,
        description: "Lifetime of a temporary hold. 0 disables holds and confirms immediately.",
      },
      minDurationMinutes: { type: "integer", minimum: 1, default: 1 },
      maxDurationMinutes: { type: "integer", minimum: 1, default: 43200 },
      cancellationWindowMinutes: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Minutes before the start time after which cancellation is refused.",
      },
    },
  },

  requiredEntities(raw): readonly string[] {
    const config = reservationsConfig(raw);
    return [config.owner, config.resource].sort();
  },

  validate(context: FeatureEntityContext) {
    const config = reservationsConfig(context.config);
    const issues: Array<{ code: string; path: string; message: string }> = [];

    if (context.specEntities.includes(config.entity)) {
      issues.push({
        code: "feature.reservations.entity-exists",
        path: "/features/reservations/entity",
        message: `The reservations feature owns the '${config.entity}' entity, including its interval, status and hold fields. Remove '${config.entity}' from the entities block, or point 'entity' at a different name.`,
      });
    }

    if (config.minDurationMinutes > config.maxDurationMinutes) {
      issues.push({
        code: "feature.reservations.invalid-duration-range",
        path: "/features/reservations/minDurationMinutes",
        message: "minDurationMinutes cannot be greater than maxDurationMinutes",
      });
    }

    const auth = context.featureConfig("auth") as { userEntity?: string } | undefined;
    const authUserEntity = auth?.userEntity ?? "User";
    if (config.owner !== authUserEntity) {
      issues.push({
        code: "feature.reservations.unsupported-owner-entity",
        path: "/features/reservations/owner",
        message:
          `Reservation ownership is derived from the authenticated user id, so owner must equal auth.userEntity '${authUserEntity}', not '${config.owner}'. Custom owner mapping is not supported yet.`,
      });
    }

    if (config.preventOverlap && context.target.database !== "postgresql") {
      issues.push({
        code: "feature.reservations.overlap-unsupported",
        path: "/features/reservations/preventOverlap",
        message:
          "Database-enforced overlap prevention needs PostgreSQL exclusion constraints. Choose postgresql, or set preventOverlap to false and accept application-level checks only.",
      });
    }

    return issues;
  },

  contributeEntities(context: FeatureEntityContext): FeatureEntityContribution {
    const config = reservationsConfig(context.config);
    const tenantAware = context.featureConfig("organizations") !== undefined;

    const relations: DraftRelation[] = [
      { name: "resource", type: "belongsTo", target: config.resource, required: true },
      { name: "owner", type: "belongsTo", target: config.owner, required: true },
    ];

    if (tenantAware) {
      relations.push({
        name: "organization",
        type: "belongsTo",
        target: "Organization",
        required: true,
      });
    }

    const reservation: DraftEntity = {
      name: config.entity,
      description: `Interval reservation of a ${config.resource}.`,
      origin: "feature",
      ownerFeature: "reservations",
      crud: false,
      fields: [
        {
          name: "startsAt",
          type: "datetime",
          required: true,
          description: "Inclusive start instant, stored in UTC.",
        },
        {
          name: "endsAt",
          type: "datetime",
          required: true,
          description: "Exclusive end instant, stored in UTC.",
        },
        {
          name: "status",
          type: "string",
          required: true,
          enumValues: [...RESERVATION_STATUSES],
          defaultValue: holdsEnabled(config) ? "HELD" : "CONFIRMED",
          readOnly: true,
        },
        {
          name: "holdExpiresAt",
          type: "datetime",
          required: false,
          readOnly: true,
          description: "When an unconfirmed hold stops blocking the interval.",
        },
        { name: "confirmedAt", type: "datetime", required: false, readOnly: true },
        { name: "cancelledAt", type: "datetime", required: false, readOnly: true },
        {
          name: "idempotencyKey",
          type: "string",
          required: false,
          internal: true,
          description:
            "Value of the Idempotency-Key request header, if one was supplied. Unique per owner (and tenant), never globally.",
        },
        {
          name: "requestFingerprint",
          type: "string",
          required: false,
          internal: true,
          description:
            "Digest of the request an idempotency key was first used with. Replaying the key with a different request is a conflict, not a silent replay.",
        },
      ],
      relations,
      indexes: [
        { fields: ["resourceId", "startsAt", "endsAt"], unique: false },
        // Matches the hold-expiry sweep: WHERE status = 'HELD' AND holdExpiresAt <= now.
        { fields: ["status", "holdExpiresAt"], unique: false },
        // Idempotency keys are scoped to the principal (and tenant) so two
        // clients can never collide on, or replay, each other's keys.
        {
          fields: tenantAware
            ? ["organizationId", "ownerId", "idempotencyKey"]
            : ["ownerId", "idempotencyKey"],
          unique: true,
        },
      ],
      ownership: { relation: "owner", foreignKey: "ownerId", entity: config.owner },
    };

    if (tenantAware) {
      reservation.tenant = {
        relation: "organization",
        foreignKey: "organizationId",
        entity: "Organization",
      };
    }

    return { create: [reservation] };
  },

  contribute(context: FeatureContext): FeatureContribution {
    const config = reservationsConfig(context.config);
    const entity = config.entity;
    const holds = holdsEnabled(config);

    return {
      endpoints: [
        {
          id: `${entity}.availability`,
          feature: "reservations",
          method: "GET",
          path: "/reservations/availability",
          entity,
          operation: "availability",
          summary: "Report whether a resource is free for an interval",
          auth: "authenticated",
          roles: [],
        },
        {
          id: `${entity}.create`,
          feature: "reservations",
          method: "POST",
          path: "/reservations",
          entity,
          operation: "create",
          summary: holds
            ? `Place a ${config.holdMinutes} minute hold on a resource`
            : "Reserve a resource",
          auth: "authenticated",
          roles: [],
        },
        {
          id: `${entity}.list`,
          feature: "reservations",
          method: "GET",
          path: "/reservations",
          entity,
          operation: "list",
          summary: "List the caller's reservations",
          auth: "authenticated",
          roles: [],
        },
        {
          id: `${entity}.read`,
          feature: "reservations",
          method: "GET",
          path: "/reservations/:id",
          entity,
          operation: "read",
          summary: "Read one reservation",
          auth: "authenticated",
          roles: [],
        },
        ...(holds
          ? [
              {
                id: `${entity}.confirm`,
                feature: "reservations" as const,
                method: "POST" as const,
                path: "/reservations/:id/confirm",
                entity,
                operation: "confirm",
                summary: "Confirm a held reservation",
                auth: "authenticated" as const,
                roles: [],
              },
            ]
          : []),
        {
          id: `${entity}.cancel`,
          feature: "reservations",
          method: "POST",
          path: "/reservations/:id/cancel",
          entity,
          operation: "cancel",
          summary: "Cancel a reservation",
          auth: "authenticated",
          roles: [],
        },
      ],

      workflows: [
        {
          name: "reservation-lifecycle",
          feature: "reservations",
          description: holds
            ? "A reservation is created HELD, becomes CONFIRMED, and ends CANCELLED or EXPIRED. No transition out of a terminal state is permitted."
            : "A reservation is created CONFIRMED and can become CANCELLED. No transition out of the terminal state is permitted.",
          states: holds ? [...RESERVATION_STATUSES] : ["CONFIRMED", "CANCELLED"],
          initialState: holds ? "HELD" : "CONFIRMED",
          terminalStates: holds ? ["CANCELLED", "EXPIRED"] : ["CANCELLED"],
          transitions: holds
            ? [
                { from: "HELD", to: "CONFIRMED", trigger: "confirm" },
                { from: "HELD", to: "CANCELLED", trigger: "cancel" },
                { from: "HELD", to: "EXPIRED", trigger: "hold-expiry" },
                { from: "CONFIRMED", to: "CANCELLED", trigger: "cancel" },
              ]
            : [{ from: "CONFIRMED", to: "CANCELLED", trigger: "cancel" }],
        },
      ],

      events: [
        {
          name: "reservation.created",
          feature: "reservations",
          description: "A reservation was created.",
          payload: { reservationId: "uuid", resourceId: "uuid", ownerId: "uuid", status: "string" },
        },
        {
          name: "reservation.confirmed",
          feature: "reservations",
          description: holds
            ? "A held reservation was confirmed."
            : "A reservation was confirmed immediately when it was created.",
          payload: {
            reservationId: "uuid",
            resourceId: "uuid",
            ownerId: "uuid",
            startsAt: "datetime",
            endsAt: "datetime",
          },
        },
        {
          name: "reservation.cancelled",
          feature: "reservations",
          description: "A reservation was cancelled.",
          payload: { reservationId: "uuid", resourceId: "uuid", ownerId: "uuid" },
        },
        ...(holds
          ? [
              {
                name: "reservation.expired",
                feature: "reservations",
                description: "A hold expired without being confirmed.",
                payload: {
                  reservationId: "uuid" as const,
                  resourceId: "uuid" as const,
                  ownerId: "uuid" as const,
                },
              },
            ]
          : []),
      ],

      infrastructure: [
        ...(config.preventOverlap
          ? [
              {
                kind: "database-extension" as const,
                name: "btree_gist",
                feature: "reservations",
                reason:
                  "Required by the exclusion constraint that makes overlapping reservations impossible at the database level.",
                portabilityNote:
                  "PostgreSQL only. A target on a database without exclusion constraints must fall back to a serialisable transaction or an advisory lock, and must document the weaker guarantee.",
              },
            ]
          : []),
        ...(holds
          ? [
              {
                kind: "scheduler" as const,
                name: "hold-expiry",
                feature: "reservations",
                reason: `Expires holds older than ${config.holdMinutes} minutes so the interval is released.`,
                portabilityNote:
                  "The in-process scheduler runs in every replica. Expiry is idempotent, so duplicate runs are harmless.",
              },
            ]
          : []),
      ],

      customizationPoints: [
        {
          path: "src/custom/reservation-policy.ts",
          feature: "reservations",
          contract: "ReservationPolicy",
          description:
            "Add domain rules such as blackout dates, minimum notice or per-resource limits. Provide CUSTOM_RESERVATION_POLICY in CustomModule and the generated service uses it instead of the default.",
        },
      ],
    };
  },

  renderers: { [TARGET_ID]: reservationsRenderer },

  agentSummary:
    "Reservations over a resource entity. Creates the Reservation entity itself (do not declare it): startsAt, endsAt, status (HELD/CONFIRMED/CANCELLED/EXPIRED), holdExpiresAt, idempotencyKey, plus resource and owner relations. Overlaps are prevented by a PostgreSQL exclusion constraint, so two concurrent requests for the same interval cannot both succeed. Required config: resource, owner. Optional: entity, holdMinutes (0 disables holds), preventOverlap, minDurationMinutes, maxDurationMinutes, cancellationWindowMinutes.",

  examples: [
    {
      name: "Hotel rooms with a 15 minute hold",
      config: { resource: "Room", owner: "User", holdMinutes: 15, preventOverlap: true },
    },
    {
      name: "Immediate booking, no holds",
      config: { resource: "Desk", owner: "User", holdMinutes: 0 },
    },
  ],

  conformance: [
    {
      name: "reservations-default",
      description:
        "The reservation service, the overlap constraint, the hold expiry job and the concurrency test all exist.",
      config: { resource: "Room", owner: "User" },
      expectFiles: [
        "src/generated/reservations/reservation.service.ts",
        "src/generated/reservations/reservation.controller.ts",
        "src/generated/reservations/reservation-policy.ts",
        "src/generated/reservations/hold-expiry.job.ts",
        "src/custom/reservation-policy.ts",
        "test/reservation-concurrency.e2e-spec.ts",
      ],
      expectEndpoints: [
        "Reservation.create",
        "Reservation.confirm",
        "Reservation.cancel",
        "Reservation.availability",
      ],
    },
  ],
};
