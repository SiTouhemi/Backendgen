/**
 * Single source of truth for the generator identity written into
 * `.backendgen/manifest.json`. Bumping this value invalidates previously
 * generated output for regeneration-compatibility purposes, so it must only
 * change when generated code changes shape.
 */
export const GENERATOR_NAME = "backendgen" as const;
export const GENERATOR_VERSION = "0.2.2" as const;
