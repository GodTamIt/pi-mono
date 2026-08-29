import { describe, expect, it, vi } from "vitest";
import type { CreateSubagentSessionParams } from "../../src/lifecycle/create-subagent-session.ts";
import {
  Subagent,
  type SubagentExecution,
  type SubagentLifecycleObserver,
} from "../../src/lifecycle/subagent.ts";
import type { SubagentSession, TurnLoopResult } from "../../src/lifecycle/subagent-session.ts";
import { SubagentState, type SubagentStateInit } from "../../src/lifecycle/subagent-state.ts";
import type { Workspace, WorkspaceProvider } from "../../src/lifecycle/workspace.ts";
import type { ModelRegistry } from "../../src/session/model-resolver.ts";
import type { AgentInvocation, CompactionInfo, SubagentType } from "../../src/types.ts";
import { makeModel } from "../helpers/make-model.ts";
import { makeStubExecution, makeStubRuntime } from "../helpers/make-subagent.ts";
import {
  createMockSession,
  createSubagentSessionStub,
  emitResumeUsageAndCompaction,
  toSubagentSession,
} from "../helpers/mock-session.ts";
import { STUB_SNAPSHOT } from "../helpers/stub-ctx.ts";

type SessionFactory = (params: CreateSubagentSessionParams) => Promise<SubagentSession>;

/** Build a factory plus the SubagentSession stub it resolves to. */
function createFactory(): {
  factory: SessionFactory;
  stub: ReturnType<typeof createSubagentSessionStub>;
} {
  const stub = createSubagentSessionStub();
  const factory = vi.fn(async (_params: CreateSubagentSessionParams) => toSubagentSession(stub));
  return { factory, stub };
}

/** A factory resolving to a default (done) SubagentSession stub. */
function defaultFactory(): SessionFactory {
  return createFactory().factory;
}

interface MakeSubagentOptions extends SubagentStateInit {
  id?: string;
  type?: SubagentType;
  description?: string;
  invocation?: AgentInvocation;
  execution?: SubagentExecution;
  runtime?: ReturnType<typeof makeStubRuntime>;
}

/** Construct a Subagent with default identity and a stub execution, overridable per test. */
function makeSubagent(overrides: MakeSubagentOptions = {}): Subagent {
  const { id, type, description, invocation, execution, runtime, ...stateOverrides } = overrides;
  const record = new Subagent({
    id: id ?? "1",
    type: type ?? "general-purpose",
    description: description ?? "test",
    invocation,
    execution: execution ?? makeStubExecution(),
    state: Object.keys(stateOverrides).length > 0 ? new SubagentState(stateOverrides) : undefined,
  });
  record.admit(runtime ?? makeStubRuntime());
  return record;
}

/** A Subagent wired to a ready session whose messages hold a single user "hi". */
function makeReadySubagent(): { agent: Subagent } {
  const agent = makeSubagent();
  const session = createMockSession();
  session.messages.push({ role: "user", content: "hi" });
  const stub = createSubagentSessionStub(session);
  agent.subagentSession = toSubagentSession(stub);
  return { agent };
}

