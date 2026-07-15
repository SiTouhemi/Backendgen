import type { BackendIR } from "@backend-compiler/compiler";
import { describe, expect, it } from "vitest";
import { createRenderContext, emptyRenderResult, mergeRenderResults } from "./context.js";

describe("target render composition", () => {
  it("sorts files and root modules deterministically and deduplicates environment entries", () => {
    const first = emptyRenderResult();
    first.files = [{ path: "z.ts", contents: "z", ownership: "generated" }];
    first.rootModules = [{ symbol: "Z", from: "./z", kind: "module", order: 20 }];
    first.envExample = [{ name: "TOKEN", value: "x", comment: "token" }];
    const second = emptyRenderResult();
    second.files = [{ path: "a.ts", contents: "a", ownership: "generated" }];
    second.rootModules = [{ symbol: "A", from: "./a", kind: "module", order: 10 }];
    second.envExample = [{ name: "TOKEN", value: "x", comment: "token" }];
    const result = mergeRenderResults([first, second]);
    expect(result.files.map((file) => file.path)).toEqual(["a.ts", "z.ts"]);
    expect(result.rootModules.map((item) => item.symbol)).toEqual(["A", "Z"]);
    expect(result.envExample).toHaveLength(1);
  });

  it("rejects duplicate paths with different contents", () => {
    const a = emptyRenderResult();
    const b = emptyRenderResult();
    a.files = [{ path: "same.ts", contents: "a", ownership: "generated" }];
    b.files = [{ path: "same.ts", contents: "b", ownership: "generated" }];
    expect(() => mergeRenderResults([a, b])).toThrowError(/Conflicting output/);
  });

  it("rejects conflicting dependency versions", () => {
    const a = emptyRenderResult();
    const b = emptyRenderResult();
    a.packageDependencies.lib = "1.0.0";
    b.packageDependencies.lib = "2.0.0";
    expect(() => mergeRenderResults([a, b])).toThrowError(/Conflicting dependency/);
  });

  it("fails with a stable issue when a renderer requests an unknown entity", () => {
    const ir = {
      target: { database: "postgresql" }, entities: [], features: [],
    } as unknown as BackendIR;
    const context = createRenderContext({ ir, targetId: "test", settings: { apiPrefix: "api", port: 3000, client: true } });
    expect(() => context.entity("Missing")).toThrowError(/Unknown entity/);
  });
});
