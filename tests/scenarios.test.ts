import {
  compileBackend,
  createDefaultRegistry,
  createDefaultTargets,
  renderBackend,
} from "@backend-compiler/generator-runtime";
import { runConformanceSuite, SCENARIOS } from "@backend-compiler/testing";
import { describe, expect, it } from "vitest";

const features = createDefaultRegistry();
const targets = createDefaultTargets();

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
  });

  it("basic-crud generates no authentication and no secret", () => {
    const { compiled, rendered } = compile("basic-crud");

    expect(compiled.ir.secrets).toEqual([]);
    expect(rendered.files.map((file) => file.path)).not.toContain(
      "src/generated/auth/auth.service.ts",
    );
    expect(compiled.ir.endpoints.every((endpoint) => endpoint.auth === "public")).toBe(true);
  });

  it("authentication scopes owned rows and hides the password hash", () => {
    const { compiled, rendered } = compile("authentication");

    const note = compiled.ir.entities.find((entity) => entity.name === "Note")!;
    expect(note.ownership).toEqual({ relation: "owner", foreignKey: "ownerId", entity: "User" });
    expect(note.softDelete).toBe(true);

    const user = compiled.ir.entities.find((entity) => entity.name === "User")!;
    expect(user.crud).toBe(false);
    expect(user.fields.find((field) => field.name === "passwordHash")?.internal).toBe(true);

    expect(compiled.ir.secrets.map((secret) => secret.name)).toContain("JWT_ACCESS_SECRET");

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

    const paths = rendered.files.map((file) => file.path);
    expect(paths).toContain("test/tenant-isolation.e2e-spec.ts");
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
  });

  it("all-features combines tenants, ownership and reservations without conflict", () => {
    const { compiled, rendered } = compile("all-features");

    expect(compiled.ir.features.map((feature) => feature.name)).toEqual([
      "crud",
      "auth",
      "notifications",
      "organizations",
      "reservations",
    ]);

    const reservation = compiled.ir.entities.find((entity) => entity.name === "Reservation")!;
    expect(reservation.tenant?.entity).toBe("Organization");
    expect(reservation.ownership?.entity).toBe("User");

    const appModule = rendered.files.find((file) => file.path === "src/app.module.ts")!;
    expect(appModule.contents).toContain("JwtAuthGuard");
    expect(appModule.contents).toContain("OrganizationContextGuard");
    expect(appModule.contents).toContain("RolesGuard");

    // The organization context guard must run after authentication and before
    // the role guard, or a tenant check would read an empty request.
    const guardOrder = ["JwtAuthGuard", "OrganizationContextGuard", "RolesGuard"].map((symbol) =>
      appModule.contents.indexOf(`{ provide: APP_GUARD, useClass: ${symbol} }`),
    );
    expect(guardOrder).toEqual([...guardOrder].sort((left, right) => left - right));
    expect(guardOrder.every((index) => index >= 0)).toBe(true);
  });
});

describe("specification errors", () => {
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
