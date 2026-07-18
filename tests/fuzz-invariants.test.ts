import {
  assertSafeRelativePath,
  compileBackend,
  createDefaultRegistry,
  createDefaultTargets,
  renderBackend,
} from "@backend-compiler/generator-runtime";
import type { BackendSpec, EntityDefinition } from "@backend-compiler/specification";
import { buildSpec } from "@backend-compiler/testing";
import type { RenderedFile } from "@backend-compiler/target-sdk";
import { describe, expect, it } from "vitest";

/**
 * Property test: for a large sample of randomly assembled but valid
 * specifications, every generated backend must satisfy a fixed security
 * contract. A failure prints the seed and feature facts, so every
 * counterexample can be replayed deterministically.
 *
 * Default local gate: 250 seeds.
 * CI gate: eight 250-seed shards via npm run test:fuzz:ci.
 * Replay one counterexample: BACKENDGEN_FUZZ_SEED=<seed>.
 */

// A tiny, seeded PRNG (mulberry32) keeps the corpus reproducible without a dependency.
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chance(next: () => number, probability: number): boolean {
  return next() < probability;
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

type RelationShape = "none" | "required-restrict" | "optional-set-null";
type NotificationProvider = "none" | "log" | "resend" | "custom";

interface GeneratedSpec {
  seed: number;
  spec: BackendSpec;
  /** What the generator intentionally enabled, so invariants know what to expect. */
  facts: {
    auth: boolean;
    organizations: boolean;
    scopedNote: boolean;
    scopedResource: boolean;
    ownedNote: boolean;
    userSoftDelete: boolean;
    noteSoftDelete: boolean;
    resourceSoftDelete: boolean;
    relationShape: RelationShape;
    fieldProfile: number;
    reservations: boolean;
    reservationHolds: boolean;
    notifications: boolean;
    notificationProvider: NotificationProvider;
    recoveryNotifications: boolean;
    webhooks: boolean;
    uploads: boolean;
  };
}

function noteEntity(fieldProfile: number, relationShape: RelationShape): EntityDefinition {
  const fields: EntityDefinition["fields"] = {
    title: { type: "string", required: true, minLength: 1, maxLength: 200 },
    body: "text",
    pinned: { type: "boolean", default: false },
  };

  if (fieldProfile === 0) {
    fields.status = {
      type: "string",
      required: true,
      enum: ["DRAFT", "PUBLISHED", "ARCHIVED"],
      default: "DRAFT",
    };
    fields.priority = { type: "integer", minimum: 0, maximum: 10, default: 0 };
  } else if (fieldProfile === 1) {
    fields.estimate = { type: "decimal", minimum: 0, maximum: 10_000 };
    fields.scheduledAt = "datetime";
  } else if (fieldProfile === 2) {
    fields.externalId = { type: "uuid", unique: true };
    fields.publishedOn = "date";
  } else {
    fields.slug = { type: "string", minLength: 2, maxLength: 80, unique: true };
    fields.score = { type: "integer", minimum: -100, maximum: 100 };
  }

  if (relationShape === "none") return { fields };

  return {
    fields,
    relations: [
      relationShape === "required-restrict"
        ? {
            name: "collection",
            type: "belongsTo",
            target: "Collection",
            required: true,
            onDelete: "restrict",
          }
        : {
            name: "collection",
            type: "belongsTo",
            target: "Collection",
            onDelete: "setNull",
          },
    ],
    indexes: [{ fields: ["title", "createdAt"], unique: false }],
  };
}

function generateSpec(seed: number): GeneratedSpec {
  const next = rng(seed);

  const auth = chance(next, 0.82);
  const organizations = auth && chance(next, 0.52);
  const reservations = auth && chance(next, 0.55);
  const reservationHolds = reservations && chance(next, 0.68);
  const notifications = auth && chance(next, 0.62);
  const notificationProvider: NotificationProvider = notifications
    ? pick(next, ["log", "resend", "custom"] as const)
    : "none";
  const recoveryRequested =
    notifications && notificationProvider !== "log" && chance(next, 0.45);
  const emailVerification = recoveryRequested && chance(next, 0.7);
  const passwordReset = recoveryRequested && (!emailVerification || chance(next, 0.7));
  const recoveryNotifications = emailVerification || passwordReset;
  const webhooks = auth && chance(next, 0.52);
  const uploads = chance(next, 0.6);
  const scopedNote = organizations && chance(next, 0.7);
  const scopedResource = organizations && reservations && chance(next, 0.65);
  const ownedNote = auth && !scopedNote && chance(next, 0.58);
  const userSoftDelete = auth && chance(next, 0.5);
  const noteSoftDelete = chance(next, 0.5);
  const resourceSoftDelete = reservations && chance(next, 0.5);
  const relationShape = pick(next, [
    "none",
    "required-restrict",
    "optional-set-null",
  ] as const);
  const fieldProfile = Math.floor(next() * 4);

  const entities: BackendSpec["entities"] = {
    Note: noteEntity(fieldProfile, relationShape),
  };
  if (relationShape !== "none") {
    entities.Collection = {
      fields: {
        name: { type: "string", required: true, minLength: 1, maxLength: 120 },
        sortOrder: { type: "integer", minimum: 0, default: 0 },
      },
    };
  }
  if (auth) {
    entities.User = {
      fields: {
        displayName: { type: "string", required: true, minLength: 2, maxLength: 100 },
      },
    };
  }
  if (reservations) {
    entities.Resource = {
      fields: {
        label: { type: "string", required: true, minLength: 1, maxLength: 100 },
        capacity: { type: "integer", required: true, minimum: 1, maximum: 1_000 },
        price: { type: "decimal", required: true, minimum: 0 },
      },
    };
  }

  const softDelete: string[] = [];
  if (noteSoftDelete) softDelete.push("Note");
  if (userSoftDelete) softDelete.push("User");
  if (resourceSoftDelete) softDelete.push("Resource");

  const features: BackendSpec["features"] = {
    crud: {
      ...(ownedNote ? { ownedBy: { Note: "User" } } : {}),
      ...(softDelete.length > 0 ? { softDelete } : {}),
    },
  };
  if (auth) {
    features.auth = {
      roles: ["admin", "member"],
      emailVerification,
      passwordReset,
    };
  }
  if (organizations) {
    const scopedEntities = [
      ...(scopedNote ? ["Note"] : []),
      ...(scopedResource ? ["Resource"] : []),
      ...(scopedNote && relationShape !== "none" ? ["Collection"] : []),
    ];
    features.organizations = {
      roles: ["owner", "admin", "member"],
      defaultRole: "member",
      scopedEntities,
    };
  }
  if (reservations) {
    const minDurationMinutes = pick(next, [1, 5, 15, 30] as const);
    features.reservations = {
      resource: "Resource",
      owner: "User",
      preventOverlap: chance(next, 0.85),
      holdMinutes: reservationHolds ? pick(next, [5, 10, 15, 30] as const) : 0,
      minDurationMinutes,
      maxDurationMinutes: minDurationMinutes + pick(next, [60, 240, 1_440] as const),
      cancellationWindowMinutes: pick(next, [0, 15, 60] as const),
    };
  }
  if (notifications) {
    const events: string[] = [];
    if (chance(next, 0.7)) events.push("user_registered");
    if (reservations) {
      if (chance(next, 0.8)) events.push("reservation_confirmed");
      if (chance(next, 0.7)) events.push("reservation_cancelled");
      if (reservationHolds && chance(next, 0.5)) events.push("reservation_expired");
    }
    if (events.length === 0) events.push("user_registered");
    features.notifications = {
      provider: notificationProvider,
      from: "Backend Compiler <no-reply@example.com>",
      events,
      maxAttempts: pick(next, [1, 3, 5] as const),
    };
  }
  if (webhooks) {
    features.webhooks = {
      maxAttempts: pick(next, [1, 2, 5] as const),
      disableAfterFailures: pick(next, [1, 3, 10] as const),
    };
  }
  if (uploads) {
    const presignTtlMinutes = pick(next, [5, 15, 30] as const);
    features.uploads = {
      entities: {
        Note: {
          maxSizeMb: pick(next, [1, 5, 25] as const),
          allowedTypes: chance(next, 0.5)
            ? ["image/png", "image/jpeg"]
            : ["application/pdf", "text/plain"],
        },
      },
      presignTtlMinutes,
      staleAfterMinutes: presignTtlMinutes + pick(next, [0, 15, 60] as const),
    };
  }
  if (chance(next, 0.42)) {
    features.jobs = { cron: [{ name: "heartbeat", schedule: "* * * * *" }] };
  }

  const spec = buildSpec({
    name: `fuzz-${seed}-api`,
    description: `Fuzzed specification, seed ${seed}`,
    entities,
    features,
  });
  if (chance(next, 0.4)) {
    spec.options = {
      apiPrefix: pick(next, ["api", "v1", "internal"] as const),
      port: pick(next, [3_000, 4_000, 8_080] as const),
      client: chance(next, 0.7),
    };
  }

  return {
    seed,
    spec,
    facts: {
      auth,
      organizations,
      scopedNote,
      scopedResource,
      ownedNote,
      userSoftDelete,
      noteSoftDelete,
      resourceSoftDelete,
      relationShape,
      fieldProfile,
      reservations,
      reservationHolds,
      notifications,
      notificationProvider,
      recoveryNotifications,
      webhooks,
      uploads,
    },
  };
}

const features = createDefaultRegistry();
const targets = createDefaultTargets();

function fileMap(files: readonly RenderedFile[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.contents] as const));
}

