/**
 * The `/subagents:sessions` picker and read-only child transcript overlay.
 */

import {
  type ExtensionCommandContext,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type MarkdownTheme,
  matchesKey,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "../config/agent-types.ts";
import { sanitizeTerminalText } from "./display.ts";
import { type RosterPickerItem, showRosterPicker } from "./roster-picker.ts";
import {
  fileSnapshotSource,
  listNavigableAgents,
  liveSource,
  type NavigableSubagent,
  type NavigationIdentity,
  type TranscriptSource,
} from "./session-navigation.ts";
import { TranscriptContent } from "./transcript-content.ts";

const MIN_VIEWPORT = 3;
const VIEWPORT_HEIGHT_PCT = 70;
const MAX_OVERLAY_WIDTH = 120;

type OverlayTheme = Pick<Theme, "bold" | "fg">;

export type OverlayComponentFactory<R> = (
  tui: TUI,
  theme: Theme,
  keybindings: unknown,
  done: (result: R) => void,
) => Component;

export type SessionNavigatorUI = Pick<ExtensionCommandContext["ui"], "notify" | "custom">;

export interface SessionNavigatorParams {
  ui: SessionNavigatorUI;
  agents: readonly NavigableSubagent[];
  registry: AgentConfigLookup;
  cwd: string;
  readFile: (path: string) => string;
}

export interface TranscriptOverlayOptions {
  tui: TUI;
  theme: OverlayTheme;
  source: TranscriptSource;
  session: NavigationIdentity;
  done: (result: undefined) => void;
  cwd: string;
  markdownTheme: MarkdownTheme;
}

export class SessionNavigatorHandler {
  async handle({ ui, agents, registry, cwd, readFile }: SessionNavigatorParams): Promise<void> {
    const entries = listNavigableAgents(agents, registry);
    if (entries.length === 0) {
      ui.notify("No subagent sessions to view.", "info");
      return;
    }

    const items: RosterPickerItem[] = entries.map((entry) => ({
      value: entry.key,
      label: `${entry.name} · ${entry.status}`,
      description: entry.description,
      secondary: `ID ${entry.id} · ${entry.duration} · ${entry.toolUses} tool uses · ${entry.sourceLabel}`,
    }));
    const selectedKey = await showRosterPicker(ui, "Subagent sessions", items);
    const entry = entries.find((candidate) => candidate.key === selectedKey);
    if (!entry) return;

    let source: TranscriptSource;
    try {
      source =
        entry.kind === "live"
          ? liveSource(entry.record)
          : fileSnapshotSource(entry.outputFile, readFile);
    } catch {
      ui.notify("Could not read the session transcript file.", "error");
      return;
    }

    await ui.custom<undefined>(
      (tui, theme, _keybindings, done) =>
        new TranscriptOverlay({
          tui,
          theme,
          source,
          session: entry,
          done,
          cwd,
          markdownTheme: getMarkdownTheme(),
        }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: MAX_OVERLAY_WIDTH,
          maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
        },
      },
    );
  }
}

