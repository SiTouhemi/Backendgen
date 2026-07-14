import type { NormalizedEntity, NormalizedField } from "@backend-compiler/compiler";
import { inputType, names } from "./naming.js";

export interface FieldValidation {
  /** Decorator lines, already indented by the caller. */
  decorators: string[];
  /** Symbols to import from `class-validator`. */
  validatorImports: string[];
  /** Symbols to import from `class-transformer`. */
  transformerImports: string[];
  /** Symbols to import from `@nestjs/swagger`. */
  swaggerImports: string[];
  /** TypeScript property type. */
  type: string;
}

function swaggerOptions(entity: NormalizedEntity, field: NormalizedField): string {
  const parts: string[] = [];

  if (field.enumValues) {
    parts.push(`enum: ${names.enumType(entity.name, field.name)}`);
  }
  if (field.description) {
    parts.push(`description: ${JSON.stringify(field.description)}`);
  }
  if (field.type === "datetime" || field.type === "date") {
    parts.push("format: 'date-time'");
  }
  if (field.constraints.minimum !== null) {
    parts.push(`minimum: ${field.constraints.minimum}`);
  }
  if (field.constraints.maximum !== null) {
    parts.push(`maximum: ${field.constraints.maximum}`);
  }
  if (field.constraints.minLength !== null) {
    parts.push(`minLength: ${field.constraints.minLength}`);
  }
  if (field.constraints.maxLength !== null) {
    parts.push(`maxLength: ${field.constraints.maxLength}`);
  }

  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "";
}

/**
 * Turns an IR field into the class-validator, class-transformer and Swagger
 * decorators for a request DTO property. Validation lives here so that every
 * feature that renders a DTO enforces the same constraints the specification
 * declared.
 */
export function validationDecorators(
  entity: NormalizedEntity,
  field: NormalizedField,
  options: { optional: boolean; coerce?: boolean },
): FieldValidation {
  const decorators: string[] = [];
  const validatorImports = new Set<string>();
  const transformerImports = new Set<string>();
  const swaggerImports = new Set<string>();

  const swaggerDecorator = options.optional ? "ApiPropertyOptional" : "ApiProperty";
  swaggerImports.add(swaggerDecorator);
  const swaggerArgs = swaggerOptions(entity, field);
  decorators.push(`@${swaggerDecorator}(${swaggerArgs})`);

  if (options.optional) {
    decorators.push("@IsOptional()");
    validatorImports.add("IsOptional");
  }

  if (field.enumValues) {
    decorators.push(`@IsEnum(${names.enumType(entity.name, field.name)})`);
    validatorImports.add("IsEnum");
    return {
      decorators,
      validatorImports: [...validatorImports].sort(),
      transformerImports: [...transformerImports].sort(),
      swaggerImports: [...swaggerImports].sort(),
      type: inputType(entity, field),
    };
  }

  switch (field.type) {
    case "uuid":
      decorators.push("@IsUUID()");
      validatorImports.add("IsUUID");
      break;

    case "string":
    case "text":
      decorators.push("@IsString()");
      validatorImports.add("IsString");
      if (field.constraints.minLength !== null) {
        decorators.push(`@MinLength(${field.constraints.minLength})`);
        validatorImports.add("MinLength");
      }
      if (field.constraints.maxLength !== null) {
        decorators.push(`@MaxLength(${field.constraints.maxLength})`);
        validatorImports.add("MaxLength");
      }
      break;

    case "integer":
      if (options.coerce) {
        decorators.push("@Type(() => Number)");
        transformerImports.add("Type");
      }
      decorators.push("@IsInt()");
      validatorImports.add("IsInt");
      break;

    case "decimal":
      if (options.coerce) {
        decorators.push("@Type(() => Number)");
        transformerImports.add("Type");
      }
      decorators.push("@IsNumber()");
      validatorImports.add("IsNumber");
      break;

    case "boolean":
      decorators.push("@IsBoolean()");
      validatorImports.add("IsBoolean");
      break;

    case "datetime":
    case "date":
      decorators.push("@IsISO8601()");
      validatorImports.add("IsISO8601");
      break;
  }

  if (field.type === "integer" || field.type === "decimal") {
    if (field.constraints.minimum !== null) {
      decorators.push(`@Min(${field.constraints.minimum})`);
      validatorImports.add("Min");
    }
    if (field.constraints.maximum !== null) {
      decorators.push(`@Max(${field.constraints.maximum})`);
      validatorImports.add("Max");
    }
  }

  return {
    decorators,
    validatorImports: [...validatorImports].sort(),
    transformerImports: [...transformerImports].sort(),
    swaggerImports: [...swaggerImports].sort(),
    type: inputType(entity, field),
  };
}
