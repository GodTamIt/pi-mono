import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SubagentManagerObserver } from "../lifecycle/subagent-manager.ts";
import type { CompactionInfo, SessionMessage, Subagent } from "../types.ts";
import {
  type AgentDetails,
  describeActivity,
  formatContextPercent,
  formatMs,
  formatTurns,
  sanitizeTerminalText,
  type Theme,
} from "../ui/display.ts";
import { GLYPHS } from "../ui/glyphs.ts";
import { formatLifetimeTokens } from "./helpers.ts";

const MAX_BINDINGS = 128;
const MAX_ACTIVITY = 40;

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
  owner?: object | undefined;
};

/** Keeps settled native tool rows connected to their child while work continues. */
export class InvocationRowRegistry implements SubagentManagerObserver {
  private readonly bindings = new Map<string, Binding>();
  private readonly activitySnapshots = new Map<string, readonly string[]>();

  constructor(private readonly getRecord: (id: string) => Subagent | undefined) {}

  bind(
    toolCallId: string,
    agentId: string,
    invalidate: () => void,
    owner?: object,
    active = this.getRecord(agentId)?.isActive() ?? true,
  ): Binding {
    const key = bindingKey(toolCallId, agentId);
    const record = this.getRecord(agentId);
    let binding = this.bindings.get(key);
    if (!active) {
      binding?.unsubscribe?.();
      this.bindings.delete(key);
      const settled = {
        key,
        agentId,
        invalidate,
        activity: [...(binding?.activity ?? this.activitySnapshots.get(key) ?? [])],
        owner,
      };
      if (record && settled.activity.length === 0) this.rebuild(settled, record);
      this.activitySnapshots.set(key, settled.activity);
      this.trim();
      return settled;
    }
    if (!binding) {
      binding = { key, agentId, invalidate, activity: [], owner };
      this.bindings.set(key, binding);
      this.trim();
    } else if (binding.owner === owner) {
      binding.invalidate = invalidate;
      this.bindings.delete(key);
      this.bindings.set(key, binding);
    }
    if (record && binding.owner === owner) this.attachSession(binding, record);
    return binding;
  }

