import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types.ts";
import type { Subagent } from "../../src/lifecycle/subagent.ts";
import type { SubagentManager } from "../../src/lifecycle/subagent-manager.ts";
import type { CompactionInfo } from "../../src/types.ts";
import { AgentWidget, assembleWidgetState, type UICtx } from "../../src/ui/agent-widget.ts";
import { FooterStatus } from "../../src/ui/footer-status.ts";
import { createTestSubagent } from "../helpers/make-subagent.ts";

// Minimal agent fixture — only the three fields AgentSummary requires.
function makeAgent(
  overrides: { id?: string; status?: string; completedAt?: number | undefined } = {},
) {
  return {
    id: "agent-1",
    status: "completed",
    completedAt: 5000,
    ...overrides,
  };
}

// shouldShowFinished stub that always returns true (default) or a fixed value.
const alwaysShow = () => true;
const neverShow = () => false;

// Build a widget over a manager stub whose listAgents() returns a fixed list,
// plus a recording UICtx. setWidgetCalls captures the `content` arg of each
// setWidget call: a function means the widget is registered/visible; undefined
// means it was cleared (the finished agent has aged out).
// Fixtures default to a background invocation so they survive the widget's
// background-only filter; per-agent `invocation` overrides the default.
function makeWidget(
  agents: Array<{
    id: string;
    status: string;
    completedAt?: number;
    invocation?: { runInBackground: boolean };
  }>,
) {
  const manager = {
    listAgents: () => agents.map((a) => ({ invocation: { runInBackground: true }, ...a })),
  } as unknown as SubagentManager;
  const registry = new AgentTypeRegistry(() => new Map());
  const widget = new AgentWidget(manager, registry, new FooterStatus());
  const setWidgetCalls: unknown[] = [];
  const ui: UICtx = {
    setStatus: () => {},
    setWidget: (_key, content) => {
      setWidgetCalls.push(content);
    },
  };
  widget.setUICtx(ui);
  const lastContent = () => setWidgetCalls.at(-1);
  return { widget, lastContent };
}

describe("assembleWidgetState", () => {
  describe("empty list", () => {
    it("returns all-zero/false state for an empty agent list", () => {
      expect(assembleWidgetState([], alwaysShow)).toEqual({
        runningCount: 0,
        queuedCount: 0,
        hasFinished: false,
        hasActive: false,
      });
    });
  });

  describe("running agents", () => {
    it("counts a single running agent", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "running", completedAt: undefined })],
        alwaysShow,
      );
      expect(state.runningCount).toBe(1);
      expect(state.queuedCount).toBe(0);
      expect(state.hasFinished).toBe(false);
      expect(state.hasActive).toBe(true);
    });

    it("counts multiple running agents", () => {
      const agents = [
        makeAgent({ id: "a1", status: "running", completedAt: undefined }),
        makeAgent({ id: "a2", status: "running", completedAt: undefined }),
        makeAgent({ id: "a3", status: "running", completedAt: undefined }),
      ];
      expect(assembleWidgetState(agents, alwaysShow).runningCount).toBe(3);
    });
  });

  describe("queued agents", () => {
    it("counts a single queued agent", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "queued", completedAt: undefined })],
        alwaysShow,
      );
      expect(state.runningCount).toBe(0);
      expect(state.queuedCount).toBe(1);
      expect(state.hasFinished).toBe(false);
      expect(state.hasActive).toBe(true);
    });

    it("counts multiple queued agents", () => {
      const agents = [
        makeAgent({ id: "a1", status: "queued", completedAt: undefined }),
        makeAgent({ id: "a2", status: "queued", completedAt: undefined }),
      ];
      expect(assembleWidgetState(agents, alwaysShow).queuedCount).toBe(2);
    });
  });

  describe("finished agents", () => {
    it("sets hasFinished when a completed agent has completedAt and shouldShowFinished returns true", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "completed", completedAt: 5000 })],
        alwaysShow,
      );
      expect(state.hasFinished).toBe(true);
      expect(state.hasActive).toBe(false);
    });

    it("does not set hasFinished when shouldShowFinished returns false", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "completed", completedAt: 5000 })],
        neverShow,
      );
      expect(state.hasFinished).toBe(false);
    });

    it("does not set hasFinished when completedAt is absent", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "error", completedAt: undefined })],
        alwaysShow,
      );
      expect(state.hasFinished).toBe(false);
    });

    it("passes agentId and status to shouldShowFinished", () => {
      const calls: Array<{ id: string; status: string }> = [];
      assembleWidgetState(
        [makeAgent({ id: "agent-42", status: "error", completedAt: 9000 })],
        (id, status) => {
          calls.push({ id, status });
          return true;
        },
      );
      expect(calls).toEqual([{ id: "agent-42", status: "error" }]);
    });

    it("sets hasFinished for error status agents when shouldShowFinished returns true", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "error", completedAt: 5000 })],
        alwaysShow,
      );
      expect(state.hasFinished).toBe(true);
    });
  });

  describe("mixed states", () => {
    it("counts running and queued independently", () => {
      const agents = [
        makeAgent({ id: "a1", status: "running", completedAt: undefined }),
        makeAgent({ id: "a2", status: "running", completedAt: undefined }),
        makeAgent({ id: "a3", status: "queued", completedAt: undefined }),
      ];
      const state = assembleWidgetState(agents, alwaysShow);
      expect(state.runningCount).toBe(2);
      expect(state.queuedCount).toBe(1);
      expect(state.hasActive).toBe(true);
      expect(state.hasFinished).toBe(false);
    });

    it("reports both hasActive and hasFinished when present", () => {
      const agents = [
        makeAgent({ id: "a1", status: "running", completedAt: undefined }),
        makeAgent({ id: "a2", status: "completed", completedAt: 5000 }),
      ];
      const state = assembleWidgetState(agents, alwaysShow);
      expect(state.hasActive).toBe(true);
      expect(state.hasFinished).toBe(true);
      expect(state.runningCount).toBe(1);
    });

    it("running agents are not counted as finished even if completedAt is set", () => {
      // Unusual but defensive: a running agent with a completedAt should
      // be counted as running, not finished.
      const state = assembleWidgetState(
        [makeAgent({ status: "running", completedAt: 5000 })],
        alwaysShow,
      );
      expect(state.runningCount).toBe(1);
      expect(state.hasFinished).toBe(false);
    });
  });

  describe("hasActive derivation", () => {
    it("is false when only finished agents exist", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "completed", completedAt: 5000 })],
        alwaysShow,
      );
      expect(state.hasActive).toBe(false);
    });

    it("is true with any running agent", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "running", completedAt: undefined })],
        neverShow,
      );
      expect(state.hasActive).toBe(true);
    });

    it("is true with any queued agent", () => {
      const state = assembleWidgetState(
        [makeAgent({ status: "queued", completedAt: undefined })],
        neverShow,
      );
      expect(state.hasActive).toBe(true);
    });
  });
});

