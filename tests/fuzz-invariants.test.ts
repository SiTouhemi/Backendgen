import {
  compileBackend,
  createDefaultRegistry,
  createDefaultTargets,
  renderBackend,
} from "@backend-compiler/generator-runtime";
import { assertSafeRelativePath } from "@backend-compiler/generator-runtime";
import type { BackendSpec } from "@backend-compiler/specification";
import { buildSpec } from "@backend-compiler/testing";
import type { RenderedFile } from "@backend-compiler/target-sdk";
import { describe, expect, it } from "vitest";

/**
 * Property test: for a large sample of randomly assembled but valid
 * specifications, every generated backend must satisfy a fixed set of security
 * invariants. This is the standing guard against the class of defect found by
 * hand before release (a soft-deleted owner counted as active; a rendered path
 * that escapes the output root). A failure prints the seed, so any counterexample
 * replays deterministically.
 */

// A tiny, seeded PRNG (mulberry32) so the whole run is reproducible from a seed.
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

interface GeneratedSpec {
  seed: number;
  spec: BackendSpec;
  /** What the generator intentionally enabled, so invariants know what to expect. */
  facts: {
    auth: boolean;
    organizations: boolean;
    scopedNote: boolean;
    ownedNote: boolean;
    userSoftDelete: boolean;
    noteSoftDelete: boolean;
  };
}

function generateSpec(seed: number): GeneratedSpec {
  const next = rng(seed);

  const auth = chance(next, 0.75);
  // organizations depends on auth + crud.
  const organizations = auth && chance(next, 0.5);
  const scopedNote = organizations && chance(next, 0.7);
  const ownedNote = auth && !scopedNote && chance(next, 0.5);
  const userSoftDelete = auth && chance(next, 0.5);
  const noteSoftDelete = chance(next, 0.5);

  const entities: BackendSpec["entities"] = {
    Note: {
      fields: {
        title: { type: "string", required: true, minLength: 1, maxLength: 200 },
        body: "text",
        pinned: { type: "boolean", default: false },
      },
    },
  };
  if (auth) {
    entities.User = {
      fields: {
        displayName: { type: "string", required: true, minLength: 2, maxLength: 100 },
      },
    };
  }

  const softDelete: string[] = [];
  if (noteSoftDelete) softDelete.push("Note");
  if (userSoftDelete) softDelete.push("User");

  const features: BackendSpec["features"] = {
    crud: {
      ...(ownedNote ? { ownedBy: { Note: "User" } } : {}),
      ...(softDelete.length > 0 ? { softDelete } : {}),
    },
  };
  if (auth) {
    features.auth = {
      roles: ["admin", "member"],
      emailVerification: chance(next, 0.5),
      passwordReset: chance(next, 0.5),
    };
  }
  if (organizations) {
    features.organizations = {
      roles: ["owner", "admin", "member"],
      defaultRole: "member",
      ...(scopedNote ? { scopedEntities: ["Note"] } : { scopedEntities: [] }),
    };
  }
  if (auth && chance(next, 0.4)) {
    features.webhooks = { maxAttempts: 2, disableAfterFailures: 1 };
  }
  if (chance(next, 0.4)) {
    features.jobs = { cron: [{ name: "heartbeat", schedule: "* * * * *" }] };
  }

  return {
    seed,
    spec: buildSpec({
      name: `fuzz-${seed}-api`,
      description: `Fuzzed specification, seed ${seed}`,
      entities,
      features,
    }),
    facts: { auth, organizations, scopedNote, ownedNote, userSoftDelete, noteSoftDelete },
  };
}

const features = createDefaultRegistry();
const targets = createDefaultTargets();

function fileMap(files: readonly RenderedFile[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.contents] as const));
}

/** The security contract. Each throws with a descriptive message on violation. */
function assertInvariants(generated: GeneratedSpec, files: readonly RenderedFile[]): void {
  const map = fileMap(files);
  const { facts, seed } = generated;
  const at = (path: string): string | undefined => map.get(path);
  const context = `seed ${seed} (${JSON.stringify(facts)})`;

  // 1. Every rendered path stays inside the output root.
  for (const file of files) {
    expect(assertSafeRelativePath(file.path), `${context}: unsafe path ${file.path}`).toBeNull();
  }

  // 2. A secret value never appears in any response DTO.
  for (const [path, contents] of map) {
    if (path.endsWith(".response.dto.ts") || path.endsWith("/note.response.dto.ts")) {
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

  // 4. A tenant-scoped Note filters by organizationId on the server.
  const noteService = at("src/generated/note/note.service.ts");
  if (facts.scopedNote) {
    expect(noteService, `${context}: scoped Note has no service`).toBeDefined();
    expect(
      noteService!.includes("organizationId"),
      `${context}: scoped Note service does not filter by organizationId`,
    ).toBe(true);
  }

  // 5. An owned Note filters by ownerId for non-admins.
  if (facts.ownedNote && noteService !== undefined) {
    expect(
      noteService.includes("ownerId"),
      `${context}: owned Note service does not filter by ownerId`,
    ).toBe(true);
  }

  // 6. The active-owner invariant regression: when the user entity is
  //    soft-deletable and organizations are present, owner counts must exclude
  //    soft-deleted users. This is the exact bug fixed before release.
  const orgService = at("src/generated/organizations/organization.service.ts");
  if (facts.organizations) {
    expect(orgService, `${context}: organizations without a service`).toBeDefined();
    if (facts.userSoftDelete) {
      // Every owner-count query must exclude soft-deleted users. Rejecting the
      // unfiltered form catches a single unguarded count, which the mere
      // presence of a filtered count elsewhere would otherwise mask.
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

  // 7. Determinism: a second render is byte-identical.
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

describe("fuzzed specifications satisfy the security contract", () => {
  const SAMPLE = 250;
  const seeds = Array.from({ length: SAMPLE }, (_, index) => index + 1);

  it.each(seeds)("seed %i generates a backend that upholds every invariant", (seed) => {
    const generated = generateSpec(seed);
    const compiled = compileOk(generated);
    const rendered = renderBackend(compiled.value);

    expect(rendered.files.length).toBeGreaterThan(20);
    assertInvariants(generated, rendered.files);
  });
});
