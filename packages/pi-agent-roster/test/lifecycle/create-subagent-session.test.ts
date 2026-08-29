import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentSession } from "../../src/lifecycle/create-subagent-session.ts";
import { SubagentSession } from "../../src/lifecycle/subagent-session.ts";
import { STUB_SNAPSHOT } from "../helpers/stub-ctx.ts";
import {
  createAgentLookup,
  createChildLifecycleMock,
  createFactorySession,
  createSubagentSessionDeps,
  createSubagentSessionIO,
} from "../helpers/subagent-session-io.ts";

/** Mock AgentConfigLookup. */
const mockAgentLookup = createAgentLookup();

let io: ReturnType<typeof createSubagentSessionIO>;

const exec = vi.fn();
const MODEL_REGISTRY = { find: () => undefined, getAll: () => [] };

beforeEach(() => {
  io = createSubagentSessionIO();
});

/** Arrange: build a factory session and wire it as the created session. Returns it for assertions. */
function arrangeFactory() {
  const session = createFactorySession();
  io.createSession.mockResolvedValue({ session });
  return session;
}

/** The standard deps bag for the default `io`/`exec`/`registry` wiring. */
function defaultDeps() {
  return createSubagentSessionDeps({ io, exec, registry: mockAgentLookup });
}

describe("createSubagentSession — assembly", () => {
  let session: ReturnType<typeof createFactorySession>;

  beforeEach(() => {
    session = createFactorySession();
    io.createSession.mockResolvedValue({ session });
  });

  it("returns a born-complete SubagentSession wrapping the created session", async () => {
    const sub = await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(sub).toBeInstanceOf(SubagentSession);
    expect(sub.session).toBe(session);
  });

  it("exposes the persisted session file as outputFile", async () => {
    const sub = await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(sub.outputFile).toBe("/sessions/child.jsonl");
  });

  it("binds extensions before returning", async () => {
    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith({});
  });

  it("passes the effective cwd and agentDir to the loader, settings, and session", async () => {
    await createSubagentSession(
      {
        baseline: STUB_SNAPSHOT,
        modelRegistry: MODEL_REGISTRY,
        type: "Explore",
        cwd: "/tmp/worktree",
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.getAgentDir).toHaveBeenCalledTimes(1);
    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree", agentDir: "/mock/agent-dir" }),
    );
    expect(io.createSettingsManager).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(io.createSessionManager).toHaveBeenCalledWith(
      "/tmp/worktree",
      "/mock/session-dir/tasks",
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree", agentDir: "/mock/agent-dir" }),
    );
  });

  it("gives the resource loader the derived settings view, not the session's own", async () => {
    const sessionSettings = { marker: "session" };
    const loaderSettings = { marker: "loader" };
    io.createSettingsManager.mockReturnValue(sessionSettings);
    io.createLoaderSettingsManager.mockReturnValue(loaderSettings);

    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createLoaderSettingsManager).toHaveBeenCalledWith(sessionSettings);
    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ settingsManager: loaderSettings }),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ settingsManager: sessionSettings }),
    );
  });

  it("creates the session's settings manager exactly once and reuses it", async () => {
    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createSettingsManager).toHaveBeenCalledTimes(1);
    expect(io.createLoaderSettingsManager).toHaveBeenCalledTimes(1);
  });

  it("loads context files by default while suppressing ambient APPEND_SYSTEM.md", async () => {
    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: false,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    const loaderOpts = io.createResourceLoader.mock.calls[0]![0];
    expect(loaderOpts.appendSystemPromptOverride()).toEqual([]);
  });

  it.each(["append", "replace"] as const)(
    "disables context discovery when context_files is false in %s mode",
    async (promptMode) => {
      const registry = createAgentLookup({ contextFiles: false, promptMode });
      await createSubagentSession(
        { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
        createSubagentSessionDeps({ io, exec, registry }),
      );
      expect(io.createResourceLoader).toHaveBeenCalledWith(
        expect.objectContaining({ noContextFiles: true }),
      );
    },
  );

  it("prevents Pi from treating an empty replacement body as its default prompt", async () => {
    io.assemblerIO.buildAgentPrompt.mockReturnValue("");
    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      defaultDeps(),
    );
    const loaderOpts = io.createResourceLoader.mock.calls[0]![0];
    expect(loaderOpts.systemPromptOverride!()).toBe(" ");
  });

  it("passes only permitted built-ins to prompt guidance and session creation", async () => {
    const registry = createAgentLookup({
      promptMode: "append",
      permission: { "*": "deny", read: "allow", powershell: "allow", grep: "allow" },
    });
    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry }),
    );
    expect(io.assemblerIO.buildAgentPrompt).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      ["read", "powershell", "grep"],
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ["read", "powershell", "grep"] }),
    );
  });

  it("calls newSession with parentSession when parentSessionId is provided", async () => {
    await createSubagentSession(
      {
        baseline: STUB_SNAPSHOT,
        modelRegistry: MODEL_REGISTRY,
        type: "Explore",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-id-123",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    const sm = io.createSessionManager.mock.results[0]!.value;
    expect(sm.newSession).toHaveBeenCalledWith({ parentSession: "parent-id-123" });
  });
});

