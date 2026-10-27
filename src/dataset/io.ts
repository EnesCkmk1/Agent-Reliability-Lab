import { readFile, writeFile } from "node:fs/promises";
import { canonicalStringify, isPlainObject, sha256 } from "../util.ts";
import type { Dataset } from "../types.ts";
import { validateDataset } from "../schema/validate.ts";

export function datasetChecksum(dataset: Dataset): string {
  return sha256(canonicalStringify(dataset));
}

export function serializeDataset(dataset: Dataset): string {
  return `${JSON.stringify(dataset, null, 2)}\n`;
}

export function serializeDatasetJsonl(dataset: Dataset): string {
  const { cases, ...header } = dataset;
  const lines = [JSON.stringify(header), ...cases.map((task) => JSON.stringify(task))];
  return `${lines.join("\n")}\n`;
}

export async function readDatasetFile(path: string): Promise<Dataset> {
  const text = await readFile(path, "utf8");
  const parsed = path.endsWith(".jsonl") ? parseJsonl(text) : JSON.parse(text);
  const result = validateDataset(parsed);
  if (!result.ok) {
    const detail = result.errors
      .slice(0, 20)
      .map((error) => `${error.path}: ${error.message}`)
      .join("\n");
    throw new DatasetValidationError(detail, result.errors.length);
  }
  return result.dataset;
}

export async function writeDatasetFile(path: string, dataset: Dataset, format: "json" | "jsonl" = "json"): Promise<void> {
  const body = format === "jsonl" ? serializeDatasetJsonl(dataset) : serializeDataset(dataset);
  await writeFile(path, body, "utf8");
}

export function parseJsonl(text: string): unknown {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("JSONL dataset is empty.");
  const header = JSON.parse(lines[0]!) as unknown;
  if (!isPlainObject(header)) throw new Error("JSONL header must be an object.");
  const cases = lines.slice(1).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid JSONL at line ${index + 2}.`);
    }
  });
  return { ...header, cases };
}

export class DatasetValidationError extends Error {
  readonly issueCount: number;

  constructor(message: string, issueCount: number) {
    super(message);
    this.name = "DatasetValidationError";
    this.issueCount = issueCount;
  }
}