describe("AgentWidget — footer counts", () => {
  it("removes idle counts without erasing task and primary state", () => {
    const agents = [
      { id: "a1", status: "running", invocation: { runInBackground: true } },
      { id: "a2", status: "queued", invocation: { runInBackground: true } },
    ];
    const manager = { listAgents: () => agents } as unknown as SubagentManager;
    const footer = new FooterStatus();
    const setStatus = vi.fn();
    footer.attach({ setStatus });
    footer.setTaskPrompt("Current task");
    footer.setPrimary("Lead", "deep");
    const widget = new AgentWidget(manager, new AgentTypeRegistry(() => new Map()), footer);
    widget.setUICtx({ setStatus, setWidget: vi.fn() });

    widget.update();
    expect(setStatus).toHaveBeenLastCalledWith(
      "subagents",
      "Current task · Lead · stack: deep · agents: 1 running, 1 queued",
    );

    agents.splice(0);
    widget.update();
    expect(setStatus).toHaveBeenLastCalledWith("subagents", "Current task · Lead · stack: deep");
  });
});

describe("AgentWidget — projection reads progress off Subagent records", () => {
  it("surfaces compact progress and resolved invocation metadata via renderWidget", () => {
    const record = createTestSubagent({
      status: "running",
      completedAt: undefined,
      startedAt: Date.now() - 100,
      turnCount: 3,
      activeTools: ["read"],
      maxTurns: 6,
      graceTurns: 0,
      invocation: {
        runInBackground: true,
        stack: "deep",
        modelName: "anthropic/claude-opus",
        thinking: "high",
      },
    });
    const manager = { listAgents: () => [record] } as unknown as SubagentManager;
    const registry = new AgentTypeRegistry(() => new Map());
    const widget = new AgentWidget(manager, registry, new FooterStatus());

    let renderFn: ((tui: unknown, theme: unknown) => { render(): string[] }) | undefined;
    const ui: UICtx = {
      setStatus: () => {},
      setWidget: (_key, content) => {
        if (typeof content === "function") renderFn = content as typeof renderFn;
      },
    };
    widget.setUICtx(ui);
    widget.update();

    expect(renderFn).toBeDefined();
    const stubTui = {
      terminal: { columns: 200 },
      mode: "regular" as const,
      requestRender: () => {},
    };
    const stubTheme = { fg: (_: string, t: string) => t, bold: (t: string) => t };
    if (typeof renderFn !== "function") throw new Error("widget factory missing");
    const lines = renderFn(stubTui, stubTheme).render();
    const allText = lines.join("\n");
    expect(allText).toContain("turns: 3/6");
    expect(allText).toContain("tools: 3");
    expect(allText).toContain("stack: deep");
    expect(allText).toContain("model: anthropic/claude-opus");
    expect(allText).not.toContain("grace");
    expect(allText).not.toContain("thinking");
    expect(allText).not.toContain("reading");
  });
});

