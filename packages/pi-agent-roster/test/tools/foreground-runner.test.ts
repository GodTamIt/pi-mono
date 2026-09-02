import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ForegroundParams, runForeground } from "../../src/tools/foreground-runner.ts";
import { createToolDeps } from "../helpers/make-deps.ts";
import { createResolvedSpawnConfig } from "../helpers/make-spawn-config.ts";
import { createTestSubagent } from "../helpers/make-subagent.ts";
import { STUB_SNAPSHOT } from "../helpers/stub-ctx.ts";

function makeParams(overrides: Partial<ForegroundParams> = {}): ForegroundParams {
  return {
    config: createResolvedSpawnConfig({ description: "fg task" }),
    baseline: STUB_SNAPSHOT,
    parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "session-1" },
    ...overrides,
  };
}

describe("runForeground", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns completion message with tool use count on success", async () => {
    const { manager } = createToolDeps();
    const result = await runForeground(manager, makeParams(), undefined, undefined);
    expect(result.content[0]!.text).toContain("Agent completed");
    expect(result.content[0]!.text).toContain("3 tool uses");
    expect(result.content[0]!.text).toContain("All done.");
  });

  it("marks the returned record consumed (foreground-return delivery edge)", async () => {
    const record = createTestSubagent();
    const deps = createToolDeps({
      manager: { ...createToolDeps().manager, spawnAndWait: vi.fn().mockResolvedValue(record) },
    });
    await runForeground(deps.manager, makeParams(), undefined, undefined);
    expect(record.consumed).toBe(true);
  });

  it("marks consumed even when the agent errored (result delivered in the tool result)", async () => {
    const record = createTestSubagent({ status: "error", error: "boom" });
    const deps = createToolDeps({
      manager: { ...createToolDeps().manager, spawnAndWait: vi.fn().mockResolvedValue(record) },
    });
    await runForeground(deps.manager, makeParams(), undefined, undefined);
    expect(record.consumed).toBe(true);
  });

  it("returns error message when agent record status is error", async () => {
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi
          .fn()
          .mockResolvedValue(
            createTestSubagent({ status: "error", error: "Context window exceeded" }),
          ),
      },
    });
    const result = await runForeground(deps.manager, makeParams(), undefined, undefined);
    expect(result.content[0]!.text).toContain("Agent failed");
    expect(result.content[0]!.text).toContain("Context window exceeded");
  });

  it("returns error text when spawnAndWait throws", async () => {
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockRejectedValue(new Error("runner crashed")),
      },
    });
    const result = await runForeground(deps.manager, makeParams(), undefined, undefined);
    expect(result.content[0]!.text).toContain("runner crashed");
  });

  it("includes fallback note when fellBack is true", async () => {
    const { manager } = createToolDeps();
    const result = await runForeground(
      manager,
      makeParams({
        config: createResolvedSpawnConfig({
          rawType: "unknown-type",
          fellBack: true,
          description: "fg task",
        }),
      }),
      undefined,
      undefined,
    );
    expect(result.content[0]!.text).toContain('Unknown agent type "unknown-type"');
  });

  it("calls onUpdate with streaming details while running", async () => {
    let resolve!: (r: any) => void;
    const promise = new Promise<any>((res) => {
      resolve = res;
    });
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockReturnValue(promise),
      },
    });
    const onUpdate = vi.fn();
    const runPromise = runForeground(deps.manager, makeParams(), undefined, onUpdate);

    // Advance timer to trigger a spinner tick
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalled();

    resolve(createTestSubagent({ result: "done" }));
    await runPromise;
  });

  it("does not stream running metadata after the live record settles", async () => {
    let resolve!: (record: ReturnType<typeof createTestSubagent>) => void;
    const pending = new Promise<ReturnType<typeof createTestSubagent>>((done) => {
      resolve = done;
    });
    const record = createTestSubagent({ status: "running", startedAt: 1000, turnCount: 7 });
    vi.spyOn(record, "getContextPercent").mockReturnValue(35);
    const spawnAndWait = vi.fn((_baseline, _type, _task, options) => {
      options.observer?.onSessionCreated?.(record);
      return pending;
    });
    const deps = createToolDeps({
      manager: { ...createToolDeps().manager, spawnAndWait },
    });
    const onUpdate = vi.fn();
    const runPromise = runForeground(deps.manager, makeParams(), undefined, onUpdate);

    record.markCompleted("done", 2000);
    await vi.advanceTimersByTimeAsync(100);

    const streamed = onUpdate.mock.calls.at(-1)?.[0].details;
    expect(streamed.status).toBe("completed");
    expect(streamed.durationMs).toBe(1000);
    expect(streamed.contextPercent).toBe(35);

    // One settled update is streamed, then the interval stops ticking
    const settledCalls = onUpdate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(onUpdate.mock.calls.length).toBe(settledCalls);

    resolve(record);
    await runPromise;
  });

  it("clears spinner interval on error and does not leave it running", async () => {
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockRejectedValue(new Error("fail")),
      },
    });
    const onUpdate = vi.fn();
    await runForeground(deps.manager, makeParams(), undefined, onUpdate);

    onUpdate.mockClear();
    await vi.advanceTimersByTimeAsync(200);
    // Interval must have been cleared — no further onUpdate calls
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
