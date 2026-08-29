import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types.ts";
import { SubagentsServiceAdapter, toSubagentRecord } from "../../src/service/service-adapter.ts";
import { makeModel } from "../helpers/make-model.ts";
import { createTestSubagent } from "../helpers/make-subagent.ts";

function harness(active = true) {
  const record = createTestSubagent({ id: "child", type: "worker", result: "done" });
  const manager = {
    spawn: vi.fn(() => "child"),
    resume: vi.fn().mockResolvedValue(record),
    getRecord: vi.fn((id: string) => (id === "child" ? record : undefined)),
    listAgents: vi.fn(() => [record]),
    abort: vi.fn(() => true),
    waitForAll: vi.fn().mockResolvedValue(undefined),
    hasRunning: vi.fn(() => true),
    registerWorkspaceProvider: vi.fn(() => vi.fn()),
  };
  const baseline = { cwd: "/child", model: { provider: "p", id: "m" } };
  const model = makeModel({ provider: "p", id: "m" });
  const modelRegistry = {
    find: (provider: string, id: string) =>
      provider === model.provider && id === model.id ? model : undefined,
    getAll: () => [model],
    getAvailable: () => [model],
  };
  const runtime = {
    currentCtx: active ? ({} as never) : undefined,
    buildChildBaseline: vi.fn(() => baseline),
    getModelInfo: vi.fn(() => ({ parentModel: model, modelRegistry })),
    getSessionInfo: vi.fn(() => ({
      parentSessionFile: "/sessions/parent.jsonl",
      parentSessionId: "parent",
    })),
  };
  const registry = new AgentTypeRegistry(
    () =>
      new Map([
        [
          "worker",
          {
            name: "worker",
            description: "worker",
            systemPrompt: "work",
            promptMode: "replace" as const,
            mode: "subagent" as const,
            stacks: new Map([["fast", { model: "p/m" }]]),
          },
        ],
      ]),
  );
  return {
    service: new SubagentsServiceAdapter(manager, runtime, { registry }),
    manager,
    record,
    baseline,
  };
}

describe("toSubagentRecord", () => {
  it("serializes public state and strips mutable collaborators", () => {
    const record = createTestSubagent({ id: "child", result: "done" });
    const snapshot = toSubagentRecord(record);
    expect(snapshot).toMatchObject({
      id: "child",
      task: record.task,
      result: "done",
      maxTurns: "unlimited",
      graceTurns: "unlimited",
    });
    expect(snapshot).not.toHaveProperty("subagentSession");
    expect(snapshot).not.toHaveProperty("abortController");
    expect(snapshot).not.toHaveProperty("promise");
    expect(JSON.stringify(snapshot)).not.toContain("abortController");
  });
});

describe("SubagentsServiceAdapter", () => {
  it("assembles background and foreground spawn requests from value-only runtime accessors", () => {
    const { service, manager, baseline } = harness();
    expect(service.spawn({ type: " worker ", task: " inspect auth ", stack: " fast " })).toBe(
      "child",
    );
    expect(manager.spawn).toHaveBeenLastCalledWith(
      baseline,
      "worker",
      "inspect auth",
      expect.objectContaining({
        description: "inspect auth",
        model: expect.objectContaining({ provider: "p", id: "m" }),
        thinkingLevel: undefined,
        isBackground: true,
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent",
        },
        invocation: expect.objectContaining({
          stack: "fast",
          modelName: "p/m",
          runInBackground: true,
        }),
      }),
    );

    service.spawn({ type: "worker", task: "foreground", foreground: true });
    expect(manager.spawn).toHaveBeenLastCalledWith(
      baseline,
      "worker",
      "foreground",
      expect.objectContaining({
        isBackground: false,
        invocation: expect.objectContaining({ runInBackground: false }),
      }),
    );
  });

  it("rejects ambient inheritance, invalid input, and spawning without a session", () => {
    const { service, manager } = harness();
    expect(() => service.spawn({ type: "worker", task: "", maxTurns: 0 })).toThrow(/task/);
    expect(() => service.spawn({ type: "worker", task: "x", maxTurns: 0 })).toThrow(/maxTurns/);
    expect(() =>
      service.spawn({ type: "worker", task: "x", inheritContext: true } as never),
    ).toThrow(/unsupported/);
    expect(() => service.spawn({ type: "worker", task: "x", model: "p/m" } as never)).toThrow(
      /unsupported request field/,
    );
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(() => harness(false).service.spawn({ type: "worker", task: "x" })).toThrow(
      /No active session/,
    );
  });

  it("supports inspect/list/abort/wait and workspace registration", async () => {
    const { service, manager } = harness();
    expect(service.inspect("child")?.id).toBe("child");
    expect(service.inspect("missing")).toBeUndefined();
    expect(service.listAgents()).toHaveLength(1);
    expect(service.abort("child")).toBe(true);
    expect(service.hasRunning()).toBe(true);
    await service.waitForAll();
    const provider = { prepare: vi.fn() };
    const dispose = service.registerWorkspaceProvider(provider);
    expect(manager.registerWorkspaceProvider).toHaveBeenCalledWith(provider);
    expect(dispose).toBeTypeOf("function");
  });

  it("validates and serializes child-only resume and explicit steering", async () => {
    const { service, manager, record } = harness();
    record.steer = vi.fn().mockResolvedValue({ kind: "sent" });
    expect((await service.resume({ id: "child", task: "new facts", graceTurns: 0 }))?.id).toBe(
      "child",
    );
    expect(manager.resume).toHaveBeenCalledWith(
      "child",
      "new facts",
      undefined,
      { maxTurns: undefined, graceTurns: 0 },
      expect.objectContaining({
        model: expect.objectContaining({ provider: "p", id: "m" }),
        snapshot: expect.objectContaining({ stack: "default", modelName: "p/m", graceTurns: 0 }),
      }),
    );
    await expect(
      service.resume({ id: "child", task: "new facts", stack: "fast" }),
    ).resolves.toMatchObject({ id: "child" });
    expect(manager.resume).toHaveBeenLastCalledWith(
      "child",
      "new facts",
      undefined,
      { maxTurns: undefined, graceTurns: undefined },
      expect.objectContaining({
        model: expect.objectContaining({ provider: "p", id: "m" }),
        snapshot: expect.objectContaining({ stack: "fast", modelName: "p/m" }),
      }),
    );
    const resumeCalls = manager.resume.mock.calls.length;
    await expect(
      service.resume({ id: "child", task: "new facts", stack: "missing" }),
    ).rejects.toThrow(/Unknown explicit stack/);
    expect(manager.resume).toHaveBeenCalledTimes(resumeCalls);
    expect(await service.steer("child", "change direction")).toBe(true);
    expect(record.steer).toHaveBeenCalledWith("change direction");
    await expect(service.steer("child", " ")).rejects.toThrow(/steering/);
    await expect(
      service.resume({ id: "child", task: "new facts", model: "p/m" } as never),
    ).rejects.toThrow(/unsupported request field/);
  });
});
