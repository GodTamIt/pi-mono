import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/custom-agents.ts", () => ({
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
}));

vi.mock("../src/lifecycle/create-subagent-session.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lifecycle/create-subagent-session.ts")
  >("../src/lifecycle/create-subagent-session.ts");
  return {
    ...actual,
    createSubagentSession: vi.fn(),
  };
});

import subagentsExtension from "../src/index.ts";
import { createSubagentSession } from "../src/lifecycle/create-subagent-session.ts";
import { makeModel } from "./helpers/make-model.ts";
import {
  createMockSession,
  createSubagentSessionStub,
  toSubagentSession,
} from "./helpers/mock-session.ts";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      getFlag: vi.fn(),
      getThinkingLevel: vi.fn(() => "off"),
      setThinkingLevel: vi.fn(),
      getActiveTools: vi.fn(() => [...tools.keys()]),
      getAllTools: vi.fn(() => [...tools.values()]),
      setActiveTools: vi.fn(),
      setModel: vi.fn(async () => true),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
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
  } as any;
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
