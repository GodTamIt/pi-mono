import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../src/config/agent-types.ts";
import { ConcurrencyLimiter } from "../src/lifecycle/concurrency-limiter.ts";
import {
  type CreateSubagentSessionParams,
  createSubagentSession,
} from "../src/lifecycle/create-subagent-session.ts";
import { SubagentManager } from "../src/lifecycle/subagent-manager.ts";
import type { SubagentSession } from "../src/lifecycle/subagent-session.ts";
import { SubagentsServiceAdapter, toSubagentRecord } from "../src/service/service-adapter.ts";
import type { SessionContext } from "../src/types.ts";
import { makeModel } from "./helpers/make-model.ts";
import {
  createAgentLookup,
  createFactorySession,
  createSubagentSessionDeps,
  createSubagentSessionIO,
} from "./helpers/subagent-session-io.ts";

const CHILD_TASK = "Inspect src/auth.ts and report the exact failing branch.";
const CHILD_SYSTEM = "CHILD_ONLY_SYSTEM";
const PARENT_SENTINELS = [
  { kind: "prompt", text: "PARENT_PROMPT_SENTINEL" },
  { kind: "message", text: "PARENT_MESSAGE_SENTINEL" },
  { kind: "tool-result", text: "PARENT_TOOL_RESULT_SENTINEL" },
  { kind: "thinking", text: "PARENT_THINKING_SENTINEL" },
  { kind: "compaction", text: "PARENT_COMPACTION_SENTINEL" },
  { kind: "event", text: "PARENT_EVENT_SENTINEL" },
  vi.fn(() => "PARENT_CALLBACK_SENTINEL"),
] as const;

function containsReference(
  value: unknown,
  targets: readonly unknown[],
  seen = new Set<unknown>(),
): boolean {
  if (targets.some((target) => value === target)) return true;
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (containsReference((value as Record<PropertyKey, unknown>)[key], targets, seen)) return true;
  }
  return false;
}

function createHarness(limit = 4) {
  const model = makeModel({ provider: "test-provider", id: "test-model" });
  const modelRegistry = {
    find: (provider: string, id: string) =>
      provider === model.provider && id === model.id ? model : undefined,
    getAll: () => [model],
    getAvailable: () => [model],
  };
  const constructions: Array<{
    params: CreateSubagentSessionParams;
    systemPrompt: string;
    session: ReturnType<typeof createFactorySession>;
    sessionManager: ReturnType<ReturnType<typeof createSubagentSessionIO>["createSessionManager"]>;
  }> = [];
  let blockNextPrompt: Promise<void> | undefined;

  const factory = vi.fn(async (params: CreateSubagentSessionParams): Promise<SubagentSession> => {
    const io = createSubagentSessionIO();
    const session = createFactorySession();
    session.prompt.mockImplementation(async (task: string) => {
      session.messages.push({ role: "user", content: task });
      if (blockNextPrompt) {
        const block = blockNextPrompt;
        blockNextPrompt = undefined;
        await block;
      }
      session.messages.push({ role: "assistant", content: "CHILD_RESULT" });
    });
    io.createSession.mockResolvedValue({ session });
    io.assemblerIO.buildAgentPrompt.mockReturnValue(CHILD_SYSTEM);
    const subagentSession = await createSubagentSession(
      params,
      createSubagentSessionDeps({
        io,
        registry: createAgentLookup({ systemPrompt: "STATIC_CHILD_INSTRUCTIONS" }),
      }),
    );
    const loader = io.createResourceLoader.mock.calls[0]![0];
    constructions.push({
      params,
      systemPrompt: loader.systemPromptOverride!(),
      session,
      sessionManager:
        io.createSessionManager.mock.results[0]?.value ??
        io.openSessionManager.mock.results[0]!.value,
    });
    return subagentSession;
  });

  const manager = new SubagentManager({
    createSubagentSession: factory,
    limiter: new ConcurrencyLimiter(() => limit),
    baseCwd: "/repo",
    getModelRegistry: () => modelRegistry,
    getDefaultModel: () => model,
  });

  return {
    manager,
    model,
    modelRegistry,
    factory,
    constructions,
    blockPromptUntil(promise: Promise<void>) {
      blockNextPrompt = promise;
    },
  };
}

function parentContext(harness: ReturnType<typeof createHarness>): SessionContext {
  return {
    cwd: "/repo",
    model: harness.model,
    modelRegistry: harness.modelRegistry,
    sessionManager: {
      getSessionFile: () => "/sessions/parent.jsonl",
      getSessionId: () => "parent-lineage-id",
    },
    parentPrompt: PARENT_SENTINELS[0],
    messages: [PARENT_SENTINELS[1], PARENT_SENTINELS[2]],
    thinking: PARENT_SENTINELS[3],
    compaction: PARENT_SENTINELS[4],
    event: PARENT_SENTINELS[5],
    callback: PARENT_SENTINELS[6],
  } as SessionContext;
}

function assertChildConstructionIsClean(
  construction: ReturnType<typeof createHarness>["constructions"][number],
) {
  expect(construction.systemPrompt).toBe(CHILD_SYSTEM);
  expect(construction.session.prompt).toHaveBeenCalledWith(CHILD_TASK);
  expect(construction.session.messages).toEqual([
    { role: "user", content: CHILD_TASK },
    { role: "assistant", content: "CHILD_RESULT" },
  ]);
  expect(containsReference(construction.params, PARENT_SENTINELS)).toBe(false);
  expect(containsReference(construction.session.messages, PARENT_SENTINELS)).toBe(false);
}

