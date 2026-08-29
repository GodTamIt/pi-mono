import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../src/config/agent-types.ts";
import type { Theme } from "../src/ui/display.ts";
import type { WidgetAgent } from "../src/ui/widget-renderer.ts";
import { renderWidgetLines } from "../src/ui/widget-renderer.ts";

const registry = new AgentTypeRegistry(() => new Map());
const plainTheme: Theme = { fg: (_color, text) => text, bold: (text) => text };
const ansiTheme: Theme = {
  fg: (_color, text) => `\x1b[31m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const NOW = Date.parse("2026-06-23T12:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

function makeAgent(overrides: Partial<WidgetAgent> = {}): WidgetAgent {
  return {
    id: "agent-1",
    type: "general-purpose",
    status: "running",
    description: "inspect Unicode café 🚀 and report progress",
    toolUses: 0,
    startedAt: NOW - 5000,
    completedAt: undefined,
    lifetimeUsage: undefined,
    compactionCount: 0,
    turnCount: 3,
    maxTurns: 10,
    graceTurns: 2,
    stack: "deep",
    model: "anthropic/claude-opus",
    thinking: "high",
    activeTools: new Map(),
    responseText: "",
    contextPercent: null,
    ...overrides,
  };
}

function render(agents: WidgetAgent[], width = 120, theme = plainTheme): string[] {
  return renderWidgetLines({
    agents,
    registry,
    spinnerFrame: 0,
    terminalWidth: width,
    theme,
    shouldShowFinished: () => true,
  });
}

describe("background widget statuses", () => {
  it("pins every lifecycle state in monochrome", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const statuses: WidgetAgent["status"][] = [
      "queued",
      "running",
      "completed",
      "error",
      "aborted",
      "stopped",
      "steered",
    ];
    const baseline = Object.fromEntries(
      statuses.map((status) => [
        status,
        render(
          [
            makeAgent({
              status,
              completedAt: status === "queued" || status === "running" ? undefined : NOW,
              error: status === "error" ? "provider unavailable" : undefined,
            }),
          ],
          96,
        ).join("\n"),
      ]),
    );

    expect(baseline).toMatchInlineSnapshot(`
      {
        "aborted": "○ Background agents  1 recent
      └─ ✗ Agent  Background · aborted · duration: 5.0s
         task:     inspect Unicode café 🚀 and report progress",
        "completed": "○ Background agents  1 recent
      └─ ✓ Agent  Background · completed · duration: 5.0s
         task:     inspect Unicode café 🚀 and report progress",
        "error": "○ Background agents  1 recent
      └─ ✗ Agent  Background · failed · duration: 5.0s
         error:    provider unavailable",
        "queued": "● Background agents  1 queued
      └─ ◦ Agent  Background · queued
         task:     inspect Unicode café 🚀 and report progress
         activity: ▸ waiting for a background slot
         stack: deep · model: anthropic/claude-opus · thinking: high · ↻ turn 3 · max 10 · grace 2
         0 tool uses · 0 tokens · context: unavailable · ⇊ compactions: 0 · elapsed: 5.0s",
        "running": "● Background agents  1 running
      └─ ⠋ Agent  Background · running
         task:     inspect Unicode café 🚀 and report progress
         activity: ▸ thinking…
         stack: deep · model: anthropic/claude-opus · thinking: high · ↻ turn 3 · max 10 · grace 2
         0 tool uses · 0 tokens · context: unavailable · ⇊ compactions: 0 · elapsed: 5.0s",
        "steered": "○ Background agents  1 recent
      └─ ✓ Agent  Background · steered (turn limit) · duration: 5.0s
         task:     inspect Unicode café 🚀 and report progress",
        "stopped": "○ Background agents  1 recent
      └─ ■ Agent  Background · stopped · duration: 5.0s
         task:     inspect Unicode café 🚀 and report progress",
      }
    `);
    expect(Object.values(baseline).every((value) => !value.includes("\u001b"))).toBe(true);
  });

  it("uses textual state labels independent of color and glyphs", () => {
    const statuses: Array<[WidgetAgent["status"], string]> = [
      ["queued", "queued"],
      ["running", "running"],
      ["completed", "completed"],
      ["error", "failed"],
      ["aborted", "aborted"],
      ["stopped", "stopped"],
      ["steered", "steered"],
    ];
    for (const [status, label] of statuses) {
      const terminal = status !== "queued" && status !== "running";
      const text = render([
        makeAgent({ status, completedAt: terminal ? Date.now() : undefined }),
      ]).join("\n");
      expect(text).toContain("Background");
      expect(text).toContain(label);
    }
  });

  it("reports active counts and renders queued agents individually", () => {
    const text = render([
      makeAgent({ id: "q1", status: "queued", description: "first queued identity" }),
      makeAgent({ id: "q2", status: "queued", description: "second queued identity" }),
    ]).join("\n");
    expect(text).toContain("2 queued");
    expect(text).toContain("first queued identity");
    expect(text).toContain("second queued identity");
  });
});

describe("active-agent details", () => {
  it("shows background identity, invocation, budgets, usage, timing, and activity", () => {
    const text = render([
      makeAgent({
        toolUses: 4,
        lifetimeUsage: { input: 5000, output: 2000, cacheWrite: 1000 },
        compactionCount: 2,
        contextPercent: 45.678,
        activeTools: new Map([["read-1", "read"]]),
      }),
    ]).join("\n");
    for (const required of [
      "Background · running",
      "stack: deep",
      "model: anthropic/claude-opus",
      "thinking: high",
      "turn 3",
      "max 10",
      "grace 2",
      "4 tool uses",
      "8.0k tokens",
      "context: 45.7%",
      "compactions: 2",
      "elapsed:",
      "activity: ▸ reading",
    ]) {
      expect(text).toContain(required);
    }
  });

  it("labels unlimited budgets and unavailable context while retaining zero usage", () => {
    const text = render([
      makeAgent({ maxTurns: undefined, graceTurns: undefined, contextPercent: null }),
    ]).join("\n");
    expect(text).toContain("max unlimited");
    expect(text).toContain("grace unlimited");
    expect(text).toContain("0 tool uses");
    expect(text).toContain("0 tokens");
    expect(text).toContain("context: unavailable");
    expect(text).toContain("compactions: 0");
  });

  it("gives queued agents explicit waiting activity and the same metadata", () => {
    const text = render([makeAgent({ status: "queued" })]).join("\n");
    expect(text).toContain("Background · queued");
    expect(text).toContain("stack: deep");
    expect(text).toContain("activity: ▸ waiting for a background slot");
  });

  it("sanitizes every untrusted detail without flattening the hierarchy", () => {
    const lines = render([
      makeAgent({
        description: "inspect\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007\nforged row",
        stack: "\u001b[31mdeep\u001b[0m",
        model: "provider/model\nforged model",
        thinking: "high\tpriority",
        responseText: "working\u0007\nforged activity",
      }),
    ]);

    expect(lines.some((line) => line.includes("task:"))).toBe(true);
    expect(lines.some((line) => line.includes("activity:"))).toBe(true);
    expect(
      lines.every((line) =>
        [...line].every((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127 && (code < 128 || code > 159);
        }),
      ),
    ).toBe(true);
  });

  it("assigns semantic colors while keeping lifecycle states textual", () => {
    const fg = vi.fn((_color: string, text: string) => text);
    const theme: Theme = { fg, bold: (text) => text };

    render([makeAgent({ status: "queued" })], 120, theme);

    expect(fg).toHaveBeenCalledWith("warning", "queued");
    expect(fg).toHaveBeenCalledWith("warning", "1 queued");
    expect(fg).toHaveBeenCalledWith("dim", "Background · ");
  });
});

describe("width and row budgets", () => {
  it.each([40, 60, 80, 120])("stays within %i columns and retains required identity", (width) => {
    const lines = render([makeAgent()], width, ansiTheme);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    const text = lines.join("\n");
    for (const required of [
      "running",
      "stack:",
      "model:",
      "thinking:",
      "turn 3",
      "max 10",
      "grace 2",
      "0 tool uses",
      "0 tokens",
      "context:",
      "compactions:",
      "elapsed:",
      "activity:",
    ]) {
      expect(text).toContain(required);
    }
  });

  it("handles ANSI and wide Unicode without horizontal overflow", () => {
    const lines = render(
      [makeAgent({ description: "界".repeat(80), responseText: "🚀".repeat(80) })],
      40,
      ansiTheme,
    );
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(lines.join("\n")).toContain("Background");
  });

  it("never exceeds 12 rows and prioritizes running, queued, errors, then completions", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const agents: WidgetAgent[] = [
      makeAgent({ id: "run", description: "RUN-FIRST" }),
      makeAgent({ id: "queue", status: "queued", description: "QUEUE-SECOND" }),
      makeAgent({ id: "fail", status: "error", completedAt: NOW, error: "FAIL-THIRD" }),
      makeAgent({
        id: "done",
        status: "completed",
        completedAt: NOW,
        description: "DONE-LAST",
      }),
    ];
    const lines = render(agents, 60);
    const text = lines.join("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(text).toContain("RUN-FIRST");
    expect(text).toContain("hidden:");
    expect(text).toMatch(/\d+ queued/);
    expect(text).toMatch(/\d+ failed/);
    expect(text).toMatch(/\d+ completed/);
    expect(text).toMatchInlineSnapshot(`
      "● Background agents  1 running · 1 queued
      ├─ ⠋ Agent  Background · running
      │  task:     RUN-FIRST
      │  activity: ▸ thinking…
      │  stack: deep · model: anthropic/claude-opus
      │  thinking: high · ↻ turn 3 · max 10 · grace 2
      │  0 tool uses · 0 tokens · context: unavailable
      │  ⇊ compactions: 0 · elapsed: 5.0s
      └─ hidden: 1 queued · 1 failed · 1 completed"
    `);
  });

  it("remains width-safe down to a one-column render surface", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    for (const width of [1, 2, 4, 8, 16, 24]) {
      const lines = render([makeAgent()], width, ansiTheme);
      expect(lines.length).toBeLessThanOrEqual(12);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    const minimumBaseline = render([makeAgent()], 16).join("\n");
    expect(minimumBaseline).not.toContain("\u001b");
    expect(minimumBaseline).toMatchInlineSnapshot(`
      "● Background ...
      └─ hidden: 1 ..."
    `);
  });

  it("filters expired terminal agents", () => {
    const agent = makeAgent({ status: "completed", completedAt: Date.now() });
    const lines = renderWidgetLines({
      agents: [agent],
      registry,
      spinnerFrame: 0,
      terminalWidth: 80,
      theme: plainTheme,
      shouldShowFinished: () => false,
    });
    expect(lines).toEqual([]);
  });
});
