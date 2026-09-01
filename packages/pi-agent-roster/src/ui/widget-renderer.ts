/** Pure, width-aware rendering for the background-agent widget. */

import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "../config/agent-types.ts";
import { isActiveStatus, type SubagentStatus } from "../lifecycle/subagent-state.ts";
import type { LifetimeUsage } from "../lifecycle/usage.ts";
import type { SubagentType } from "../types.ts";
import {
  formatContextPercent,
  formatMs,
  getDisplayName,
  getPromptModeLabel,
  sanitizeTerminalText,
  type Theme,
} from "./display.ts";
import { GLYPHS, SPINNER } from "./glyphs.ts";

export interface WidgetAgent {
  readonly id: string;
  readonly type: SubagentType;
  readonly status: SubagentStatus;
  readonly description: string;
  readonly toolUses: number;
  readonly startedAt: number;
  readonly completedAt?: number | undefined;
  readonly error?: string | undefined;
  readonly lifetimeUsage?: Readonly<LifetimeUsage> | undefined;
  readonly compactionCount: number;
  readonly turnCount: number;
  readonly maxTurns?: number | undefined;
  readonly graceTurns?: number | undefined;
  readonly stack?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  readonly contextPercent: number | null;
}

const MAX_WIDGET_LINES = 12;

type StatusColor = "accent" | "muted" | "success" | "error" | "warning" | "dim";

function statusPresentation(status: SubagentStatus): {
  text: string;
  color: StatusColor;
  icon: string;
} {
  switch (status) {
    case "queued":
      return { text: "queued", color: "warning", icon: GLYPHS.queued };
    case "running":
      return { text: "running", color: "accent", icon: "" };
    case "completed":
      return { text: "completed", color: "success", icon: GLYPHS.success };
    case "error":
      return { text: "failed", color: "error", icon: GLYPHS.failure };
    case "aborted":
      return { text: "aborted", color: "warning", icon: GLYPHS.failure };
    case "stopped":
      return { text: "stopped", color: "dim", icon: GLYPHS.stopped };
    case "steered":
      return { text: "steered (turn limit)", color: "warning", icon: GLYPHS.success };
  }
}

function identity(
  agent: WidgetAgent,
  registry: AgentConfigLookup,
  theme: Theme,
  icon: string,
): string {
  const name = sanitizeTerminalText(getDisplayName(agent.type, registry));
  const mode = getPromptModeLabel(agent.type, registry);
  const status = statusPresentation(agent.status);
  const modeText = mode ? theme.fg("dim", ` (${mode})`) : "";
  const prefix = icon || status.icon;
  return `${theme.fg(status.color, prefix)} ${theme.bold(name)}${modeText}  ${theme.fg("dim", "Background · ")}${theme.fg(status.color, status.text)}`.trimStart();
}

function shortModel(model: string | undefined): string {
  const safe = sanitizeTerminalText(model ?? "—");
  const name = safe.split("/").at(-1) ?? safe;
  return name
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d+(?:-\d+)*$/, "");
}

function activeMetadata(agent: WidgetAgent, now: number, compact: boolean): string[] {
  const elapsed = formatMs(now - agent.startedAt);
  const turns = `${agent.turnCount}/${agent.maxTurns ?? "∞"}`;
  const context = agent.contextPercent == null ? "?" : formatContextPercent(agent.contextPercent);
  const stack = sanitizeTerminalText(agent.stack ?? "—");
  const model = shortModel(agent.model);
  if (compact) {
    return [elapsed, `${GLYPHS.turns}${turns}`, `${agent.toolUses}t`, context, `${stack}/${model}`];
  }
  return [
    `elapsed: ${elapsed}`,
    `turns: ${turns}`,
    `tools: ${agent.toolUses}`,
    `context: ${context}`,
    `stack: ${stack}`,
    `model: ${sanitizeTerminalText(agent.model ?? "—")}`,
  ];
}

