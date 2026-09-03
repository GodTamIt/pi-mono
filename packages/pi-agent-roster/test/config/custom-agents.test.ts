import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomAgentDiagnosticReporter, loadCustomAgents } from "../../src/config/custom-agents.ts";

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not created`);
  return value;
}

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, content: string) {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  it("returns empty map when .pi/agents/ does not exist", () => {
    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads permission and context_files fields", () => {
    writeAgent(
      "auditor",
      `---
description: Security Auditor
permission:
  "*": deny
  read: allow
  audit_tool: allow
context_files: false
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
prompt_mode: replace
run_in_background: true
---

You are a security auditor.`,
    );

    const agent = requireDefined(loadCustomAgents(tmpDir).get("auditor"), "auditor agent");
    expect(agent.permission).toEqual({ "*": "deny", read: "allow", audit_tool: "allow" });
    expect(agent.contextFiles).toBe(false);
    expect(agent.promptMode).toBe("replace");
    expect(agent.systemPrompt).toBe("You are a security auditor.");
  });

  it("accepts an exact extension tool name outside the old built-in-name pattern", () => {
    writeAgent("extension", "---\npermission:\n  plugin.tool: allow\n---\nExtension.");
    expect(loadCustomAgents(tmpDir).get("extension")?.permission).toEqual({
      "plugin.tool": "allow",
    });
  });

  it("defaults to append, all tools allowed, and child context discovery enabled", () => {
    writeAgent("bare", "Just a system prompt, no frontmatter.");
    const agent = requireDefined(loadCustomAgents(tmpDir).get("bare"), "bare agent");
    expect(agent.mode).toBe("subagent");
    expect(agent.permission).toBeUndefined();
    expect(agent.contextFiles).toBe(true);
    expect(agent.promptMode).toBe("append");
  });

  it("rejects the removed tools field with an unsupported-field diagnostic", () => {
    writeAgent("legacy", "---\ntools: [read]\n---\nLegacy.");
    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.has("legacy")).toBe(false);
    expect(diagnostics).toContainEqual(expect.stringContaining("tools is unsupported"));
  });

  it("does not write to stderr when the production-style callback consumes diagnostics", () => {
    writeAgent("legacy", "---\ntools: [read]\n---\nLegacy.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    loadCustomAgents(tmpDir, () => undefined);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("buffers and de-duplicates diagnostics for each session UI", () => {
    const reporter = new CustomAgentDiagnosticReporter();
    const diagnostic = {
      path: "/tmp/agent.md",
      message: "npm WARN \u001b[31mbroken\u001b[0m\rretry",
      source: "project" as const,
    };
    const firstNotify = vi.fn();
    reporter.reportScan([diagnostic, diagnostic]);
    reporter.beginSession({ notify: firstNotify });
    reporter.reportScan([diagnostic]);
    reporter.reportScan([diagnostic]);

    expect(firstNotify).toHaveBeenCalledOnce();
    for (const control of ["\u001b", "\r", "\b", "\u009b"]) {
      expect(firstNotify.mock.calls[0]?.[0]).not.toContain(control);
    }

    const recreatedNotify = vi.fn();
    reporter.beginSession({ notify: recreatedNotify });
    expect(recreatedNotify).toHaveBeenCalledOnce();
  });

  it.each([
    ["nested", "permission:\n  bash:\n    command: allow", "exactly"],
    ["ask", "permission:\n  bash: ask", "allow"],
    ["array", "permission: [read, deny]", "flat mapping"],
    ["glob", "permission:\n  ba*: deny", "exact tool name"],
    ["path", "permission:\n  src/file: deny", "exact tool name"],
  ])("rejects malformed permission form %s", (_name, yaml, expected) => {
    writeAgent(String(_name), `---\n${yaml}\n---\nInvalid.`);
    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.has(String(_name))).toBe(false);
    expect(diagnostics.join("\n")).toContain(expected);
  });

  it("isolates malformed YAML without changing the default mode of valid files", () => {
    writeAgent("broken", "---\nstacks: [unterminated\n---\nBroken prompt.");
    writeAgent("worker", "A valid child prompt.");
    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.has("broken")).toBe(false);
    expect(result.get("worker")?.mode).toBe("subagent");
    expect(diagnostics).toHaveLength(1);
  });

  it("isolates an unsupported thinking level", () => {
    writeAgent("valid", "Valid agent.");
    writeAgent("anythink", "---\nthinking: turbo\n---\n\nAny thinking.");

    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.has("anythink")).toBe(false);
    expect(result.has("valid")).toBe(true);
    expect(diagnostics).toContainEqual(expect.stringContaining("supported thinking level"));
  });

  it("normalizes legacy max_turns: 0 to unlimited", () => {
    writeAgent(
      "unlimited",
      `---