export class TranscriptOverlay implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private renderedInnerWidth: number | undefined;
  private renderedViewportHeight: number | undefined;

  private readonly tui: TUI;
  private readonly theme: OverlayTheme;
  private readonly session: NavigationIdentity;
  private readonly done: (result: undefined) => void;
  private readonly content: TranscriptContent;

  constructor({ tui, theme, source, session, done, cwd, markdownTheme }: TranscriptOverlayOptions) {
    this.tui = tui;
    this.theme = theme;
    this.session = session;
    this.done = done;
    this.content = new TranscriptContent({ tui, cwd, markdownTheme, source });
    this.unsubscribe = source.subscribe((event) => {
      if (this.closed) return;
      this.content.apply(event);
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }

    const totalLines = this.content.lineCount(this.inputWidth());
    const viewportHeight = this.renderedViewportHeight ?? this.viewportHeight(1, 1);
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    let handled = true;

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    } else {
      handled = false;
    }

    if (handled) this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const innerWidth = width - 4;
    this.renderedInnerWidth = innerWidth;
    const header = this.header(innerWidth);
    const totalLines = this.content.lineCount(innerWidth);
    const footer = this.footer(innerWidth, totalLines, this.scrollOffset);
    const viewportHeight = this.viewportHeight(header.length, footer.length);
    this.renderedViewportHeight = viewportHeight;
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = this.content.slice(innerWidth, visibleStart, viewportHeight);
    const finalFooter = this.footer(innerWidth, totalLines, visibleStart);

    const row = (content: string): string => {
      const clipped = clipToWidth(content, innerWidth);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      return `${this.theme.fg("border", "│")} ${clipped}${padding} ${this.theme.fg("border", "│")}`;
    };
    const horizontal = row(this.theme.fg("dim", "─".repeat(innerWidth)));
    const lines = [this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`)];
    lines.push(...header.map(row), horizontal);
    for (let index = 0; index < viewportHeight; index++) lines.push(row(visible[index] ?? ""));
    lines.push(horizontal, ...finalFooter.map(row));
    lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  invalidate(): void {
    this.content.invalidate();
  }

  dispose(): void {
    this.closed = true;
    this.releaseSubscription();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseSubscription();
    this.done(undefined);
  }

  private releaseSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private header(width: number): string[] {
    const available = Math.max(1, width);
    const identity = `${sanitizeTerminalText(this.session.name)} · ${this.session.status}`;
    const metadata = `ID ${sanitizeTerminalText(this.session.id)} · ${sanitizeTerminalText(this.session.sourceLabel)}`;
    const lines =
      available >= 20 && available < 60
        ? [
            ...boundedWrap(this.theme.bold(identity), available, 1),
            ...boundedWrap(this.theme.fg("dim", metadata), available, 1),
          ]
        : boundedWrap(this.theme.bold(`${identity} · ${metadata}`), available, 2);
    if (this.session.description && available >= 20) {
      lines.push(
        ...boundedWrap(
          this.theme.fg("dim", sanitizeTerminalText(this.session.description)),
          available,
          2,
        ),
      );
    }
    return lines;
  }

  private footer(width: number, totalLines: number, visibleStart: number): string[] {
    const viewport = this.renderedViewportHeight ?? MIN_VIEWPORT;
    const percent =
      totalLines <= viewport
        ? "100%"
        : `${Math.round(((Math.min(visibleStart, totalLines) + viewport) / totalLines) * 100)}%`;
    const position = `${totalLines} lines · ${percent}`;
    const controls =
      width < 50
        ? "↑↓/jk scroll · q close"
        : width < 90
          ? "↑↓/jk · PgUp/Dn · q/Esc close"
          : "↑↓/jk · PgUp/PgDn · Home/End · q/Esc/Ctrl+C close";
    if (visibleWidth(position) + visibleWidth(controls) + 1 > width) {
      return [this.theme.fg("dim", position), this.theme.fg("dim", controls)];
    }
    const gap = " ".repeat(width - visibleWidth(position) - visibleWidth(controls));
    return [this.theme.fg("dim", `${position}${gap}${controls}`)];
  }

  private inputWidth(): number {
    return (
      this.renderedInnerWidth ??
      Math.max(1, Math.min(MAX_OVERLAY_WIDTH, this.tui.terminal.columns) - 4)
    );
  }

  private viewportHeight(headerLines: number, footerLines: number): number {
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    const chromeLines = 4 + headerLines + footerLines;
    return Math.max(MIN_VIEWPORT, maxRows - chromeLines);
  }
}

function boundedWrap(text: string, width: number, maxLines: number): string[] {
  const lines = wrapTextWithAnsi(text, width);
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  visible[maxLines - 1] = clipToWidth(`${visible[maxLines - 1] ?? ""}…`, width, "…");
  return visible;
}

function clipToWidth(text: string, width: number, ellipsis?: string): string {
  const clipped = truncateToWidth(text, width, ellipsis);
  return text.includes("\u001b") ? clipped : stripTerminalSequences(clipped);
}
