import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SHARDS = 8;
const SEEDS_PER_SHARD = 250;
const vitest = resolve("node_modules", "vitest", "vitest.mjs");

for (let shard = 0; shard < SHARDS; shard += 1) {
  const startSeed = shard * SEEDS_PER_SHARD + 1;
  const endSeed = startSeed + SEEDS_PER_SHARD - 1;
  process.stdout.write(
    `\nSecurity contract shard ${shard + 1}/${SHARDS}: seeds ${startSeed}-${endSeed}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [vitest, "run", "tests/fuzz-invariants.test.ts", "--reporter=dot"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BACKENDGEN_FUZZ_SAMPLES: String(SEEDS_PER_SHARD),
        BACKENDGEN_FUZZ_START_SEED: String(startSeed),
        BACKENDGEN_FUZZ_SEED: "",
      },
      stdio: "inherit",
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(
  `\nGenerated security contract passed ${SHARDS * SEEDS_PER_SHARD} deterministic specs across ${SHARDS} shards.\n`,
);
