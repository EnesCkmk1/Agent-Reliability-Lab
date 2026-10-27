import type { AgentExecution, AgentTaskView, Limits } from "../types.ts";
import type { ToolEnvironment } from "../tools/environment.ts";

export interface AgentRequest {
  view: AgentTaskView;
  limits: Limits;
  tools: ToolEnvironment;
  signal: AbortSignal;
}

export interface AgentAdapter {
  name: string;
  version: string;
  model: string | null;
  provider: string | null;
  capabilities: {
    usesAnswerKey: boolean;
    deterministic: boolean;
  };
  promptTemplateVersion: string | null;
  promptTemplateSha256: string | null;
  publicConfig: Record<string, unknown>;
  execute(request: AgentRequest): Promise<AgentExecution>;
}
