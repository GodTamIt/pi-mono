import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types.ts";
import { AgentTool } from "../../src/tools/agent-tool.ts";
import type { AgentConfig } from "../../src/types.ts";
import { createToolDeps, createToolDepsWithDisabledBuiltInAgents } from "../helpers/make-deps.ts";
import { createTestSubagent } from "../helpers/make-subagent.ts";
import {
  createMockSession,
  createSubagentSessionStub,
  toSubagentSession,
} from "../helpers/mock-session.ts";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    ui: { fake: true },
    ...overrides,
  } as unknown as ExtensionContext;
}

function makeTool(deps: ReturnType<typeof createToolDeps>) {
  return new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir);
}

async function execute(
  deps: ReturnType<typeof createToolDeps>,
  params: Record<string, unknown>,
  ctx?: ReturnType<typeof makeCtx>,
) {
  return makeTool(deps).execute(
    "tc-1",
    params,
    new AbortController().signal,
    vi.fn(),
    ctx ?? makeCtx(),
  );
}

describe("AgentTool", () => {
  it("returns tool definition with correct name and label", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.name).toBe("subagent");
    expect(def.label).toBe("Subagent");
  });

  it("includes promptSnippet", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.promptSnippet).toBe("Delegate complex, multi-step tasks to a specialized agent.");
  });

  it("exposes only the documented snake_case invocation schema", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(Object.keys(def.parameters.properties).sort()).toEqual(
      [
        "description",
        "grace_turns",
        "max_turns",
        "model",
        "resume",
        "run_in_background",
        "stack",
        "subagent_type",
        "task",
        "thinking",
      ].sort(),
    );
    expect(def.parameters.properties.task.description).toBe(
      "Self-contained task: the child has no parent context; include required facts, paths, constraints, and expected output.",
    );
    expect(Value.Check(def.parameters, { task: "Inspect src/runtime.ts" })).toBe(true);
    expect(Value.Check(def.parameters, { task: "   " })).toBe(false);
    expect(
      Value.Check(def.parameters, {
        task: "Inspect src/runtime.ts",
        stack: { model: "provider/model" },
      }),
    ).toBe(false);
    expect(
      Value.Check(def.parameters, { task: "Inspect src/runtime.ts", inherit_context: true }),
    ).toBe(false);
  });

  it("derives type list from registry — includes default agents in description", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    // testRegistry loads default agents: general-purpose, Explore, Architect
    expect(def.description).toContain("- general-purpose: General-purpose agent");
    expect(def.description).toContain("- Explore: Fast codebase exploration agent");
  });

  it("does not advertise primary-only agents as subagents", () => {
    const agent = (name: string, mode: AgentConfig["mode"]): AgentConfig => ({
      name,
      description: `${name} description`,
      systemPrompt: `${name} prompt`,
      promptMode: "replace",
      mode,
      isDefault: true,
      toolGuideline: `- Use ${name}.`,
    });
    const registry = new AgentTypeRegistry(
      () =>
        new Map([
          ["architect", agent("architect", "primary")],
          ["reviewer", agent("reviewer", "subagent")],
          ["utility", agent("utility", "all")],
        ]),
    );
    const def = makeTool(createToolDeps({ registry })).toToolDefinition();
    const typeDescription = def.parameters.properties.subagent_type.description;

    expect(typeDescription).toContain("reviewer, utility");
    expect(typeDescription).not.toContain("architect");
    expect(def.description).toContain("- reviewer: reviewer description");
    expect(def.description).toContain("- utility: utility description");
    expect(def.description).not.toContain("architect description");
    expect(def.description).not.toContain("Use architect");
  });

  it("lists the built-in agent guidelines in registry order", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    const guidelines = [
      "- Use general-purpose for complex tasks that need file editing.",
      "- Use Explore for codebase searches and code understanding.",
      "- Use Architect for architecture and implementation design.",
    ];
    for (const line of guidelines) expect(def.description).toContain(line);
    const positions = guidelines.map((line) => def.description.indexOf(line));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it.for(["Explore", "Architect", "general-purpose"])(
    "omits the type-list entry and guideline for a disabled built-in %s",
    (name) => {
      const def = makeTool(createToolDepsWithDisabledBuiltInAgents(name)).toToolDefinition();
      expect(def.description).not.toContain(`- ${name}:`);
      expect(def.description).not.toContain(`- Use ${name} for `);
    },
  );

  it("calls registry.reload() on each execute", async () => {
    const deps = createToolDeps();
    const reloadSpy = vi.spyOn(deps.registry, "reload");
    await execute(deps, {
      task: "test",
      description: "test",
      subagent_type: "general-purpose",
    });
    expect(reloadSpy).toHaveBeenCalledOnce();
    reloadSpy.mockRestore();
  });
});

