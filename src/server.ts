import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns, computeVariation, recentRegressions } from "./compare/compare.ts";
import { datasetChecksum, readDatasetFile } from "./dataset/io.ts";
import { calculateMetrics } from "./metrics/calculate.ts";
import { METRIC_DEFINITIONS } from "./metrics/definitions.ts";
import { RunStore, assertRunId } from "./storage/runs.ts";
import type { RunRecord } from "./types.ts";
import { SYNTHETIC_LABEL } from "./version.ts";

const dashboardDir = fileURLToPath(new URL("../dashboard/", import.meta.url));

export interface ServerOptions {
  port: number;
  host: string;
  dataDir: string;
  roots: string[];
}

export async function startServer(options: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const store = new RunStore(options.dataDir);
  const server = createServer((request, response) => {
    void handle(request, response, store, options).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Server error" });
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}/`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, store: RunStore, options: ServerOptions): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Only GET is supported." });
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      product: "Agent Reliability Lab",
      version: "0.1.0",
      syntheticDataNotice: "Synthetic tasks are fictional and labelled. They are not real-world performance.",
    });
    return;
  }
  if (url.pathname === "/api/overview") {
    sendJson(response, 200, await overview(store));
    return;
  }
  if (url.pathname === "/api/runs") {
    const runs = await store.list();
    sendJson(response, 200, { runs: runs.map(publicSummary) });
    return;
  }
  if (url.pathname.startsWith("/api/runs/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
    try {
      assertRunId(id);
    } catch {
      sendJson(response, 400, { error: "Invalid run id." });
      return;
    }
    const run = await store.get(id);
    if (!run) {
      sendJson(response, 404, { error: "Run not found." });
      return;
    }
    sendJson(response, 200, run);
    return;
  }
  if (url.pathname === "/api/compare") {
    const baselineId = url.searchParams.get("baseline");
    const candidateId = url.searchParams.get("candidate");
    if (!baselineId || !candidateId) {
      sendJson(response, 400, { error: "baseline and candidate are required." });
      return;
    }
    try {
      assertRunId(baselineId);
      assertRunId(candidateId);
    } catch {
      sendJson(response, 400, { error: "Invalid run id." });
      return;
    }
    const baseline = await store.get(baselineId);
    const candidate = await store.get(candidateId);
    if (!baseline || !candidate) {
      sendJson(response, 404, { error: "Run not found." });
      return;
    }
    sendJson(response, 200, compareRuns(baseline, candidate));
    return;
  }
  if (url.pathname === "/api/definitions") {
    sendJson(response, 200, METRIC_DEFINITIONS);
    return;
  }
  if (url.pathname === "/api/dataset") {
    const datasetPath = url.searchParams.get("path");
    if (!datasetPath) {
      sendJson(response, 400, { error: "path is required." });
      return;
    }
    const file = resolveDataset(options.roots, datasetPath);
    if (!file) {
      sendJson(response, 400, { error: "Dataset path is outside the allowed roots." });
      return;
    }
    try {
      const dataset = await readDatasetFile(file);
      sendJson(response, 200, {
        path: datasetPath,
        version: dataset.version,
        origin: dataset.origin,
        synthetic: dataset.synthetic,
        label: dataset.label,
        seed: dataset.seed,
        count: dataset.count,
        checksum: datasetChecksum(dataset),
        generator: dataset.generator,
        notes: dataset.notes,
        cases: dataset.cases.map((task) => ({
          id: task.id,
          category: task.category,
          difficulty: task.difficulty,
          scenarioType: task.scenarioType,
          title: task.title,
          synthetic: task.synthetic,
          validationMethod: task.validationMethod,
          seed: task.seed,
        })),
      });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid dataset." });
    }
    return;
  }
  if (url.pathname === "/api/dataset/case") {
    const datasetPath = url.searchParams.get("path");
    const id = url.searchParams.get("id");
    if (!datasetPath || !id) {
      sendJson(response, 400, { error: "path and id are required." });
      return;
    }
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id)) {
      sendJson(response, 400, { error: "Invalid task id." });
      return;
    }
    const file = resolveDataset(options.roots, datasetPath);
    if (!file) {
      sendJson(response, 400, { error: "Dataset path is outside the allowed roots." });
      return;
    }
    try {
      const dataset = await readDatasetFile(file);
      const task = dataset.cases.find((item) => item.id === id);
      if (!task) {
        sendJson(response, 404, { error: "Task not found." });
        return;
      }
      sendJson(response, 200, task);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid dataset." });
    }
    return;
  }
  if (url.pathname === "/api/reliability") {
    const id = url.searchParams.get("run");
    if (!id) {
      sendJson(response, 400, { error: "run is required." });
      return;
    }
    try {
      assertRunId(id);
    } catch {
      sendJson(response, 400, { error: "Invalid run id." });
      return;
    }
    const run = await store.get(id);
    if (!run?.metrics) {
      sendJson(response, 404, { error: "Run not found." });
      return;
    }
    sendJson(response, 200, {
      runId: run.id,
      failureRateByCategory: run.metrics.failureRateByCategory,
      recoverySuccessRate: run.metrics.recoverySuccessRate,
      timeoutRate: run.metrics.timeoutRate,
      retryCount: run.metrics.retryCount,
      smallSample: run.metrics.sample.smallSample,
      evaluated: run.metrics.sample.evaluated,
      warnings: run.metrics.warnings,
    });
    return;
  }
  if (url.pathname === "/api/variation") {
    const ids = (url.searchParams.get("runs") ?? "").split(",").filter(Boolean);
    if (ids.length < 2) {
      sendJson(response, 400, { error: "At least two run ids are required." });
      return;
    }
    const runs: RunRecord[] = [];
    for (const id of ids) {
      try {
        assertRunId(id);
      } catch {
        sendJson(response, 400, { error: "Invalid run id." });
        return;
      }
      const run = await store.get(id);
      if (!run) {
        sendJson(response, 404, { error: `Run not found: ${id}` });
        return;
      }
      runs.push(run);
    }
    sendJson(response, 200, computeVariation(runs));
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/styles.css" || url.pathname === "/app.js" || url.pathname === "/favicon.svg") {
    await serveStatic(url.pathname, response);
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

async function overview(store: RunStore) {
  const runs = await store.list();
  const tasks = runs.flatMap((run) => run.tasks);
  const metrics = calculateMetrics(tasks, { synthetic: runs.some((run) => run.dataset.synthetic) });
  return {
    totalRuns: runs.length,
    tasksEvaluated: metrics.sample.evaluated,
    successes: metrics.taskSuccessRate.numerator,
    successRate: metrics.taskSuccessRate.rate,
    successSampleSize: metrics.sample.evaluated,
    smallSample: metrics.sample.smallSample || runs.length === 0,
    medianLatencyMs: metrics.latencyMs.median,
    p95LatencyMs: metrics.latencyMs.p95,
    latencySampleSize: metrics.latencyMs.sampleSize,
    estimatedCostUsd: metrics.estimatedCostUsd.recordedTotalUsd,
    costCoverage: { runsWithCost: runs.filter((run) => run.metrics?.estimatedCostUsd.tasksWithCost).length, runs: runs.length },
    syntheticRunCount: runs.filter((run) => run.dataset.synthetic).length,
    externalRunCount: runs.filter((run) => !run.dataset.synthetic).length,
    recentRegressions: recentRegressions(runs),
    notice:
      runs.length === 0
        ? "No runs yet. Rates are not shown until a benchmark has been stored."
        : "Pooled across every persisted task. Runs may use different agents and profiles. This is not a leaderboard.",
    syntheticLabel: SYNTHETIC_LABEL,
  };
}

function publicSummary(run: RunRecord) {
  const metrics = run.metrics;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    datasetVersion: run.dataset.version,
    datasetSynthetic: run.dataset.synthetic,
    datasetLabel: run.dataset.label,
    agentName: run.agent.name,
    model: run.agent.model,
    usesAnswerKey: run.agent.usesAnswerKey,
    deterministic: run.agent.deterministic,
    scenarioMode: run.scenario.mode,
    evaluationClass: run.scenario.evaluationClass,
    seed: run.seed,
    taskCount: run.dataset.count,
    evaluated: metrics?.sample.evaluated ?? 0,
    successes: metrics?.taskSuccessRate.numerator ?? 0,
    successRate: metrics?.taskSuccessRate.rate ?? null,
    medianLatencyMs: metrics?.latencyMs.median ?? null,
    p95LatencyMs: metrics?.latencyMs.p95 ?? null,
    estimatedCostUsd: metrics?.estimatedCostUsd.recordedTotalUsd ?? null,
    smallSample: metrics?.sample.smallSample ?? true,
  };
}

function resolveDataset(roots: string[], requested: string): string | null {
  if (requested.includes("\0") || requested.includes("\\")) return null;
  for (const root of roots) {
    const rootResolved = resolve(root);
    const target = resolve(rootResolved, requested);
    if (target === rootResolved || target.startsWith(rootResolved + sep)) return target;
  }
  return null;
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (name.includes("..")) {
    sendJson(response, 400, { error: "Invalid path." });
    return;
  }
  const file = join(dashboardDir, name);
  try {
    await access(file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Dashboard file is not available.");
    return;
  }
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  response.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  createReadStream(file).pipe(response);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export { resolveDataset };
