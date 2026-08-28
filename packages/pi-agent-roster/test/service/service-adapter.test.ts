import { describe, expect, it, vi } from "vitest";
import { SubagentsServiceAdapter, toSubagentRecord } from "../../src/service/service-adapter.ts";
import { createTestSubagent } from "../helpers/make-subagent.ts";

function harness(active = true) {
  const record = createTestSubagent({ id: "child", result: "done" });
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
  const runtime = {
    currentCtx: active ? ({} as never) : undefined,
    buildChildBaseline: vi.fn(() => baseline),
    getSessionInfo: vi.fn(() => ({
      parentSessionFile: "/sessions/parent.jsonl",
      parentSessionId: "parent",
    })),
  };
  return { service: new SubagentsServiceAdapter(manager, runtime), manager, record, baseline };
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
    expect(manager.spawn).toHaveBeenLastCalledWith(baseline, "worker", "inspect auth", {
      description: "inspect auth",
      maxTurns: undefined,
      graceTurns: undefined,
      bypassQueue: undefined,
      isBackground: true,
      parentSession: {
        parentSessionFile: "/sessions/parent.jsonl",
        parentSessionId: "parent",
      },
      invocation: {
        stack: "fast",
        maxTurns: undefined,
        graceTurns: undefined,
        runInBackground: true,
      },
    });

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
    expect(manager.resume).toHaveBeenCalledWith("child", "new facts", undefined, {
      maxTurns: undefined,
      graceTurns: 0,
    });
    await expect(service.resume({ id: "child", task: "new facts", stack: "fast" })).rejects.toThrow(
      /stack selection is unavailable/,
    );
    expect(await service.steer("child", "change direction")).toBe(true);
    expect(record.steer).toHaveBeenCalledWith("change direction");
    await expect(service.steer("child", " ")).rejects.toThrow(/steering/);
  });
});