describe("AgentWidget.update self-seeds finished agents", () => {
  it("keeps a completion for one complete subsequent parent turn", () => {
    const { widget, lastContent } = makeWidget([
      { id: "a1", status: "completed", completedAt: 5000 },
    ]);
    widget.update();
    expect(typeof lastContent()).toBe("function");
    widget.onTurnStart();
    expect(typeof lastContent()).toBe("function");
    widget.onTurnStart();
    expect(lastContent()).toBeUndefined();
  });

  it.each(["error", "aborted", "stopped", "steered"])(
    "keeps %s for two complete subsequent parent turns",
    (status) => {
      const { widget, lastContent } = makeWidget([{ id: "a1", status, completedAt: 5000 }]);
      widget.update();
      widget.onTurnStart();
      expect(typeof lastContent()).toBe("function");
      widget.onTurnStart();
      expect(typeof lastContent()).toBe("function");
      widget.onTurnStart();
      expect(lastContent()).toBeUndefined();
    },
  );

  it("does not advance the linger age on repeated update() without a turn", () => {
    const { widget, lastContent } = makeWidget([
      { id: "a1", status: "completed", completedAt: 5000 },
    ]);
    widget.update();
    widget.update();
    widget.update();
    // update() seeds at most once and never ages — the agent is still visible.
    expect(typeof lastContent()).toBe("function");
    widget.onTurnStart();
    expect(typeof lastContent()).toBe("function");
    widget.onTurnStart();
    expect(lastContent()).toBeUndefined();
  });

  it("gives a resumed agent's new completion its own linger window", () => {
    const agent = { id: "a1", status: "completed", completedAt: 5000 };
    const { widget, lastContent } = makeWidget([agent]);
    widget.update();
    widget.onTurnStart();
    widget.onTurnStart();
    expect(lastContent()).toBeUndefined();

    agent.completedAt = 6000;
    widget.update();

    expect(typeof lastContent()).toBe("function");
  });
});

describe("AgentWidget — self-drives from lifecycle notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const COMPACTION: CompactionInfo = { reason: "threshold", tokensBefore: 1000 };

  it("starts the update timer and renders on onSubagentStarted", () => {
    const { widget, lastContent } = makeWidget([{ id: "a1", status: "running" }]);
    expect(vi.getTimerCount()).toBe(0);

    widget.onSubagentStarted(createTestSubagent({ id: "a1", status: "running" }));

    expect(vi.getTimerCount()).toBe(1);
    expect(typeof lastContent()).toBe("function");
  });

  it("starts the update timer and renders on onSubagentCreated", () => {
    const { widget, lastContent } = makeWidget([{ id: "a1", status: "queued" }]);
    expect(vi.getTimerCount()).toBe(0);

    widget.onSubagentCreated(createTestSubagent({ id: "a1", status: "queued" }));

    expect(vi.getTimerCount()).toBe(1);
    expect(typeof lastContent()).toBe("function");
  });

  it.each([
    ["regular", 0],
    ["fullscreen", 3],
  ] as const)("requests recurring renders only in %s mode", (mode, expectedRenderCount) => {
    const { widget, lastContent } = makeWidget([{ id: "a1", status: "running" }]);
    widget.onSubagentStarted(createTestSubagent({ id: "a1", status: "running" }));
    const factory = lastContent();
    if (typeof factory !== "function") throw new Error("widget factory missing");
    const requestRender = vi.fn();
    factory(
      { terminal: { columns: 80 }, mode, requestRender },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    );

    vi.advanceTimersByTime(240);

    expect(requestRender).toHaveBeenCalledTimes(expectedRenderCount);
    widget.dispose();
  });

  it("renders the finished agent on onSubagentCompleted", () => {
    const { widget, lastContent } = makeWidget([
      { id: "a1", status: "completed", completedAt: 5000 },
    ]);

    widget.onSubagentCompleted(createTestSubagent({ id: "a1", status: "completed" }));

    expect(typeof lastContent()).toBe("function");
  });

  it("renders on onSubagentCompacted", () => {
    const { widget, lastContent } = makeWidget([{ id: "a1", status: "running" }]);

    widget.onSubagentCompacted(createTestSubagent({ id: "a1", status: "running" }), COMPACTION);

    expect(typeof lastContent()).toBe("function");
  });

  it("disposes the update timer and registered widget", () => {
    const { widget, lastContent } = makeWidget([{ id: "a1", status: "running" }]);
    widget.onSubagentStarted(createTestSubagent({ id: "a1", status: "running" }));
    expect(vi.getTimerCount()).toBe(1);

    widget.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(lastContent()).toBeUndefined();
  });
});

