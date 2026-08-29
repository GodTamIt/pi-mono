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
  it("pins stack-picker layouts at wide and narrow widths in monochrome", () => {
    const items: RosterPickerItem[] = [
      {
        value: "balanced",
        label: "Balanced · Current",
        secondary: "model: sonnet · thinking: medium",
        description: "General implementation and review.",
      },
      {
        value: "deep",
        label: "Deep",
        secondary: "model: opus · thinking: high",
        description: "Long-horizon architecture and difficult synthesis.",
      },
    ];
    const wide = picker(items).component.render(88);
    const narrow = picker(items).component.render(34);

    expect({ wide: wide.join("\n"), narrow: narrow.join("\n") }).toMatchInlineSnapshot(`
      {
        "narrow": " Choose
       Filter: type to search

       › Balanced · Current
          model: sonnet · thinking:
          medium
          General implementation and
          review.
         Deep
          model: opus · thinking: high
          Long-horizon architecture and
          difficult synthesis.

       1/2 · ↑↓/jk · Enter · Esc",
        "wide": " Choose
       Filter: type to search

       › Balanced · Current              model: sonnet · thinking: medium
          General implementation and review.
         Deep                            model: opus · thinking: high
          Long-horizon architecture and difficult synthesis.

       1/2 · ↑↓/j k navigate · Enter select · Esc cancel",
      }
    `);
    expect([...wide, ...narrow].every((line) => !line.includes("\u001b"))).toBe(true);
  });

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

  it("handles Kitty printable input, Kitty backspace, and a no-match state", () => {
    const h = picker([
      { value: "architect", label: "Architect" },
      { value: "rocket", label: "Rocket 🚀", description: "Fast launch" },
    ]);

    h.component.handleInput("\x1b[128640u");
    h.component.handleInput("\x1b[120u");
    expect(h.component.render(40).join("\n")).toMatchInlineSnapshot(`
      " Choose
       Filter: 🚀x

       No matches

       ↑↓/jk · Enter · Esc"
    `);

    h.component.handleInput("\x1b[127u");
    expect(h.component.render(40).join("\n")).toContain("Rocket 🚀");
    h.component.handleInput("\r");
    expect(h.done).toHaveBeenCalledWith("rocket");
  });

  it("removes one Unicode code point for legacy backspace", () => {
    const h = picker([{ value: "cafe", label: "Café" }]);
    h.component.handleInput("éx");
    h.component.handleInput("\x7f");

    expect(h.component.render(30).join("\n")).toContain("Filter: é");
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

  it("keeps wrapped secondary text inside a minimum practical picker width", () => {
    const lines = picker([
      {
        value: "wide",
        label: "設計 🚀",
        secondary: "stack: deliberate · model: long-model",
        description: "Unicode words stay reviewable when the picker wraps.",
      },
    ]).component.render(20);

    expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
    expect(lines.every((line) => !line.includes("\u001b"))).toBe(true);
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      " Choose
       Filter: type to ...

       › 設計 🚀
          stack:
          deliberate ·
          model:
          long-model
          Unicode words
          stay reviewable
          when the picker
          wraps.

       1/1
       ↑↓ · Enter · Esc"
    `);
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
