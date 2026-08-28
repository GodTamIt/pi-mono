import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../../src/session/prompts.ts";
import type { AgentPromptConfig } from "../../src/types.ts";

const env = { isGitRepo: true, branch: "main", platform: "linux" };

function config(overrides: Partial<AgentPromptConfig> = {}): AgentPromptConfig {
  return {
    name: "reviewer",
    promptMode: "replace",
    systemPrompt: "Review only the requested files.",
    ...overrides,
  };
}

describe("buildAgentPrompt", () => {
  it("assembles an isolated replace prompt in deterministic order", () => {
    const prompt = buildAgentPrompt(config(), "/workspace", env);
    const parts = [
      "isolated child session",
      '<active_agent name="reviewer"/>',
      "# Environment",
      "Working directory: /workspace",
      "Review only the requested files.",
    ];
    for (const part of parts) expect(prompt).toContain(part);
    expect(parts.map((part) => prompt.indexOf(part))).toEqual(
      [...parts].map((part) => prompt.indexOf(part)).sort((a, b) => a - b),
    );
    expect(prompt).not.toContain("PARENT_SYSTEM_SENTINEL");
  });

  it("adds child tool guidance and wraps static instructions in append mode", () => {
    const prompt = buildAgentPrompt(config({ promptMode: "append" }), "/workspace", env);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("Use the read tool instead of cat/head/tail");
    expect(prompt).toContain("<agent_instructions>\nReview only the requested files.");
  });

  it("reports a non-git child environment without inventing a branch", () => {
    const prompt = buildAgentPrompt(config({ systemPrompt: "" }), "/tmp/child", {
      isGitRepo: false,
      branch: "PARENT_BRANCH_SENTINEL",
      platform: "darwin",
    });
    expect(prompt).toContain("Not a git repository");
    expect(prompt).toContain("Platform: darwin");
    expect(prompt).not.toContain("PARENT_BRANCH_SENTINEL");
  });
});
