import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunRecord } from "../types.ts";

const RUN_ID = /^run_[A-Za-z0-9_]+$/;

export class RunStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  directory(): string {
    return join(this.root, "runs");
  }

  async save(run: RunRecord): Promise<void> {
    assertRunId(run.id);
    const directory = this.directory();
    await mkdir(directory, { recursive: true });
    await atomicWrite(join(directory, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
    const runs = await this.list();
    const summaries = runs.map(summarize);
    await atomicWrite(join(directory, "index.json"), `${JSON.stringify({ runs: summaries }, null, 2)}\n`);
  }

  async get(id: string): Promise<RunRecord | null> {
    assertRunId(id);
    try {
      const text = await readFile(join(this.directory(), `${id}.json`), "utf8");
      return JSON.parse(text) as RunRecord;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async list(): Promise<RunRecord[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.directory());
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const runs: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name === "index.json") continue;
      const text = await readFile(join(this.directory(), name), "utf8");
      runs.push(JSON.parse(text) as RunRecord);
    }
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return runs;
  }
}

export function summarize(run: RunRecord) {
  const metrics = run.metrics;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    datasetVersion: run.dataset.version,
    datasetChecksum: run.dataset.checksum,
    datasetSynthetic: run.dataset.synthetic,
    datasetLabel: run.dataset.label,
    agentName: run.agent.name,
    agentVersion: run.agent.version,
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

export function assertRunId(id: string): void {
  if (!RUN_ID.test(id)) throw new Error(`Invalid run id "${id}".`);
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, body, "utf8");
  await rename(temporary, path);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
