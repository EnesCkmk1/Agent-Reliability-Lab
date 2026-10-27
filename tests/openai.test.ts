import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModelPrompt, createOpenAIAdapter } from "../src/agents/openai.ts";
import { createToolEnvironment } from "../src/tools/environment.ts";
import type { AgentTaskView } from "../src/types.ts";

const view: AgentTaskView = {
  id: "task-1",
  category: "tool_selection",
  difficulty: "easy",
  title: "lookup",
  prompt: "Return the balance.",
  input: { customerId: "C-1" },
  visibleContext: { catalog: "synthetic-customers" },
  synthetic: true,
  datasetVersion: "synthetic-v1",
  scenarioType: "baseline",
};

test("the model prompt contains only the visible task", () => {
  const prompt = buildModelPrompt(view);
  assert.match(prompt, /C-1/);
  assert.doesNotMatch(prompt, /hidden-balance-9912/);
  assert.doesNotMatch(prompt, /expectedOutput/);
});

test("token cost is calculated only when usage and a price card exist", async () => {
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer sk-test-secret");
    return new Response(
      JSON.stringify({
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        choices: [{ message: { role: "assistant", content: "{\"balanceUsd\":12.5}" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const adapter = createOpenAIAdapter({
    apiKey: "sk-test-secret",
    model: "gpt-test",
    fetchImpl,
    priceCard: [{ model: "gpt-test", inputUsdPerMillion: 1, outputUsdPerMillion: 2 }],
  });
  const tools = createToolEnvironment({
    hiddenContext: { records: [{ id: "C-1", balanceUsd: 9912.12 }] },
    faults: [],
    limits: { timeoutMs: 1000, toolTimeoutMs: 1000, maxToolCalls: 4, maxRetries: 1 },
    signal: new AbortController().signal,
  });
  const execution = await adapter.execute({ view, tools, limits: { timeoutMs: 1000, toolTimeoutMs: 1000, maxToolCalls: 4, maxRetries: 1 }, signal: new AbortController().signal });
  assert.equal(execution.tokenUsage?.totalTokens, 1500);
  assert.equal(execution.estimatedCostUsd, 0.002);
  assert.equal(execution.outputParsed, true);
  assert.doesNotMatch(bodies[0] ?? "", /9912.12/);
  assert.equal(adapter.capabilities.usesAnswerKey, false);
  assert.equal(adapter.capabilities.deterministic, false);
  assert.equal(adapter.publicConfig.priceCardConfigured, true);
  assert.doesNotMatch(JSON.stringify(adapter.publicConfig), /sk-test-secret/);
});

test("missing usage and provider errors do not invent cost or leak the key", async () => {
  const noUsage: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200 });
  const adapter = createOpenAIAdapter({ apiKey: "sk-test-secret", model: "gpt-test", fetchImpl: noUsage });
  const tools = createToolEnvironment({
    hiddenContext: {},
    faults: [],
    limits: { timeoutMs: 1000, toolTimeoutMs: 1000, maxToolCalls: 4, maxRetries: 1 },
    signal: new AbortController().signal,
  });
  const limits = { timeoutMs: 1000, toolTimeoutMs: 1000, maxToolCalls: 4, maxRetries: 1 };
  const missing = await adapter.execute({ view, tools, limits, signal: new AbortController().signal });
  assert.equal(missing.tokenUsage, null);
  assert.equal(missing.estimatedCostUsd, null);

  const denied: typeof fetch = async () => new Response("invalid key sk-test-secret", { status: 401 });
  const failing = createOpenAIAdapter({ apiKey: "sk-test-secret", model: "gpt-test", fetchImpl: denied });
  const error = await failing.execute({ view, tools, limits, signal: new AbortController().signal });
  assert.equal(error.terminationReason, "infrastructure_error");
  assert.equal(error.estimatedCostUsd, null);
  assert.doesNotMatch(error.error?.message ?? "", /sk-test-secret/);
});
