import { SPEC_VERSION, type BackendSpec } from "@backend-compiler/specification";

export interface Scenario {
  name: string;
  description: string;
  spec: BackendSpec;
  /** Set when the scenario's integration suite needs a reachable database. */
  needsDatabase: boolean;
}

export function buildSpec(input: {
  name: string;
  description: string;
  entities: BackendSpec["entities"];
  features: BackendSpec["features"];
}): BackendSpec {
  return {
    specVersion: SPEC_VERSION,
    project: { name: input.name, description: input.description },
    target: { id: "nestjs-prisma", database: "postgresql" },
    entities: input.entities,
    features: input.features,
  };
}

const NOTE_ENTITY: BackendSpec["entities"] = {
  Note: {
    fields: {
      title: { type: "string", required: true, minLength: 1, maxLength: 200 },
      body: "text",
      pinned: { type: "boolean", default: false },
    },
  },
};

const USER_ENTITY: BackendSpec["entities"] = {
  User: {
    fields: {
      displayName: { type: "string", required: true, minLength: 2, maxLength: 100 },
    },
  },
};

/**
 * The end-to-end matrix. Each scenario is generated into a temporary directory,
 * built, and tested; together they cover every feature and every interesting
 * combination of them.
 */
export const SCENARIOS: Scenario[] = [
  {
    name: "basic-crud",
    description: "CRUD only, no authentication. The smallest useful backend.",
    needsDatabase: true,
    spec: buildSpec({
      name: "notes-api",
      description: "Notes with pagination, filtering and sorting",
      entities: NOTE_ENTITY,
      features: { crud: {} },
    }),
  },
  {
    name: "file-uploads",
    description: "Owned notes with presigned attachment uploads to S3-compatible storage.",
    needsDatabase: true,
    spec: buildSpec({
      name: "uploads-api",
      description: "Notes with verified file attachments",
      entities: { ...NOTE_ENTITY, ...USER_ENTITY },
      features: {
        crud: { ownedBy: { Note: "User" } },
        auth: { roles: ["admin", "member"], emailVerification: false, passwordReset: false },
        uploads: {
          entities: { Note: { maxSizeMb: 5, allowedTypes: ["image/png", "image/jpeg"] } },
        },
      },
    }),
  },
  {
    name: "background-jobs",
    description: "CRUD plus durable PostgreSQL-backed background jobs with a cron heartbeat.",
    needsDatabase: true,
    spec: buildSpec({
      name: "jobs-api",
      description: "Notes with durable background processing",
      entities: NOTE_ENTITY,
      features: {
        crud: {},
        jobs: { cron: [{ name: "heartbeat", schedule: "* * * * *" }] },
      },
    }),
  },
  {
    name: "authentication",
    description: "CRUD plus email and password authentication with rotating sessions.",
    needsDatabase: true,
    spec: buildSpec({
      name: "auth-api",
      description: "Accounts, roles and per-row ownership",
      entities: { ...USER_ENTITY, ...NOTE_ENTITY },
      features: {
        crud: { ownedBy: { Note: "User" }, softDelete: ["Note", "User"] },
        auth: { roles: ["admin", "member"], emailVerification: false, passwordReset: false },
      },
    }),
  },
  {
    name: "multi-tenant-saas",
    description: "Organizations, membership and server-side tenant isolation.",
    needsDatabase: true,
    spec: buildSpec({
      name: "saas-api",
      description: "Multi-tenant projects and tasks",
      entities: {
        ...USER_ENTITY,
        Project: {
          fields: {
            name: { type: "string", required: true, minLength: 1, maxLength: 120 },
            status: {
              type: "string",
              enum: ["ACTIVE", "ARCHIVED"],
              default: "ACTIVE",
              required: true,
            },
          },
        },
        Task: {
          fields: {
            title: { type: "string", required: true, maxLength: 200 },
            done: { type: "boolean", default: false, required: true },
          },
          relations: [{ name: "project", type: "belongsTo", target: "Project", required: true }],
        },
      },
      features: {
        crud: {},
        auth: { roles: ["admin", "member"], emailVerification: false, passwordReset: false },
        organizations: { roles: ["owner", "admin", "member"] },
      },
    }),
  },
  {
    name: "hotel-reservation",
    description:
      "The reference scenario: rooms, reservations with holds and overlap prevention, and notifications.",
    needsDatabase: true,
    spec: buildSpec({
      name: "hotel-api",
      description: "Hotel room availability and reservation backend",
      entities: {
        ...USER_ENTITY,
        Hotel: {
          fields: {
            name: { type: "string", required: true, maxLength: 200 },
            address: "string",
          },
        },
        Room: {
          fields: {
            number: { type: "string", required: true },
            capacity: { type: "integer", required: true, minimum: 1 },
            price: { type: "decimal", required: true, minimum: 0 },
          },
          relations: [{ name: "hotel", type: "belongsTo", target: "Hotel", required: true }],
        },
      },
      features: {
        crud: { softDelete: ["Room"] },
        auth: {
          roles: ["admin", "customer"],
          emailVerification: false,
          passwordReset: false,
        },
        reservations: { resource: "Room", owner: "User", preventOverlap: true, holdMinutes: 15 },
        notifications: {
          provider: "log",
          events: ["reservation_confirmed", "reservation_cancelled"],
        },
      },
    }),
  },
  {
    name: "appointment-scheduling",
    description:
      "Reservations without holds: an appointment is confirmed the moment it is booked.",
    needsDatabase: true,
    spec: buildSpec({
      name: "appointments-api",
      description: "Practitioner appointment scheduling",
      entities: {
        ...USER_ENTITY,
        Practitioner: {
          fields: {
            name: { type: "string", required: true, maxLength: 120 },
            specialty: "string",
          },
        },
      },
      features: {
        crud: {},
        auth: {
          roles: ["admin", "patient"],
          emailVerification: false,
          passwordReset: false,
        },
        reservations: {
          entity: "Appointment",
          resource: "Practitioner",
          owner: "User",
          holdMinutes: 0,
          minDurationMinutes: 15,
          maxDurationMinutes: 240,
        },
      },
    }),
  },
  {
    name: "all-features",
    description: "Every feature at once, which is where feature interactions show up.",
    needsDatabase: true,
    spec: buildSpec({
      name: "everything-api",
      description: "All features combined",
      entities: {
        ...USER_ENTITY,
        Venue: {
          fields: {
            name: { type: "string", required: true, maxLength: 200 },
          },
        },
        Desk: {
          fields: {
            label: { type: "string", required: true, maxLength: 60 },
            seats: { type: "integer", required: true, minimum: 1 },
          },
          relations: [{ name: "venue", type: "belongsTo", target: "Venue", required: true }],
        },
      },
      features: {
        crud: { softDelete: ["Desk", "User"] },
        auth: { roles: ["admin", "member"] },
        organizations: { roles: ["owner", "admin", "member"] },
        reservations: { resource: "Desk", owner: "User", holdMinutes: 10 },
        notifications: {
          provider: "resend",
          events: ["user_registered", "reservation_confirmed", "reservation_cancelled"],
        },
      },
    }),
  },
];

export function scenarioSpec(name: string): BackendSpec {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);

  if (scenario === undefined) {
    throw new Error(
      `Unknown scenario '${name}'. Available: ${SCENARIOS.map((item) => item.name).join(", ")}`,
    );
  }

  return structuredClone(scenario.spec);
}

export const HOTEL_SPEC_PATH = "examples/hotel-booking/backend.yaml";