describe("child isolation boundary", () => {
  it("constructs and prompts a foreground child without retaining parent runtime content", async () => {
    const harness = createHarness();
    const ctx = parentContext(harness);
    const record = await harness.manager.spawnAndWait(
      { cwd: ctx.cwd, model: { provider: harness.model.provider, id: harness.model.id } },
      "worker",
      CHILD_TASK,
      {
        description: "foreground isolation",
        parentSession: {
          parentSessionFile: ctx.sessionManager.getSessionFile(),
          parentSessionId: ctx.sessionManager.getSessionId(),
        },
      },
    );

    expect(Object.keys(record.execution).sort()).toEqual([
      "baseCwd",
      "baseline",
      "graceTurns",
      "isBackground",
      "maxTurns",
      "model",
      "parentSession",
      "task",
      "thinkingLevel",
    ]);
    expect(containsReference(record.execution, PARENT_SENTINELS)).toBe(false);
    assertChildConstructionIsClean(harness.constructions[0]!);
    expect(containsReference(toSubagentRecord(record), PARENT_SENTINELS)).toBe(false);
    await harness.manager.dispose();
  });

  it("keeps a delayed descriptor value-only, then reconstructs providers and flushes steering after FIFO admission", async () => {
    const harness = createHarness(1);
    const firstGate = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- valid settlement gate
    harness.blockPromptUntil(firstGate.promise);
    const first = harness.manager.spawn(
      { cwd: "/repo", model: { provider: harness.model.provider, id: harness.model.id } },
      "worker",
      "first child",
      { description: "first", isBackground: true },
    );
    await vi.waitFor(() => expect(harness.constructions).toHaveLength(1));

    const queued = harness.manager.spawn(
      { cwd: "/repo", model: { provider: harness.model.provider, id: harness.model.id } },
      "worker",
      CHILD_TASK,
      {
        description: "queued isolation",
        isBackground: true,
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-lineage-id",
        },
      },
    );
    const queuedRecord = harness.manager.getRecord(queued)!;
    expect(queuedRecord.status).toBe("queued");
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(containsReference(queuedRecord.execution, PARENT_SENTINELS)).toBe(false);
    expect(await queuedRecord.steer("Use the release branch.")).toEqual({ kind: "buffered" });

    firstGate.resolve();
    await harness.manager.getRecord(first)!.promise;
    await queuedRecord.promise;
    expect(harness.constructions).toHaveLength(2);
    assertChildConstructionIsClean(harness.constructions[1]!);
    expect(harness.constructions[1]!.session.steer).toHaveBeenCalledWith("Use the release branch.");
    await harness.manager.dispose();
  });

  it("isolates service spawning, workspace context, records, persistence, release and resume", async () => {
    const harness = createHarness();
    const ctx = parentContext(harness);
    const workspaceCwds = ["/workspace/child-1", "/workspace/child-2"];
    const workspaceProvider = {
      prepare: vi.fn(async (workspaceCtx) => ({ cwd: workspaceCwds.shift()!, dispose: vi.fn() })),
    };
    harness.manager.registerWorkspaceProvider(workspaceProvider);
    const runtime = {
      currentCtx: ctx,
      buildChildBaseline: () => ({
        cwd: ctx.cwd,
        model: { provider: harness.model.provider, id: harness.model.id },
      }),
      getModelInfo: () => ({
        parentModel: harness.model,
        modelRegistry: harness.modelRegistry,
      }),
      getSessionInfo: () => ({
        parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
        parentSessionId: ctx.sessionManager.getSessionId(),
      }),
    };
    const registry = new AgentTypeRegistry(
      () =>
        new Map([
          [
            "worker",
            {
              name: "worker",
              description: "worker",
              systemPrompt: "STATIC_CHILD_INSTRUCTIONS",
              promptMode: "replace" as const,
              mode: "subagent" as const,
            },
          ],
        ]),
    );
    const service = new SubagentsServiceAdapter(harness.manager, runtime, { registry });
    const id = service.spawn({ type: "worker", task: CHILD_TASK });
    const record = harness.manager.getRecord(id)!;
    await record.promise;

    expect(workspaceProvider.prepare).toHaveBeenCalledWith({
      agentId: id,
      agentType: "worker",
      baseCwd: "/repo",
      invocation: {
        stack: "default",
        modelName: "test-provider/test-model",
        thinking: undefined,
        maxTurns: undefined,
        graceTurns: undefined,
        runInBackground: true,
      },
    });
    assertChildConstructionIsClean(harness.constructions[0]!);
    expect(harness.constructions[0]!.params.cwd).toBe("/workspace/child-1");
    expect(harness.constructions[0]!.sessionManager.newSession).toHaveBeenCalledWith({
      parentSession: "parent-lineage-id",
    });
    expect(containsReference(service.inspect(id), PARENT_SENTINELS)).toBe(false);

    const transcript = record.outputFile!;
    await record.releaseSession();
    await service.resume({ id, task: "Resume using only the child transcript." });
    expect(harness.constructions[1]!.params.resumeTranscriptPath).toBe(transcript);
    expect(harness.constructions[1]!.params.cwd).toBe("/workspace/child-2");
    expect(workspaceProvider.prepare).toHaveBeenCalledTimes(2);
    expect(containsReference(workspaceProvider.prepare.mock.calls, PARENT_SENTINELS)).toBe(false);
    expect(harness.constructions[1]!.session.prompt).toHaveBeenCalledWith(
      "Resume using only the child transcript.",
    );
    expect(containsReference(service.inspect(id), PARENT_SENTINELS)).toBe(false);
    await harness.manager.dispose();
  });
});