describe("Subagent — constructor", () => {
  it("sets required fields from init", () => {
    const record = makeSubagent({
      id: "abc-123",
      type: "Explore",
      description: "Find stale TODOs",
    });
    expect(record.id).toBe("abc-123");
    expect(record.type).toBe("Explore");
    expect(record.description).toBe("Find stale TODOs");
  });

  it("passes through optional identity fields", () => {
    const record = makeSubagent({ invocation: { modelName: "haiku" } });
    expect(record.abortController).toBeInstanceOf(AbortController);
    expect(record.invocation).toEqual({ modelName: "haiku" });
    // Stats always start at zero — set via mutation methods after construction
    expect(record.toolUses).toBe(0);
    expect(record.compactionCount).toBe(0);
    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("defaults to a fresh queued state when none is supplied", () => {
    const record = makeSubagent();
    expect(record.status).toBe("queued");
    expect(record.result).toBeUndefined();
    expect(record.error).toBeUndefined();
    expect(record.completedAt).toBeUndefined();
    expect(record.promise).toBeUndefined();
    expect(record.subagentSession).toBeUndefined();
  });

  it("always creates its own AbortController", () => {
    const record = makeSubagent();
    expect(record.abortController).toBeInstanceOf(AbortController);
    expect(record.abortController.signal.aborted).toBe(false);
  });

  it("toolCallId reflects execution.parentSession.toolCallId", () => {
    const record = makeSubagent({
      execution: makeStubExecution({ parentSession: { toolCallId: "tc-42" } }),
    });
    expect(record.toolCallId).toBe("tc-42");
  });

  it("toolCallId is undefined when parentSession.toolCallId is absent", () => {
    const record = makeSubagent({
      execution: makeStubExecution({ parentSession: { parentSessionFile: "/sessions/p.jsonl" } }),
    });
    expect(record.toolCallId).toBeUndefined();
  });

  it("toolCallId is undefined when parentSession is absent", () => {
    const record = makeSubagent();
    expect(record.toolCallId).toBeUndefined();
  });
});

describe("convenience getters", () => {
  describe("live-activity getters", () => {
    it("turnCount defaults to 1 (delegates to SubagentState)", () => {
      const record = makeSubagent();
      expect(record.turnCount).toBe(1);
    });

    it("activeTools defaults to an empty map (delegates to SubagentState)", () => {
      const record = makeSubagent();
      expect(record.activeTools.size).toBe(0);
    });

    it("responseText defaults to empty string (delegates to SubagentState)", () => {
      const record = makeSubagent();
      expect(record.responseText).toBe("");
    });

    it("maxTurns returns execution.maxTurns", () => {
      const record = makeSubagent({ execution: makeStubExecution({ maxTurns: 10 }) });
      expect(record.maxTurns).toBe(10);
    });

    it("maxTurns returns undefined when execution.maxTurns is not set", () => {
      const record = makeSubagent();
      expect(record.maxTurns).toBeUndefined();
    });

    it("turnCount reflects state mutations via incrementTurnCount", () => {
      const state = new SubagentState();
      const record = new Subagent({
        id: "1",
        type: "general-purpose",
        description: "test",
        execution: makeStubExecution(),
        state,
      });
      state.incrementTurnCount();
      expect(record.turnCount).toBe(2);
    });

    it("activeTools reflects state mutations via addActiveTool", () => {
      const state = new SubagentState();
      const record = new Subagent({
        id: "1",
        type: "general-purpose",
        description: "test",
        execution: makeStubExecution(),
        state,
      });
      state.addActiveTool("Read");
      expect(record.activeTools.size).toBe(1);
      expect([...record.activeTools.values()]).toContain("Read");
    });

    it("responseText reflects state mutations via appendResponseText", () => {
      const state = new SubagentState();
      const record = new Subagent({
        id: "1",
        type: "general-purpose",
        description: "test",
        execution: makeStubExecution(),
        state,
      });
      state.appendResponseText("Hello");
      expect(record.responseText).toBe("Hello");
    });
  });

  describe("consumption getters", () => {
    it("consumed defaults to false and consumedAt undefined (delegates to SubagentState)", () => {
      const record = makeSubagent();
      expect(record.consumed).toBe(false);
      expect(record.consumedAt).toBeUndefined();
    });

    it("markConsumed delegates to SubagentState", () => {
      const state = new SubagentState({ status: "completed" });
      const record = new Subagent({
        id: "1",
        type: "general-purpose",
        description: "test",
        execution: makeStubExecution(),
        state,
      });
      record.markConsumed(5000);
      expect(record.consumed).toBe(true);
      expect(record.consumedAt).toBe(5000);
      expect(state.consumedAt).toBe(5000);
    });
  });

  describe("outputFile", () => {
    it("returns undefined when subagentSession is not set", () => {
      const record = makeSubagent();
      expect(record.outputFile).toBeUndefined();
    });

    it("returns outputFile from subagentSession when set", () => {
      const record = makeSubagent();
      record.subagentSession = toSubagentSession(
        createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl"),
      );
      expect(record.outputFile).toBe("/path/to/session.jsonl");
    });

    it("returns undefined when subagentSession is set but outputFile is undefined", () => {
      const record = makeSubagent();
      record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
      expect(record.outputFile).toBeUndefined();
    });
  });
});

describe("Subagent — session-encapsulation methods", () => {
  describe("isSessionReady", () => {
    it("returns false when no subagentSession", () => {
      const agent = makeSubagent();
      expect(agent.isSessionReady()).toBe(false);
    });

    it("returns true when subagentSession is set", () => {
      const agent = makeSubagent();
      agent.subagentSession = toSubagentSession(createSubagentSessionStub());
      expect(agent.isSessionReady()).toBe(true);
    });
  });

  describe("steer", () => {
    it("rejects with the observed status when the agent is not running", async () => {
      const agent = makeSubagent();
      agent.markCompleted("done");
      const stub = createSubagentSessionStub();
      agent.subagentSession = toSubagentSession(stub);
      const outcome = await agent.steer("hello");
      expect(outcome).toEqual({ kind: "rejected", status: "completed" });
      expect(stub.steer).not.toHaveBeenCalled();
      expect(agent.pendingSteerCount).toBe(0);
    });

    it("buffers the message and returns a buffered outcome when the session is not ready", async () => {
      const agent = makeSubagent();
      agent.markRunning(Date.now());
      const outcome = await agent.steer("hello");
      expect(outcome).toEqual({ kind: "buffered" });
      expect(agent.pendingSteerCount).toBe(1);
    });

    it("delivers to the session and returns a delivered outcome when the session is ready", async () => {
      const agent = makeSubagent();
      agent.markRunning(Date.now());
      const stub = createSubagentSessionStub();
      agent.subagentSession = toSubagentSession(stub);
      const outcome = await agent.steer("go faster");
      expect(outcome).toEqual({ kind: "delivered" });
      expect(stub.steer).toHaveBeenCalledWith("go faster");
      expect(agent.pendingSteerCount).toBe(0);
    });
  });

  describe("getConversation", () => {
    it("returns undefined when no session", () => {
      const agent = makeSubagent();
      expect(agent.getConversation()).toBeUndefined();
    });

    it("delegates to SubagentSession.getConversation when session is ready", () => {
      const agent = makeSubagent();
      const stub = createSubagentSessionStub();
      stub.getConversation.mockReturnValue("[User]: hi");
      agent.subagentSession = toSubagentSession(stub);
      expect(agent.getConversation()).toBe("[User]: hi");
    });
  });

  describe("getContextPercent", () => {
    it("returns null when no session", () => {
      const agent = makeSubagent();
      expect(agent.getContextPercent()).toBeNull();
    });

    it("delegates to SubagentSession.getContextPercent when session is ready", () => {
      const agent = makeSubagent();
      const stub = createSubagentSessionStub();
      stub.getContextPercent.mockReturnValue(55);
      agent.subagentSession = toSubagentSession(stub);
      expect(agent.getContextPercent()).toBe(55);
    });
  });

  describe("subscribeToUpdates", () => {
    it("returns undefined when no session", () => {
      const agent = makeSubagent();
      expect(agent.subscribeToUpdates(vi.fn())).toBeUndefined();
    });

    it("delegates to SubagentSession.subscribe when session is ready", () => {
      const agent = makeSubagent();
      const stub = createSubagentSessionStub();
      agent.subagentSession = toSubagentSession(stub);
      const fn = vi.fn();
      const unsub = agent.subscribeToUpdates(fn);
      expect(stub.subscribe).toHaveBeenCalledWith(fn);
      expect(typeof unsub).toBe("function");
    });
  });

  describe("messages", () => {
    it("returns empty array when no session", () => {
      const agent = makeSubagent();
      expect(agent.messages).toEqual([]);
    });

    it("delegates to SubagentSession.messages when session is ready", () => {
      const { agent } = makeReadySubagent();
      expect(agent.messages).toEqual([{ role: "user", content: "hi" }]);
    });
  });

  describe("agentMessages", () => {
    it("returns empty array when no session", () => {
      const agent = makeSubagent();
      expect(agent.agentMessages).toEqual([]);
    });

    it("delegates to SubagentSession.agentMessages when session is ready", () => {
      const { agent } = makeReadySubagent();
      expect(agent.agentMessages).toEqual([{ role: "user", content: "hi" }]);
    });
  });

  describe("getToolDefinition", () => {
    it("returns undefined when no session", () => {
      const agent = makeSubagent();
      expect(agent.getToolDefinition("read")).toBeUndefined();
    });

    it("delegates to SubagentSession.getToolDefinition when session is ready", () => {
      const agent = makeSubagent();
      const def = { name: "read" };
      const session = createMockSession({ getToolDefinition: vi.fn(() => def) });
      const stub = createSubagentSessionStub(session);
      agent.subagentSession = toSubagentSession(stub);
      expect(agent.getToolDefinition("read")).toBe(def);
    });
  });
});

describe("Subagent — steer buffer", () => {
  it("starts with an empty steer buffer", () => {
    const record = makeSubagent();
    expect(record.pendingSteerCount).toBe(0);
  });
});

describe("Subagent — abort", () => {
  it("returns false and does nothing when not running", () => {
    const record = makeSubagent({ status: "queued" });
    expect(record.abort()).toBe(false);
    expect(record.status).toBe("queued");
  });

  it("fires the AbortController, marks stopped, and returns true when running", () => {
    const record = makeSubagent({ status: "running" });
    expect(record.abort()).toBe(true);
    expect(record.abortController.signal.aborted).toBe(true);
    expect(record.status).toBe("stopped");
  });

  it("drops buffered steering when an in-flight child is aborted", async () => {
    const record = makeSubagent({ status: "running" });
    await expect(record.steer("stop using the old branch")).resolves.toEqual({ kind: "buffered" });
    expect(record.pendingSteerCount).toBe(1);

    expect(record.abort()).toBe(true);
    expect(record.pendingSteerCount).toBe(0);
  });

  it("marks stopped and returns true even without an AbortController", () => {
    const record = makeSubagent({ status: "running" });
    expect(record.abort()).toBe(true);
    expect(record.status).toBe("stopped");
  });

  it("returns false when already stopped", () => {
    const record = makeSubagent({ status: "stopped" });
    expect(record.abort()).toBe(false);
  });

  it("returns false when completed", () => {
    const record = makeSubagent({ status: "completed" });
    expect(record.abort()).toBe(false);
  });
});

/** Create a Subagent for completeRun / failRun tests. */
function createCompletionAgent(overrides?: { observer?: SubagentLifecycleObserver }) {
  return {
    record: makeSubagent({
      status: "running",
      runtime: makeStubRuntime({ observer: overrides?.observer }),
    }),
  };
}

function createTurnLoopResult(overrides?: Partial<TurnLoopResult>): TurnLoopResult {
  return {
    responseText: "done",
    aborted: false,
    steered: false,
    ...overrides,
  };
}

describe("Subagent — completeRun", () => {
  it("transitions to completed for a normal result", () => {
    const { record } = createCompletionAgent();
    record.completeRun(createTurnLoopResult());
    expect(record.status).toBe("completed");
    expect(record.result).toBe("done");
  });

  it("transitions to aborted when result.aborted is true", () => {
    const { record } = createCompletionAgent();
    record.completeRun(createTurnLoopResult({ aborted: true }));
    expect(record.status).toBe("aborted");
  });

  it("transitions to steered when result.steered is true", () => {
    const { record } = createCompletionAgent();
    record.completeRun(createTurnLoopResult({ steered: true }));
    expect(record.status).toBe("steered");
  });

  it("fires observer.onRunFinished on completion", () => {
    const onRunFinished = vi.fn();
    const { record } = createCompletionAgent({ observer: { onRunFinished } });
    record.completeRun(createTurnLoopResult());
    expect(onRunFinished).toHaveBeenCalledOnce();
    expect(onRunFinished).toHaveBeenCalledWith(record);
  });
});

describe("Subagent — failRun", () => {
  it("transitions to error state", () => {
    const { record } = createCompletionAgent();
    record.failRun(new Error("boom"));
    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
  });

  it("fires observer.onRunFinished on failure", () => {
    const onRunFinished = vi.fn();
    const { record } = createCompletionAgent({ observer: { onRunFinished } });
    record.failRun(new Error("boom"));
    expect(onRunFinished).toHaveBeenCalledOnce();
    expect(onRunFinished).toHaveBeenCalledWith(record);
  });
});

describe("Subagent — stopQueued", () => {
  function createQueuedAgent(observer?: SubagentLifecycleObserver) {
    return makeSubagent({
      status: "queued",
      runtime: makeStubRuntime({ observer }),
    });
  }

  it("transitions to stopped and records that the agent never started", () => {
    const record = createQueuedAgent();
    record.stopQueued();
    expect(record.status).toBe("stopped");
    expect(record.stoppedWhileQueued).toBe(true);
  });

  it("fires observer.onRunFinished once, like every other terminal transition", () => {
    const onRunFinished = vi.fn();
    const record = createQueuedAgent({ onRunFinished });
    record.stopQueued();
    expect(onRunFinished).toHaveBeenCalledOnce();
    expect(onRunFinished).toHaveBeenCalledWith(record);
  });

  it("leaves stoppedWhileQueued false for a running agent aborted mid-run", () => {
    const record = makeSubagent({ status: "running" });
    expect(record.abort()).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.stoppedWhileQueued).toBe(false);
  });
});

describe("Subagent — disposeSession", () => {
  it("disposes the wrapped SubagentSession", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub();
    record.subagentSession = toSubagentSession(stub);
    await record.disposeSession();
    expect(stub.dispose).toHaveBeenCalledOnce();
  });

  it("resolves only after the child's teardown settles", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub();
    const teardown = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    stub.dispose = vi.fn((): Promise<void> => teardown.promise);
    record.subagentSession = toSubagentSession(stub);

    let settled = false;
    const pending = record.disposeSession().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    teardown.resolve();
    await pending;
    expect(settled).toBe(true);
  });

  it("swallows a failing teardown so the caller's cleanup continues", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub();
    stub.dispose = vi.fn((): Promise<void> => Promise.reject(new Error("teardown failed")));
    record.subagentSession = toSubagentSession(stub);
    await expect(record.disposeSession()).resolves.toBeUndefined();
  });

  it("is a no-op when no session was created", async () => {
    const record = makeSubagent();
    await expect(record.disposeSession()).resolves.toBeUndefined();
  });
});

