import { mulberry32 } from "../util.ts";
import type {
  AgentTaskView,
  FaultSpec,
  InjectedEvent,
  ScenarioConfig,
  TaskCase,
} from "../types.ts";

export interface AppliedScenario {
  view: AgentTaskView;
  faults: Array<FaultSpec & { source: "task" | "run" }>;
  events: InjectedEvent[];
  maxRetriesOverride: number | null;
}

export function applyScenario(task: TaskCase, scenario: ScenarioConfig): AppliedScenario {
  const input = structuredClone(task.input);
  const visibleContext = structuredClone(task.visibleContext);
  const faults = [
    ...task.faults.map((fault) => ({ ...fault, source: "task" as const })),
    ...scenario.faults.map((fault) => ({ ...structuredClone(fault), source: "run" as const })),
  ];
  const events: InjectedEvent[] = [];
  let maxRetriesOverride: number | null = null;

  for (const fault of faults) {
    if (fault.kind === "incomplete_input") {
      const field = String(fault.params.field);
      delete input[field];
      events.push(event(fault, "Removed an input field before the agent saw the task."));
    } else if (fault.kind === "contradictory" && fault.target === "input") {
      visibleContext.injectedContradiction = String(fault.params.message);
      events.push(event(fault, "Added a contradictory note to visible context."));
    } else if (fault.kind === "retry_limit") {
      maxRetriesOverride = Number(fault.params.maxRetries);
      events.push(event(fault, `Capped retries at ${maxRetriesOverride}.`));
    }
  }

  return {
    view: {
      id: task.id,
      category: task.category,
      difficulty: task.difficulty,
      title: task.title,
      prompt: task.prompt,
      input,
      visibleContext,
      synthetic: task.synthetic,
      datasetVersion: task.datasetVersion,
      scenarioType: task.scenarioType,
    },
    faults,
    events,
    maxRetriesOverride,
  };
}

export function stressFaults(seed: number): FaultSpec[] {
  const rng = mulberry32(seed >>> 0);
  const catalog: FaultSpec[] = [
    { id: "stress-delay", target: "lookup_record", kind: "delay", params: { delayMs: 15 } },
    { id: "stress-malformed", target: "lookup_record", kind: "malformed", params: {} },
    { id: "stress-unavailable", target: "calculator", kind: "unavailable", params: {} },
  ];
  const index = Math.min(catalog.length - 1, Math.floor(rng() * catalog.length));
  const chosen = catalog[index]!;
  return [{ ...chosen, id: `${chosen.id}-seed-${seed}` }];
}

function event(fault: FaultSpec & { source: "task" | "run" }, detail: string): InjectedEvent {
  return {
    id: fault.id,
    source: fault.source,
    kind: fault.kind,
    target: fault.target,
    phase: "fired",
    detail,
  };
}
