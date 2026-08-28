import type { AgentConfig, ThinkingLevel } from "../types.ts";

interface AgentInvocationParams {
  model?: string | undefined;
  thinking?: string | undefined;
  stack?: string | undefined;
  max_turns?: number | undefined;
  grace_turns?: number | undefined;
  run_in_background?: boolean | undefined;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string | undefined;
  modelFromParams: boolean;
  thinking?: ThinkingLevel | undefined;
  stack?: string | undefined;
  maxTurns?: number | undefined;
  graceTurns?: number | undefined;
  runInBackground: boolean;
} {
  const stack = typeof params.stack === "string" ? params.stack.trim() : undefined;
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    ...(stack ? { stack } : {}),
    maxTurns: params.max_turns ?? agentConfig?.maxTurns,
    graceTurns: params.grace_turns ?? agentConfig?.graceTurns,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
  };
}
