/**
 * agent-types.ts — Unified agent type registry.
 *
 * Discovers user-defined agents from .pi/agents/*.md.
 * Project agents override global agents with the same name. Disabled agents are kept but excluded from spawning.
 */
import type { AgentConfig } from "../types.ts";

const normalizeAgentId = (name: string): string => name.trim().toLocaleLowerCase("en-US");

export interface AgentRegistrySnapshot {
  readonly revision: number;
  readonly agents: ReadonlyMap<string, AgentConfig>;
  readonly primary: readonly string[];
  readonly subagent: readonly string[];
  readonly all: readonly string[];
  readonly disabled: readonly string[];
}

// ── AgentConfigLookup interface ──────────────────────────────────────────────

/**
 * Narrow registry interface for consumers that only need config resolution.
 * Prefer this over the full `AgentTypeRegistry` in function signatures (ISP).
 */
export interface AgentConfigLookup {
  resolveAgentConfig(type: string): AgentConfig;
}

// ── AgentTypeRegistry class ──────────────────────────────────────────────────

/**
 * Injectable registry of all discovered agent configurations.
 *
 * Replaces the module-scoped `agents` Map and its companion free functions.
 * The constructor accepts a `loadUserAgents` callback to defer disk I/O to the
 * call site, keeping this class side-effect-free and easy to test.
 */
export class AgentTypeRegistry implements AgentConfigLookup {
  private agents = new Map<string, AgentConfig>();
  private revision = 0;

  /** Kept for API compatibility; this package does not provide built-in agents. */
  static readonly DEFAULT_AGENT_NAMES = [] as const;

  constructor(private loadUserAgents: () => Map<string, AgentConfig>) {
    this.reload();
  }

  /**
   * Re-scan user agents and rebuild the registry.
   */
  reload(): void {
    const next = new Map<string, AgentConfig>();
    const keysById = new Map<string, string>();
    for (const [name, config] of this.loadUserAgents()) {
      const id = config.id ?? normalizeAgentId(name);
      const previousKey = keysById.get(id);
      if (previousKey) next.delete(previousKey);
      const key = previousKey ?? name;
      keysById.set(id, key);
      next.set(key, { ...config, id });
    }
    this.agents = next;
    this.revision++;
  }

  /** Refresh discovery and return an immutable point-in-time view. */
  refresh(): AgentRegistrySnapshot {
    this.reload();
    return this.snapshot();
  }

  snapshot(): AgentRegistrySnapshot {
    const agents = new Map(
      [...this.agents].map(([name, config]) => [
        name,
        { ...config, stacks: config.stacks ? new Map(config.stacks) : undefined },
      ]),
    );
    const enabled = [...agents].filter(([_, config]) => config.enabled !== false);
    return Object.freeze({
      revision: this.revision,
      agents,
      primary: Object.freeze(
        enabled
          .filter(([_, config]) => config.mode === "primary" || config.mode === "all")
          .map(([name]) => name),
      ),
      subagent: Object.freeze(
        enabled
          .filter(
            ([_, config]) => (config.mode ?? "subagent") === "subagent" || config.mode === "all",
          )
          .map(([name]) => name),
      ),
      all: Object.freeze(
        enabled.filter(([_, config]) => config.mode === "all").map(([name]) => name),
      ),
      disabled: Object.freeze(
        [...agents].filter(([_, config]) => config.enabled === false).map(([name]) => name),
      ),
    });
  }

  /** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
  resolveType(name: string): string | undefined {
    return this.resolveKey(name);
  }

  getPrimaryTypes(): string[] {
    return [...this.snapshot().primary];
  }

  getSubagentTypes(): string[] {
    return [...this.snapshot().subagent];
  }

  /** Get all enabled type names across primary and child modes. */
  getAvailableTypes(): string[] {
    return [...this.agents.entries()]
      .filter(([_, config]) => config.enabled !== false)
      .map(([name]) => name);
  }

  /** Get all type names including disabled (for UI listing). */
  getAllTypes(): string[] {
    return [...this.agents.keys()];
  }

  /** Get names of default agents currently in the registry. */
  getDefaultAgentNames(): string[] {
    return [...this.agents.entries()]
      .filter(([_, config]) => config.isDefault === true)
      .map(([name]) => name);
  }

  /** Get names of user-defined agents (non-defaults) currently in the registry. */
  getUserAgentNames(): string[] {
    return [...this.agents.entries()]
      .filter(([_, config]) => config.isDefault !== true)
      .map(([name]) => name);
  }

  /** Check if a type is valid and enabled (case-insensitive). */
  isValidType(type: string): boolean {
    const key = this.resolveKey(type);
    if (!key) return false;
    return this.agents.get(key)?.enabled !== false;
  }

  /** Resolve a known config without substituting another agent. Disabled definitions remain inspectable. */
  findAgentConfig(type: string): AgentConfig | undefined {
    const key = this.resolveKey(type);
    return key ? this.agents.get(key) : undefined;
  }

  /** Resolve an existing definition. Unknown names never borrow another agent's config. */
  resolveAgentConfig(type: string): AgentConfig {
    const config = this.findAgentConfig(type);
    if (config) return config;
    throw new Error(`Unknown agent type: ${JSON.stringify(type)}`);
  }

  private resolveKey(name: string): string | undefined {
    if (this.agents.has(name)) return name;
    const id = normalizeAgentId(name);
    for (const [key, config] of this.agents) {
      if ((config.id ?? normalizeAgentId(key)) === id) return key;
    }
    return undefined;
  }
}

/** All known built-in tool names. */
export const BUILTIN_TOOL_NAMES: string[] = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];
