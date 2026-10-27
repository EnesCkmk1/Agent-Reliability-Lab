import { calculateMetrics } from "../metrics/calculate.ts";
import {
  FAILURE_OUTCOMES,
  type CompareReport,
  type MetricComparison,
  type RegressionThresholds,
  type RunRecord,
  type TaskOutcome,
  type VariationReport,
} from "../types.ts";
import { DEFAULT_MIN_SAMPLE } from "../version.ts";

const failureOutcomes = new Set<string>(FAILURE_OUTCOMES);

export const DEFAULT_THRESHOLDS: RegressionThresholds = {
  minSampleSize: DEFAULT_MIN_SAMPLE,
  successRateDrop: 0.05,
  recoveryRateDrop: 0.05,
  exactMatchDrop: 0.05,
  schemaComplianceDrop: 0.05,
  toolCallSuccessDrop: 0.05,
  timeoutRateIncrease: 0.05,
  p95LatencyIncreaseRatio: null,
  medianLatencyIncreaseRatio: null,
  costIncreaseRatio: null,
};

export interface CompareOptions {
  declareDespiteSmallSample?: boolean;
}

export function compareRuns(
  baseline: RunRecord,
  candidate: RunRecord,
  thresholds: RegressionThresholds = DEFAULT_THRESHOLDS,
  options: CompareOptions = {},
): CompareReport {
  const baseMetrics = baseline.metrics ?? calculateMetrics(baseline.tasks, { synthetic: baseline.dataset.synthetic });
  const candMetrics = candidate.metrics ?? calculateMetrics(candidate.tasks, { synthetic: candidate.dataset.synthetic });
  let reasons: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  if (baseline.dataset.synthetic || candidate.dataset.synthetic) {
    notes.push("At least one run uses synthetic data. Differences are not real-world performance changes.");
  }
  if (baseline.agent.usesAnswerKey || candidate.agent.usesAnswerKey) {
    notes.push("At least one run used an answer-key scripted adapter.");
  }
  if (!baseline.agent.deterministic || !candidate.agent.deterministic) {
    notes.push("A non-deterministic adapter was used. A difference can come from the provider rather than the agent code.");
  }
  if (baseline.dataset.checksum !== candidate.dataset.checksum) {
    notes.push("Dataset checksums differ. Task-level comparison only includes ids present in both runs.");
  }

  const successRate = comparison(baseMetrics.taskSuccessRate.rate, candMetrics.taskSuccessRate.rate);
  const recoveryRate = comparison(baseMetrics.recoverySuccessRate?.rate ?? null, candMetrics.recoverySuccessRate?.rate ?? null);
  const medianLatencyMs = comparison(baseMetrics.latencyMs.median, candMetrics.latencyMs.median);
  const p95LatencyMs = comparison(baseMetrics.latencyMs.p95, candMetrics.latencyMs.p95);
  const estimatedCostUsd = comparison(baseMetrics.estimatedCostUsd.meanPerRunUsd, candMetrics.estimatedCostUsd.meanPerRunUsd);

  drop("success rate", successRate, thresholds.successRateDrop, reasons, warnings);
  drop("recovery rate", recoveryRate, thresholds.recoveryRateDrop, reasons, warnings);
  drop("exact-match accuracy", comparison(baseMetrics.exactMatchAccuracy?.rate ?? null, candMetrics.exactMatchAccuracy?.rate ?? null), thresholds.exactMatchDrop, reasons, warnings);
  drop("schema compliance", comparison(baseMetrics.schemaComplianceRate?.rate ?? null, candMetrics.schemaComplianceRate?.rate ?? null), thresholds.schemaComplianceDrop, reasons, warnings);
  drop("tool-call success", comparison(baseMetrics.toolCallSuccessRate.rate, candMetrics.toolCallSuccessRate.rate), thresholds.toolCallSuccessDrop, reasons, warnings);
  increase("timeout rate", comparison(baseMetrics.timeoutRate.rate, candMetrics.timeoutRate.rate), thresholds.timeoutRateIncrease, reasons, warnings);
  ratioIncrease("median latency", medianLatencyMs, thresholds.medianLatencyIncreaseRatio, reasons, warnings);
  ratioIncrease("p95 latency", p95LatencyMs, thresholds.p95LatencyIncreaseRatio, reasons, warnings);
  ratioIncrease("mean estimated cost", estimatedCostUsd, thresholds.costIncreaseRatio, reasons, warnings);

  const categories = new Set([
    ...Object.keys(baseMetrics.failureRateByCategory),
    ...Object.keys(candMetrics.failureRateByCategory),
  ]);
  const failureRateByCategory = [...categories].sort().map((category) => {
    const baselineRate = baseMetrics.failureRateByCategory[category]?.rate ?? null;
    const candidateRate = candMetrics.failureRateByCategory[category]?.rate ?? null;
    return { category, baseline: baselineRate, candidate: candidateRate, delta: delta(baselineRate, candidateRate) };
  });

  const baseById = new Map(baseline.tasks.map((task) => [task.taskId, task.outcome]));
  const candById = new Map(candidate.tasks.map((task) => [task.taskId, task.outcome]));
  const shared = [...baseById.keys()].filter((id) => candById.has(id));
  const onlyBaseline = [...baseById.keys()].filter((id) => !candById.has(id));
  const onlyCandidate = [...candById.keys()].filter((id) => !baseById.has(id));
  if (onlyBaseline.length || onlyCandidate.length) {
    notes.push(`${onlyBaseline.length} task ids exist only in the baseline and ${onlyCandidate.length} only in the candidate.`);
  }

  const newFailures = [];
  const resolvedFailures = [];
  const outcomeChanges = [];
  for (const taskId of shared) {
    const baselineOutcome = baseById.get(taskId)!;
    const candidateOutcome = candById.get(taskId)!;
    if (baselineOutcome === candidateOutcome) continue;
    outcomeChanges.push({ taskId, baselineOutcome, candidateOutcome });
    if (baselineOutcome === "succeeded" && failureOutcomes.has(candidateOutcome)) {
      newFailures.push({ taskId, baselineOutcome, candidateOutcome });
    }
    if (failureOutcomes.has(baselineOutcome) && candidateOutcome === "succeeded") {
      resolvedFailures.push({ taskId, baselineOutcome, candidateOutcome });
    }
  }

  const smallSample =
    baseMetrics.sample.evaluated < thresholds.minSampleSize || candMetrics.sample.evaluated < thresholds.minSampleSize;
  let declared = reasons.length > 0;
  let suppressedReasons: string[] = [];
  if (smallSample && declared && !options.declareDespiteSmallSample) {
    suppressedReasons = reasons;
    reasons = [];
    declared = false;
    warnings.push(
      `Thresholds were crossed, but a regression was not declared because a run has fewer than ${thresholds.minSampleSize} evaluated tasks.`,
    );
  } else if (smallSample) {
    warnings.push(`Sample size is below ${thresholds.minSampleSize}. Treat differences as descriptive.`);
  }

  return {
    baselineRunId: baseline.id,
    candidateRunId: candidate.id,
    successRate,
    recoveryRate,
    medianLatencyMs,
    p95LatencyMs,
    estimatedCostUsd,
    failureRateByCategory,
    newFailures,
    resolvedFailures,
    outcomeChanges,
    regression: { declared, reasons, suppressedReasons, warnings, smallSample, thresholds },
    notes,
  };
}

