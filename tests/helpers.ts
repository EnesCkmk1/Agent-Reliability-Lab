import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskResult } from "../src/types.ts";

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "arl-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function taskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: overrides.taskId ?? "task-1",
    category: overrides.category ?? "json_schema",
    difficulty: overrides.difficulty ?? "easy",
    scenarioType: overrides.scenarioType ?? "baseline",
    synthetic: overrides.synthetic ?? true,
    title: overrides.title ?? "Fixture task",
    outcome: overrides.outcome ?? "succeeded",
    criteriaResults: overrides.criteriaResults ?? [{ type: "json_schema", passed: overrides.outcome === "succeeded", detail: "fixture" }],
    expectedOutput: overrides.expectedOutput ?? { ok: true },
    actualOutput: overrides.actualOutput ?? { ok: true },
    actualOutputText: overrides.actualOutputText ?? "{\"ok\":true}",
    failureReason: overrides.failureReason ?? null,
    toolCalls: overrides.toolCalls ?? [],
    injectedEvents: overrides.injectedEvents ?? [],
    startedAt: overrides.startedAt ?? "2026-10-27T00:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-10-27T00:00:00.010Z",
    durationMs: overrides.durationMs === undefined ? 10 : overrides.durationMs,
    tokenUsage: overrides.tokenUsage === undefined ? null : overrides.tokenUsage,
    estimatedCostUsd: overrides.estimatedCostUsd === undefined ? null : overrides.estimatedCostUsd,
    terminationReason: overrides.terminationReason ?? "completed",
    error: overrides.error ?? null,
    retries: overrides.retries ?? 0,
    timedOut: overrides.timedOut ?? overrides.outcome === "timeout",
  };
}
