import { isAbortError, isPlainObject, sleep } from "../util.ts";
import type { AgentAdapter, AgentRequest } from "./types.ts";
import type {
  AgentExecution,
  AnswerKey,
  ExpectedToolCall,
  ScriptedBehavior,
  ScriptedProfile,
  TaskCategory,
} from "../types.ts";

export function createScriptedAdapter(
  profile: ScriptedProfile,
  answers: ReadonlyMap<string, AnswerKey>,
): AgentAdapter {
  return {
    name: "scripted",
    version: "scripted-1",
    model: null,
    provider: null,
    capabilities: { usesAnswerKey: true, deterministic: true },
    promptTemplateVersion: null,
    promptTemplateSha256: null,
    publicConfig: {
      profile: profile.name,
      defaultBehavior: profile.defaultBehavior,
      byCategory: profile.byCategory ?? {},
      byTaskId: profile.byTaskId ?? {},
      latencyMs: profile.latencyMs ?? 0,
      answerKeyAccess: true,
    },
    async execute(request) {
      const startedAt = new Date().toISOString();
      const behavior = resolveBehavior(profile, request.view.id, request.view.category);
      const answer = answers.get(request.view.id) ?? null;
      try {
        if ((profile.latencyMs ?? 0) > 0) await sleep(profile.latencyMs ?? 0, request.signal);
        if (behavior === "tool_timeout") {
          await performCalls("correct", request, answer);
          return done(startedAt, behavior, {
            terminationReason: "timeout",
            error: { code: "timeout", message: "Scripted behavior tool_timeout ended the task before an answer." },
          });
        }
        if (behavior === "tool_failure") {
          await performCalls("correct", request, answer);
          return done(startedAt, behavior, {
            terminationReason: "error",
            error: { code: "tool_failure", message: "Scripted behavior tool_failure stopped without an answer." },
          });
        }
        if (behavior === "invalid_json") {
          await performCalls("correct", request, answer);
          return done(startedAt, behavior, {
            terminationReason: "completed",
            outputText: "{not-json",
            output: null,
            outputParsed: false,
            parseError: "Output was not valid JSON.",
          });
        }
        if (behavior === "fail_to_recover") {
          await performCalls(behavior, request, answer);
          return done(startedAt, behavior, {
            terminationReason: "retry_limit",
            output: { recovered: true },
            outputParsed: true,
            error: { code: "retry_limit", message: "Scripted agent stopped at the retry limit and claimed recovery." },
          });
        }
        await performCalls(behavior, request, answer);
        const output = outputFor(behavior, request.view.category, answer);
        return done(startedAt, behavior, {
          terminationReason: "completed",
          output,
          outputParsed: true,
          outputText: JSON.stringify(output),
        });
      } catch (error) {
        if (isAbortError(error) || request.signal.aborted) {
          const interrupted = request.signal.reason === "interrupted";
          return done(startedAt, behavior, {
            terminationReason: interrupted ? "incomplete" : "timeout",
            error: {
              code: interrupted ? "interrupted" : "timeout",
              message: interrupted ? "The run was interrupted." : "Execution exceeded the timeout.",
            },
          });
        }
        return done(startedAt, behavior, {
          terminationReason: "infrastructure_error",
          error: { code: "scripted_error", message: error instanceof Error ? error.message : "Scripted adapter failed." },
        });
      }
    },
  };
}

export function resolveBehavior(profile: ScriptedProfile, taskId: string, category: TaskCategory): ScriptedBehavior {
  return profile.byTaskId?.[taskId] ?? profile.byCategory?.[category] ?? profile.defaultBehavior;
}

async function performCalls(behavior: ScriptedBehavior, request: AgentRequest, answer: AnswerKey | null): Promise<void> {
  const calls = answer?.expectedToolCalls ?? [];
  if (behavior === "incorrect_tool") {
    await request.tools.call("shell", { command: "noop" });
    return;
  }
  if (calls.length === 0) return;
  if (behavior === "repeated_tool_calls") {
    const first = calls[0]!;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request.tools.call(first.tool, first.arguments);
    }
    return;
  }
  if (behavior === "fail_to_recover") {
    const first = calls[0]!;
    const max = answer?.expectedRecovery?.maxAttempts ?? request.limits.maxRetries + 1;
    for (let attempt = 0; attempt < max; attempt += 1) {
      await request.tools.call(first.tool, first.arguments);
    }
    return;
  }
  for (const call of calls) {
    await callWithRecovery(call, request, answer, behavior);
  }
}

async function callWithRecovery(
  call: ExpectedToolCall,
  request: AgentRequest,
  answer: AnswerKey | null,
  behavior: ScriptedBehavior,
): Promise<void> {
  const recovery = answer?.expectedRecovery;
  const retries = behavior === "correct" || behavior === "recover_after_transient";
  const max = retries && recovery && recovery.tool === call.tool ? recovery.maxAttempts : 1;
  for (let attempt = 0; attempt < max; attempt += 1) {
    const record = await request.tools.call(call.tool, call.arguments);
    if (record.status === "success") return;
    if (record.status === "timeout" || record.error === "malformed_tool_response") return;
    if (record.error === "retry_limit" || record.error === "tool_call_limit") return;
  }
}

function outputFor(behavior: ScriptedBehavior, category: TaskCategory, answer: AnswerKey | null): unknown {
  const expected = answer?.expectedOutput;
  if (behavior === "correct" || behavior === "recover_after_transient" || behavior === "repeated_tool_calls") {
    return expected ?? null;
  }
  if (behavior === "missing_fields") {
    if (!isPlainObject(expected)) return {};
    const clone = { ...expected };
    const key = Object.keys(clone)[0];
    if (key) delete clone[key];
    return clone;
  }
  if (behavior === "incorrect" || behavior === "incorrect_tool") {
    if (category === "prompt_injection_resistance") return { badgeColor: "PWNED" };
    if (category === "missing_or_contradictory") {
      return { status: "active", field: "subscriptionStatus", sources: ["billing-export"] };
    }
    if (isPlainObject(expected) && typeof expected.intact === "number") return { intact: expected.intact + 1 };
    if (isPlainObject(expected) && typeof expected.balanceUsd === "number") return { balanceUsd: expected.balanceUsd + 1 };
    if (isPlainObject(expected)) return { ...expected, wrong: true };
    return { wrong: true };
  }
  return { wrong: true };
}

function done(
  startedAt: string,
  behavior: ScriptedBehavior,
  partial: Partial<AgentExecution> & Pick<AgentExecution, "terminationReason">,
): AgentExecution {
  return {
    outputText: partial.outputText ?? (partial.output === undefined ? null : JSON.stringify(partial.output ?? null)),
    output: partial.output ?? null,
    outputParsed: partial.outputParsed ?? false,
    parseError: partial.parseError ?? null,
    startedAt,
    endedAt: new Date().toISOString(),
    tokenUsage: null,
    estimatedCostUsd: null,
    error: partial.error ?? null,
    terminationReason: partial.terminationReason,
    metadata: { behavior, adapter: "scripted", answerKeyAccess: true },
  };
}
