import assert from "node:assert/strict";
import { test } from "node:test";
import { createScriptedAdapter } from "../src/agents/scripted.ts";
import { executeBenchmark } from "../src/engine/run.ts";
import { generateDataset } from "../src/dataset/generate.ts";
import { markdownReport } from "../src/reporting/report.ts";
import { startServer } from "../src/server.ts";
import { RunStore } from "../src/storage/runs.ts";
import type { AnswerKey } from "../src/types.ts";
import { METRIC_DEFINITIONS } from "../src/metrics/definitions.ts";
import { tempDir } from "./helpers.ts";

test("stored runs can be compared, reported, and read through the API", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const dataset = generateDataset({ seed: 11, count: 11 });
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
    const store = new RunStore(dir);
    const base = await executeBenchmark({
      dataset,
      datasetPath: "memory.json",
      adapter: createScriptedAdapter({ name: "correct", defaultBehavior: "correct" }, answers),
      scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
      seed: 1,
      limits: { timeoutMs: 2000, toolTimeoutMs: 200, maxToolCalls: 8, maxRetries: 2 },
      gitCommit: null,
      runId: "run_20261027T000000Z_aaaaaaaa",
    });
    const worse = await executeBenchmark({
      dataset,
      datasetPath: "memory.json",
      adapter: createScriptedAdapter({ name: "wrong", defaultBehavior: "incorrect" }, answers),
      scenario: { mode: "baseline", seed: 1, faults: [], evaluationClass: "deterministic" },
      seed: 1,
      limits: { timeoutMs: 2000, toolTimeoutMs: 200, maxToolCalls: 8, maxRetries: 2 },
      gitCommit: null,
      runId: "run_20261027T000100Z_bbbbbbbb",
    });
    await store.save(base);
    await store.save(worse);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.get(base.id))?.id, base.id);

    const markdown = markdownReport(base);
    assert.match(markdown, /SYNTHETIC/);
    assert.match(markdown, /not real-world performance/);
    assert.match(markdown, /Task success rate/);
    for (const definition of METRIC_DEFINITIONS) assert.match(markdown, new RegExp(definition.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, roots: [process.cwd()] });
    try {
      const health = await fetch(`${server.url}api/health`);
      assert.equal(health.status, 200);
      const overview = await (await fetch(`${server.url}api/overview`)).json();
      assert.equal(overview.totalRuns, 2);
      assert.equal(overview.syntheticRunCount, 2);
      assert.ok(overview.tasksEvaluated > 0);
      const escaped = await fetch(`${server.url}api/dataset?path=${encodeURIComponent("../package.json")}`);
      assert.equal(escaped.status, 400);
      const badId = await fetch(`${server.url}api/runs/not%20a%20run`);
      assert.equal(badId.status, 400);
      const compare = await (await fetch(`${server.url}api/compare?baseline=${base.id}&candidate=${worse.id}`)).json();
      assert.equal(compare.regression.smallSample, false);
      assert.equal(compare.regression.declared, true);
      assert.ok(compare.newFailures.length > 0);
      const reliability = await fetch(`${server.url}api/reliability?run=${base.id}`);
      assert.equal(reliability.status, 200);
      const variation = await (await fetch(`${server.url}api/variation?runs=${base.id},${worse.id}`)).json();
      assert.equal(variation.statisticalSignificance, "not_assessed");
    } finally {
      await server.close();
    }
  } finally {
    await cleanup();
  }
});
