import type { ExtensionAPI, MessageUpdateEvent, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  stripTerminalSequences,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ file: "{}", write: vi.fn(async () => {}) }));
vi.mock("node:os", () => ({ homedir: () => "/test-home" }));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readFileSync: () => config.file,
  promises: { readFile: async () => config.file, writeFile: config.write },
}));

import tpsExtension from "../extensions/pi-tps.ts";

type Handler = (event: never, ctx: never) => Promise<unknown>;
type Command = { handler: (args: string, ctx: never) => Promise<void> };

function setup(mode = "rpc", responses: Array<string | undefined> = []) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  tpsExtension({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
  } as unknown as ExtensionAPI);
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const requestRender = vi.fn();
  let component: Component | undefined;
  const widgets: Array<string[] | undefined> = [];
  const ui = {
    theme,
    setWidget: vi.fn(
      (_key: string, value: string[] | undefined | ((tui: TUI, theme: Theme) => Component)) => {
        if (typeof value === "function") {
          expect(mode).toBe("tui");
          component = value({ requestRender } as unknown as TUI, theme);
        } else {
          widgets.push(value);
          if (!value) component = undefined;
        }
      },
    ),
    notify: vi.fn(),
    select: vi.fn(async (_title: string, choices: string[]) => {
      const response = responses.shift();
      if (response !== undefined) expect(choices).toContain(response);
      return response;
    }),
    input: vi.fn(async () => responses.shift()),
  };
  const ctx = { mode, hasUI: mode === "rpc" || mode === "tui", ui };
  return {
    ui,
    widgets,
    requestRender,
    emit: async (name: string, event: object = {}) => {
      const handler = handlers.get(name);
      expect(handler).toBeDefined();
      await handler?.(event as never, ctx as never);
    },
    command: async () => commands.get("pi-tps")?.handler("", ctx as never),
    lines: (width = 80) => component?.render(width) ?? widgets.at(-1) ?? [],
  };
}