describe("Subagent — releaseSession", () => {
  it("disposes the wrapped session and clears it (isSessionReady false)", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    record.subagentSession = toSubagentSession(stub);
    await record.releaseSession();
    expect(stub.dispose).toHaveBeenCalledOnce();
    expect(record.isSessionReady()).toBe(false);
  });

  it("captures outputFile so the getter still resolves it after release", async () => {
    const record = makeSubagent();
    record.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl"),
    );
    await record.releaseSession();
    expect(record.outputFile).toBe("/path/to/session.jsonl");
  });

  it("sets sessionReleased (default false)", async () => {
    const record = makeSubagent();
    expect(record.sessionReleased).toBe(false);
    record.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl"),
    );
    await record.releaseSession();
    expect(record.sessionReleased).toBe(true);
  });

  it("clears the session before awaiting teardown, so a racing sweep releases once", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    const teardown = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    stub.dispose = vi.fn((): Promise<void> => teardown.promise);
    record.subagentSession = toSubagentSession(stub);

    const first = record.releaseSession();
    expect(record.isSessionReady()).toBe(false);
    const second = record.releaseSession();

    teardown.resolve();
    await Promise.all([first, second]);
    expect(stub.dispose).toHaveBeenCalledOnce();
  });

  it("is a no-op on a second release — does not re-dispose, keeps the captured outputFile", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    record.subagentSession = toSubagentSession(stub);
    await record.releaseSession();
    await record.releaseSession();
    expect(stub.dispose).toHaveBeenCalledOnce();
    expect(record.outputFile).toBe("/path/to/session.jsonl");
  });

  it("disposeSession after release is a no-op (session already cleared)", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    record.subagentSession = toSubagentSession(stub);
    await record.releaseSession();
    await record.disposeSession();
    expect(stub.dispose).toHaveBeenCalledOnce();
  });

  it("swallows a failing teardown but still marks the session released", async () => {
    const record = makeSubagent();
    const stub = createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl");
    stub.dispose = vi.fn((): Promise<void> => Promise.reject(new Error("teardown failed")));
    record.subagentSession = toSubagentSession(stub);
    await expect(record.releaseSession()).resolves.toBeUndefined();
    expect(record.sessionReleased).toBe(true);
  });

  it("is a no-op when no session was created (sessionReleased stays false)", async () => {
    const record = makeSubagent();
    await expect(record.releaseSession()).resolves.toBeUndefined();
    expect(record.sessionReleased).toBe(false);
  });
});

