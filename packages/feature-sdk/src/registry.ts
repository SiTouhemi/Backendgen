import { CompilerError, issue } from "@backend-compiler/common";
import type { FeaturePack } from "./types.js";

/**
 * Feature discovery is explicit: a registry is constructed from the packs the
 * host wants to expose. There is no filesystem scanning or dynamic `require`,
 * which keeps compilation pure and makes the available feature set auditable.
 */
export class FeatureRegistry {
  readonly #packs: Map<string, FeaturePack>;

  constructor(packs: readonly FeaturePack[]) {
    this.#packs = new Map();
    for (const pack of packs) {
      if (this.#packs.has(pack.name)) {
        throw new CompilerError(`Duplicate feature '${pack.name}'`, [
          issue(
            "feature.duplicate",
            `/features/${pack.name}`,
            `Feature '${pack.name}' is registered more than once`,
          ),
        ]);
      }
      this.#packs.set(pack.name, pack);
    }
  }

  list(): FeaturePack[] {
    return [...this.#packs.values()].sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  names(): string[] {
    return this.list().map((pack) => pack.name);
  }

  get(name: string): FeaturePack | undefined {
    return this.#packs.get(name);
  }

  has(name: string): boolean {
    return this.#packs.has(name);
  }

  /** Packs that can render for the given target, in stable order. */
  forTarget(targetId: string): FeaturePack[] {
    return this.list().filter((pack) => pack.supportedTargets.includes(targetId));
  }
}