  owns(toolCallId: string, agentId: string, owner: object): boolean {
    const binding = this.bindings.get(bindingKey(toolCallId, agentId));
    return !binding || binding.owner === undefined || binding.owner === owner;
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
    this.bindings.delete(binding.key);
    this.trim();
    binding.invalidate();
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
  private suppressed = false;

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
    if (
      !this.suppressed &&
      isActive(details.status) &&
      details.agentId &&
      this.registry &&
      !this.registry.owns(this.toolCallId, details.agentId, this)
    ) {
      // Duplicate host for a live invocation: stay hidden permanently so two
      // identical rows never both appear once the record settles.
      this.suppressed = true;
    }
    if (this.suppressed) return [];
    const lines = collapsedLines(details, this.theme, width);
    if (this.expanded) {
      lines.push(
        ...expandedLines(
          details,
          record,
          this.resultText,
          this.toolCallId,
          this.registry,
          width,
          this.theme,
        ),
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
  if (details.agentId) {
    const record = getRecord(details.agentId);
    registry?.bind(
      context.toolCallId,
      details.agentId,
      context.invalidate,
      component,
      record ? record.isActive() : isActive(details.status),
    );
  }
  context.state.invocationRow = component;
  return component;
}

function collapsedLines(details: AgentDetails, theme: Theme, width: number): string[] {
  const status = statusPresentation(details.status);
  const separator = theme.fg("dim", " · ");
  const first = [
    theme.bold(sanitizeTerminalText(details.displayName)),
    theme.fg(status.color, `${status.icon} ${status.label}`),
  ].join(separator);
  const timing = `${formatMs(details.durationMs)} ${isActive(details.status) ? "elapsed" : "duration"}`;
  const metadata = packMetadata(
    [
      details.isBackground ? "Background" : "Foreground",
      `stack ${sanitizeTerminalText(details.stack ?? "—")}`,
      `model ${sanitizeTerminalText(details.modelName ?? "—")}`,
      `thinking ${sanitizeTerminalText(details.thinking ?? "—")}`,
      formatTurns(details.turnCount ?? 0, details.maxTurns),
      `${details.toolUses} ${details.toolUses === 1 ? "tool" : "tools"}`,
      formatContext(details.contextPercent),
      timing,
    ],
    width,
  );
  const summary = `${GLYPHS.subLine} Summary: ${sanitizeTerminalText(details.description)}`;
  const lines = [
    first,
    ...metadata.map((line) => theme.fg("dim", line)),
    theme.fg("muted", summary),
  ];
  if (isActive(details.status)) {
    lines.push(
      theme.fg(
        "accent",
        `${GLYPHS.subLine} Activity: ${sanitizeTerminalText(details.activity ?? "thinking…")}`,
      ),
    );
  }
  return lines;
}

/** Wrap compact metadata only between facts, never before an orphaned separator. */
function packMetadata(parts: readonly string[], width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const rows: string[] = [];
  let row = "";
  for (const part of parts) {
    const candidate = row ? `${row} · ${part}` : part;
    if (row && visibleWidth(candidate) > contentWidth) {
      rows.push(row);
      row = part;
    } else {
      row = candidate;
    }
  }
  if (row) rows.push(row);
  return rows.map((line, index) => `${index === 0 ? `${GLYPHS.subLine} ` : "  "}${line}`);
}

function expandedLines(
  details: AgentDetails,
  record: Subagent | undefined,
  resultText: string,
  toolCallId: string,
  registry: InvocationRowRegistry | undefined,
  width: number,
  theme: Theme,
): string[] {
  const status = statusPresentation(details.status);
  const execution = details.isBackground ? "Background" : "Foreground";
  const compactions = record?.compactionCount ?? details.compactions ?? 0;
  const heading = (label: string) => theme.fg("toolTitle", theme.bold(label));
  const lines = [
    "",
    heading("Task"),
    `  ${sanitizeTerminalText(details.task ?? record?.task ?? details.description)}`,
    heading("Run details"),
    `  ${status.label} · ${execution}`,
    `  Turns: ${details.turnCount ?? 0}/${details.maxTurns ?? "unlimited"} · grace: ${details.graceTurns ?? "unlimited"} · tool uses: ${details.toolUses}`,
    `  Usage: ${details.tokens || "0 tokens"} · ${formatContext(record ? record.getContextPercent() : details.contextPercent)} · ${compactions} compaction${compactions === 1 ? "" : "s"}`,
    `  Started: ${record ? new Date(record.startedAt).toISOString() : "not available"} · ${isActive(details.status) ? "elapsed" : "duration"}: ${formatMs(details.durationMs)}`,
    heading("Identifiers"),
    `  Agent ID: ${sanitizeTerminalText(details.agentId ?? "unknown")}`,
    `  Child session ID: ${sanitizeTerminalText(record?.childSessionId ?? details.childSessionId ?? "not available")}`,
    heading("Activity"),
  ];
  const activity =
    details.agentId && registry
      ? registry.getActivity(toolCallId, details.agentId)
      : details.activity
        ? [details.activity]
        : [];
  lines.push(
    ...(activity.length
      ? activity.map((item) => `  ${GLYPHS.subLine} ${sanitizeTerminalText(item)}`)
      : [`  ${GLYPHS.subLine} No child activity yet.`]),
  );
  lines.push(heading("Current/final output"));
  const output =
    record?.result ?? record?.error ?? record?.responseText ?? details.output ?? resultText;
  const outputLines = wrapTextWithAnsi(
    sanitizeOutput(output || "No output."),
    Math.max(1, width - 2),
  );
  lines.push(...outputLines.map((line) => `  ${line}`));

  const conversation =
    !details.isBackground && !isActive(details.status) ? record?.getConversation() : undefined;
  if (conversation) {
    lines.push("", heading("Child conversation"));
    const conversationLines = wrapTextWithAnsi(
      sanitizeTerminalText(conversation, true),
      Math.max(1, width - 2),
    );
    lines.push(...conversationLines.map((line) => `  ${line}`));
  }
  lines.push("", theme.fg("dim", "Read-only transcript · /subagents:sessions"));
  return lines;
}

function detailsFromRecord(base: AgentDetails, record: Subagent): AgentDetails {
  return {
    ...base,
    status: record.status,
    description: record.description,
    activity: isActive(record.status)
      ? describeActivity(record.activeTools, record.responseText)
      : statusText(record.status),
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
    contextPercent: record.getContextPercent(),
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

type StatusColor = "muted" | "accent" | "success" | "warning" | "dim" | "error";

function statusPresentation(status: string): { label: string; color: StatusColor; icon: string } {
  switch (status) {
    case "queued":
      return { label: "queued", color: "muted", icon: GLYPHS.queued };
    case "running":
      return { label: "running", color: "accent", icon: GLYPHS.toolCall };
    case "completed":
      return { label: "completed", color: "success", icon: GLYPHS.success };
    case "steered":
      return { label: "completed (turn limit)", color: "warning", icon: GLYPHS.success };
    case "aborted":
      return { label: "aborted (max turns)", color: "warning", icon: GLYPHS.failure };
    case "stopped":
      return { label: "stopped", color: "dim", icon: GLYPHS.stopped };
    default:
      return { label: "failed", color: "error", icon: GLYPHS.failure };
  }
}

function statusText(status: string): string {
  return statusPresentation(status).label;
}

function isActive(status: string): boolean {
  return status === "queued" || status === "running";
}

function formatContext(percent: number | null | undefined): string {
  return percent == null ? "? context" : `${formatContextPercent(percent)} context`;
}

function bindingKey(toolCallId: string, agentId: string): string {
  return `${toolCallId}\u0000${agentId}`;
}
