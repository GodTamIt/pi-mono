import { sanitizeTerminalText } from "./display.ts";

const STATUS_KEY = "subagents";
const LEGACY_PRIMARY_STATUS_KEY = "primary-agent";
const MAX_SUMMARY_LENGTH = 48;

export interface FooterStatusUI {
  setStatus(key: string, text: string | undefined): void;
}

export interface FooterStatusState {
  taskSummary?: string | undefined;
  primaryName?: string | undefined;
  stack?: string | undefined;
  runningCount?: number | undefined;
  queuedCount?: number | undefined;
}

export function composeFooterStatus(state: FooterStatusState): string | undefined {
  const segments: string[] = [];
  if (state.taskSummary) segments.push(state.taskSummary);
  if (state.primaryName) segments.push(state.primaryName);
  if (state.stack) segments.push(`stack: ${state.stack}`);

  const counts: string[] = [];
  if (state.runningCount) counts.push(`${state.runningCount} running`);
  if (state.queuedCount) counts.push(`${state.queuedCount} queued`);
  if (counts.length) segments.push(`agents: ${counts.join(", ")}`);

  return segments.length ? segments.join(" · ") : undefined;
}

export function normalizeTaskSummary(prompt: string): string | undefined {
  let summary = sanitizeTerminalText(prompt).replace(/\s+/g, " ").trim();
  let previous: string;
  do {
    previous = summary;
    summary = summary.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "").trim();
  } while (summary !== previous);

  while (summary.length >= 2) {
    const first = summary[0];
    const last = summary.at(-1);
    if (!first || first !== last || !['"', "'", "`"].includes(first)) break;
    summary = summary.slice(1, -1).trim();
  }
  if (!summary) return undefined;

  const characters = [...summary];
  if (characters.length <= MAX_SUMMARY_LENGTH) return summary;

  const available = MAX_SUMMARY_LENGTH - 1;
  const candidate = characters.slice(0, available);
  let boundary = -1;
  for (let index = candidate.length - 1; index >= 0; index--) {
    if (/\s/.test(candidate[index] ?? "")) {
      boundary = index;
      break;
    }
  }
  const cutoff = boundary >= Math.floor(available * 0.6) ? boundary : available;
  return `${candidate.slice(0, cutoff).join("").trimEnd()}…`;
}

export class FooterStatus {
  private ui: FooterStatusUI | undefined;
  private state: FooterStatusState = {};
  private lastText: string | undefined;

  attach(ui: FooterStatusUI): void {
    if (this.ui === ui) {
      ui.setStatus(LEGACY_PRIMARY_STATUS_KEY, undefined);
      return;
    }
    this.ui = ui;
    this.lastText = composeFooterStatus(this.state);
    ui.setStatus(LEGACY_PRIMARY_STATUS_KEY, undefined);
    ui.setStatus(STATUS_KEY, this.lastText);
  }

  reset(): void {
    this.state = {};
    this.render();
  }

  setTaskPrompt(prompt: string): void {
    const taskSummary = normalizeTaskSummary(prompt);
    if (!taskSummary) return;
    this.state = { ...this.state, taskSummary };
    this.render();
  }

  setPrimary(primaryName: string | undefined, stack: string | undefined): void {
    this.state = { ...this.state, primaryName, stack };
    this.render();
  }

  setAgentCounts(runningCount: number, queuedCount: number): void {
    this.state = { ...this.state, runningCount, queuedCount };
    this.render();
  }

  dispose(): void {
    if (this.ui) {
      this.ui.setStatus(LEGACY_PRIMARY_STATUS_KEY, undefined);
      if (this.lastText !== undefined) this.ui.setStatus(STATUS_KEY, undefined);
    }
    this.ui = undefined;
    this.state = {};
    this.lastText = undefined;
  }

  private render(): void {
    const text = composeFooterStatus(this.state);
    if (!this.ui || text === this.lastText) return;
    this.ui.setStatus(STATUS_KEY, text);
    this.lastText = text;
  }
}
