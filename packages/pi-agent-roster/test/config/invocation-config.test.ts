import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "../../src/config/invocation-config.ts";
import type { AgentConfig } from "../../src/types.ts";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    systemPrompt: "Test agent",
    promptMode: "replace",
    runInBackground: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("applies legacy one-off model/thinking overlays and invocation budgets", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        maxTurns: 42,
        graceTurns: 8,
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
        max_turns: 1,
        grace_turns: 0,
        run_in_background: true,
      },
    );

    expect(resolved).toMatchObject({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
      maxTurns: 1,
      graceTurns: 0,
      runInBackground: false,
    });
    expect(resolved).not.toHaveProperty("inheritContext");
  });

  it("uses invocation fields when the agent leaves them open", () => {
    expect(
      resolveAgentInvocationConfig(undefined, {
        model: "provider/param-model",
        thinking: "minimal",
        stack: " fast ",
        max_turns: 3,
        grace_turns: 2,
        run_in_background: true,
      }),
    ).toEqual({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
      stack: "fast",
      maxTurns: 3,
      graceTurns: 2,
      runInBackground: true,
    });
  });

  it("defaults background mode to false and omits a blank stack", () => {
    const resolved = resolveAgentInvocationConfig(undefined, { stack: " " });
    expect(resolved.runInBackground).toBe(false);
    expect(resolved).not.toHaveProperty("stack");
  });

  it("rejects a non-string stack instead of silently dropping it", () => {
    expect(() =>
      resolveAgentInvocationConfig(undefined, {
        stack: { model: "provider/model" },
      } as never),
    ).toThrow("stack must be a string");
  });
});
