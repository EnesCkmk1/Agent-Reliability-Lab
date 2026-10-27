import { deepEqual, isPlainObject } from "../util.ts";
import type { JsonSchema } from "../types.ts";

export function typeMatches(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

export function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${path} is not an allowed value`);
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path} must be ${schema.type}`);
    return errors;
  }
  if (schema.type === "string" && typeof value === "string" && schema.minLength != null) {
    if (value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    }
  }
  if (schema.type === "object" && isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) errors.push(...validateJsonSchema(value[key], child, `${path}.${key}`));
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(item, schema.items as JsonSchema, `${path}[${index}]`));
    });
  }
  return errors;
}
