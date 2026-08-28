import type { CreateSubagentSessionParams } from "../../src/lifecycle/create-subagent-session.ts";
import {
  type AdmittedSubagentRuntime,
  Subagent,
  type SubagentExecution,
} from "../../src/lifecycle/subagent.ts";
import type { SubagentSession } from "../../src/lifecycle/subagent-session.ts";
import { SubagentState, type SubagentStatus } from "../../src/lifecycle/subagent-state.ts";
import type { AgentInvocation, SubagentType } from "../../src/types.ts";
import { createSubagentSessionStub, toSubagentSession } from "./mock-session.ts";
import { STUB_SNAPSHOT } from "./stub-ctx.ts";

export function makeStubExecution(overrides: Partial<SubagentExecution> = {}): SubagentExecution {
  return {
    baseline: STUB_SNAPSHOT,
    task: "do something",
    baseCwd: "",
    isBackground: false,
    ...overrides,
  };
}

export function makeStubRuntime(
  overrides: Partial<AdmittedSubagentRuntime> = {},
): AdmittedSubagentRuntime {
  return {
    createSubagentSession: async (_params: CreateSubagentSessionParams): Promise<SubagentSession> =>
      toSubagentSession(createSubagentSessionStub()),
    modelRegistry: { find: () => undefined, getAll: () => [] },
    ...overrides,
  };
}

export interface TestSubagentOptions {
  id?: string;
  type?: SubagentType;
  description?: string;
  invocation?: AgentInvocation;
  execution?: SubagentExecution;
  runtime?: AdmittedSubagentRuntime;
  toolCallId?: string;
  status?: SubagentStatus;
  result?: string | undefined;
  error?: string | undefined;
  stoppedWhileQueued?: boolean;
  startedAt?: number;
  completedAt?: number | undefined;
  consumedAt?: number;
  toolUses?: number;
  lifetimeUsage?: { input: number; output: number; cacheWrite: number };
  compactionCount?: number;
  turnCount?: number;
  activeTools?: string[];
  responseText?: string;
  maxTurns?: number;
  graceTurns?: number;
}

export function createTestSubagent(overrides: TestSubagentOptions = {}): Subagent {
  const {
    id,
    type,
    description,
    invocation,
    execution,
    runtime,
    toolCallId,
    toolUses,
    lifetimeUsage,
    compactionCount,
    turnCount,
    activeTools,
    responseText,
    maxTurns,
    graceTurns,
    ...stateOverrides
  } = overrides;
  const state = new SubagentState({
    status: "completed",
    result: "All done.",
    startedAt: 1000,
    completedAt: 2000,
    toolUses: toolUses ?? 3,
    lifetimeUsage: lifetimeUsage ?? { input: 500, output: 500, cacheWrite: 0 },
    ...(compactionCount !== undefined ? { compactionCount } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(activeTools !== undefined ? { activeTools } : {}),
    ...(responseText !== undefined ? { responseText } : {}),
    ...stateOverrides,
  });
  const record = new Subagent({
    id: id ?? "agent-1",
    type: type ?? "general-purpose",
    description: description ?? "Test task",
    invocation,
    execution:
      execution ??
      makeStubExecution({
        ...(toolCallId ? { parentSession: { toolCallId } } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(graceTurns !== undefined ? { graceTurns } : {}),
      }),
    state,
  });
  record.admit(runtime ?? makeStubRuntime());
  return record;
}
