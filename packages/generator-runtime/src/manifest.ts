import { GENERATOR_NAME, GENERATOR_VERSION, sha256 } from "@backend-compiler/common";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileOwnership } from "@backend-compiler/target-sdk";

export const MANIFEST_DIRECTORY = ".backendgen";
export const MANIFEST_PATH = `${MANIFEST_DIRECTORY}/manifest.json`;
export const MANIFEST_VERSION = 1;

export interface ManifestFile {
  path: string;
  /** SHA-256 of the contents the generator last wrote. */
  hash: string;
  ownership: FileOwnership;
}

export interface GenerationManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  generator: { name: string; version: string };
  target: { id: string; version: string };
  features: Array<{ name: string; version: string }>;
  specChecksum: string;
  irChecksum: string;
  files: ManifestFile[];
}

export function hashContents(contents: string): string {
  return `sha256:${sha256(contents)}`;
}

export function createManifest(input: {
  target: { id: string; version: string };
  features: Array<{ name: string; version: string }>;
  specChecksum: string;
  irChecksum: string;
  files: ManifestFile[];
}): GenerationManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    target: input.target,
    features: [...input.features].sort((left, right) => (left.name < right.name ? -1 : 1)),
    specChecksum: input.specChecksum,
    irChecksum: input.irChecksum,
    files: [...input.files].sort((left, right) => (left.path < right.path ? -1 : 1)),
  };
}

/** Serialised with sorted keys and no timestamp, so identical input yields an identical file. */
export function serializeManifest(manifest: GenerationManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersionedName(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

function isManifest(value: unknown): value is GenerationManifest {
  if (!isRecord(value) || value.manifestVersion !== MANIFEST_VERSION) return false;
  if (!isVersionedName(value.generator)) return false;
  if (
    !isRecord(value.target) ||
    typeof value.target.id !== "string" ||
    typeof value.target.version !== "string"
  ) {
    return false;
  }
  if (
    typeof value.specChecksum !== "string" ||
    typeof value.irChecksum !== "string" ||
    !Array.isArray(value.features) ||
    !value.features.every(isVersionedName) ||
    !Array.isArray(value.files) ||
    value.files.length > 10_000
  ) {
    return false;
  }

  const paths = new Set<string>();
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.length > 1_024 ||
      typeof entry.hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.hash) ||
      (entry.ownership !== "generated" && entry.ownership !== "custom-scaffold") ||
      paths.has(entry.path)
    ) {
      return false;
    }
    paths.add(entry.path);
  }

  return true;
}

export async function readManifest(outputDirectory: string): Promise<GenerationManifest | null> {
  try {
    const source = await readFile(join(outputDirectory, MANIFEST_PATH), "utf8");
    const parsed: unknown = JSON.parse(source);
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
