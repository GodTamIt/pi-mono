import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { type ModelRegistry, resolveModel } from "../session/model-resolver.ts";
import type { AgentConfig, ThinkingLevel } from "../types.ts";

const DEFAULT_STACK = "default";
const THINKING_ORDER: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface StackFallbackNotice {
  kind: "stale-session-override";
  requested: string;
  selected: string;
  message: string;
}

export interface ResolveAgentStackOptions {
  agent: AgentConfig;
  registry: ModelRegistry;
  runtimeModel?: Model<any> | undefined;
  runtimeThinking?: ThinkingLevel | undefined;
  explicitStack?: string | undefined;
  sessionOverride?: string | undefined;
  /** Legacy one-off invocation override, applied after profile selection. */
  model?: string | undefined;
  /** Legacy one-off invocation override, applied after profile selection. */
  thinking?: ThinkingLevel | undefined;
}

export interface ResolvedAgentStack {
  stack: string;
  model: Model<any> | undefined;
  modelName?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  notice?: StackFallbackNotice | undefined;
}

export type AgentStackResolution =
  | { ok: true; value: ResolvedAgentStack }
  | { ok: false; error: string };

/** Resolve one agent's local stack without consulting or mutating any global stack store. */
export function resolveAgentStack(options: ResolveAgentStackOptions): AgentStackResolution {
  const { agent } = options;
  if (agent.enabled === false) {
    return { ok: false, error: `Agent ${JSON.stringify(agent.name)} is disabled.` };
  }
  const explicit = clean(options.explicitStack);
  const override = clean(options.sessionOverride);
  let selected: string;
  let notice: StackFallbackNotice | undefined;

  if (explicit) {
    const canonical = resolveStackName(agent, explicit);
    if (!canonical) return unknownStack(agent, explicit, "explicit stack");
    selected = canonical;
  } else if (override) {
    const canonical = resolveStackName(agent, override);
    if (canonical) {
      selected = canonical;
    } else {
      selected = configuredDefault(agent);
      notice = {
        kind: "stale-session-override",
        requested: override,
        selected,
        message: `Stack ${JSON.stringify(override)} no longer exists for agent ${JSON.stringify(agent.name)}; using ${JSON.stringify(selected)}.`,
      };
    }
  } else {
    selected = configuredDefault(agent);
  }

  const syntheticThinking = agent.thinking ?? options.runtimeThinking;
  const named = findProfile(agent, selected);
  // `default` may be either a named profile or the synthetic agent/runtime fallback.
  // Schema validation normally guarantees every other selected stack exists.
  if (selected !== DEFAULT_STACK && !named) return unknownStack(agent, selected, "selected stack");

  const modelInput = clean(options.model) ?? named?.model ?? clean(agent.model);
  let model = options.runtimeModel;
  if (modelInput) {
    const resolution = resolveModel(modelInput, options.registry);
    if (typeof resolution === "string") {
      return {
        ok: false,
        error: `Agent ${JSON.stringify(agent.name)} stack ${JSON.stringify(selected)}: ${resolution}`,
      };
    }
    model = resolution;
  }

  const requestedThinking = options.thinking ?? named?.thinking ?? syntheticThinking;
  const thinking = clampThinking(requestedThinking, model);
  return {
    ok: true,
    value: {
      stack: selected,
      model,
      ...(model ? { modelName: `${model.provider}/${model.id}` } : {}),
      ...(thinking ? { thinking } : {}),
      ...(notice ? { notice } : {}),
    },
  };
}

/** Session-only override storage keyed by stable agent identity. */
export class AgentStackOverrides {
  private readonly selections = new Map<string, string>();

  get(agent: AgentConfig): string | undefined {
    return this.selections.get(identity(agent));
  }

  set(agent: AgentConfig, stack: string): void {
    const value = clean(stack);
    if (!value) throw new Error("stack must be non-empty");
    this.selections.set(identity(agent), value);
  }

  clear(agent: AgentConfig): void {
    this.selections.delete(identity(agent));
  }

  reset(): void {
    this.selections.clear();
  }
}

export function clampThinking(
  thinking: ThinkingLevel | undefined,
  model: Model<any> | undefined,
): ThinkingLevel | undefined {
  if (!thinking || !model) return thinking;
  const supported = getSupportedThinkingLevels(model).filter(
    (level): level is ThinkingLevel => level !== "off",
  );
  if (supported.length === 0) return undefined;
  if (supported.includes(thinking)) return thinking;

  const requestedIndex = THINKING_ORDER.indexOf(thinking);
  const lower = [...supported]
    .sort((a, b) => THINKING_ORDER.indexOf(b) - THINKING_ORDER.indexOf(a))
    .find((level) => THINKING_ORDER.indexOf(level) <= requestedIndex);
  return (
    lower ?? supported.sort((a, b) => THINKING_ORDER.indexOf(a) - THINKING_ORDER.indexOf(b))[0]
  );
}

function configuredDefault(agent: AgentConfig): string {
  if (!agent.defaultStack || normalize(agent.defaultStack) === DEFAULT_STACK) return DEFAULT_STACK;
  return resolveStackName(agent, agent.defaultStack) ?? DEFAULT_STACK;
}

function resolveStackName(agent: AgentConfig, wanted: string): string | undefined {
  const entry = [...(agent.stacks?.keys() ?? [])].find(
    (name) => normalize(name) === normalize(wanted),
  );
  if (entry) return entry;
  return normalize(wanted) === DEFAULT_STACK ? DEFAULT_STACK : undefined;
}

function findProfile(agent: AgentConfig, name: string) {
  const canonical = [...(agent.stacks?.keys() ?? [])].find(
    (stack) => normalize(stack) === normalize(name),
  );
  return canonical ? agent.stacks?.get(canonical) : undefined;
}

function unknownStack(agent: AgentConfig, selected: string, context: string): AgentStackResolution {
  const named = [...(agent.stacks?.keys() ?? [])];
  const available = [
    ...(named.some((name) => normalize(name) === DEFAULT_STACK) ? [] : [DEFAULT_STACK]),
    ...named,
  ].join(", ");
  return {
    ok: false,
    error: `Unknown ${context} ${JSON.stringify(selected)} for agent ${JSON.stringify(agent.name)}. Available stacks: ${available}`,
  };
}

function identity(agent: AgentConfig): string {
  return agent.id ?? normalize(agent.name);
}

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}
