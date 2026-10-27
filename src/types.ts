import type {
  DATASET_FORMAT,
  METRICS_VERSION,
  RUN_FORMAT,
} from "./version.ts";

export const TASK_CATEGORIES = [
  "structured_extraction",
  "json_schema",
  "multi_step_reasoning",
  "tool_selection",
  "input_validation",
  "missing_or_contradictory",
  "retry_recovery",
  "safe_refusal",
  "prompt_injection_resistance",
  "long_context_retrieval",
  "error_handling",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const SCENARIO_TYPES = ["baseline", "edge", "fault"] as const;
export type ScenarioType = (typeof SCENARIO_TYPES)[number];

export const VALIDATION_METHODS = [
  "exact_match",
  "json_schema",
  "numeric",
  "tool_trace",
  "refusal",
  "field_match",
  "recovery",
  "retrieval",
] as const;
export type ValidationMethod = (typeof VALIDATION_METHODS)[number];

export const FAULT_KINDS = [
  "error_on_first_call",
  "delay",
  "malformed",
  "unavailable",
  "incomplete_input",
  "contradictory",
  "retry_limit",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

export const TASK_OUTCOMES = [
  "succeeded",
  "failed",
  "invalid_output",
  "timeout",
  "cancelled",
  "infrastructure_error",
  "incomplete",
  "retry_exhausted",
] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const EXCLUDED_OUTCOMES = [
  "cancelled",
  "infrastructure_error",
  "incomplete",
] as const;

export const FAILURE_OUTCOMES = [
  "failed",
  "invalid_output",
  "timeout",
  "retry_exhausted",
] as const;

export const SCRIPTED_BEHAVIORS = [
  "correct",
  "incorrect",
  "invalid_json",
  "missing_fields",
  "tool_timeout",
  "tool_failure",
  "repeated_tool_calls",
  "incorrect_tool",
  "recover_after_transient",
  "fail_to_recover",
] as const;
export type ScriptedBehavior = (typeof SCRIPTED_BEHAVIORS)[number];

export const PROHIBITED_TOOLS = [
  "shell",
  "delete_file",
  "send_http",
  "write_file",
  "exec",
  "eval",
] as const;

export const SANDBOX_TOOLS = ["lookup_record", "calculator", "read_section"] as const;

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
  minLength?: number;
}

export type Criterion =
  | { type: "exact_match"; expected: unknown }
  | { type: "json_schema"; schema: JsonSchema }
  | { type: "field_match"; fields: Record<string, unknown> }
  | { type: "numeric"; path: string; value: number; tolerance: number }
  | { type: "tool_sequence"; tools: string[] }
  | { type: "refusal"; mustRefuse: boolean; prohibitedTools: string[] }
  | { type: "recovery"; mustRecover: boolean; maxAttempts: number; tool: string }
  | { type: "retrieval"; path: string; value: string }
  | { type: "max_tool_calls"; max: number };

export interface FaultSpec {
  id: string;
  target: string;
  kind: FaultKind;
  params: Record<string, unknown>;
}

export interface ExpectedToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  required: boolean;
}

export interface ExpectedRecovery {
  mustRecover: boolean;
  maxAttempts: number;
  tool: string;
}

export interface GenerationMetadata {
  generator: string;
  version: string;
  datasetSeed: number;
  caseSeed: number;
  datasetVersion: string;
  synthetic: boolean;
  label: string;
  notes: string;
}

export interface TaskCase {
  id: string;
  datasetVersion: string;
  origin: "synthetic" | "external";
  synthetic: boolean;
  category: TaskCategory;
  difficulty: Difficulty;
  title: string;
  prompt: string;
  input: Record<string, unknown>;
  visibleContext: Record<string, unknown>;
  hiddenContext: Record<string, unknown>;
  expectedOutput: unknown;
  validationMethod: ValidationMethod;
  criteria: Criterion[];
  scenarioType: ScenarioType;
  faults: FaultSpec[];
  expectedToolCalls: ExpectedToolCall[];
  expectedRecovery: ExpectedRecovery | null;
  seed: number;
  caseSeed: number;
  generation: GenerationMetadata;
}

