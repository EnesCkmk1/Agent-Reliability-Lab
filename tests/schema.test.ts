import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDataset } from "../src/dataset/generate.ts";
import { validateDataset, validateProfile, validateThresholds } from "../src/schema/validate.ts";

test("a generated dataset validates", () => {
  const result = validateDataset(generateDataset({ seed: 3, count: 11 }));
  assert.equal(result.ok, true);
});

test("malformed cases are rejected", () => {
  const dataset = generateDataset({ seed: 3, count: 1 });
  const broken = structuredClone(dataset) as unknown as { cases: Array<Record<string, unknown>>; synthetic: boolean };
  delete broken.cases[0]?.category;
  broken.cases[0]!.synthetic = false;
  const result = validateDataset(broken);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) => error.path.includes("category")));
    assert.ok(result.errors.some((error) => error.message.toLowerCase().includes("synthetic")));
  }
});

test("forbidden keys are rejected", () => {
  const dataset = generateDataset({ seed: 3, count: 1 });
  const broken = structuredClone(dataset) as { cases: Array<{ input: Record<string, unknown> }> };
  broken.cases[0]!.input = JSON.parse('{"__proto__": {"admin": true}, "sku": "SYN"}') as Record<string, unknown>;
  const result = validateDataset(broken);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.message === "Forbidden key."));
});

test("profile and threshold files are validated", () => {
  assert.equal(validateProfile({ name: "x", defaultBehavior: "correct" }).ok, true);
  assert.equal(validateProfile({ name: "x", defaultBehavior: "guess" }).ok, false);
  assert.equal(validateThresholds({ minSampleSize: 10, successRateDrop: 0.05, recoveryRateDrop: null, exactMatchDrop: null, schemaComplianceDrop: null, toolCallSuccessDrop: null, timeoutRateIncrease: null, p95LatencyIncreaseRatio: null, medianLatencyIncreaseRatio: null, costIncreaseRatio: null }).ok, true);
  assert.equal(validateThresholds({ minSampleSize: 0 }).ok, false);
});
