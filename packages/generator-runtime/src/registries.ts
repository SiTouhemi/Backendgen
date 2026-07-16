import { FeatureRegistry } from "@backend-compiler/feature-sdk";
import { authFeature } from "@backend-compiler/feature-auth";
import { crudFeature } from "@backend-compiler/feature-crud";
import { jobsFeature } from "@backend-compiler/feature-jobs";
import { notificationsFeature } from "@backend-compiler/feature-notifications";
import { organizationsFeature } from "@backend-compiler/feature-organizations";
import { reservationsFeature } from "@backend-compiler/feature-reservations";
import { nestjsPrismaTarget } from "@backend-compiler/target-nestjs-prisma";
import type { TargetAdapter } from "@backend-compiler/target-sdk";

/**
 * Feature and target discovery. Both registries are constructed from an explicit
 * list rather than by scanning the filesystem, so what a build can generate is
 * always visible in source.
 */
export function createDefaultRegistry(): FeatureRegistry {
  return new FeatureRegistry([
    authFeature,
    crudFeature,
    jobsFeature,
    notificationsFeature,
    organizationsFeature,
    reservationsFeature,
  ]);
}

export class TargetRegistry {
  readonly #targets: Map<string, TargetAdapter>;

  constructor(targets: readonly TargetAdapter[]) {
    this.#targets = new Map(targets.map((target) => [target.id, target]));
  }

  list(): TargetAdapter[] {
    return [...this.#targets.values()].sort((left, right) => (left.id < right.id ? -1 : 1));
  }

  ids(): string[] {
    return this.list().map((target) => target.id);
  }

  get(id: string): TargetAdapter | undefined {
    return this.#targets.get(id);
  }
}

export function createDefaultTargets(): TargetRegistry {
  return new TargetRegistry([nestjsPrismaTarget]);
}