describe("AgentTool — resume path", () => {
  it("returns not-found when resume ID does not exist", async () => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
    const result = await execute(deps, {
      task: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "nonexistent",
    });
    expect(result.content[0]!.text).toContain("Agent not found");
  });

  it("returns no-session when agent has no active session", async () => {
    const deps = createToolDeps();
    // No execution state set — session not yet created
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent());
    const result = await execute(deps, {
      task: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "agent-1",
    });
    expect(result.content[0]!.text).toContain("no child transcript");
  });

  it("returns not-found copy without claiming cleanup for an unknown resume ID", async () => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
    const result = await execute(deps, {
      task: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "nonexistent",
    });
    expect(result.content[0]!.text).toContain("Agent not found");
    expect(result.content[0]!.text).not.toContain("cleaned up");
  });

  it("resumes a released agent from its child transcript", async () => {
    const deps = createToolDeps();
    const released = createTestSubagent();
    released.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession(), "/tasks/agent.jsonl"),
    );
    await released.releaseSession();
    deps.manager.getRecord = vi.fn().mockReturnValue(released);
    const result = await execute(deps, {
      task: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "agent-1",
    });
    expect(result.content[0]!.text).toContain("All done.");
    expect(deps.manager.resume).toHaveBeenCalledWith(
      "agent-1",
      "continue",
      expect.any(AbortSignal),
      { maxTurns: undefined, graceTurns: undefined },
      expect.objectContaining({
        snapshot: expect.objectContaining({ stack: "default" }),
      }),
    );
  });

  it("applies legacy model and thinking as one-off overrides for the existing agent", async () => {
    const deps = createToolDeps();
    const resumeRecord = createTestSubagent({ type: "general-purpose" });
    resumeRecord.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession()),
    );
    deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
    const parentModel = deps.runtime.getModelInfo().parentModel!;
    const model = { ...parentModel, reasoning: true };
    deps.runtime.getModelInfo = vi.fn(() => ({
      parentModel: model,
      modelRegistry: {
        find: (provider: string, id: string) =>
          provider === model.provider && id === model.id ? model : undefined,
        getAll: () => [model],
        getAvailable: () => [model],
      },
    }));

    await execute(deps, {
      task: "continue",
      resume: "agent-1",
      model: `${model.provider}/${model.id}`,
      thinking: "high",
    });

    expect(deps.manager.resume).toHaveBeenCalledWith(
      "agent-1",
      "continue",
      expect.any(AbortSignal),
      { maxTurns: undefined, graceTurns: undefined },
      expect.objectContaining({
        model,
        snapshot: expect.objectContaining({
          modelName: `${model.provider}/${model.id}`,
          thinking: "high",
        }),
      }),
    );
  });

  it("rejects invalid legacy overrides atomically before resume", async () => {
    const deps = createToolDeps();
    const resumeRecord = createTestSubagent();
    resumeRecord.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession()),
    );
    deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);

    const result = await execute(deps, {
      task: "continue",
      resume: "agent-1",
      model: "valid-looking-model",
      thinking: "turbo",
    });

    expect(result.content[0]!.text).toContain("thinking must be one of");
    expect(deps.manager.resume).not.toHaveBeenCalled();
  });

  it("returns result text on successful resume", async () => {
    const deps = createToolDeps();
    const resumeRecord = createTestSubagent();
    resumeRecord.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession()),
    );
    deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
    deps.manager.resume = vi
      .fn()
      .mockResolvedValue(createTestSubagent({ result: "Resumed output." }));
    const result = await execute(deps, {
      task: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "agent-1",
    });
    expect(result.content[0]!.text).toContain("Resumed output.");
  });

  it("marks the resumed record consumed (resume-return delivery edge)", async () => {
    const deps = createToolDeps();
    const resumeRecord = createTestSubagent();
    resumeRecord.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession()),
    );
    deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
    const resumed = createTestSubagent({ result: "Resumed output." });
    deps.manager.resume = vi.fn().mockResolvedValue(resumed);
    await execute(deps, {
      task: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "agent-1",
    });
    expect(resumed.consumed).toBe(true);
  });

  it("starts a background resume and returns retrieval guidance without consuming it", async () => {
    const deps = createToolDeps();
    const resumeRecord = createTestSubagent({
      invocation: { stack: "default", modelName: "anthropic/old", thinking: "low" },
    });
    resumeRecord.subagentSession = toSubagentSession(
      createSubagentSessionStub(createMockSession()),
    );
    deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
    deps.manager.resume = vi.fn(() => new Promise<never>(() => {}));

    const result = await execute(deps, {
      task: "continue",
      resume: "agent-1",
      max_turns: 4,
      grace_turns: 1,
      run_in_background: true,
    });

    expect(result.content[0]!.text).toContain("resumed in background");
    expect(result.content[0]!.text).toContain("Agent ID: agent-1");
    expect(result.content[0]!.text).toContain("get_subagent_result");
    expect(result.content[0]!.text).toContain("steer_subagent");
    expect(resumeRecord.consumed).toBe(false);
    expect(deps.manager.resume).toHaveBeenCalledWith(
      "agent-1",
      "continue",
      expect.objectContaining({ aborted: false }),
      { maxTurns: 4, graceTurns: 1 },
      expect.objectContaining({
        snapshot: expect.objectContaining({
          stack: "default",
          maxTurns: 4,
          graceTurns: 1,
          runInBackground: true,
        }),
      }),
    );
  });
});

