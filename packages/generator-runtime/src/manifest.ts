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

export async function readManifest(outputDirectory: string): Promise<GenerationManifest | null> {
  try {
    const source = await readFile(join(outputDirectory, MANIFEST_PATH), "utf8");
    const parsed = JSON.parse(source) as GenerationManifest;

    if (parsed.manifestVersion !== MANIFEST_VERSION) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