export function recentRegressions(runs: RunRecord[], thresholds: RegressionThresholds = DEFAULT_THRESHOLDS) {
  const groups = new Map<string, RunRecord[]>();
  for (const run of runs) {
    if (run.status !== "completed" || !run.metrics) continue;
    const key = [
      run.dataset.checksum,
      run.agent.name,
      run.agent.model ?? "",
      run.scenario.mode,
      run.scenario.evaluationClass,
      JSON.stringify(run.agent.config.profile ?? run.agent.config),
    ].join("|");
    const list = groups.get(key) ?? [];
    list.push(run);
    groups.set(key, list);
  }
  const found: Array<{ baselineRunId: string; candidateRunId: string; reasons: string[]; candidateStartedAt: string }> = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (let index = 1; index < group.length; index += 1) {
      const baseline = group[index - 1]!;
      const candidate = group[index]!;
      const report = compareRuns(baseline, candidate, thresholds);
      if (report.regression.declared) {
        found.push({
          baselineRunId: baseline.id,
          candidateRunId: candidate.id,
          reasons: report.regression.reasons,
          candidateStartedAt: candidate.startedAt,
        });
      }
    }
  }
  return found.sort((a, b) => b.candidateStartedAt.localeCompare(a.candidateStartedAt));
}

export function computeVariation(runs: RunRecord[]): VariationReport {
  const byTask = new Map<string, { outcomes: TaskOutcome[]; latencies: number[] }>();
  for (const run of runs) {
    for (const task of run.tasks) {
      const entry = byTask.get(task.taskId) ?? { outcomes: [], latencies: [] };
      entry.outcomes.push(task.outcome);
      if (typeof task.durationMs === "number" && Number.isFinite(task.durationMs)) entry.latencies.push(task.durationMs);
      byTask.set(task.taskId, entry);
    }
  }
  return {
    runIds: runs.map((run) => run.id),
    statisticalSignificance: "not_assessed",
    note: "Observed spread across the selected runs. Statistical significance is not assessed.",
    tasks: [...byTask.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([taskId, entry]) => ({
        taskId,
        runs: entry.outcomes.length,
        successes: entry.outcomes.filter((outcome) => outcome === "succeeded").length,
        outcomes: entry.outcomes,
        latencyMs: {
          min: entry.latencies.length ? Math.min(...entry.latencies) : null,
          max: entry.latencies.length ? Math.max(...entry.latencies) : null,
        },
      })),
  };
}

