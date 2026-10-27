#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpenAIAdapter, type OpenAIAdapterOptions } from "./agents/openai.ts";
import { createScriptedAdapter } from "./agents/scripted.ts";
import type { AgentAdapter } from "./agents/types.ts";
import { DEFAULT_THRESHOLDS, compareRuns } from "./compare/compare.ts";
import { generateDataset } from "./dataset/generate.ts";
import { DatasetValidationError, datasetChecksum, readDatasetFile, writeDatasetFile } from "./dataset/io.ts";
import { DEFAULT_LIMITS, executeBenchmark } from "./engine/run.ts";
import { formatRate } from "./metrics/calculate.ts";
import { METRIC_DEFINITIONS } from "./metrics/definitions.ts";
import { readGitCommit } from "./repro.ts";
import { jsonReport, markdownReport } from "./reporting/report.ts";
import { stressFaults } from "./scenarios/apply.ts";
import { validateDataset, validateFaultList, validateProfile, validateThresholds } from "./schema/validate.ts";
import { startServer } from "./server.ts";
import { RunStore } from "./storage/runs.ts";
import type { AnswerKey, FaultSpec, PriceCardEntry, ScenarioConfig, ScriptedProfile } from "./types.ts";
import { DATASET_VERSION } from "./version.ts";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_REGRESSION = 2;
export const EXIT_RUNTIME = 3;
export const EXIT_INTERRUPTED = 4;

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const HELP = `Agent Reliability Lab

Deterministic benchmarks run offline. Synthetic results are not real-world performance.

Usage
  arl dataset generate --seed <n> --count <n> --out <file>
  arl dataset validate <file>
  arl dataset inspect <file> --id <task-id>
  arl dataset export <file> --format json|jsonl --out <file>
  arl dataset import <file> --out <file>
  arl run --dataset <file> [--agent scripted|openai] [--profile <file>]
          [--scenario baseline|fault|stress] [--faults <file>] [--seed <n>]
          [--data <dir>] [--timeout-ms <n>] [--json]
  arl runs list [--data <dir>]
  arl runs show <run-id> [--data <dir>]
  arl compare <baseline-id> <candidate-id> [--thresholds <file>] [--data <dir>]
          [--declare-despite-small-sample]
  arl report <run-id> --format md|json [--out <file>] [--data <dir>]
  arl rerun <run-id> [--data <dir>] [--allow-dataset-drift]
  arl serve [--port 4317] [--data <dir>]
  arl metrics

Exit codes
  0  success
  1  usage or validation error
  2  regression beyond the configured thresholds
  3  runtime error
  4  run interrupted; partial results were kept and not marked successful

The default agent is the scripted test double. It needs no API key.
OpenAI-compatible runs read ARL_OPENAI_API_KEY, ARL_OPENAI_MODEL, and optional ARL_OPENAI_BASE_URL.
Cost stays unavailable unless a price card is passed with --price-card.
`;

export async function main(argv: string[], io: CliIO = defaultIo()): Promise<number> {
  const parsed = parseArgv(argv);
  const [group, action] = parsed.command;
  try {
    if (!group || group === "help" || parsed.flags.has("help")) {
      io.stdout(HELP);
      return EXIT_OK;
    }
    if (group === "metrics") {
      for (const definition of METRIC_DEFINITIONS) {
        io.stdout(`${definition.name}\n  numerator: ${definition.numerator}\n  denominator: ${definition.denominator}\n  exclusions: ${definition.exclusions}\n  aggregation: ${definition.aggregation}\n`);
      }
      return EXIT_OK;
    }
    if (group === "dataset") return await datasetCommand(action, parsed, io);
    if (group === "run") return await runCommand(parsed, io);
    if (group === "runs") return await runsCommand(action, parsed, io);
    if (group === "compare") return await compareCommand(parsed, io);
    if (group === "report") return await reportCommand(parsed, io);
    if (group === "rerun") return await rerunCommand(parsed, io);
    if (group === "serve") return await serveCommand(parsed, io);
    io.stderr(`Unknown command "${group}". Run arl help.\n`);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof DatasetValidationError || error instanceof SyntaxError) {
      io.stderr(`${error.message}\n`);
      return EXIT_USAGE;
    }
    io.stderr(`${error instanceof Error ? error.message : "Unexpected error"}\n`);
    return EXIT_RUNTIME;
  }
}

class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = EXIT_USAGE) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

