import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
const CALL_SUMMARY_MAX = 80;

type RenderState = {
  invocationRow?: InvocationRowComponent;
  /** Set while a rich invocation row owns the summary; the call slot then omits its duplicate. */
  subagentCallSummarySuppressed?: boolean;
};
export interface InvocationRowRenderContext {
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: RenderState;
  expanded: boolean;
  /** Host settlement boundary: false once the native tool result is final. */
  isPartial: boolean;
}

/**
 * Plain, render-ready row data. Live rows rebuild it from the child record;
 * settled rows freeze one copy so no later render can observe child mutation.
 */
type InvocationRowView = {
  details: AgentDetails;
  resultText: string;
  activity: readonly string[];
  output: string;
  conversation?: string | undefined;
  childSessionId?: string | undefined;
  startedAt?: number | undefined;
  /** Accepted background launch receipt: no live status, counters, or activity. */
  accepted: boolean;
};
type Binding = {
  key: string;
  agentId: string;
  sessionId?: string;
  invalidate: () => void;
  unsubscribe?: (() => void) | undefined;
  activity: string[];
  owner?: object | undefined;
};

/** Tracks live native rows while their child runs and settles them into immutable receipts. */
export class InvocationRowRegistry implements SubagentManagerObserver {
  private readonly bindings = new Map<string, Binding>();
  private readonly activitySnapshots = new Map<string, readonly string[]>();
  private readonly settledOwners = new Map<string, object>();

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
    const key = bindingKey(toolCallId, agentId);
    const binding = this.bindings.get(key);
    if (binding) return binding.owner === undefined || binding.owner === owner;
    const settled = this.settledOwners.get(key);
    return settled === undefined || settled === owner;
  }

  /**
   * Freeze a row at host settlement: drop any live child subscription and claim
   * the key so the first host keeps the receipt while duplicates stay hidden.
   */
  settle(toolCallId: string, agentId: string, owner: object): void {
    const key = bindingKey(toolCallId, agentId);
    const binding = this.bindings.get(key);
    if (binding) {
      binding.unsubscribe?.();
      this.bindings.delete(key);
    }
    if (!this.settledOwners.has(key)) this.settledOwners.set(key, owner);
    this.trim();
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
    this.settledOwners.clear();
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
    while (this.settledOwners.size > MAX_BINDINGS) {
      const oldest = this.settledOwners.keys().next().value as string | undefined;
      if (!oldest) return;
      this.settledOwners.delete(oldest);
    }
  }
}

/** Width-aware native component retained by ToolExecutionComponent after settlement. */
export class InvocationRowComponent implements Component {
  private expanded: boolean;
  private theme: Theme;
  private suppressed = false;
  private settled = false;
  private view: InvocationRowView;

  constructor(
    private readonly toolCallId: string,
    details: AgentDetails,
    resultText: string,
    theme: Theme,
    private readonly registry: InvocationRowRegistry | undefined,
    private readonly getRecord: (id: string) => Subagent | undefined,
  ) {
    this.expanded = false;
    this.theme = theme;
    this.view = this.buildLiveView(details, resultText);
  }

  /** A settled row never re-reads the child record. */
  isSettled(): boolean {
    return this.settled;
  }

  /**
   * Update a still-partial row from the live record. Once settled, this only
   * reuses the frozen snapshot with the new presentation (expand/theme).
   */
  update(details: AgentDetails, resultText: string, expanded: boolean, theme: Theme): void {
    if (!this.settled) this.view = this.buildLiveView(details, resultText);
    this.expanded = expanded;
    this.theme = theme;
  }

  /** Freeze the row at host settlement; later calls only refresh presentation. */
  settle(details: AgentDetails, resultText: string, expanded: boolean, theme: Theme): void {
    if (!this.settled) {
      this.view = this.buildSettledView(details, resultText);
      this.settled = true;
    }
    this.expanded = expanded;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const view = this.view;
    const agentId = view.details.agentId;
    if (
      !this.suppressed &&
      agentId &&
      this.registry &&
      !this.registry.owns(this.toolCallId, agentId, this)
    ) {
      // Duplicate host for one invocation: stay hidden permanently so two
      // identical rows never both appear.
      this.suppressed = true;
    }
    if (this.suppressed) return [];
    const lines = collapsedLines(view, this.theme, width);
    if (this.expanded) {
      lines.push(...expandedLines(view, width, this.theme));
    }
    return lines.flatMap((line) => wrapTextWithAnsi(line, width));
  }