function comparison(baseline: number | null, candidate: number | null): MetricComparison {
  return { baseline, candidate, delta: delta(baseline, candidate) };
}

function delta(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null) return null;
  return candidate - baseline;
}

function drop(
  name: string,
  change: MetricComparison,
  threshold: number | null,
  reasons: string[],
  warnings: string[],
): void {
  if (threshold === null) return;
  if (change.baseline === null || change.candidate === null || change.delta === null) {
    warnings.push(`${name} was not compared because one side has no rate.`);
    return;
  }
  const fallen = change.baseline - change.candidate;
  if (fallen > threshold) {
    reasons.push(`${name} dropped by ${(fallen * 100).toFixed(1)} percentage points (threshold ${(threshold * 100).toFixed(1)}).`);
  }
}

function increase(
  name: string,
  change: MetricComparison,
  threshold: number | null,
  reasons: string[],
  warnings: string[],
): void {
  if (threshold === null) return;
  if (change.delta === null) {
    warnings.push(`${name} was not compared because one side has no rate.`);
    return;
  }
  if (change.delta > threshold) {
    reasons.push(`${name} increased by ${(change.delta * 100).toFixed(1)} percentage points (threshold ${(threshold * 100).toFixed(1)}).`);
  }
}

function ratioIncrease(
  name: string,
  change: MetricComparison,
  threshold: number | null,
  reasons: string[],
  warnings: string[],
): void {
  if (threshold === null) return;
  if (change.baseline === null || change.candidate === null || change.baseline === 0) {
    warnings.push(`${name} ratio was not compared because the baseline is missing or zero.`);
    return;
  }
  const ratio = (change.candidate - change.baseline) / change.baseline;
  if (ratio > threshold) {
    reasons.push(`${name} increased by ${(ratio * 100).toFixed(1)}% (threshold ${(threshold * 100).toFixed(1)}%).`);
  }
}
