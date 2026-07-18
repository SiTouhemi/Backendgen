import backendSpecSchema from "../schema/backend-spec.v1.schema.json" with { type: "json" };
import frontendContractSchema from "../schema/frontend-contract.v1.schema.json" with { type: "json" };

/**
 * The two public, versioned machine-readable contracts. Consumers (agents,
 * editors, CI) can read them from here or export them with
 * `backendgen export-schema`.
 */
export const PUBLIC_SCHEMAS = {
  /** Authoritative JSON Schema for `backendcompiler.dev/v1` specifications. */
  spec: backendSpecSchema as Record<string, unknown>,
  /** Authoritative JSON Schema for generated `frontend-contract.json` files. */
  frontend: frontendContractSchema as Record<string, unknown>,
} as const;

export type PublicSchemaName = keyof typeof PUBLIC_SCHEMAS;

export const PUBLIC_SCHEMA_NAMES = Object.keys(PUBLIC_SCHEMAS).sort() as PublicSchemaName[];

export const FRONTEND_CONTRACT_VERSION = "backendcompiler.dev/frontend-contract/v1" as const;
