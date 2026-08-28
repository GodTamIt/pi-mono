import type { AgentConfig, ThinkingLevel } from "../types.ts";

interface AgentInvocationParams {
  model?: string | undefined;
  thinking?: string | undefined;
  max_turns?: number | undefined;
  run_in_background?: boolean | undefined;
  inherit_context?: boolean | undefined;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string | undefined;
  modelFromParams: boolean;
  thinking?: ThinkingLevel | undefined;
  maxTurns?: number | undefined;
  inheritContext: boolean;
  runInBackground: boolean;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
  };
}