describe("AgentWidget — theme changes", () => {
  it("re-registers its factory after invalidation and renders with the new theme", () => {
    const record = createTestSubagent({
      status: "running",
      completedAt: undefined,
      invocation: { runInBackground: true },
    });
    const widget = new AgentWidget(
      { listAgents: () => [record] } as unknown as SubagentManager,
      new AgentTypeRegistry(() => new Map()),
      new FooterStatus(),
    );
    const factories: Array<Exclude<Parameters<UICtx["setWidget"]>[1], undefined>> = [];
    const ui: UICtx = {
      setStatus: () => {},
      setWidget: (_key, content) => {
        if (content) factories.push(content);
      },
    };
    const tui = {
      terminal: { columns: 80 },
      mode: "regular" as const,
      requestRender: vi.fn(),
    };
    widget.setUICtx(ui);
    widget.update();

    const firstFactory = factories[0];
    expect(typeof firstFactory).toBe("function");
    if (typeof firstFactory !== "function") throw new Error("widget factory missing");
    const first = firstFactory(tui, {
      fg: (_color, text) => `[old]${text}`,
      bold: (text) => text,
    });
    expect(first.render().join("\n")).toContain("[old]");

    first.invalidate();
    widget.update();

    const secondFactory = factories[1];
    expect(typeof secondFactory).toBe("function");
    if (typeof secondFactory !== "function") throw new Error("replacement widget factory missing");
    const second = secondFactory(tui, {
      fg: (_color, text) => `[new]${text}`,
      bold: (text) => text,
    });
    expect(second.render().join("\n")).toContain("[new]");
    expect(factories).toHaveLength(2);
    widget.dispose();
  });
});

describe("AgentWidget — background-only filtering", () => {
  function setup(records: Subagent[]) {
    const manager = { listAgents: () => records } as unknown as SubagentManager;
    const registry = new AgentTypeRegistry(() => new Map());
    const widget = new AgentWidget(manager, registry, new FooterStatus());
    const setWidgetCalls: unknown[] = [];
    let renderFn: ((tui: unknown, theme: unknown) => { render(): string[] }) | undefined;
    const ui: UICtx = {
      setStatus: () => {},
      setWidget: (_key, content) => {
        setWidgetCalls.push(content);
        if (typeof content === "function") renderFn = content as typeof renderFn;
      },
    };
    widget.setUICtx(ui);
    const lastContent = () => setWidgetCalls.at(-1);
    const renderLines = () => {
      const stubTui = {
        terminal: { columns: 200 },
        mode: "regular" as const,
        requestRender: () => {},
      };
      const stubTheme = { fg: (_: string, t: string) => t, bold: (t: string) => t };
      if (typeof renderFn !== "function") throw new Error("widget factory missing");
      return renderFn(stubTui, stubTheme).render();
    };
    return { widget, lastContent, renderLines };
  }

  it("does not register the widget when only foreground agents exist", () => {
    const { widget, lastContent } = setup([
      createTestSubagent({
        id: "fg1",
        status: "running",
        completedAt: undefined,
        invocation: { runInBackground: false },
      }),
    ]);
    widget.update();
    expect(lastContent()).toBeUndefined();
  });

  it("renders only background agents when foreground and background agents are mixed", () => {
    const { widget, renderLines } = setup([
      createTestSubagent({
        id: "bg1",
        status: "running",
        completedAt: undefined,
        description: "background task",
        invocation: { runInBackground: true },
      }),
      createTestSubagent({
        id: "fg1",
        status: "running",
        completedAt: undefined,
        description: "foreground task",
        invocation: { runInBackground: false },
      }),
    ]);
    widget.update();
    const text = renderLines().join("\n");
    expect(text).toContain("background task");
    expect(text).not.toContain("foreground task");
  });
});