/** Pack metadata at semantic boundaries; only an individually over-wide value is truncated. */
function packParts(parts: readonly string[], width: number): string[] {
  const available = Math.max(1, width);
  const rows: string[] = [];
  let row = "";
  for (const part of parts) {
    const safePart = visibleWidth(part) <= available ? part : clipToWidth(part, available);
    const candidate = row ? `${row} · ${safePart}` : safePart;
    if (row && visibleWidth(candidate) > available) {
      rows.push(row);
      row = safePart;
    } else {
      row = candidate;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/** Legacy single-agent formatter retained for focused consumers and tests. */
export function renderFinishedLine(
  agent: WidgetAgent,
  registry: AgentConfigLookup,
  theme: Theme,
): string {
  const duration = formatMs((agent.completedAt ?? Date.now()) - agent.startedAt);
  const error =
    agent.status === "error" && agent.error
      ? ` · ${sanitizeTerminalText(agent.error).slice(0, 60)}`
      : "";
  return `${identity(agent, registry, theme, "")} · duration: ${duration} · ${sanitizeTerminalText(agent.description)}${error}`;
}

/** Legacy two-line formatter retained for focused consumers and tests. */
export function renderRunningLines(
  agent: WidgetAgent,
  registry: AgentConfigLookup,
  spinnerFrame: number,
  theme: Theme,
): [header: string, activity: string] {
  const frame = SPINNER[spinnerFrame % SPINNER.length] ?? "";
  const header = `${identity(agent, registry, theme, frame)} · ${activeMetadata(agent, Date.now(), false).join(" · ")}`;
  return [
    header,
    theme.fg("muted", `${GLYPHS.subLine} ${sanitizeTerminalText(agent.description)}`),
  ];
}

interface RenderBlock {
  status: SubagentStatus;
  lines: string[];
}

function activeBlock(
  agent: WidgetAgent,
  registry: AgentConfigLookup,
  spinnerFrame: number,
  theme: Theme,
  width: number,
  now: number,
): RenderBlock {
  const contentWidth = Math.max(1, width - 4);
  const frame =
    agent.status === "running" ? (SPINNER[spinnerFrame % SPINNER.length] ?? "") : GLYPHS.queued;
  const first = identity(agent, registry, theme, frame);
  const separator = theme.fg("dim", " · ");
  const withFacts = (facts: readonly string[]): string =>
    facts.length ? `${first}${separator}${theme.fg("dim", facts.join(" · "))}` : first;
  const wide = withFacts(activeMetadata(agent, now, false));
  let header = wide;
  if (visibleWidth(wide) > contentWidth) {
    const compact = activeMetadata(agent, now, true);
    // Drop trailing facts first so narrow rows retain the leading operational state.
    const dropOrder = [4, 3, 2, 1, 0];
    const dropped = new Set<number>();
    header = withFacts(compact);
    for (const index of dropOrder) {
      if (visibleWidth(header) <= contentWidth) break;
      dropped.add(index);
      header = withFacts(compact.filter((_fact, factIndex) => !dropped.has(factIndex)));
    }
  }
  return {
    status: agent.status,
    lines: [
      clipToWidth(header, contentWidth),
      clipToWidth(theme.fg("muted", sanitizeTerminalText(agent.description)), contentWidth),
    ],
  };
}

function finishedBlock(
  agent: WidgetAgent,
  registry: AgentConfigLookup,
  theme: Theme,
  width: number,
): RenderBlock {
  const contentWidth = Math.max(1, width - 4);
  const duration = formatMs((agent.completedAt ?? Date.now()) - agent.startedAt);
  const required = `${identity(agent, registry, theme, "")} · ${duration}`;
  const hasError = agent.status === "error" && Boolean(agent.error);
  const detail = sanitizeTerminalText(hasError ? (agent.error ?? "") : agent.description);
  return {
    status: agent.status,
    lines: [clipToWidth(`${required} · ${detail}`, contentWidth)],
  };
}

function hiddenLabel(status: SubagentStatus): string {
  return status === "error" ? "failed" : status;
}

function overflowLines(hidden: readonly RenderBlock[], width: number, theme: Theme): string[] {
  const counts = new Map<SubagentStatus, number>();
  for (const block of hidden) counts.set(block.status, (counts.get(block.status) ?? 0) + 1);
  const order: SubagentStatus[] = [
    "running",
    "queued",
    "error",
    "aborted",
    "stopped",
    "steered",
    "completed",
  ];
  const parts = order
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${hiddenLabel(status)}`);
  const packed = packParts(parts, Math.max(1, width - 4));
  return packed.map((line, index) => theme.fg("dim", `${index === 0 ? "hidden: " : ""}${line}`));
}

function decorateBlock(block: RenderBlock, last: boolean, width: number, theme: Theme): string[] {
  return block.lines.map((line, index) => {
    const prefix = index === 0 ? (last ? "└─ " : "├─ ") : last ? "   " : "│  ";
    return clipToWidth(theme.fg("dim", prefix) + line, width);
  });
}

export function renderWidgetLines(params: {
  agents: readonly WidgetAgent[];
  registry: AgentConfigLookup;
  spinnerFrame: number;
  terminalWidth: number;
  theme: Theme;
  shouldShowFinished: (agentId: string, status: string) => boolean;
}): string[] {
  const { agents, registry, spinnerFrame, terminalWidth, theme, shouldShowFinished } = params;
  const width = Math.max(1, terminalWidth);
  const running = agents.filter((agent) => agent.status === "running");
  const queued = agents.filter((agent) => agent.status === "queued");
  const finished = agents.filter(
    (agent) =>
      !isActiveStatus(agent.status) &&
      agent.completedAt != null &&
      shouldShowFinished(agent.id, agent.status),
  );
  if (running.length === 0 && queued.length === 0 && finished.length === 0) return [];

  const now = Date.now();
  const terminalErrors = finished.filter((agent) => agent.status !== "completed");
  const completions = finished.filter((agent) => agent.status === "completed");
  const blocks = [
    ...running.map((agent) => activeBlock(agent, registry, spinnerFrame, theme, width, now)),
    ...queued.map((agent) => activeBlock(agent, registry, spinnerFrame, theme, width, now)),
    ...terminalErrors.map((agent) => finishedBlock(agent, registry, theme, width)),
    ...completions.map((agent) => finishedBlock(agent, registry, theme, width)),
  ];

  const selected = [...blocks];
  const hidden: RenderBlock[] = [];
  while (selected.length > 0) {
    const bodySize = selected.reduce((sum, block) => sum + block.lines.length, 0);
    const overflowSize = hidden.length ? overflowLines(hidden, width, theme).length : 0;
    if (bodySize + overflowSize <= MAX_WIDGET_LINES - 1) break;
    const last = selected.pop();
    if (!last) break;
    hidden.unshift(last);
  }

  const activeCount = running.length + queued.length;
  const countParts: string[] = [];
  if (running.length) countParts.push(theme.fg("accent", `${running.length} running`));
  if (queued.length) countParts.push(theme.fg("warning", `${queued.length} queued`));
  const headingState = countParts.length
    ? countParts.join(theme.fg("dim", " · "))
    : theme.fg("dim", `${finished.length} recent`);
  const headingIcon = activeCount ? GLYPHS.agentsActive : GLYPHS.agentsIdle;
  const headingColor = activeCount ? "accent" : "dim";
  const heading = `${theme.fg(headingColor, headingIcon)} ${theme.bold("Background agents")}  ${headingState}`;
  const lines = [clipToWidth(heading, width)];
  selected.forEach((block, index) => {
    const last = hidden.length === 0 && index === selected.length - 1;
    lines.push(...decorateBlock(block, last, width, theme));
  });
  if (hidden.length) {
    const overflow = overflowLines(hidden, width, theme);
    overflow.forEach((line, index) => {
      const prefix = index === 0 ? "└─ " : "   ";
      lines.push(clipToWidth(theme.fg("dim", prefix) + line, width));
    });
  }
  return lines.slice(0, MAX_WIDGET_LINES);
}

function clipToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return text.includes("\u001b") ? clipped : stripTerminalSequences(clipped);
}
