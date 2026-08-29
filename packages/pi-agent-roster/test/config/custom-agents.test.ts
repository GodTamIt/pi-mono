import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../../src/config/agent-types.ts";
import { loadCustomAgents } from "../../src/config/custom-agents.ts";

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

  it("loads a basic agent with all frontmatter fields", () => {
    writeAgent(
      "auditor",
      `---
description: Security Auditor
tools: read, grep, find
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
prompt_mode: replace
run_in_background: true
---

You are a security auditor.`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);

    const agent = result.get("auditor")!;
    expect(agent.name).toBe("auditor");
    expect(agent.description).toBe("Security Auditor");
    expect(agent.toolNames).toEqual(["read", "grep", "find"]);
    expect(agent.model).toBe("anthropic/claude-opus-4-6");
    expect(agent.thinking).toBe("high");
    expect(agent.maxTurns).toBe(30);
    expect(agent.promptMode).toBe("replace");
    expect(agent).not.toHaveProperty("inheritContext");
    expect(agent.runInBackground).toBe(true);
    expect(agent.systemPrompt).toBe("You are a security auditor.");
  });

  it("uses sensible defaults when frontmatter is empty", () => {
    writeAgent(
      "minimal",
      `---
---

Just a prompt.`,
    );

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("minimal")!;

    expect(agent.name).toBe("minimal");
    expect(agent.description).toBe("minimal"); // defaults to filename
    expect(agent.toolNames).toEqual(BUILTIN_TOOL_NAMES); // all tools
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.promptMode).toBe("append");
    expect(agent).not.toHaveProperty("inheritContext");
    expect(agent.runInBackground).toBeUndefined();
    expect(agent.systemPrompt).toBe("Just a prompt.");
  });

  it("uses sensible defaults when no frontmatter at all", () => {
    writeAgent("bare", "Just a system prompt, no frontmatter.");

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("bare")!;

    expect(agent.name).toBe("bare");
    expect(agent.description).toBe("bare");
    expect(agent.mode).toBe("subagent");
    expect(agent.toolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.promptMode).toBe("append");
    expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
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

  it("handles tools: none → empty array", () => {
    writeAgent(
      "notool",
      `---
tools: none
---

No tools.`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(result.get("notool")!.toolNames).toEqual([]);
  });

  it("passes through unknown tool names (not filtered)", () => {
    writeAgent(
      "custom-tools",
      `---
tools: read, my_custom_tool, grep
---

Custom tools.`,
    );

    const result = loadCustomAgents(tmpDir);
    // An extension-registered tool name is a supported `tools:` entry: the child's
    // allowlist admits it when the extension registers it during bind (#725).
    expect(result.get("custom-tools")!.toolNames).toEqual(["read", "my_custom_tool", "grep"]);
  });

  describe("tools field forms", () => {
    it("accepts a YAML block sequence", () => {
      writeAgent(
        "block-seq",
        `---
tools:
  - read
  - my_custom_tool
  - grep
---

Block sequence.`,
      );

      const result = loadCustomAgents(tmpDir);
      expect(result.get("block-seq")!.toolNames).toEqual(["read", "my_custom_tool", "grep"]);
    });

    it("accepts a YAML flow sequence", () => {
      writeAgent(
        "flow-seq",
        `---
tools: [read, grep]
---

Flow sequence.`,
      );

      const result = loadCustomAgents(tmpDir);
      expect(result.get("flow-seq")!.toolNames).toEqual(["read", "grep"]);
    });

    it("treats a single-element none sequence as no tools", () => {
      writeAgent(
        "seq-none",
        `---
tools: [none]
---

No tools.`,
      );

      const result = loadCustomAgents(tmpDir);
      expect(result.get("seq-none")!.toolNames).toEqual([]);
    });

    it("treats an empty sequence as no tools", () => {
      writeAgent(
        "seq-empty",
        `---
tools: []
---

No tools.`,
      );

      const result = loadCustomAgents(tmpDir);
      expect(result.get("seq-empty")!.toolNames).toEqual([]);
    });

    it("keeps a comma inside a quoted sequence entry", () => {
      writeAgent(
        "seq-comma",
        `---
tools: ["read", "weird,name"]
---

Comma entry.`,
      );

      const result = loadCustomAgents(tmpDir);
      expect(result.get("seq-comma")!.toolNames).toEqual(["read", "weird,name"]);
    });
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
    expect(result.get("unlimited")!.maxTurns).toBeUndefined();
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
    expect(result.get("appender")!.promptMode).toBe("append");
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
    expect(result.get("explore")!.description).toBe("Custom Explore");
    expect(result.has("custom")).toBe(true);
  });

  it("handles empty body with frontmatter", () => {
    writeAgent(
      "nobody",
      `---
description: No body
tools: read
---
`,
    );

    const result = loadCustomAgents(tmpDir);
    expect(result.get("nobody")!.systemPrompt).toBe("");
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
    const agent = result.get("disabled")!;
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
    expect(result.get("myagent")!.displayName).toBe("MyAgent");
  });

  it("uses a stable case-insensitive identity when a project file overrides global", () => {
    const globalDir = join(tmpDir, ".pi", "agent", "agents");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(globalDir + "/Reviewer.md", "---\ndescription: Global\n---\nGlobal.");
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

    const agent = loadCustomAgents(tmpDir, () => {}).get("reviewer")!;
    expect(agent.mode).toBe("all");
    expect(agent.allowedAgents).toEqual(["tests", "explore"]);
    expect(agent.defaultStack).toBe("balanced");
    expect(agent.stacks?.get("fast")).toEqual({ model: "anthropic/haiku" });
    expect(agent.maxTurns).toBe(25);
    expect(agent.graceTurns).toBe(3);
  });

  it("accepts the synthetic default as a default_stack", () => {
    writeAgent("reviewer", "---\ndefault_stack: default\n---\nReview.");

    expect(loadCustomAgents(tmpDir, () => {}).get("reviewer")?.defaultStack).toBe("default");
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

  it("rejects reserved, colliding, malformed, empty, and unknown default stacks", () => {
    const cases = {
      reserved: "stacks:\n  default:\n    model: a/b",
      collision: "stacks:\n  Fast:\n    model: a/b\n  fast:\n    model: c/d",
      malformed: "stacks:\n  fast:\n    model: sonnet",
      empty: 'default_stack: ""',
      unknown: "default_stack: missing\nstacks:\n  fast:\n    model: a/b",
    };
    for (const [name, yaml] of Object.entries(cases)) writeAgent(name, `---\n${yaml}\n---\nBad.`);
    const diagnostics: string[] = [];
    const result = loadCustomAgents(tmpDir, (diagnostic) => diagnostics.push(diagnostic.message));
    expect(result.size).toBe(0);
    expect(diagnostics).toHaveLength(5);
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
      expect(result.get("via-env")!.description).toBe("Discovered via env var");
    } finally {
      if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalEnv;
      rmSync(altAgentDir, { recursive: true, force: true });
    }
  });
});
