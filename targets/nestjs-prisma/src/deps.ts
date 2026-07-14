/**
 * Dependency ranges for generated projects. Generated output stays byte-stable
 * because these strings are fixed; the generated project's own lock file pins
 * the exact resolutions.
 */
export const BASE_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@nestjs/common": "^11.0.0",
  "@nestjs/config": "^4.0.0",
  "@nestjs/core": "^11.0.0",
  "@nestjs/event-emitter": "^3.0.0",
  "@nestjs/platform-express": "^11.0.0",
  "@nestjs/swagger": "^11.0.0",
  "@prisma/client": "^6.5.0",
  "class-transformer": "^0.5.1",
  "class-validator": "^0.14.1",
  "reflect-metadata": "^0.2.2",
  rxjs: "^7.8.1",
};

export const BASE_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@nestjs/cli": "^11.0.0",
  "@nestjs/schematics": "^11.0.0",
  "@nestjs/testing": "^11.0.0",
  "@types/express": "^5.0.0",
  "@types/jest": "^29.5.14",
  "@types/node": "^22.13.0",
  "@types/supertest": "^6.0.2",
  jest: "^29.7.0",
  prisma: "^6.5.0",
  supertest: "^7.0.0",
  "ts-jest": "^29.2.5",
  "ts-node": "^10.9.2",
  "tsconfig-paths": "^4.2.0",
  typescript: "^5.7.0",
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
