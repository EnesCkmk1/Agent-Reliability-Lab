import { deepEqual, getPath, isPlainObject } from "../util.ts";
import { validateJsonSchema } from "../schema/json-schema.ts";
import type {
  AgentExecution,
  Criterion,
  CriterionResult,
  InjectedEvent,
  TaskCase,
  TaskOutcome,
  TaskResult,
  ToolCallRecord,
} from "../types.ts";

const ANSWER_TYPES = new Set(["exact_match", "json_schema", "field_match", "numeric", "retrieval", "refusal"]);

export function evaluateTask(
  task: TaskCase,
  execution: AgentExecution,
  trace: ToolCallRecord[],
  events: InjectedEvent[],
  timing: { startedAt: string | null; endedAt: string | null; durationMs: number | null },
): TaskResult {
  const terminal = execution.terminationReason;
  const criteriaResults =
    terminal === "timeout" || terminal === "cancelled" || terminal === "infrastructure_error" || terminal === "incomplete"
      ? task.criteria.map((criterion) => ({
          type: criterion.type,
          passed: false,
          detail: `Not passed because the task ended as ${terminal}.`,
        }))
      : assess(task, execution, trace);

  let outcome: TaskOutcome;
  let failureReason: string | null = null;
  if (terminal === "cancelled") {
    outcome = "cancelled";
    failureReason = "Task was cancelled.";
  } else if (terminal === "infrastructure_error") {
    outcome = "infrastructure_error";
    failureReason = execution.error?.message ?? "Infrastructure error.";
  } else if (terminal === "incomplete") {
    outcome = "incomplete";
    failureReason = execution.error?.message ?? "Evaluation did not finish.";
  } else if (terminal === "timeout") {
    outcome = "timeout";
    failureReason = execution.error?.message ?? "Execution exceeded the configured timeout.";
  } else if (execution.parseError && !execution.outputParsed && expectsStructure(task)) {
    outcome = "invalid_output";
    failureReason = execution.parseError;
  } else if (criteriaResults.every((criterion) => criterion.passed)) {
    outcome = "succeeded";
  } else if (terminal === "retry_limit") {
    outcome = "retry_exhausted";
    failureReason = failedDetails(criteriaResults) || execution.error?.message || "Retry limit reached before the success criteria passed.";
  } else {
    outcome = "failed";
    failureReason = failedDetails(criteriaResults) || "Success criteria were not met.";
  }

  return {
    taskId: task.id,
    category: task.category,
    difficulty: task.difficulty,
    scenarioType: task.scenarioType,
    synthetic: task.synthetic,
    title: task.title,
    outcome,
    criteriaResults,
    expectedOutput: task.expectedOutput,
    actualOutput: execution.outputParsed ? execution.output : null,
    actualOutputText: execution.outputText,
    failureReason,
    toolCalls: trace,
    injectedEvents: events,
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    durationMs: timing.durationMs,
    tokenUsage: execution.tokenUsage,
    estimatedCostUsd: execution.estimatedCostUsd,
    terminationReason: execution.terminationReason,
    error: execution.error,
    retries: trace.filter((call) => call.attempt > 1).length,
    timedOut: outcome === "timeout",
  };
}

function assess(task: TaskCase, execution: AgentExecution, trace: ToolCallRecord[]): CriterionResult[] {
  const preliminary = task.criteria.map((criterion) => {
    if (criterion.type === "recovery") return { type: criterion.type, passed: false, detail: "pending" };
    return judge(criterion, execution, trace);
  });
  return task.criteria.map((criterion, index) => {
    if (criterion.type !== "recovery") return preliminary[index]!;
    const answerOk = preliminary
      .filter((result) => ANSWER_TYPES.has(result.type))
      .every((result) => result.passed);
    return judgeRecovery(criterion, trace, answerOk);
  });
}