function occurrences(contents: string, needle: string): number {
  return contents.split(needle).length - 1;
}

function requiredFile(map: ReadonlyMap<string, string>, path: string, context: string): string {
  const contents = map.get(path);
  expect(contents, `${context}: missing ${path}`).toBeDefined();
  return contents ?? "";
}

function methodSection(contents: string, start: string, end: string): string {
  const startAt = contents.indexOf(start);
  if (startAt === -1) return "";
  const endAt = contents.indexOf(end, startAt + start.length);
  return contents.slice(startAt, endAt === -1 ? undefined : endAt);
}

/** The security contract. Each assertion carries the reproducing seed and feature facts. */
function assertInvariants(generated: GeneratedSpec, files: readonly RenderedFile[]): void {
  const map = fileMap(files);
  const { facts, seed } = generated;
  const at = (path: string): string | undefined => map.get(path);
  const context = `seed ${seed} (${JSON.stringify(facts)})`;

  // 1. Every rendered path stays inside the output root.
  for (const file of files) {
    expect(assertSafeRelativePath(file.path), `${context}: unsafe path ${file.path}`).toBeNull();
  }

  // 2. Password/session hashes never appear in any response-shaped DTO.
  for (const [path, contents] of map) {
    if (path.endsWith(".dto.ts") || path.endsWith(".response.dto.ts")) {
      expect(contents.includes("passwordHash"), `${context}: ${path} exposes passwordHash`).toBe(
        false,
      );
      expect(contents.includes("tokenHash"), `${context}: ${path} exposes tokenHash`).toBe(false);
    }
  }

  // 3. Authentication is deny-by-default: a global JWT guard is wired.
  const appModule = at("src/app.module.ts") ?? "";
  if (facts.auth) {
    expect(appModule.includes("APP_GUARD"), `${context}: auth without a global guard`).toBe(true);
    expect(
      appModule.includes("JwtAuthGuard"),
      `${context}: auth without the JWT guard registered`,
    ).toBe(true);
  }

  // 4. Tenant and owner scoping is enforced in generated CRUD services.
  const noteService = at("src/generated/note/note.service.ts");
  if (facts.scopedNote) {
    expect(noteService, `${context}: scoped Note has no service`).toBeDefined();
    expect(
      noteService!.includes("organizationId"),
      `${context}: scoped Note service does not filter by organizationId`,
    ).toBe(true);
  }
  if (facts.ownedNote && noteService !== undefined) {
    expect(
      noteService.includes("ownerId"),
      `${context}: owned Note service does not filter by ownerId`,
    ).toBe(true);
  }

  // 5. Soft-deleted users never count as active organization owners or members.
  const orgService = at("src/generated/organizations/organization.service.ts");
  if (facts.organizations) {
    expect(orgService, `${context}: organizations without a service`).toBeDefined();
    if (facts.userSoftDelete) {
      expect(
        orgService!.includes("where: { organizationId, role: OWNER_ROLE as never }"),
        `${context}: an owner count does not exclude soft-deleted users`,
      ).toBe(false);
      expect(
        orgService!.includes("role: OWNER_ROLE as never, user: { deletedAt: null }"),
        `${context}: owner count does not exclude soft-deleted users`,
      ).toBe(true);
      expect(
        orgService!.includes("email: dto.email.trim().toLowerCase(), deletedAt: null"),
        `${context}: addMember can add a soft-deleted account`,
      ).toBe(true);
    }
  }

  // 6. Reservation replay and mutation paths stay principal/tenant scoped.
  if (facts.reservations) {
    const service = requiredFile(
      map,
      "src/generated/reservations/reservation.service.ts",
      context,
    );
    const dto = requiredFile(map, "src/generated/reservations/dto/reservation.dto.ts", context);
    const idempotencyWhere = methodSection(
      service,
      "const idempotencyWhere:",
      "if (idempotencyKey !== undefined)",
    );

    expect(idempotencyWhere.includes("ownerId"), `${context}: replay key is not owner scoped`).toBe(
      true,
    );
    if (facts.organizations) {
      expect(
        idempotencyWhere.includes("organizationId"),
        `${context}: replay key is not tenant scoped`,
      ).toBe(true);
      expect(
        service.includes("scoped.organizationId = requireOrganization(scope)"),
        `${context}: reservation mutations are not tenant scoped`,
      ).toBe(true);
    }
    expect(
      occurrences(service, "where: idempotencyWhere"),
      `${context}: both replay and unique-race recovery must use the scoped key`,
    ).toBeGreaterThanOrEqual(2);
    expect(
      occurrences(service, "requestFingerprint !== requestFingerprint"),
      `${context}: idempotency replay does not reject a changed request`,
    ).toBeGreaterThanOrEqual(2);
    expect(
      service.includes("scoped.ownerId = requireUser(scope)"),
      `${context}: non-admin reservation access is not owner scoped`,
    ).toBe(true);
    if (facts.resourceSoftDelete) {
      expect(
        service.includes("deletedAt: null"),
        `${context}: reservations accept a soft-deleted resource`,
      ).toBe(true);
    }
    if (facts.scopedResource) {
      expect(
        service.includes("organizationId: organizationId"),
        `${context}: reservation resource lookup is not tenant scoped`,
      ).toBe(true);
    }
    expect(dto.includes("idempotencyKey"), `${context}: response exposes idempotencyKey`).toBe(
      false,
    );
    expect(
      dto.includes("requestFingerprint"),
      `${context}: response exposes requestFingerprint`,
    ).toBe(false);
  }

  // 7. Webhook endpoints resist SSRF/DNS rebinding and do not list signing secrets.
  if (facts.webhooks) {
    const guard = requiredFile(map, "src/generated/webhooks/url-guard.ts", context);
    const service = requiredFile(map, "src/generated/webhooks/webhook.service.ts", context);
    const dispatcher = requiredFile(map, "src/generated/webhooks/webhook-dispatcher.ts", context);
    const listMethod = methodSection(service, "async list(", "async remove(");

    expect(guard.includes("url.protocol !== 'https:'"), `${context}: webhook HTTPS is optional`).toBe(
      true,
    );
    expect(
      guard.includes("Webhook URL must not contain credentials"),
      `${context}: webhook URL credentials are accepted`,
    ).toBe(true);
    expect(
      guard.includes("for (const target of targets)"),
      `${context}: webhook guard does not reject every unsafe DNS answer`,
    ).toBe(true);
    expect(
      guard.includes("Webhook URL resolves to a non-public address"),
      `${context}: webhook private-network addresses are not blocked`,
    ).toBe(true);
    expect(
      dispatcher.includes("const target = await resolveWebhookTarget(url)"),
      `${context}: webhook destination is not pinned immediately before delivery`,
    ).toBe(true);
    expect(
      dispatcher.includes("postWebhook(\n        url,\n        target,"),
      `${context}: resolved webhook address is not passed to the HTTP client`,
    ).toBe(true);
    expect(listMethod.includes("secret"), `${context}: webhook list returns signing secrets`).toBe(
      false,
    );
    expect(
      dispatcher.includes("payload: null"),
      `${context}: terminal webhook rows retain sensitive payloads`,
    ).toBe(true);
    if (facts.organizations) {
      expect(
        service.includes("organizationId: requireOrganization(scope)"),
        `${context}: webhook management is not tenant scoped`,
      ).toBe(true);
      expect(
        dispatcher.includes("organizationId: event.organizationId"),
        `${context}: webhook fan-out crosses tenant boundaries`,
      ).toBe(true);
    }
  }

  // 8. Uploads inherit parent scope, use server-generated keys, and sign immutable PUTs.
  if (facts.uploads) {
    const service = requiredFile(map, "src/generated/uploads/note-attachment.service.ts", context);
    const module = requiredFile(map, "src/generated/uploads/uploads.module.ts", context);
    const s3 = requiredFile(map, "src/generated/uploads/s3.provider.ts", context);
    const controller = requiredFile(
      map,
      "src/generated/uploads/note-attachment.controller.ts",
      context,
    );

    expect(service.includes("randomUUID()"), `${context}: client controls upload object keys`).toBe(
      true,
    );
    expect(service.includes("input.storageKey"), `${context}: upload accepts a client object key`).toBe(
      false,
    );
    expect(controller.includes("storageKey"), `${context}: upload API exposes its storage key`).toBe(
      false,
    );
    expect(
      s3.includes("'if-none-match': '*'"),
      `${context}: presigned PUT can overwrite an existing object`,
    ).toBe(true);
    expect(
      s3.includes("'content-length': String(sizeBytes)") &&
        s3.includes("'content-type': contentType"),
      `${context}: upload size/type are not signed`,
    ).toBe(true);
    expect(
      module.includes("The mock storage provider is only allowed when NODE_ENV is \"test\""),
      `${context}: mock storage can run outside tests`,
    ).toBe(true);
    if (facts.noteSoftDelete) {
      expect(
        service.includes("deletedAt: null"),
        `${context}: uploads accept a soft-deleted parent`,
      ).toBe(true);
    }
    if (facts.scopedNote) {
      expect(
        service.includes("organizationId: requireOrganization(scope)"),
        `${context}: uploads do not inherit tenant scope`,
      ).toBe(true);
    }
    if (facts.ownedNote) {
      expect(
        service.includes("ownerId: requireUser(scope)"),
        `${context}: uploads do not inherit owner scope`,
      ).toBe(true);
    }
  }

  // 9. Notification sinks redact content and terminal outbox rows clear payloads.
  if (facts.notifications) {
    const logProvider = requiredFile(
      map,
      "src/generated/notifications/providers/log.provider.ts",
      context,
    );
    const module = requiredFile(map, "src/generated/notifications/notification.module.ts", context);
    const dispatcher = requiredFile(
      map,
      "src/generated/notifications/notification.dispatcher.ts",
      context,
    );
    const outbox = requiredFile(map, "src/generated/notifications/outbox.ts", context);

    expect(
      logProvider.includes("this.logger.log('[notification] accepted')"),
      `${context}: log provider lacks the metadata-only sink`,
    ).toBe(true);
    for (const sensitiveAccess of ["_message.to", "_message.subject", "_message.text", "_message.html"]) {
      expect(
        logProvider.includes(sensitiveAccess),
        `${context}: log provider reads ${sensitiveAccess}`,
      ).toBe(false);
    }
    expect(
      dispatcher.includes("payload: null"),
      `${context}: terminal notification rows retain message payloads`,
    ).toBe(true);
    expect(
      dispatcher.includes("lastError: error"),
      `${context}: raw provider errors are persisted`,
    ).toBe(false);
    expect(
      module.includes("The mock notification provider is only allowed when NODE_ENV is \"test\""),
      `${context}: mock notifications can run outside tests`,
    ).toBe(true);
    if (facts.userSoftDelete) {
      expect(
        dispatcher.includes("where: { id: userId, deletedAt: null }"),
        `${context}: notifications can target a soft-deleted user`,
      ).toBe(true);
    }
    if (facts.recoveryNotifications) {
      expect(
        outbox.includes(
          "RECOVERY_NOTIFICATION_EVENTS.has(eventName) || !DURABLE_NOTIFICATION_EVENTS.has(eventName)",
        ),
        `${context}: raw recovery credentials can enter the durable outbox`,
      ).toBe(true);
    }
  }

  // 10. A second render is byte-identical.
  const again = renderBackend(compileOk(generated).value);
  const secondMap = fileMap(again.files);
  expect(secondMap.size, `${context}: file count changed between renders`).toBe(map.size);
  for (const [path, contents] of map) {
    expect(secondMap.get(path), `${context}: ${path} not deterministic`).toBe(contents);
  }
}

