import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { RosterPicker, type RosterPickerItem } from "../../src/ui/roster-picker.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function picker(items: RosterPickerItem[]) {
  const done = vi.fn<(value: string | undefined) => void>();
  const requestRender = vi.fn();
  return {
    component: new RosterPicker("Choose", items, theme, done, requestRender),
    done,
    requestRender,
  };
}

describe("RosterPicker", () => {
  it("returns stable values when display labels are duplicated", () => {
    const h = picker([
      { value: "first-id", label: "Same name", secondary: "model: one" },
      { value: "second-id", label: "Same name", secondary: "model: two" },
    ]);

    h.component.handleInput("\x1b[B");
    h.component.handleInput("\r");

    expect(h.done).toHaveBeenCalledWith("second-id");
  });

  it("supports arrows, j/k, paging, and home/end navigation", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      value: String(index),
      label: `Item ${index}`,
    }));
    const h = picker(items);

    h.component.handleInput("j");
    h.component.handleInput("\x1b[6~");
    h.component.handleInput("\x1b[F");
    h.component.handleInput("k");
    h.component.handleInput("\x1b[H");
    h.component.handleInput("\x1b[B");
    h.component.handleInput("\r");

    expect(h.done).toHaveBeenCalledWith("1");
    expect(h.requestRender).toHaveBeenCalledTimes(6);
  });

  it("filters rows and cancels with Escape or Ctrl+C", () => {
    const items = [
      { value: "alpha", label: "Alpha" },
      { value: "beta", label: "Beta", description: "specialist" },
    ];
    const filtered = picker(items);
    filtered.component.handleInput("s");
    filtered.component.handleInput("p");
    filtered.component.handleInput("\r");
    expect(filtered.done).toHaveBeenCalledWith("beta");

    const escaped = picker(items);
    escaped.component.handleInput("\x1b");
    expect(escaped.done).toHaveBeenCalledWith(undefined);

    const interrupted = picker(items);
    interrupted.component.handleInput("\x03");
    expect(interrupted.done).toHaveBeenCalledWith(undefined);
  });

  it.each([40, 60, 80, 120])(
    "wraps Unicode descriptions and keeps ANSI-aware output within %i columns",
    (width) => {
      const h = picker([
        {
          value: "wide",
          label: "設計者 🚀 with a long visible label",
          secondary: "stack: deliberate · model: anthropic/very-long-model-name · thinking: high",
          description:
            "Reviews interfaces across 中文 boundaries and explains the reasoning without clipping important context.",
        },
      ]);

      const lines = h.component.render(width);

      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).toContain("設計者");
      expect(lines.length).toBeGreaterThan(6);
    },
  );
});
