import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types.ts";
import { resolveSpawnConfig } from "../../src/tools/spawn-config.ts";
import type { AgentConfig } from "../../src/types.ts";
import { makeModel } from "../helpers/make-model.ts";
import { TEST_AGENTS } from "../helpers/test-agents.ts";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    toolNames: ["read", "grep"],
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    runInBackground: false,
    ...overrides,
  };
}

/** Registry with a single disabled Architect override. */
function makeDisabledArchitectRegistry(): AgentTypeRegistry {
  return new AgentTypeRegistry(
    () =>
      new Map([
        [
          "Architect",
          makeAgentConfig({ name: "Architect", description: "Disabled", enabled: false }),
        ],
      ]),
  );
}

/** Minimal registry with default agents only. */
const testRegistry = new AgentTypeRegistry(() => TEST_AGENTS);

/** Shorthand for building ModelInfo. */
function makeModelInfo(overrides: Partial<Parameters<typeof resolveSpawnConfig>[2]> = {}) {
  return {
    parentModel: makeModel({ id: "claude-sonnet", name: "Claude Sonnet" }),
    modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
    ...overrides,
  };
}

const defaultSettings = { defaultMaxTurns: undefined as number | undefined };

describe("resolveSpawnConfig — type resolution", () => {
  it("resolves a known agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) return;
    expect(result.identity.subagentType).toBe("general-purpose");
    expect(result.identity.fellBack).toBe(false);
  });

  it("falls back to general-purpose for unknown agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "unknown-type", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) return;
    expect(result.identity.subagentType).toBe("general-purpose");
    expect(result.identity.fellBack).toBe(true);
  });

  it("sets displayName from registry", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.identity.displayName).toBe("Explore");
  });

  it("returns an error for a disabled agent type (exact match)", () => {
    const registry = makeDisabledArchitectRegistry();
    const result = resolveSpawnConfig(
      { subagent_type: "Architect", task: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe('Agent type "Architect" is disabled');
    }
  });

  it("reports the canonical casing in the disabled-agent error (case-insensitive input)", () => {
    const registry = makeDisabledArchitectRegistry();
    const result = resolveSpawnConfig(
      { subagent_type: "architect", task: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe('Agent type "Architect" is disabled');
    }
  });

  it("uses displayName from agent config when available", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // general-purpose config has displayName: "Agent"
    expect(result.identity.displayName).toBe("Agent");
  });
});

describe("resolveSpawnConfig — model resolution", () => {
  it("inherits parent model when no model specified", () => {
    const parentModel = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d" },
      testRegistry,
      makeModelInfo({ parentModel }),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.model).toBe(parentModel);
    // modelName is undefined when same as parent
    expect(result.presentation.modelName).toBeUndefined();
  });

  it("returns error when user-specified model cannot be resolved", () => {
    const result = resolveSpawnConfig(
      {
        subagent_type: "general-purpose",
        task: "test",
        description: "d",
        model: "nonexistent-xyz",
      },
      testRegistry,
      makeModelInfo({
        modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
      }),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeTruthy();
  });
});

describe("resolveSpawnConfig — max turns normalization", () => {
  it("normalizes max_turns from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d", max_turns: 10 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(10);
  });

  it("uses settings defaultMaxTurns when no max_turns in params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      { defaultMaxTurns: 25 },
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(25);
  });

  it("returns undefined effectiveMaxTurns when neither params nor settings specify", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBeUndefined();
  });
});

describe("resolveSpawnConfig — invocation fields", () => {
  it("sets runInBackground from params", () => {
    const result = resolveSpawnConfig(
      {
        subagent_type: "general-purpose",
        task: "test",
        description: "d",
        run_in_background: true,
      },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.runInBackground).toBe(true);
  });

  it("builds agentInvocation snapshot", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d", thinking: "high" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.agentInvocation).toEqual({
      modelName: undefined,
      thinking: "high",
      stack: undefined,
      maxTurns: undefined,
      graceTurns: undefined,
      runInBackground: false,
    });
  });
});

describe("resolveSpawnConfig — detailBase and tags", () => {
  it("builds detailBase with description from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "my task" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.presentation.detailBase.description).toBe("my task");
    expect(result.presentation.detailBase.subagentType).toBe("general-purpose");
    expect(result.presentation.detailBase.displayName).toBe("Agent");
  });

  it("includes thinking tag when thinking is set", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d", thinking: "high" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.presentation.agentTags).toContain("thinking: high");
  });

  it("omits mode label for replace-mode agents", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.presentation.agentTags).toEqual([
      "max turns: unlimited",
      "grace turns: unlimited",
    ]);
  });

  it("includes twin tag for append-mode agents like general-purpose", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // general-purpose has promptMode: "append" → gets "twin" label
    expect(result.presentation.agentTags).toContain("twin");
  });

  it("shows unlimited budgets on replace-mode detail", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", task: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.presentation.detailBase.tags).toEqual([
      "max turns: unlimited",
      "grace turns: unlimited",
    ]);
  });
});

describe("resolveSpawnConfig — task and rawType passthrough", () => {
  it("passes through task and rawType", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", task: "search for bugs", description: "bug search" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.task).toBe("search for bugs");
    expect(result.identity.rawType).toBe("Explore");
  });
});