// ── Agent.run() ──────────────────────────────────────────────────────────────

/** Create a complete Agent ready for run(). */
function createRunnableAgent(overrides?: {
  createSubagentSession?: SessionFactory;
  observer?: SubagentLifecycleObserver;
  getRunConfig?: () => { defaultMaxTurns: number | undefined; graceTurns: number };
  parentSession?: { toolCallId?: string; parentSessionFile?: string; parentSessionId?: string };
  signal?: AbortSignal;
  baseCwd?: string;
  workspaceProvider?: WorkspaceProvider;
  modelRegistry?: ModelRegistry;
}) {
  const createSubagentSession = overrides?.createSubagentSession ?? defaultFactory();
  const observer = overrides?.observer ?? {};
  const agent = new Subagent({
    id: "run-1",
    type: "general-purpose",
    description: "run test",
    execution: {
      baseline: STUB_SNAPSHOT,
      task: "do something",
      parentSession: overrides?.parentSession,
      baseCwd: overrides?.baseCwd ?? "/base",
      isBackground: false,
    },
  });
  agent.admit(
    makeStubRuntime({
      createSubagentSession,
      observer,
      runConfig: overrides?.getRunConfig?.(),
      signal: overrides?.signal,
      workspaceProvider: overrides?.workspaceProvider,
      modelRegistry: overrides?.modelRegistry ?? { find: () => undefined, getAll: () => [] },
    }),
  );
  return agent;
}

/** Build a Workspace with a recorded dispose. */
function makeWorkspace(cwd: string, disposeResult?: { resultAddendum?: string }): Workspace {
  return { cwd, dispose: vi.fn(() => disposeResult) };
}

/** Build a WorkspaceProvider whose prepare resolves to the given workspace. */
function makeWorkspaceProvider(workspace: Workspace | undefined): WorkspaceProvider {
  return { prepare: vi.fn(async () => workspace) };
}

describe("Subagent.run() — happy path", () => {
  it("transitions through running → completed", async () => {
    const agent = createRunnableAgent();
    await agent.run();
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("done");
  });

  it("fires observer callbacks in order: onStarted → onSessionCreated → onRunFinished", async () => {
    const callOrder: string[] = [];
    const observer: SubagentLifecycleObserver = {
      onStarted: () => callOrder.push("started"),
      onSessionCreated: () => callOrder.push("sessionCreated"),
      onRunFinished: () => callOrder.push("runFinished"),
    };
    const agent = createRunnableAgent({ observer });
    await agent.run();
    expect(callOrder).toEqual(["started", "sessionCreated", "runFinished"]);
  });

  it("sets the subagentSession with a session", async () => {
    const agent = createRunnableAgent();
    await agent.run();
    expect(agent.subagentSession).toBeDefined();
    expect(agent.subagentSession!.session).toBeDefined();
  });

  it("flushes pending steers when session is created", async () => {
    const agent = createRunnableAgent();
    // A steer arriving while the agent is running but the session is not yet
    // ready buffers; run() flushes it once the session is created.
    agent.markRunning(Date.now());
    void agent.steer("hurry up");
    expect(agent.pendingSteerCount).toBe(1);
    await agent.run();
    expect(agent.pendingSteerCount).toBe(0);
  });
});

