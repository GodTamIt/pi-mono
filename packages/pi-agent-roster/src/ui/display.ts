/**
 * display.ts — Pure formatting helpers and display utilities for agent UI.
 *
 * All functions are stateless and dependency-free (no SDK, no widget lifecycle).
 * Consumed by the widget, the menu, tool modules, and the notification renderer.
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "../config/agent-types.ts";
import type { AgentInvocation, SubagentType, ThinkingLevel } from "../types.ts";
import { GLYPHS } from "./glyphs.ts";

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

/** Remove terminal controls from untrusted text before adding theme sequences. */
export function sanitizeTerminalText(text: string, preserveNewlines = false): string {
  return [...stripTerminalSequences(text)]
    .map((character) => {
      const code = character.charCodeAt(0);
      if (character === "\n") return preserveNewlines ? character : " ";
      if (character === "\t") return " ";
      return code >= 32 && code !== 127 && (code < 128 || code > 159) ? character : "";
    })
    .join("");
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status:
    | "queued"
    | "running"
    | "completed"
    | "steered"
    | "aborted"
    | "stopped"
    | "error"
    | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string | undefined;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number | undefined;
  /** Short model name if different from parent (e.g. "haiku", "sonnet"). */
  modelName?: string | undefined;
  /** Notable config tags (e.g. ["thinking: high", "inherit context"]). */
  tags?: string[] | undefined;
  /** Current turn count. */
  turnCount?: number | undefined;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number | undefined;
  agentId?: string | undefined;
  childSessionId?: string | undefined;
  task?: string | undefined;
  isBackground?: boolean | undefined;
  stack?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  graceTurns?: number | undefined;
  compactions?: number | undefined;
  output?: string | undefined;
  error?: string | undefined;
}

// ---- Constants ----

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Pure formatters ----

/** Round a context-window percentage to the nearest tenth. */
export function roundContextPercent(percent: number): number {
  return Math.round(percent * 10) / 10;
}

/** Format a context-window percentage with at most one decimal place. */
export function formatContextPercent(percent: number): string {
  return `${roundContextPercent(percent)}%`;
}

/** Format a token count compactly: "1 token", "33.8k tokens", "1.2M tokens". */
export function formatTokens(count: number): string {
  const unit = count === 1 ? "token" : "tokens";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M ${unit}`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k ${unit}`;
  return `${count} ${unit}`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim (see `glyphs.ts`).
 *
 *   "12.3k tokens"               — no annotations
 *   "12.3k tokens (45%)"         — percent only
 *   "12.3k tokens (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k tokens (45% · ⇊2)"    — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, formatContextPercent(percent)));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `${GLYPHS.compactions}${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  const sep = theme.fg("dim", " · ");
  return `${tokenStr} ${theme.fg("dim", "(")}${annot.join(sep)}${theme.fg("dim", ")")}`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null
    ? `${GLYPHS.turns}${turnCount}≤${maxTurns}`
    : `${GLYPHS.turns}${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

// ---- Display helpers ----

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType, registry: AgentConfigLookup): string {
  try {
    const config = registry.resolveAgentConfig(type);
    return config.displayName ?? config.name;
  } catch {
    return type === "general-purpose" ? "Agent" : type;
  }
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(
  type: SubagentType,
  registry: AgentConfigLookup,
): string | undefined {
  try {
    return registry.resolveAgentConfig(type).promptMode === "append" ? "twin" : undefined;
  } catch {
    return undefined;
  }
}

/** Explicit labels keep stack resolution readable when values are shown outside their config context. */
export function buildInvocationMetadataParts(metadata: {
  stack?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
}): string[] {
  const parts: string[] = [];
  if (metadata.stack) parts.push(`stack: ${metadata.stack}`);
  if (metadata.model) parts.push(`model: ${metadata.model}`);
  if (metadata.thinking) parts.push(`thinking: ${metadata.thinking}`);
  return parts;
}

/** Mode label is not included — callers add it where they want it. */
export function buildInvocationTags(invocation: AgentInvocation | undefined): {
  modelName?: string | undefined;
  tags: string[];
} {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.stack) tags.push(`stack: ${invocation.stack}`);
  if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
  if (invocation.runInBackground) tags.push("background");
  tags.push(`max turns: ${invocation.maxTurns ?? "unlimited"}`);
  tags.push(`grace turns: ${invocation.graceTurns ?? "unlimited"}`);
  return { modelName: invocation.modelName, tags };
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  if (line.length <= len) return line;
  return `${line.slice(0, len)}…`;
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(
  activeTools: ReadonlyMap<string, string>,
  responseText?: string,
): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return `${parts.join(", ")}…`;
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}