  private buildLiveView(details: AgentDetails, resultText: string): InvocationRowView {
    const record = details.agentId ? this.getRecord(details.agentId) : undefined;
    const merged = record ? detailsFromRecord(details, record) : details;
    const activity =
      details.agentId && this.registry
        ? [...this.registry.getActivity(this.toolCallId, details.agentId)]
        : merged.activity
          ? [merged.activity]
          : [];
    return {
      details: merged,
      resultText,
      activity,
      output:
        record?.result ?? record?.error ?? record?.responseText ?? details.output ?? resultText,
      conversation:
        !merged.isBackground && !isActive(merged.status) ? record?.getConversation() : undefined,
      childSessionId: record?.childSessionId ?? merged.childSessionId,
      startedAt: record?.startedAt,
      accepted: false,
    };
  }

  private buildSettledView(details: AgentDetails, resultText: string): InvocationRowView {
    // Copy first: the host reuses its result object, and a frozen receipt must
    // not observe anything the producer might later write into it.
    const snapshot = { ...details };
    // A background launch result is final the moment the tool returns; render it
    // as an accepted receipt rather than freezing a transient running status.
    if (snapshot.isBackground) {
      return {
        details: snapshot,
        resultText,
        activity: [],
        output: "",
        conversation: undefined,
        childSessionId: snapshot.childSessionId,
        startedAt: undefined,
        accepted: true,
      };
    }
    const record = details.agentId ? this.getRecord(details.agentId) : undefined;
    // A record that is active again (resumed) must not backfill a historical
    // restored row; its persisted details are all the snapshot it gets.
    if (record?.isActive()) {
      return {
        details: snapshot,
        resultText,
        activity: snapshot.activity ? [snapshot.activity] : [],
        output: snapshot.output ?? resultText,
        conversation: undefined,
        childSessionId: snapshot.childSessionId,
        startedAt: undefined,
        accepted: false,
      };
    }
    return this.buildLiveView(snapshot, resultText);
  }
}

/**
 * Call-slot preview of the delegated task. The suppression flag is read at
 * render time, not construction, because the result slot decides on a later
 * update whether its rich row owns the summary.
 */
export class SubagentCallComponent implements Component {
  constructor(
    private readonly args: { description?: unknown; task?: unknown } | undefined,
    private readonly theme: Theme,
    private readonly context: InvocationRowRenderContext,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const title = truncateToWidth(
      this.theme.fg("toolTitle", this.theme.bold("Subagent")),
      width,
      "…",
    );
    if (this.context.state.subagentCallSummarySuppressed) return [title];
    const preview = callSummaryPreview(this.args);
    if (!preview) return [title];
    return [
      title,
      truncateToWidth(this.theme.fg("muted", `${GLYPHS.subLine} Summary: ${preview}`), width, "…"),
    ];
  }
}

function callSummaryPreview(
  args: { description?: unknown; task?: unknown } | undefined,
): string | undefined {
  const candidate = (value: unknown): string =>
    typeof value === "string" ? sanitizeTerminalText(value).replace(/\s+/g, " ").trim() : "";
  const collapsed = candidate(args?.description) || candidate(args?.task);
  return collapsed ? truncateToWidth(collapsed, CALL_SUMMARY_MAX, "…") : undefined;
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
  if (!component.isSettled()) {
    if (context.isPartial) {
      component.update(details, resultText, context.expanded, theme);
      if (details.agentId) {
        registry?.bind(context.toolCallId, details.agentId, context.invalidate, component, true);
      }
    } else {
      component.settle(details, resultText, context.expanded, theme);
      if (details.agentId) registry?.settle(context.toolCallId, details.agentId, component);
    }
  } else {
    component.update(details, resultText, context.expanded, theme);
  }
  context.state.invocationRow = component;
  return component;
}

