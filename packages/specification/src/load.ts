import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";

export async function loadSpecFile(filePath: string): Promise<unknown> {
  const source = await readFile(filePath, "utf8");
  const extension = extname(filePath).toLowerCase();

  if (extension === ".json") {
    return JSON.parse(source) as unknown;
  }

  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(source) as unknown;
  }

  throw new Error(`Unsupported specification file extension: ${extension || "none"}`);
}
