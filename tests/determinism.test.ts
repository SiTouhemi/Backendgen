import { sha256 } from "@backend-compiler/common";
import {
  compileBackend,
  createDefaultRegistry,
  createDefaultTargets,
  renderBackend,
} from "@backend-compiler/generator-runtime";
import { SCENARIOS, scenarioSpec } from "@backend-compiler/testing";
import type { BackendSpec } from "@backend-compiler/specification";
import { describe, expect, it } from "vitest";

const features = createDefaultRegistry();
const targets = createDefaultTargets();

function render(spec: BackendSpec) {
  const compiled = compileBackend(spec, { features, targets });

  if (!compiled.ok) {
    throw new Error(
      `Compilation failed: ${compiled.issues.map((issue) => `${issue.code} ${issue.path}`).join(", ")}`,
    );
  }

  return { compiled: compiled.value, rendered: renderBackend(compiled.value) };
}

function fingerprint(spec: BackendSpec): string {
  const { rendered } = render(spec);

  return sha256(
    rendered.files.map((file) => `${file.path}:${sha256(file.contents)}`).join("\n"),
  );
}

describe("deterministic output", () => {
  it.each(SCENARIOS.map((scenario) => scenario.name))(
    "produces byte-identical output for '%s' across runs",
    (name) => {
      expect(fingerprint(scenarioSpec(name))).toBe(fingerprint(scenarioSpec(name)));
    },
  );

  it("does not depend on the order features are listed in", () => {
    const forward = scenarioSpec("hotel-reservation");
    const reversed = scenarioSpec("hotel-reservation");
    reversed.features = Object.fromEntries(Object.entries(reversed.features).reverse());

    expect(Object.keys(reversed.features)).not.toEqual(Object.keys(forward.features));
    expect(fingerprint(reversed)).toBe(fingerprint(forward));
  });

  it("does not depend on the order entities are listed in", () => {
    const forward = scenarioSpec("hotel-reservation");
    const reversed = scenarioSpec("hotel-reservation");
    reversed.entities = Object.fromEntries(Object.entries(reversed.entities).reverse());

    expect(fingerprint(reversed)).toBe(fingerprint(forward));
  });

  it("contains no timestamp or random value in generated output", () => {
    const { rendered } = render(scenarioSpec("hotel-reservation"));

    const currentYear = String(new Date().getFullYear());
    const offenders = rendered.files.filter(
      (file) =>
        // The generated code may *call* Date.now() at runtime; it must never bake
        // the generation time into its own source.
        file.path !== "README.md" &&
        new RegExp(`Generated on|${currentYear}-\\d{2}-\\d{2}T\\d{2}:`).test(file.contents),
    );

    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it("changes the IR checksum when the specification changes", () => {
    const before = render(scenarioSpec("basic-crud")).compiled.irChecksum;

    const changed = scenarioSpec("basic-crud");
    changed.entities.Note!.fields.extra = "string";

    expect(render(changed).compiled.irChecksum).not.toBe(before);
  });
});