function collapsedLines(view: InvocationRowView, theme: Theme, width: number): string[] {
  const details = view.details;
  const status = view.accepted ? ACCEPTED_STATUS : statusPresentation(details.status);
  const separator = theme.fg("dim", " · ");
  const first = [
    theme.bold(sanitizeTerminalText(details.displayName)),
    theme.fg(status.color, `${status.icon} ${status.label}`),
  ].join(separator);
  const parts = [
    details.isBackground ? "Background" : "Foreground",
    `stack ${sanitizeTerminalText(details.stack ?? "—")}`,
    `model ${sanitizeTerminalText(details.modelName ?? "—")}`,
    `thinking ${sanitizeTerminalText(details.thinking ?? "—")}`,
  ];
  if (!view.accepted) {
    const timing = `${formatMs(details.durationMs)} ${isActive(details.status) ? "elapsed" : "duration"}`;
    parts.push(
      formatTurns(details.turnCount ?? 0, details.maxTurns),
      `${details.toolUses} ${details.toolUses === 1 ? "tool" : "tools"}`,
      formatContext(details.contextPercent),
      timing,
    );
  }
  const metadata = packMetadata(parts, width);
  const summary = `${GLYPHS.subLine} Summary: ${sanitizeTerminalText(details.description)}`;
  const lines = [
    first,
    ...metadata.map((line) => theme.fg("dim", line)),
    theme.fg("muted", summary),
  ];
  if (view.accepted) {
    lines.push(
      theme.fg("dim", `${GLYPHS.subLine} get_subagent_result or /subagents:sessions for status`),
    );
  } else if (isActive(details.status)) {
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

function expandedLines(view: InvocationRowView, width: number, theme: Theme): string[] {
  const heading = (label: string) => theme.fg("toolTitle", theme.bold(label));
  const details = view.details;
  if (view.accepted) {
    return [
      "",
      heading("Task"),
      `  ${sanitizeTerminalText(details.task ?? details.description)}`,
      heading("Run details"),
      `  ${ACCEPTED_STATUS.label} · Background`,
      heading("Identifiers"),
      `  Agent ID: ${sanitizeTerminalText(details.agentId ?? "unknown")}`,
      `  Child session ID: ${sanitizeTerminalText(view.childSessionId ?? "not available")}`,
      "",
      theme.fg("dim", "Read-only receipt · get_subagent_result or /subagents:sessions for status"),
    ];
  }
  const status = statusPresentation(details.status);
  const execution = details.isBackground ? "Background" : "Foreground";
  const compactions = details.compactions ?? 0;
  const lines = [
    "",
    heading("Task"),
    `  ${sanitizeTerminalText(details.task ?? details.description)}`,
    heading("Run details"),
    `  ${status.label} · ${execution}`,
    `  Turns: ${details.turnCount ?? 0}/${details.maxTurns ?? "unlimited"} · grace: ${details.graceTurns ?? "unlimited"} · tool uses: ${details.toolUses}`,
    `  Usage: ${details.tokens || "0 tokens"} · ${formatContext(details.contextPercent)} · ${compactions} compaction${compactions === 1 ? "" : "s"}`,
    `  Started: ${view.startedAt != null ? new Date(view.startedAt).toISOString() : "not available"} · ${isActive(details.status) ? "elapsed" : "duration"}: ${formatMs(details.durationMs)}`,
    heading("Identifiers"),
    `  Agent ID: ${sanitizeTerminalText(details.agentId ?? "unknown")}`,
    `  Child session ID: ${sanitizeTerminalText(view.childSessionId ?? "not available")}`,
    heading("Activity"),
  ];
  lines.push(
    ...(view.activity.length
      ? view.activity.map((item) => `  ${GLYPHS.subLine} ${sanitizeTerminalText(item)}`)
      : [`  ${GLYPHS.subLine} No child activity yet.`]),
  );
  lines.push(heading("Current/final output"));
  const outputLines = wrapTextWithAnsi(
    sanitizeOutput(view.output || "No output."),
    Math.max(1, width - 2),
  );
  lines.push(...outputLines.map((line) => `  ${line}`));

  if (view.conversation) {
    lines.push("", heading("Child conversation"));
    const conversationLines = wrapTextWithAnsi(
      sanitizeTerminalText(view.conversation, true),
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

const ACCEPTED_STATUS = {
  label: "Background request accepted",
  color: "muted" as StatusColor,
  icon: GLYPHS.queued,
};

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