describe("Subagent.run() — workspace provider", () => {
  it("prepares the workspace and threads its cwd into the factory params", async () => {
    const { factory } = createFactory();
    const provider = makeWorkspaceProvider(makeWorkspace("/ws/dir"));
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });
    await agent.run();
    const params = (factory as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(params.cwd).toBe("/ws/dir");
  });

  it("calls prepare with the run-start context", async () => {
    const provider = makeWorkspaceProvider(makeWorkspace("/ws/dir"));
    const agent = createRunnableAgent({ workspaceProvider: provider, baseCwd: "/parent" });
    await agent.run();
    expect(provider.prepare).toHaveBeenCalledWith({
      agentId: "run-1",
      agentType: "general-purpose",
      baseCwd: "/parent",
      invocation: undefined,
    });
  });

  it("appends the dispose resultAddendum to the result", async () => {
    const workspace = makeWorkspace("/ws/dir", { resultAddendum: "\n\n---\nsaved to branch foo" });
    const agent = createRunnableAgent({ workspaceProvider: makeWorkspaceProvider(workspace) });
    await agent.run();
    expect(agent.result).toBe("done\n\n---\nsaved to branch foo");
    expect(workspace.dispose).toHaveBeenCalledWith({
      status: "completed",
      description: "run test",
    });
  });

  it("falls back to baseCwd (cwd undefined) when prepare returns undefined", async () => {
    const { factory } = createFactory();
    const provider = makeWorkspaceProvider(undefined);
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });
    await agent.run();
    const params = (factory as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(params.cwd).toBeUndefined();
    expect(agent.status).toBe("completed");
  });

  it("marks error and fires onRunFinished when prepare rejects", async () => {
    const onRunFinished = vi.fn();
    const provider: WorkspaceProvider = {
      prepare: vi.fn(() => Promise.reject(new Error("prepare failed"))),
    };
    const agent = createRunnableAgent({ workspaceProvider: provider, observer: { onRunFinished } });
    await agent.run();
    expect(agent.status).toBe("error");
    expect(agent.error).toBe("prepare failed");
    expect(onRunFinished).toHaveBeenCalledOnce();
  });

  it("disposes with status error when the turn loop throws", async () => {
    const { factory, stub } = createFactory();
    stub.runTurnLoop.mockRejectedValue(new Error("turn loop exploded"));
    const workspace = makeWorkspace("/ws/dir", { resultAddendum: "\nshould be discarded" });
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: makeWorkspaceProvider(workspace),
    });
    await agent.run();
    expect(agent.status).toBe("error");
    expect(workspace.dispose).toHaveBeenCalledWith({ status: "error", description: "run test" });
    expect(agent.result).toBeUndefined();
  });
});

describe("Subagent.run() — error handling", () => {
  it("transitions to error when the turn loop throws", async () => {
    const { factory, stub } = createFactory();
    stub.runTurnLoop.mockRejectedValue(new Error("turn loop exploded"));
    const agent = createRunnableAgent({ createSubagentSession: factory });
    await agent.run();
    expect(agent.status).toBe("error");
    expect(agent.error).toBe("turn loop exploded");
  });

  it("transitions to error when the factory throws", async () => {
    const factory: SessionFactory = vi.fn().mockRejectedValue(new Error("creation failed"));
    const agent = createRunnableAgent({ createSubagentSession: factory });
    await agent.run();
    expect(agent.status).toBe("error");
    expect(agent.error).toBe("creation failed");
  });
});

describe("Subagent.run() — abort signal forwarding", () => {
  it("wires parent signal so aborting it stops the agent", async () => {
    const parentController = new AbortController();
    const { factory, stub } = createFactory();
    stub.runTurnLoop.mockImplementation(() => {
      parentController.abort();
      return Promise.reject(new Error("aborted"));
    });
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      signal: parentController.signal,
    });
    await agent.run();
    expect(agent.abortController.signal.aborted).toBe(true);
  });
});

describe("Subagent.run() — RunConfig threading", () => {
  it("passes defaultMaxTurns and graceTurns to runTurnLoop", async () => {
    const { factory, stub } = createFactory();
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      getRunConfig: () => ({ defaultMaxTurns: 10, graceTurns: 3 }),
    });
    await agent.run();
    const turnOpts = stub.runTurnLoop.mock.calls[0]![1];
    expect(turnOpts.defaultMaxTurns).toBe(10);
    expect(turnOpts.graceTurns).toBe(3);
  });
});

// ── Subagent.start() ───────────────────────────────────────────────────────────

describe("Subagent.start() — promise encapsulation", () => {
  it("stores a run promise that resolves on completion", async () => {
    const agent = createRunnableAgent();
    agent.start();
    expect(agent.promise).toBeInstanceOf(Promise);
    await agent.promise;
    expect(agent.status).toBe("completed");
  });

  it("promise is undefined before start() is called", () => {
    const agent = createRunnableAgent();
    expect(agent.promise).toBeUndefined();
  });

  it("is a no-op when status is stopped (abort-while-queued guard)", async () => {
    const agent = makeSubagent({ status: "stopped", startedAt: 1, completedAt: 1 });
    agent.start();
    await expect(agent.promise).resolves.toBeUndefined();
    expect(agent.status).toBe("stopped");
  });

  it("is a no-op when status is completed", async () => {
    const agent = makeSubagent({
      status: "completed",
      result: "done",
      startedAt: 1,
      completedAt: 2,
    });
    agent.start();
    await expect(agent.promise).resolves.toBeUndefined();
    expect(agent.status).toBe("completed");
  });
});