async function datasetCommand(action: string | undefined, parsed: Parsed, io: CliIO): Promise<number> {
  if (action === "generate") {
    const seed = requiredInt(parsed, "seed");
    const count = requiredInt(parsed, "count");
    const out = requiredFlag(parsed, "out");
    const version = stringFlag(parsed, "version") ?? DATASET_VERSION;
    let dataset;
    try {
      dataset = generateDataset({ seed, count, version });
    } catch (error) {
      throw new CliError(error instanceof Error ? error.message : "Could not generate the dataset.");
    }
    await writeDatasetFile(resolve(io.cwd, out), dataset);
    io.stdout(`${dataset.label}\nWrote ${dataset.count} cases to ${out}\nversion ${dataset.version}\nseed ${dataset.seed}\nchecksum ${datasetChecksum(dataset)}\n`);
    return EXIT_OK;
  }
  if (action === "validate") {
    const file = requiredPositional(parsed, 0, "dataset file");
    const text = await readFile(resolve(io.cwd, file), "utf8");
    const { parseJsonl } = await import("./dataset/io.ts");
    const parsedJson = file.endsWith(".jsonl") ? parseJsonl(text) : JSON.parse(text);
    const result = validateDataset(parsedJson);
    if (!result.ok) {
      io.stderr(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n") + "\n");
      return EXIT_USAGE;
    }
    io.stdout(`Valid ${result.dataset.origin} dataset\n${result.dataset.label}\ncases ${result.dataset.count}\nchecksum ${datasetChecksum(result.dataset)}\n`);
    return EXIT_OK;
  }
  if (action === "inspect") {
    const file = requiredPositional(parsed, 0, "dataset file");
    const id = requiredFlag(parsed, "id");
    const dataset = await readDatasetFile(resolve(io.cwd, file));
    const task = dataset.cases.find((item) => item.id === id);
    if (!task) throw new CliError(`No task with id ${id}.`);
    io.stdout(`${JSON.stringify(task, null, 2)}\n`);
    return EXIT_OK;
  }
  if (action === "export" || action === "import") {
    const file = requiredPositional(parsed, 0, "dataset file");
    const out = requiredFlag(parsed, "out");
    const format = stringFlag(parsed, "format") === "jsonl" || out.endsWith(".jsonl") ? "jsonl" : "json";
    const dataset = await readDatasetFile(resolve(io.cwd, file));
    await writeDatasetFile(resolve(io.cwd, out), dataset, format);
    io.stdout(`${dataset.label}\nWrote ${format} dataset with ${dataset.count} cases.\nchecksum ${datasetChecksum(dataset)}\n`);
    return EXIT_OK;
  }
  throw new CliError("Usage: arl dataset generate|validate|inspect|export|import");
}

async function runCommand(parsed: Parsed, io: CliIO, reuse?: { datasetPath: string; scenario: ScenarioConfig; agentName: "scripted" | "openai"; profile?: ScriptedProfile; seed: number; limits: typeof DEFAULT_LIMITS; temperature?: number }): Promise<number> {
  const datasetPath = reuse?.datasetPath ?? requiredFlag(parsed, "dataset");
  const absoluteDataset = resolve(io.cwd, datasetPath);
  const dataset = await readDatasetFile(absoluteDataset);
  const agentName = (reuse?.agentName ?? stringFlag(parsed, "agent") ?? "scripted") as "scripted" | "openai";
  if (agentName !== "scripted" && agentName !== "openai") throw new CliError("--agent must be scripted or openai.");
  const profile = reuse?.profile ?? (agentName === "scripted" ? await loadProfile(parsed, io) : undefined);
  const seed = reuse?.seed ?? (parsed.flags.has("seed") ? requiredInt(parsed, "seed") : 1);
  const requestedMode = stringFlag(parsed, "scenario") ?? "baseline";
  if (!reuse && !["baseline", "fault", "stress"].includes(requestedMode)) {
    throw new CliError("--scenario must be baseline, fault, or stress.");
  }
  const faults = reuse ? reuse.scenario.faults : await loadFaults(parsed, io);
  const scenario: ScenarioConfig = reuse?.scenario ?? {
    mode: requestedMode === "fault" ? "fault_injection" : (requestedMode as ScenarioConfig["mode"]),
    seed,
    faults: requestedMode === "stress" ? stressFaults(seed) : faults,
    evaluationClass: requestedMode === "stress" ? "seeded_stress" : "deterministic",
  };
  const limits = reuse?.limits ?? {
    timeoutMs: numberFlag(parsed, "timeout-ms") ?? DEFAULT_LIMITS.timeoutMs,
    toolTimeoutMs: numberFlag(parsed, "tool-timeout-ms") ?? DEFAULT_LIMITS.toolTimeoutMs,
    maxToolCalls: numberFlag(parsed, "max-tool-calls") ?? DEFAULT_LIMITS.maxToolCalls,
    maxRetries: numberFlag(parsed, "max-retries") ?? DEFAULT_LIMITS.maxRetries,
  };
  const adapter = await buildAdapter(agentName, profile, parsed, io, reuse?.temperature);
  const store = new RunStore(resolve(io.cwd, stringFlag(parsed, "data") ?? ".arl"));
  const gitCommit = await readGitCommit(io.cwd);
  const controller = new AbortController();
  const onSigint = () => controller.abort("interrupted");
  process.on("SIGINT", onSigint);
  let run;
  try {
    run = await executeBenchmark({
      dataset,
      datasetPath,
      adapter,
      scenario,
      seed,
      limits,
      signal: controller.signal,
      gitCommit,
      onUpdate: (current) => store.save(current),
    });
  } finally {
    process.off("SIGINT", onSigint);
  }
  const metrics = run.metrics;
  if (parsed.flags.has("json")) io.stdout(`${JSON.stringify(jsonReport(run), null, 2)}\n`);
  else if (metrics) {
    io.stdout(
      [
        run.dataset.label,
        run.interpretation.note,
        `Run ${run.id} ${run.status}`,
        `Dataset ${run.dataset.version} checksum ${run.dataset.checksum}`,
        `Agent ${run.agent.name} ${run.agent.version} model ${run.agent.model ?? "n/a"} answer-key ${run.agent.usesAnswerKey ? "yes" : "no"}`,
        `Scenario ${run.scenario.mode} class ${run.scenario.evaluationClass} seed ${run.scenario.seed}`,
        `Success ${formatRate(metrics.taskSuccessRate)}`,
        `Exact match ${formatRate(metrics.exactMatchAccuracy)}`,
        `Schema ${formatRate(metrics.schemaComplianceRate)}`,
        `Tool calls ${formatRate(metrics.toolCallSuccessRate)}`,
        `Recovery ${formatRate(metrics.recoverySuccessRate)}`,
        `Timeouts ${formatRate(metrics.timeoutRate)}`,
        `Median latency ${metrics.latencyMs.median === null ? "unavailable" : `${metrics.latencyMs.median.toFixed(1)} ms`} (n=${metrics.latencyMs.sampleSize})`,
        `p95 latency ${metrics.latencyMs.p95 === null ? "unavailable" : `${metrics.latencyMs.p95.toFixed(1)} ms`}`,
        `Tokens ${metrics.tokenUsage.recordedTotalTokens === null ? "unavailable" : metrics.tokenUsage.recordedTotalTokens} (missing ${metrics.tokenUsage.tasksMissingUsage})`,
        `Estimated cost USD ${metrics.estimatedCostUsd.recordedTotalUsd === null ? "unavailable" : metrics.estimatedCostUsd.recordedTotalUsd}`,
        metrics.sample.smallSample ? `Warning: only ${metrics.sample.evaluated} evaluated tasks, below ${metrics.sample.minSampleSize}.` : "",
        metrics.warnings.length ? `Warnings: ${metrics.warnings.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
  }
  if (run.status === "interrupted") return EXIT_INTERRUPTED;
  return EXIT_OK;
}

async function runsCommand(action: string | undefined, parsed: Parsed, io: CliIO): Promise<number> {
  const store = new RunStore(resolve(io.cwd, stringFlag(parsed, "data") ?? ".arl"));
  if (action === "list") {
    const runs = await store.list();
    if (runs.length === 0) {
      io.stdout("No runs stored.\n");
      return EXIT_OK;
    }
    for (const run of runs) {
      const rate = run.metrics ? formatRate(run.metrics.taskSuccessRate) : "n/a";
      io.stdout(`${run.id}  ${run.status}  ${run.agent.name}  ${run.dataset.version}  success ${rate}  synthetic ${run.dataset.synthetic}\n`);
    }
    return EXIT_OK;
  }
  if (action === "show") {
    const id = requiredPositional(parsed, 0, "run id");
    const run = await store.get(id);
    if (!run) throw new CliError(`No run ${id}.`);
    io.stdout(`${JSON.stringify(run, null, 2)}\n`);
    return EXIT_OK;
  }
  throw new CliError("Usage: arl runs list|show <run-id>");
}

async function compareCommand(parsed: Parsed, io: CliIO): Promise<number> {
  const baselineId = requiredPositional(parsed, 0, "baseline run id");
  const candidateId = requiredPositional(parsed, 1, "candidate run id");
  const store = new RunStore(resolve(io.cwd, stringFlag(parsed, "data") ?? ".arl"));
  const baseline = await store.get(baselineId);
  const candidate = await store.get(candidateId);
  if (!baseline || !candidate) throw new CliError("Both run ids must exist in the data directory.");
  const thresholds = parsed.flags.has("thresholds")
    ? await readThresholds(resolve(io.cwd, requiredFlag(parsed, "thresholds")))
    : DEFAULT_THRESHOLDS;
  const report = compareRuns(baseline, candidate, thresholds, {
    declareDespiteSmallSample: parsed.flags.has("declare-despite-small-sample"),
  });
  io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  if (report.regression.warnings.length) io.stderr(report.regression.warnings.join("\n") + "\n");
  return report.regression.declared ? EXIT_REGRESSION : EXIT_OK;
}

async function reportCommand(parsed: Parsed, io: CliIO): Promise<number> {
  const id = requiredPositional(parsed, 0, "run id");
  const format = stringFlag(parsed, "format") ?? "md";
  if (format !== "md" && format !== "json") throw new CliError("--format must be md or json.");
  const store = new RunStore(resolve(io.cwd, stringFlag(parsed, "data") ?? ".arl"));
  const run = await store.get(id);
  if (!run) throw new CliError(`No run ${id}.`);
  const body = format === "json" ? `${JSON.stringify(jsonReport(run), null, 2)}\n` : markdownReport(run);
  const out = stringFlag(parsed, "out");
  if (out) await writeFile(resolve(io.cwd, out), body, "utf8");
  else io.stdout(body);
  return EXIT_OK;
}

async function rerunCommand(parsed: Parsed, io: CliIO): Promise<number> {
  const id = requiredPositional(parsed, 0, "run id");
  const store = new RunStore(resolve(io.cwd, stringFlag(parsed, "data") ?? ".arl"));
  const previous = await store.get(id);
  if (!previous) throw new CliError(`No run ${id}.`);
  const dataset = await readDatasetFile(resolve(io.cwd, previous.dataset.path));
  const checksum = datasetChecksum(dataset);
  if (checksum !== previous.dataset.checksum && !parsed.flags.has("allow-dataset-drift")) {
    throw new CliError(
      `Dataset checksum changed for ${previous.dataset.path}. Refusing to rerun. Pass --allow-dataset-drift to continue anyway.`,
    );
  }
  io.stderr(
    "Rerunning the stored configuration. For a live model, an identical configuration does not guarantee identical output.\n",
  );
  const profile = previous.agent.name === "scripted" ? profileFromConfig(previous.agent.config) : undefined;
  const nested: Parsed = {
    command: ["run"],
    flags: new Map(parsed.flags),
    positionals: [],
  };
  nested.flags.set("dataset", previous.dataset.path);
  nested.flags.set("agent", previous.agent.name);
  return runCommand(nested, io, {
    datasetPath: previous.dataset.path,
    scenario: previous.scenario,
    agentName: previous.agent.name === "openai" ? "openai" : "scripted",
    profile,
    seed: previous.seed,
    limits: previous.limits,
    temperature: typeof previous.agent.config.temperature === "number" ? previous.agent.config.temperature : undefined,
  });
}

async function serveCommand(parsed: Parsed, io: CliIO): Promise<number> {
  const port = numberFlag(parsed, "port") ?? 4317;
  const dataDir = resolve(io.cwd, stringFlag(parsed, "data") ?? ".arl");
  const server = await startServer({ port, host: "127.0.0.1", dataDir, roots: [io.cwd] });
  io.stdout(`Agent Reliability Lab dashboard at ${server.url}\nSynthetic results are not real-world performance.\n`);
  await new Promise(() => {});
  return EXIT_OK;
}

async function buildAdapter(
  agentName: "scripted" | "openai",
  profile: ScriptedProfile | undefined,
  parsed: Parsed,
  io: CliIO,
  temperature?: number,
): Promise<AgentAdapter> {
  if (agentName === "scripted") {
    const dataset = await readDatasetFile(resolve(io.cwd, requiredFlag(parsed, "dataset")));
    const answers = new Map<string, AnswerKey>(
      dataset.cases.map((task) => [
        task.id,
        {
          expectedOutput: task.expectedOutput,
          expectedToolCalls: task.expectedToolCalls,
          expectedRecovery: task.expectedRecovery,
          category: task.category,
        },
      ]),
    );
    return createScriptedAdapter(profile ?? { name: "correct", defaultBehavior: "correct" }, answers);
  }
  const apiKey = io.env.ARL_OPENAI_API_KEY;
  if (!apiKey) throw new CliError("ARL_OPENAI_API_KEY is not set. The scripted agent runs without a key.");
  const model = stringFlag(parsed, "model") ?? io.env.ARL_OPENAI_MODEL;
  if (!model) throw new CliError("Set ARL_OPENAI_MODEL or pass --model. No default model is assumed.");
  const priceCard = parsed.flags.has("price-card") ? await readPriceCard(resolve(io.cwd, requiredFlag(parsed, "price-card"))) : undefined;
  const options: OpenAIAdapterOptions = {
    apiKey,
    model,
    baseUrl: io.env.ARL_OPENAI_BASE_URL,
    temperature: temperature ?? (parsed.flags.has("temperature") ? requiredNumber(parsed, "temperature") : undefined),
    priceCard,
  };
  return createOpenAIAdapter(options);
}

async function loadProfile(parsed: Parsed, io: CliIO): Promise<ScriptedProfile> {
  const path = stringFlag(parsed, "profile");
  if (!path) return { name: "correct", defaultBehavior: "correct" };
  const raw = JSON.parse(await readFile(resolve(io.cwd, path), "utf8")) as unknown;
  const result = validateProfile(raw);
  if (!result.ok) throw new CliError(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  return result.profile;
}

async function loadFaults(parsed: Parsed, io: CliIO): Promise<FaultSpec[]> {
  const path = stringFlag(parsed, "faults");
  if (!path) return [];
  const raw = JSON.parse(await readFile(resolve(io.cwd, path), "utf8")) as unknown;
  const result = validateFaultList(raw);
  if (!result.ok) throw new CliError(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  return result.faults;
}

function profileFromConfig(config: Record<string, unknown>): ScriptedProfile {
  const profile = {
    name: typeof config.profile === "string" ? config.profile : "rerun",
    defaultBehavior: config.defaultBehavior,
    byCategory: config.byCategory,
    byTaskId: config.byTaskId,
    latencyMs: config.latencyMs,
  };
  const result = validateProfile(profile);
  if (!result.ok) throw new CliError("Stored scripted profile is invalid and cannot be rerun.");
  return result.profile;
}

async function readThresholds(path: string) {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const result = validateThresholds(raw);
  if (!result.ok) throw new CliError(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  return result.thresholds;
}

async function readPriceCard(path: string): Promise<PriceCardEntry[]> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new CliError("Price card must be an array.");
  return raw.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as PriceCardEntry).model !== "string" ||
      typeof (entry as PriceCardEntry).inputUsdPerMillion !== "number" ||
      typeof (entry as PriceCardEntry).outputUsdPerMillion !== "number"
    ) {
      throw new CliError("Each price-card entry needs model, inputUsdPerMillion, and outputUsdPerMillion.");
    }
    return entry as PriceCardEntry;
  });
}

interface Parsed {
  command: string[];
  flags: Map<string, string | true>;
  positionals: string[];
}

const SUBCOMMANDS = new Set(["dataset", "runs"]);

function parseArgv(argv: string[]): Parsed {
  const command: string[] = [];
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) flags.set(token.slice(2, eq), token.slice(eq + 1));
      else {
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(key, next);
          index += 1;
        } else flags.set(key, true);
      }
    } else if (command.length === 0 || (command.length === 1 && SUBCOMMANDS.has(command[0] ?? ""))) {
      command.push(token);
    } else positionals.push(token);
  }
  return { command, flags, positionals };
}

function requiredFlag(parsed: Parsed, name: string): string {
  const value = parsed.flags.get(name);
  if (typeof value !== "string" || value.length === 0) throw new CliError(`Missing --${name}.`);
  return value;
}

function stringFlag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredInt(parsed: Parsed, name: string): number {
  const value = Number(requiredFlag(parsed, name));
  if (!Number.isInteger(value)) throw new CliError(`--${name} must be an integer.`);
  return value;
}

function numberFlag(parsed: Parsed, name: string): number | undefined {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new CliError(`--${name} must be a number.`);
  return value;
}

function requiredNumber(parsed: Parsed, name: string): number {
  const value = numberFlag(parsed, name);
  if (value === undefined) throw new CliError(`Missing --${name}.`);
  return value;
}

function requiredPositional(parsed: Parsed, index: number, label: string): string {
  const value = parsed.positionals[index];
  if (!value) throw new CliError(`Missing ${label}.`);
  return value;
}

function defaultIo(): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
