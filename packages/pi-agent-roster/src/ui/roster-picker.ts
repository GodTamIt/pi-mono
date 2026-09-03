import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./display.ts";

export interface RosterPickerItem {
  value: string;
  label: string;
  description?: string | undefined;
  secondary?: string | undefined;
}

type PickerContext = Pick<ExtensionCommandContext, "hasUI" | "mode"> & {
  ui: Pick<ExtensionCommandContext["ui"], "custom" | "select">;
};
type PickerTheme = Pick<Theme, "bold" | "fg">;

const RPC_OPTION_WIDTH = 160;
// Below this width the border chrome is dropped so the content stays usable.
const MIN_BOX_WIDTH = 20;

export async function showRosterPicker(
  ctx: PickerContext,
  title: string,
  items: readonly RosterPickerItem[],
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  if (ctx.mode === "tui") {
    return ctx.ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) =>
        new RosterPicker(title, items, theme, done, () => tui.requestRender()),
    );
  }

  const options = items.map((item, index) => formatSelectOption(item, index));
  const selected = await ctx.ui.select(sanitizeTerminalText(title), options);
  const selectedIndex = selected === undefined ? -1 : options.indexOf(selected);
  return selectedIndex < 0 ? undefined : items[selectedIndex]?.value;
}

export class RosterPicker {
  private filter = "";
  private selected = 0;
  private offset = 0;
  private filtered: RosterPickerItem[];
  private readonly pageSize = 8;

