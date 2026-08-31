import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentTypeRegistry } from "../config/agent-types.ts";
import { normalizeAgentId } from "../config/custom-agents.ts";
import {
  resolvePermittedToolNames,
  unknownPermissionToolNames,
} from "../config/tool-permissions.ts";
import type { AgentStackOverrides } from "../stacks/stack-resolver.ts";
import { resolveAgentStack } from "../stacks/stack-resolver.ts";
import type { AgentConfig } from "../types.ts";
import type { FooterStatus } from "../ui/footer-status.ts";
import { type RosterPickerItem, showRosterPicker } from "../ui/roster-picker.ts";

export const PRIMARY_AGENT_FLAG = "agent";
export const PRIMARY_STACK_FLAG = "stack";
export const MANAGED_SUBAGENT_TOOLS = [
  "subagent",
  "get_subagent_result",
  "steer_subagent",
] as const;

type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface BaselineState {
  model: Model<any> | undefined;
  thinking: PiThinkingLevel;
  systemPrompt: string;
  tools: string[];
}

interface Selection {
  name: string;
  agent: AgentConfig;
  model: Model<any>;
  thinking: ThinkingLevel | undefined;
  tools: string[];
  stack: string;
}

export interface PrimaryControllerOptions {
  pi: ExtensionAPI;
  registry: AgentTypeRegistry;
  stackOverrides: AgentStackOverrides;
  footerStatus: FooterStatus;
}

export class PrimaryController {
  private baseline: BaselineState | undefined;
  private selected: Selection | undefined;
  private delegationDenied: string | undefined;
  private ctx: ExtensionContext | undefined;

  constructor(private readonly options: PrimaryControllerOptions) {}

  async handleSessionStart(ctx: ExtensionContext): Promise<void> {
    this.options.registry.reload();
    this.options.footerStatus.reset();
    this.options.footerStatus.attach(ctx.ui);
    this.ctx = ctx;
    this.selected = undefined;
    this.delegationDenied = undefined;
    this.options.stackOverrides.reset();
    this.baseline = {
      model: ctx.model,
      thinking: this.options.pi.getThinkingLevel(),
      systemPrompt: ctx.getSystemPrompt(),
      tools: this.options.pi.getActiveTools(),
    };

    const requestedAgent = clean(this.options.pi.getFlag(PRIMARY_AGENT_FLAG));
    const requestedStack = clean(this.options.pi.getFlag(PRIMARY_STACK_FLAG));
    if (requestedStack && !requestedAgent) {
      ctx.ui.notify(
        `--${PRIMARY_STACK_FLAG} requires --${PRIMARY_AGENT_FLAG} naming an enabled primary agent.`,
        "error",
      );
      this.reconcileToolVisibility();
      return;
    }
    if (!requestedAgent) {
      this.reconcileToolVisibility();
      return;
    }
    if (normalizeAgentId(requestedAgent) === "default" && requestedStack) {
      ctx.ui.notify(
        `--${PRIMARY_STACK_FLAG} requires an enabled primary agent with a frontmatter stack.`,
        "error",
      );
      this.reconcileToolVisibility();
      return;
    }

    const resolved = this.resolveSelection(requestedAgent, requestedStack);
    if (typeof resolved === "string") {
      ctx.ui.notify(`Unable to apply startup agent: ${resolved}`, "error");
      this.reconcileToolVisibility();
      return;
    }
    const error = await this.applySelection(resolved, ctx);
    if (error) {
      ctx.ui.notify(`Unable to apply startup agent: ${error}`, "error");
      this.reconcileToolVisibility();
    }
  }

  beforeAgentStart(event: BeforeAgentStartEvent): BeforeAgentStartEventResult | void {
    this.options.footerStatus.setTaskPrompt(event.prompt);
    const baseline = this.baseline?.systemPrompt;
    if (baseline === undefined) return;
    const prompt = this.selected?.agent.systemPrompt.trim();
    return {
      systemPrompt:
        this.selected?.agent.promptMode === "replace"
          ? (prompt ?? "")
          : prompt
            ? `${baseline}\n\n${prompt}`
            : baseline,
    };
  }

