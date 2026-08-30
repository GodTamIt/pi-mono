import type { Model } from "@earendil-works/pi-ai";
import type { AgentTypeRegistry } from "../config/agent-types.ts";
import { resolveAgentInvocationConfig } from "../config/invocation-config.ts";
import type { ModelRegistry } from "../session/model-resolver.ts";
import { type AgentStackOverrides, resolveAgentStack } from "../stacks/stack-resolver.ts";
import type { AgentConfig, AgentInvocation, SubagentType, ThinkingLevel } from "../types.ts";
import {
  type AgentDetails,
  buildInvocationTags,
  getDisplayName,
  getPromptModeLabel,
} from "../ui/display.ts";

export interface ModelInfo {
  parentModel: Model<any> | undefined;
  modelRegistry: ModelRegistry | undefined;
}

export interface PropagatedStackSelection {
  stack: string;
  fallbackModel: Model<any>;
  fallbackThinking?: ThinkingLevel | undefined;
}

export interface SpawnResolutionOptions {
  stackOverrides?: AgentStackOverrides | undefined;
  /** Active primary stack name and fallback values. Child invocation overrides are disabled. */
  propagatedStack?: PropagatedStackSelection | undefined;
}

export interface SpawnIdentity {
  subagentType: string;
  rawType: SubagentType;
  /** Retained for result-renderer compatibility. Production resolution never falls back. */
  fellBack: boolean;
  displayName: string;
}

export interface SpawnExecution {
  task: string;
  description: string;
  notice?: string | undefined;
  model: Model<any> | undefined;
  effectiveMaxTurns: number | undefined;
  effectiveGraceTurns: number | undefined;
  thinking: ThinkingLevel | undefined;
  stack: string | undefined;
  runInBackground: boolean;
  agentInvocation: AgentInvocation;
}

export interface SpawnPresentation {
  modelName: string | undefined;
  agentTags: string[];
  detailBase: Pick<
    AgentDetails,
    | "displayName"
    | "description"
    | "subagentType"
    | "modelName"
    | "tags"
    | "task"
    | "isBackground"
    | "stack"
    | "thinking"
    | "graceTurns"
  >;
}

export interface ResolvedSpawnConfig {
  identity: SpawnIdentity;
  execution: SpawnExecution;
  presentation: SpawnPresentation;
}

export interface SpawnConfigError {
  error: string;
}

export interface ResumeConfig {
  task: string;
  stack: string | undefined;
  model: string | undefined;
  thinking: ThinkingLevel | undefined;
  maxTurns: number | undefined;
  graceTurns: number | undefined;
  runInBackground: boolean;
}

