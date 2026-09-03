import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.ts";
import { PRIMARY_AGENT_FLAG, PRIMARY_STACK_FLAG } from "../src/public.ts";

function loadExtension() {
  const pi = {
    registerFlag: vi.fn(),
  } as unknown as ExtensionAPI;

  extension(pi);
  return pi;
}

function loadInteractiveExtension() {
  const pi = {
    registerFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn(),
    getThinkingLevel: vi.fn(() => "off"),
    setThinkingLevel: vi.fn(),
    getActiveTools: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
    setModel: vi.fn(async () => true),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;

  extension(pi);
  return pi;
}

describe("pi-agent-roster extension", () => {
  it("registers only the primary agent and stack flags", () => {
    const pi = loadExtension();

    expect(pi.registerFlag).toHaveBeenCalledTimes(2);
    expect(pi.registerFlag).toHaveBeenNthCalledWith(1, PRIMARY_AGENT_FLAG, {
      description: expect.any(String),
      type: "string",
    });
    expect(pi.registerFlag).toHaveBeenNthCalledWith(2, PRIMARY_STACK_FLAG, {
      description: expect.any(String),
      type: "string",
    });
  });

  it("routes registry diagnostics through session UI once across reloads", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-roster-extension-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "broken.md"), "---\ntools: [read]\n---\nBroken.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const pi = loadInteractiveExtension();
      type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
      type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      type TestCommand = { handler: CommandHandler };
      const handlers = new Map<string, EventHandler>(
        vi.mocked(pi.on).mock.calls as unknown as Array<[string, EventHandler]>,
      );
      const commands = new Map<string, TestCommand>(
        vi.mocked(pi.registerCommand).mock.calls as unknown as Array<[string, TestCommand]>,
      );
      const notify = vi.fn();
      const ctx = {
        cwd,
        model: undefined,
        ui: { notify, setStatus: vi.fn() },
        getSystemPrompt: () => "system prompt",
        waitForIdle: async () => undefined,
      } as unknown as ExtensionCommandContext;

      await handlers.get("session_start")?.({}, ctx);
      await commands.get("agents:reload")?.handler("", ctx);
      await commands.get("agents:reload")?.handler("", ctx);

      const diagnostics = notify.mock.calls.filter(([message]) =>
        String(message).includes("tools is unsupported"),
      );
      expect(diagnostics).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("registers idle-gated shortcuts that dispatch the agent and stack commands", () => {
    const pi = loadInteractiveExtension();

    expect(pi.registerShortcut).toHaveBeenCalledTimes(2);
    expect(pi.registerShortcut).toHaveBeenNthCalledWith(1, Key.ctrlAlt("a"), {
      description: "Open the primary agent selector",
      handler: expect.any(Function),
    });
    expect(pi.registerShortcut).toHaveBeenNthCalledWith(2, Key.ctrlAlt("s"), {
      description: "Open the stack selector for the active primary",
      handler: expect.any(Function),
    });

    const agentShortcut = vi.mocked(pi.registerShortcut).mock.calls[0];
    const stackShortcut = vi.mocked(pi.registerShortcut).mock.calls[1];
    if (!agentShortcut || !stackShortcut) throw new Error("shortcuts were not registered");
    const agentHandler = agentShortcut[1].handler;
    const stackHandler = stackShortcut[1].handler;
    const notify = vi.fn();
    const idleCtx = {
      isIdle: () => true,
      ui: { notify },
    } as unknown as ExtensionContext;

    agentHandler(idleCtx);
    stackHandler(idleCtx);

    expect(pi.sendUserMessage).toHaveBeenNthCalledWith(1, "/agent", {
      expandPromptTemplates: true,
    });
    expect(pi.sendUserMessage).toHaveBeenNthCalledWith(2, "/stack", {
      expandPromptTemplates: true,
    });

    const busyCtx = {
      isIdle: () => false,
      ui: { notify },
    } as unknown as ExtensionContext;
    agentHandler(busyCtx);
    stackHandler(busyCtx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
