import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../src/config/agent-types.ts";
import { buildChildRuntimeBaseline } from "../src/lifecycle/child-runtime-baseline.ts";
import { SubagentsServiceAdapter } from "../src/service/service-adapter.ts";
import { buildAgentPrompt } from "../src/session/prompts.ts";
import { loadSettings, SettingsManager } from "../src/settings.ts";
import { AgentTool } from "../src/tools/agent-tool.ts";
import { resolveResumeConfig, resolveSpawnConfig } from "../src/tools/spawn-config.ts";
import { SteerTool } from "../src/tools/steer-tool.ts";
import { SubagentsSettingsHandler } from "../src/ui/subagents-settings.ts";
import { createToolDeps } from "./helpers/make-deps.ts";
import { makeModel } from "./helpers/make-model.ts";
import { createTestSubagent } from "./helpers/make-subagent.ts";
import { createSubagentSessionStub, toSubagentSession } from "./helpers/mock-session.ts";

const registry = new AgentTypeRegistry(
  () =>
    new Map([
      [
        "worker",
        {
          name: "worker",
          description: "worker",
          promptMode: "append" as const,
          systemPrompt: "STATIC_CHILD_INSTRUCTIONS",
        },
      ],
    ]),
);

function resolve(params: Record<string, unknown>) {
  return resolveSpawnConfig(
    params,
    registry,
    {
      parentModel: makeModel(),
      modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
    },
    { defaultMaxTurns: undefined, graceTurns: undefined },
  );
}

describe("isolated child contracts", () => {
  it("uses task and independent optional budgets without recursive context controls", () => {
    const deps = createToolDeps();
    const def = new AgentTool(
      deps.manager,
      deps.runtime,
      deps.settings,
      deps.registry,
      deps.agentDir,
    ).toToolDefinition() as unknown as {
      parameters: { properties: Record<string, unknown>; required: string[] };
      description: string;
    };
    expect(def.parameters.properties).toHaveProperty("task");
    expect(def.parameters.properties).toHaveProperty("stack");
    expect(def.parameters.properties).toHaveProperty("max_turns");
    expect(def.parameters.properties).toHaveProperty("grace_turns");
    expect(def.parameters.properties).not.toHaveProperty("prompt");
    expect(def.parameters.properties).not.toHaveProperty("inherit_context");
    expect(def.parameters.required).toContain("task");
    expect(def.description).toContain("sees none of the main conversation");
  });

  it("rejects blank text, zero max turns, and the removed context option", () => {
    expect(resolve({ task: "  ", description: "x", subagent_type: "worker" })).toEqual({
      error: "task must be a non-empty self-contained string",
    });
    expect(resolve({ task: "x", description: "x", subagent_type: "worker", max_turns: 0 })).toEqual(
      { error: "max_turns must be an integer from 1 through 10000" },
    );
    expect(
      resolve({ task: "x", description: "x", subagent_type: "worker", inherit_context: false }),
    ).toMatchObject({ error: expect.stringContaining("unsupported") });
  });

  it("resolves max and grace independently as unlimited when omitted", () => {
    const result = resolve({ task: "child task", description: "work", subagent_type: "worker" });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBeUndefined();
    expect(result.execution.effectiveGraceTurns).toBeUndefined();
    expect(result.execution.task).toBe("child task");
  });

  it("uses the task as a description when a new child has none", () => {
    const result = resolve({ task: "child task", subagent_type: "worker" });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.execution.description).toBe("child task");
  });

  it("captures only cwd and immutable model identity in the child baseline", () => {
    const model = makeModel({ provider: "provider", id: "child-model" });
    const baseline = buildChildRuntimeBaseline({
      cwd: "/child",
      model,
      modelRegistry: { find: () => model, getAll: () => [model] },
      sessionManager: {
        getSessionFile: () => "/parent/session.jsonl",
        getSessionId: () => "parent-id",
      },
    });
    expect(baseline).toEqual({
      cwd: "/child",
      model: { provider: "provider", id: "child-model" },
    });
    expect(baseline.model).not.toBe(model);
    const prompt = buildAgentPrompt(registry.resolveAgentConfig("worker"), "/child", {
      isGitRepo: false,
      branch: "",
      platform: "linux",
    });
    expect(prompt).toContain("STATIC_CHILD_INSTRUCTIONS");
  });

  it("resumes with a new task and independently optional budgets", async () => {
    expect(resolveResumeConfig({ task: "  " })).toEqual({
      error: "task must be a non-empty self-contained string",
    });
    expect(resolveResumeConfig({ task: "resume", max_turns: 2, grace_turns: 0 })).toEqual({
      task: "resume",
      maxTurns: 2,
      graceTurns: 0,
    });

    const deps = createToolDeps();
    const record = createTestSubagent({ result: "done" });
    record.subagentSession = toSubagentSession(createSubagentSessionStub());
    deps.manager.getRecord = vi.fn(() => record);
    deps.manager.resume = vi.fn().mockResolvedValue(record);
    const tool = new AgentTool(
      deps.manager,
      deps.runtime,
      deps.settings,
      deps.registry,
      deps.agentDir,
    );
    await tool.execute(
      "call",
      { resume: "child", task: "resume with explicit facts", max_turns: 2, grace_turns: 0 },
      new AbortController().signal,
      undefined,
      {} as never,
    );
    expect(deps.manager.resume).toHaveBeenCalledWith(
      "child",
      "resume with explicit facts",
      expect.any(AbortSignal),
      { maxTurns: 2, graceTurns: 0 },
    );
  });

  it("requires trimmed steering", async () => {
    const record = { steer: vi.fn() };
    const tool = new SteerTool({ getRecord: () => record as never }, { emit: vi.fn() });
    const result = await tool.execute(
      "id",
      { agent_id: "a", steering: "  " },
      new AbortController().signal,
      undefined,
      undefined,
    );
    expect(result.content[0]).toMatchObject({ text: "steering must be a non-empty string" });
    expect(record.steer).not.toHaveBeenCalled();
  });
});