export interface Dataset {
  formatVersion: typeof DATASET_FORMAT;
  version: string;
  origin: "synthetic" | "external" | "mixed";
  synthetic: boolean;
  label: string;
  seed: number | null;
  count: number;
  generator: { name: string; version: string } | null;
  notes: string;
  cases: TaskCase[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type TerminationReason =
  | "completed"
  | "error"
  | "timeout"
  | "cancelled"
  | "infrastructure_error"
  | "incomplete"
  | "retry_limit";

export interface AgentTaskView {
  id: string;
  category: TaskCategory;
  difficulty: Difficulty;
  title: string;
  prompt: string;
  input: Record<string, unknown>;
  visibleContext: Record<string, unknown>;
  synthetic: boolean;
  datasetVersion: string;
  scenarioType: ScenarioType;
}

export interface Limits {
  timeoutMs: number;
  toolTimeoutMs: number;
  maxToolCalls: number;
  maxRetries: number;
}

export interface AgentExecution {
  outputText: string | null;
  output: unknown;
  outputParsed: boolean;
  parseError: string | null;
  startedAt: string;
  endedAt: string;
  tokenUsage: TokenUsage | null;
  estimatedCostUsd: number | null;
  error: { code: string; message: string } | null;
  terminationReason: TerminationReason;
  metadata: Record<string, unknown>;
}

export interface ToolCallRecord {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  simulatedDelayMs: number;
  status: "success" | "error" | "timeout" | "not_permitted";
  result: unknown;
  error: string | null;
  attempt: number;
  injectedFaultId: string | null;
}

export interface InjectedEvent {
  id: string;
  source: "task" | "run";
  kind: FaultKind;
  target: string;
  phase: "configured" | "fired";
  detail: string;
}

export interface CriterionResult {
  type: Criterion["type"];
  passed: boolean;
  detail: string;
}

export interface TaskResult {
  taskId: string;
  category: TaskCategory;
  difficulty: Difficulty;
  scenarioType: ScenarioType;
  synthetic: boolean;
  title: string;
  outcome: TaskOutcome;
  criteriaResults: CriterionResult[];
  expectedOutput: unknown;
  actualOutput: unknown;
  actualOutputText: string | null;
  failureReason: string | null;
  toolCalls: ToolCallRecord[];
  injectedEvents: InjectedEvent[];
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  tokenUsage: TokenUsage | null;
  estimatedCostUsd: number | null;
  terminationReason: TerminationReason | "not_started";
  error: { code: string; message: string } | null;
  retries: number;
  timedOut: boolean;
}

export interface Rate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface MetricReport {
  version: typeof METRICS_VERSION;
  sample: {
    total: number;
    evaluated: number;
    excluded: {
      cancelled: number;
      infrastructure_error: number;
      incomplete: number;
    };
    smallSample: boolean;
    minSampleSize: number;
  };
  taskSuccessRate: Rate;
  exactMatchAccuracy: Rate | null;
  schemaComplianceRate: Rate | null;
  toolCallSuccessRate: Rate;
  recoverySuccessRate: Rate | null;
  failureRateByCategory: Record<string, Rate>;
  latencyMs: {
    median: number | null;
    p95: number | null;
    sampleSize: number;
    excludedMissingTimestamps: number;
  };
  tokenUsage: {
    recordedInputTokens: number | null;
    recordedOutputTokens: number | null;
    recordedTotalTokens: number | null;
    tasksWithUsage: number;
    tasksMissingUsage: number;
  };
  estimatedCostUsd: {
    recordedTotalUsd: number | null;
    meanPerRunUsd: number | null;
    tasksWithCost: number;
    tasksMissingCost: number;
  };
  costPerSuccessfulTaskUsd: number | null;
  costPerSuccessfulTaskCoverage: {
    successesWithCost: number;
    successes: number;
  };
  retryCount: {
    total: number;
    meanPerEvaluatedTask: number | null;
  };
  timeoutRate: Rate;
  warnings: string[];
}

export type ScenarioMode = "baseline" | "fault_injection" | "stress";
export type EvaluationClass = "deterministic" | "seeded_stress";

export interface ScenarioConfig {
  mode: ScenarioMode;
  seed: number;
  faults: FaultSpec[];
  evaluationClass: EvaluationClass;
}

export interface Interpretation {
  syntheticData: boolean;
  agentUsesAnswerKey: boolean;
  deterministicAgent: boolean;
  evaluationClass: EvaluationClass;
  modelOutputDeterminism: "deterministic" | "not_guaranteed";
  note: string;
}

export interface RunRecord {
  formatVersion: typeof RUN_FORMAT;
  id: string;
  status: "running" | "completed" | "interrupted";
  dataset: {
    path: string;
    version: string;
    checksum: string;
    origin: Dataset["origin"];
    synthetic: boolean;
    label: string;
    seed: number | null;
    count: number;
    generator: Dataset["generator"];
  };
  agent: {
    name: string;
    version: string;
    model: string | null;
    provider: string | null;
    usesAnswerKey: boolean;
    deterministic: boolean;
    config: Record<string, unknown>;
    promptTemplateVersion: string | null;
    promptTemplateSha256: string | null;
  };
  scenario: ScenarioConfig;
  seed: number;
  limits: Limits;
  evaluationCodeVersion: string;
  gitCommit: string | null;
  metricDefinitionsVersion: typeof METRICS_VERSION;
  environment: {
    node: string;
    platform: string;
    arch: string;
    dependencies: Record<string, string>;
  };
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  tasks: TaskResult[];
  notRun: number;
  metrics: MetricReport | null;
  interpretation: Interpretation;
}

export interface ScriptedProfile {
  name: string;
  defaultBehavior: ScriptedBehavior;
  byCategory?: Partial<Record<TaskCategory, ScriptedBehavior>>;
  byTaskId?: Record<string, ScriptedBehavior>;
  latencyMs?: number;
}

export interface AnswerKey {
  expectedOutput: unknown;
  expectedToolCalls: ExpectedToolCall[];
  expectedRecovery: ExpectedRecovery | null;
  category: TaskCategory;
}

export interface PriceCardEntry {
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface RegressionThresholds {
  minSampleSize: number;
  successRateDrop: number | null;
  recoveryRateDrop: number | null;
  exactMatchDrop: number | null;
  schemaComplianceDrop: number | null;
  toolCallSuccessDrop: number | null;
  timeoutRateIncrease: number | null;
  p95LatencyIncreaseRatio: number | null;
  medianLatencyIncreaseRatio: number | null;
  costIncreaseRatio: number | null;
}

export interface MetricComparison {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
}

export interface CompareReport {
  baselineRunId: string;
  candidateRunId: string;
  successRate: MetricComparison;
  recoveryRate: MetricComparison;
  medianLatencyMs: MetricComparison;
  p95LatencyMs: MetricComparison;
  estimatedCostUsd: MetricComparison;
  failureRateByCategory: Array<{
    category: string;
    baseline: number | null;
    candidate: number | null;
    delta: number | null;
  }>;
  newFailures: Array<{ taskId: string; baselineOutcome: TaskOutcome; candidateOutcome: TaskOutcome }>;
  resolvedFailures: Array<{ taskId: string; baselineOutcome: TaskOutcome; candidateOutcome: TaskOutcome }>;
  outcomeChanges: Array<{ taskId: string; baselineOutcome: TaskOutcome; candidateOutcome: TaskOutcome }>;
  regression: {
    declared: boolean;
    reasons: string[];
    suppressedReasons: string[];
    warnings: string[];
    smallSample: boolean;
    thresholds: RegressionThresholds;
  };
  notes: string[];
}

export interface VariationReport {
  runIds: string[];
  statisticalSignificance: "not_assessed";
  note: string;
  tasks: Array<{
    taskId: string;
    runs: number;
    successes: number;
    outcomes: TaskOutcome[];
    latencyMs: { min: number | null; max: number | null };
  }>;
}
