import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentAdapter } from "../agents/types.ts";
import { datasetChecksum } from "../dataset/io.ts";
import { evaluateTask } from "./evaluate.ts";
import { calculateMetrics } from "../metrics/calculate.ts";
import { applyScenario } from "../scenarios/apply.ts";
import { createToolEnvironment } from "../tools/environment.ts";
import type { AgentExecution, Dataset, Limits, RunRecord, ScenarioConfig, TaskCase } from "../types.ts";
import { isAbortError } from "../util.ts";
import { METRICS_VERSION, PACKAGE_VERSION } from "../version.ts";

export interface BenchmarkRequest {
  dataset: Dataset;
  datasetPath: string;
  adapter: AgentAdapter;
  scenario: ScenarioConfig;
  seed: number;
  limits: Limits;
  signal?: AbortSignal;
  gitCommit?: string | null;
  runId?: string;
  onUpdate?: (run: RunRecord) => void | Promise<void>;
}

export async function executeBenchmark(request: BenchmarkRequest): Promise<RunRecord> {
  const started = new Date();
  const run = blankRun(request, started);
  await request.onUpdate?.(run);

  for (const task of request.dataset.cases) {
    if (request.signal?.aborted) {
      run.status = "interrupted";
      run.notRun = request.dataset.cases.length - run.tasks.length;
      break;
    }
    run.tasks.push(await runTask(task, request));
    run.notRun = request.dataset.cases.length - run.tasks.length;
    await request.onUpdate?.(run);
    const latest = run.tasks[run.tasks.length - 1];
    if (latest?.outcome === "incomplete" && request.signal?.aborted) {
      run.status = "interrupted";
      run.notRun = request.dataset.cases.length - run.tasks.length;
      break;
    }
  }

  const ended = new Date();
  run.endedAt = ended.toISOString();
  run.durationMs = ended.getTime() - started.getTime();
  if (run.status !== "interrupted") run.status = "completed";
  run.metrics = calculateMetrics(run.tasks, {
    synthetic: request.dataset.synthetic,
    usesAnswerKey: request.adapter.capabilities.usesAnswerKey,
    evaluationClass: request.scenario.evaluationClass,
    interrupted: run.status === "interrupted",
  });
  await request.onUpdate?.(run);
  return run;
}

async function runTask(task: TaskCase, request: BenchmarkRequest): Promise<RunRecord["tasks"][number]> {
  const applied = applyScenario(task, request.scenario);
  const limits: Limits = {
    ...request.limits,
    maxRetries: applied.maxRetriesOverride ?? request.limits.maxRetries,
  };
  const controller = new AbortController();
  const onParent = () => controller.abort("interrupted");
  if (request.signal?.aborted) controller.abort("interrupted");
  else request.signal?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort("timeout");
  }, limits.timeoutMs);

  const tools = createToolEnvironment({
    hiddenContext: task.hiddenContext,
    faults: applied.faults.filter((fault) => fault.kind !== "incomplete_input" && fault.kind !== "retry_limit" && !(fault.kind === "contradictory" && fault.target === "input")),
    limits,
    signal: controller.signal,
  });

  const startedAt = new Date();
  const startedMs = performance.now();
  let execution: AgentExecution;
  try {
    execution = await request.adapter.execute({
      view: applied.view,
      limits,
      tools,
      signal: controller.signal,
    });
    if (controller.signal.aborted && execution.terminationReason === "completed") {
      execution = abortedExecution(controller.signal.reason, startedAt.toISOString());
    }
  } catch (error) {
    execution = abortedExecution(
      controller.signal.aborted ? controller.signal.reason : "error",
      startedAt.toISOString(),
      error,
    );
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onParent);
  }

  const endedAt = new Date();
  const durationMs = performance.now() - startedMs;
  const events = [...applied.events, ...tools.events()];
  return evaluateTask(task, execution, tools.trace(), events, {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs,
  });
}

