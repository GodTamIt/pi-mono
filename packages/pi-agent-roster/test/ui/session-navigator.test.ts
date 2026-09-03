import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types.ts";
import type { SessionMessage } from "../../src/types.ts";
import type { TranscriptSource } from "../../src/ui/session-navigation.ts";
import { SessionNavigatorHandler, TranscriptOverlay } from "../../src/ui/session-navigator.ts";
import { makeNavigable } from "../helpers/make-navigable.ts";
import { fakeSource, mockTui } from "../helpers/transcript-fixtures.ts";

const registry = new AgentTypeRegistry(() => new Map());

// Pi's per-entry components read the global interactive theme; Pi initializes it
// at startup before any command runs. Tests must initialize it explicitly.
beforeAll(() => initTheme(undefined, false));

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function makeOverlay(
  opts: { source?: TranscriptSource; done?: (r: undefined) => void; tui?: TUI } = {},
) {
  return new TranscriptOverlay({
    tui: opts.tui ?? mockTui(),
    theme: ansiTheme(),
    source: opts.source ?? fakeSource(),
    session: {
      key: "live:child-1",
      id: "child-1",
      name: "Agent",
      description: "Unicode task 設計 🚀",
      status: "running",
      duration: "2.0s",
      toolUses: 1,
      sourceLabel: "live session",
    },
    done: opts.done ?? vi.fn(),
    cwd: "/test/cwd",
    markdownTheme: getMarkdownTheme(),
  });
}

