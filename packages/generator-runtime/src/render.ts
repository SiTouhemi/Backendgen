import { createRenderContext, mergeRenderResults, type RenderResult } from "@backend-compiler/target-sdk";
import type { CompiledBackend } from "./compile.js";

/**
 * Runs the target's project and entity renderers, then every selected feature's
 * renderer, then the target's composition pass. Feature order is the resolved
 * dependency order, so output does not depend on how the specification happened
 * to list its features.
 */
export function renderBackend(compiled: CompiledBackend): RenderResult {
  const { ir, target, features, settings } = compiled;

  const baseContext = createRenderContext({ ir, targetId: target.id, settings });

  const results: RenderResult[] = [
    target.renderProject(baseContext),
    target.renderEntities(baseContext),
  ];

  for (const feature of features) {
    const renderer = feature.pack.renderers[target.id];

    if (renderer === undefined) {
      continue;
    }

    results.push(
      renderer.render(
        createRenderContext({
          ir,
          targetId: target.id,
          settings,
          config: feature.config,
        }),
      ),
    );
  }

  const contributions = mergeRenderResults(results);
  const composed = target.compose(baseContext, contributions);

  return mergeRenderResults([contributions, composed]);
}