describe("AgentTool — model resolution error", () => {
  it("returns error when model resolution fails", async () => {
    const deps = createToolDeps();
    const result = await execute(deps, {
      task: "test",
      description: "test",
      subagent_type: "general-purpose",
      model: "nonexistent-model-xyz",
    });
    // User-specified model that doesn't resolve → error message
    expect(result.content[0]!.text).toContain("nonexistent-model-xyz");
  });
});

describe("AgentTool — background execution", () => {
  it("returns background launch message with agent ID", async () => {
    const deps = createToolDeps();
    const record = createTestSubagent({ status: "running" });
    deps.manager.getRecord = vi.fn().mockReturnValue(record);
    const result = await execute(deps, {
      task: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("background");
    expect(text).toContain("agent-1");
    expect(text).toContain("bg task");
  });

  it("does not emit subagents:created directly — delegated to observer.onSubagentCreated", async () => {
    // The subagents:created event is now emitted by SubagentManagerObserver.onSubagentCreated,
    // called from SubagentManager.spawn(). Tested in subagent-manager.test.ts.
    // This test ensures the tool no longer holds an emitEvent dep for this purpose.
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
    const result = await execute(deps, {
      task: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    // Background spawn succeeds — no emitEvent dep required
    expect(result.content[0]!.text).toContain("background");
  });

  it("passes parentSession.toolCallId to manager.spawn", async () => {
    const deps = createToolDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
    await execute(deps, {
      task: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(spawnOpts.parentSession?.toolCallId).toBe("tc-1");
  });
});

describe("AgentTool — foreground execution", () => {
  it("returns completion message with stats", async () => {
    const deps = createToolDeps();
    deps.manager.spawnAndWait = vi
      .fn()
      .mockResolvedValue(createTestSubagent({ result: "Task complete.", toolUses: 5 }));
    const result = await execute(deps, {
      task: "do task",
      description: "fg task",
      subagent_type: "general-purpose",
    });
    const text = result.content[0]!.text;
    expect(text).toContain("Agent completed");
    expect(text).toContain("Task complete.");
  });

  it("returns error message when agent fails", async () => {
    const deps = createToolDeps();
    deps.manager.spawnAndWait = vi
      .fn()
      .mockResolvedValue(createTestSubagent({ status: "error", error: "Out of context" }));
    const result = await execute(deps, {
      task: "do task",
      description: "fg task",
      subagent_type: "general-purpose",
    });
    expect(result.content[0]!.text).toContain("Agent failed");
    expect(result.content[0]!.text).toContain("Out of context");
  });

  it("returns error when spawnAndWait throws", async () => {
    const deps = createToolDeps();
    deps.manager.spawnAndWait = vi.fn().mockRejectedValue(new Error("spawn failure"));
    const result = await execute(deps, {
      task: "do task",
      description: "fg task",
      subagent_type: "general-purpose",
    });
    expect(result.content[0]!.text).toContain("spawn failure");
  });
});