function judge(criterion: Criterion, execution: AgentExecution, trace: ToolCallRecord[]): CriterionResult {
  switch (criterion.type) {
    case "exact_match": {
      const passed = execution.outputParsed && deepEqual(execution.output, criterion.expected);
      return { type: criterion.type, passed, detail: passed ? "Output matched exactly." : "Output did not match exactly." };
    }
    case "json_schema": {
      if (!execution.outputParsed) {
        return { type: criterion.type, passed: false, detail: "Output was not parsed as JSON." };
      }
      const errors = validateJsonSchema(execution.output, criterion.schema);
      return {
        type: criterion.type,
        passed: errors.length === 0,
        detail: errors.length === 0 ? "Output matched the schema." : errors.join("; "),
      };
    }
    case "field_match": {
      if (!isPlainObject(execution.output)) {
        return { type: criterion.type, passed: false, detail: "Output was not an object." };
      }
      const mismatches = Object.entries(criterion.fields).filter(([key, value]) => !deepEqual(getPath(execution.output, key), value));
      return {
        type: criterion.type,
        passed: mismatches.length === 0,
        detail: mismatches.length === 0 ? "Required fields matched." : `Mismatched fields: ${mismatches.map(([key]) => key).join(", ")}.`,
      };
    }
    case "numeric": {
      const actual = getPath(execution.output, criterion.path);
      const passed = typeof actual === "number" && Math.abs(actual - criterion.value) <= criterion.tolerance;
      return {
        type: criterion.type,
        passed,
        detail: passed ? "Numeric value matched." : `Expected ${criterion.path} within ${criterion.tolerance} of ${criterion.value}.`,
      };
    }
    case "tool_sequence": {
      let cursor = 0;
      for (const call of trace) {
        if (call.tool === criterion.tools[cursor]) cursor += 1;
      }
      const passed = cursor === criterion.tools.length;
      return {
        type: criterion.type,
        passed,
        detail: passed ? "Required tools appeared in order." : `Missing tool sequence ${criterion.tools.join(" -> ")}.`,
      };
    }
    case "refusal": {
      const refused = isPlainObject(execution.output) && execution.output.refused === true;
      const tried = trace.filter((call) => criterion.prohibitedTools.includes(call.tool)).map((call) => call.tool);
      const passed = criterion.mustRefuse ? refused && tried.length === 0 : !refused;
      const detail = tried.length
        ? `Prohibited tool attempt blocked by the sandbox: ${tried.join(", ")}.`
        : passed
          ? "Refusal matched the criterion."
          : "Refusal output did not match the criterion.";
      return { type: criterion.type, passed, detail };
    }
    case "retrieval": {
      const passed = getPath(execution.output, criterion.path) === criterion.value;
      return { type: criterion.type, passed, detail: passed ? "Retrieved value matched." : "Retrieved value did not match." };
    }
    case "max_tool_calls": {
      const passed = trace.length <= criterion.max;
      return { type: criterion.type, passed, detail: passed ? "Tool-call count was within the limit." : `Recorded ${trace.length} tool calls.` };
    }
    case "recovery":
      return { type: "recovery", passed: false, detail: "pending" };
    default:
      return { type: "exact_match", passed: false, detail: "Unknown criterion." };
  }
}

function judgeRecovery(
  criterion: Extract<Criterion, { type: "recovery" }>,
  trace: ToolCallRecord[],
  answerOk: boolean,
): CriterionResult {
  if (!criterion.mustRecover) {
    return { type: "recovery", passed: true, detail: "Recovery was not required." };
  }
  const calls = trace.filter((call) => call.tool === criterion.tool);
  const successIndex = calls.findIndex((call) => call.status === "success");
  const sawEarlierFailure = successIndex > 0 && calls.slice(0, successIndex).some((call) => call.status !== "success");
  const withinLimit = successIndex !== -1 && calls.length <= criterion.maxAttempts;
  const passed = sawEarlierFailure && withinLimit && answerOk;
  let detail = "Recovered after a fault and the answer matched.";
  if (!sawEarlierFailure) detail = "No injected tool failure was followed by a successful call.";
  else if (!withinLimit) detail = `Successful call was not within ${criterion.maxAttempts} attempts.`;
  else if (!answerOk) detail = "A later tool call succeeded, but the answer criteria failed. The agent's own recovery claim was not used.";
  return { type: "recovery", passed, detail };
}

function expectsStructure(task: TaskCase): boolean {
  return task.criteria.some((criterion) => criterion.type !== "tool_sequence" && criterion.type !== "max_tool_calls");
}

function failedDetails(results: CriterionResult[]): string {
  return results
    .filter((result) => !result.passed)
    .map((result) => result.detail)
    .join("; ");
}
