import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

    const agentHandler = vi.mocked(pi.registerShortcut).mock.calls[0]![1].handler;
    const stackHandler = vi.mocked(pi.registerShortcut).mock.calls[1]![1].handler;
    const notify = vi.fn();
    const idleCtx = {
      isIdle: () => true,
      ui: { notify },
    } as any;

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
    } as any;
    agentHandler(busyCtx);
    stackHandler(busyCtx);

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
