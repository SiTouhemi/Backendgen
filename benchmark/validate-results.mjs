import Ajv2020 from "ajv/dist/2020.js";
import { readdir, readFile } from "node:fs/promises";

const directory = new URL("./runs/", import.meta.url);
const schema = JSON.parse(await readFile(new URL("./result.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
let files = [];
try { files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort(); } catch {}
if (files.length === 0) {
  console.log("No benchmark runs found. The committed template is intentionally not treated as data.");
  process.exit(0);
}
for (const file of files) {
  const value = JSON.parse(await readFile(new URL(file, directory), "utf8"));
  if (!validate(value)) {
    console.error(`${file}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
    process.exitCode = 1;
  } else console.log(`${file}: valid`);
}
