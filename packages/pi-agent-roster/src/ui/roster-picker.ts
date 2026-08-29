import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface RosterPickerItem {
  value: string;
  label: string;
  description?: string | undefined;
  secondary?: string | undefined;
}

type PickerUI = Pick<ExtensionCommandContext["ui"], "custom">;
type PickerTheme = Pick<Theme, "bold" | "fg">;

export async function showRosterPicker(
  ui: PickerUI,
  title: string,
  items: readonly RosterPickerItem[],
): Promise<string | undefined> {
  return ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) =>
      new RosterPicker(title, items, theme, done, () => tui.requestRender()),
  );
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
    const contentWidth = Math.max(1, available - 2);
    const lines = [
      truncateToWidth(` ${this.theme.fg("accent", this.theme.bold(this.title))}`, available),
      truncateToWidth(
        ` ${this.theme.fg("dim", "Filter:")} ${this.filter || this.theme.fg("muted", "type to search")}`,
        available,
      ),
      "",
    ];

    if (!this.filtered.length) {
      lines.push(truncateToWidth(` ${this.theme.fg("muted", "No matches")}`, available));
    } else {
      const visible = this.filtered.slice(this.offset, this.offset + this.pageSize);
      for (let index = 0; index < visible.length; index++) {
        const absoluteIndex = this.offset + index;
        const item = visible[index];
        if (!item) continue;
        const selected = absoluteIndex === this.selected;
        const marker = selected ? this.theme.fg("accent", "›") : " ";
        const label = selected
          ? this.theme.fg("accent", this.theme.bold(item.label))
          : this.theme.fg("text", item.label);

        if (available >= 80 && item.secondary) {
          const labelWidth = Math.min(Math.max(20, Math.floor(contentWidth * 0.4)), contentWidth);
          const left = truncateToWidth(`${marker} ${label}`, labelWidth, "…", true);
          const rightWidth = Math.max(1, contentWidth - labelWidth);
          const secondary = wrapTextWithAnsi(this.theme.fg("muted", item.secondary), rightWidth);
          lines.push(truncateToWidth(` ${left}${secondary[0] ?? ""}`, available));
          for (const line of secondary.slice(1)) {
            lines.push(truncateToWidth(` ${" ".repeat(labelWidth)}${line}`, available));
          }
        } else {
          lines.push(truncateToWidth(` ${marker} ${label}`, available));
          if (item.secondary)
            lines.push(...this.wrapSecondary(item.secondary, contentWidth, available));
        }
        if (item.description)
          lines.push(...this.wrapSecondary(item.description, contentWidth, available));
      }
    }

    lines.push("");
    const position = this.filtered.length ? `${this.selected + 1}/${this.filtered.length} · ` : "";
    lines.push(
      truncateToWidth(
        ` ${this.theme.fg("dim", `${position}↑↓/j k navigate · Enter select · Esc cancel`)}`,
        available,
      ),
    );
    return lines.map((line) =>
      visibleWidth(line) <= available ? line : truncateToWidth(line, available),
    );
  }

  invalidate(): void {}

  private wrapSecondary(text: string, contentWidth: number, width: number): string[] {
    const indent = "   ";
    return wrapTextWithAnsi(
      this.theme.fg("muted", text),
      Math.max(1, contentWidth - indent.length),
    ).map((line) => truncateToWidth(` ${indent}${line}`, width));
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

function isPrintable(data: string): boolean {
  return (
    data.length > 0 && !data.includes("\u001b") && [...data].every((character) => character >= " ")
  );
}