export interface ResolvedInvocationSelection {
  agent: AgentConfig;
  model: Model<any> | undefined;
  invocation: AgentInvocation;
  notice?: string | undefined;
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function resolveResumeConfig(
  params: Record<string, unknown>,
): ResumeConfig | SpawnConfigError {
  if (Object.hasOwn(params, "inherit_context")) {
    return {
      error:
        "inherit_context is unsupported. Children receive no parent conversation; include all required context in task.",
    };
  }
  const task = trimmedString(params.task);
  if (!task) return { error: "task must be a non-empty self-contained string" };
  const stack = params.stack === undefined ? undefined : trimmedString(params.stack);
  if (params.stack !== undefined && !stack) return { error: "stack must be a non-empty string" };
  const model = params.model === undefined ? undefined : trimmedString(params.model);
  if (params.model !== undefined && !model) return { error: "model must be a non-empty string" };
  const thinking = parseThinking(params.thinking);
  if (params.thinking !== undefined && !thinking) {
    return { error: "thinking must be one of minimal, low, medium, high, xhigh, or max" };
  }
  const maxError = validateBudget(params.max_turns, "max_turns", 1, 10_000);
  if (maxError) return { error: maxError };
  const graceError = validateBudget(params.grace_turns, "grace_turns", 0, 1_000);
  if (graceError) return { error: graceError };
  if (params.run_in_background !== undefined && typeof params.run_in_background !== "boolean") {
    return { error: "run_in_background must be a boolean" };
  }
  return {
    task,
    stack,
    model,
    thinking,
    maxTurns: params.max_turns as number | undefined,
    graceTurns: params.grace_turns as number | undefined,
    runInBackground: params.run_in_background === true,
  };
}

/** Resolve a known, enabled child-capable agent and capture its immutable invocation snapshot. */
export function resolveInvocationForAgent(
  rawType: string,
  params: Record<string, unknown>,
  registry: AgentTypeRegistry,
  modelInfo: ModelInfo,
  options: SpawnResolutionOptions = {},
): ResolvedInvocationSelection | SpawnConfigError {
  const canonical = registry.resolveType(rawType);
  if (!canonical) return { error: `Unknown agent type: ${JSON.stringify(rawType)}` };
  const agent = registry.resolveAgentConfig(canonical);
  if (agent.enabled === false)
    return { error: `Agent type ${JSON.stringify(canonical)} is disabled` };
  const mode = agent.mode ?? "subagent";
  if (mode !== "subagent" && mode !== "all") {
    return { error: `Agent type ${JSON.stringify(canonical)} is not available as a subagent` };
  }
  if (!modelInfo.modelRegistry) return { error: "No model registry available." };

  if (
    options.propagatedStack &&
    (params.stack !== undefined || params.model !== undefined || params.thinking !== undefined)
  ) {
    return {
      error:
        "stack, model, and thinking cannot override the active primary agent's propagated stack.",
    };
  }

  if (options.propagatedStack) {
    const { stack, fallbackModel, fallbackThinking } = options.propagatedStack;
    const childStack = [...(agent.stacks?.keys() ?? [])].find(
      (name) => normalizeStackName(name) === normalizeStackName(stack),
    );
    if (!childStack) {
      return {
        agent,
        model: fallbackModel,
        invocation: {
          stack,
          modelName: `${fallbackModel.provider}/${fallbackModel.id}`,
          thinking: fallbackThinking,
        },
      };
    }

    const resolved = resolveAgentStack({
      agent,
      registry: modelInfo.modelRegistry,
      runtimeModel: fallbackModel,
      runtimeThinking: fallbackThinking,
      explicitStack: childStack,
    });
    if (!resolved.ok) return { error: resolved.error };
    if (!resolved.value.model || !resolved.value.modelName) {
      return { error: `No available model resolved for agent ${JSON.stringify(canonical)}.` };
    }
    return {
      agent,
      model: resolved.value.model,
      invocation: {
        stack: resolved.value.stack,
        modelName: resolved.value.modelName,
        thinking: resolved.value.thinking,
      },
    };
  }

  const thinking = parseThinking(params.thinking);
  if (params.thinking !== undefined && !thinking) {
    return { error: "thinking must be one of minimal, low, medium, high, xhigh, or max" };
  }
  const explicitStack = params.stack === undefined ? undefined : trimmedString(params.stack);
  if (params.stack !== undefined && !explicitStack)
    return { error: "stack must be a non-empty string" };
  const model = params.model === undefined ? undefined : trimmedString(params.model);
  if (params.model !== undefined && !model) return { error: "model must be a non-empty string" };

  const resolved = resolveAgentStack({
    agent,
    registry: modelInfo.modelRegistry,
    runtimeModel: modelInfo.parentModel,
    explicitStack,
    sessionOverride: options.stackOverrides?.get(agent),
    model,
    thinking,
  });
  if (!resolved.ok) return { error: resolved.error };
  if (!resolved.value.model || !resolved.value.modelName) {
    return { error: `No available model resolved for agent ${JSON.stringify(canonical)}.` };
  }

  return {
    agent,
    model: resolved.value.model,
    ...(resolved.value.notice ? { notice: resolved.value.notice.message } : {}),
    invocation: {
      stack: resolved.value.stack,
      modelName: resolved.value.modelName,
      thinking: resolved.value.thinking,
    },
  };
}

export function resolveSpawnConfig(
  params: Record<string, unknown>,
  registry: AgentTypeRegistry,
  modelInfo: ModelInfo,
  settings: {
    readonly defaultMaxTurns: number | undefined;
    readonly graceTurns?: number | undefined;
  },
  options: SpawnResolutionOptions = {},
): ResolvedSpawnConfig | SpawnConfigError {
  if (Object.hasOwn(params, "inherit_context")) {
    return {
      error:
        "inherit_context is unsupported. Children receive no parent conversation; include all required context in task.",
    };
  }
  const task = trimmedString(params.task);
  if (!task) return { error: "task must be a non-empty self-contained string" };
  const description = trimmedString(params.description) ?? task.slice(0, 80);
  const rawType = trimmedString(params.subagent_type);
  if (!rawType) return { error: "subagent_type must be a non-empty string" };
  const maxError = validateBudget(params.max_turns, "max_turns", 1, 10_000);
  if (maxError) return { error: maxError };
  const graceError = validateBudget(params.grace_turns, "grace_turns", 0, 1_000);
  if (graceError) return { error: graceError };

  const selection = resolveInvocationForAgent(rawType, params, registry, modelInfo, options);
  if ("error" in selection) return selection;
  const canonical = registry.resolveType(rawType)!;
  const resolvedConfig = resolveAgentInvocationConfig(selection.agent, params);
  const runInBackground = resolvedConfig.runInBackground;
  const effectiveMaxTurns = resolvedConfig.maxTurns ?? settings.defaultMaxTurns;
  const effectiveGraceTurns = resolvedConfig.graceTurns ?? settings.graceTurns;
  const agentInvocation: AgentInvocation = {
    ...selection.invocation,
    maxTurns: effectiveMaxTurns,
    graceTurns: effectiveGraceTurns,
    runInBackground,
  };
  const displayName = getDisplayName(canonical, registry);
  const modeLabel = getPromptModeLabel(canonical, registry);
  const { tags: invocationTags } = buildInvocationTags(agentInvocation);
  const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
  const modelName = agentInvocation.modelName;
  const detailBase = {
    displayName,
    description,
    subagentType: canonical,
    modelName,
    tags: agentTags.length > 0 ? agentTags : undefined,
    task,
    isBackground: runInBackground,
    stack: selection.invocation.stack,
    thinking: selection.invocation.thinking,
    graceTurns: effectiveGraceTurns,
  };

  return {
    identity: { subagentType: canonical, rawType, fellBack: false, displayName },
    execution: {
      task,
      description,
      ...(selection.notice ? { notice: selection.notice } : {}),
      model: selection.model,
      effectiveMaxTurns,
      effectiveGraceTurns,
      thinking: selection.invocation.thinking,
      stack: selection.invocation.stack!,
      runInBackground,
      agentInvocation,
    },
    presentation: { modelName, agentTags, detailBase },
  };
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)
    ? (value as ThinkingLevel)
    : undefined;
}

function normalizeStackName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function validateBudget(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return `${name} must be an integer from ${minimum} through ${maximum}`;
  }
  return undefined;
}
