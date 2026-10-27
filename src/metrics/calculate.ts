import { percentileNearestRank, round } from "../util.ts";
import {
  EXCLUDED_OUTCOMES,
  FAILURE_OUTCOMES,
  type MetricReport,
  type Rate,
  type TaskOutcome,
  type TaskResult,
} from "../types.ts";
import { DEFAULT_MIN_SAMPLE, METRICS_VERSION } from "../version.ts";

export interface MetricContext {
  minSampleSize?: number;
  synthetic?: boolean;
  usesAnswerKey?: boolean;
  evaluationClass?: "deterministic" | "seeded_stress";
  interrupted?: boolean;
}

const excluded = new Set<string>(EXCLUDED_OUTCOMES);
const failures = new Set<string>(FAILURE_OUTCOMES);

export function calculateMetrics(tasks: readonly TaskResult[], context: MetricContext = {}): MetricReport {
  const minSampleSize = context.minSampleSize ?? DEFAULT_MIN_SAMPLE;
  const evaluated = tasks.filter((task) => !excluded.has(task.outcome));
  const countOutcome = (outcome: TaskOutcome) => tasks.filter((task) => task.outcome === outcome).length;
  const successes = evaluated.filter((task) => task.outcome === "succeeded");

  const exactTasks = evaluated.filter((task) => hasType(task, "exact_match"));
  const schemaTasks = evaluated.filter((task) => hasType(task, "json_schema"));
  const recoveryTasks = evaluated.filter((task) => hasType(task, "recovery"));
  const toolCalls = tasks.flatMap((task) => task.toolCalls);
  const successfulCalls = toolCalls.filter((call) => call.status === "success");

  const latencySamples: number[] = [];
  let missingLatency = 0;
  for (const task of evaluated) {
    if (typeof task.durationMs === "number" && Number.isFinite(task.durationMs)) latencySamples.push(task.durationMs);
    else missingLatency += 1;
  }
  latencySamples.sort((a, b) => a - b);

  const withUsage = tasks.filter((task) => task.tokenUsage != null);
  const missingUsage = tasks.length - withUsage.length;
  const withCost = tasks.filter((task) => task.estimatedCostUsd != null);
  const successesWithCost = successes.filter((task) => task.estimatedCostUsd != null);

  const failureRateByCategory: Record<string, Rate> = {};
  for (const category of new Set(evaluated.map((task) => task.category))) {
    const group = evaluated.filter((task) => task.category === category);
    const failed = group.filter((task) => failures.has(task.outcome)).length;
    failureRateByCategory[category] = rate(failed, group.length);
  }

  const warnings: string[] = [];
  if (evaluated.length < minSampleSize) warnings.push("sample_below_minimum");
  if (tasks.length > 0 && withUsage.length === 0) warnings.push("token_usage_unavailable");
  else if (missingUsage > 0 && withUsage.length > 0) warnings.push("token_usage_partial");
  if (tasks.length > 0 && withCost.length === 0) warnings.push("cost_unavailable");
  else if (withCost.length > 0 && withCost.length < tasks.length) warnings.push("cost_partial");
  if (successesWithCost.length < successes.length) warnings.push("successful_task_cost_partial");
  if (context.interrupted) warnings.push("run_interrupted");
  if (context.synthetic) warnings.push("synthetic_data");
  if (context.usesAnswerKey) warnings.push("scripted_answer_key");
  if (context.evaluationClass === "seeded_stress") warnings.push("seeded_stress_not_a_baseline");

  const retryTotal = evaluated.reduce((sum, task) => sum + task.retries, 0);
  const recordedCost = withCost.reduce((sum, task) => sum + (task.estimatedCostUsd ?? 0), 0);
  const successCost = successesWithCost.reduce((sum, task) => sum + (task.estimatedCostUsd ?? 0), 0);

  return {
    version: METRICS_VERSION,
    sample: {
      total: tasks.length,
      evaluated: evaluated.length,
      excluded: {
        cancelled: countOutcome("cancelled"),
        infrastructure_error: countOutcome("infrastructure_error"),
        incomplete: countOutcome("incomplete"),
      },
      smallSample: evaluated.length < minSampleSize,
      minSampleSize,
    },
    taskSuccessRate: rate(successes.length, evaluated.length),
    exactMatchAccuracy: exactTasks.length === 0 ? null : rate(passed(exactTasks, "exact_match"), exactTasks.length),
    schemaComplianceRate: schemaTasks.length === 0 ? null : rate(passed(schemaTasks, "json_schema"), schemaTasks.length),
    toolCallSuccessRate: rate(successfulCalls.length, toolCalls.length),
    recoverySuccessRate: recoveryTasks.length === 0 ? null : rate(passed(recoveryTasks, "recovery"), recoveryTasks.length),
    failureRateByCategory,
    latencyMs: {
      median: percentileNearestRank(latencySamples, 50),
      p95: percentileNearestRank(latencySamples, 95),
      sampleSize: latencySamples.length,
      excludedMissingTimestamps: missingLatency,
    },
    tokenUsage: {
      recordedInputTokens: withUsage.length ? withUsage.reduce((sum, task) => sum + (task.tokenUsage?.inputTokens ?? 0), 0) : null,
      recordedOutputTokens: withUsage.length ? withUsage.reduce((sum, task) => sum + (task.tokenUsage?.outputTokens ?? 0), 0) : null,
      recordedTotalTokens: withUsage.length ? withUsage.reduce((sum, task) => sum + (task.tokenUsage?.totalTokens ?? 0), 0) : null,
      tasksWithUsage: withUsage.length,
      tasksMissingUsage: missingUsage,
    },
    estimatedCostUsd: {
      recordedTotalUsd: withCost.length ? round(recordedCost, 8) : null,
      meanPerRunUsd: withCost.length ? round(recordedCost / withCost.length, 8) : null,
      tasksWithCost: withCost.length,
      tasksMissingCost: tasks.length - withCost.length,
    },
    costPerSuccessfulTaskUsd: successesWithCost.length ? round(successCost / successesWithCost.length, 8) : null,
    costPerSuccessfulTaskCoverage: {
      successesWithCost: successesWithCost.length,
      successes: successes.length,
    },
    retryCount: {
      total: retryTotal,
      meanPerEvaluatedTask: evaluated.length ? round(retryTotal / evaluated.length, 6) : null,
    },
    timeoutRate: rate(evaluated.filter((task) => task.outcome === "timeout").length, evaluated.length),
    warnings,
  };
}

function hasType(task: TaskResult, type: string): boolean {
  return task.criteriaResults.some((criterion) => criterion.type === type);
}

function passed(tasks: TaskResult[], type: string): number {
  return tasks.filter((task) => task.criteriaResults.some((criterion) => criterion.type === type && criterion.passed)).length;
}

export function rate(numerator: number, denominator: number): Rate {
  if (denominator === 0) return { numerator, denominator, rate: null };
  return { numerator, denominator, rate: numerator / denominator };
}

export function formatRate(value: Rate | null): string {
  if (!value || value.rate === null) return "n/a (n=0)";
  return `${value.numerator}/${value.denominator} (${(value.rate * 100).toFixed(1)}%)`;
}

export function formatNullable(value: number | null, suffix = ""): string {
  if (value === null) return "unavailable";
  const text = Number.isInteger(value) ? String(value) : String(round(value, 4));
  return `${text}${suffix}`;
}
