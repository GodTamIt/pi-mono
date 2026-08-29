import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SubagentManagerObserver } from "../lifecycle/subagent-manager.ts";
import type { CompactionInfo, SessionMessage, Subagent } from "../types.ts";
import { sanitizeTerminalText, type AgentDetails, formatMs, type Theme } from "../ui/display.ts";
import { formatLifetimeTokens } from "./helpers.ts";

const MAX_BINDINGS = 128;
const MAX_ACTIVITY = 40;
const MAX_OUTPUT_LINES = 50;

type RenderState = { invocationRow?: InvocationRowComponent };
export interface InvocationRowRenderContext {
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: RenderState;
  expanded: boolean;
}
type Binding = {
  key: string;
  agentId: string;
  sessionId?: string;
  invalidate: () => void;
  unsubscribe?: (() => void) | undefined;
  activity: string[];
};

/** Keeps settled native tool rows connected to their child while work continues. */
export class InvocationRowRegistry implements SubagentManagerObserver {
  private readonly bindings = new Map<string, Binding>();
  private readonly activitySnapshots = new Map<string, readonly string[]>();

  constructor(private readonly getRecord: (id: string) => Subagent | undefined) {}

  bind(toolCallId: string, agentId: string, invalidate: () => void): Binding {
    const key = bindingKey(toolCallId, agentId);
    const record = this.getRecord(agentId);
    let binding = this.bindings.get(key);
    if (record && !record.isActive()) {
      binding?.unsubscribe?.();
      this.bindings.delete(key);
      const settled = {
        key,
        agentId,
        invalidate,
        activity: [...(binding?.activity ?? this.activitySnapshots.get(key) ?? [])],
      };
      if (settled.activity.length === 0) this.rebuild(settled, record);
      this.activitySnapshots.set(key, settled.activity);
      this.trim();
      return settled;
    }
    if (!binding) {
      binding = { key, agentId, invalidate, activity: [] };
      this.bindings.set(key, binding);
      this.trim();
    } else {
      binding.invalidate = invalidate;
      this.bindings.delete(key);
      this.bindings.set(key, binding);
    }
    if (record) this.attachSession(binding, record);
    return binding;
  }

  getActivity(toolCallId: string, agentId: string): readonly string[] {
    const key = bindingKey(toolCallId, agentId);
    return this.bindings.get(key)?.activity ?? this.activitySnapshots.get(key) ?? [];
  }

  onSubagentCreated(record: Subagent): void {
    this.refresh(record, `queued · ${record.description}`);
  }

  onSubagentStarted(record: Subagent): void {
    this.refresh(record, "started");
  }

  onSubagentSessionCreated(record: Subagent): void {
    const binding = this.find(record);
    if (!binding) return;
    this.attachSession(binding, record);
    this.push(binding, "child session created");
    binding.invalidate();
  }

  onSubagentCompleted(record: Subagent): void {
    this.finish(record);
  }

  onSubagentResumed(record: Subagent): void {
    this.finish(record);
  }

  onSubagentCompacted(record: Subagent, _info: CompactionInfo): void {
    const binding = this.find(record);
    if (!binding) return;
    this.rebuild(binding, record);
    this.push(binding, "context compacted");
    binding.invalidate();
  }

  clear(): void {
    for (const binding of this.bindings.values()) binding.unsubscribe?.();
    this.bindings.clear();
    this.activitySnapshots.clear();
  }

  dispose(): void {
    this.clear();
  }

  private refresh(record: Subagent, activity?: string): void {
    const binding = this.find(record);
    if (!binding) return;
    if (activity) this.push(binding, activity);
    this.attachSession(binding, record);
    binding.invalidate();
  }

  private finish(record: Subagent): void {
    const binding = this.find(record);
    if (!binding) return;
    this.push(binding, statusText(record.status));
    binding.unsubscribe?.();
    binding.unsubscribe = undefined;
    this.activitySnapshots.set(binding.key, [...binding.activity]);
    this.trim();
    binding.invalidate();
    this.bindings.delete(binding.key);
  }

  private find(record: Subagent): Binding | undefined {
    if (!record.toolCallId) return undefined;
    return this.bindings.get(bindingKey(record.toolCallId, record.id));
  }