describe("createSubagentSession — configured tools", () => {
  it("rejects an unknown child tool before creating the session", async () => {
    const registry = createAgentLookup({
      name: "Custom",
      source: "project",
      permission: { missing_tool: "deny" },
    });

    await expect(
      createSubagentSession(
        { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Custom" },
        createSubagentSessionDeps({ io, exec, registry }),
      ),
    ).rejects.toThrow("project:Custom.md:permission references unknown child tools: missing_tool");
    expect(io.createSession).not.toHaveBeenCalled();
  });

  it("resolves a child extension tool after the loader reloads", async () => {
    const session = arrangeFactory();
    let loaded = false;
    io.createResourceLoader.mockReturnValue({
      reload: vi.fn(async () => {
        loaded = true;
      }),
      getExtensions: vi.fn(() => ({
        extensions: loaded ? [{ tools: new Map([["custom_tool", {}]]) }] : [],
      })),
    });
    const registry = createAgentLookup({
      permission: { "*": "deny", read: "allow", custom_tool: "allow" },
    });

    const sub = await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry }),
    );

    expect(sub.session).toBe(session);
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ["read", "custom_tool"] }),
    );
  });
});

describe("createSubagentSession — lifecycle ordering", () => {
  let session: ReturnType<typeof createFactorySession>;
  let lifecycle: ReturnType<typeof createChildLifecycleMock>;

  beforeEach(() => {
    session = createFactorySession();
    io.createSession.mockResolvedValue({ session });
    lifecycle = createChildLifecycleMock();
  });

  it("emits spawning before session-created", async () => {
    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.spawning).toHaveBeenCalledOnce();
    const spawnOrder = lifecycle.spawning.mock.invocationCallOrder[0]!;
    const createdOrder = lifecycle.sessionCreated.mock.invocationCallOrder[0]!;
    expect(spawnOrder).toBeLessThan(createdOrder);
  });

  it("emits session-created before bindExtensions()", async () => {
    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.sessionCreated).toHaveBeenCalledOnce();
    const createdOrder = lifecycle.sessionCreated.mock.invocationCallOrder[0]!;
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0]!;
    expect(createdOrder).toBeLessThan(bindOrder);
  });

  it("carries the session id and parent session id in session-created", async () => {
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");

    await createSubagentSession(
      {
        baseline: STUB_SNAPSHOT,
        modelRegistry: MODEL_REGISTRY,
        type: "Explore",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-session-42",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.sessionCreated).toHaveBeenCalledWith({
      sessionId: "child-session-id",
      parentSessionId: "parent-session-42",
    });
  });

  it("does not emit completed or disposed during creation", async () => {
    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });
});

describe("createSubagentSession — dispose on creation failure", () => {
  it("disposes the session and emits disposed when bindExtensions throws, then rethrows", async () => {
    const session = createFactorySession();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("bind failed"));
    io.createSession.mockResolvedValue({ session });
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");
    const lifecycle = createChildLifecycleMock();

    await expect(
      createSubagentSession(
        { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
      ),
    ).rejects.toThrow("bind failed");

    // session-created fired, so disposed must fire to avoid a registry leak.
    expect(lifecycle.sessionCreated).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledWith({ sessionId: "child-session-id" });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("shuts down the extensions that did initialize before the bind failed", async () => {
    const session = createFactorySession();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("bind failed"));
    io.createSession.mockResolvedValue({ session });

    await expect(
      createSubagentSession(
        { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
      ),
    ).rejects.toThrow("bind failed");

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
  });
});

describe("createSubagentSession — recursion guard", () => {
  // A child loads this extension too, so it registers the spawn tools during
  // bindExtensions. They are denied at the SDK boundary, which holds for the
  // child's whole life — a post-bind active-set filter would be undone by the
  // next tool-registry refresh (#725).

  it("denies this extension's spawn tools when creating the child session", async () => {
    arrangeFactory();

    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      defaultDeps(),
    );

    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeTools: ["subagent", "get_subagent_result", "steer_subagent"],
      }),
    );
  });

  it("leaves the child's active tool set untouched after bind", async () => {
    const session = arrangeFactory();

    await createSubagentSession(
      { baseline: STUB_SNAPSHOT, modelRegistry: MODEL_REGISTRY, type: "Explore" },
      defaultDeps(),
    );

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});
