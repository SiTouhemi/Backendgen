import type { Issue } from "@backend-compiler/common";
import type { BackendIR, Database, NormalizedEntity } from "@backend-compiler/compiler";
import type { TargetMigrationSupport } from "./migrations.js";

/**
 * `generated` files are owned by the compiler and are replaced on every run.
 * `custom-scaffold` files are written once and then belong to the user; the
 * generator never overwrites them. This is the whole of the ownership model —
 * there are deliberately no inline "custom code" markers.
 */
export type FileOwnership = "generated" | "custom-scaffold";

export interface RenderedFile {
  /** POSIX-style path relative to the generated project root. */
  path: string;
  contents: string;
  ownership: FileOwnership;
  /** Marks files that must keep their executable bit on POSIX systems. */
  executable?: boolean;
}

/** A framework module (or equivalent composition unit) the app root must wire up. */
export interface RootModuleImport {
  /** Symbol to import, e.g. `AuthModule`. */
  symbol: string;
  /** Module specifier relative to the app root file, e.g. `./generated/auth/auth.module`. */
  from: string;
  /** Whether the symbol is registered as a module import (vs. a provider). */
  kind: "module" | "provider" | "global-filter" | "global-guard";
  /** Ordering hint; lower sorts first. Ties break on `symbol`. */
  order: number;
}

export interface RenderResult {
  files: RenderedFile[];
  rootModules: RootModuleImport[];
  /** Runtime dependencies to merge into the generated manifest, name to pinned version. */
  packageDependencies: Record<string, string>;
  /** Development dependencies to merge into the generated manifest. */
  packageDevDependencies: Record<string, string>;
  /** Scripts to merge into the generated manifest. */
  scripts: Record<string, string>;
  /** Extra DDL appended, in order, to the initial migration. */
  migrationSql: string[];
  /** Environment variables written into `.env.example`, in declaration order. */
  envExample: Array<{ name: string; value: string; comment: string }>;
  /**
   * Defaults applied to the environment before a test run reads its
   * configuration, so that a test suite never needs a real credential and can
   * never reach a real third-party service. An explicitly exported variable
   * still wins.
   */
  testEnv: Record<string, string>;
}

export interface ProjectSettings {
  apiPrefix: string;
  port: number;
  /** Whether the target should emit its typed API client. */
  client: boolean;
}

/**
 * Everything a renderer is allowed to see. Renderers are pure functions of this
 * context, which is what makes generation deterministic.
 */
export interface TargetRenderContext {
  ir: BackendIR;
  targetId: string;
  database: Database;
  settings: ProjectSettings;
  /** Configuration of the feature currently being rendered. */
  config: Record<string, unknown>;
  hasFeature(name: string): boolean;
  featureConfig(name: string): Record<string, unknown> | undefined;
  entity(name: string): NormalizedEntity;
  /** Entities the CRUD surface is exposed for, in stable order. */
  crudEntities(): NormalizedEntity[];
}

export interface FeatureTargetRenderer {
  render(context: TargetRenderContext): RenderResult;
}

export interface TargetCommands {
  install: string;
  build: string;
  test: string;
  testIntegration: string;
  format: string;
  migrate: string;
}

export interface TargetAdapter {
  id: string;
  version: string;
  description: string;
  supportedDatabases: readonly Database[];
  /** Feature capability identifiers this target can render, e.g. `reservations`. */
  capabilities: readonly string[];
  commands: TargetCommands;
  /** Target-specific validation, run against the fully compiled IR. */
  validate(ir: BackendIR): Issue[];
  /** Project skeleton: manifests, bootstrap, error handling, health, Docker, docs. */
  renderProject(context: TargetRenderContext): RenderResult;
  /** Data model: schema and migrations for every entity in the IR. */
  renderEntities(context: TargetRenderContext): RenderResult;
  /**
   * Incremental-migration capability. When present, the generator runtime keeps
   * a schema snapshot and emits an incremental migration for a changed spec
   * instead of rewriting the initial migration. Absent means the target only
   * supports the rewrite-in-place workflow.
   */
  migrations?: TargetMigrationSupport;
  /**
   * Final composition pass. Receives every contribution collected so far and
   * emits the files that depend on them (application root module, package
   * manifest, environment example, initial migration).
   */
  compose(context: TargetRenderContext, contributions: RenderResult): RenderResult;
}
