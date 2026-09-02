import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "../src/config/agent-types.ts";
import type { AgentConfig } from "../src/types.ts";
import {
  buildInvocationMetadataParts,
  buildInvocationTags,
  formatSessionTokens,
  formatTokens,
  getDisplayName,
  getPromptModeLabel,
  sanitizeTerminalText,
} from "../src/ui/display.ts";
import { TEST_AGENTS } from "./helpers/test-agents.ts";

const testRegistry = new AgentTypeRegistry(() => TEST_AGENTS);

const HOSTILE_OUTPUT =
  "npm WARN \u001b[31mdeprecated\u001b[0m \u001b]8;;https://example.test\u0007package\u001b]8;;\u0007 " +
  "\u001b[2Aoverwrite\rprogress\b!\u001b_hidden\u001b\\ done";

describe("sanitizeTerminalText", () => {
  it("removes ANSI, OSC, cursor movement, control strings, and control bytes", () => {
    const sanitized = sanitizeTerminalText(HOSTILE_OUTPUT, true);

    expect(sanitized).toContain("npm WARN deprecated package overwriteprogress! done");
    for (const control of ["\u001b", "\r", "\b", "\u009b"]) {
      expect(sanitized).not.toContain(control);
    }
  });

  it("preserves newlines only when requested", () => {
    expect(sanitizeTerminalText("one\ntwo", true)).toBe("one\ntwo");
    expect(sanitizeTerminalText("one\ntwo")).toBe("one two");
  });

  it("restarts aborted sequences instead of leaking their payload", () => {
    expect(sanitizeTerminalText("\x1b[1\x1b[2Jhide")).toBe("hide");
    expect(sanitizeTerminalText("\x1b\x1b[mrest")).toBe("rest");
  });
});

describe("getDisplayName", () => {
  it("returns displayName when set", () => {
    const customAgents = new Map<string, AgentConfig>([
      [
        "my-agent",
        {
          name: "my-agent",
          displayName: "My Agent",
          description: "test",
          systemPrompt: "",
          promptMode: "replace",
        },
      ],
    ]);
    const registry = new AgentTypeRegistry(() => customAgents);
    expect(getDisplayName("my-agent", registry)).toBe("My Agent");
  });

  it("falls back to name when displayName is not set", () => {
    const customAgents = new Map<string, AgentConfig>([
      [
        "my-agent",
        {
          name: "my-agent",
          description: "test",
          systemPrompt: "",
          promptMode: "replace",
        },
      ],
    ]);
    const registry = new AgentTypeRegistry(() => customAgents);
    expect(getDisplayName("my-agent", registry)).toBe("my-agent");
  });

  it("uses registry to resolve Explore displayName", () => {
    expect(getDisplayName("Explore", testRegistry)).toBe("Explore");
  });

  it("uses registry to resolve general-purpose displayName", () => {
    expect(getDisplayName("general-purpose", testRegistry)).toBe("Agent");
  });

  it("keeps stale records renderable after their agent definition is removed", () => {
    const emptyRegistry = new AgentTypeRegistry(() => new Map());
    expect(getDisplayName("general-purpose", emptyRegistry)).toBe("Agent");
    expect(getDisplayName("retired-reviewer", emptyRegistry)).toBe("retired-reviewer");
  });
});

describe("getPromptModeLabel", () => {
  it("returns 'twin' for append promptMode", () => {
    const customAgents = new Map<string, AgentConfig>([
      [
        "twin-agent",
        {
          name: "twin-agent",
          description: "test",
          systemPrompt: "",
          promptMode: "append",
        },
      ],
    ]);
    const registry = new AgentTypeRegistry(() => customAgents);
    expect(getPromptModeLabel("twin-agent", registry)).toBe("twin");
  });

  it("returns undefined for replace promptMode", () => {
    expect(getPromptModeLabel("Explore", testRegistry)).toBeUndefined();
  });

  it("omits a mode label when a stale record no longer has a definition", () => {
    const emptyRegistry = new AgentTypeRegistry(() => new Map());
    expect(getPromptModeLabel("retired-reviewer", emptyRegistry)).toBeUndefined();
  });
});

describe("buildInvocationMetadataParts", () => {
  it("labels the selected stack and its resolved model and thinking level", () => {
    expect(
      buildInvocationMetadataParts({
        stack: "deep",
        model: "anthropic/claude-opus",
        thinking: "high",
      }),
    ).toEqual(["stack: deep", "model: anthropic/claude-opus", "thinking: high"]);
  });

  it("omits unavailable metadata without placeholder clutter", () => {
    expect(buildInvocationMetadataParts({ model: "anthropic/claude-sonnet" })).toEqual([
      "model: anthropic/claude-sonnet",
    ]);
    expect(buildInvocationMetadataParts({})).toEqual([]);
  });
});

describe("buildInvocationTags", () => {
  it("labels finite turn and grace budgets", () => {
    expect(buildInvocationTags({ maxTurns: 20, graceTurns: 0 }).tags).toEqual([
      "max turns: 20",
      "grace turns: 0",
    ]);
  });

  it("labels omitted budgets as unlimited", () => {
    expect(buildInvocationTags({}).tags).toEqual([
      "max turns: unlimited",
      "grace turns: unlimited",
    ]);
  });
});

describe("formatTokens", () => {
  it("pluralizes every count except exactly one", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(2)).toBe("2 tokens");
    expect(formatTokens(26_700)).toBe("26.7k tokens");
  });
});

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k tokens");
    expect(formatSessionTokens(1234, 50, theme)).toBe(
      "1.2k tokens <dim>(</dim><dim>50%</dim><dim>)</dim>",
    );
    expect(formatSessionTokens(1234, 70, theme)).toBe(
      "1.2k tokens <dim>(</dim><warning>70%</warning><dim>)</dim>",
    );
    expect(formatSessionTokens(1234, 84, theme)).toBe(
      "1.2k tokens <dim>(</dim><warning>84%</warning><dim>)</dim>",
    );
    expect(formatSessionTokens(1234, 85, theme)).toBe(
      "1.2k tokens <dim>(</dim><error>85%</error><dim>)</dim>",
    );
    expect(formatSessionTokens(1234, 99, theme)).toBe(
      "1.2k tokens <dim>(</dim><error>99%</error><dim>)</dim>",
    );
  });

  it("rounds context percentage to the nearest tenth", () => {
    expect(formatSessionTokens(1234, 5.7134813489, theme)).toBe(
      "1.2k tokens <dim>(</dim><dim>5.7%</dim><dim>)</dim>",
    );
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe(
      "1.2k tokens <dim>(</dim><dim>⇊1</dim><dim>)</dim>",
    );
    expect(formatSessionTokens(1234, null, theme, 3)).toBe(
      "1.2k tokens <dim>(</dim><dim>⇊3</dim><dim>)</dim>",
    );
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe(
      "1.2k tokens <dim>(</dim><dim>45%</dim><dim> · </dim><dim>⇊2</dim><dim>)</dim>",
    );
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe(
      "1.2k tokens <dim>(</dim><error>88%</error><dim> · </dim><dim>⇊4</dim><dim>)</dim>",
    );
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe(
      "1.2k tokens <dim>(</dim><dim>45%</dim><dim>)</dim>",
    );
  });
});