max_turns: 0
---

Unlimited turns.`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(requireDefined(result.get("unlimited"), "unlimited agent").maxTurns).toBeUndefined();
  });

  it("rejects negative max_turns", () => {
    writeAgent(
      "negturns",
      `---
max_turns: -5
---

Negative turns.`,
    );

    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.has("negturns")).toBe(false);
    expect(diagnostics).toContainEqual(expect.stringContaining("max_turns"));
  });

  it("handles prompt_mode: append", () => {
    writeAgent(
      "appender",
      `---
prompt_mode: append
---

Extra instructions.`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(requireDefined(result.get("appender"), "appender agent").promptMode).toBe("append");
  });

  it("rejects an unknown prompt_mode", () => {
    writeAgent("badmode", "---\nprompt_mode: merge\n---\n\nUnknown mode.");

    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.has("badmode")).toBe(false);
    expect(diagnostics).toContainEqual(expect.stringContaining("replace or append"));
  });

  it("loads multiple agents", () => {
    writeAgent(
      "agent1",
      `---
description: First
---

First agent.`,
    );
    writeAgent(
      "agent2",
      `---
description: Second
---

Second agent.`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(2);
    expect(result.has("agent1")).toBe(true);
    expect(result.has("agent2")).toBe(true);
  });

  it("skips non-.md files", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    writeFileSync(
      join(dir, "real.md"),
      `---
description: Real Agent
---

Real.`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("real")).toBe(true);
  });

  it("allows agents with names matching defaults (overrides them)", () => {
    writeAgent(
      "Explore",
      `---
description: Custom Explore
---

Custom explore agent.`,
    );
    writeAgent(
      "custom",
      `---
description: Custom Agent
---

Should be loaded.`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(result.has("explore")).toBe(true);
    expect(requireDefined(result.get("explore"), "explore agent").description).toBe(
      "Custom Explore",
    );
    expect(result.has("custom")).toBe(true);
  });

  it("handles empty body with frontmatter", () => {
    writeAgent(
      "nobody",
      `---
description: No body
permission:
  read: allow
---
`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(requireDefined(result.get("nobody"), "nobody agent").systemPrompt).toBe("");
  });

  it("handles enabled: false frontmatter", () => {
    writeAgent(
      "disabled",
      `---
enabled: false
---
`,
    );

    const result = loadCustomAgents(tmpDir);
    const agent = requireDefined(result.get("disabled"), "disabled agent");
    expect(agent.enabled).toBe(false);
  });

  it("parses display_name frontmatter", () => {
    writeAgent(
      "myagent",
      `---
description: My Agent
display_name: MyAgent
---

