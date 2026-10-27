import assert from "node:assert/strict";
import { test } from "node:test";
import { compareRuns } from "../src/compare/compare.ts";
import { calculateMetrics } from "../src/metrics/calculate.ts";
import type { RunRecord } from "../src/types.ts";
import { taskResult } from "./helpers.ts";

function run(id: string, tasks: ReturnType<typeof taskResult>[]): RunRecord {
  const metrics = calculateMetrics(tasks, { synthetic: true, minSampleSize: 10 });
  return {
    formatVersion: "arl.run.v1",
    id,
    status: "completed",
    dataset: {
      path: "datasets/baseline.json",
      version: "synthetic-v1",
      checksum: "abc",
      origin: "synthetic",
      synthetic: true,
      label: "SYNTHETIC — not real-world evaluation data",
      seed: 1,
      count: tasks.length,
      generator: { name: "arl-synthetic", version: "1" },
    },
    agent: {
      name: "scripted",
      version: "scripted-1",
      model: null,
      provider: null,
      usesAnswerKey: true,
      deterministic: true,
      config: { profile: "fixture" },
      promptTemplateVersion: null,
      promptTemplateSha256: null,
    },
    scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits: { timeoutMs: 1000, toolTimeoutMs: 1000, maxToolCalls: 4, maxRetries: 1 },
    evaluationCodeVersion: "0.1.0",
    gitCommit: null,
    metricDefinitionsVersion: "metrics-v1",
    environment: { node: "v22.0.0", platform: "linux", arch: "x64", dependencies: {} },
    startedAt: "2026-10-27T00:00:00.000Z",
    endedAt: "2026-10-27T00:00:01.000Z",
    durationMs: 1000,
    tasks,
    notRun: 0,
    metrics,
    interpretation: {
      syntheticData: true,
      agentUsesAnswerKey: true,
      deterministicAgent: true,
      evaluationClass: "deterministic",
      modelOutputDeterminism: "deterministic",
      note: "synthetic",
    },
  };
}

test("a success-rate drop is a regression when the sample is large enough", () => {
  const baseline = run("run_base_aaaa", Array.from({ length: 12 }, (_, index) => taskResult({ taskId: `t-${index}`, outcome: "succeeded" })));
  const candidate = run(
    "run_cand_bbbb",
    Array.from({ length: 12 }, (_, index) => taskResult({ taskId: `t-${index}`, outcome: index < 6 ? "succeeded" : "failed" })),
  );
  const report = compareRuns(baseline, candidate, {
    minSampleSize: 10,
    successRateDrop: 0.05,
    recoveryRateDrop: null,
    exactMatchDrop: null,
    schemaComplianceDrop: null,
    toolCallSuccessDrop: null,
    timeoutRateIncrease: null,
    p95LatencyIncreaseRatio: null,
    medianLatencyIncreaseRatio: null,
    costIncreaseRatio: null,
  });
  assert.equal(report.regression.declared, true);
  assert.equal(report.newFailures.length, 6);
  assert.equal(report.resolvedFailures.length, 0);
  assert.ok((report.successRate.delta ?? 0) < 0);
});

test("a tiny sample does not declare a regression", () => {
  const baseline = run("run_base_cccc", [taskResult({ taskId: "t-1", outcome: "succeeded" })]);
  const candidate = run("run_cand_dddd", [taskResult({ taskId: "t-1", outcome: "failed" })]);
  const report = compareRuns(baseline, candidate);
  assert.equal(report.regression.declared, false);
  assert.equal(report.regression.smallSample, true);
  assert.ok(report.regression.suppressedReasons.length > 0);
});
