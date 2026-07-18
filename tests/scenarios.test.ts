import {
  compileBackend,
  createDefaultRegistry,
  createDefaultTargets,
  renderBackend,
} from "@backend-compiler/generator-runtime";
import { PUBLIC_SCHEMAS } from "@backend-compiler/specification";
import { runConformanceSuite, SCENARIOS } from "@backend-compiler/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const features = createDefaultRegistry();
const targets = createDefaultTargets();
const validateFrontendContract = new Ajv2020({ allErrors: true, strict: true }).compile(
  PUBLIC_SCHEMAS.frontend,
);

function compile(name: string) {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name)!;
  const result = compileBackend(structuredClone(scenario.spec), { features, targets });

  if (!result.ok) {
    throw new Error(
      `${name} failed to compile: ${result.issues
        .map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return { compiled: result.value, rendered: renderBackend(result.value) };
}

describe("feature conformance", () => {
  it("every feature satisfies its own conformance cases on nestjs-prisma", () => {
    const results = runConformanceSuite({ targetId: "nestjs-prisma", features, targets });

    expect(results.length).toBeGreaterThanOrEqual(5);

    const failures = results.filter((result) => !result.passed);
    expect(failures).toEqual([]);
  });
});

describe("scenarios", () => {
  it.each(SCENARIOS.map((scenario) => scenario.name))("compiles and renders '%s'", (name) => {
    const { compiled, rendered } = compile(name);

    expect(rendered.files.length).toBeGreaterThan(20);
    expect(compiled.ir.entities.length).toBeGreaterThan(0);

    const paths = rendered.files.map((file) => file.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("prisma/schema.prisma");
    expect(paths).toContain("src/app.module.ts");
    expect(paths).toContain("src/main.ts");
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("docker-compose.yml");
    expect(paths).toContain(".env.example");
    expect(paths).toContain("frontend-contract.json");
  });

  it.each(SCENARIOS.map((scenario) => scenario.name))(
    "renders a compact, secret-free frontend contract for '%s'",
    (name) => {
      const { compiled, rendered } = compile(name);
      const contractFile = rendered.files.find(
        (file) => file.path === "frontend-contract.json",
      )!;
      const contract = JSON.parse(contractFile.contents) as {
        schemaVersion: string;
        api: { basePath: string; cors: { environmentVariable: string; credentials: boolean } };
        entities: Array<{ name: string; fields: Array<{ name: string }> }>;
        endpoints: Array<{ path: string }>;
      };

      expect(
        validateFrontendContract(contract),
        JSON.stringify(validateFrontendContract.errors, null, 2),
      ).toBe(true);
      expect(contract.schemaVersion).toBe("backendcompiler.dev/frontend-contract/v1");
      expect(contract.api.basePath).toBe("/api");
      expect(contract.api.cors).toEqual({
        environmentVariable: "CORS_ORIGINS",
        format: "comma-separated exact origins",
        credentials: false,
      });
      expect(contract.endpoints.every((endpoint) => endpoint.path.startsWith("/api/"))).toBe(
        true,
      );

      for (const entity of contract.entities) {
        const compiledEntity = compiled.ir.entities.find(
          (candidate) => candidate.name === entity.name,
        )!;
        const internalFields = new Set(
          compiledEntity.fields.filter((field) => field.internal).map((field) => field.name),
        );
        expect(entity.fields.some((field) => internalFields.has(field.name))).toBe(false);
      }
      expect(contractFile.contents).not.toContain("replace-with-a-random");
      // Secret environment names (and so their values) never reach the contract.
      for (const secret of compiled.ir.secrets) {
        expect(contractFile.contents).not.toContain(secret.name);
      }
    },
  );

  it("generates exact-origin CORS parsing and keeps credentials disabled", () => {
    const { rendered } = compile("all-features");
    const environment = rendered.files.find(
      (file) => file.path === "src/generated/config/environment.ts",
    )!.contents;
    const bootstrap = rendered.files.find(
      (file) => file.path === "src/generated/common/bootstrap.ts",
    )!.contents;
    const main = rendered.files.find((file) => file.path === "src/main.ts")!.contents;
    const envExample = rendered.files.find((file) => file.path === ".env.example")!.contents;
    const environmentSpec = rendered.files.find(
      (file) => file.path === "src/generated/config/environment.spec.ts",
    )!.contents;

    expect(environment).toContain("parseCorsOrigins");
    expect(environment).toContain("does not allow wildcard origins");
    expect(environment).toContain("requires HTTPS origins in production");
    expect(bootstrap).toContain("app.enableCors");
    expect(bootstrap).toContain("credentials: false");
    expect(main).toContain("corsOrigins: environment.CORS_ORIGINS");
    expect(envExample).toContain("CORS_ORIGINS=");
    expect(environmentSpec).toContain("rejects unsafe origin");
  });

  it.each(SCENARIOS.map((scenario) => scenario.name))(
    "renders a deterministic, clock-free seed for '%s'",
    (name) => {
      const { rendered } = compile(name);
      const seed = rendered.files.find((file) => file.path === "prisma/seed.ts");
      const seedTest = rendered.files.find((file) => file.path === "test/seed.e2e-spec.ts");
      const packageJson = JSON.parse(
        rendered.files.find((file) => file.path === "package.json")!.contents,
      ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

      expect(seed).toBeDefined();
      expect(seedTest).toBeDefined();
      expect(packageJson.scripts["db:seed"]).toContain("prisma/seed.ts");
      expect(packageJson.devDependencies["ts-node"]).toBe("10.9.2");

      // Determinism: nothing in the seed may depend on the clock or randomness.
      expect(seed!.contents).not.toContain("Date.now(");
      expect(seed!.contents).not.toContain("Math.random");
      expect(seed!.contents).not.toContain("randomUUID");
      expect(seed!.contents).toContain("upsert");

      // Two renders of the same specification emit byte-identical seeds.
      const again = compile(name).rendered.files.find((file) => file.path === "prisma/seed.ts");
      expect(again!.contents).toBe(seed!.contents);
    },
  );

  it("generates production-safe, role-aware development seeds", () => {
    const { rendered } = compile("all-features");
    const seed = rendered.files.find((file) => file.path === "prisma/seed.ts")!.contents;

    expect(seed).toContain("ALLOW_PRODUCTION_SEED !== 'true'");
    expect(seed).toContain("role: index === 0");
    expect(seed).toContain("UserRole.admin");
    expect(seed).toContain("UserRole.member");
    expect(seed).toContain("MembershipRole.owner");
    expect(seed).toContain("ReservationStatus.CONFIRMED");
    expect(seed).not.toContain("as never");
  });

  it("omits an impossible seed instead of emitting guaranteed unique violations", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === "basic-crud")!;
    const spec = structuredClone(scenario.spec);
    spec.entities.Note!.fields.code = {
      type: "string",
      required: true,
      unique: true,
      enum: ["ONLY"],
    };

    const result = compileBackend(spec, { features, targets });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = renderBackend(result.value).files.map((file) => file.path);
    expect(paths).not.toContain("prisma/seed.ts");
  });

  it("uses a global parent pool when only the child entity is tenant-scoped", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === "multi-tenant-saas")!;
    const spec = structuredClone(scenario.spec);
    spec.features.organizations = {
      ...(spec.features.organizations ?? {}),
      scopedEntities: ["Task"],
    };

    const result = compileBackend(spec, { features, targets });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seed = renderBackend(result.value).files.find(
      (file) => file.path === "prisma/seed.ts",
    )!.contents;

    expect(seed).toContain("projectId: projectIds[index % projectIds.length]!");
    expect(seed).not.toContain("projectIdsByOrganization[organizationId]");
  });

  it("makes an explicit unique-index field deterministic across every row", () => {
    const spec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "basic-crud")!.spec,
    );
    spec.entities.Note!.indexes = [{ fields: ["title", "pinned"], unique: true }];

    const result = compileBackend(spec, { features, targets });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seed = renderBackend(result.value).files.find(
      (file) => file.path === "prisma/seed.ts",
    )!.contents;

    expect(seed).toContain("title: seedUniqueString(ordinal, 1, 200)");
  });

  it("excludes a tenant child whose unique global parent pool is too small", () => {
    const spec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "multi-tenant-saas")!.spec,
    );
    spec.features.organizations = {
      ...(spec.features.organizations ?? {}),
      scopedEntities: ["Task"],
    };
    spec.entities.Task!.indexes = [{ fields: ["projectId"], unique: true }];

    const result = compileBackend(spec, { features, targets });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seed = renderBackend(result.value).files.find(
      (file) => file.path === "prisma/seed.ts",
    )!.contents;

    expect(seed).toContain("Not seeded: Task");
    expect(seed).toContain("unique relation project has 5 parent row(s) for 10 child rows");
  });

  it("omits both seed and seed test when auth users require an unsatisfied relation", () => {
    const spec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "file-uploads")!.spec,
    );
    spec.entities.User!.relations = [
      { name: "manager", type: "belongsTo", target: "User", required: true },
    ];

    const result = compileBackend(spec, { features, targets });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = renderBackend(result.value).files.map((file) => file.path);

    expect(paths).not.toContain("prisma/seed.ts");
    expect(paths).not.toContain("test/seed.e2e-spec.ts");
  });

  it.each(SCENARIOS.map((scenario) => scenario.name))(
    "renders a typed API client for '%s'",
    (name) => {
      const { compiled, rendered } = compile(name);
      const paths = rendered.files.map((file) => file.path);

      expect(paths).toContain("client/src/index.ts");
      expect(paths).toContain("client/src/types.ts");
      expect(paths).toContain("client/package.json");

      const index = rendered.files.find((file) => file.path === "client/src/index.ts")!;
      for (const entity of compiled.ir.entities.filter((candidate) => candidate.crud)) {
        expect(index.contents).toContain(`Create${entity.name}Input`);
      }

      const packageJson = JSON.parse(
        rendered.files.find((file) => file.path === "package.json")!.contents,
      ) as { scripts: Record<string, string> };
      expect(packageJson.scripts["build:client"]).toBe("tsc -p client/tsconfig.json");
    },
  );

  it("omits the client when options.client is false", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === "basic-crud")!;
    const spec = structuredClone(scenario.spec);
    spec.options = { client: false };

    const result = compileBackend(spec, { features, targets });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = renderBackend(result.value).files.map((file) => file.path);
    expect(paths.some((path) => path.startsWith("client/"))).toBe(false);
  });

  it.each(SCENARIOS.map((scenario) => scenario.name))(
    "pins every direct generated dependency for '%s'",
    (name) => {
      const { rendered } = compile(name);
      const packageFile = rendered.files.find((file) => file.path === "package.json")!;
      const manifest = JSON.parse(packageFile.contents) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      const versions = [...Object.values(manifest.dependencies), ...Object.values(manifest.devDependencies)];

      expect(versions.every((version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))).toBe(true);
    },
  );

  it("basic-crud generates no authentication and no secret", () => {
    const { compiled, rendered } = compile("basic-crud");

    expect(compiled.ir.secrets).toEqual([]);
    expect(rendered.files.map((file) => file.path)).not.toContain(
      "src/generated/auth/auth.service.ts",
    );
    expect(compiled.ir.endpoints.every((endpoint) => endpoint.auth === "public")).toBe(true);
    const appModule = rendered.files.find((file) => file.path === "src/app.module.ts")!;
    expect(appModule.contents).not.toContain("APP_GUARD");
  });

  it("authentication scopes owned rows and hides the password hash", () => {
    const { compiled, rendered } = compile("authentication");

    const note = compiled.ir.entities.find((entity) => entity.name === "Note")!;
    expect(note.ownership).toEqual({ relation: "owner", foreignKey: "ownerId", entity: "User" });
    expect(note.softDelete).toBe(true);

    const user = compiled.ir.entities.find((entity) => entity.name === "User")!;
    expect(user.crud).toBe(false);
    expect(user.softDelete).toBe(true);
    expect(user.fields.find((field) => field.name === "passwordHash")?.internal).toBe(true);

    expect(compiled.ir.secrets.map((secret) => secret.name)).toContain("JWT_ACCESS_SECRET");

    const testEnvironment = rendered.files.find(
      (file) => file.path === "test/utils/test-env.ts",
    )!;
    expect(testEnvironment.contents).toContain("JWT_ACCESS_SECRET");
    expect(testEnvironment.contents).toContain("test-only-jwt-secret");

    const service = rendered.files.find(
      (file) => file.path === "src/generated/note/note.service.ts",
    )!;
    expect(service.contents).toContain("requireUser(scope)");

    const response = rendered.files.find(
      (file) => file.path === "src/generated/note/dto/note.response.dto.ts",
    )!;
    expect(response.contents).not.toContain("passwordHash");
  });

  it("multi-tenant-saas scopes every tenant entity and filters on the server", () => {
    const { compiled, rendered } = compile("multi-tenant-saas");

    for (const name of ["Project", "Task"]) {
      const entity = compiled.ir.entities.find((candidate) => candidate.name === name)!;
      expect(entity.tenant?.entity).toBe("Organization");
    }

    // The user entity is never tenant-scoped: one account can join many tenants.
    const user = compiled.ir.entities.find((entity) => entity.name === "User")!;
    expect(user.tenant).toBeNull();

    const service = rendered.files.find(
      (file) => file.path === "src/generated/project/project.service.ts",
    )!;
    expect(service.contents).toContain("organizationId: requireOrganization(scope)");
    expect(service.contents).toContain("error.code === 'P2003'");
    expect(service.contents).toContain("23001");

    const paths = rendered.files.map((file) => file.path);
    expect(paths).toContain("test/tenant-isolation.e2e-spec.ts");

    const projectE2e = rendered.files.find(
      (file) => file.path === "test/project.e2e-spec.ts",
    )!;
    expect(projectE2e.contents).toContain(".post('/api/organizations')");
    expect(projectE2e.contents).toContain("'X-Organization-Id': organizationId");
    expect(projectE2e.contents).toContain(
      "refuses destructive operations for a disallowed organization role",
    );
    expect(projectE2e.contents).toContain("role: \"member\" as never");
    expect(projectE2e.contents).toContain(
      "returns conflict and retains data when a dependent restricts deletion",
    );

    const projectController = rendered.files.find(
      (file) => file.path === "src/generated/project/project.controller.ts",
    )!;
    expect(projectController.contents).toContain('@OrgRoles("owner", "admin")');
    expect(projectController.contents).toContain("@ApiConflictResponse({ type: ApiErrorDto })");
    expect(projectController.contents).toContain("@ApiPaginatedResponse(ProjectResponseDto)");

    const projectDelete = compiled.ir.endpoints.find(
      (endpoint) => endpoint.id === "Project.delete",
    )!;
    expect(projectDelete.roles).toEqual(["owner", "admin"]);
    const projectDeletePermission = compiled.ir.permissions.find(
      (permission) => permission.entity === "Project" && permission.action === "delete",
    )!;
    expect(projectDeletePermission.roles).toEqual(["owner", "admin"]);

    const taskE2e = rendered.files.find((file) => file.path === "test/task.e2e-spec.ts")!;
    expect(taskE2e.contents).toContain(
      "createProject(prisma, { organizationId: organizationId })",
    );

    const response = rendered.files.find(
      (file) => file.path === "src/generated/project/dto/project.response.dto.ts",
    )!;
    expect(response.contents).toContain("import { ProjectStatus } from '@prisma/client';");
    expect(response.contents).toContain("import type { Project } from '@prisma/client';");
  });

  it("hotel-reservation enforces overlap in the database, not in the service", () => {
    const { compiled, rendered } = compile("hotel-reservation");

    const migration = rendered.files.find((file) =>
      file.path.endsWith("_init/migration.sql"),
    )!;

    expect(migration.contents).toContain("CREATE EXTENSION IF NOT EXISTS btree_gist");
    expect(migration.contents).toContain('ADD CONSTRAINT "Reservation_no_overlap"');
    expect(migration.contents).toContain("EXCLUDE USING gist");

    expect(compiled.ir.infrastructure.map((item) => item.name)).toContain("btree_gist");

    const paths = rendered.files.map((file) => file.path);
    expect(paths).toContain("test/reservation-concurrency.e2e-spec.ts");
    expect(paths).toContain("src/custom/reservation-policy.ts");

    // The reservation service must not know how a notification is delivered.
    const service = rendered.files.find(
      (file) => file.path === "src/generated/reservations/reservation.service.ts",
    )!;
    expect(service.contents).not.toContain("resend");
    expect(service.contents).not.toContain("NotificationProvider");
    expect(service.contents).toContain("this.events.emit('reservation.confirmed'");

    // Soft-delete is a data predicate, not a request-scope predicate. Strict
    // projects must still consume the scope parameter when no tenant or owner
    // condition applies.
    const roomService = rendered.files.find(
      (file) => file.path === "src/generated/room/room.service.ts",
    )!;
    expect(roomService.contents).toContain(
      "const clauses: Prisma.RoomWhereInput[] = [where];\n    void scope;\n    clauses.push({ deletedAt: null });",
    );
  });

  it("appointment-scheduling confirms immediately when holds are disabled", () => {
    const { compiled, rendered } = compile("appointment-scheduling");

    const appointment = compiled.ir.entities.find((entity) => entity.name === "Appointment")!;
    expect(appointment.fields.find((field) => field.name === "status")?.defaultValue).toBe(
      "CONFIRMED",
    );

    const paths = rendered.files.map((file) => file.path);
    expect(paths).not.toContain("src/generated/reservations/hold-expiry.job.ts");

    const workflow = compiled.ir.workflows[0]!;
    expect(workflow.initialState).toBe("CONFIRMED");
    expect(workflow.states).toEqual(["CONFIRMED", "CANCELLED"]);
    expect(workflow.transitions).toEqual([
      { from: "CONFIRMED", to: "CANCELLED", trigger: "cancel" },
    ]);
    expect(
      compiled.ir.endpoints.some((endpoint) => endpoint.id === "Appointment.confirm"),
    ).toBe(false);
    expect(compiled.ir.events.some((event) => event.name === "reservation.expired")).toBe(false);
    const client = rendered.files.find((file) => file.path === "client/src/index.ts")!;
    expect(client.contents).not.toContain("confirm(id: string)");
    expect(client.contents).not.toContain("/confirm");
  });

  it("webhooks generate transactional capture, safe management, and an authorization-aware client proof", () => {
    const { compiled, rendered } = compile("webhooks");
    const contents = (path: string): string =>
      rendered.files.find((file) => file.path === path)?.contents ?? "";

    expect(compiled.ir.endpoints.find((endpoint) => endpoint.id === "WebhookEndpoint.create")?.roles)
      .toEqual(["admin"]);
    expect(contents("src/generated/auth/auth.service.ts")).toContain(
      "await enqueueWebhookEvent(tx, 'user.registered'",
    );
    expect(contents("src/generated/webhooks/webhook-dispatcher.ts")).toContain(
      "skipDuplicates: true",
    );
    expect(contents("src/generated/webhooks/webhook-dispatcher.ts")).toContain(
      "resolveWebhookTarget(url)",
    );
    expect(contents("test/client.e2e-spec.ts")).toContain(
      "data: { role: \"admin\" }",
    );
  });

  it("tenant webhooks fail closed and generate organization-isolation coverage", () => {
    const { rendered } = compile("webhooks-multitenant");
    const contents = (path: string): string =>
      rendered.files.find((file) => file.path === path)?.contents ?? "";

    expect(contents("src/generated/webhooks/webhook-outbox.ts")).not.toContain(
      '"user.registered"',
    );
    expect(contents("src/generated/webhooks/webhook-outbox.ts")).toContain(
      "organizationId: string",
    );
    expect(contents("src/generated/webhooks/webhook.controller.ts")).toContain(
      '@OrgRoles("owner")',
    );
    expect(contents("src/generated/webhooks/webhook-dispatcher.ts")).toContain(
      "organizationId: event.organizationId",
    );
    expect(contents("test/webhooks.e2e-spec.ts")).toContain(
      "never fans an organization event out across tenant boundaries",
    );
  });

  it("scopes reservations to owned resources and never treats the registration role as admin", () => {
    const scenario = SCENARIOS.find(
      (candidate) => candidate.name === "appointment-scheduling",
    )!;
    const spec = structuredClone(scenario.spec);
    spec.features.auth = {
      ...spec.features.auth,
      roles: ["manager", "admin"],
    };
    spec.features.crud = {
      ...spec.features.crud,
      ownedBy: { Practitioner: "User" },
    };

    const result = compileBackend(spec, { features, targets });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderBackend(result.value);
    const service = rendered.files.find(
      (file) => file.path === "src/generated/reservations/reservation.service.ts",
    )!;
    const controller = rendered.files.find(
      (file) => file.path === "src/generated/reservations/reservation.controller.ts",
    )!;

    expect(service.contents).toContain('const ADMIN_ROLES = ["manager"]');
    expect(service.contents).toContain(
      "...(isAdmin(scope, ADMIN_ROLES) ? {} : { ownerId: ownerId }),",
    );
    expect(service.contents).toContain("const ownerId = requireUser(scope);");
    expect(controller.contents).toContain("this.service.availability(query, scope)");
  });

  it("all-features combines tenants, ownership and reservations without conflict", () => {
    const { compiled, rendered } = compile("all-features");

    expect(compiled.ir.features.map((feature) => feature.name)).toEqual([
      "crud",
      "auth",
      "jobs",
      "notifications",
      "organizations",
      "reservations",
      "uploads",
      "webhooks",
    ]);

    const reservation = compiled.ir.entities.find((entity) => entity.name === "Reservation")!;
    expect(reservation.tenant?.entity).toBe("Organization");
    expect(reservation.ownership?.entity).toBe("User");

    const appModule = rendered.files.find((file) => file.path === "src/app.module.ts")!;
    expect(appModule.contents).toContain("JwtAuthGuard");
    expect(appModule.contents).toContain("OrganizationContextGuard");
    expect(appModule.contents).toContain("RolesGuard");
    expect(appModule.contents).toContain("JobsModule");
    expect(appModule.contents).toContain("UploadsModule");
    expect(appModule.contents).toContain("WebhooksModule");
    expect(
      rendered.files.some((file) => file.path === "test/client.e2e-spec.ts"),
    ).toBe(true);

    // The organization context guard must run after authentication and before
    // the role guard, or a tenant check would read an empty request.
    const guardOrder = [
      "JwtAuthGuard",
      "OrganizationContextGuard",
      "OrganizationRolesGuard",
      "RolesGuard",
    ].map((symbol) =>
      appModule.contents.indexOf(`{ provide: APP_GUARD, useClass: ${symbol} }`),
    );
    expect(guardOrder).toEqual([...guardOrder].sort((left, right) => left - right));
    expect(guardOrder.every((index) => index >= 0)).toBe(true);
  });

  it("all-features emits secure defaults at every generated trust boundary", () => {
    const { rendered } = compile("all-features");
    const contents = (path: string): string =>
      rendered.files.find((file) => file.path === path)?.contents ?? "";

    expect(contents("src/main.ts")).toContain("{ bodyParser: false }");
    const bootstrap = contents("src/generated/common/bootstrap.ts");
    expect(bootstrap).toContain("server.disable('x-powered-by')");
    expect(bootstrap).toContain("helmet(");
    expect(bootstrap).toContain("json({ limit: '100kb'");

    const tokens = contents("src/generated/auth/token.service.ts");
    expect(tokens).toContain("tx.refreshSession.updateMany");
    expect(tokens).toContain("claimed.count !== 1");
    expect(contents("src/generated/auth/jwt.strategy.ts")).toContain("algorithms: ['HS256']");

    const organizations = contents("src/generated/organizations/organization.service.ts");
    expect(organizations).toContain("TransactionIsolationLevel.Serializable");
    expect(organizations).toContain("membership.role === OWNER_ROLE && dto.role !== OWNER_ROLE");

    const reservations = contents("src/generated/reservations/reservation.service.ts");
    expect(reservations).toContain("const idempotencyWhere");
    expect(reservations).toContain("where: idempotencyWhere");
    expect(reservations).toContain("requestFingerprint");
    expect(reservations).toContain("updateManyAndReturn");
    expect(reservations).not.toContain("findUnique({ where: { idempotencyKey }");

    const logProvider = contents("src/generated/notifications/providers/log.provider.ts");
    expect(logProvider).not.toContain("message.text");
    expect(logProvider).not.toContain("message.to");
    expect(contents("src/generated/notifications/providers/resend.provider.ts")).toContain(
      "AbortSignal.timeout",
    );

    expect(contents("Dockerfile")).toContain("USER node");
    expect(contents("Dockerfile")).toContain("/api/health/live");
    const compose = contents("docker-compose.yml");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain("${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}");
    expect(compose).not.toContain("POSTGRES_PASSWORD: everything-api");

    const readme = contents("README.md");
    expect(readme).toContain("A valid Resend API key");
    expect(readme).toContain("Resend is an external service");
    expect(readme).toContain("cannot deliver verification or");
    expect(readme).toContain("password-reset links");

    const tsconfig = JSON.parse(contents("tsconfig.json")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions).toMatchObject({
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
    });

    const pagination = contents("src/generated/common/pagination.ts");
    expect(pagination).toContain("export function ApiPaginatedResponse");
    expect(pagination).toContain("type: 'object'");

    const health = contents("src/generated/health/health.controller.ts");
    expect(health).toContain("@Get('live')");
    expect(health).toContain("@Get('ready')");
    expect(health).toContain("throw new ServiceUnavailableException");
    expect(contents("test/health.e2e-spec.ts")).toContain(".expect(503)");
    expect(contents("test/openapi.e2e-spec.ts")).toContain("required: ['data', 'meta']");
  });

  it("applies configured CRUD pagination defaults and bounds to runtime validation", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === "multi-tenant-saas")!;
    const spec = structuredClone(scenario.spec);
    spec.features.crud = {
      ...spec.features.crud,
      defaultPageSize: 17,
      maxPageSize: 42,
    };

    const result = compileBackend(spec, { features, targets });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rendered = renderBackend(result.value);
    const query = rendered.files.find(
      (file) => file.path === "src/generated/project/dto/query-project.dto.ts",
    )!;

    expect(query.contents).toContain("@Max(42)");
    expect(query.contents).toContain("pageSize: number = 17");
    expect(query.contents).not.toContain("extends PaginationQueryDto");
  });

  it("tenant-scoped relations cannot point at another tenant's row", () => {
    const { rendered } = compile("multi-tenant-saas");
    const service = rendered.files.find(
      (file) => file.path === "src/generated/task/task.service.ts",
    )!;

    expect(service.contents).toContain("this.prisma.project.findFirst");
    expect(service.contents).toContain("organizationId: requireOrganization(scope)");
    expect(service.contents).toContain("Invalid related Project");
  });
});

describe("specification errors", () => {
  it("rejects fields that collide with auth-owned security state", () => {
    const spec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "authentication")!.spec,
    );
    spec.entities.User!.fields.role = { type: "string", required: true };

    expect(compileBackend(spec, { features, targets })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "feature.field-conflict" })],
    });
  });

  it("rejects empty and unknown destructive role policies", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === "multi-tenant-saas")!;

    const empty = structuredClone(scenario.spec);
    empty.features.crud = { ...empty.features.crud, destructiveOrgRoles: [] };
    const emptyResult = compileBackend(empty, { features, targets });
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) {
      expect(
        emptyResult.issues.some((issue) => issue.path.includes("destructiveOrgRoles")),
      ).toBe(true);
    }

    const unknown = structuredClone(scenario.spec);
    unknown.features.crud = {
      ...unknown.features.crud,
      destructiveOrgRoles: ["superuser"],
    };
    const unknownResult = compileBackend(unknown, { features, targets });
    expect(unknownResult).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "feature.crud.unknown-destructive-org-role" })],
    });
  });

  it("rejects ownership bypass for the self-registration role", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === "authentication")!;
    const spec = structuredClone(scenario.spec);
    spec.features.auth = { ...spec.features.auth, roles: ["manager", "admin"] };
    spec.features.crud = {
      ...spec.features.crud,
      adminRoles: ["admin"],
    };

    expect(compileBackend(spec, { features, targets })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "feature.crud.self-registration-admin-role" })],
    });
  });

  it("refuses a bcrypt password minimum above its safe 72-byte ceiling", () => {
    const spec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "authentication")!.spec,
    );
    spec.features.auth = { ...spec.features.auth, minPasswordLength: 73 };

    const result = compileBackend(spec, { features, targets });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path.includes("minPasswordLength"))).toBe(true);
  });

  it("refuses to compile a reservation entity the user also declared", () => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === "hotel-reservation")!;
    const spec = structuredClone(scenario.spec);
    spec.entities.Reservation = { fields: { note: "string" } };

    const result = compileBackend(spec, { features, targets });

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "feature.reservations.entity-exists" })],
    });
  });

  it("refuses ownership scoping without authentication", () => {
    const spec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "basic-crud")!.spec,
    );
    spec.entities.User = { fields: { displayName: { type: "string", required: true } } };
    spec.features = { crud: { ownedBy: { Note: "User" } } };

    const result = compileBackend(spec, { features, targets });

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "feature.crud.ownership-requires-auth" })],
    });
  });

  it("rejects owner entities that cannot be derived from the authenticated principal", () => {
    const crudSpec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "authentication")!.spec,
    );
    crudSpec.features.crud = { ...crudSpec.features.crud, ownedBy: { Note: "Note" } };

    expect(compileBackend(crudSpec, { features, targets })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "feature.crud.unsupported-owner-entity" })],
    });

    const reservationSpec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "hotel-reservation")!.spec,
    );
    reservationSpec.features.reservations = {
      ...reservationSpec.features.reservations,
      owner: "Room",
    };

    expect(compileBackend(reservationSpec, { features, targets })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "feature.reservations.unsupported-owner-entity" })],
    });
  });

  it("refuses a database the target cannot support", () => {
    const spec = structuredClone(
      SCENARIOS.find((candidate) => candidate.name === "basic-crud")!.spec,
    );
    spec.target.database = "sqlite";

    const result = compileBackend(spec, { features, targets });

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "target.unsupported-database" })],
    });
  });
});
