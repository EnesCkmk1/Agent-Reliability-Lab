import { FORBIDDEN_KEYS, isPlainObject } from "../util.ts";
import {
  DIFFICULTIES,
  FAULT_KINDS,
  SCRIPTED_BEHAVIORS,
  TASK_CATEGORIES,
  VALIDATION_METHODS,
  type Criterion,
  type Dataset,
  type FaultSpec,
  type JsonSchema,
  type RegressionThresholds,
  type ScriptedProfile,
  type TaskCase,
} from "../types.ts";
import { DATASET_FORMAT, MAX_IMPORTED_CASES } from "../version.ts";

export interface SchemaIssue {
  path: string;
  message: string;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;

export function validateDataset(data: unknown): { ok: true; dataset: Dataset } | { ok: false; errors: SchemaIssue[] } {
  const errors: SchemaIssue[] = [];
  if (!isPlainObject(data)) {
    return { ok: false, errors: [{ path: "$", message: "Dataset must be a JSON object." }] };
  }
  rejectForbidden(data, "$", errors);
  requireEqual(data, "formatVersion", DATASET_FORMAT, "$", errors);
  requireString(data, "version", "$", errors);
  if (data.origin !== "synthetic" && data.origin !== "external" && data.origin !== "mixed") {
    errors.push({ path: "$.origin", message: "origin must be synthetic, external, or mixed." });
  }
  if (typeof data.synthetic !== "boolean") {
    errors.push({ path: "$.synthetic", message: "synthetic must be a boolean." });
  }
  requireString(data, "label", "$", errors);
  if (typeof data.label === "string" && data.synthetic === true && !/synthetic/i.test(data.label)) {
    errors.push({ path: "$.label", message: "Synthetic datasets must say that they are synthetic." });
  }
  if (data.seed !== null && !isUintSeed(data.seed)) {
    errors.push({ path: "$.seed", message: "seed must be a non-negative integer below 2^31 or null." });
  }
  if (!Number.isInteger(data.count) || (data.count as number) < 0) {
    errors.push({ path: "$.count", message: "count must be a non-negative integer." });
  }
  if (data.generator !== null && !isGenerator(data.generator)) {
    errors.push({ path: "$.generator", message: "generator must be null or {name, version}." });
  }
  requireString(data, "notes", "$", errors);
  if (!Array.isArray(data.cases)) {
    errors.push({ path: "$.cases", message: "cases must be an array." });
  } else {
    if (data.cases.length > MAX_IMPORTED_CASES) {
      errors.push({ path: "$.cases", message: `A dataset can contain at most ${MAX_IMPORTED_CASES} cases.` });
    }
    if (data.count !== data.cases.length) {
      errors.push({ path: "$.count", message: "count must equal cases.length." });
    }
    const ids = new Set<string>();
    data.cases.forEach((item, index) => {
      const path = `$.cases[${index}]`;
      const taskErrors = validateTask(item, path);
      errors.push(...taskErrors);
      if (isPlainObject(item) && typeof item.id === "string") {
        if (ids.has(item.id)) errors.push({ path: `${path}.id`, message: "Duplicate task id." });
        ids.add(item.id);
      }
    });
    if (data.synthetic === true && Array.isArray(data.cases)) {
      const allSynthetic = data.cases.every((item) => isPlainObject(item) && item.synthetic === true && item.origin === "synthetic");
      if (!allSynthetic) {
        errors.push({ path: "$.synthetic", message: "A synthetic dataset can contain only synthetic cases." });
      }
    }
    if (data.origin === "synthetic" && data.synthetic !== true) {
      errors.push({ path: "$.origin", message: "origin synthetic requires synthetic true." });
    }
    if (data.origin === "external" && data.synthetic !== false) {
      errors.push({ path: "$.origin", message: "origin external requires synthetic false." });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, dataset: data as unknown as Dataset };
}

export function validateTask(data: unknown, path: string): SchemaIssue[] {
  const errors: SchemaIssue[] = [];
  if (!isPlainObject(data)) {
    return [{ path, message: "Task must be an object." }];
  }
  rejectForbidden(data, path, errors);
  if (typeof data.id !== "string" || !ID_PATTERN.test(data.id)) {
    errors.push({ path: `${path}.id`, message: "id must match [A-Za-z0-9._:-] and be at most 120 characters." });
  }
  requireString(data, "datasetVersion", path, errors);
  if (data.origin !== "synthetic" && data.origin !== "external") {
    errors.push({ path: `${path}.origin`, message: "origin must be synthetic or external." });
  }
  if (typeof data.synthetic !== "boolean") {
    errors.push({ path: `${path}.synthetic`, message: "synthetic must be a boolean." });
  }
  if (data.origin === "synthetic" && data.synthetic !== true) {
    errors.push({ path: `${path}.synthetic`, message: "Synthetic cases must set synthetic true." });
  }
  if (data.origin === "external" && data.synthetic !== false) {
    errors.push({ path: `${path}.synthetic`, message: "External cases must set synthetic false." });
  }
  if (!TASK_CATEGORIES.includes(data.category as TaskCase["category"])) {
    errors.push({ path: `${path}.category`, message: "Unknown category." });
  }
  if (!DIFFICULTIES.includes(data.difficulty as TaskCase["difficulty"])) {
    errors.push({ path: `${path}.difficulty`, message: "difficulty must be easy, medium, or hard." });
  }
  requireBoundedString(data, "title", path, 300, errors);
  requireBoundedString(data, "prompt", path, 200_000, errors);
  requireObject(data, "input", path, errors);
  requireObject(data, "visibleContext", path, errors);
  requireObject(data, "hiddenContext", path, errors);
  if (!VALIDATION_METHODS.includes(data.validationMethod as TaskCase["validationMethod"])) {
    errors.push({ path: `${path}.validationMethod`, message: "Unknown validation method." });
  }
  if (!Array.isArray(data.criteria) || data.criteria.length === 0) {
    errors.push({ path: `${path}.criteria`, message: "At least one success criterion is required." });
  } else {
    data.criteria.forEach((criterion, index) => validateCriterion(criterion, `${path}.criteria[${index}]`, errors));
  }
  if (data.scenarioType !== "baseline" && data.scenarioType !== "edge" && data.scenarioType !== "fault") {
    errors.push({ path: `${path}.scenarioType`, message: "scenarioType must be baseline, edge, or fault." });
  }
  if (!Array.isArray(data.faults)) {
    errors.push({ path: `${path}.faults`, message: "faults must be an array." });
  } else {
    data.faults.forEach((fault, index) => validateFault(fault, `${path}.faults[${index}]`, errors));
  }
  if (!Array.isArray(data.expectedToolCalls)) {
    errors.push({ path: `${path}.expectedToolCalls`, message: "expectedToolCalls must be an array." });
  } else {
    data.expectedToolCalls.forEach((call, index) => {
      const callPath = `${path}.expectedToolCalls[${index}]`;
      if (!isPlainObject(call) || typeof call.tool !== "string" || !TOOL_PATTERN.test(call.tool)) {
        errors.push({ path: callPath, message: "tool name is invalid." });
      }
      if (!isPlainObject(call) || !isPlainObject(call.arguments)) {
        errors.push({ path: `${callPath}.arguments`, message: "arguments must be an object." });
      }
      if (!isPlainObject(call) || typeof call.required !== "boolean") {
        errors.push({ path: `${callPath}.required`, message: "required must be a boolean." });
      }
    });
  }
  if (data.expectedRecovery !== null) {
    validateRecovery(data.expectedRecovery, `${path}.expectedRecovery`, errors);
  }
  if (!isUintSeed(data.seed)) errors.push({ path: `${path}.seed`, message: "seed must be a non-negative integer below 2^31." });
  if (!isUint32(data.caseSeed)) errors.push({ path: `${path}.caseSeed`, message: "caseSeed must be an integer from 0 through 2^32-1." });
  if (!isPlainObject(data.generation)) {
    errors.push({ path: `${path}.generation`, message: "generation metadata is required." });
  } else {
    rejectForbidden(data.generation, `${path}.generation`, errors);
    for (const key of ["generator", "version", "datasetVersion", "label", "notes"]) {
      if (typeof data.generation[key] !== "string" || data.generation[key] === "") {
        errors.push({ path: `${path}.generation.${key}`, message: "Required string." });
      }
    }
    if (typeof data.generation.synthetic !== "boolean") {
      errors.push({ path: `${path}.generation.synthetic`, message: "synthetic must be a boolean." });
    }
    if (data.synthetic === true && typeof data.generation.label === "string" && !/synthetic/i.test(data.generation.label)) {
      errors.push({ path: `${path}.generation.label`, message: "Synthetic generation metadata must say synthetic." });
    }
    if (!isUintSeed(data.generation.datasetSeed) || !isUint32(data.generation.caseSeed)) {
      errors.push({ path: `${path}.generation`, message: "generation seeds must be unsigned integers in range." });
    }
  }
  if (Array.isArray(data.criteria) && typeof data.validationMethod === "string") {
    const types = new Set(
      data.criteria.filter(isPlainObject).map((criterion) => criterion.type),
    );
    const method = data.validationMethod;
    const needed =
      method === "exact_match"
        ? "exact_match"
        : method === "json_schema"
          ? "json_schema"
          : method === "numeric"
            ? "numeric"
            : method === "tool_trace"
              ? "tool_sequence"
              : method === "refusal"
                ? "refusal"
                : method === "field_match"
                  ? "field_match"
                  : method === "recovery"
                    ? "recovery"
                    : method === "retrieval"
                      ? "retrieval"
                      : null;
    if (needed && !types.has(needed)) {
      errors.push({
        path: `${path}.validationMethod`,
        message: `validation method ${method} requires a ${needed} criterion.`,
      });
    }
  }
  return errors;
}

function validateCriterion(data: unknown, path: string, errors: SchemaIssue[]): void {
  if (!isPlainObject(data) || typeof data.type !== "string") {
    errors.push({ path, message: "Criterion must be an object with a type." });
    return;
  }
  rejectForbidden(data, path, errors);
  switch (data.type) {
    case "exact_match":
      if (!("expected" in data)) errors.push({ path, message: "exact_match requires expected." });
      break;
    case "json_schema":
      if (!isPlainObject(data.schema)) errors.push({ path, message: "json_schema requires a schema object." });
      else validateSchemaNode(data.schema, `${path}.schema`, errors);
      break;
    case "field_match":
      if (!isPlainObject(data.fields) || Object.keys(data.fields).length === 0) {
        errors.push({ path, message: "field_match requires a non-empty fields object." });
      }
      break;
    case "numeric":
      if (typeof data.path !== "string" || typeof data.value !== "number" || typeof data.tolerance !== "number") {
        errors.push({ path, message: "numeric requires path, value, and tolerance." });
      }
      break;
    case "tool_sequence":
      if (!Array.isArray(data.tools) || data.tools.some((tool) => typeof tool !== "string")) {
        errors.push({ path, message: "tool_sequence requires a string array." });
      }
      break;
    case "refusal":
      if (typeof data.mustRefuse !== "boolean" || !Array.isArray(data.prohibitedTools)) {
        errors.push({ path, message: "refusal requires mustRefuse and prohibitedTools." });
      }
      break;
    case "recovery":
      validateRecovery(data, path, errors);
      break;
    case "retrieval":
      if (typeof data.path !== "string" || typeof data.value !== "string") {
        errors.push({ path, message: "retrieval requires path and value." });
      }
      break;
    case "max_tool_calls":
      if (!Number.isInteger(data.max) || (data.max as number) < 0) {
        errors.push({ path, message: "max_tool_calls requires a non-negative integer max." });
      }
      break;
    default:
      errors.push({ path, message: `Unknown criterion type ${String(data.type)}.` });
  }
}

function validateSchemaNode(data: unknown, path: string, errors: SchemaIssue[]): void {
  if (!isPlainObject(data)) {
    errors.push({ path, message: "Schema must be an object." });
    return;
  }
  const schema = data as JsonSchema;
  if (schema.type && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) {
    errors.push({ path: `${path}.type`, message: "Unsupported JSON Schema type." });
  }
  if (schema.properties) {
    if (!isPlainObject(schema.properties)) errors.push({ path: `${path}.properties`, message: "properties must be an object." });
    else {
      for (const [key, child] of Object.entries(schema.properties)) {
        validateSchemaNode(child, `${path}.properties.${key}`, errors);
      }
    }
  }
  if (schema.items) validateSchemaNode(schema.items, `${path}.items`, errors);
}

function validateFault(data: unknown, path: string, errors: SchemaIssue[]): void {
  if (!isPlainObject(data)) {
    errors.push({ path, message: "Fault must be an object." });
    return;
  }
  if (typeof data.id !== "string" || !ID_PATTERN.test(data.id)) {
    errors.push({ path: `${path}.id`, message: "Fault id is invalid." });
  }
  if (typeof data.target !== "string" || data.target.length === 0 || data.target.length > 80) {
    errors.push({ path: `${path}.target`, message: "Fault target is invalid." });
  }
  if (!FAULT_KINDS.includes(data.kind as FaultSpec["kind"])) {
    errors.push({ path: `${path}.kind`, message: "Unknown fault kind." });
  }
  if (!isPlainObject(data.params)) {
    errors.push({ path: `${path}.params`, message: "params must be an object." });
    return;
  }
  rejectForbidden(data.params, `${path}.params`, errors);
  if (data.kind === "delay" && (!Number.isFinite(data.params.delayMs) || (data.params.delayMs as number) < 0)) {
    errors.push({ path: `${path}.params.delayMs`, message: "delay requires delayMs >= 0." });
  }
  if (data.kind === "incomplete_input" && typeof data.params.field !== "string") {
    errors.push({ path: `${path}.params.field`, message: "incomplete_input requires params.field." });
  }
  if (data.kind === "contradictory" && typeof data.params.message !== "string") {
    errors.push({ path: `${path}.params.message`, message: "contradictory requires params.message." });
  }
  if (data.kind === "retry_limit" && (!Number.isInteger(data.params.maxRetries) || (data.params.maxRetries as number) < 0)) {
    errors.push({ path: `${path}.params.maxRetries`, message: "retry_limit requires integer params.maxRetries >= 0." });
  }
}

function validateRecovery(data: unknown, path: string, errors: SchemaIssue[]): void {
  if (!isPlainObject(data)) {
    errors.push({ path, message: "Recovery must be an object." });
    return;
  }
  if (typeof data.mustRecover !== "boolean") errors.push({ path: `${path}.mustRecover`, message: "mustRecover must be a boolean." });
  if (!Number.isInteger(data.maxAttempts) || (data.maxAttempts as number) < 1) {
    errors.push({ path: `${path}.maxAttempts`, message: "maxAttempts must be an integer >= 1." });
  }
  if (typeof data.tool !== "string" || !TOOL_PATTERN.test(data.tool)) {
    errors.push({ path: `${path}.tool`, message: "recovery tool name is invalid." });
  }
}

export function validateProfile(data: unknown): { ok: true; profile: ScriptedProfile } | { ok: false; errors: SchemaIssue[] } {
  const errors: SchemaIssue[] = [];
  if (!isPlainObject(data)) return { ok: false, errors: [{ path: "$", message: "Profile must be an object." }] };
  if (typeof data.name !== "string" || data.name.length === 0) errors.push({ path: "$.name", message: "name is required." });
  if (!SCRIPTED_BEHAVIORS.includes(data.defaultBehavior as ScriptedProfile["defaultBehavior"])) {
    errors.push({ path: "$.defaultBehavior", message: "Unknown default behavior." });
  }
  if (data.byCategory != null) {
    if (!isPlainObject(data.byCategory)) errors.push({ path: "$.byCategory", message: "byCategory must be an object." });
    else {
      for (const [key, value] of Object.entries(data.byCategory)) {
        if (!TASK_CATEGORIES.includes(key as TaskCase["category"])) {
          errors.push({ path: `$.byCategory.${key}`, message: "Unknown category." });
        }
        if (!SCRIPTED_BEHAVIORS.includes(value as ScriptedProfile["defaultBehavior"])) {
          errors.push({ path: `$.byCategory.${key}`, message: "Unknown behavior." });
        }
      }
    }
  }
  if (data.byTaskId != null) {
    if (!isPlainObject(data.byTaskId)) errors.push({ path: "$.byTaskId", message: "byTaskId must be an object." });
    else {
      for (const [key, value] of Object.entries(data.byTaskId)) {
        if (!SCRIPTED_BEHAVIORS.includes(value as ScriptedProfile["defaultBehavior"])) {
          errors.push({ path: `$.byTaskId.${key}`, message: "Unknown behavior." });
        }
      }
    }
  }
  if (data.latencyMs != null && (!Number.isFinite(data.latencyMs) || (data.latencyMs as number) < 0 || (data.latencyMs as number) > 60_000)) {
    errors.push({ path: "$.latencyMs", message: "latencyMs must be between 0 and 60000." });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, profile: data as unknown as ScriptedProfile };
}

export function validateThresholds(data: unknown): { ok: true; thresholds: RegressionThresholds } | { ok: false; errors: SchemaIssue[] } {
  const errors: SchemaIssue[] = [];
  if (!isPlainObject(data)) return { ok: false, errors: [{ path: "$", message: "Thresholds must be an object." }] };
  if (!Number.isInteger(data.minSampleSize) || (data.minSampleSize as number) < 1) {
    errors.push({ path: "$.minSampleSize", message: "minSampleSize must be an integer >= 1." });
  }
  for (const key of [
    "successRateDrop",
    "recoveryRateDrop",
    "exactMatchDrop",
    "schemaComplianceDrop",
    "toolCallSuccessDrop",
    "timeoutRateIncrease",
    "p95LatencyIncreaseRatio",
    "medianLatencyIncreaseRatio",
    "costIncreaseRatio",
  ]) {
    const value = data[key];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      errors.push({ path: `$.${key}`, message: "Must be null or a finite number >= 0." });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, thresholds: data as unknown as RegressionThresholds };
}

function rejectForbidden(value: unknown, path: string, errors: SchemaIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbidden(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push({ path: `${path}.${key}`, message: "Forbidden key." });
    } else {
      rejectForbidden(value[key], `${path}.${key}`, errors);
    }
  }
}

function requireEqual(obj: Record<string, unknown>, key: string, expected: string, path: string, errors: SchemaIssue[]): void {
  if (obj[key] !== expected) errors.push({ path: `${path}.${key}`, message: `Must be ${expected}.` });
}

function requireString(obj: Record<string, unknown>, key: string, path: string, errors: SchemaIssue[]): void {
  if (typeof obj[key] !== "string" || obj[key] === "") {
    errors.push({ path: `${path}.${key}`, message: "Required non-empty string." });
  }
}

function requireBoundedString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
  errors: SchemaIssue[],
): void {
  if (typeof obj[key] !== "string" || obj[key] === "" || (obj[key] as string).length > max) {
    errors.push({ path: `${path}.${key}`, message: `Required string up to ${max} characters.` });
  }
}

function requireObject(obj: Record<string, unknown>, key: string, path: string, errors: SchemaIssue[]): void {
  if (!isPlainObject(obj[key])) errors.push({ path: `${path}.${key}`, message: "Must be an object." });
  else rejectForbidden(obj[key], `${path}.${key}`, errors);
}

function isUintSeed(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 2 ** 31;
}

function isUint32(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isGenerator(value: unknown): boolean {
  return isPlainObject(value) && typeof value.name === "string" && typeof value.version === "string";
}

export function validateFaultList(data: unknown): { ok: true; faults: FaultSpec[] } | { ok: false; errors: SchemaIssue[] } {
  const faults = Array.isArray(data) ? data : isPlainObject(data) && Array.isArray(data.faults) ? data.faults : null;
  if (!faults) return { ok: false, errors: [{ path: "$", message: "Fault file must be an array or { faults: [] }." }] };
  const errors: SchemaIssue[] = [];
  faults.forEach((fault, index) => validateFault(fault, `$[${index}]`, errors));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, faults: faults as FaultSpec[] };
}

export function criterionTypes(criteria: Criterion[]): Set<string> {
  return new Set(criteria.map((criterion) => criterion.type));
}
