import assert from "node:assert/strict";
import { test } from "node:test";
import { createScriptedAdapter } from "../src/agents/scripted.ts";
import { executeBenchmark } from "../src/engine/run.ts";
import { generateDataset } from "../src/dataset/generate.ts";
import type { AnswerKey, ScriptedProfile, TaskCase } from "../src/types.ts";

function answersFor(cases: TaskCase[]): Map<string, AnswerKey> {
  return new Map(
    cases.map((task) => [
      task.id,
      {
        expectedOutput: task.expectedOutput,
        expectedToolCalls: task.expectedToolCalls,
        expectedRecovery: task.expectedRecovery,
        category: task.category,
      },
    ]),
  );
}

const limits = { timeoutMs: 2000, toolTimeoutMs: 50, maxToolCalls: 8, maxRetries: 2 };

test("the correct scripted profile passes the synthetic baseline, including recovery", async () => {
  const dataset = generateDataset({ seed: 20261027, count: 22 });
  const profile: ScriptedProfile = { name: "correct", defaultBehavior: "correct" };
  const run = await executeBenchmark({
    dataset,
    datasetPath: "datasets/baseline.json",
    adapter: createScriptedAdapter(profile, answersFor(dataset.cases)),
    scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits,
    gitCommit: null,
  });
  assert.equal(run.metrics?.taskSuccessRate.numerator, 22);
  assert.equal(run.metrics?.taskSuccessRate.denominator, 22);
  assert.equal(run.metrics?.recoverySuccessRate?.numerator, 2);
  assert.equal(run.metrics?.recoverySuccessRate?.denominator, 2);
  assert.equal(run.metrics?.estimatedCostUsd.recordedTotalUsd, null);
  assert.equal(run.agent.usesAnswerKey, true);
  assert.match(run.interpretation.note, /not a measurement of real-world performance/);
  const recovery = run.tasks.find((task) => task.taskId.endsWith("0006"));
  assert.equal(recovery?.outcome, "succeeded");
  assert.ok((recovery?.retries ?? 0) >= 1);
  assert.equal(recovery?.criteriaResults.find((item) => item.type === "recovery")?.passed, true);
});

test("explicit failure behaviors do not count a recovery claim as recovery", async () => {
  const dataset = generateDataset({ seed: 20261027, count: 22 });
  const profile: ScriptedProfile = {
    name: "mixed-explicit",
    defaultBehavior: "correct",
    byCategory: {
      json_schema: "invalid_json",
      structured_extraction: "missing_fields",
      multi_step_reasoning: "incorrect",
      tool_selection: "incorrect_tool",
      prompt_injection_resistance: "incorrect",
    },
    byTaskId: {
      "syn-synthetic-v1-20261027-0006": "recover_after_transient",
      "syn-synthetic-v1-20261027-0017": "fail_to_recover",
    },
  };
  const run = await executeBenchmark({
    dataset,
    datasetPath: "datasets/baseline.json",
    adapter: createScriptedAdapter(profile, answersFor(dataset.cases)),
    scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits,
    gitCommit: null,
  });
  const outcomes = Object.fromEntries(run.tasks.map((task) => [task.category + ":" + task.taskId.slice(-4), task.outcome]));
  assert.equal(run.tasks.find((task) => task.taskId.endsWith("0006"))?.outcome, "succeeded");
  const failedRecovery = run.tasks.find((task) => task.taskId.endsWith("0017"));
  assert.equal(failedRecovery?.outcome, "retry_exhausted");
  assert.equal(failedRecovery?.actualOutput && (failedRecovery.actualOutput as { recovered?: boolean }).recovered, true);
  assert.equal(failedRecovery?.criteriaResults.find((item) => item.type === "recovery")?.passed, false);
  assert.equal(run.tasks.filter((task) => task.category === "json_schema").every((task) => task.outcome === "invalid_output"), true);
  assert.equal(run.tasks.filter((task) => task.category === "safe_refusal").every((task) => task.outcome === "succeeded"), true);
  assert.equal(run.tasks.filter((task) => task.category === "safe_refusal").every((task) => task.toolCalls.length === 0), true);
  assert.ok(run.metrics && run.metrics.taskSuccessRate.rate !== null && run.metrics.taskSuccessRate.rate < 1);
  assert.ok(outcomes);
});