function abortedExecution(reason: unknown, startedAt: string, error?: unknown): AgentExecution {
  const interrupted = reason === "interrupted";
  const timeout = reason === "timeout" || isAbortError(error);
  if (interrupted) {
    return {
      outputText: null,
      output: null,
      outputParsed: false,
      parseError: null,
      startedAt,
      endedAt: new Date().toISOString(),
      tokenUsage: null,
      estimatedCostUsd: null,
      error: { code: "interrupted", message: "The run was interrupted." },
      terminationReason: "incomplete",
      metadata: {},
    };
  }
  if (timeout && reason !== "error") {
    return {
      outputText: null,
      output: null,
      outputParsed: false,
      parseError: null,
      startedAt,
      endedAt: new Date().toISOString(),
      tokenUsage: null,
      estimatedCostUsd: null,
      error: { code: "timeout", message: "Execution exceeded the configured timeout." },
      terminationReason: "timeout",
      metadata: {},
    };
  }
  return {
    outputText: null,
    output: null,
    outputParsed: false,
    parseError: null,
    startedAt,
    endedAt: new Date().toISOString(),
    tokenUsage: null,
    estimatedCostUsd: null,
    error: { code: "infrastructure_error", message: error instanceof Error ? error.message : "Adapter failed." },
    terminationReason: "infrastructure_error",
    metadata: {},
  };
}

function blankRun(request: BenchmarkRequest, started: Date): RunRecord {
  const synthetic = request.dataset.synthetic;
  const answerKey = request.adapter.capabilities.usesAnswerKey;
  const deterministic = request.adapter.capabilities.deterministic;
  return {
    formatVersion: "arl.run.v1",
    id: request.runId ?? createRunId(started),
    status: "running",
    dataset: {
      path: request.datasetPath,
      version: request.dataset.version,
      checksum: datasetChecksum(request.dataset),
      origin: request.dataset.origin,
      synthetic,
      label: request.dataset.label,
      seed: request.dataset.seed,
      count: request.dataset.count,
      generator: request.dataset.generator,
    },
    agent: {
      name: request.adapter.name,
      version: request.adapter.version,
      model: request.adapter.model,
      provider: request.adapter.provider,
      usesAnswerKey: answerKey,
      deterministic,
      config: request.adapter.publicConfig,
      promptTemplateVersion: request.adapter.promptTemplateVersion,
      promptTemplateSha256: request.adapter.promptTemplateSha256,
    },
    scenario: request.scenario,
    seed: request.seed,
    limits: request.limits,
    evaluationCodeVersion: PACKAGE_VERSION,
    gitCommit: request.gitCommit ?? null,
    metricDefinitionsVersion: METRICS_VERSION,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      dependencies: {},
    },
    startedAt: started.toISOString(),
    endedAt: null,
    durationMs: null,
    tasks: [],
    notRun: request.dataset.cases.length,
    metrics: null,
    interpretation: {
      syntheticData: synthetic,
      agentUsesAnswerKey: answerKey,
      deterministicAgent: deterministic,
      evaluationClass: request.scenario.evaluationClass,
      modelOutputDeterminism: deterministic ? "deterministic" : "not_guaranteed",
      note: interpretationNote(synthetic, answerKey, deterministic, request.scenario.evaluationClass),
    },
  };
}

export function interpretationNote(
  synthetic: boolean,
  answerKey: boolean,
  deterministic: boolean,
  evaluationClass: ScenarioConfig["evaluationClass"],
): string {
  const parts: string[] = [];
  if (synthetic) {
    parts.push("This run uses synthetic tasks. It is not a measurement of real-world performance.");
  }
  if (answerKey) {
    parts.push("The scripted adapter can read answer keys. Scores reflect the explicit behavior profile, not language-model quality.");
  }
  if (!deterministic) {
    parts.push("The configuration can be reproduced. Provider outputs are not guaranteed to repeat, because external model APIs can change.");
  }
  if (evaluationClass === "seeded_stress") {
    parts.push("This is a seeded stress run and is not a deterministic baseline.");
  }
  return parts.join(" ");
}

export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `run_${stamp}_${randomBytes(4).toString("hex")}`;
}

export const DEFAULT_LIMITS: Limits = {
  timeoutMs: 10_000,
  toolTimeoutMs: 5_000,
  maxToolCalls: 8,
  maxRetries: 2,
};
