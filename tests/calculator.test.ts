import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateArithmetic } from "../src/tools/calculator.ts";

test("calculator evaluates arithmetic and rejects code", () => {
  assert.equal(evaluateArithmetic("4*6-5"), 19);
  assert.equal(evaluateArithmetic("(2+3)*4"), 20);
  assert.equal(evaluateArithmetic("-3+5"), 2);
  assert.throws(() => evaluateArithmetic("process.exit()"), /unsupported/);
  assert.throws(() => evaluateArithmetic("1/0"), /division/);
});