  private attachSession(binding: Binding, record: Subagent): void {
    const sessionId = record.childSessionId;
    if (!sessionId || binding.sessionId === sessionId) return;
    binding.unsubscribe?.();
    binding.sessionId = sessionId;
    this.rebuild(binding, record);
    binding.unsubscribe = record.subscribeToUpdates((event) => {
      this.applyEvent(binding, record, event);
      binding.invalidate();
    });
  }

  private applyEvent(binding: Binding, record: Subagent, event: AgentSessionEvent): void {
    switch (event.type) {
      case "tool_execution_start":
        this.push(binding, `tool · ${event.toolName}`);
        break;
      case "tool_execution_end":
        this.push(binding, `tool · ${event.toolName} · finished`);
        break;
      case "turn_end":
        this.push(binding, `turn ${record.turnCount} completed`);
        break;
      case "compaction_end":
        this.rebuild(binding, record);
        this.push(binding, "context compacted");
        break;
      case "agent_end":
        this.rebuild(binding, record);
        this.push(binding, "run completed");
        break;
    }
  }

  private rebuild(binding: Binding, record: Subagent): void {
    const rebuilt: string[] = [];
    for (const message of record.agentMessages) appendMessageActivity(rebuilt, message);
    binding.activity = rebuilt.slice(-MAX_ACTIVITY).map((item) => sanitizeTerminalText(item));
  }

  private push(binding: Binding, item: string): void {
    const safeItem = sanitizeTerminalText(item);
    if (binding.activity.at(-1) === safeItem) return;
    binding.activity.push(safeItem);
    if (binding.activity.length > MAX_ACTIVITY) binding.activity.shift();
  }

  private trim(): void {
    while (this.bindings.size > MAX_BINDINGS) {
      const oldest = this.bindings.entries().next().value as [string, Binding] | undefined;
      if (!oldest) return;
      oldest[1].unsubscribe?.();
      this.bindings.delete(oldest[0]);
    }
    while (this.activitySnapshots.size > MAX_BINDINGS) {
      const oldest = this.activitySnapshots.keys().next().value as string | undefined;
      if (!oldest) return;
      this.activitySnapshots.delete(oldest);
    }
  }
}

/** Width-aware native component retained by ToolExecutionComponent after settlement. */
export class InvocationRowComponent implements Component {
  private expanded = false;

  constructor(
    private readonly toolCallId: string,
    private details: AgentDetails,
    private resultText: string,
    private theme: Theme,
    private readonly registry: InvocationRowRegistry | undefined,
    private readonly getRecord: (id: string) => Subagent | undefined,
  ) {}

  update(details: AgentDetails, resultText: string, expanded: boolean, theme: Theme): void {
    this.details = details;
    this.resultText = resultText;
    this.expanded = expanded;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const record = this.details.agentId ? this.getRecord(this.details.agentId) : undefined;
    const details = record ? detailsFromRecord(this.details, record) : this.details;
    const lines = collapsedLines(details, this.theme);
    if (this.expanded) {
      lines.push(
        ...expandedLines(details, record, this.resultText, this.toolCallId, this.registry, width),
      );
    }
    return lines.flatMap((line) => wrapTextWithAnsi(line, width));
  }
}

export function renderInvocationRow(
  details: AgentDetails,
  resultText: string,
  theme: Theme,
  context: InvocationRowRenderContext,
  registry: InvocationRowRegistry | undefined,
  getRecord: (id: string) => Subagent | undefined,
): InvocationRowComponent {
  if (details.agentId) registry?.bind(context.toolCallId, details.agentId, context.invalidate);
  const component =
    context.lastComponent instanceof InvocationRowComponent
      ? context.lastComponent
      : new InvocationRowComponent(
          context.toolCallId,
          details,
          resultText,
          theme,
          registry,
          getRecord,
        );
  component.update(details, resultText, context.expanded, theme);
  context.state.invocationRow = component;
  return component;
}

function collapsedLines(details: AgentDetails, theme: Theme): string[] {
  const status = statusText(details.status);
  const first = ["Subagent", sanitizeTerminalText(details.displayName), status]
    .map((part, index) => (index === 0 ? theme.fg("toolTitle", theme.bold(part)) : part))
    .join(theme.fg("dim", " · "));
  const timing = `${isActive(details.status) ? "elapsed" : "duration"}: ${formatMs(details.durationMs)}`;
  const metadata = [
    details.isBackground ? "Background" : "Foreground",
    `stack: ${sanitizeTerminalText(details.stack ?? "—")}`,
    `model: ${sanitizeTerminalText(details.modelName ?? "—")}`,
    `thinking: ${sanitizeTerminalText(details.thinking ?? "—")}`,
    timing,
  ].join(" · ");
  return [first, theme.fg("dim", metadata)];
}