Agent prompt.`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(requireDefined(result.get("myagent"), "myagent agent").displayName).toBe("MyAgent");
  });

  it("uses a stable case-insensitive identity when a project file overrides global", () => {
    const globalDir = join(tmpDir, ".pi", "agent", "agents");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(`${globalDir}/Reviewer.md`, "---\ndescription: Global\n---\nGlobal.");
    writeAgent("reviewer", "---\ndescription: Project\n---\nProject.");

    const result = loadCustomAgents(tmpDir);
    expect([...result.keys()]).toEqual(["reviewer"]);
    expect(result.get("reviewer")).toMatchObject({
      id: "reviewer",
      name: "reviewer",
      description: "Project",
      source: "project",
    });
  });

  it("does not resurrect a global definition behind an invalid project override", () => {
    const globalDir = join(tmpDir, ".pi", "agent", "agents");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(`${globalDir}/reviewer.md`, "Global.");
    writeAgent("REVIEWER", "---\nmode: invalid\n---\nProject.");

    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.has("reviewer")).toBe(false);
    expect(diagnostics).toContainEqual(expect.stringContaining("mode must be"));
  });

  it("parses modes, delegation, stacks, and independent budgets", () => {
    writeAgent(
      "reviewer",
      `---
mode: all
allowed_agents: [tests, explore]
default_stack: BALANCED
stacks:
  fast:
    model: anthropic/haiku
  balanced:
    model: anthropic/sonnet
    thinking: high
max_turns: 25
grace_turns: 3
---
Review.`,
    );

    const agent = requireDefined(
      loadCustomAgents(tmpDir, () => {}).get("reviewer"),
      "reviewer agent",
    );
    expect(agent.mode).toBe("all");
    expect(agent.allowedAgents).toEqual(["tests", "explore"]);
    expect(agent.defaultStack).toBe("balanced");
    expect(agent.stacks?.get("fast")).toEqual({ model: "anthropic/haiku" });
    expect(agent.maxTurns).toBe(25);
    expect(agent.graceTurns).toBe(3);
  });

  it("accepts default as either the synthetic fallback or a named stack", () => {
    writeAgent("fallback", "---\ndefault_stack: default\n---\nReview.");
    writeAgent(
      "named",
      "---\nstacks:\n  default:\n    model: anthropic/sonnet\n    thinking: high\n---\nReview.",
    );

    const agents = loadCustomAgents(tmpDir, () => {});
    expect(agents.get("fallback")?.defaultStack).toBe("default");
    expect(agents.get("named")?.stacks?.get("default")).toEqual({
      model: "anthropic/sonnet",
      thinking: "high",
    });
  });

  it.each(["inherit_context", "model_stacks"])("rejects unsupported %s per file", (field) => {
    writeAgent("bad", `---\n${field}: true\n---\nBad.`);
    writeAgent("good", "Good.");
    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.has("bad")).toBe(false);
    expect(result.has("good")).toBe(true);
    expect(diagnostics).toContainEqual(expect.stringContaining(`${field} is unsupported`));
  });

  it("rejects colliding, malformed, empty, and unknown default stacks", () => {
    const cases = {
      collision: "stacks:\n  Fast:\n    model: a/b\n  fast:\n    model: c/d",
      malformed: "stacks:\n  fast:\n    model: sonnet",
      empty: 'default_stack: ""',
      unknown: "default_stack: missing\nstacks:\n  fast:\n    model: a/b",
    };
    for (const [name, yaml] of Object.entries(cases)) writeAgent(name, `---\n${yaml}\n---\nBad.`);
    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.size).toBe(0);
    expect(diagnostics).toHaveLength(4);
  });

  it("honors PI_CODING_AGENT_DIR for global custom agent discovery", () => {
    const altAgentDir = mkdtempSync(join(tmpdir(), "pi-alt-agent-"));
    const originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = altAgentDir;
    try {
      const globalAgentsDir = join(altAgentDir, "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "via-env.md"),
        "---\ndescription: Discovered via env var\n---\n\nTest body.",
      );

      const result = loadCustomAgents(tmpDir);

      // Agent is found at $PI_CODING_AGENT_DIR/agents, not at $HOME/.pi/agent/agents
      expect(result.has("via-env")).toBe(true);
      expect(requireDefined(result.get("via-env"), "via-env agent").description).toBe(
        "Discovered via env var",
      );
    } finally {
      if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalEnv;
      rmSync(altAgentDir, { recursive: true, force: true });
    }
  });
});
