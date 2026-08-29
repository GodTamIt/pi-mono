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
  it("keeps the isolated runtime baseline around the profile body in replace mode", () => {
    const prompt = buildAgentPrompt(config(), "/workspace", env, ["read"]);
    expect(prompt).toContain("isolated child session");
    expect(prompt).toContain("Use the read tool instead of cat/head/tail");
    expect(prompt).toContain('<active_agent name="reviewer"/>');
    expect(prompt).toContain("Working directory: /workspace");
    expect(prompt).toContain("<agent_instructions>\nReview only the requested files.");
  });

  it("assembles the isolated baseline, enabled-tool guidance, metadata, and wrapped body in append mode", () => {
    const prompt = buildAgentPrompt(config({ promptMode: "append" }), "/workspace", env, [
      "read",
      "grep",
    ]);
    expect(prompt).toContain("isolated child session");
    expect(prompt).toContain("Use the read tool instead of cat/head/tail");
    expect(prompt).toContain("Use the grep tool instead of shell content search");
    expect(prompt).not.toContain("Use the edit tool");
    expect(prompt).toContain('<active_agent name="reviewer"/>');
    expect(prompt).toContain("Working directory: /workspace");
    expect(prompt).toContain("<agent_instructions>\nReview only the requested files.");
  });

  it("omits guidance for every disabled file tool", () => {
    const prompt = buildAgentPrompt(config({ promptMode: "append" }), "/workspace", env, ["bash"]);
    for (const name of ["read", "edit", "write", "find", "grep"]) {
      expect(prompt).not.toContain(`Use the ${name} tool`);
    }
  });

  it("reports a non-git append environment without inventing a branch", () => {
    const prompt = buildAgentPrompt(
      config({ promptMode: "append", systemPrompt: "" }),
      "/tmp/child",
      { isGitRepo: false, branch: "PARENT_BRANCH_SENTINEL", platform: "darwin" },
      [],
    );
    expect(prompt).toContain("Not a git repository");
    expect(prompt).toContain("Platform: darwin");
    expect(prompt).not.toContain("PARENT_BRANCH_SENTINEL");
  });
});