describe("TranscriptOverlay", () => {
  it("renders the transcript content", () => {
    const lines = makeOverlay().render(80);
    expect(lines.some((l) => l.includes("Hello world"))).toBe(true);
  });

  it("keeps one subscription and requests a render on change", () => {
    const tui = mockTui();
    let captured: (() => void) | undefined;
    const subscribe = vi.fn((onChange: () => void) => {
      captured = onChange;
      return () => {};
    });
    const source = fakeSource({ subscribe });
    const overlay = makeOverlay({ source, tui });
    overlay.render(80);
    overlay.render(60);
    captured?.();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });

  it.each(["\x1b", "q", "\x03"])("closes on %j and releases its subscription", (key) => {
    const done = vi.fn();
    const unsubscribe = vi.fn();
    const overlay = makeOverlay({ source: fakeSource({ subscribe: () => unsubscribe }), done });
    overlay.handleInput(key);
    expect(done).toHaveBeenCalledWith(undefined);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("unsubscribes on dispose", () => {
    const unsub = vi.fn();
    const overlay = makeOverlay({ source: fakeSource({ subscribe: () => unsub }) });
    overlay.dispose();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("does not request a render after dispose", () => {
    const tui = mockTui();
    let captured: (() => void) | undefined;
    const source = fakeSource({
      subscribe: (onChange) => {
        captured = onChange;
        return () => {};
      },
    });
    const overlay = makeOverlay({ source, tui });
    overlay.dispose();
    captured?.();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("appends the streaming-activity indicator while running", () => {
    const source = fakeSource({
      streaming: () => ({ activeTools: new Map([["k", "read"]]), responseText: "" }),
    });
    const out = makeOverlay({ source }).render(80).join("\n");
    expect(out).toContain("◍");
  });

  describe("scroll bounds", () => {
    // A 200-column terminal caps this overlay at 120 columns. Input must use
    // that rendered width rather than the terminal width when finding bounds.
    const OVERLAY_WIDTH = 120;
    const wrappingMessages = Array.from({ length: 30 }, (_, i) => ({
      role: "user",
      content: `${String(i).padStart(3, "0")} ${"wrap".repeat(46)}`,
    })) as unknown as SessionMessage[];

    function overlayAtBottom() {
      const overlay = makeOverlay({
        tui: mockTui(40, 200),
        source: fakeSource({ getMessages: () => wrappingMessages }),
      });
      const atBottom = overlay.render(OVERLAY_WIDTH);
      return { overlay, atBottom };
    }

    it("scrolls up from the bottom on a terminal wider than the overlay", () => {
      const { overlay, atBottom } = overlayAtBottom();
      overlay.handleInput("\x1b[A");
      expect(overlay.render(OVERLAY_WIDTH)).not.toEqual(atBottom);
    });

    it("returns to the bottom when scrolling back down", () => {
      const { overlay, atBottom } = overlayAtBottom();
      overlay.handleInput("\x1b[A");
      overlay.handleInput("\x1b[B");
      expect(overlay.render(OVERLAY_WIDTH)).toEqual(atBottom);
    });
  });

  it("supports arrows, j/k, pages and aliases, Home, and End without global shortcuts", () => {
    const source = fakeSource({
      getMessages: () =>
        Array.from({ length: 40 }, (_, i) => ({
          role: "user",
          content: `row ${i}`,
        })) as SessionMessage[],
    });
    const tui = mockTui();
    const overlay = makeOverlay({ source, tui });
    const bottom = overlay.render(80);

    for (const key of ["\x1b[A", "k", "\x1b[5~", "\x1b[1;2A", "\x1b[H"]) {
      overlay.handleInput(key);
    }
    expect(overlay.render(80)).not.toEqual(bottom);
    for (const key of ["\x1b[B", "j", "\x1b[6~", "\x1b[1;2B", "\x1b[F"]) {
      overlay.handleInput(key);
    }
    expect(overlay.render(80)).toEqual(bottom);
    const renders = vi.mocked(tui.requestRender).mock.calls.length;
    overlay.handleInput("x");
    expect(tui.requestRender).toHaveBeenCalledTimes(renders);
  });

  it.each([40, 60, 80, 120])(
    "wraps ANSI/Unicode-safe chrome and content at %i columns",
    (width) => {
      const lines = makeOverlay({
        source: fakeSource({
          getMessages: () =>
            [
              { role: "user", content: `\u001b[31m${"界🚀".repeat(40)}\u001b[0m` },
            ] as unknown as SessionMessage[],
        }),
      }).render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).toContain("Agent");
      expect(lines.join("\n")).toContain("child-1");
      expect(lines.join("\n")).toContain("live");
      expect(lines.join("\n")).toContain("session");
    },
  );

  it("pins compact monochrome chrome", () => {
    const output = makeOverlay({
      tui: mockTui(12, 40),
      source: fakeSource({ getMessages: () => [] }),
    })
      .render(40)
      .join("\n");

    expect(output).toMatchInlineSnapshot(`
      "╭──────────────────────────────────────╮
      │ Agent · running                      │
      │ ID child-1 · live session            │
      │ Unicode task 設計 🚀                 │
      │ ──────────────────────────────────── │
      │                                      │
      │                                      │
      │                                      │
      │ ──────────────────────────────────── │
      │ 0 lines · 100%                       │
      │ ↑↓/jk scroll · q close               │
      ╰──────────────────────────────────────╯"
    `);
    expect(output).not.toContain("\u001b");
  });

  it("bounds chrome at the minimum render width and keeps a three-row viewport", () => {
    const overlay = makeOverlay({
      tui: mockTui(8, 6),
      source: fakeSource({ getMessages: () => [] }),
    });

    expect(overlay.render(5)).toEqual([]);
    const lines = overlay.render(6);
    expect(lines.every((line) => visibleWidth(line) <= 6)).toBe(true);
    expect(lines.every((line) => !line.includes("\u001b"))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(13);
    const dividers = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith("│ ") && line.includes("──"));
    expect(dividers).toHaveLength(2);
    const [beforeViewport, afterViewport] = dividers;
    if (!beforeViewport || !afterViewport) throw new Error("viewport dividers missing");
    expect(afterViewport.index - beforeViewport.index - 1).toBe(3);
  });

  it("caps a long narrow header instead of allowing it to consume the viewport", () => {
    const overlay = new TranscriptOverlay({
      tui: mockTui(10, 24),
      theme: ansiTheme(),
      source: fakeSource({ getMessages: () => [] }),
      session: {
        key: "live:long",
        id: "child-with-a-very-long-id",
        name: "Long-running architecture specialist",
        description: "界🚀".repeat(100),
        status: "running",
        duration: "2.0s",
        toolUses: 1,
        sourceLabel: "live session",
      },
      done: vi.fn(),
      cwd: "/test/cwd",
      markdownTheme: getMarkdownTheme(),
    });

    const lines = overlay.render(24);
    expect(lines).toHaveLength(13);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(lines.join("\n")).toContain("…");
  });

  it("refreshes its content when the source changes", () => {
    let messages = [{ role: "user", content: "first" }] as unknown as SessionMessage[];
    let captured: (() => void) | undefined;
    const source = fakeSource({
      getMessages: () => messages,
      subscribe: (onChange) => {
        captured = onChange;
        return () => {};
      },
    });
    const overlay = makeOverlay({ source });
    expect(overlay.render(80).join("\n")).toContain("first");
    messages = [{ role: "user", content: "second" }] as unknown as SessionMessage[];
    captured?.();
    expect(overlay.render(80).join("\n")).toContain("second");
  });
});

describe("SessionNavigatorHandler", () => {
  function makeUI(pickerResult?: string) {
    return {
      notify: vi.fn(),
      custom: vi.fn().mockResolvedValueOnce(pickerResult).mockResolvedValue(undefined),
    };
  }

  function renderCapturedPicker(ui: ReturnType<typeof makeUI>, width = 120): string[] {
    const call = ui.custom.mock.calls[0];
    if (!call) throw new Error("picker call missing");
    const factory = call[0] as (
      tui: TUI,
      theme: ReturnType<typeof ansiTheme>,
      kb: unknown,
      done: (r: string | undefined) => void,
    ) => Component;
    return factory(mockTui(), ansiTheme(), undefined, vi.fn()).render(width);
  }

  // Invoke the overlay factory captured by the handler's second ui.custom call.
  function renderCapturedOverlay(ui: ReturnType<typeof makeUI>, width = 80): string[] {
    const call = ui.custom.mock.calls[1];
    if (!call) throw new Error("overlay call missing");
    const factory = call[0] as (
      tui: TUI,
      theme: ReturnType<typeof ansiTheme>,
      kb: unknown,
      done: (r: undefined) => void,
    ) => Component;
    const overlay = factory(mockTui(), ansiTheme(), undefined, vi.fn());
    return overlay.render(width);
  }

  const noReadFile = (): string => {
    throw new Error("readFile not expected in this test");
  };

  it("notifies and skips the overlay when no sessions are navigable", async () => {
    const ui = makeUI();
    const notReady = makeNavigable({ isSessionReady: () => false, outputFile: undefined });
    await new SessionNavigatorHandler().handle({
      ui,
      agents: [notReady],
      registry,
      cwd: "/test/cwd",
      readFile: noReadFile,
    });
    expect(ui.notify).toHaveBeenCalledWith("No subagent sessions to view.", "info");
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("does not open the overlay when the operator cancels the picker", async () => {
    const ui = makeUI(undefined);
    await new SessionNavigatorHandler().handle({
      ui,
      agents: [makeNavigable()],
      registry,
      cwd: "/test/cwd",
      readFile: noReadFile,
    });
    expect(ui.custom).toHaveBeenCalledOnce();
  });

  it("opens a read-only overlay sourced from the picked record", async () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "picked agent reply" }] },
    ] as unknown as SessionMessage[];
    const record = makeNavigable({ agentMessages: messages });
    const ui = makeUI("live:agent-1");

    await new SessionNavigatorHandler().handle({
      ui,
      agents: [record],
      registry,
      cwd: "/test/cwd",
      readFile: noReadFile,
    });

    expect(ui.custom).toHaveBeenCalledTimes(2);
    const overlayCall = ui.custom.mock.calls[1];
    if (!overlayCall) throw new Error("overlay call missing");
    expect(overlayCall[1]).toMatchObject({
      overlayOptions: { width: 120, maxHeight: "70%" },
    });
    const picker = renderCapturedPicker(ui).join("\n");
    expect(picker).toContain("Agent · completed");
    expect(picker).toContain("Test task");
    expect(picker).toContain("ID agent-1 · 3.0s · 2 tool uses · live session");
    // Invariant #423: the handler is a reactive consumer — it sources the
    // transcript and never reads tool definitions off the record itself; only
    // the overlay does, lazily, through the TranscriptSource at render time.
    expect(record.getToolDefinition).not.toHaveBeenCalled();
    // Invoke the captured component factory and render to confirm it is sourced from the picked record.
    expect(renderCapturedOverlay(ui).some((l) => l.includes("picked agent reply"))).toBe(true);
  });

  it("selects duplicate display labels by stable child key", async () => {
    const first = makeNavigable({
      id: "first",
      agentMessages: [{ role: "user", content: "first transcript" }] as unknown as SessionMessage[],
    });
    const second = makeNavigable({
      id: "second",
      agentMessages: [
        { role: "user", content: "second transcript" },
      ] as unknown as SessionMessage[],
    });
    const ui = makeUI("live:second");

    await new SessionNavigatorHandler().handle({
      ui,
      agents: [first, second],
      registry,
      cwd: "/test/cwd",
      readFile: noReadFile,
    });

    const rendered = renderCapturedOverlay(ui).join("\n");
    expect(rendered).toContain("second transcript");
    expect(rendered).not.toContain("first transcript");
  });

  it("opens an overlay sourced from the persisted file when a released agent is picked", async () => {
    const jsonl = [
      { type: "session", version: 3, id: "s1", timestamp: "2026-06-23T00:00:00Z", cwd: "/proj" },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-06-23T00:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "released reply" }] },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const readFile = vi.fn(() => jsonl);
    const released = makeNavigable({
      id: "e1",
      description: "Old task",
      status: "completed",
      startedAt: 1000,
      completedAt: 4000,
      toolUses: 5,
      isSessionReady: () => false,
      outputFile: "/tasks/e1.jsonl",
    });
    const ui = makeUI("snapshot:e1");

    await new SessionNavigatorHandler().handle({
      ui,
      agents: [released],
      registry,
      cwd: "/test/cwd",
      readFile,
    });

    expect(readFile).toHaveBeenCalledWith("/tasks/e1.jsonl");
    expect(ui.custom).toHaveBeenCalledTimes(2);
    const rendered = renderCapturedOverlay(ui).join("\n");
    expect(rendered).toContain("released reply");
    expect(rendered).toContain("ID e1");
    expect(rendered).toContain("released snapshot");
  });

  it("notifies and skips the overlay when the session file cannot be read", async () => {
    const readFile = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const released = makeNavigable({
      id: "e1",
      description: "Old task",
      status: "completed",
      startedAt: 1000,
      completedAt: 4000,
      toolUses: 5,
      isSessionReady: () => false,
      outputFile: "/tasks/e1.jsonl",
    });
    const ui = makeUI("snapshot:e1");

    await new SessionNavigatorHandler().handle({
      ui,
      agents: [released],
      registry,
      cwd: "/test/cwd",
      readFile,
    });

    expect(ui.notify).toHaveBeenCalledWith("Could not read the session transcript file.", "error");
    expect(ui.custom).toHaveBeenCalledOnce();
  });
});
