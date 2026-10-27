import { isPlainObject, sleep } from "../util.ts";
import { evaluateArithmetic } from "./calculator.ts";
import { PROHIBITED_TOOLS, type FaultSpec, type InjectedEvent, type Limits, type ToolCallRecord } from "../types.ts";

export interface ToolEnvironment {
  call(name: string, args: Record<string, unknown>): Promise<ToolCallRecord>;
  trace(): ToolCallRecord[];
  events(): InjectedEvent[];
}

interface SourcedFault extends FaultSpec {
  source: "task" | "run";
}

const prohibited = new Set<string>(PROHIBITED_TOOLS);

export function createToolEnvironment(options: {
  hiddenContext: Record<string, unknown>;
  faults: SourcedFault[];
  limits: Limits;
  signal: AbortSignal;
  now?: () => Date;
}): ToolEnvironment {
  const trace: ToolCallRecord[] = [];
  const events: InjectedEvent[] = options.faults.map((fault) => ({
    id: fault.id,
    source: fault.source,
    kind: fault.kind,
    target: fault.target,
    phase: "configured",
    detail: `Configured ${fault.kind} on ${fault.target}.`,
  }));
  let sequence = 0;
  const now = options.now ?? (() => new Date());

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
    const attempt = trace.filter((entry) => entry.tool === name).length + 1;
    const started = now();
    const startedMs = performance.now();
    const base = {
      id: `tc_${++sequence}`,
      tool: name,
      arguments: args,
      startedAt: started.toISOString(),
      attempt,
    };

    const finish = (
      status: ToolCallRecord["status"],
      result: unknown,
      error: string | null,
      faultId: string | null,
      simulatedDelayMs = 0,
    ): ToolCallRecord => {
      const record: ToolCallRecord = {
        ...base,
        endedAt: now().toISOString(),
        durationMs: Math.max(0, performance.now() - startedMs),
        simulatedDelayMs,
        status,
        result,
        error,
        injectedFaultId: faultId,
      };
      trace.push(record);
      return record;
    };

    if (trace.length >= options.limits.maxToolCalls) {
      return finish("error", null, "tool_call_limit", null);
    }
    if (attempt > options.limits.maxRetries + 1) {
      return finish("error", null, "retry_limit", null);
    }
    if (prohibited.has(name)) {
      events.push({
        id: `blocked-${base.id}`,
        source: "task",
        kind: "unavailable",
        target: name,
        phase: "fired",
        detail: "Prohibited tool was rejected and not executed.",
      });
      return finish("not_permitted", null, "tool_not_permitted", null);
    }

    const delay = matching(options.faults, name, "delay");
    const delayMs = delay ? Number(delay.params.delayMs ?? 0) : 0;
    if (delay && delayMs > options.limits.toolTimeoutMs) {
      await sleep(options.limits.toolTimeoutMs, options.signal);
      markFired(events, delay, "Delay exceeded the tool timeout.");
      return finish("timeout", null, "timeout", delay.id, delayMs);
    }
    if (delayMs > 0) {
      await sleep(delayMs, options.signal);
      markFired(events, delay!, `Waited ${delayMs}ms before the tool ran.`);
    }

    if (!isKnownTool(name)) return finish("error", null, "unknown_tool", null);

    const firstError = matching(options.faults, name, "error_on_first_call");
    if (firstError && attempt === 1) {
      markFired(events, firstError, "First call returned a transient error.");
      return finish("error", null, "transient_unavailable", firstError.id, delayMs);
    }
    const unavailable = matching(options.faults, name, "unavailable");
    if (unavailable) {
      markFired(events, unavailable, "Tool is unavailable for this call.");
      return finish("error", null, "unavailable", unavailable.id, delayMs);
    }
    const malformed = matching(options.faults, name, "malformed");
    if (malformed) {
      markFired(events, malformed, "Tool returned a malformed payload.");
      return finish("error", "{bad-json", "malformed_tool_response", malformed.id, delayMs);
    }

    try {
      const result = executeTool(name, args, options.hiddenContext);
      const contradictory = matching(options.faults, name, "contradictory");
      if (contradictory && isPlainObject(result)) {
        markFired(events, contradictory, "Tool result contradicted stored context.");
        const altered = { ...result };
        const field = typeof contradictory.params.field === "string" ? contradictory.params.field : "balanceUsd";
        altered[field] = "value" in contradictory.params ? contradictory.params.value : "contradicted";
        return finish("success", altered, null, contradictory.id, delayMs);
      }
      return finish("success", result, null, null, delayMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "tool_error";
      return finish("error", null, message, null, delayMs);
    }
  };

  return {
    call,
    trace: () => [...trace],
    events: () => [...events],
  };
}

function matching(faults: SourcedFault[], tool: string, kind: FaultSpec["kind"]): SourcedFault | undefined {
  return faults.find((fault) => fault.kind === kind && fault.target === tool);
}

function markFired(events: InjectedEvent[], fault: SourcedFault, detail: string): void {
  events.push({
    id: fault.id,
    source: fault.source,
    kind: fault.kind,
    target: fault.target,
    phase: "fired",
    detail,
  });
}

function isKnownTool(name: string): boolean {
  return name === "lookup_record" || name === "calculator" || name === "read_section";
}

function executeTool(name: string, args: Record<string, unknown>, hidden: Record<string, unknown>): unknown {
  if (name === "calculator") {
    if (typeof args.expression !== "string") throw new Error("calculator requires expression");
    return { value: evaluateArithmetic(args.expression) };
  }
  if (name === "lookup_record") {
    const records = Array.isArray(hidden.records) ? hidden.records : [];
    const id = typeof args.id === "string" ? args.id : "";
    const found = records.find((record) => isPlainObject(record) && record.id === id);
    if (!found) throw new Error("not_found");
    return found;
  }
  if (name === "read_section") {
    const sections = Array.isArray(hidden.sections) ? hidden.sections : [];
    const sectionId = typeof args.sectionId === "string" ? args.sectionId : "";
    const found = sections.find((section) => isPlainObject(section) && section.id === sectionId);
    if (!found) throw new Error("not_found");
    return found;
  }
  throw new Error("unknown_tool");
}
