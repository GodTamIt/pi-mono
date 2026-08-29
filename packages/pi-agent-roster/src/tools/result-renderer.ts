/**
 * result-renderer.ts — Pure per-status rendering functions for Agent tool results.
 *
 * All functions are stateless: they receive AgentDetails and a Theme, returning
 * formatted strings. No SDK types, no timers, no side effects.
 * Consumed by the renderResult hook in agent-tool.ts.
 */

import type { AgentDetails, Theme } from "../ui/display.ts";
import { formatMs, formatTurns } from "../ui/display.ts";
import { GLYPHS, SPINNER } from "../ui/glyphs.ts";

// ---- Dispatcher ----

/** Dispatch to the per-status renderer based on details.status and isPartial. */
export function renderAgentResult(
  details: AgentDetails,
  resultText: string,
  expanded: boolean,
  isPartial: boolean,
  theme: Theme,
): string {
  if (isPartial || details.status === "running") return renderRunning(details, theme);
  if (details.status === "background")
    return renderBackground(details, resultText, expanded, theme);
  if (details.status === "completed" || details.status === "steered")
    return renderCompleted(details, resultText, expanded, theme);
  if (details.status === "stopped") return renderStopped(details, theme);
  return renderFailed(details, theme);
}

// ---- Per-status renderers ----

/** Render running/partial status: spinner + stats + activity line. */
export function renderRunning(details: AgentDetails, theme: Theme): string {
  const frame = SPINNER[details.spinnerFrame ?? 0] ?? "";
  const s = renderStats(details, theme);
  let line = theme.fg("accent", frame) + (s ? " " + s : "");
  line += "\n" + theme.fg("dim", `  ${GLYPHS.subLine}  ${details.activity ?? "thinking\u2026"}`);
  return line;
}

/** Render background launch status with a compact invocation summary or expanded raw result. */
export function renderBackground(
  details: AgentDetails,
  resultText: string,
  expanded: boolean,
  theme: Theme,
): string {
  let line = theme.fg("dim", `  ${GLYPHS.subLine}  Background \u00B7 ID: ${details.agentId}`);

  if (expanded && resultText) {
    for (const rawLine of resultText.split("\n")) {
      line += "\n" + theme.fg("dim", `  ${rawLine}`);
    }
    return line;
  }

  const stack = details.tags?.find((tag) => tag.startsWith("stack: "));
  const thinking = details.tags?.find((tag) => tag.startsWith("thinking: "));
  const shortParts = [stack, thinking].filter((part): part is string => part !== undefined);
  if (shortParts.length > 0) {
    line += "\n" + theme.fg("dim", `  ${shortParts.join(" \u00B7 ")}`);
  }
  if (details.modelName) {
    line += "\n" + theme.fg("dim", `  model: ${details.modelName}`);
  }
  return line;
}

/** Render completed or steered status with optional expanded result text. */
export function renderCompleted(
  details: AgentDetails,
  resultText: string,
  expanded: boolean,
  theme: Theme,
): string {
  const duration = formatMs(details.durationMs);
  const isSteered = details.status === "steered";
  const icon = isSteered
    ? theme.fg("warning", GLYPHS.success)
    : theme.fg("success", GLYPHS.success);
  const s = renderStats(details, theme);
  let line = icon + (s ? " " + s : "");
  line += " " + theme.fg("dim", "\u00B7") + " " + theme.fg("dim", duration);

  if (expanded) {
    if (resultText) {
      for (const l of resultText.split("\n")) {
        line += "\n" + theme.fg("dim", `  ${l}`);
      }
    }
  } else {
    const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
    line += "\n" + theme.fg("dim", `  ${GLYPHS.subLine}  ${doneText}`);
  }
  return line;
}

/** Render stopped status: dim stop icon + stats + "Stopped". */
export function renderStopped(details: AgentDetails, theme: Theme): string {
  const s = renderStats(details, theme);
  let line = theme.fg("dim", GLYPHS.stopped) + (s ? " " + s : "");
  line += "\n" + theme.fg("dim", `  ${GLYPHS.subLine}  Stopped`);
  return line;
}

/** Render error or aborted status: error icon + stats + status message. */
export function renderFailed(details: AgentDetails, theme: Theme): string {
  const s = renderStats(details, theme);
  let line = theme.fg("error", GLYPHS.failure) + (s ? " " + s : "");

  if (details.status === "error") {
    line += "\n" + theme.fg("error", `  ${GLYPHS.subLine}  Error: ${details.error ?? "unknown"}`);
  } else {
    line += "\n" + theme.fg("warning", `  ${GLYPHS.subLine}  Aborted (max turns exceeded)`);
  }
  return line;
}

// ---- Shared helper ----

/**
 * Build the stats string: "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens".
 * Returns an empty string when all fields are absent or zero.
 */
export function renderStats(details: AgentDetails, theme: Theme): string {
  const parts: string[] = [];
  if (details.modelName) parts.push(details.modelName);
  if (details.tags) parts.push(...details.tags);
  if (details.turnCount != null && details.turnCount > 0) {
    parts.push(formatTurns(details.turnCount, details.maxTurns));
  }
  if (details.toolUses > 0)
    parts.push(`${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
  if (details.tokens) parts.push(details.tokens);
  return parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "\u00B7") + " ");
}
