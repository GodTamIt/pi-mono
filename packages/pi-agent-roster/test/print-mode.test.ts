import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/custom-agents.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/config/custom-agents.ts")>(
    "../src/config/custom-agents.ts",
  );
  return {
    ...actual,
    loadCustomAgents: () =>
      new Map([
        [
          "general-purpose",
          {
            name: "general-purpose",
            description: "Test agent",
            systemPrompt: "",
            promptMode: "append",
            enabled: true,
          },
        ],
      ]),
  };
});

vi.mock("../src/lifecycle/create-subagent-session.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lifecycle/create-subagent-session.ts")
  >("../src/lifecycle/create-subagent-session.ts");
  return {
    ...actual,
    createSubagentSession: vi.fn(),
  };
});

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../src/index.ts";
import { createSubagentSession } from "../src/lifecycle/create-subagent-session.ts";
import { makeModel } from "./helpers/make-model.ts";
import {
  createMockSession,
  createSubagentSessionStub,
  toSubagentSession,
} from "./helpers/mock-session.ts";

type RegisteredTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};
type Handler = (...args: unknown[]) => unknown;

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      getFlag: vi.fn(),
      getThinkingLevel: vi.fn(() => "off"),
      setThinkingLevel: vi.fn(),
      getActiveTools: vi.fn(() => [...tools.keys()]),
      getAllTools: vi.fn(() => [...tools.values()]),
      setActiveTools: vi.fn(),
      setModel: vi.fn(async () => true),
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: Handler) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as unknown as ExtensionAPI,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  const model = makeModel({ provider: "test", id: "headless" });
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
    cwd: "/tmp",
    model,
    modelRegistry: {
      find: vi.fn((provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
      ),
      getAvailable: vi.fn(() => [model]),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  };
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(createSubagentSession).mockResolvedValue(
      toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
    );

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    // Fire session_start so runtime.currentCtx is populated for buildSnapshot
    const ctx = makeHeadlessCtx();
    await handlers.get("session_start")?.({}, ctx);

    const agentTool = tools.get("subagent");
    if (!agentTool) throw new Error("Expected subagent tool");
    await agentTool.execute(
      "tool-call-1",
      {
        task: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