describe("Subagent.waitUntilSettled()", () => {
  it("resolves immediately without a manager-owned run handle", async () => {
    const agent = makeSubagent({ status: "queued" });
    await expect(agent.waitUntilSettled(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("ends a wait on interrupt without cancelling work", async () => {
    const agent = makeSubagent({ status: "queued" });
    const pending = new Promise<void>(() => {});
    agent.setQueuedPromise(pending);
    const controller = new AbortController();
    const wait = agent.waitUntilSettled(controller.signal);
    controller.abort();
    await wait;
    expect(agent.status).toBe("queued");
  });
});

// ── Agent.resume() ─────────────────────────────────────────────────────────────

/** Create an Agent with a SubagentSession already attached, ready for resume(). */
function createResumableAgent(overrides?: {
  observer?: SubagentLifecycleObserver;
  session?: ReturnType<typeof createMockSession>;
  stub?: ReturnType<typeof createSubagentSessionStub>;
}) {
  const session = overrides?.session ?? createMockSession();
  const stub = overrides?.stub ?? createSubagentSessionStub(session);
  const agent = new Subagent({
    id: "resume-1",
    type: "general-purpose",
    description: "resume test",
    execution: makeStubExecution(),
    state: new SubagentState({ status: "completed", result: "first" }),
  });
  agent.admit(makeStubRuntime({ observer: overrides?.observer ?? {} }));
  agent.subagentSession = toSubagentSession(stub);
  return { agent, session, stub };
}

describe("Subagent.resume() — happy path", () => {
  it("transitions to completed and sets result from the resume response", async () => {
    const { agent } = createResumableAgent();
    await agent.resume("continue");
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("resumed");
  });

  it("passes the prompt and signal straight through to resumeTurnLoop", async () => {
    const { agent, stub } = createResumableAgent();
    const signal = new AbortController().signal;
    await agent.resume("continue", signal);
    expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
    expect(stub.resumeTurnLoop.mock.calls[0]![0]).toBe("continue");
    expect(stub.resumeTurnLoop.mock.calls[0]![1]).toMatchObject({ signal });
  });

  it("resets transition state before resuming", async () => {
    const { agent } = createResumableAgent();
    await agent.resume("continue");
    expect(agent.error).toBeUndefined();
  });

  it("reserves the record and forwards its abort while a resume is in flight", async () => {
    const { agent, stub } = createResumableAgent();
    const gate = Promise.withResolvers<string>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- valid test gate
    let resumeSignal: AbortSignal | undefined;
    stub.resumeTurnLoop.mockImplementation(async (_task, opts) => {
      resumeSignal = opts.signal;
      return gate.promise;
    });

    const resuming = agent.resume("continue");
    expect(agent.status).toBe("running");
    await expect(agent.resume("second resume")).rejects.toThrow(/already running/);

    expect(agent.abort()).toBe(true);
    expect(resumeSignal?.aborted).toBe(true);
    gate.resolve("stopped result");
    await resuming;
    expect(agent.status).toBe("stopped");
  });

  it.each(["live", "released"] as const)(
    "reconstructs a %s provider-backed session in a fresh workspace",
    async (sessionState) => {
      const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
      const restored = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
      const stubs = [initial, restored];
      const factory: SessionFactory = vi.fn(async () => {
        const stub = stubs.shift();
        if (!stub) throw new Error("Unexpected child session reconstruction");
        return toSubagentSession(stub);
      });
      const oldWorkspace = makeWorkspace("/worktrees/old");
      const resumedWorkspace = makeWorkspace("/worktrees/resumed", {
        resultAddendum: "\nworkspace saved",
      });
      const workspaces = [oldWorkspace, resumedWorkspace];
      const provider: WorkspaceProvider = {
        prepare: vi.fn(async () => workspaces.shift()),
      };
      const onSessionCreated = vi.fn();
      const agent = createRunnableAgent({
        createSubagentSession: factory,
        workspaceProvider: provider,
        observer: { onSessionCreated },
      });

      await agent.run();
      if (sessionState === "released") await agent.releaseSession();
      await agent.resume("continue");

      expect(provider.prepare).toHaveBeenCalledTimes(2);
      expect(provider.prepare).toHaveBeenLastCalledWith({
        agentId: "run-1",
        agentType: "general-purpose",
        baseCwd: "/base",
        invocation: undefined,
      });
      expect(factory).toHaveBeenCalledTimes(2);
      expect(onSessionCreated).toHaveBeenCalledTimes(2);
      expect(vi.mocked(factory).mock.calls[1]![0]).toMatchObject({
        cwd: "/worktrees/resumed",
        resumeTranscriptPath: "/sessions/child.jsonl",
      });
      expect(initial.dispose).toHaveBeenCalledOnce();
      expect(oldWorkspace.dispose).toHaveBeenCalledOnce();
      expect(resumedWorkspace.dispose).toHaveBeenCalledExactlyOnceWith({
        status: "completed",
        description: "run test",
      });
      expect(agent.result).toBe("resumed\nworkspace saved");
    },
  );

  it("prepares a new provider workspace for every resume", async () => {
    const stubs = [
      createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl"),
      createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl"),
      createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl"),
    ];
    const factory: SessionFactory = vi.fn(async () => toSubagentSession(stubs.shift()!));
    const preparedWorkspaces = [
      makeWorkspace("/ws/one"),
      makeWorkspace("/ws/two"),
      makeWorkspace("/ws/three"),
    ];
    const pendingWorkspaces = [...preparedWorkspaces];
    const provider: WorkspaceProvider = { prepare: vi.fn(async () => pendingWorkspaces.shift()) };
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });

    await agent.run();
    await agent.resume("second");
    await agent.resume("third");

    expect(provider.prepare).toHaveBeenCalledTimes(3);
    expect(vi.mocked(factory).mock.calls.map(([params]) => params.cwd)).toEqual([
      "/ws/one",
      "/ws/two",
      "/ws/three",
    ]);
    for (const workspace of preparedWorkspaces) expect(workspace.dispose).toHaveBeenCalledOnce();
  });

  it("reconstructs a released no-provider session from the baseline cwd", async () => {
    const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const restored = createSubagentSessionStub();
    const factory: SessionFactory = vi
      .fn()
      .mockResolvedValueOnce(toSubagentSession(initial))
      .mockResolvedValueOnce(toSubagentSession(restored));
    const agent = createRunnableAgent({ createSubagentSession: factory });

    await agent.run();
    await agent.releaseSession();
    await agent.resume("continue");

    expect(vi.mocked(factory).mock.calls[1]![0]).toMatchObject({
      cwd: STUB_SNAPSHOT.cwd,
      resumeTranscriptPath: "/sessions/child.jsonl",
    });
  });

  it("reconstructs with a newly resolved stack model and thinking snapshot", async () => {
    const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const restored = createSubagentSessionStub();
    const factory: SessionFactory = vi
      .fn()
      .mockResolvedValueOnce(toSubagentSession(initial))
      .mockResolvedValueOnce(toSubagentSession(restored));
    const model = makeModel({ provider: "anthropic", id: "deep", reasoning: true });
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      modelRegistry: {
        find: (provider, id) =>
          provider === model.provider && id === model.id ? model : undefined,
        getAll: () => [model],
      },
    });

    await agent.run();
    await agent.resume("continue", undefined, undefined, {
      model,
      snapshot: { stack: "deep", modelName: "anthropic/deep", thinking: "high" },
    });

    expect(agent.invocation).toEqual({
      stack: "deep",
      modelName: "anthropic/deep",
      thinking: "high",
    });
    expect(vi.mocked(factory).mock.calls[1]![0]).toMatchObject({
      model,
      thinkingLevel: "high",
      invocation: { stack: "deep", modelName: "anthropic/deep", thinking: "high" },
      resumeTranscriptPath: "/sessions/child.jsonl",
    });
  });
});