test("a tool delay is cut off by the tool timeout", async () => {
  const dataset = generateDataset({ seed: 5, count: 11 });
  const task = dataset.cases.find((item) => item.category === "tool_selection");
  assert.ok(task);
  const faulty = {
    ...dataset,
    cases: [
      {
        ...task,
        faults: [{ id: "delay-1", target: "lookup_record", kind: "delay" as const, params: { delayMs: 400 } }],
      },
    ],
    count: 1,
  };
  const started = Date.now();
  const run = await executeBenchmark({
    dataset: faulty,
    datasetPath: "memory",
    adapter: createScriptedAdapter({ name: "timeout", defaultBehavior: "tool_timeout" }, answersFor(faulty.cases)),
    scenario: { mode: "fault_injection", seed: 5, faults: [], evaluationClass: "deterministic" },
    seed: 5,
    limits: { timeoutMs: 2000, toolTimeoutMs: 30, maxToolCalls: 8, maxRetries: 2 },
    gitCommit: null,
  });
  assert.ok(Date.now() - started < 300);
  assert.equal(run.tasks[0]?.outcome, "timeout");
  assert.equal(run.tasks[0]?.toolCalls[0]?.status, "timeout");
});

test("an unavailable tool is not recovered by exhausting retries", async () => {
  const dataset = generateDataset({ seed: 5, count: 11 });
  const task = structuredClone(dataset.cases.find((item) => item.category === "retry_recovery")!);
  task.faults = [{ id: "down", target: "lookup_record", kind: "unavailable", params: {} }];
  const run = await executeBenchmark({
    dataset: { ...dataset, cases: [task], count: 1 },
    datasetPath: "memory",
    adapter: createScriptedAdapter({ name: "exhaust", defaultBehavior: "fail_to_recover" }, answersFor([task])),
    scenario: { mode: "fault_injection", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits,
    gitCommit: null,
  });
  assert.equal(run.tasks[0]?.outcome, "retry_exhausted");
  assert.equal(run.tasks[0]?.criteriaResults.find((item) => item.type === "recovery")?.passed, false);
  assert.ok(run.tasks[0]?.toolCalls.every((call) => call.status === "error"));
});

test("an interrupted run stays incomplete and is not successful", async () => {
  const dataset = generateDataset({ seed: 4, count: 2 });
  const controller = new AbortController();
  controller.abort("interrupted");
  const run = await executeBenchmark({
    dataset,
    datasetPath: "memory",
    adapter: createScriptedAdapter({ name: "correct", defaultBehavior: "correct" }, answersFor(dataset.cases)),
    scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits,
    signal: controller.signal,
    gitCommit: null,
  });
  assert.equal(run.status, "interrupted");
  assert.equal(run.tasks.length, 0);
  assert.equal(run.notRun, 2);
  assert.equal(run.metrics?.taskSuccessRate.numerator, 0);
  assert.equal(run.metrics?.taskSuccessRate.rate, null);
});

test("the same stress seed injects the same fault", async () => {
  const { stressFaults } = await import("../src/scenarios/apply.ts");
  assert.deepEqual(stressFaults(99), stressFaults(99));
  assert.notDeepEqual(stressFaults(99), stressFaults(100));
});

test("repeated calls and tool_failure are explicit scripted behaviors", async () => {
  const dataset = generateDataset({ seed: 12, count: 11 });
  const task = dataset.cases.find((item) => item.category === "multi_step_reasoning")!;
  const repeated = await executeBenchmark({
    dataset: { ...dataset, cases: [task], count: 1 },
    datasetPath: "memory",
    adapter: createScriptedAdapter({ name: "repeat", defaultBehavior: "repeated_tool_calls" }, answersFor([task])),
    scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits,
    gitCommit: null,
  });
  assert.equal(repeated.tasks[0]?.outcome, "succeeded");
  assert.equal(repeated.tasks[0]?.toolCalls.length, 3);
  const failed = await executeBenchmark({
    dataset: { ...dataset, cases: [task], count: 1 },
    datasetPath: "memory",
    adapter: createScriptedAdapter({ name: "tool-fail", defaultBehavior: "tool_failure" }, answersFor([task])),
    scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits,
    gitCommit: null,
  });
  assert.equal(failed.tasks[0]?.outcome, "failed");
  assert.notEqual(failed.tasks[0]?.outcome, "succeeded");
});

test("prohibited tools are rejected and not executed", async () => {
  const dataset = generateDataset({ seed: 8, count: 11 });
  const task = dataset.cases.find((item) => item.category === "safe_refusal")!;
  const run = await executeBenchmark({
    dataset: { ...dataset, cases: [task], count: 1 },
    datasetPath: "memory",
    adapter: createScriptedAdapter({ name: "bad-tool", defaultBehavior: "incorrect_tool" }, answersFor([task])),
    scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits,
    gitCommit: null,
  });
  assert.equal(run.tasks[0]?.outcome, "failed");
  assert.equal(run.tasks[0]?.toolCalls[0]?.tool, "shell");
  assert.equal(run.tasks[0]?.toolCalls[0]?.status, "not_permitted");
  assert.match(run.tasks[0]?.failureReason ?? "", /blocked by the sandbox/);
});
