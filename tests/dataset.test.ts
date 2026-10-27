import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDataset } from "../src/dataset/generate.ts";
import { datasetChecksum, parseJsonl, serializeDataset, serializeDatasetJsonl } from "../src/dataset/io.ts";
import { validateDataset } from "../src/schema/validate.ts";
import { SYNTHETIC_LABEL } from "../src/version.ts";

test("the same seed and count reproduce the same dataset", () => {
  const left = generateDataset({ seed: 20261027, count: 22 });
  const right = generateDataset({ seed: 20261027, count: 22 });
  assert.equal(serializeDataset(left), serializeDataset(right));
  assert.equal(datasetChecksum(left), datasetChecksum(right));
});

test("a different seed changes the cases", () => {
  const left = generateDataset({ seed: 1, count: 11 });
  const right = generateDataset({ seed: 2, count: 11 });
  assert.notEqual(datasetChecksum(left), datasetChecksum(right));
});

test("generated cases carry synthetic provenance", () => {
  const dataset = generateDataset({ seed: 7, count: 11 });
  const result = validateDataset(dataset);
  assert.equal(result.ok, true);
  assert.equal(dataset.synthetic, true);
  assert.equal(dataset.label, SYNTHETIC_LABEL);
  assert.equal(dataset.cases.length, 11);
  for (const task of dataset.cases) {
    assert.equal(task.synthetic, true);
    assert.equal(task.origin, "synthetic");
    assert.match(task.title, /synthetic/i);
    assert.match(task.generation.label, /synthetic/i);
    assert.equal(task.generation.datasetSeed, 7);
    assert.ok(task.criteria.length > 0);
  }
});

test("category round-robin is stable for the baseline seed", () => {
  const dataset = generateDataset({ seed: 20261027, count: 22 });
  assert.equal(dataset.cases[6]?.category, "retry_recovery");
  assert.equal(dataset.cases[6]?.id, "syn-synthetic-v1-20261027-0006");
  assert.equal(dataset.cases[17]?.id, "syn-synthetic-v1-20261027-0017");
  assert.equal(dataset.cases[6]?.faults[0]?.kind, "error_on_first_call");
  assert.equal(dataset.cases[10]?.category, "error_handling");
  assert.equal(dataset.cases[10]?.faults[0]?.kind, "malformed");
});

test("jsonl export and import keep the cases", () => {
  const dataset = generateDataset({ seed: 9, count: 3 });
  const parsed = parseJsonl(serializeDatasetJsonl(dataset));
  const result = validateDataset(parsed);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(datasetChecksum(result.dataset), datasetChecksum(dataset));
});

test("generation rejects a non-integer seed and an oversized count", () => {
  assert.throws(() => generateDataset({ seed: 1.5, count: 1 }), /seed/);
  assert.throws(() => generateDataset({ seed: 1, count: 0 }), /count/);
});
