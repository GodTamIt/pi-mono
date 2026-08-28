import { describe, expect, it } from "vitest";
import { createSubagentRuntime, SubagentRuntime } from "../src/runtime.ts";
import type { SessionContext } from "../src/types.ts";
import { makeModel } from "./helpers/make-model.ts";

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    cwd: "/test/cwd",
    model: undefined,
    modelRegistry: { find: () => undefined, getAll: () => [] },
    sessionManager: {
      getSessionFile: () => "/sessions/test.jsonl",
      getSessionId: () => "test-session-id",
    },
    ...overrides,
  };
}

describe("SubagentRuntime", () => {
  it("creates an empty runtime", () => {
    const runtime = createSubagentRuntime();
    expect(runtime).toBeInstanceOf(SubagentRuntime);
    expect(runtime.currentCtx).toBeUndefined();
  });

  it("stores and clears the active Pi session context", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
    runtime.clearSessionContext();
    expect(runtime.currentCtx).toBeUndefined();
  });

  it("returns model registry and model without retaining other context fields", () => {
    const runtime = createSubagentRuntime();
    const registry = { find: () => undefined, getAll: () => [], getAvailable: () => [] };
    const model = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    runtime.setSessionContext(makeSessionCtx({ model, modelRegistry: registry }));
    expect(runtime.getModelInfo()).toEqual({ parentModel: model, modelRegistry: registry });
  });

  it("returns persisted and ephemeral parent lineage", () => {
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx());
    expect(runtime.getSessionInfo()).toEqual({
      parentSessionFile: "/sessions/test.jsonl",
      parentSessionId: "test-session-id",
    });

    runtime.setSessionContext(
      makeSessionCtx({
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => "ephemeral",
        },
      }),
    );
    expect(runtime.getSessionInfo()).toEqual({
      parentSessionFile: "",
      parentSessionId: "ephemeral",
    });
  });
});
