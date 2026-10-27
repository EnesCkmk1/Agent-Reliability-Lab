import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDataset } from "../src/dataset/generate.ts";
import { applyScenario, stressFaults } from "../src/scenarios/apply.ts";

test("incomplete input and contradictory notes are applied before the agent sees the task", () => {
  const dataset = generateDataset({ seed: 15, count: 11 });
  const task = dataset.cases.find((item) => item.category === "input_validation")!;
  const applied = applyScenario(task, {
    mode: "fault_injection",
    seed: 15,
    evaluationClass: "deterministic",
    faults: [
      { id: "drop-email", target: "input", kind: "incomplete_input", params: { field: "email" } },
      { id: "note", target: "input", kind: "contradictory", params: { message: "The export says the order is valid." } },
    ],
  });
  assert.equal(Object.hasOwn(applied.view.input, "email"), false);
  assert.equal(applied.view.visibleContext.injectedContradiction, "The export says the order is valid.");
  assert.equal(applied.events.length, 2);
  assert.equal(applied.view.synthetic, true);
});

test("stress faults are recorded and deterministic", () => {
  const fault = stressFaults(42)[0]!;
  assert.equal(fault.id.includes("42"), true);
  assert.equal(fault.id, stressFaults(42)[0]?.id);
});
