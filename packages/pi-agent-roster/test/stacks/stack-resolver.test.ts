import { describe, expect, it } from "vitest";
import { AgentStackOverrides, resolveAgentStack } from "../../src/stacks/stack-resolver.ts";
import type { AgentConfig, AgentStackProfile } from "../../src/types.ts";
import { makeModel } from "../helpers/make-model.ts";

const models = [
  makeModel({ provider: "anthropic", id: "runtime", reasoning: true }),
  makeModel({ provider: "anthropic", id: "fast", reasoning: false }),
  makeModel({
    provider: "anthropic",
    id: "deep",
    reasoning: true,
    thinkingLevelMap: { xhigh: null, max: null },
  }),
];
const registry = {
  find: (provider: string, id: string) =>
    models.find((model) => model.provider === provider && model.id === id),
  getAll: () => models,
  getAvailable: () => models,
};

function agent(stacks: [string, AgentStackProfile][] = []): AgentConfig {
  return {
    id: "reviewer",
    name: "Reviewer",
    description: "Review",
    systemPrompt: "Review.",
    promptMode: "replace",
    model: "anthropic/runtime",
    thinking: "medium",
    defaultStack: "deep",
    stacks: new Map(stacks),
  };
}

describe("resolveAgentStack", () => {
  it("uses explicit, session, configured default, then synthetic default precedence", () => {
    const config = agent([
      ["fast", { model: "anthropic/fast", thinking: "low" }],
      ["deep", { model: "anthropic/deep", thinking: "high" }],
    ]);
    expect(
      resolveAgentStack({
        agent: config,
        registry,
        explicitStack: "FAST",
        sessionOverride: "deep",
      }),
    ).toMatchObject({ ok: true, value: { stack: "fast", modelName: "anthropic/fast" } });
    expect(resolveAgentStack({ agent: config, registry, sessionOverride: "fast" })).toMatchObject({
      ok: true,
      value: { stack: "fast" },
    });
    expect(resolveAgentStack({ agent: config, registry })).toMatchObject({
      ok: true,
      value: { stack: "deep" },
    });
    expect(
      resolveAgentStack({ agent: { ...config, defaultStack: undefined }, registry }),
    ).toMatchObject({
      ok: true,
      value: { stack: "default", modelName: "anthropic/runtime", thinking: "medium" },
    });
  });

  it("inherits named thinking and overlays legacy fields independently", () => {
    const config = agent([["fast", { model: "anthropic/fast" }]]);
    const inherited = resolveAgentStack({ agent: config, registry, explicitStack: "fast" });
    expect(inherited).toMatchObject({ ok: true, value: { modelName: "anthropic/fast" } });
    if (inherited.ok) expect(inherited.value.thinking).toBeUndefined();
    expect(
      resolveAgentStack({
        agent: config,
        registry,
        explicitStack: "fast",
        model: "anthropic/deep",
        thinking: "high",
      }),
    ).toMatchObject({ ok: true, value: { modelName: "anthropic/deep", thinking: "high" } });
  });

  it("fails an unknown explicit stack but represents stale override fallback", () => {
    const config = agent([["deep", { model: "anthropic/deep" }]]);
    expect(resolveAgentStack({ agent: config, registry, explicitStack: "other" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Available stacks"),
    });
    expect(
      resolveAgentStack({ agent: config, registry, sessionOverride: "removed" }),
    ).toMatchObject({
      ok: true,
      value: {
        stack: "deep",
        notice: { kind: "stale-session-override", requested: "removed", selected: "deep" },
      },
    });
  });

  it("requires the selected model to be available and authenticated", () => {
    const config = agent([["missing", { model: "openai/missing" }]]);
    const result = resolveAgentStack({ agent: config, registry, explicitStack: "missing" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Model not found") });
  });

  it("keeps session overrides local to stable agent identities", () => {
    const overrides = new AgentStackOverrides();
    const reviewer = agent();
    const other = { ...agent(), id: "other", name: "Other" };
    overrides.set(reviewer, "deep");
    expect(overrides.get({ ...reviewer, name: "REVIEWER" })).toBe("deep");
    expect(overrides.get(other)).toBeUndefined();
    overrides.reset();
    expect(overrides.get(reviewer)).toBeUndefined();
  });
});
