/**
 * Dependency versions for generated projects. Versions are exact, not ranges:
 * two generations of the same specification must install the same dependency
 * tree even months apart, or the "generated output is tested output" claim
 * silently stops being true. Bumps happen here, in the compiler, where CI
 * re-runs every scenario against the new resolutions.
 */
export const BASE_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@nestjs/common": "11.1.28",
  "@nestjs/config": "4.0.4",
  "@nestjs/core": "11.1.28",
  "@nestjs/event-emitter": "3.1.0",
  "@nestjs/platform-express": "11.1.28",
  "@nestjs/swagger": "11.4.5",
  "@prisma/client": "6.19.3",
  "class-transformer": "0.5.1",
  "class-validator": "0.14.4",
  helmet: "8.3.0",
  "reflect-metadata": "0.2.2",
  rxjs: "7.8.2",
};

export const BASE_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@nestjs/cli": "11.0.24",
  "@nestjs/schematics": "11.1.0",
  "@nestjs/testing": "11.1.28",
  "@types/express": "5.0.6",
  "@types/jest": "29.5.14",
  "@types/node": "22.20.1",
  "@types/supertest": "6.0.3",
  jest: "29.7.0",
  prisma: "6.19.3",
  supertest: "7.2.2",
  "ts-jest": "29.4.11",
  "ts-node": "10.9.2",
  "tsconfig-paths": "4.2.0",
  typescript: "5.9.3",
};

export const BASE_SCRIPTS: Readonly<Record<string, string>> = {
  build: "nest build",
  start: "nest start",
  "start:dev": "nest start --watch",
  "start:prod": "node dist/main",
  "db:generate": "prisma generate",
  "db:deploy": "prisma migrate deploy",
  "db:push": "prisma db push",
  "db:validate": "prisma validate",
  test: "jest --config jest.config.json",
  "test:integration": "jest --config jest-integration.config.json --runInBand",
};