describe("settings and service boundaries", () => {
  it("diagnoses unknown and invalid settings while preserving valid fields", () => {
    const root = mkdtempSync(join(tmpdir(), "roster-settings-"));
    const project = join(root, "project");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "agent-roster.json"),
      JSON.stringify({ maxConcurrent: 3, graceTurns: -1, stacks: { fast: {} } }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSettings(root, project)).toEqual({ maxConcurrent: 3 });
    const diagnostics = warn.mock.calls.flat().join(" ");
    expect(diagnostics).toContain("graceTurns");
    expect(diagnostics).toContain("fix or remove this value");
    expect(diagnostics).toContain("unknown field stacks");
    expect(diagnostics).toContain("define stacks in agent Markdown files instead");
    warn.mockRestore();
  });

  it("keeps both omitted budgets unlimited in memory and persistence", () => {
    const cwd = mkdtempSync(join(tmpdir(), "roster-manager-"));
    const settings = new SettingsManager({ emit: vi.fn(), cwd, agentDir: cwd });
    expect(settings.defaultMaxTurns).toBeUndefined();
    expect(settings.graceTurns).toBeUndefined();
    expect(settings.snapshot()).not.toHaveProperty("defaultMaxTurns");
    expect(settings.snapshot()).not.toHaveProperty("graceTurns");
    settings.applyGraceTurns(0);
    expect(settings.snapshot()).toMatchObject({ graceTurns: 0 });
    settings.applyGraceTurns(undefined);
    expect(settings.snapshot()).not.toHaveProperty("graceTurns");
  });

  it("lets the project UI clear either budget without writing a finite default", async () => {
    const settings = {
      maxConcurrent: 4,
      defaultMaxTurns: 10,
      graceTurns: 3,
      consumedSessionRetentionMinutes: 10,
      unconsumedSessionRetentionMinutes: 720,
      abortAllOnInterrupt: true,
      applyMaxConcurrent: vi.fn(),
      applyDefaultMaxTurns: vi.fn(() => ({ message: "ok", level: "info" as const })),
      applyGraceTurns: vi.fn(() => ({ message: "ok", level: "info" as const })),
      applyConsumedSessionRetentionMinutes: vi.fn(),
      applyUnconsumedSessionRetentionMinutes: vi.fn(),
      toggleAbortAllOnInterrupt: vi.fn(),
    };
    const ui = {
      select: vi.fn().mockResolvedValue("Grace turns (current: 3)"),
      input: vi.fn().mockResolvedValue("unlimited"),
      notify: vi.fn(),
    };
    await new SubagentsSettingsHandler(settings).handle({ ui });
    expect(settings.applyGraceTurns).toHaveBeenCalledWith(undefined);
  });

  it("validates service tasks and budgets before spawn", () => {
    const manager = { spawn: vi.fn() };
    const service = new SubagentsServiceAdapter(manager as never, {
      currentCtx: {} as never,
      buildChildBaseline: vi.fn(),
      getSessionInfo: () => ({ parentSessionFile: "", parentSessionId: "parent" }),
    });
    expect(() => service.spawn({ type: "worker", task: " " })).toThrow(/task/);
    expect(() => service.spawn({ type: "worker", task: "x", maxTurns: 0 })).toThrow(/maxTurns/);
    expect(() =>
      service.spawn({ type: "worker", task: "x", inheritContext: true } as never),
    ).toThrow(/inheritContext/);
    expect(manager.spawn).not.toHaveBeenCalled();
  });
});
