import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createScriptedAdapter } from "../src/agents/scripted.ts";
import { datasetChecksum, readDatasetFile } from "../src/dataset/io.ts";
import { generateDataset } from "../src/dataset/generate.ts";
import { executeBenchmark } from "../src/engine/run.ts";
import { formatRate } from "../src/metrics/calculate.ts";
import { startServer } from "../src/server.ts";
import type { AnswerKey } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

test("the committed baseline dataset matches seed 20261027 and count 22", async () => {
  const committed = await readDatasetFile("datasets/baseline.json");
  const generated = generateDataset({ seed: 20261027, count: 22 });
  assert.equal(datasetChecksum(committed), datasetChecksum(generated));
  assert.equal(committed.synthetic, true);
  assert.match(committed.label, /SYNTHETIC/);
});

test("the checked-in mixed report matches a fresh scripted run", async () => {
  const report = await readFile("examples/mixed-report.md", "utf8");
  const dataset = await readDatasetFile("datasets/baseline.json");
  const profile = JSON.parse(await readFile("fixtures/scripted-mixed.json", "utf8"));
  const answers = new Map<string, AnswerKey>(
    dataset.cases.map((task) => [
      task.id,
      {
        expectedOutput: task.expectedOutput,
        expectedToolCalls: task.expectedToolCalls,
        expectedRecovery: task.expectedRecovery,
        category: task.category,
      },
    ]),
  );
  const run = await executeBenchmark({
    dataset,
    datasetPath: "datasets/baseline.json",
    adapter: createScriptedAdapter(profile, answers),
    scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
    seed: 1,
    limits: { timeoutMs: 2000, toolTimeoutMs: 200, maxToolCalls: 8, maxRetries: 2 },
    gitCommit: null,
  });
  assert.match(report, /SYNTHETIC/);
  assert.match(report, /not real-world performance/);
  assert.match(report, new RegExp(formatRate(run.metrics?.taskSuccessRate ?? null).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(run.metrics?.taskSuccessRate.numerator, 11);
  assert.equal(run.metrics?.taskSuccessRate.denominator, 22);
});

test("the dashboard is static, local, and does not inject HTML", async () => {
  const source = await readFile("dashboard/app.js", "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|document\.write|eval\(/);
  const { dir, cleanup } = await tempDir();
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, roots: [process.cwd()] });
  try {
    const response = await fetch(`${server.url}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Agent Reliability Lab/);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    const overview = await (await fetch(`${server.url}api/overview`)).json();
    assert.equal(overview.totalRuns, 0);
    assert.equal(overview.successRate, null);
    assert.equal(overview.estimatedCostUsd, null);
  } finally {
    await server.close();
    await cleanup();
  }
});