describe("Subagent.resume() — observer lifecycle", () => {
  it("accumulates usage and compactions from session events during resume", async () => {
    const session = createMockSession();
    const stub = createSubagentSessionStub(session);
    stub.resumeTurnLoop.mockImplementation(async () => {
      emitResumeUsageAndCompaction(session);
      return "second";
    });
    const { agent } = createResumableAgent({ session, stub });
    await agent.resume("more");
    expect(agent.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(agent.compactionCount).toBe(1);
  });

  it("forwards compaction events through observer.onCompacted", async () => {
    const session = createMockSession();
    const seen: Array<{ reason: string; tokensBefore: number }> = [];
    const observer: SubagentLifecycleObserver = {
      onCompacted: (_agent: Subagent, info: CompactionInfo) =>
        seen.push({ reason: info.reason, tokensBefore: info.tokensBefore }),
    };
    const stub = createSubagentSessionStub(session);
    stub.resumeTurnLoop.mockImplementation(async () => {
      session.emit({
        type: "compaction_end",
        aborted: false,
        result: { tokensBefore: 123 },
        reason: "threshold",
      });
      return "second";
    });
    const { agent } = createResumableAgent({ observer, session, stub });
    await agent.resume("more");
    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 123 }]);
  });

  it("releases the observer subscription after resume completes", async () => {
    const session = createMockSession();
    const { agent } = createResumableAgent({ session });
    await agent.resume("more");
    // Events emitted after resume must not accumulate — subscription released.
    session.emit({ type: "tool_execution_end" });
    expect(agent.toolUses).toBe(0);
  });

  it("fires observer.onResumeFinished once the resume completes", async () => {
    const onResumeFinished = vi.fn();
    const { agent } = createResumableAgent({ observer: { onResumeFinished } });
    await agent.resume("continue");
    expect(onResumeFinished).toHaveBeenCalledExactlyOnceWith(agent);
    expect(agent.status).toBe("completed");
  });

  it("fires observer.onResumeFinished when the resume errors", async () => {
    const onResumeFinished = vi.fn();
    const stub = createSubagentSessionStub();
    stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
    const { agent } = createResumableAgent({ observer: { onResumeFinished }, stub });
    await agent.resume("continue");
    expect(onResumeFinished).toHaveBeenCalledExactlyOnceWith(agent);
    expect(agent.status).toBe("error");
  });
});