  constructor(
    private readonly title: string,
    private readonly items: readonly RosterPickerItem[],
    private readonly theme: PickerTheme,
    private readonly done: (value: string | undefined) => void,
    private readonly requestRender: () => void = () => undefined,
  ) {
    this.filtered = [...items];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "return")) {
      this.done(this.filtered[this.selected]?.value);
      return;
    }

    if (matchesKey(data, "home")) this.moveTo(0);
    else if (matchesKey(data, "end")) this.moveTo(this.filtered.length - 1);
    else if (matchesKey(data, "pageUp")) this.moveBy(-this.pageSize);
    else if (matchesKey(data, "pageDown")) this.moveBy(this.pageSize);
    else if (matchesKey(data, "up") || (this.filter === "" && data === "k")) this.moveBy(-1);
    else if (matchesKey(data, "down") || (this.filter === "" && data === "j")) this.moveBy(1);
    else if (matchesKey(data, "backspace")) {
      const characters = [...this.filter];
      characters.pop();
      this.setFilter(characters.join(""));
    } else {
      const printable = decodeKittyPrintable(data) ?? (isPrintable(data) ? data : undefined);
      if (printable) this.setFilter(this.filter + printable);
      else return;
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const available = Math.max(1, width);
    const lines =
      available >= MIN_BOX_WIDTH ? this.renderBoxed(available) : this.renderFlat(available);
    return lines.map((line) =>
      visibleWidth(line) <= available ? line : clipToWidth(line, available),
    );
  }

  private renderFlat(width: number): string[] {
    const lines = [this.titleLine(width), this.filterLine(width), ""];
    lines.push(...this.itemLines(width));
    lines.push("", ...this.footerLines(width));
    return lines;
  }

  private renderBoxed(width: number): string[] {
    const inner = width - 2;
    const border = (text: string): string => this.theme.fg("border", text);
    const row = (content: string): string =>
      `${border("│")}${clipToWidth(content, inner, undefined, true)}${border("│")}`;
    const fill = "─".repeat(Math.max(0, width - 2));
    return [
      this.titleBorder(width),
      row(this.filterLine(inner)),
      border(`├${fill}┤`),
      ...this.itemLines(inner).map(row),
      border(`├${fill}┤`),
      ...this.footerLines(inner).map(row),
      border(`╰${fill}╯`),
    ];
  }

  private titleBorder(width: number): string {
    const border = (text: string): string => this.theme.fg("border", text);
    const title = sanitizeTerminalText(this.title);
    const maxTitle = width - 6;
    if (!title || maxTitle < 1) {
      return border(`╭${"─".repeat(Math.max(0, width - 2))}╮`);
    }
    const clippedTitle = clipToWidth(title, maxTitle, "…");
    const fill = "─".repeat(Math.max(1, width - 5 - visibleWidth(clippedTitle)));
    return `${border("╭─ ")}${this.theme.fg("accent", this.theme.bold(clippedTitle))}${border(` ${fill}╮`)}`;
  }

  private titleLine(width: number): string {
    return clipToWidth(
      ` ${this.theme.fg("accent", this.theme.bold(sanitizeTerminalText(this.title)))}`,
      width,
    );
  }

  private filterLine(width: number): string {
    return clipToWidth(
      ` ${this.theme.fg("dim", "Filter:")} ${sanitizeTerminalText(this.filter) || this.theme.fg("muted", "type to search")}`,
      width,
    );
  }

  private itemLines(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    if (!this.filtered.length) {
      lines.push(clipToWidth(` ${this.theme.fg("muted", "No matches")}`, width));
      return lines;
    }
    const visible = this.filtered.slice(this.offset, this.offset + this.pageSize);
    for (let index = 0; index < visible.length; index++) {
      const absoluteIndex = this.offset + index;
      const item = visible[index];
      if (!item) continue;
      const selected = absoluteIndex === this.selected;
      const marker = selected ? this.theme.fg("accent", "›") : " ";
      const safeLabel = sanitizeTerminalText(item.label);
      const label = selected
        ? this.theme.fg("accent", this.theme.bold(safeLabel))
        : this.theme.fg("text", safeLabel);

      if (width >= 80 && item.secondary) {
        const labelWidth = Math.min(Math.max(20, Math.floor(contentWidth * 0.4)), contentWidth);
        const left = clipToWidth(`${marker} ${label}`, labelWidth, "…", true);
        const rightWidth = Math.max(1, contentWidth - labelWidth);
        const secondary = wrapTextWithAnsi(
          this.theme.fg("muted", sanitizeTerminalText(item.secondary)),
          rightWidth,
        );
        lines.push(clipToWidth(` ${left}${secondary[0] ?? ""}`, width));
        for (const line of secondary.slice(1)) {
          lines.push(clipToWidth(` ${" ".repeat(labelWidth)}${line}`, width));
        }
      } else {
        lines.push(clipToWidth(` ${marker} ${label}`, width));
        if (item.secondary)
          lines.push(
            ...this.wrapSecondary(sanitizeTerminalText(item.secondary), contentWidth, width),
          );
      }
      if (item.description)
        lines.push(
          ...this.wrapSecondary(sanitizeTerminalText(item.description), contentWidth, width),
        );
    }
    return lines;
  }

  private footerLines(width: number): string[] {
    const position = this.filtered.length
      ? `${this.selected + 1}/${this.filtered.length}`
      : undefined;
    const controls =
      width < 24
        ? "↑↓ · Enter · Esc"
        : width < 50
          ? "↑↓/jk · Enter · Esc"
          : "↑↓/j k navigate · Enter select · Esc cancel";
    const footer = position ? `${position} · ${controls}` : controls;
    if (visibleWidth(footer) + 1 <= width) {
      return [clipToWidth(` ${this.theme.fg("dim", footer)}`, width)];
    }
    const lines: string[] = [];
    if (position) lines.push(clipToWidth(` ${this.theme.fg("dim", position)}`, width));
    lines.push(clipToWidth(` ${this.theme.fg("dim", controls)}`, width));
    return lines;
  }

  invalidate(): void {}

  private wrapSecondary(text: string, contentWidth: number, width: number): string[] {
    const indent = "   ";
    return wrapTextWithAnsi(
      this.theme.fg("muted", text),
      Math.max(1, contentWidth - indent.length),
    ).map((line) => clipToWidth(` ${indent}${line}`, width));
  }

  private setFilter(filter: string): void {
    this.filter = filter;
    const query = filter.toLocaleLowerCase("en-US");
    this.filtered = query
      ? this.items.filter((item) =>
          [item.label, item.description, item.secondary, item.value]
            .filter((part): part is string => Boolean(part))
            .some((part) => part.toLocaleLowerCase("en-US").includes(query)),
        )
      : [...this.items];
    this.selected = 0;
    this.offset = 0;
  }

  private moveBy(delta: number): void {
    this.moveTo(this.selected + delta);
  }

  private moveTo(index: number): void {
    if (!this.filtered.length) return;
    this.selected = Math.max(0, Math.min(index, this.filtered.length - 1));
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + this.pageSize) {
      this.offset = this.selected - this.pageSize + 1;
    }
  }
}

function clipToWidth(text: string, width: number, ellipsis?: string, pad?: boolean): string {
  const clipped = truncateToWidth(text, width, ellipsis, pad);
  return text.includes("\u001b") ? clipped : stripTerminalSequences(clipped);
}

function formatSelectOption(item: RosterPickerItem, index: number): string {
  const identity = `${index + 1}. `;
  const details = [item.label, item.description, item.secondary]
    .filter((part): part is string => Boolean(part))
    .map((part) => sanitizeTerminalText(part))
    .join(" · ");
  const bounded = truncateToWidth(details, RPC_OPTION_WIDTH - visibleWidth(identity), "…");
  return `${identity}${stripTerminalSequences(bounded)}`;
}

function isPrintable(data: string): boolean {
  return (
    data.length > 0 && !data.includes("\u001b") && [...data].every((character) => character >= " ")
  );
}
