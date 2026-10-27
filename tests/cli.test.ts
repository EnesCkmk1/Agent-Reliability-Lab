import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_OK, EXIT_REGRESSION, EXIT_USAGE, main } from "../src/cli.ts";
import { tempDir } from "./helpers.ts";

function io(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      env: {},
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

test("the offline CLI generates, validates, runs, reports, and detects a regression", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const capture = io(dir);
    assert.equal(await main(["dataset", "generate", "--seed", "20261027", "--count", "22", "--out", "baseline.json"], capture.io), EXIT_OK);
    assert.match(capture.stdout.join(""), /SYNTHETIC/);
    assert.equal(await main(["dataset", "validate", "baseline.json"], capture.io), EXIT_OK);
    const again = io(dir);
    assert.equal(await main(["dataset", "generate", "--seed", "20261027", "--count", "22", "--out", "baseline-again.json"], again.io), EXIT_OK);
    assert.equal(await readFile(join(dir, "baseline.json"), "utf8"), await readFile(join(dir, "baseline-again.json"), "utf8"));
    assert.equal(await main(["dataset", "inspect", "baseline.json", "--id", "missing"], capture.io), EXIT_USAGE);

    const correct = io(dir);
    assert.equal(
      await main(["run", "--dataset", "baseline.json", "--agent", "scripted", "--profile", join(process.cwd(), "fixtures/scripted-correct.json"), "--data", "runs"], correct.io),
      EXIT_OK,
    );
    assert.match(correct.stdout.join(""), /Success 22\/22/);
    const mixed = io(dir);
    assert.equal(
      await main(["run", "--dataset", "baseline.json", "--agent", "scripted", "--profile", join(process.cwd(), "fixtures/scripted-mixed.json"), "--data", "runs"], mixed.io),
      EXIT_OK,
    );
    const list = io(dir);
    assert.equal(await main(["runs", "list", "--data", "runs"], list.io), EXIT_OK);
    const ids = list.stdout.join("").trim().split("\n").map((line) => line.split(/\s+/)[0]!);
    assert.equal(ids.length, 2);
    const report = io(dir);
    assert.equal(await main(["report", ids[0]!, "--format", "md", "--out", "report.md", "--data", "runs"], report.io), EXIT_OK);
    const markdown = await readFile(join(dir, "report.md"), "utf8");
    assert.match(markdown, /SYNTHETIC/);
    assert.match(markdown, /Metric definitions/);
    const compared = io(dir);
    const code = await main(["compare", ids[1]!, ids[0]!, "--thresholds", join(process.cwd(), "fixtures/thresholds.json"), "--data", "runs"], compared.io);
    assert.equal(code, EXIT_REGRESSION);
    const rerun = io(dir);
    assert.equal(await main(["rerun", ids[1]!, "--data", "runs"], rerun.io), EXIT_OK);
    assert.match(rerun.stderr.join(""), /does not guarantee identical output/);
  } finally {
    await cleanup();
  }
});

test("openai mode fails clearly when no key is configured", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const capture = io(dir);
    await main(["dataset", "generate", "--seed", "1", "--count", "1", "--out", "one.json"], capture.io);
    const code = await main(["run", "--dataset", "one.json", "--agent", "openai", "--data", "runs"], capture.io);
    assert.equal(code, EXIT_USAGE);
    assert.match(capture.stderr.join(""), /ARL_OPENAI_API_KEY/);
    assert.doesNotMatch(capture.stderr.join("") + capture.stdout.join(""), /sk-/);
  } finally {
    await cleanup();
  }
});
