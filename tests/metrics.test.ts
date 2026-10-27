import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateMetrics } from "../src/metrics/calculate.ts";
import { percentileNearestRank } from "../src/util.ts";
import { taskResult } from "./helpers.ts";

test("nearest-rank percentiles follow the documented rank", () => {
  assert.equal(percentileNearestRank([10, 20, 30, 40], 50), 20);
  assert.equal(percentileNearestRank([10, 20, 30, 40], 95), 40);
  assert.equal(percentileNearestRank([5], 95), 5);
  assert.equal(percentileNearestRank([], 50), null);
});

test("excluded outcomes are not successes and missing cost is not zero", () => {
  const metrics = calculateMetrics(
    [
      taskResult({ taskId: "ok", outcome: "succeeded", durationMs: 10, criteriaResults: [{ type: "exact_match", passed: true, detail: "ok" }] }),
      taskResult({ taskId: "bad", outcome: "failed", durationMs: 30, criteriaResults: [{ type: "exact_match", passed: false, detail: "no" }] }),
      taskResult({ taskId: "down", outcome: "infrastructure_error", durationMs: 1 }),
      taskResult({ taskId: "stop", outcome: "cancelled", durationMs: null }),
      taskResult({ taskId: "partial", outcome: "incomplete", durationMs: null }),
      taskResult({ taskId: "slow", outcome: "timeout", durationMs: 40, criteriaResults: [{ type: "exact_match", passed: false, detail: "timeout" }] }),
    ],
    { synthetic: true, minSampleSize: 10 },
  );
  assert.equal(metrics.taskSuccessRate.numerator, 1);
  assert.equal(metrics.taskSuccessRate.denominator, 3);
  assert.equal(metrics.sample.excluded.infrastructure_error, 1);
  assert.equal(metrics.sample.excluded.cancelled, 1);
  assert.equal(metrics.sample.excluded.incomplete, 1);
  assert.equal(metrics.timeoutRate.numerator, 1);
  assert.equal(metrics.timeoutRate.denominator, 3);
  assert.equal(metrics.exactMatchAccuracy?.numerator, 1);
  assert.equal(metrics.exactMatchAccuracy?.denominator, 3);
  assert.equal(metrics.estimatedCostUsd.recordedTotalUsd, null);
  assert.equal(metrics.tokenUsage.recordedTotalTokens, null);
  assert.equal(metrics.latencyMs.median, 30);
  assert.ok(metrics.warnings.includes("cost_unavailable"));
  assert.ok(metrics.warnings.includes("sample_below_minimum"));
  assert.equal(metrics.sample.smallSample, true);
});

test("cost per successful task ignores successes that have no cost", () => {
  const metrics = calculateMetrics([
    taskResult({ taskId: "a", outcome: "succeeded", estimatedCostUsd: 0.2, tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    taskResult({ taskId: "b", outcome: "succeeded", estimatedCostUsd: null }),
    taskResult({ taskId: "c", outcome: "failed", estimatedCostUsd: 1 }),
  ]);
  assert.equal(metrics.costPerSuccessfulTaskUsd, 0.2);
  assert.deepEqual(metrics.costPerSuccessfulTaskCoverage, { successesWithCost: 1, successes: 2 });
  assert.equal(metrics.tokenUsage.recordedTotalTokens, 15);
  assert.equal(metrics.tokenUsage.tasksMissingUsage, 2);
});

test("failure rate by category uses only evaluated tasks", () => {
  const metrics = calculateMetrics([
    taskResult({ taskId: "a", category: "tool_selection", outcome: "failed" }),
    taskResult({ taskId: "b", category: "tool_selection", outcome: "succeeded" }),
    taskResult({ taskId: "c", category: "tool_selection", outcome: "cancelled" }),
  ]);
  assert.equal(metrics.failureRateByCategory.tool_selection?.numerator, 1);
  assert.equal(metrics.failureRateByCategory.tool_selection?.denominator, 2);
});