function compileOk(generated: GeneratedSpec) {
  const result = compileBackend(structuredClone(generated.spec), { features, targets });
  if (!result.ok) {
    throw new Error(
      `seed ${generated.seed} was intended valid but failed to compile: ${result.issues
        .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result;
}

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}; received '${raw}'`);
  }
  return value;
}

describe("fuzzed specifications satisfy the universal security contract", () => {
  const replaySeed = process.env.BACKENDGEN_FUZZ_SEED;
  const sampleCount = positiveInteger("BACKENDGEN_FUZZ_SAMPLES", 250, 100_000);
  const startSeed = positiveInteger("BACKENDGEN_FUZZ_START_SEED", 1, 0xffff_ffff);
  if (startSeed + sampleCount - 1 > 0xffff_ffff) {
    throw new Error("BACKENDGEN_FUZZ_START_SEED + BACKENDGEN_FUZZ_SAMPLES exceeds uint32");
  }
  const seeds =
    replaySeed === undefined || replaySeed === ""
      ? Array.from({ length: sampleCount }, (_, index) => startSeed + index)
      : [positiveInteger("BACKENDGEN_FUZZ_SEED", 1, 0xffff_ffff)];
  const batches = Array.from({ length: Math.ceil(seeds.length / 25) }, (_, index) => {
    const batchSeeds = seeds.slice(index * 25, index * 25 + 25);
    return {
      label:
        batchSeeds.length === 1
          ? `seed ${batchSeeds[0]}`
          : `seeds ${batchSeeds[0]}-${batchSeeds.at(-1)}`,
      seeds: batchSeeds,
    };
  });

  // Thousands of individual Vitest tasks can overwhelm the worker RPC channel
  // after every seed has passed. Small batches retain exact seed diagnostics
  // while keeping CI result traffic bounded.
  it.each(batches)("$label compiles and upholds every invariant", ({ seeds: batchSeeds }) => {
    for (const seed of batchSeeds) {
      const generated = generateSpec(seed);
      const compiled = compileOk(generated);
      const rendered = renderBackend(compiled.value);

      expect(rendered.files.length).toBeGreaterThan(20);
      assertInvariants(generated, rendered.files);
    }
  });
});
