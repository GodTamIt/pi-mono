/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { debugLog } from "../debug.ts";
import type { AgentConfig, ThinkingLevel } from "../types.ts";
import { BUILTIN_TOOL_NAMES } from "./agent-types.ts";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadFromDir(globalDir, agents, "global"); // lower priority
  loadFromDir(projectDir, agents, "project"); // higher priority (overwrites)
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: "project" | "global",
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    debugLog("readdirSync agents dir", err);
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");

    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch (err) {
      debugLog("readFileSync agent file", err);
      continue;
    }

    const { frontmatter: fm, body } = parseFrontmatter(content);
    if (Object.hasOwn(fm, "inherit_context")) {
      console.warn(
        `[pi-agent-roster] Ignoring agent ${join(dir, file)}: inherit_context is unsupported; put all context in the explicit task`,
      );
      continue;
    }

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      toolNames: listField(fm.tools, BUILTIN_TOOL_NAMES),
      model: str(fm.model),
      thinking: str(fm.thinking) as ThinkingLevel | undefined,
      maxTurns: legacyMaxTurns(fm.max_turns),
      graceTurns: boundedInt(fm.grace_turns, 0, 1_000),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "replace" ? "replace" : "append",
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      enabled: fm.enabled !== false, // default true; explicitly false disables
      source,
    });
  }
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Parse the persisted max-turn convention where zero means unlimited. */
function legacyMaxTurns(val: unknown): number | undefined {
  if (val === 0) return undefined;
  return boundedInt(val, 1, 10_000);
}

function boundedInt(val: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isInteger(val) && (val as number) >= minimum && (val as number) <= maximum
    ? (val as number)
    : undefined;
}

/**
 * Parse a raw list field into items, or undefined if absent/empty/"none".
 *
 * Frontmatter is YAML, so a list field is written either as a comma-separated
 * scalar (`tools: read, grep`) or as a sequence (`tools: [read, grep]`). Both
 * are supported: a sequence keeps its entries intact, while a scalar is split
 * on commas.
 */
function parseListField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const items = Array.isArray(val)
    ? val.map((entry) => String(entry).trim()).filter(Boolean)
    : // eslint-disable-next-line @typescript-eslint/no-base-to-string -- val is already narrowed past null/undefined; String() is the intended coercion here
      String(val)
        .trim()
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  if (items.length === 0) return undefined;
  return items.length === 1 && items[0] === "none" ? undefined : items;
}

/**
 * Parse a list field with defaults.
 * omitted → defaults; "none"/empty → []; otherwise → listed items.
 */
function listField(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseListField(val) ?? [];
}