function message(
  output = 0,
  input = 100,
): Extract<MessageUpdateEvent["message"], { role: "assistant" }> {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    timestamp: Date.now(),
    stopReason: "pending",
    usage: {
      input,
      output,
      reasoning: 2000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function start(s: ReturnType<typeof setup>) {
  await s.emit("agent_start");
  await s.emit("turn_start");
  await s.emit("before_provider_request");
  await s.emit("message_start", { message: message() });
}

async function delta(
  s: ReturnType<typeof setup>,
  time: number,
  type: "thinking_delta" | "text_delta",
  text: string,
  output = 0,
) {
  vi.setSystemTime(time);
  const partial = message(output);
  await s.emit("message_update", {
    message: partial,
    assistantMessageEvent: { type, contentIndex: 0, delta: text, partial },
  });
}

function tps(s: ReturnType<typeof setup>) {
  return Number(stripTerminalSequences(s.lines()[0] ?? "").match(/⚡ (\d+)t\/s/)?.[1]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  config.file = "{}";
  config.write.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("live TPS shared thinking/text interval", () => {
  it.each(["provider", "estimated"])(
    "retains the interval and EMA for %s tokens",
    async (source) => {
      const s = setup();
      await start(s);
      // Establish TTFT without feeding a nonzero estimate into the unchanged EMA.
      await delta(s, 2000, "thinking_delta", "x");
      await delta(s, 42000, "thinking_delta", "x".repeat(7999), source === "provider" ? 2000 : 0);
      expect(tps(s)).toBe(50);
      // First text arrives 81ms later: the former text-first denominator spikes here.
      await delta(s, 42081, "text_delta", "x", source === "provider" ? 2000 : 0);
      const transition = 0.15 * (2000 / 40.081) + 0.85 * 50;
      expect(tps(s)).toBe(Math.round(transition));
      await delta(s, 45081, "text_delta", "x".repeat(524), source === "provider" ? 2150 : 0);
      const live = 0.15 * (2150 / 43.081) + 0.85 * transition;
      expect(tps(s)).toBe(Math.round(live));
      expect(s.lines()[0]).toContain("↓ 2.1k");
      expect(s.lines()[0]).toContain("🧠 2.0k");
      // Final usage remains authoritative, with the same EMA rather than raw TPS.
      vi.setSystemTime(46081);
      await s.emit("message_end", { message: message(2200, 120) });
      expect(tps(s)).toBe(Math.round(0.15 * (2200 / 44.081) + 0.85 * live));
      expect(s.lines()[0]).toContain("↑ 120 ↓ 2.2k");
      expect(s.lines().join("\n")).toContain("▓");
      expect(s.lines().join("\n")).toContain("█");
      await s.emit("turn_end");
      await s.emit("agent_end");
      expect(s.widgets.at(-1)).toBeUndefined();
      expect(s.ui.notify).toHaveBeenCalledOnce();
      expect(s.ui.notify.mock.calls[0]?.[0]).toContain("50t/s");
      expect(s.ui.notify.mock.calls[0]?.[0]).not.toContain("\u001b[");
    },
  );

  it("uses provider usage over estimates and preserves text-only finalization", async () => {
    const s = setup();
    await start(s);
    await delta(s, 2000, "text_delta", "x");
    await delta(s, 5000, "text_delta", "x".repeat(524), 300);
    expect(tps(s)).toBe(100);
    expect(s.lines()[0]).toContain("↓ 300");
    vi.setSystemTime(6000);
    await s.emit("message_end", { message: message(320) });
    expect(tps(s)).toBe(97);
    await s.emit("agent_end");
    expect(s.ui.notify.mock.calls[0]?.[0]).toContain("97t/s");
  });
});

describe("mode-aware widget and configuration", () => {
  it("publishes event-driven RPC string widgets, including tools, and clears on completion", async () => {
    const s = setup();
    await start(s);
    expect(s.lines().join("\n")).toContain("⚡ …");
    await delta(s, 2000, "text_delta", "hello");
    const count = s.ui.setWidget.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(s.ui.setWidget).toHaveBeenCalledTimes(count);
    await s.emit("tool_execution_start", { toolName: "read", toolCallId: "tool" });
    expect(s.lines().join("\n")).toContain("read");
    await s.emit("tool_execution_end", { toolCallId: "tool" });
    expect(
      s.widgets.filter(Boolean).every((lines) => lines?.every((line) => !line.includes("\u001b["))),
    ).toBe(true);
    await s.emit("agent_end");
    expect(s.widgets.at(-1)).toBeUndefined();
    expect(s.ui.setWidget.mock.calls.at(-1)).toEqual(["pi-tps", undefined]);
  });

  it("keeps terminal styling and line widths, invalidates on events, and cleans up", async () => {
    const s = setup("tui");
    await start(s);
    await delta(s, 2000, "thinking_delta", "x".repeat(400));
    for (const width of [8, 20, 40, 80, 160]) {
      expect(s.lines(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(s.lines().join("\n")).toContain("\u001b[");
    const previous = s.lines();
    expect(s.lines()).toBe(previous);
    const renders = s.requestRender.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(s.requestRender).toHaveBeenCalledTimes(renders);
    await delta(s, 4000, "text_delta", "hello");
    expect(s.requestRender.mock.calls.length).toBeGreaterThan(renders);
    expect(s.lines()).not.toBe(previous);
    await s.emit("agent_end");
    expect(s.ui.setWidget.mock.calls.at(-1)).toEqual(["pi-tps", undefined]);
  });

  it("clears a live widget on session shutdown without requiring agent_end", async () => {
    const s = setup();
    await start(s);
    await s.emit("session_shutdown");
    expect(s.ui.setWidget.mock.calls.at(-1)).toEqual(["pi-tps", undefined]);
    const count = s.ui.setWidget.mock.calls.length;
    await s.emit("turn_end");
    expect(s.ui.setWidget).toHaveBeenCalledTimes(count);
  });

  it("runs RPC select/input/result configuration and preserves cancellation and validation", async () => {
    const s = setup("rpc", ["Detailed traces count [6]", "3"]);
    await start(s);
    await s.command();
    expect(s.ui.input).toHaveBeenCalledWith("Detailed traces count (current: 6):", "6");
    expect(config.write).toHaveBeenCalledWith(
      "/test-home/.pi/agent/pi-tps.json",
      expect.stringContaining('"maxDetailed": 3'),
    );
    expect(s.ui.notify).toHaveBeenCalledWith("maxDetailed = 3", "info");
    const invalid = setup("rpc", ["Memory limit (total)  [100]", "0"]);
    await invalid.command();
    expect(invalid.ui.notify).toHaveBeenCalledWith("Invalid — must be positive number", "error");
    expect(config.write).toHaveBeenCalledOnce();
    const cancelled = setup("rpc", [undefined]);
    await cancelled.command();
    expect(cancelled.ui.input).not.toHaveBeenCalled();
    expect(cancelled.ui.notify).not.toHaveBeenCalled();
  });

  it.each(["json", "print"])(
    "never prompts or calls UI in %s and gives actionable configuration errors",
    async (mode) => {
      const s = setup(mode);
      await start(s);
      await delta(s, 2000, "text_delta", "hello");
      await s.emit("message_end", { message: message(10) });
      await s.emit("agent_end");
      await expect(s.command()).rejects.toThrow(
        "requires interactive TUI or RPC mode; edit /test-home/.pi/agent/pi-tps.json",
      );
      expect(s.ui.select).not.toHaveBeenCalled();
      expect(s.ui.input).not.toHaveBeenCalled();
      expect(s.ui.setWidget).not.toHaveBeenCalled();
      expect(s.ui.notify).not.toHaveBeenCalled();
    },
  );
});
