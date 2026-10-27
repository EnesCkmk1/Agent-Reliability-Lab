import type { MetricReport, RunRecord } from "../types.ts";
import { METRIC_DEFINITIONS } from "../metrics/definitions.ts";
import { formatNullable, formatRate } from "../metrics/calculate.ts";

export interface JsonReport {
  formatVersion: "arl.report.v1";
  disclaimer: string;
  syntheticData: boolean;
  agentUsesAnswerKey: boolean;
  modelOutputDeterminism: RunRecord["interpretation"]["modelOutputDeterminism"];
  run: RunRecord;
}

const DISCLAIMER =
  "Figures in this report come from the recorded benchmark run. Synthetic tasks and scripted adapters are not real-world performance. Missing cost and token figures are unavailable, not zero.";

export function jsonReport(run: RunRecord): JsonReport {
  return {
    formatVersion: "arl.report.v1",
    disclaimer: DISCLAIMER,
    syntheticData: run.interpretation.syntheticData,
    agentUsesAnswerKey: run.interpretation.agentUsesAnswerKey,
    modelOutputDeterminism: run.interpretation.modelOutputDeterminism,
    run,
  };
}

export function markdownReport(run: RunRecord): string {
  const metrics = run.metrics;
  const lines: string[] = [];
  lines.push(`# Agent Reliability Lab report`);
  lines.push("");
  lines.push(`> ${DISCLAIMER}`);
  lines.push("");
  if (run.dataset.synthetic) {
    lines.push(`> **${run.dataset.label}**`);
    lines.push("");
  }
  lines.push(run.interpretation.note);
  lines.push("");
  lines.push("## Run");
  lines.push("");
  lines.push(`- Run id: \`${run.id}\``);
  lines.push(`- Status: ${run.status}`);
  lines.push(`- Started: ${run.startedAt}`);
  lines.push(`- Duration: ${formatNullable(run.durationMs, " ms")}`);
  lines.push(`- Dataset: ${run.dataset.version} (${run.dataset.origin}), checksum \`${run.dataset.checksum}\``);
  lines.push(`- Dataset seed: ${run.dataset.seed ?? "n/a"}`);
  lines.push(`- Agent: ${run.agent.name} ${run.agent.version}`);
  lines.push(`- Model: ${run.agent.model ?? "n/a"}`);
  lines.push(`- Answer key: ${run.agent.usesAnswerKey ? "yes" : "no"}`);
  lines.push(`- Deterministic agent: ${run.agent.deterministic ? "yes" : "no"}`);
  lines.push(`- Prompt template: ${run.agent.promptTemplateVersion ?? "n/a"}`);
  lines.push(`- Scenario: ${run.scenario.mode} (${run.scenario.evaluationClass}), seed ${run.scenario.seed}`);
  lines.push(`- Injected run faults: ${run.scenario.faults.length}`);
  lines.push(`- Evaluation code: ${run.evaluationCodeVersion}`);
  lines.push(`- Git commit: ${run.gitCommit ?? "unavailable"}`);
  lines.push(`- Metric definitions: ${run.metricDefinitionsVersion}`);
  lines.push(`- Node: ${run.environment.node} (${run.environment.platform}/${run.environment.arch})`);
  lines.push("");
  lines.push("## Metrics");
  lines.push("");
  if (!metrics) {
    lines.push("Metrics were not calculated.");
  } else {
    lines.push(metricLine("Task success rate", formatRate(metrics.taskSuccessRate)));
    lines.push(metricLine("Exact-match accuracy", formatRate(metrics.exactMatchAccuracy)));
    lines.push(metricLine("Schema compliance", formatRate(metrics.schemaComplianceRate)));
    lines.push(metricLine("Tool-call success", formatRate(metrics.toolCallSuccessRate)));
    lines.push(metricLine("Recovery success", formatRate(metrics.recoverySuccessRate)));
    lines.push(metricLine("Timeout rate", formatRate(metrics.timeoutRate)));
    lines.push(metricLine("Median latency", formatNullable(metrics.latencyMs.median, " ms")));
    lines.push(metricLine("p95 latency", formatNullable(metrics.latencyMs.p95, " ms")));
    lines.push(`- Latency sample: ${metrics.latencyMs.sampleSize} (excluded missing timestamps: ${metrics.latencyMs.excludedMissingTimestamps})`);
    lines.push(metricLine("Recorded input tokens", formatNullable(metrics.tokenUsage.recordedInputTokens)));
    lines.push(metricLine("Recorded output tokens", formatNullable(metrics.tokenUsage.recordedOutputTokens)));
    lines.push(`- Token coverage: ${metrics.tokenUsage.tasksWithUsage} with usage, ${metrics.tokenUsage.tasksMissingUsage} missing`);
    lines.push(metricLine("Estimated cost (USD, recorded total)", formatNullable(metrics.estimatedCostUsd.recordedTotalUsd)));
    lines.push(metricLine("Mean estimated cost per costed task (USD)", formatNullable(metrics.estimatedCostUsd.meanPerRunUsd)));
    lines.push(metricLine("Cost per successful task (USD)", formatNullable(metrics.costPerSuccessfulTaskUsd)));
    lines.push(
      `- Success cost coverage: ${metrics.costPerSuccessfulTaskCoverage.successesWithCost}/${metrics.costPerSuccessfulTaskCoverage.successes} successes had a cost`,
    );
    lines.push(metricLine("Retries", `${metrics.retryCount.total} total, mean ${formatNullable(metrics.retryCount.meanPerEvaluatedTask)}`));
    lines.push(`- Evaluated sample: ${metrics.sample.evaluated} of ${metrics.sample.total} recorded tasks`);
    lines.push(
      `- Excluded: cancelled ${metrics.sample.excluded.cancelled}, infrastructure ${metrics.sample.excluded.infrastructure_error}, incomplete ${metrics.sample.excluded.incomplete}`,
    );
    lines.push(`- Not started: ${run.notRun}`);
    if (metrics.sample.smallSample) {
      lines.push(`- Warning: sample is below ${metrics.sample.minSampleSize}. Do not treat the rates as a firm conclusion.`);
    }
    if (metrics.warnings.length) {
      lines.push(`- Metric warnings: ${metrics.warnings.join(", ")}`);
    }
    lines.push("");
    lines.push("### Failure rate by category");
    lines.push("");
    const categories = Object.keys(metrics.failureRateByCategory).sort();
    if (categories.length === 0) lines.push("No evaluated categories.");
    for (const category of categories) {
      lines.push(`- ${category}: ${formatRate(metrics.failureRateByCategory[category] ?? null)}`);
    }
  }
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  lines.push("| Task | Category | Outcome | Latency (ms) | Retries | Failure |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const task of run.tasks) {
    lines.push(
      `| \`${task.taskId}\` | ${task.category} | ${task.outcome} | ${task.durationMs === null ? "n/a" : task.durationMs.toFixed(1)} | ${task.retries} | ${escapeCell(task.failureReason ?? "")} |`,
    );
  }
  lines.push("");
  lines.push("## Metric definitions");
  lines.push("");
  lines.push("These are the rules used for this report (`metrics-v1`).");
  lines.push("");
  for (const definition of METRIC_DEFINITIONS) {
    lines.push(`### ${definition.name}`);
    lines.push("");
    lines.push(`- Numerator: ${definition.numerator}`);
    lines.push(`- Denominator: ${definition.denominator}`);
    lines.push(`- Exclusions: ${definition.exclusions}`);
    lines.push(`- Aggregation: ${definition.aggregation}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function metricLine(name: string, value: string): string {
  return `- ${name}: ${value}`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function assertMetrics(metrics: MetricReport | null): asserts metrics is MetricReport {
  if (!metrics) throw new Error("Run has no metrics.");
}