  async handleAgentCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.options.registry.reload();
    const direct = args.trim();
    const name =
      direct || (await showRosterPicker(ctx.ui, "Select primary agent", this.agentItems()));
    if (!name) return;
    await this.selectPrimary(name, ctx);
  }

  getStackArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
    this.options.registry.reload();
    const firstSpace = argumentPrefix.search(/\s/);
    if (firstSpace === -1) {
      const query = normalizeAgentId(argumentPrefix);
      const items = this.stackCommandAgentTypes()
        .filter((canonical) => normalizeAgentId(canonical).startsWith(query))
        .map((canonical) => {
          const agent = this.options.registry.resolveAgentConfig(canonical);
          return {
            value: `${canonical} `,
            label: canonical,
            description: agent.description,
          };
        });
      return items.length ? items : null;
    }

    const match = argumentPrefix.match(/^(\S+)\s+(\S*)$/);
    if (!match) return null;
    const canonical = this.options.registry.resolveType(match[1] ?? "");
    if (!canonical) return null;
    const agent = this.options.registry.resolveAgentConfig(canonical);
    if (agent.enabled === false || (this.selected && !sameAgent(this.selected.agent, agent))) {
      return null;
    }
    const query = normalizeAgentId(match[2] ?? "");
    const items = this.availableStackNames(agent)
      .filter((stack) => normalizeAgentId(stack).startsWith(query))
      .map((stack) => ({
        value: `${canonical} ${stack}`,
        label: stack,
        ...(stack === "auto"
          ? { description: "Clear the session override and use the configured default." }
          : stack === "default"
            ? { description: "Use the named default stack, or the synthetic fallback." }
            : {}),
      }));
    return items.length ? items : null;
  }

  async handleStackCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.options.registry.reload();
    const parts = args.trim() ? args.trim().split(/\s+/) : [];
    if (parts.length > 2) {
      ctx.ui.notify("Usage: /stack [agent] [stack|default|auto]", "warning");
      return;
    }

    if (!parts[0] && !this.selected) {
      ctx.ui.notify("No roster primary is active. Select one with /agent first.", "warning");
      return;
    }

    const rawAgent = parts[0] ?? this.selected?.name;
    if (!rawAgent) return;
    if (!parts[1]) {
      const canonical = this.options.registry.resolveType(rawAgent);
      if (!canonical) {
        ctx.ui.notify(`Unknown agent ${JSON.stringify(rawAgent)}.`, "error");
        return;
      }
      if (this.options.registry.resolveAgentConfig(canonical).enabled === false) {
        ctx.ui.notify(`Agent ${JSON.stringify(canonical)} is disabled.`, "error");
        return;
      }
    }
    const rawStack =
      parts[1] ??
      (await showRosterPicker(
        ctx.ui,
        `Select stack for ${this.agentDisplayName(rawAgent)}`,
        this.stackItems(rawAgent),
      ));
    if (!rawStack) return;
    await this.selectStack(rawAgent, rawStack, ctx);
  }

  private async selectPrimary(name: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle();
    const resolved = this.resolveSelection(name);
    if (typeof resolved === "string") {
      ctx.ui.notify(resolved, "error");
      return;
    }
    const error = await this.applySelection(resolved, ctx);
    ctx.ui.notify(
      error ?? `Primary agent set to ${resolved?.name ?? "default"}.`,
      error ? "error" : "info",
    );
  }

  private async selectStack(
    rawAgent: string,
    rawStack: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    await ctx.waitForIdle();
    const canonical = this.options.registry.resolveType(rawAgent);
    if (!canonical) {
      ctx.ui.notify(`Unknown agent ${JSON.stringify(rawAgent)}.`, "error");
      return;
    }
    const agent = this.options.registry.resolveAgentConfig(canonical);
    if (agent.enabled === false) {
      ctx.ui.notify(`Agent ${JSON.stringify(canonical)} is disabled.`, "error");
      return;
    }

    if (this.selected && !sameAgent(this.selected.agent, agent)) {
      ctx.ui.notify(
        `Subagent ${JSON.stringify(canonical)} cannot override active primary ${JSON.stringify(this.selected.name)} stack ${JSON.stringify(this.selected.stack)}.`,
        "error",
      );
      return;
    }

    const previousOverride = this.options.stackOverrides.get(agent);
    if (normalizeAgentId(rawStack) === "auto") {
      this.options.stackOverrides.clear(agent);
    } else {
      const resolution = this.resolveStack(agent, rawStack);
      if (typeof resolution === "string") {
        ctx.ui.notify(resolution, "error");
        return;
      }
      this.options.stackOverrides.set(agent, resolution.stack);
    }

    if (this.selected && sameAgent(this.selected.agent, agent)) {
      const next = this.resolveSelection(canonical);
      if (typeof next === "string") {
        restoreOverride(this.options.stackOverrides, agent, previousOverride);
        ctx.ui.notify(next, "error");
        return;
      }
      const error = await this.applySelection(next, ctx);
      if (error) {
        restoreOverride(this.options.stackOverrides, agent, previousOverride);
        ctx.ui.notify(error, "error");
        return;
      }
    } else {
      this.reconcileToolVisibility();
    }
    ctx.ui.notify(
      normalizeAgentId(rawStack) === "auto"
        ? `Stack override cleared for ${canonical}.`
        : `Stack ${JSON.stringify(rawStack)} selected for ${canonical}.`,
      "info",
    );
  }

  private agentItems(): RosterPickerItem[] {
    const baselineModel = this.baseline?.model;
    const baselineThinking = this.baseline?.thinking ?? "off";
    const items: RosterPickerItem[] = [
      {
        value: "default",
        label: `Pi default · Default${this.selected ? "" : " · Current"}`,
        description: "Use Pi's model, thinking level, prompt, and tools captured at session start.",
        secondary: `stack: default · model: ${formatModel(baselineModel)} · thinking: ${baselineThinking}`,
      },
    ];
    for (const canonical of this.options.registry.getPrimaryTypes()) {
      const agent = this.options.registry.resolveAgentConfig(canonical);
      const stack = this.resolveStack(agent);
      items.push({
        value: canonical,
        label: `${agent.displayName ?? agent.name}${
          this.selected?.name === canonical ? " · Current" : ""
        }`,
        description: agent.description,
        secondary:
          typeof stack === "string"
            ? stack
            : `stack: ${stack.stack} · model: ${formatModel(stack.model)} · thinking: ${stack.thinking ?? "off"}`,
      });
    }
    return items;
  }

  private stackCommandAgentTypes(): string[] {
    return this.selected ? [this.selected.name] : this.options.registry.getAvailableTypes();
  }

  private stackItems(rawAgent: string): RosterPickerItem[] {
    const canonical = this.options.registry.resolveType(rawAgent);
    if (!canonical) return [];
    const agent = this.options.registry.resolveAgentConfig(canonical);
    const override = this.options.stackOverrides.get(agent);
    const entries: Array<{ value: string; label: string; explicit?: string | undefined }> = [
      {
        value: "auto",
        label: `auto${override ? "" : " · Current override: auto"}`,
      },
      {
        value: "default",
        label: `default · Default${
          override && normalizeAgentId(override) === "default" ? " · Current override" : ""
        }`,
        explicit: "default",
      },
      ...this.availableStackNames(agent)
        .filter((stack) => stack !== "auto" && stack !== "default")
        .map((stack) => ({
          value: stack,
          label: `${stack}${
            override && normalizeAgentId(override) === normalizeAgentId(stack)
              ? " · Current override"
              : ""
          }`,
          explicit: stack,
        })),
    ];
    return entries.map((entry) => {
      const stack = this.previewStack(agent, entry.explicit);
      return {
        value: entry.value,
        label: entry.label,
        secondary:
          typeof stack === "string"
            ? stack
            : `model: ${formatModel(stack.model)} · thinking: ${stack.thinking ?? "off"}`,
      };
    });
  }

  private agentDisplayName(rawAgent: string): string {
    const canonical = this.options.registry.resolveType(rawAgent);
    if (!canonical) return rawAgent;
    const agent = this.options.registry.resolveAgentConfig(canonical);
    return agent.displayName ?? agent.name;
  }

  async reload(ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle();
    this.options.registry.reload();
    if (this.selected) {
      const canonical = this.options.registry.resolveType(this.selected.name);
      const next = canonical
        ? this.resolveSelection(canonical)
        : `Selected primary ${JSON.stringify(this.selected.name)} no longer exists.`;
      if (typeof next === "string") {
        const error = await this.applySelection(undefined, ctx);
        ctx.ui.notify(`${next} Restored default.${error ? ` ${error}` : ""}`, "warning");
      } else {
        const error = await this.applySelection(next, ctx);
        if (error) ctx.ui.notify(`Reload could not reapply ${canonical}: ${error}`, "error");
      }
    } else {
      this.delegationDenied = undefined;
      this.reconcileToolVisibility();
    }
    ctx.ui.notify("Agent definitions reloaded.", "info");
  }

  reconcileBeforeDelegation(): void {
    this.options.registry.reload();
    if (this.selected) {
      const name = this.selected.name;
      const next = this.resolveSelection(name);
      if (typeof next === "string" || !next) {
        this.delegationDenied =
          typeof next === "string"
            ? `Selected primary ${JSON.stringify(name)} is no longer eligible: ${next}`
            : `Selected primary ${JSON.stringify(name)} is no longer available.`;
      } else {
        this.selected = next;
        this.delegationDenied = undefined;
        this.options.footerStatus.setPrimary(next.agent.displayName ?? next.agent.name, next.stack);
      }
    }
    this.reconcileToolVisibility();
  }

  notify(message: string): void {
    this.ctx?.ui.notify(message, "warning");
  }

  /** Propagate the active stack name, with the primary's resolution as the child fallback. */
  getPropagatedStack() {
    if (!this.selected) return undefined;
    return {
      stack: this.selected.stack,
      fallbackModel: this.selected.model,
      fallbackThinking: this.selected.thinking,
    };
  }

  authorizeTarget(type: string): string | undefined {
    if (this.delegationDenied) return this.delegationDenied;
    const canonical = this.options.registry.resolveType(type);
    if (!canonical) return `Unknown agent type: ${JSON.stringify(type)}`;
    const target = this.options.registry.resolveAgentConfig(canonical);
    const mode = target.mode ?? "subagent";
    if (target.enabled === false || (mode !== "subagent" && mode !== "all")) {
      return `Agent type ${JSON.stringify(canonical)} is not available as a subagent`;
    }
    if (!this.selected?.agent.allowedAgents) return;
    const allowed = new Set(this.selected.agent.allowedAgents.map(normalizeAgentId));
    if (
      allowed.has(normalizeAgentId(canonical)) ||
      allowed.has(normalizeAgentId(target.id ?? target.name))
    )
      return;
    return `Primary agent ${JSON.stringify(this.selected.name)} is not authorized to delegate to ${JSON.stringify(canonical)}.`;
  }

  private resolveSelection(name: string, explicitStack?: string): Selection | undefined | string {
    if (normalizeAgentId(name) === "default") return undefined;
    const canonical = this.options.registry.resolveType(name);
    if (!canonical) return `Unknown primary agent ${JSON.stringify(name)}.`;
    const agent = this.options.registry.resolveAgentConfig(canonical);
    const mode = agent.mode ?? "subagent";
    if (agent.enabled === false || (mode !== "primary" && mode !== "all")) {
      return `Agent ${JSON.stringify(canonical)} is not an enabled primary/all agent.`;
    }
    const stack = this.resolveStack(agent, explicitStack);
    if (typeof stack === "string") return stack;
    if (stack.notice) this.ctx?.ui.notify(stack.notice.message, "warning");
    if (!stack.model) return `No available model resolved for agent ${JSON.stringify(canonical)}.`;

    const registered = this.options.pi.getAllTools().map((tool) => tool.name);
    const unknown = unknownPermissionToolNames(registered, agent.permission);
    if (unknown.length) {
      this.ctx?.ui.notify(
        `Agent ${JSON.stringify(canonical)} has permission entries for unknown tools: ${unknown.join(", ")}. Ignoring those entries.`,
        "warning",
      );
    }
    const tools = resolvePermittedToolNames(registered, agent.permission);
    return {
      name: canonical,
      agent,
      model: stack.model,
      thinking: stack.thinking,
      tools: [...tools],
      stack: stack.stack,
    };
  }

  private resolveStack(agent: AgentConfig, explicitStack?: string) {
    return this.previewStack(agent, explicitStack, this.options.stackOverrides.get(agent));
  }

  private availableStackNames(agent: AgentConfig): string[] {
    return [
      "auto",
      "default",
      ...[...(agent.stacks?.keys() ?? [])].filter(
        (stack) => !["auto", "default"].includes(normalizeAgentId(stack)),
      ),
    ];
  }

  private previewStack(agent: AgentConfig, explicitStack?: string, sessionOverride?: string) {
    if (!this.ctx) return "No active session.";
    const resolved = resolveAgentStack({
      agent,
      registry: this.ctx.modelRegistry,
      runtimeModel: this.baseline?.model,
      runtimeThinking: this.baseline?.thinking === "off" ? undefined : this.baseline?.thinking,
      explicitStack,
      sessionOverride,
    });
    return resolved.ok ? resolved.value : resolved.error;
  }

  private async applySelection(
    next: Selection | undefined,
    ctx: ExtensionContext,
  ): Promise<string | undefined> {
    const baseline = this.baseline;
    if (!baseline) return "No session baseline is available.";
    const previous = {
      model: ctx.model,
      thinking: this.options.pi.getThinkingLevel(),
      tools: this.options.pi.getActiveTools(),
      selected: this.selected,
      delegationDenied: this.delegationDenied,
    };
    const model = next?.model ?? baseline.model;
    const thinking: PiThinkingLevel = next ? (next.thinking ?? "off") : baseline.thinking;
    this.delegationDenied = undefined;
    const tools = this.visibleTools(next?.tools ?? baseline.tools, next);

    try {
      if (model && !(await this.options.pi.setModel(model))) {
        throw new Error(`No authentication is available for ${model.provider}/${model.id}.`);
      }
      this.options.pi.setThinkingLevel(thinking);
      this.options.pi.setActiveTools(tools);
      this.selected = next;
      this.delegationDenied = undefined;
    } catch (error) {
      const rollbackErrors: string[] = [];
      try {
        if (previous.model && !(await this.options.pi.setModel(previous.model)))
          rollbackErrors.push("model");
      } catch {
        rollbackErrors.push("model");
      }
      try {
        this.options.pi.setThinkingLevel(previous.thinking);
      } catch {
        rollbackErrors.push("thinking");
      }
      try {
        this.options.pi.setActiveTools(previous.tools);
      } catch {
        rollbackErrors.push("tools");
      }
      this.selected = previous.selected;
      this.delegationDenied = previous.delegationDenied;
      const message = error instanceof Error ? error.message : String(error);
      return rollbackErrors.length
        ? `${message} Rollback failed for: ${rollbackErrors.join(", ")}.`
        : message;
    }

    this.options.footerStatus.setPrimary(next?.agent.displayName ?? next?.agent.name, next?.stack);
  }

  dispose(): void {
    this.options.footerStatus.dispose();
    this.ctx = undefined;
  }

  private reconcileToolVisibility(): void {
    const active = this.options.pi.getActiveTools();
    const desired = this.selected?.tools ?? this.baseline?.tools ?? active;
    this.options.pi.setActiveTools(this.visibleTools(desired, this.selected, desired));
  }

  private visibleTools(tools: string[], selection = this.selected, desired = tools): string[] {
    const hasTarget =
      !this.delegationDenied &&
      this.options.registry.getSubagentTypes().some((type) => {
        if (!selection?.agent.allowedAgents) return true;
        const config = this.options.registry.resolveAgentConfig(type);
        const allowed = new Set(selection.agent.allowedAgents.map(normalizeAgentId));
        return (
          allowed.has(normalizeAgentId(type)) ||
          allowed.has(normalizeAgentId(config.id ?? config.name))
        );
      });
    const managed = new Set<string>(MANAGED_SUBAGENT_TOOLS);
    const unrelated = tools.filter((name) => !managed.has(name));
    if (!hasTarget) return unrelated;
    const registered = new Set(this.options.pi.getAllTools().map((tool) => tool.name));
    const wanted = selection ? new Set(desired) : new Set(MANAGED_SUBAGENT_TOOLS);
    return [
      ...unrelated,
      ...MANAGED_SUBAGENT_TOOLS.filter((name) => registered.has(name) && wanted.has(name)),
    ];
  }
}

function formatModel(model: Model<any> | undefined): string {
  return model ? `${model.provider}/${model.id}` : "none";
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function sameAgent(left: AgentConfig, right: AgentConfig): boolean {
  return normalizeAgentId(left.id ?? left.name) === normalizeAgentId(right.id ?? right.name);
}

function restoreOverride(
  overrides: AgentStackOverrides,
  agent: AgentConfig,
  previous: string | undefined,
): void {
  if (previous) overrides.set(agent, previous);
  else overrides.clear(agent);
}
