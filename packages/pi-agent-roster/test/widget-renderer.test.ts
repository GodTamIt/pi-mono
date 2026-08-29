import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
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

function makeAgent(overrides: Partial<WidgetAgent> = {}): WidgetAgent {
  return {
    id: "agent-1",
    type: "general-purpose",
    status: "running",
    description: "inspect Unicode café 🚀 and report progress",
    toolUses: 0,
    startedAt: Date.now() - 5000,
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
        contextPercent: 45,
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
      "8.0k token",
      "context: 45%",
      "compactions: 2",
      "elapsed:",
      "activity: reading",
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
    expect(text).toContain("0 token");
    expect(text).toContain("context: unavailable");
    expect(text).toContain("compactions: 0");
  });

  it("gives queued agents explicit waiting activity and the same metadata", () => {
    const text = render([makeAgent({ status: "queued" })]).join("\n");
    expect(text).toContain("Background · queued");
    expect(text).toContain("stack: deep");
    expect(text).toContain("activity: waiting for a background slot");
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
      "0 token",
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
    const agents: WidgetAgent[] = [
      makeAgent({ id: "run", description: "RUN-FIRST" }),
      makeAgent({ id: "queue", status: "queued", description: "QUEUE-SECOND" }),
      makeAgent({ id: "fail", status: "error", completedAt: Date.now(), error: "FAIL-THIRD" }),
      makeAgent({
        id: "done",
        status: "completed",
        completedAt: Date.now(),
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
