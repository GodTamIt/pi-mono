import type { Model } from "@earendil-works/pi-ai";
import type { AgentTypeRegistry } from "../config/agent-types.ts";
import { resolveAgentInvocationConfig } from "../config/invocation-config.ts";
import type { ModelRegistry } from "../session/model-resolver.ts";
import { resolveInvocationModel } from "../session/model-resolver.ts";
import type { AgentInvocation, SubagentType, ThinkingLevel } from "../types.ts";
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

export interface SpawnIdentity {
  subagentType: string;
  rawType: SubagentType;
  fellBack: boolean;
  displayName: string;
}

export interface SpawnExecution {
  task: string;
  description: string;
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
    "displayName" | "description" | "subagentType" | "modelName" | "tags"
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
  maxTurns: number | undefined;
  graceTurns: number | undefined;
}

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
  const maxError = validateBudget(params.max_turns, "max_turns", 1, 10_000);
  if (maxError) return { error: maxError };
  const graceError = validateBudget(params.grace_turns, "grace_turns", 0, 1_000);
  if (graceError) return { error: graceError };
  return {
    task,
    maxTurns: params.max_turns as number | undefined,
    graceTurns: params.grace_turns as number | undefined,
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
  const stack = params.stack === undefined ? undefined : trimmedString(params.stack);
  if (params.stack !== undefined && !stack) return { error: "stack must be a non-empty string" };
  const maxError = validateBudget(params.max_turns, "max_turns", 1, 10_000);
  if (maxError) return { error: maxError };
  const graceError = validateBudget(params.grace_turns, "grace_turns", 0, 1_000);
  if (graceError) return { error: graceError };

  const resolved = registry.resolveType(rawType);
  if (resolved !== undefined && !registry.isValidType(resolved)) {
    return { error: `Agent type "${resolved}" is disabled` };
  }
  const subagentType = resolved ?? "general-purpose";
  const fellBack = resolved === undefined;
  const displayName = getDisplayName(subagentType, registry);
  const customConfig = registry.resolveAgentConfig(subagentType);
  const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);
  const resolution = resolveInvocationModel(
    modelInfo.parentModel,
    resolvedConfig.modelInput,
    resolvedConfig.modelFromParams,
    modelInfo.modelRegistry,
  );
  if (resolution.error) return { error: resolution.error };
  const model = resolution.model;
  const thinking = resolvedConfig.thinking;
  const runInBackground = resolvedConfig.runInBackground;
  const effectiveMaxTurns = resolvedConfig.maxTurns ?? settings.defaultMaxTurns;
  const effectiveGraceTurns = resolvedConfig.graceTurns ?? settings.graceTurns;
  const parentModelId = modelInfo.parentModel?.id;
  const effectiveModelId = model?.id;
  const modelName =
    effectiveModelId && effectiveModelId !== parentModelId
      ? model.name.replace(/^Claude\s+/i, "").toLowerCase()
      : undefined;

  const agentInvocation: AgentInvocation = {
    modelName,
    thinking,
    maxTurns: effectiveMaxTurns,
    graceTurns: effectiveGraceTurns,
    stack,
    runInBackground,
  };
  const modeLabel = getPromptModeLabel(subagentType, registry);
  const { tags: invocationTags } = buildInvocationTags(agentInvocation);
  const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
  const detailBase = {
    displayName,
    description,
    subagentType,
    modelName,
    tags: agentTags.length > 0 ? agentTags : undefined,
  };

  return {
    identity: { subagentType, rawType, fellBack, displayName },
    execution: {
      task,
      description,
      model,
      effectiveMaxTurns,
      effectiveGraceTurns,
      thinking,
      stack,
      runInBackground,
      agentInvocation,
    },
    presentation: { modelName, agentTags, detailBase },
  };
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