describe("Subagent.resume() — error handling", () => {
  it("reuses a live no-provider session without constructing another one", async () => {
    const stub = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const factory: SessionFactory = vi.fn();
    const agent = new Subagent({
      id: "resume-live",
      type: "general-purpose",
      description: "resume live",
      execution: makeStubExecution(),
      state: new SubagentState({ status: "completed", result: "first" }),
    });
    agent.admit(makeStubRuntime({ createSubagentSession: factory }));
    agent.subagentSession = toSubagentSession(stub);

    await agent.resume("more");

    expect(factory).not.toHaveBeenCalled();
    expect(stub.dispose).not.toHaveBeenCalled();
    expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
  });

  it("transitions to error without throwing when resumeTurnLoop rejects", async () => {
    const stub = createSubagentSessionStub();
    stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
    const { agent } = createResumableAgent({ stub });
    await agent.resume("more");
    expect(agent.status).toBe("error");
    expect(agent.error).toBe("resume exploded");
  });

  it("releases the observer subscription after resume errors", async () => {
    const session = createMockSession();
    const stub = createSubagentSessionStub(session);
    stub.resumeTurnLoop.mockRejectedValue(new Error("boom"));
    const { agent } = createResumableAgent({ session, stub });
    await agent.resume("more");
    session.emit({ type: "tool_execution_end" });
    expect(agent.toolUses).toBe(0);
  });

  it("disposes an errored resume workspace once and appends its addendum", async () => {
    const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const resumed = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    resumed.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
    const factory: SessionFactory = vi
      .fn()
      .mockResolvedValueOnce(toSubagentSession(initial))
      .mockResolvedValueOnce(toSubagentSession(resumed));
    const oldWorkspace = makeWorkspace("/ws/old");
    const errorWorkspace = makeWorkspace("/ws/error", { resultAddendum: "\nworkspace retained" });
    const pending = [oldWorkspace, errorWorkspace];
    const provider: WorkspaceProvider = { prepare: vi.fn(async () => pending.shift()) };
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });

    await agent.run();
    await agent.resume("more");

    expect(agent.status).toBe("error");
    expect(agent.error).toBe("resume exploded\nworkspace retained");
    expect(errorWorkspace.dispose).toHaveBeenCalledExactlyOnceWith({
      status: "error",
      description: "run test",
    });
  });

  it("keeps the transcript recoverable when fresh workspace preparation fails", async () => {
    const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const restored = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const factory: SessionFactory = vi
      .fn()
      .mockResolvedValueOnce(toSubagentSession(initial))
      .mockResolvedValueOnce(toSubagentSession(restored));
    const initialWorkspace = makeWorkspace("/ws/initial");
    const retryWorkspace = makeWorkspace("/ws/retry");
    const provider: WorkspaceProvider = {
      prepare: vi
        .fn()
        .mockResolvedValueOnce(initialWorkspace)
        .mockRejectedValueOnce(new Error("prepare failed"))
        .mockResolvedValueOnce(retryWorkspace),
    };
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });

    await agent.run();
    await agent.resume("fails before create");
    expect(agent.status).toBe("error");
    expect(agent.outputFile).toBe("/sessions/child.jsonl");
    expect(factory).toHaveBeenCalledOnce();
    expect(initial.dispose).toHaveBeenCalledOnce();

    await agent.resume("retry");
    expect(agent.status).toBe("completed");
    expect(vi.mocked(factory).mock.calls[1]![0]).toMatchObject({
      cwd: "/ws/retry",
      resumeTranscriptPath: "/sessions/child.jsonl",
    });
    expect(retryWorkspace.dispose).toHaveBeenCalledOnce();
  });

  it("disposes after creation failure once and leaves the transcript recoverable", async () => {
    const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const factory: SessionFactory = vi
      .fn()
      .mockResolvedValueOnce(toSubagentSession(initial))
      .mockRejectedValueOnce(new Error("creation failed"));
    const initialWorkspace = makeWorkspace("/ws/initial");
    const failedWorkspace = makeWorkspace("/ws/failed", { resultAddendum: "\nworkspace retained" });
    const pending = [initialWorkspace, failedWorkspace];
    const provider: WorkspaceProvider = { prepare: vi.fn(async () => pending.shift()) };
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });

    await agent.run();
    await agent.resume("fails during create");

    expect(agent.status).toBe("error");
    expect(agent.error).toBe("creation failed\nworkspace retained");
    expect(agent.outputFile).toBe("/sessions/child.jsonl");
    expect(agent.sessionReleased).toBe(true);
    expect(failedWorkspace.dispose).toHaveBeenCalledExactlyOnceWith({
      status: "error",
      description: "run test",
    });
  });

  it("disposes an aborted resume workspace once and includes its addendum", async () => {
    const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const resumed = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const gate = Promise.withResolvers<string>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- valid test gate
    resumed.resumeTurnLoop.mockReturnValue(gate.promise);
    const factory: SessionFactory = vi
      .fn()
      .mockResolvedValueOnce(toSubagentSession(initial))
      .mockResolvedValueOnce(toSubagentSession(resumed));
    const initialWorkspace = makeWorkspace("/ws/initial");
    const abortedWorkspace = makeWorkspace("/ws/aborted", {
      resultAddendum: "\nworkspace retained",
    });
    const pending = [initialWorkspace, abortedWorkspace];
    const provider: WorkspaceProvider = { prepare: vi.fn(async () => pending.shift()) };
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });

    await agent.run();
    const resuming = agent.resume("abort me");
    await vi.waitFor(() => expect(resumed.resumeTurnLoop).toHaveBeenCalledOnce());
    expect(agent.abort()).toBe(true);
    gate.resolve("partial result");
    await resuming;

    expect(agent.status).toBe("stopped");
    expect(agent.result).toBe("partial result\nworkspace retained");
    expect(abortedWorkspace.dispose).toHaveBeenCalledExactlyOnceWith({
      status: "stopped",
      description: "run test",
    });
  });

  it("disposes a prepared resume workspace without creating a session when aborted", async () => {
    const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const factory: SessionFactory = vi.fn().mockResolvedValue(toSubagentSession(initial));
    const initialWorkspace = makeWorkspace("/ws/initial");
    const preparation = Promise.withResolvers<Workspace | undefined>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- valid test gate
    const abortedWorkspace = makeWorkspace("/ws/aborted", {
      resultAddendum: "\nworkspace retained",
    });
    const provider: WorkspaceProvider = {
      prepare: vi
        .fn()
        .mockResolvedValueOnce(initialWorkspace)
        .mockReturnValueOnce(preparation.promise),
    };
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });

    await agent.run();
    const resuming = agent.resume("abort during prepare");
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(2));
    expect(agent.abort()).toBe(true);
    preparation.resolve(abortedWorkspace);
    await resuming;

    expect(factory).toHaveBeenCalledOnce();
    expect(agent.status).toBe("stopped");
    expect(agent.result).toBe("\nworkspace retained");
    expect(abortedWorkspace.dispose).toHaveBeenCalledExactlyOnceWith({
      status: "stopped",
      description: "run test",
    });
  });

  it("releases a reconstructed session when aborted during creation", async () => {
    const initial = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const resumed = createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl");
    const creation = Promise.withResolvers<SubagentSession>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- valid test gate
    const factory: SessionFactory = vi
      .fn()
      .mockResolvedValueOnce(toSubagentSession(initial))
      .mockReturnValueOnce(creation.promise);
    const initialWorkspace = makeWorkspace("/ws/initial");
    const abortedWorkspace = makeWorkspace("/ws/aborted");
    const pending = [initialWorkspace, abortedWorkspace];
    const provider: WorkspaceProvider = { prepare: vi.fn(async () => pending.shift()) };
    const agent = createRunnableAgent({
      createSubagentSession: factory,
      workspaceProvider: provider,
    });

    await agent.run();
    const resuming = agent.resume("abort during create");
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    expect(agent.abort()).toBe(true);
    creation.resolve(toSubagentSession(resumed));
    await resuming;

    expect(agent.status).toBe("stopped");
    expect(resumed.dispose).toHaveBeenCalledOnce();
    expect(abortedWorkspace.dispose).toHaveBeenCalledExactlyOnceWith({
      status: "stopped",
      description: "run test",
    });
  });

  it("throws when no session exists", async () => {
    const agent = makeSubagent();
    await expect(agent.resume("more")).rejects.toThrow(/missing session/);
  });
});

describe("Subagent.resume() — awaitable handle", () => {
  it("republishes the promise getter for the in-flight resume", async () => {
    const { agent, stub } = createResumableAgent();
    agent.start();
    const firstRun = agent.promise;
    await firstRun;
    const { promise: resuming, resolve: finishResume } = Promise.withResolvers<string>();
    stub.resumeTurnLoop.mockReturnValue(resuming);

    const returned = agent.resume("continue");

    // The getter must track the live resume, not the settled first-run handle.
    expect(agent.promise).not.toBe(firstRun);
    expect(agent.promise).toBe(returned);

    finishResume("resumed late");
    await returned;
    expect(agent.status).toBe("completed");
    expect(agent.result).toBe("resumed late");
  });
});