function expandedLines(
  details: AgentDetails,
  record: Subagent | undefined,
  resultText: string,
  toolCallId: string,
  registry: InvocationRowRegistry | undefined,
  width: number,
): string[] {
  const lines = [
    "",
    `Task: ${sanitizeTerminalText(details.task ?? record?.task ?? details.description)}`,
    `Agent: ${sanitizeTerminalText(details.displayName)} · ${statusText(details.status)} · ${details.isBackground ? "Background" : "Foreground"} · stack: ${sanitizeTerminalText(details.stack ?? "—")} · model: ${sanitizeTerminalText(details.modelName ?? "—")} · thinking: ${sanitizeTerminalText(details.thinking ?? "—")}`,
    `Agent ID: ${sanitizeTerminalText(details.agentId ?? "unknown")}`,
    `Child session ID: ${sanitizeTerminalText(record?.childSessionId ?? details.childSessionId ?? "not available")}`,
    `Timing: started ${record ? new Date(record.startedAt).toISOString() : "not available"} · ${isActive(details.status) ? "elapsed" : "duration"}: ${formatMs(details.durationMs)}`,
    `Budgets: turns ${details.turnCount ?? 0}/${details.maxTurns ?? "unlimited"} · grace ${details.graceTurns ?? "unlimited"}`,
    `Tool uses: ${details.toolUses}`,
    `Tokens/context/compactions: ${details.tokens || "0 token"} · ${formatContext(record?.getContextPercent())} · ${record?.compactionCount ?? details.compactions ?? 0} compactions`,
    "Activity:",
  ];
  const activity =
    details.agentId && registry
      ? registry.getActivity(toolCallId, details.agentId)
      : details.activity
        ? [details.activity]
        : [];
  lines.push(
    ...(activity.length ? activity.map((item) => `  ${item}`) : ["  No child activity yet."]),
  );
  lines.push("Current/final output:");
  const output =
    record?.result ?? record?.error ?? record?.responseText ?? details.output ?? resultText;
  const outputLines = wrapTextWithAnsi(
    sanitizeOutput(output || "No output."),
    Math.max(1, width - 2),
  );
  lines.push(...outputLines.slice(0, MAX_OUTPUT_LINES).map((line) => `  ${line}`));
  if (outputLines.length > MAX_OUTPUT_LINES) lines.push("  … output truncated to 50 lines");
  lines.push("Read-only transcript: /subagents:sessions");
  return lines;
}

function detailsFromRecord(base: AgentDetails, record: Subagent): AgentDetails {
  return {
    ...base,
    status: record.status,
    agentId: record.id,
    childSessionId: record.childSessionId,
    task: record.task,
    isBackground: record.execution.isBackground,
    stack: record.invocation?.stack,
    modelName: record.invocation?.modelName ?? base.modelName,
    thinking: record.invocation?.thinking,
    turnCount: record.turnCount,
    maxTurns: record.maxTurns,
    graceTurns: record.graceTurns,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    compactions: record.compactionCount,
    output: record.result ?? record.error ?? record.responseText,
    error: record.error,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
  };
}

function appendMessageActivity(into: string[], message: SessionMessage): void {
  if (message.role === "assistant") {
    for (const content of message.content) {
      if (content.type === "toolCall") into.push(`tool · ${content.name}`);
    }
    if (message.content.some((content) => content.type === "text")) into.push("assistant response");
  } else if (message.role === "toolResult") {
    into.push(`tool result · ${message.toolName}`);
  } else if (message.role === "compactionSummary") {
    into.push("context compacted");
  }
}

function sanitizeOutput(output: string): string {
  return sanitizeTerminalText(output, true);
}

function statusText(status: string): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "steered":
      return "completed (turn limit)";
    case "aborted":
      return "aborted (max turns)";
    case "stopped":
      return "stopped";
    default:
      return "failed";
  }
}

function isActive(status: string): boolean {
  return status === "queued" || status === "running";
}

function formatContext(percent: number | null | undefined): string {
  return percent == null ? "context unknown" : `${Math.round(percent)}% context`;
}

function bindingKey(toolCallId: string, agentId: string): string {
  return `${toolCallId}\u0000${agentId}`;
}
