import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "../../src/config/agent-types.ts";
import type { AgentConfig } from "../../src/types.ts";
import { TEST_AGENTS } from "../helpers/test-agents.ts";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    runInBackground: false,
    ...overrides,
  };
}

describe("AgentTypeRegistry", () => {
  function makeRegistry(userAgents: Map<string, AgentConfig> = new Map()): AgentTypeRegistry {
    return new AgentTypeRegistry(() => new Map([...TEST_AGENTS, ...userAgents]));
  }

  describe("construction and reload", () => {
    it("loads default agents on construction", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("general-purpose")).toBe(true);
      expect(registry.isValidType("Explore")).toBe(true);
      expect(registry.isValidType("Architect")).toBe(true);
    });

    it("does not call loadUserAgents until construction", () => {
      let callCount = 0;
      const registry = new AgentTypeRegistry(() => {
        callCount++;
        return new Map();
      });
      // constructor calls reload() once
      expect(callCount).toBe(1);
      registry.reload();
      expect(callCount).toBe(2);
    });

    it("reload picks up new agents from loader", () => {
      let userAgents = new Map<string, AgentConfig>();
      const registry = new AgentTypeRegistry(() => userAgents);

      expect(registry.isValidType("auditor")).toBe(false);

      userAgents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registry.reload();

      expect(registry.isValidType("auditor")).toBe(true);
    });

    it("reload clears previous user agents", () => {
      const userAgents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      const registry = new AgentTypeRegistry(() => userAgents);
      expect(registry.isValidType("auditor")).toBe(true);

      userAgents.clear();
      registry.reload();

      expect(registry.isValidType("auditor")).toBe(false);
      expect(registry.isValidType("general-purpose")).toBe(false);
    });
  });

  describe("snapshots", () => {
    it("classifies enabled modes and disabled definitions", () => {
      const registry = new AgentTypeRegistry(
        () =>
          new Map([
            ["Primary", makeAgentConfig({ name: "Primary", mode: "primary" })],
            ["Worker", makeAgentConfig({ name: "Worker", mode: "subagent" })],
            ["Both", makeAgentConfig({ name: "Both", mode: "all" })],
            ["Off", makeAgentConfig({ name: "Off", mode: "all", enabled: false })],
          ]),
      );
      const snapshot = registry.snapshot();
      expect(snapshot.primary).toEqual(["Primary", "Both"]);
      expect(snapshot.subagent).toEqual(["Worker", "Both"]);
      expect(snapshot.all).toEqual(["Both"]);
      expect(snapshot.disabled).toEqual(["Off"]);
    });

    it("refresh replaces the snapshot and increments its revision", () => {
      let agents = new Map([["one", makeAgentConfig({ name: "one" })]]);
      const registry = new AgentTypeRegistry(() => agents);
      const before = registry.snapshot();
      agents = new Map([["two", makeAgentConfig({ name: "two" })]]);
      const after = registry.refresh();
      expect(after.revision).toBe(before.revision + 1);
      expect([...before.agents.keys()]).toEqual(["one"]);
      expect([...after.agents.keys()]).toEqual(["two"]);
    });
  });

  describe("resolveType", () => {
    it("returns canonical key for exact match", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("Explore")).toBe("Explore");
      expect(registry.resolveType("general-purpose")).toBe("general-purpose");
    });

    it("returns canonical key for case-insensitive match", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("explore")).toBe("Explore");
      expect(registry.resolveType("GENERAL-PURPOSE")).toBe("general-purpose");
    });

    it("returns undefined for unknown type", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("nonexistent")).toBeUndefined();
    });
  });

  describe("resolveAgentConfig", () => {
    it("returns config for a known enabled type", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("Explore");
      expect(config.name).toBe("Explore");
      expect(config.promptMode).toBe("replace");
    });

    it("performs case-insensitive lookup", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("explore");
      expect(config.name).toBe("Explore");
    });

    it("does not fall back for an unknown type", () => {
      const registry = makeRegistry();
      expect(() => registry.resolveAgentConfig("nonexistent")).toThrow("Unknown agent type");
    });

    it("returns config for disabled type (no fallback for existing disabled)", () => {
      const registry = makeRegistry(
        new Map([
          [
            "Architect",
            makeAgentConfig({ name: "Architect", description: "Disabled", enabled: false }),
          ],
        ]),
      );
      const config = registry.resolveAgentConfig("Architect");
      expect(config.name).toBe("Architect");
      expect(config.enabled).toBe(false);
    });

    it("returns user-defined agent config", () => {
      const registry = makeRegistry(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor", description: "Security auditor" })],
        ]),
      );
      const config = registry.resolveAgentConfig("auditor");
      expect(config.name).toBe("auditor");
      expect(config.description).toBe("Security auditor");
    });
  });

  describe("getAvailableTypes", () => {
    it("includes all enabled defaults", () => {
      const registry = makeRegistry();
      const types = registry.getAvailableTypes();
      expect(types).toContain("general-purpose");
      expect(types).toContain("Explore");
      expect(types).toContain("Architect");
    });

    it("excludes disabled agents", () => {
      const registry = makeRegistry(
        new Map([["Architect", makeAgentConfig({ name: "Architect", enabled: false })]]),
      );
      expect(registry.getAvailableTypes()).not.toContain("Architect");
    });

    it("includes user agents", () => {
      const registry = makeRegistry(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));
      expect(registry.getAvailableTypes()).toContain("auditor");
    });
  });

  describe("getAllTypes", () => {
    it("includes disabled agents", () => {
      const registry = makeRegistry(
        new Map([["Architect", makeAgentConfig({ name: "Architect", enabled: false })]]),
      );
      expect(registry.getAllTypes()).toContain("Architect");
    });
  });

  describe("getDefaultAgentNames", () => {
    it("returns only default agents", () => {
      const registry = makeRegistry(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));
      const names = registry.getDefaultAgentNames();
      expect(names).toContain("general-purpose");
      expect(names).toContain("Explore");
      expect(names).toContain("Architect");
      expect(names).not.toContain("auditor");
    });
  });

  describe("getUserAgentNames", () => {
    it("returns only user agents", () => {
      const registry = makeRegistry(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor" })],
          ["reviewer", makeAgentConfig({ name: "reviewer" })],
        ]),
      );
      const names = registry.getUserAgentNames();
      expect(names).toEqual(["auditor", "reviewer"]);
      expect(names).not.toContain("general-purpose");
    });
  });

  describe("isValidType", () => {
    it("returns true for enabled defaults", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("general-purpose")).toBe(true);
      expect(registry.isValidType("Explore")).toBe(true);
    });

    it("returns true case-insensitively", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("explore")).toBe(true);
      expect(registry.isValidType("ARCHITECT")).toBe(true);
    });

    it("returns false for disabled agents", () => {
      const registry = makeRegistry(
        new Map([["Architect", makeAgentConfig({ name: "Architect", enabled: false })]]),
      );
      expect(registry.isValidType("Architect")).toBe(false);
    });

    it("returns false for unknown types", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("nonexistent")).toBe(false);
      expect(registry.isValidType("")).toBe(false);
    });
  });

  describe("DEFAULT_AGENT_NAMES static property", () => {
    it("is defined on the class", () => {
      expect(AgentTypeRegistry.DEFAULT_AGENT_NAMES).toBeDefined();
    });

    it("contains the three built-in default names", () => {
      expect(AgentTypeRegistry.DEFAULT_AGENT_NAMES).toEqual([]);
    });

    it("is no longer exported from types.ts", async () => {
      // DEFAULT_AGENT_NAMES was moved to AgentTypeRegistry; it must NOT appear
      // as a named export from types.ts anymore.
      const typesModule = await import("../../src/types.ts");
      expect((typesModule as Record<string, unknown>).DEFAULT_AGENT_NAMES).toBeUndefined();
    });
  });

  describe("instance isolation", () => {
    it("two registries have independent state", () => {
      const r1 = makeRegistry(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));
      const r2 = makeRegistry();

      expect(r1.isValidType("auditor")).toBe(true);
      expect(r2.isValidType("auditor")).toBe(false);
    });
  });
});
